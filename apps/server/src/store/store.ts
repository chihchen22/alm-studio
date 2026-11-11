/**
 * The append-only file store.
 *
 * All platform state is JSON files under the store root. This module owns the
 * disciplines every writer must share:
 *
 *  - Atomic writes: temp file in the destination directory, then rename, with
 *    one bounded retry on EBUSY/EPERM (the McAfee case on this machine, risk R1).
 *  - Append-only: there is no delete anywhere in this file, and a document write
 *    to an id that already exists is refused (a new version is a new id). The
 *    one exception, ADR-028: supersedeDocument MOVES a named seeded document,
 *    byte for byte, into superseded/<stamp>/ so the seed can write today's.
 *  - Content hashes are SHA-256 over the exact stored bytes, so a later reader
 *    can re-hash the file and prove it is the artifact that was pinned.
 *  - Listings are derived by directory scan on request, never from a cached
 *    index that could drift.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { assertValidId, COLLECTIONS, storePaths, type Collection, type RunFileName, type StorePaths } from "./paths";

/** Thrown when a requested document does not exist. Maps to HTTP 404. */
export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} "${id}" not found`);
    this.name = "NotFoundError";
  }
}

/** Thrown when a write would overwrite an existing document. Maps to HTTP 409. */
export class AlreadyExistsError extends Error {
  constructor(what: string, id: string) {
    super(`${what} "${id}" already exists; the store is append-only; import under a new id instead of overwriting`);
    this.name = "AlreadyExistsError";
  }
}

/** SHA-256 hex over exact bytes. */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The noun a store refusal names each collection by (Studio Polish 1 V2). A
 * Record, so a new collection cannot go unnamed: `plans` holds balance plans,
 * and a hyphenated id reads as two words.
 */
const DOC_LABEL: Record<Collection, string> = {
  portfolios: "portfolio",
  market: "market",
  "assumption-sets": "assumption set",
  "scenario-slates": "scenario slate",
  coa: "chart of accounts",
  taxonomy: "taxonomy",
  lens: "lens",
  plans: "balance plan",
  "routing-policies": "routing policy",
  "run-plans": "run plan",
  approvals: "approval",
  hierarchies: "hierarchy",
  "run-setups": "run setup",
  "curve-setups": "curve setup",
  "derived-curves": "derived curve",
  "index-histories": "index history",
  reference: "reference document",
  calibrations: "saved calibration",
};

function docLabel(collection: Collection): string {
  return DOC_LABEL[collection];
}

const RETRYABLE = new Set(["EBUSY", "EPERM"]);
const RETRY_DELAY_MS = 120;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Atomic write: unique temp file beside the destination, then rename. One retry
 * on EBUSY/EPERM for the antivirus-scan case; a second failure propagates. The
 * temp name is random so two writers never collide; rename on the same volume
 * is atomic, so a reader sees the old file or the new file, never a torn one.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, data);
  renameWithRetry(tmp, path);
}

/** A rename function; supersedeDocument takes one so a test can inject a failure. */
export type RenameFn = (from: string, to: string) => void;

/** Rename with one retry on EBUSY/EPERM (the antivirus-scan case, risk R1). */
function renameWithRetry(from: string, to: string, rename: RenameFn = renameSync): void {
  try {
    rename(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && RETRYABLE.has(code)) {
      sleepSync(RETRY_DELAY_MS);
      rename(from, to);
    } else {
      throw err;
    }
  }
}

/** Stable serialization for stored documents: pretty JSON + trailing newline. */
export function serializeDocument(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Meta record kept beside every collection document. */
export interface DocumentMeta {
  id: string;
  /** SHA-256 hex over the stored document file bytes. */
  contentHash: string;
  /** Wall-clock import stamp (platform metadata, never inside a result). */
  importedAt: string;
  /** Free-form, collection-specific metadata (label, counts, intake stats). */
  [key: string]: unknown;
}

export interface StoredDocument<T> {
  id: string;
  doc: T;
  meta: DocumentMeta;
}

/** One line of superseded/<stamp>/manifest.ndjson. */
export interface SupersededRecord {
  collection: Collection;
  id: string;
  oldHash: string;
  newHash: string;
  supersededAt: string;
}

/**
 * The store facade. One instance per store root; the server holds exactly one.
 * Every method is synchronous: at one practitioner and tens of documents the
 * filesystem is fast, and synchronous IO keeps the state transitions ordered.
 */
export class FileStore {
  readonly paths: StorePaths;

  constructor(root: string) {
    this.paths = storePaths(root);
  }

  /** Create the directory skeleton. Idempotent. */
  init(): void {
    for (const c of COLLECTIONS) mkdirSync(this.paths.collectionDir(c), { recursive: true });
    mkdirSync(this.paths.runsDir(), { recursive: true });
  }

  has(collection: Collection, id: string): boolean {
    return existsSync(this.paths.documentPath(collection, id));
  }

  /**
   * Write a new document plus its meta. Refuses an existing id (append-only).
   * Returns the content hash of the stored bytes.
   */
  putDocument(collection: Collection, id: string, doc: unknown, extraMeta: Record<string, unknown>): DocumentMeta {
    const path = this.paths.documentPath(collection, id);
    if (existsSync(path)) throw new AlreadyExistsError(docLabel(collection), id);
    const bytes = serializeDocument(doc);
    writeFileAtomic(path, bytes);
    const meta: DocumentMeta = {
      id,
      contentHash: sha256Hex(bytes),
      importedAt: new Date().toISOString(),
      ...extraMeta,
    };
    writeFileAtomic(this.paths.metaPath(collection, id), serializeDocument(meta));
    return meta;
  }

  /**
   * Move a document and its meta, byte for byte, into
   * <root>/superseded/<stamp>/<collection>/ and append one line to
   * <root>/superseded/<stamp>/manifest.ndjson. A rename, never a delete.
   * superseded/ is not a collection, so no listing, route or DB sync reads it.
   * Refuses to overwrite an earlier superseded copy under the same stamp.
   * The pair move is all-or-nothing: if the meta rename fails, the document is
   * renamed back and the original error propagates, with no manifest line.
   * `rename` is a test seam only; production callers never pass it.
   */
  supersedeDocument(
    collection: Collection,
    id: string,
    stamp: string,
    newHash: string,
    rename: RenameFn = renameSync,
  ): SupersededRecord {
    const stampDir = join(this.paths.root, "superseded", assertValidId(stamp));
    const docPath = this.paths.documentPath(collection, id);
    const metaPath = this.paths.metaPath(collection, id);
    if (!existsSync(docPath)) throw new NotFoundError(docLabel(collection), id);
    const meta = this.getMeta(collection, id);
    const dir = join(stampDir, collection);
    const docDest = join(dir, `${id}.json`);
    const metaDest = join(dir, `${id}.meta.json`);
    if (existsSync(docDest) || existsSync(metaDest)) {
      throw new Error(`superseded/${stamp}/${collection} already holds "${id}"; refusing to overwrite a superseded copy`);
    }
    mkdirSync(dir, { recursive: true });
    renameWithRetry(docPath, docDest, rename);
    try {
      renameWithRetry(metaPath, metaDest, rename);
    } catch (err) {
      try {
        renameWithRetry(docDest, docPath, rename);
      } catch (rollbackErr) {
        throw new Error(
          `supersede of ${collection}/${id} failed half way and its rollback failed: the document is at ` +
            `${docDest} and its meta is at ${metaPath}; move ${docDest} back to ${docPath} by hand ` +
            `(meta move: ${String(err)}; rollback: ${String(rollbackErr)})`,
        );
      }
      throw err;
    }
    const record: SupersededRecord = {
      collection,
      id,
      oldHash: meta.contentHash,
      newHash,
      supersededAt: new Date().toISOString(),
    };
    appendFileSync(join(stampDir, "manifest.ndjson"), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  getDocument<T>(collection: Collection, id: string): StoredDocument<T> {
    const path = this.paths.documentPath(collection, id);
    if (!existsSync(path)) throw new NotFoundError(docLabel(collection), id);
    const doc = JSON.parse(readFileSync(path, "utf8")) as T;
    return { id, doc, meta: this.getMeta(collection, id) };
  }

  /** Raw stored bytes of a document (for hash pinning and streaming). */
  getDocumentBytes(collection: Collection, id: string): Buffer {
    const path = this.paths.documentPath(collection, id);
    if (!existsSync(path)) throw new NotFoundError(docLabel(collection), id);
    return readFileSync(path);
  }

  /** Studio A+E: a pinned document by id and hash, live first, then under superseded/<stamp>/, else null. Read-only. */
  findPinned(collection: Collection, id: string, contentHash: string): { where: "live" | "superseded"; stamp?: string; bytes: Buffer } | null {
    const live = this.paths.documentPath(collection, id);
    if (existsSync(live)) { const bytes = readFileSync(live); if (sha256Hex(bytes) === contentHash) return { where: "live", bytes }; }
    const supersededDir = join(this.paths.root, "superseded");
    if (!existsSync(supersededDir)) return null;
    for (const stamp of readdirSync(supersededDir).sort()) {
      const p = join(supersededDir, stamp, collection, `${assertValidId(id)}.json`);
      if (!existsSync(p)) continue;
      const bytes = readFileSync(p);
      if (sha256Hex(bytes) === contentHash) return { where: "superseded", stamp, bytes };
    }
    return null;
  }

  getMeta(collection: Collection, id: string): DocumentMeta {
    const path = this.paths.metaPath(collection, id);
    if (!existsSync(path)) {
      // A document without meta is a store defect; surface it, do not invent meta.
      throw new NotFoundError(`${docLabel(collection)} meta`, id);
    }
    return JSON.parse(readFileSync(path, "utf8")) as DocumentMeta;
  }

  /** Directory-scan listing of a collection's meta records, id-sorted. */
  listMeta(collection: Collection): DocumentMeta[] {
    const dir = this.paths.collectionDir(collection);
    if (!existsSync(dir)) return [];
    const ids = readdirSync(dir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => f.slice(0, -".meta.json".length))
      .sort();
    return ids.map((id) => this.getMeta(collection, id));
  }

  // --- runs ------------------------------------------------------------------

  /** Directory-scan of run ids (directories under runs/), sorted ascending. */
  listRunIds(): string[] {
    const dir = this.paths.runsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  runFileExists(runId: string, file: RunFileName): boolean {
    return existsSync(this.paths.runFile(runId, file));
  }

  readRunJson<T>(runId: string, file: Exclude<RunFileName, "log.ndjson">): T {
    const path = this.paths.runFile(runId, file);
    if (!existsSync(path)) throw new NotFoundError(`run ${file}`, runId);
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  readRunBytes(runId: string, file: RunFileName): Buffer {
    const path = this.paths.runFile(runId, file);
    if (!existsSync(path)) throw new NotFoundError(`run ${file}`, runId);
    return readFileSync(path);
  }

  writeRunJson(runId: string, file: "request.json" | "status.json", doc: unknown): void {
    mkdirSync(this.paths.runDir(runId), { recursive: true });
    writeFileAtomic(this.paths.runFile(runId, file), serializeDocument(doc));
  }

  /** Append one NDJSON line to a run's log (append-only by definition). */
  appendRunLog(runId: string, event: unknown): void {
    mkdirSync(this.paths.runDir(runId), { recursive: true });
    appendFileSync(this.paths.runFile(runId, "log.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
  }

  /** Read the run log as parsed events (tolerates a torn final line). */
  readRunLog(runId: string): unknown[] {
    const path = this.paths.runFile(runId, "log.ndjson");
    if (!existsSync(path)) return [];
    const out: unknown[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn trailing line (crash mid-append) is skipped, never invented.
      }
    }
    return out;
  }
}
