/**
 * The workspace directory (Studio A+E spec v3.1 Section 2.3): a head plus an
 * append-only history, mirroring `runs/<id>/status.json` and `log.ndjson`.
 *
 *   <root>/workspaces/<id>/manifest.json    the head, written with writeFileAtomic
 *   <root>/workspaces/<id>/history.ndjson   one line per revision, the full manifest
 *   <root>/workspaces/<id>/setups.ndjson    validations and launches
 *   <root>/workspaces/<id>/runs.ndjson      run attachments
 *   <root>/workspaces/.server.json          { pid, startedAt }, rewritten at every boot
 *
 * Write order inside the mutex: append the history line, then write the head. A
 * crash between the two leaves a line ahead of the head; reconcile rewrites the
 * head from the line (the line is the truth, the head is a cache of its last
 * entry), forward and never back. A final line that does not parse is torn and
 * ignored for every purpose; the next append starts on a clean line and the
 * fragment stays as the audit record of the crash. Nothing here is deleted.
 *
 * Callers that read a counter and then append (launch numbering) hold
 * `withLock` across both; the append methods themselves are synchronous.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { approvalState, type ApprovalRecord } from "../approvals/approvals";
import { assertValidId } from "../store/paths";
import { AlreadyExistsError, NotFoundError, serializeDocument, writeFileAtomic, type FileStore } from "../store/store";
import { blockHashes, manifestHashOf, signedHashOf } from "./hashes";
import type { HistoryChange, HistoryLine, RunAttachment, SetupEvent, WorkspaceManifest } from "./types";

/** A commit whose expectedRevision is not the head's revision. The route maps it to 409 with both numbers. */
export class RevisionConflict extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(id: string, expected: number, actual: number) {
    super(`workspace "${id}" is at revision ${actual}, not ${expected}; reload and retry`);
    this.name = "RevisionConflict";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A write to a Production workspace whose sign-off record landed but whose lock commit failed in this
 * process (review B m2). The route maps it to 409 naming the approval; a retried sign-off or the next
 * boot completes the lock.
 */
export class LockPending extends Error {
  readonly approvalId: string;
  constructor(id: string, approvalId: string) {
    super(
      `workspace "${id}" was signed off by approval ${approvalId} but its lock did not commit; writes are refused until ` +
        `the lock completes: retry the sign-off, or restart the server, which completes the lock at boot`,
    );
    this.name = "LockPending";
    this.approvalId = approvalId;
  }
}

/** The approval record a lock-pending workspace will lock on. */
export interface PendingLock {
  approvalId: string;
  at: string;
  by: string;
  signedHash: string;
}

export interface ReconcileReport {
  /** Workspace ids whose head was rewritten from a history line that was ahead (or missing). */
  reconciledHeads: string[];
  /** Run ids attached from a `request.json` that named a workspace no `runs.ndjson` line covered. */
  attached: string[];
  /** Supersede clones completed forward at boot: the clone's id, once its source is marked and its pending flag is cleared. */
  completedSupersedes: string[];
  /**
   * One boot-log message per pending supersede clone that cannot complete forward (source missing, or
   * already superseded by another workspace): `workspace <id>: pending supersede of "<src>" cannot complete: <why>`.
   * Nothing is written for these; the clone stays pending for an operator.
   */
  stuckSupersedes: string[];
  /** One boot-log message per final line that did not parse: `workspace <id>: torn final line in <file> ignored`. */
  torn: string[];
  /** Production workspaces locked at boot: approved at their current signedHash, crashed before the lock. */
  lockedAtBoot: string[];
  /**
   * Launches completed forward at boot: a `launch` line with no `launch-complete` for the same slot
   * and launch number gets one, `reconciled: true`, naming the runs attached for that launch.
   */
  completedLaunches: Array<{ workspaceId: string; launchNo: number }>;
}

const HISTORY = "history.ndjson";
const SETUPS = "setups.ndjson";
const RUNS = "runs.ndjson";
/** Studio guided flow S2a fix round 1: the stochastic runs the guided Run step launched, one link per line. */
const GUIDED_RUNS = "guided-runs.ndjson";

/** One line of workspaces/<wsId>/guided-runs.ndjson: a run posted on POST /api/runs from the guided Run step, linked exactly. */
export interface GuidedRunLink {
  runId: string;
  setupLineageId: string;
  /** The guided setup document the run was launched from: a later save makes the run stale. */
  setupDocId: string;
  at: string;
  by: string;
}
const MANIFEST = "manifest.json";

interface ParsedLines {
  lines: unknown[];
  /** True when the last non-empty line failed to parse. */
  tornFinal: boolean;
}

function parseLines(path: string): ParsedLines {
  if (!existsSync(path)) return { lines: [], tornFinal: false };
  const rows = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const lines: unknown[] = [];
  let tornFinal = false;
  rows.forEach((row, i) => {
    try {
      lines.push(JSON.parse(row));
    } catch {
      // A fragment is never invented back into a record. Only the last one is "the" torn line;
      // an earlier one is the audit remnant of a crash that a later append stepped over.
      if (i === rows.length - 1) tornFinal = true;
    }
  });
  return { lines, tornFinal };
}

export class WorkspaceStore {
  private readonly dir: string;
  /** Every torn final line seen by this instance, as boot-log messages, deduplicated. */
  readonly torn: string[] = [];
  /** Per-id tail of the mutex chain. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Per-id history size at the last reconcile or own write; an unchanged size skips the re-read. */
  private readonly settled = new Map<string, number>();
  /**
   * Sign-offs whose record landed and whose lock commit threw in this process (review B m2). Process
   * memory is the right scope: the window it closes runs until boot, and boot reconcile locks from
   * the record on disk.
   */
  private readonly pendingLocks = new Map<string, PendingLock>();

  constructor(root: string) {
    this.dir = join(root, "workspaces");
  }

  // --- paths ---------------------------------------------------------------

  private wsDir(id: string): string {
    return join(this.dir, assertValidId(id));
  }
  private file(id: string, name: string): string {
    return join(this.wsDir(id), name);
  }

  // --- low-level line IO ---------------------------------------------------

  /** Append one JSON line; first writes a newline when the file is non-empty and does not end with one. */
  private appendLine(path: string, obj: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    let prefix = "";
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0) {
        const fd = openSync(path, "r");
        try {
          const last = Buffer.alloc(1);
          readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = "\n";
        } finally {
          closeSync(fd);
        }
      }
    }
    appendFileSync(path, `${prefix}${JSON.stringify(obj)}\n`, "utf8");
  }

  private noteTorn(id: string, file: string): void {
    const msg = `workspace ${id}: torn final line in ${file} ignored`;
    if (!this.torn.includes(msg)) this.torn.push(msg);
  }

  private readLines<T>(id: string, file: string): T[] {
    const { lines, tornFinal } = parseLines(this.file(id, file));
    if (tornFinal) this.noteTorn(id, file);
    return lines as T[];
  }

  private historySize(id: string): number {
    const p = this.file(id, HISTORY);
    return existsSync(p) ? statSync(p).size : 0;
  }

  // --- reads ---------------------------------------------------------------

  /** Directory scan of workspace ids, sorted ascending. */
  private ids(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((n) => existsSync(join(this.dir, n, MANIFEST)) || existsSync(join(this.dir, n, HISTORY)))
      .sort();
  }

  has(id: string): boolean {
    try {
      const d = this.wsDir(id);
      return existsSync(join(d, MANIFEST)) || existsSync(join(d, HISTORY));
    } catch {
      return false;
    }
  }

  list(): WorkspaceManifest[] {
    return this.ids().map((id) => this.head(id));
  }

  /** The head, after reconcile. */
  head(id: string): WorkspaceManifest {
    if (!this.has(id)) throw new NotFoundError("workspace", id);
    this.reconcile(id);
    return JSON.parse(readFileSync(this.file(id, MANIFEST), "utf8")) as WorkspaceManifest;
  }

  history(id: string): HistoryLine[] {
    if (!this.has(id)) throw new NotFoundError("workspace", id);
    this.reconcile(id);
    return this.readLines<HistoryLine>(id, HISTORY);
  }

  // --- reconcile -----------------------------------------------------------

  /**
   * Compare the last parsed history line with the head. When the line is ahead (or the head is
   * missing), rewrite the head from the line. Returns true when the head was rewritten.
   */
  private reconcile(id: string): boolean {
    const size = this.historySize(id);
    const headPath = this.file(id, MANIFEST);
    if (this.settled.get(id) === size && existsSync(headPath)) return false;
    const lines = this.readLines<HistoryLine>(id, HISTORY);
    const last = lines.length > 0 ? lines[lines.length - 1]! : null;
    let rewritten = false;
    if (last) {
      let headRevision = -1;
      if (existsSync(headPath)) {
        try {
          headRevision = (JSON.parse(readFileSync(headPath, "utf8")) as WorkspaceManifest).revision;
        } catch {
          headRevision = -1;
        }
      }
      if (headRevision < last.revision) {
        writeFileAtomic(headPath, serializeDocument(last.manifest));
        rewritten = true;
      }
    }
    this.settled.set(id, size);
    return rewritten;
  }

  /**
   * Boot reconcile: every head against its history, then every pending supersede completed forward
   * (whichever of steps 2 and 3 is missing, never back), then every
   * `runs/<id>/request.json` that names a workspace no `runs.ndjson` line attaches, then every launch whose
   * `launch-complete` line never landed (it reads the attachments the step before left consistent), and
   * last every active Production head whose approval record landed and whose lock commit did not.
   */
  reconcileAll(store: FileStore): ReconcileReport {
    const report: ReconcileReport = { reconciledHeads: [], attached: [], completedSupersedes: [], stuckSupersedes: [], torn: [], lockedAtBoot: [], completedLaunches: [] };
    const ids = this.ids();
    for (const id of ids) {
      if (this.reconcile(id)) report.reconciledHeads.push(id);
      for (const file of [HISTORY, SETUPS, RUNS]) {
        if (parseLines(this.file(id, file)).tornFinal) {
          const msg = `workspace ${id}: torn final line in ${file} ignored`;
          report.torn.push(msg);
          if (!this.torn.includes(msg)) this.torn.push(msg);
        }
      }
    }

    for (const id of ids) {
      const outcome = this.completePendingSupersede(id);
      if (outcome === "completed") report.completedSupersedes.push(id);
      else if (outcome !== null) report.stuckSupersedes.push(outcome.stuck);
    }

    const attachedIn = new Map<string, Set<string>>();
    const everAttached = new Set<string>();
    for (const id of ids) {
      const runs = new Set(this.readLines<RunAttachment>(id, RUNS).map((a) => a.runId));
      attachedIn.set(id, runs);
      for (const r of runs) everAttached.add(r);
    }
    for (const runId of store.listRunIds()) {
      if (everAttached.has(runId) || !store.runFileExists(runId, "request.json")) continue;
      // Cheap text test first: most runs predate workspaces and name none.
      if (!store.readRunBytes(runId, "request.json").toString("utf8").includes('"workspaceId"')) continue;
      let ws: { workspaceId?: unknown; setupLineageId?: unknown; launchNo?: unknown; consumed?: unknown } | undefined;
      try {
        ws = (store.readRunJson<{ workspace?: typeof ws }>(runId, "request.json")).workspace;
      } catch {
        continue;
      }
      if (!ws || typeof ws.workspaceId !== "string" || !attachedIn.has(ws.workspaceId)) continue;
      const line: RunAttachment = {
        runId,
        attachedBy: "reconcile",
        at: new Date().toISOString(),
        pins: ws.consumed !== undefined && ws.consumed !== null ? "consumed" : "reconstructed",
      };
      if (typeof ws.setupLineageId === "string") line.setupLineageId = ws.setupLineageId;
      if (typeof ws.launchNo === "number") line.launchNo = ws.launchNo;
      this.appendRunAttachment(ws.workspaceId, line);
      attachedIn.get(ws.workspaceId)!.add(runId);
      report.attached.push(runId);
    }
    for (const id of ids) {
      for (const launchNo of this.completeCrashedLaunches(id)) report.completedLaunches.push({ workspaceId: id, launchNo });
    }
    report.lockedAtBoot = this.lockApprovedAtBoot(store, ids);
    return report;
  }

  /**
   * The launch crash case: the server died after a `launch` line and before its
   * `launch-complete`. Forward only, as a supersede is: each such launch gets the completion line with the
   * runs that `runs.ndjson` attaches for its slot and launch number (the request.json scan above has
   * already attached any run whose attachment line was lost), `failed` empty because no refusal was
   * recorded, and `reconciled: true`. Returns the launch numbers completed, in line order.
   */
  private completeCrashedLaunches(id: string): number[] {
    const events = this.readLines<SetupEvent>(id, SETUPS);
    const key = (lineage: string, n: number) => `${lineage}\u0000${n}`;
    const complete = new Set(events.filter((e) => e.t === "launch-complete").map((e) => key(e.setupLineageId, e.launchNo)));
    const open = events.filter((e): e is Extract<SetupEvent, { t: "launch" }> => e.t === "launch" && !complete.has(key(e.setupLineageId, e.launchNo)));
    if (open.length === 0) return [];
    const attachments = this.readLines<RunAttachment>(id, RUNS);
    const done: number[] = [];
    for (const launch of open) {
      const runIds = [
        ...new Set(attachments.filter((a) => a.setupLineageId === launch.setupLineageId && a.launchNo === launch.launchNo).map((a) => a.runId)),
      ];
      this.appendSetupEvent(id, {
        t: "launch-complete",
        setupLineageId: launch.setupLineageId,
        launchNo: launch.launchNo,
        at: new Date().toISOString(),
        runIds,
        failed: [],
        reconciled: true,
      });
      complete.add(key(launch.setupLineageId, launch.launchNo));
      done.push(launch.launchNo);
    }
    return done;
  }

  /**
   * The sign-off crash case: the approval record landed, the lock did
   * not. Every `active` Production head whose newest `workspaces` approval record at its CURRENT
   * signedHash is `approved` is locked on that record, with a `reconciled: true` history line. An
   * approval at an older hash locks nothing (the head moved after it). Forward only: nothing here
   * ever clears a lock. Returns the ids locked, ascending.
   */
  private lockApprovedAtBoot(store: FileStore, ids: string[]): string[] {
    const candidates = ids.map((id) => this.head(id)).filter((h) => h.type === "production" && h.status === "active" && h.lock === null);
    if (candidates.length === 0) return [];
    const records = store
      .listMeta("approvals")
      .map((meta) => store.getDocument<ApprovalRecord>("approvals", meta.id).doc)
      .filter((r) => r.artifactCollection === "workspaces");
    const locked: string[] = [];
    for (const head of candidates) {
      const { state, latest } = approvalState(records.filter((r) => r.artifactId === head.id), head.signedHash);
      if (state !== "approved" || latest === null) continue;
      const now = new Date().toISOString();
      const next = this.stamp(
        { ...head, status: "locked", lock: { lockedAt: now, by: latest.by, approvalId: latest.id, signedHash: latest.artifactContentHash } },
        head.revision + 1,
        now,
      );
      this.write(head.id, latest.by, { kind: "lock", approvalId: latest.id }, next, true);
      locked.push(head.id);
    }
    return locked;
  }

  /**
   * One supersede clone, completed forward. A head with `pendingSupersede` and a source: when the
   * source is not yet `superseded`, write step 2 (status and `supersededBy`), then step 3 (clear the
   * flag), both lines `reconciled: true` and attributed to whoever started the clone. Returns
   * "completed" when the clone is complete afterwards because of this call, null when it was not
   * pending. A missing source, or one already superseded by a different workspace, is left alone
   * (nothing is overwritten) and returned as `{ stuck }`, the boot-log message (review B m5).
   */
  private completePendingSupersede(id: string): "completed" | { stuck: string } | null {
    let clone: WorkspaceManifest;
    try {
      clone = this.head(id);
    } catch {
      return null;
    }
    if (!clone.lineage.pendingSupersede) return null;
    const sourceId = clone.lineage.fromWorkspaceId;
    const stuck = (reason: string) => ({ stuck: `workspace ${id}: pending supersede of "${sourceId ?? "(none)"}" cannot complete: ${reason}` });
    if (sourceId === null) return stuck("the clone names no source");
    if (!this.has(sourceId)) return stuck(`"${sourceId}" does not exist`);
    const by = this.readLines<HistoryLine>(id, HISTORY)[0]?.by ?? "reconcile";
    let source = this.head(sourceId);
    if (source.status !== "superseded") {
      if (source.lineage.supersededBy !== null && source.lineage.supersededBy !== id) {
        return stuck(`"${sourceId}" names "${source.lineage.supersededBy}" as its successor`);
      }
      source = this.commit(
        sourceId,
        source.revision,
        by,
        { kind: "supersede", by: id },
        { ...source, status: "superseded", lineage: { ...source.lineage, supersededBy: id } },
        { reconciled: true },
      );
    } else if (source.lineage.supersededBy !== id) {
      return stuck(`"${sourceId}" was superseded by "${source.lineage.supersededBy ?? "(unrecorded)"}"`);
    }
    this.commit(
      id,
      clone.revision,
      by,
      { kind: "meta" },
      { ...clone, lineage: { ...clone.lineage, pendingSupersede: false } },
      { reconciled: true },
    );
    return "completed";
  }

  // --- mutex ---------------------------------------------------------------

  /**
   * One in-process mutex per id. Ids are deduplicated and sorted, and every tail is claimed in one
   * synchronous step, so two multi-id callers can never deadlock. Not reentrant.
   */
  withLock<T>(ids: string[], fn: () => Promise<T> | T): Promise<T> {
    const sorted = [...new Set(ids)].sort();
    const waits = sorted.map((id) => this.tails.get(id) ?? Promise.resolve());
    const run = Promise.all(waits).then(() => fn());
    const release = run.then(
      () => undefined,
      () => undefined,
    );
    for (const id of sorted) this.tails.set(id, release);
    void release.then(() => {
      for (const id of sorted) if (this.tails.get(id) === release) this.tails.delete(id);
    });
    return run;
  }

  // --- writes --------------------------------------------------------------

  private stamp(m: WorkspaceManifest, revision: number, now: string): WorkspaceManifest {
    const next = { ...m, revision, updatedAt: now } as WorkspaceManifest;
    next.blockHashes = blockHashes(next.blocks);
    next.signedHash = signedHashOf(next);
    next.manifestHash = manifestHashOf(next);
    return next;
  }

  /** History line first, then the head: the order the crash recovery rests on. `reconciled` marks a boot-reconcile write. */
  private write(id: string, by: string, change: HistoryChange, manifest: WorkspaceManifest, reconciled = false): void {
    const line: HistoryLine = { revision: manifest.revision, at: manifest.updatedAt, by, change, manifest, ...(reconciled ? { reconciled: true as const } : {}) };
    this.appendLine(this.file(id, HISTORY), line);
    writeFileAtomic(this.file(id, MANIFEST), serializeDocument(manifest));
    this.settled.set(id, this.historySize(id));
  }

  /** Revision 1. Refuses an id that already has a head or a history. */
  create(manifest: WorkspaceManifest, by: string): WorkspaceManifest {
    const id = assertValidId(manifest.id);
    if (this.has(id)) throw new AlreadyExistsError("workspace", id);
    const first = this.stamp(manifest, 1, new Date().toISOString());
    this.write(id, by, { kind: "create" }, first);
    return first;
  }

  // --- lock-pending (review B m2) ------------------------------------------

  markLockPending(id: string, pending: PendingLock): void {
    this.pendingLocks.set(id, pending);
  }
  pendingLock(id: string): PendingLock | null {
    return this.pendingLocks.get(id) ?? null;
  }
  /**
   * Throws LockPending while a sign-off's lock is outstanding. The writes a locked month accepts pass:
   * the lock itself, rename or note, and the supersede mark (none moves signedHash).
   */
  assertNoPendingLock(id: string, change?: HistoryChange): void {
    const pending = this.pendingLocks.get(id);
    if (pending === undefined) return;
    if (change !== undefined && (change.kind === "lock" || change.kind === "meta" || change.kind === "supersede")) return;
    throw new LockPending(id, pending.approvalId);
  }

  /** `opts.reconciled` marks the line as written by boot reconcile completing a crashed multi-step write forward. */
  commit(id: string, expectedRevision: number, by: string, change: HistoryChange, next: WorkspaceManifest, opts?: { reconciled?: boolean }): WorkspaceManifest {
    const current = this.head(id);
    // A lock commit whose history line landed before its head write failed is locked after reconcile.
    if (current.lock !== null) this.pendingLocks.delete(id);
    this.assertNoPendingLock(id, change);
    if (current.revision !== expectedRevision) throw new RevisionConflict(id, expectedRevision, current.revision);
    if (next.id !== id) throw new Error(`workspace commit: manifest id "${next.id}" does not match "${id}"`);
    const stamped = this.stamp(next, expectedRevision + 1, new Date().toISOString());
    this.write(id, by, change, stamped, opts?.reconciled === true);
    if (change.kind === "lock") this.pendingLocks.delete(id);
    return stamped;
  }

  // --- setups.ndjson and runs.ndjson ---------------------------------------

  appendSetupEvent(id: string, line: SetupEvent): void {
    this.appendLine(this.file(id, SETUPS), line);
  }
  readSetupEvents(id: string): SetupEvent[] {
    return this.readLines<SetupEvent>(id, SETUPS);
  }
  appendRunAttachment(id: string, line: RunAttachment): void {
    this.appendLine(this.file(id, RUNS), line);
  }
  readRunAttachments(id: string): RunAttachment[] {
    return this.readLines<RunAttachment>(id, RUNS);
  }
  /** The guided path's own record of the stochastic runs it launched; runs.ndjson is untouched by it. */
  appendGuidedRun(id: string, line: GuidedRunLink): void {
    this.appendLine(this.file(id, GUIDED_RUNS), line);
  }
  readGuidedRuns(id: string): GuidedRunLink[] {
    return this.readLines<GuidedRunLink>(id, GUIDED_RUNS);
  }

  // --- server marker (MINOR 8) ---------------------------------------------

  writeServerMarker(pid: number): void {
    writeFileAtomic(join(this.dir, ".server.json"), serializeDocument({ pid, startedAt: new Date().toISOString() }));
  }

  /** The marker's server when its pid is alive; null when absent, unreadable or dead. */
  liveServer(): { pid: number; startedAt: string } | null {
    const p = join(this.dir, ".server.json");
    if (!existsSync(p)) return null;
    let marker: { pid?: unknown; startedAt?: unknown };
    try {
      marker = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
    if (typeof marker.pid !== "number" || !Number.isInteger(marker.pid) || marker.pid <= 0) return null;
    try {
      process.kill(marker.pid, 0);
    } catch (err) {
      // EPERM means the process exists but is not ours to signal: alive. ESRCH means gone.
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return null;
    }
    return { pid: marker.pid, startedAt: typeof marker.startedAt === "string" ? marker.startedAt : "" };
  }
}
