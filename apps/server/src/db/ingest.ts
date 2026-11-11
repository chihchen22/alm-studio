/**
 * File-store -> database ingest.
 *
 * The append-only file store remains the byte store of record; this module
 * mirrors it into the relational database, idempotently and content-hash
 * verified:
 *
 *  - a document already present with the SAME content hash is skipped;
 *  - a document already present with a DIFFERENT hash is a divergence — the
 *    append-only invariant was violated somewhere — and the sync REFUSES;
 *  - document bytes are re-hashed on the way in and checked against the
 *    file-store meta contentHash; a mismatch refuses (never ingest bytes that
 *    do not match their own pin);
 *  - each document and its exploded projection rows land in one transaction.
 *
 * Run ingest pins every referenced artifact by content hash into run_inputs
 * (the portfolio pin comes from the submission-time pin in request.json; the
 * others resolve against the already-ingested documents), stores the verbatim
 * request.json bytes, and links the stored result by path + hash once done.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PortfolioSpec, Position, AssumptionSet, Scenario } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { FileStore, sha256Hex, type DocumentMeta } from "../store/store";
import type { Collection } from "../store/paths";
import type { RunStatus, StoredRunRequest } from "../jobs/types";
import type { PlatformContext } from "../context";
import { defaultDbPath, openPlatformDb, type PlatformDb } from "./database";

/** Thrown when the database and the file store disagree about stored content. */
export class StoreDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreDivergenceError";
  }
}

/** Minimal structural shape of a stored scenario slate document. */
interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

export interface DbSyncReport {
  documentsIngested: string[];
  documentsSkipped: number;
  positionsInserted: number;
  positionsUnrecognizedType: number;
  curvePointsInserted: number;
  capVolPointsInserted: number;
  swaptionVolPointsInserted: number;
  bindingsInserted: number;
  scenariosInserted: number;
  runsIngested: string[];
  runsUpdated: string[];
  runsSkipped: number;
  elapsedMs: number;
}

function emptyReport(): DbSyncReport {
  return {
    documentsIngested: [],
    documentsSkipped: 0,
    positionsInserted: 0,
    positionsUnrecognizedType: 0,
    curvePointsInserted: 0,
    capVolPointsInserted: 0,
    swaptionVolPointsInserted: 0,
    bindingsInserted: 0,
    scenariosInserted: 0,
    runsIngested: [],
    runsUpdated: [],
    runsSkipped: 0,
    elapsedMs: 0,
  };
}

/** Rate column extraction: which term field carries the position's rate. */
function rateOf(terms: Position["terms"]): {
  rate: number | null;
  rateKind: string;
  behavioral: string | null;
} {
  const t = terms as unknown as Record<string, unknown> & { type: string };
  switch (t.type) {
    case "fixed-loan":
      return { rate: t.coupon as number, rateKind: "coupon", behavioral: null };
    case "floating-loan":
      return { rate: t.margin as number, rateKind: "margin", behavioral: null };
    case "mortgage":
      return { rate: t.noteRate as number, rateKind: "note-rate", behavioral: "cpr-params" };
    case "nmd":
      return { rate: t.depositRate as number, rateKind: "deposit-rate", behavioral: "nmd-params" };
    case "nmd-b":
      // The deposit rate is model-implied by the beta S-curve; a NULL rate with
      // a named kind is honest, a fabricated number would not be.
      return { rate: null, rateKind: "beta-s-curve", behavioral: "beta-s-curve+nmd-params" };
    case "cd":
      // W3-A2b cohort-book arm: the position carries per-cohort contract
      // rates, not one scalar rate; a NULL rate with a named kind is honest
      // (same convention as nmd-b), and the cohorts live in terms_json.
      return { rate: null, rateKind: "cohort-book", behavioral: "cd-cohorts" };
    case "commitment":
      // An undrawn committed line has no rate to carry. It is
      // optional capacity, not a funded balance, so the rate column is NULL
      // under a named kind, the nmd-b and cd convention. The authored draw
      // path lives in terms_json; `notional` is the UNDRAWN amount, not a
      // booked asset.
      return { rate: null, rateKind: "undrawn-line", behavioral: "draw-path" };
    case "swap":
      // The fixed leg's coupon is the one scalar rate a swap carries.
      // The floating leg's rate is path-implied and lives nowhere as a number;
      // direction, margin and reset cadence are in terms_json.
      return { rate: t.fixedRate as number, rateKind: "swap-fixed-rate", behavioral: null };
    default:
      // A terms arm this module predates (e.g. a future `cd` arm): store the
      // verbatim terms and say plainly that the rate column is not populated.
      return { rate: null, rateKind: `unrecognized:${t.type}`, behavioral: null };
  }
}

/**
 * The mirrored `side` for one position (schema 1.1.0).
 *
 * A commitment family is declared asset-side in the chart of accounts, so
 * mirroring the family's side verbatim wrote an undrawn line into the ASSET
 * bucket and made `SUM(notional) GROUP BY side` disagree with the portfolio's
 * own intake metadata, which excludes it (scripts/seed-store.ts). The two
 * planes now key off the same thing, the position's instrument TYPE, and the
 * SQL asset bucket reconciles to `intake.assets` exactly.
 *
 * A named third value rather than NULL or an omitted row: the row must stay
 * present and queryable (an undrawn line IS a real exposure), and a NULL side
 * could not be told apart from a family the chart of accounts failed to
 * resolve, which the `?? null` fallback below already uses.
 *
 * A swap (schema 1.2.0) needs no special case: its family declares
 * side "derivative", which is mirrored verbatim and is admitted by the CHECK.
 */
function mirroredSide(terms: Position["terms"], familySide: string | undefined): string | null {
  if (terms.type === "commitment") return "off-balance-sheet";
  return familySide ?? null;
}

function explodePortfolio(db: PlatformDb, spec: PortfolioSpec, report: DbSyncReport): void {
  const sideOf = new Map(spec.coa.families.map((f) => [f.id, f.side]));
  const stmt = db.db.prepare(
    `INSERT INTO positions (portfolio_id, position_id, family_id, coa_node_id, side,
       instrument_type, notional, rate, rate_kind, maturity_months,
       origination_offset_months, amort_type, behavioral, terms_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of spec.positions) {
    const terms = p.terms;
    if (!Number.isFinite(terms.notional)) {
      throw new StoreDivergenceError(
        `portfolio "${spec.id}" position "${p.id}" carries a non-finite notional; refusing to ingest`,
      );
    }
    const { rate, rateKind, behavioral } = rateOf(terms);
    if (rateKind.startsWith("unrecognized:")) report.positionsUnrecognizedType += 1;
    stmt.run(
      spec.id,
      p.id,
      p.familyId,
      p.coaNodeId,
      mirroredSide(terms, sideOf.get(p.familyId)),
      terms.type,
      terms.notional,
      rate,
      rateKind,
      terms.maturityMonths,
      terms.originationOffsetMonths ?? 0,
      terms.amortType,
      behavioral,
      JSON.stringify(terms),
    );
    report.positionsInserted += 1;
  }
}

function explodeMarket(db: PlatformDb, id: string, snap: MarketSnapshot, report: DbSyncReport): void {
  const asOf = snap.calibrationDate;
  const curve = db.db.prepare(
    `INSERT INTO curve_points (market_id, as_of, curve, seq, term, t_years, instrument_type, value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  snap.curveQuotes.forEach((q, i) => {
    curve.run(id, asOf, "risk-free", i, q.term, q.tYears, q.instrumentType, q.rate);
    report.curvePointsInserted += 1;
  });
  snap.termFundingCurveQuotes.forEach((q, i) => {
    curve.run(id, asOf, "term-funding", i, q.term, q.tYears, null, q.rate);
    report.curvePointsInserted += 1;
  });
  snap.tlpNodes.forEach((n, i) => {
    curve.run(id, asOf, "tlp", i, null, n.tYears, null, n.spread);
    report.curvePointsInserted += 1;
  });
  const cap = db.db.prepare(
    `INSERT INTO cap_vol_points (market_id, as_of, seq, expiry_years, strike, is_atm, normal_vol)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  snap.capQuotes.forEach((q, i) => {
    cap.run(id, asOf, i, q.expiryYears, q.strike, q.isAtm ? 1 : 0, q.normalVol);
    report.capVolPointsInserted += 1;
  });
  const swp = db.db.prepare(
    `INSERT INTO swaption_vol_points (market_id, as_of, seq, expiry_years, tenor_years, normal_vol)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  snap.swaptionATMQuotes.forEach((q, i) => {
    swp.run(id, asOf, i, q.expiryYears, q.tenorYears, q.normalVol);
    report.swaptionVolPointsInserted += 1;
  });
}

function explodeAssumptionSet(db: PlatformDb, set: AssumptionSet, report: DbSyncReport): void {
  const stmt = db.db.prepare(
    `INSERT INTO assumption_bindings (set_id, seq, family_id, overlay_kind, model_version, overlay_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  set.bindings.forEach((b, i) => {
    stmt.run(set.id, i, b.familyId, b.overlay.kind, b.modelVersion, JSON.stringify(b.overlay));
    report.bindingsInserted += 1;
  });
}

function explodeSlate(db: PlatformDb, slate: SlateDoc, report: DbSyncReport): void {
  const stmt = db.db.prepare(
    `INSERT INTO slate_scenarios (slate_id, seq, scenario_id, label, assumption_set_id,
       rate_spec_kind, rate_spec_json, new_business_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  slate.scenarios.forEach((s, i) => {
    stmt.run(
      slate.id,
      i,
      s.id,
      s.label,
      s.assumptionSetId,
      s.rateSpec.kind,
      JSON.stringify(s.rateSpec),
      s.newBusiness.mode,
    );
    report.scenariosInserted += 1;
  });
}

/**
 * Ingest one document: verify bytes against the file-store pin, insert the
 * verbatim bytes plus the exploded projection in one transaction. Skips a
 * matching existing row; refuses a diverging one.
 */
function ingestDocument(
  db: PlatformDb,
  store: FileStore,
  collection: Collection,
  meta: DocumentMeta,
  report: DbSyncReport,
): void {
  const existing = db.db
    .prepare("SELECT content_hash FROM documents WHERE collection = ? AND id = ?")
    .get(collection, meta.id) as { content_hash: string } | undefined;
  if (existing !== undefined) {
    if (existing.content_hash !== meta.contentHash) {
      throw new StoreDivergenceError(
        `document ${collection}/${meta.id} exists in the database with content hash ` +
          `${existing.content_hash} but the file store now carries ${meta.contentHash}; ` +
          `the store is append-only, so a changed document under the same id is a corruption — refusing to sync`,
      );
    }
    report.documentsSkipped += 1;
    return;
  }
  const bytes = store.getDocumentBytes(collection, meta.id);
  const actualHash = sha256Hex(bytes);
  if (actualHash !== meta.contentHash) {
    throw new StoreDivergenceError(
      `document ${collection}/${meta.id} bytes hash ${actualHash} but its store meta pins ` +
        `${meta.contentHash}; refusing to ingest bytes that fail their own pin`,
    );
  }
  db.transaction(() => {
    db.db
      .prepare(
        `INSERT INTO documents (collection, id, content_hash, body, meta_json, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(collection, meta.id, meta.contentHash, bytes, JSON.stringify(meta), new Date().toISOString());
    const doc: unknown = JSON.parse(bytes.toString("utf8"));
    if (collection === "portfolios") explodePortfolio(db, doc as PortfolioSpec, report);
    else if (collection === "market") explodeMarket(db, meta.id, doc as MarketSnapshot, report);
    else if (collection === "assumption-sets") explodeAssumptionSet(db, doc as AssumptionSet, report);
    else if (collection === "scenario-slates") explodeSlate(db, doc as SlateDoc, report);
    // "coa": the verbatim document row is the whole story.
  });
  report.documentsIngested.push(`${collection}/${meta.id}`);
}

/** Resolve a referenced document's content hash from the database or refuse. */
function requireDocHash(db: PlatformDb, collection: Collection, id: string, runId: string): string {
  const row = db.db
    .prepare("SELECT content_hash FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { content_hash: string } | undefined;
  if (row === undefined) {
    throw new StoreDivergenceError(
      `run "${runId}" references ${collection}/"${id}" which is not in the database; ` +
        `sync documents before runs (the migrate script does) or repair the store`,
    );
  }
  return row.content_hash;
}

const RUN_LIFECYCLE_UPDATE = `UPDATE runs SET state = ?, phase = ?, label = ?, started_at = ?,
  ended_at = ?, elapsed_ms = ?, engine_inputs_hash = ?, result_ref = ?, result_content_hash = ?,
  result_bytes = ?, error_message = ? WHERE run_id = ?`;

interface RunResultLink {
  engineInputsHash: string | null;
  resultRef: string | null;
  resultContentHash: string | null;
  resultBytes: number | null;
}

function resultLink(store: FileStore, runId: string, state: string): RunResultLink {
  if (state !== "done" || !store.runFileExists(runId, "result.json")) {
    return { engineInputsHash: null, resultRef: null, resultContentHash: null, resultBytes: null };
  }
  const bytes = store.readRunBytes(runId, "result.json");
  let engineInputsHash: string | null = null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      provenance?: { inputsHash?: string };
    };
    engineInputsHash = parsed.provenance?.inputsHash ?? null;
  } catch {
    // A torn result never becomes a fabricated hash; the link stays result-only.
  }
  return {
    engineInputsHash,
    resultRef: join("runs", runId, "result.json").replace(/\\/g, "/"),
    resultContentHash: sha256Hex(bytes),
    resultBytes: bytes.length,
  };
}

function ingestRun(db: PlatformDb, store: FileStore, runId: string, report: DbSyncReport): void {
  if (!store.runFileExists(runId, "request.json") || !store.runFileExists(runId, "status.json")) {
    // A half-written run directory (crash between files) is skipped, not invented.
    report.runsSkipped += 1;
    return;
  }
  const requestBytes = store.readRunBytes(runId, "request.json");
  const stored = JSON.parse(requestBytes.toString("utf8")) as StoredRunRequest;
  const status = store.readRunJson<RunStatus>(runId, "status.json");
  const link = resultLink(store, runId, status.state);

  const existing = db.db
    .prepare("SELECT state, platform_request_hash FROM runs WHERE run_id = ?")
    .get(runId) as { state: string; platform_request_hash: string } | undefined;
  const requestHash = sha256Hex(requestBytes);

  if (existing !== undefined) {
    if (existing.platform_request_hash !== requestHash) {
      throw new StoreDivergenceError(
        `run "${runId}" request bytes hash ${requestHash} but the database pinned ` +
          `${existing.platform_request_hash}; a run's request is immutable — refusing to sync`,
      );
    }
    if (existing.state === status.state) {
      report.runsSkipped += 1;
      return;
    }
    db.db
      .prepare(RUN_LIFECYCLE_UPDATE)
      .run(
        status.state,
        status.phase ?? null,
        status.label ?? null,
        status.startedAt ?? null,
        status.endedAt ?? null,
        status.elapsedMs ?? null,
        link.engineInputsHash,
        link.resultRef,
        link.resultContentHash,
        link.resultBytes,
        status.error?.message ?? null,
        runId,
      );
    report.runsUpdated.push(runId);
    return;
  }

  const sub = stored.submission;
  db.transaction(() => {
    db.db
      .prepare(
        `INSERT INTO runs (run_id, state, phase, label, submitted_at, started_at, ended_at,
           elapsed_ms, platform_request_hash, engine_inputs_hash, seed, grid_json,
           engine_context_json, request_body, result_ref, result_content_hash, result_bytes,
           error_message, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        status.state,
        status.phase ?? null,
        status.label ?? null,
        status.submittedAt ?? null,
        status.startedAt ?? null,
        status.endedAt ?? null,
        status.elapsedMs ?? null,
        requestHash,
        link.engineInputsHash,
        stored.request.seed,
        JSON.stringify(stored.request.grid),
        JSON.stringify(stored.engineContext),
        requestBytes,
        link.resultRef,
        link.resultContentHash,
        link.resultBytes,
        status.error?.message ?? null,
        new Date().toISOString(),
      );
    const input = db.db.prepare(
      `INSERT INTO run_inputs (run_id, role, ord, collection, doc_id, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Portfolio pin: taken at submission time, carried verbatim (pin-vs-artifact).
    input.run(runId, "portfolio", 0, "portfolios", stored.portfolioRef.id, stored.portfolioRef.contentHash);
    input.run(runId, "market", 0, "market", sub.marketId, requireDocHash(db, "market", sub.marketId, runId));
    input.run(
      runId,
      "scenario-slate",
      0,
      "scenario-slates",
      sub.scenarioSlateId,
      requireDocHash(db, "scenario-slates", sub.scenarioSlateId, runId),
    );
    sub.assumptionSetIds.forEach((setId, i) => {
      input.run(runId, "assumption-set", i, "assumption-sets", setId, requireDocHash(db, "assumption-sets", setId, runId));
    });
  });
  report.runsIngested.push(runId);
}

/** The collections the database holds (the `documents.collection` CHECK in the schema). */
const MIRRORED_COLLECTIONS = ["portfolios", "market", "assumption-sets", "scenario-slates", "coa"] as const;

/**
 * Mirror the whole file store into the database. Idempotent: matching content
 * is skipped, new content is ingested, diverging content refuses. Documents
 * sync before runs so run_inputs pins always resolve.
 */
export function syncStoreToDb(store: FileStore, db: PlatformDb): DbSyncReport {
  const t0 = performance.now();
  const report = emptyReport();
  for (const collection of MIRRORED_COLLECTIONS) {
    for (const meta of store.listMeta(collection)) ingestDocument(db, store, collection, meta, report);
  }
  for (const runId of store.listRunIds()) ingestRun(db, store, runId, report);
  report.elapsedMs = Math.round(performance.now() - t0);
  return report;
}

/**
 * Mirror ONE stored document, at once (blank-path round, D1 server). An import route calls this after the
 * store write so the catalog and lineage reads answer for the document without a reboot. Same rules as the
 * whole-store sync: a matching row is skipped, bytes are re-hashed against the store pin, a diverging row
 * refuses. Idempotent: a second call for the same document ingests nothing.
 *
 * It opens its OWN writable connection to the platform database file and closes it before returning. The
 * Catalog holds a separate lazy `query_only` connection that never writes; under WAL that reader starts a
 * fresh read transaction per statement, so it sees this commit on its next query without reopening.
 *
 * A store whose database has not been created yet (nothing seeded, nothing migrated) is left alone: creating
 * `platform.db` here would make the catalog answer from a one-document mirror. The first boot sync mirrors
 * the whole store, this document included.
 *
 * Throws on a collection the database does not hold and on any ingest failure; the route helper
 * `mirrorBestEffort` is the caller that must never let that reach a client.
 */
export function syncDocumentToDb(
  ctx: Pick<PlatformContext, "store">,
  collection: Collection,
  id: string,
): DbSyncReport {
  const t0 = performance.now();
  const report = emptyReport();
  if (!(MIRRORED_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new Error(
      `collection "${collection}" is not mirrored in the platform database ` +
        `(mirrored: ${MIRRORED_COLLECTIONS.join(", ")}); cannot sync ${collection}/${id}`,
    );
  }
  const { store } = ctx;
  const dbPath = defaultDbPath(store.paths.root);
  if (!existsSync(dbPath)) {
    report.elapsedMs = Math.round(performance.now() - t0);
    return report;
  }
  const meta = store.getMeta(collection, id);
  const db = openPlatformDb(dbPath);
  try {
    ingestDocument(db, store, collection, meta, report);
  } finally {
    db.close();
  }
  report.elapsedMs = Math.round(performance.now() - t0);
  return report;
}

/**
 * Mirror ONE run, at once (blank-path round, D1 server). The queue calls this after a run's terminal status
 * is written (done, error, cancelled, interrupted) so `GET /api/catalog/runs`, the run-inputs read and the
 * lineage `consumedBy` lists answer for it without a reboot. It is `ingestRun`, unchanged: a run not yet in
 * the database is inserted with its input pins, a run already there at an older state takes the lifecycle
 * update, one already at this state is skipped, and a run whose request bytes diverge from the pin refuses.
 * Idempotent.
 *
 * Same connection and same no-database rule as `syncDocumentToDb`: its own writable connection, closed in
 * `finally`, and a store whose `platform.db` does not exist yet is left alone (the first boot sync mirrors
 * the whole store, this run included). A done run's `result.json` is read and hashed here, so the cost
 * follows the result size; the queue defers this call to its own turn of the event loop.
 *
 * Throws on any ingest failure, including an input document the database does not hold yet (the run pins
 * resolve against mirrored documents). The queue's best-effort wrapper is the caller that must never let
 * that reach run completion.
 */
export function syncRunToDb(ctx: Pick<PlatformContext, "store">, runId: string): DbSyncReport {
  const t0 = performance.now();
  const report = emptyReport();
  const { store } = ctx;
  const dbPath = defaultDbPath(store.paths.root);
  if (!existsSync(dbPath)) {
    report.elapsedMs = Math.round(performance.now() - t0);
    return report;
  }
  const db = openPlatformDb(dbPath);
  try {
    ingestRun(db, store, runId, report);
  } finally {
    db.close();
  }
  report.elapsedMs = Math.round(performance.now() - t0);
  return report;
}
