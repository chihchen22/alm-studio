/**
 * Database-side run-input resolution.
 *
 * Rebuilds the COMPLETE input set of a simulation from the database alone —
 * portfolio, market snapshot, scenario slate, assumption sets, grid, seed —
 * mirroring exactly the composition the run routes perform against the file
 * store (apps/server/src/http/routes/runs.ts). The byte-parity anchor in
 * __tests__/db.test.ts proves a run executed against these DB-resolved inputs
 * is byte-identical to the same run resolved from the file store.
 *
 * Every document read re-hashes the stored bytes against the row's pinned
 * content hash: the database is tamper-evident on read, not just guarded on
 * write.
 */
import type { AssumptionSet, PortfolioSpec, RunRequest, Scenario } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { sha256Hex } from "../store/store";
import type { Collection } from "../store/paths";
import type { StoredEngineContext } from "../jobs/types";
import type { PlatformDb } from "./database";

/** Thrown when a requested document is not in the database. */
export class DbNotFoundError extends Error {
  constructor(collection: string, id: string) {
    super(`database has no ${collection} document "${id}"`);
    this.name = "DbNotFoundError";
  }
}

/** Thrown when stored bytes fail their own content-hash pin. */
export class DbIntegrityError extends Error {
  constructor(collection: string, id: string, pinned: string, actual: string) {
    super(
      `database document ${collection}/"${id}" bytes hash ${actual} but the row pins ${pinned}; ` +
        `refusing to serve tampered or corrupt content`,
    );
    this.name = "DbIntegrityError";
  }
}

export interface VerifiedDocument<T> {
  id: string;
  contentHash: string;
  bytes: Uint8Array;
  doc: T;
  meta: Record<string, unknown>;
}

/** Read a document's verbatim bytes, verify the pin, parse. */
export function readDocumentVerified<T>(
  db: PlatformDb,
  collection: Collection,
  id: string,
): VerifiedDocument<T> {
  const row = db.db
    .prepare("SELECT content_hash, body, meta_json FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { content_hash: string; body: Uint8Array; meta_json: string } | undefined;
  if (row === undefined) throw new DbNotFoundError(collection, id);
  const actual = sha256Hex(row.body);
  if (actual !== row.content_hash) throw new DbIntegrityError(collection, id, row.content_hash, actual);
  return {
    id,
    contentHash: row.content_hash,
    bytes: row.body,
    doc: JSON.parse(Buffer.from(row.body).toString("utf8")) as T,
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
  };
}

/** What a run submission names; mirrors the platform submit body references. */
export interface RunInputSpec {
  runId: string;
  portfolioId: string;
  marketId: string;
  scenarioSlateId: string;
  assumptionSetIds: string[];
  gridHorizonMonths: number;
  seed: string;
  engineContext: StoredEngineContext;
}

export interface ResolvedRunInputs {
  /** RunRequest with placeholder timestamps (the runner injects the clock). */
  request: RunRequest;
  portfolio: PortfolioSpec;
  engineContext: StoredEngineContext;
  /** Content-hash pins over every resolved artifact, portfolio included. */
  pins: Array<{ role: string; collection: Collection; id: string; contentHash: string }>;
}

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

/**
 * Compose the full RunRequest from database documents, field-for-field the way
 * the run route composes it from the file store: market snapshot inlined,
 * slate scenarios verbatim, assumption sets in submission order, grid asOf
 * taken from the portfolio meta (the platform never invents a date).
 */
export function composeRunInputsFromDb(db: PlatformDb, spec: RunInputSpec): ResolvedRunInputs {
  const portfolio = readDocumentVerified<PortfolioSpec>(db, "portfolios", spec.portfolioId);
  const market = readDocumentVerified<MarketSnapshot>(db, "market", spec.marketId);
  const slate = readDocumentVerified<SlateDoc>(db, "scenario-slates", spec.scenarioSlateId);
  const sets = spec.assumptionSetIds.map((id) =>
    readDocumentVerified<AssumptionSet>(db, "assumption-sets", id),
  );

  const setIds = new Set(spec.assumptionSetIds);
  const unresolved = slate.doc.scenarios.filter((s) => !setIds.has(s.assumptionSetId));
  if (unresolved.length > 0) {
    throw new DbNotFoundError(
      "assumption-sets",
      [...new Set(unresolved.map((s) => s.assumptionSetId))].join(", "),
    );
  }

  const asOf = portfolio.meta.asOf;
  if (typeof asOf !== "string" || asOf.length === 0) {
    throw new DbIntegrityError(
      "portfolios",
      spec.portfolioId,
      "meta.asOf (a date)",
      String(asOf),
    );
  }

  const request: RunRequest = {
    runId: spec.runId,
    portfolioId: spec.portfolioId,
    marketSnapshot: market.doc,
    scenarios: slate.doc.scenarios,
    assumptionSets: sets.map((s) => s.doc),
    grid: { horizonMonths: spec.gridHorizonMonths, asOf },
    seed: spec.seed,
    timestamps: { startedAt: "", finishedAt: "" },
  };
  return {
    request,
    portfolio: portfolio.doc,
    engineContext: spec.engineContext,
    pins: [
      { role: "portfolio", collection: "portfolios", id: portfolio.id, contentHash: portfolio.contentHash },
      { role: "market", collection: "market", id: market.id, contentHash: market.contentHash },
      { role: "scenario-slate", collection: "scenario-slates", id: slate.id, contentHash: slate.contentHash },
      ...sets.map((s) => ({
        role: "assumption-set",
        collection: "assumption-sets" as Collection,
        id: s.id,
        contentHash: s.contentHash,
      })),
    ],
  };
}

/** A run's stored request bytes, verbatim, verified against the row's pin. */
export function readRunRequestBytes(db: PlatformDb, runId: string): Uint8Array {
  const row = db.db
    .prepare("SELECT platform_request_hash, request_body FROM runs WHERE run_id = ?")
    .get(runId) as { platform_request_hash: string; request_body: Uint8Array } | undefined;
  if (row === undefined) throw new DbNotFoundError("runs", runId);
  const actual = sha256Hex(row.request_body);
  if (actual !== row.platform_request_hash) {
    throw new DbIntegrityError("runs", runId, row.platform_request_hash, actual);
  }
  return row.request_body;
}
