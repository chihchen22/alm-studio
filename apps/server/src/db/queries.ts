/**
 * Read-only catalog query surface over the platform database.
 *
 * W3-D1 built the mirror (documents + exploded positions / curve points / vol
 * points / bindings / scenarios / runs / run_inputs); this module is the READ
 * surface a practitioner queries. Three guarantees, enforced mechanically:
 *
 *  1. **READ-ONLY, at the connection.** The catalog opens its OWN connection
 *     with `PRAGMA query_only = ON`, so this connection cannot INSERT, UPDATE,
 *     or DELETE anything even by bug — and underneath that, D1's schema
 *     triggers RAISE(ABORT) on any mutation of content rows. An API that could
 *     move a curve under a completed run would destroy the immutability
 *     guarantee; this one structurally cannot.
 *  2. **Aggregates are computed IN SQL and returned verbatim.** Count, total
 *     notional, and the notional-weighted average rate / maturity are single
 *     SQL expressions; no JS layer re-sums or re-derives them. Where a
 *     weighted average has no basis (zero or no rate-bearing notional) SQLite
 *     yields NULL and NULL is what the caller gets — never a fabricated 0.
 *  3. **Absence is typed, never an empty success.** A portfolio, market, run,
 *     or filter value the database has not mirrored raises
 *     `CatalogNotFoundError` naming exactly what is missing (a document
 *     written through the API, and a run at its end, sync at once; a 404 means
 *     that sync failed or the document was stored by other means, and the next
 *     boot sync lands it). Malformed inputs raise
 *     `CatalogValidationError`. The HTTP layer maps these 404 / 422.
 *
 * The rate column semantics come from D1's ingest (`rateOf`): nmd-b and cd
 * positions carry an honestly-NULL scalar rate (`beta-s-curve` /
 * `cohort-book`), so weighted-average rates are reported over the
 * rate-bearing notional with that basis returned beside the average.
 */
import { existsSync } from "node:fs";
import { DatabaseSync, type DatabaseSyncInstance } from "./sqlite";
import { DB_SCHEMA_VERSION } from "./schema";
import { SchemaVersionError } from "./database";

/** The platform database file does not exist (or is not a platform database). */
export class CatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

/** A named thing (portfolio, market, run, filter value) is not mirrored. */
export class CatalogNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogNotFoundError";
  }
}

/** A malformed query input (bad curve name, bad groupBy, bad pagination). */
export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

/** Mandatory pagination bounds (a 100k-row unbounded response is a defect). */
export const POSITIONS_PAGE_DEFAULT_LIMIT = 500;
export const POSITIONS_PAGE_MAX_LIMIT = 5_000;

export interface PositionFilters {
  familyId?: string;
  coaNodeId?: string;
  instrumentType?: string;
}

export interface PositionRow {
  positionId: string;
  familyId: string;
  coaNodeId: string;
  side: string | null;
  instrumentType: string;
  notional: number;
  /** NULL when the rate is model-implied (see rateKind: beta-s-curve, cohort-book). */
  rate: number | null;
  rateKind: string;
  maturityMonths: number;
  originationOffsetMonths: number;
  amortType: string;
  behavioral: string | null;
}

export interface PositionsPage {
  page: { limit: number; offset: number; total: number; returned: number };
  positions: PositionRow[];
}

/** One SQL aggregate row, served verbatim (never recomputed downstream). */
export interface PositionsAggregate {
  positionCount: number;
  totalNotional: number | null;
  /**
   * Notional-weighted average of the scalar rate column, over rate-bearing
   * rows only; NULL when no notional carries a scalar rate. The basis is
   * `ratedNotional` — nmd-b (beta-s-curve) and cd (cohort-book) positions are
   * honestly excluded rather than averaged in as zero.
   */
  weightedAvgRate: number | null;
  /** SUM(notional) over rows whose scalar rate is populated. */
  ratedNotional: number | null;
  /** Notional-weighted contractual term (maturity_months). */
  weightedAvgMaturityMonths: number | null;
  /** Notional-weighted remaining term: maturity_months + origination_offset_months. */
  weightedAvgRemainingMaturityMonths: number | null;
}

export type AggregateGroupBy = "family" | "instrumentType" | "coaNode" | "side";

/** Whitelisted grouping columns; user input never reaches SQL as text. */
const GROUP_COLUMNS: Record<AggregateGroupBy, string> = {
  family: "family_id",
  instrumentType: "instrument_type",
  coaNode: "coa_node_id",
  side: "side",
};

export const CURVE_NAMES = ["risk-free", "term-funding", "tlp"] as const;
export type CurveName = (typeof CURVE_NAMES)[number];

/** Collections a run can consume (coa is stored but never a run input). */
export const LINEAGE_COLLECTIONS = [
  "portfolios",
  "market",
  "scenario-slates",
  "assumption-sets",
] as const;
export type LineageCollection = (typeof LINEAGE_COLLECTIONS)[number];

const AGGREGATE_EXPRESSIONS = `
  COUNT(*)                                            AS position_count,
  SUM(notional)                                       AS total_notional,
  SUM(rate * notional) FILTER (WHERE rate IS NOT NULL)
    / SUM(notional)    FILTER (WHERE rate IS NOT NULL) AS weighted_avg_rate,
  SUM(notional)        FILTER (WHERE rate IS NOT NULL) AS rated_notional,
  SUM(maturity_months * notional) / SUM(notional)      AS weighted_avg_maturity_months,
  SUM((maturity_months + origination_offset_months) * notional) / SUM(notional)
                                                       AS weighted_avg_remaining_maturity_months`;

interface RawAggregate {
  grp?: string | null;
  position_count: number;
  total_notional: number | null;
  weighted_avg_rate: number | null;
  rated_notional: number | null;
  weighted_avg_maturity_months: number | null;
  weighted_avg_remaining_maturity_months: number | null;
}

function toAggregate(r: RawAggregate): PositionsAggregate {
  return {
    positionCount: r.position_count,
    totalNotional: r.total_notional,
    weightedAvgRate: r.weighted_avg_rate,
    ratedNotional: r.rated_notional,
    weightedAvgMaturityMonths: r.weighted_avg_maturity_months,
    weightedAvgRemainingMaturityMonths: r.weighted_avg_remaining_maturity_months,
  };
}

function filterClause(f: PositionFilters): { sql: string; params: string[] } {
  let sql = "";
  const params: string[] = [];
  if (f.familyId !== undefined) {
    sql += " AND family_id = ?";
    params.push(f.familyId);
  }
  if (f.coaNodeId !== undefined) {
    sql += " AND coa_node_id = ?";
    params.push(f.coaNodeId);
  }
  if (f.instrumentType !== undefined) {
    sql += " AND instrument_type = ?";
    params.push(f.instrumentType);
  }
  return { sql, params };
}

/**
 * Read-only catalog over one platform database file. Open with
 * `Catalog.open(defaultDbPath(storeRoot))`; refuses a missing file, a
 * non-platform file, or a schema-version mismatch — never reinterprets rows.
 */
export class Catalog {
  readonly path: string;
  readonly db: DatabaseSyncInstance;

  private constructor(path: string, db: DatabaseSyncInstance) {
    this.path = path;
    this.db = db;
  }

  static open(dbPath: string): Catalog {
    if (!existsSync(dbPath)) {
      throw new CatalogUnavailableError(
        `platform database not found at ${dbPath}; the mirror is created when the store is ` +
          `seeded (boot does this) or by apps/server/scripts/migrate-store.ts — nothing has been mirrored yet`,
      );
    }
    const db = new DatabaseSync(dbPath);
    try {
      // Connection-level read-only: this connection cannot write, ever.
      db.exec("PRAGMA query_only = ON;");
      let row: { value: string } | undefined;
      try {
        row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
          | { value: string }
          | undefined;
      } catch (err) {
        throw new CatalogUnavailableError(
          `file at ${dbPath} is not a platform database (no readable meta table: ` +
            `${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (row === undefined) {
        throw new CatalogUnavailableError(
          `file at ${dbPath} carries no schema_version; refusing to read an unpinned database`,
        );
      }
      if (row.value !== DB_SCHEMA_VERSION) {
        throw new SchemaVersionError(dbPath, row.value, DB_SCHEMA_VERSION);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new Catalog(dbPath, db);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------- portfolios

  listPortfolios(): Array<{
    id: string;
    contentHash: string;
    ingestedAt: string;
    positionCount: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.content_hash, d.ingested_at,
                (SELECT COUNT(*) FROM positions p WHERE p.portfolio_id = d.id) AS n
         FROM documents d WHERE d.collection = 'portfolios' ORDER BY d.id`,
      )
      .all() as Array<{ id: string; content_hash: string; ingested_at: string; n: number }>;
    return rows.map((r) => ({
      id: r.id,
      contentHash: r.content_hash,
      ingestedAt: r.ingested_at,
      positionCount: r.n,
    }));
  }

  private requireDocument(collection: string, id: string, noun: string): { contentHash: string } {
    const row = this.db
      .prepare("SELECT content_hash FROM documents WHERE collection = ? AND id = ?")
      .get(collection, id) as { content_hash: string } | undefined;
    if (row === undefined) {
      throw new CatalogNotFoundError(
        `${noun} "${id}" is not mirrored in the platform database (collection ${collection}); ` +
          `a document written through the API, and a run at its end, sync at once; a 404 here means that sync failed (the server logged one line) or the document was stored by other means; the next boot sync lands it`,
      );
    }
    return { contentHash: row.content_hash };
  }

  /**
   * Each provided filter value must exist somewhere in the portfolio; a value
   * the book has never carried 404s by name instead of returning an empty
   * page that would silently absorb a typo. A combination of individually
   * valid values that intersects to nothing is an honest empty page.
   */
  private requireFilterValues(portfolioId: string, f: PositionFilters): void {
    const checks: Array<[label: string, column: string, value: string | undefined]> = [
      ["familyId", "family_id", f.familyId],
      ["coaNodeId", "coa_node_id", f.coaNodeId],
      ["instrumentType", "instrument_type", f.instrumentType],
    ];
    for (const [label, column, value] of checks) {
      if (value === undefined) continue;
      const hit = this.db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM positions WHERE portfolio_id = ? AND ${column} = ?) AS e`,
        )
        .get(portfolioId, value) as { e: number };
      if (hit.e !== 1) {
        throw new CatalogNotFoundError(
          `portfolio "${portfolioId}" has no mirrored positions with ${label} "${value}"; ` +
            `nothing was filtered silently`,
        );
      }
    }
  }

  positionsPage(
    portfolioId: string,
    filters: PositionFilters,
    limit: number,
    offset: number,
  ): PositionsPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > POSITIONS_PAGE_MAX_LIMIT) {
      throw new CatalogValidationError(
        `limit must be an integer in [1, ${POSITIONS_PAGE_MAX_LIMIT}], got ${limit}; ` +
          `pagination is mandatory — an unbounded position dump is a defect`,
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new CatalogValidationError(`offset must be a non-negative integer, got ${offset}`);
    }
    this.requireDocument("portfolios", portfolioId, "portfolio");
    this.requireFilterValues(portfolioId, filters);
    const { sql, params } = filterClause(filters);
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM positions WHERE portfolio_id = ?${sql}`)
        .get(portfolioId, ...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT position_id, family_id, coa_node_id, side, instrument_type, notional, rate,
                rate_kind, maturity_months, origination_offset_months, amort_type, behavioral
         FROM positions WHERE portfolio_id = ?${sql}
         ORDER BY position_id LIMIT ? OFFSET ?`,
      )
      .all(portfolioId, ...params, limit, offset) as Array<{
      position_id: string;
      family_id: string;
      coa_node_id: string;
      side: string | null;
      instrument_type: string;
      notional: number;
      rate: number | null;
      rate_kind: string;
      maturity_months: number;
      origination_offset_months: number;
      amort_type: string;
      behavioral: string | null;
    }>;
    return {
      page: { limit, offset, total, returned: rows.length },
      positions: rows.map((r) => ({
        positionId: r.position_id,
        familyId: r.family_id,
        coaNodeId: r.coa_node_id,
        side: r.side,
        instrumentType: r.instrument_type,
        notional: r.notional,
        rate: r.rate,
        rateKind: r.rate_kind,
        maturityMonths: r.maturity_months,
        originationOffsetMonths: r.origination_offset_months,
        amortType: r.amort_type,
        behavioral: r.behavioral,
      })),
    };
  }

  /** Ungrouped aggregate over the filtered position set, computed in SQL. */
  positionsAggregate(portfolioId: string, filters: PositionFilters): PositionsAggregate {
    this.requireDocument("portfolios", portfolioId, "portfolio");
    this.requireFilterValues(portfolioId, filters);
    const { sql, params } = filterClause(filters);
    const row = this.db
      .prepare(`SELECT ${AGGREGATE_EXPRESSIONS} FROM positions WHERE portfolio_id = ?${sql}`)
      .get(portfolioId, ...params) as unknown as RawAggregate;
    return toAggregate(row);
  }

  /** Grouped aggregates, one SQL row per group key, computed in SQL. */
  positionsAggregateGrouped(
    portfolioId: string,
    filters: PositionFilters,
    groupBy: AggregateGroupBy,
  ): Array<{ key: string | null } & PositionsAggregate> {
    const column = GROUP_COLUMNS[groupBy];
    if (column === undefined) {
      throw new CatalogValidationError(
        `unknown groupBy "${String(groupBy)}"; allowed: ${Object.keys(GROUP_COLUMNS).join(", ")}`,
      );
    }
    this.requireDocument("portfolios", portfolioId, "portfolio");
    this.requireFilterValues(portfolioId, filters);
    const { sql, params } = filterClause(filters);
    const rows = this.db
      .prepare(
        `SELECT ${column} AS grp, ${AGGREGATE_EXPRESSIONS}
         FROM positions WHERE portfolio_id = ?${sql} GROUP BY ${column} ORDER BY ${column}`,
      )
      .all(portfolioId, ...params) as unknown as RawAggregate[];
    return rows.map((r) => ({ key: r.grp ?? null, ...toAggregate(r) }));
  }

  // ------------------------------------------------------------------ market

  listMarkets(): Array<{
    id: string;
    contentHash: string;
    ingestedAt: string;
    asOf: string | null;
    curvePoints: number;
    capVolPoints: number;
    swaptionVolPoints: number;
    derivedFromMarketId?: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.content_hash, d.ingested_at, d.meta_json,
                (SELECT as_of FROM curve_points c WHERE c.market_id = d.id LIMIT 1) AS as_of,
                (SELECT COUNT(*) FROM curve_points c WHERE c.market_id = d.id) AS n_curve,
                (SELECT COUNT(*) FROM cap_vol_points c WHERE c.market_id = d.id) AS n_cap,
                (SELECT COUNT(*) FROM swaption_vol_points c WHERE c.market_id = d.id) AS n_swp
         FROM documents d WHERE d.collection = 'market' ORDER BY as_of, d.id`,
      )
      .all() as Array<{
      id: string;
      content_hash: string;
      ingested_at: string;
      meta_json: string;
      as_of: string | null;
      n_curve: number;
      n_cap: number;
      n_swp: number;
    }>;
    return rows.map((r) => {
      // A derived market's store meta names its base; a plain market carries no key.
      const from = (JSON.parse(r.meta_json) as { derivedFromMarketId?: unknown }).derivedFromMarketId;
      return {
        id: r.id,
        contentHash: r.content_hash,
        ingestedAt: r.ingested_at,
        asOf: r.as_of,
        curvePoints: r.n_curve,
        capVolPoints: r.n_cap,
        swaptionVolPoints: r.n_swp,
        ...(typeof from === "string" ? { derivedFromMarketId: from } : {}),
      };
    });
  }

  /** One snapshot's quotes by tenor: three curves, cap and swaption surfaces. */
  marketSnapshot(marketId: string): {
    id: string;
    contentHash: string;
    asOf: string | null;
    curves: Record<
      CurveName,
      Array<{ term: string | null; tYears: number; instrumentType: string | null; value: number }>
    >;
    capVolSurface: Array<{
      expiryYears: number;
      strike: number | null;
      isAtm: boolean;
      normalVol: number;
    }>;
    swaptionVolSurface: Array<{ expiryYears: number; tenorYears: number; normalVol: number }>;
  } {
    const doc = this.requireDocument("market", marketId, "market snapshot");
    const curveRows = this.db
      .prepare(
        `SELECT curve, as_of, term, t_years, instrument_type, value
         FROM curve_points WHERE market_id = ? ORDER BY curve, seq`,
      )
      .all(marketId) as Array<{
      curve: CurveName;
      as_of: string;
      term: string | null;
      t_years: number;
      instrument_type: string | null;
      value: number;
    }>;
    const curves: Record<
      CurveName,
      Array<{ term: string | null; tYears: number; instrumentType: string | null; value: number }>
    > = { "risk-free": [], "term-funding": [], tlp: [] };
    let asOf: string | null = null;
    for (const r of curveRows) {
      asOf = r.as_of;
      curves[r.curve].push({
        term: r.term,
        tYears: r.t_years,
        instrumentType: r.instrument_type,
        value: r.value,
      });
    }
    const capRows = this.db
      .prepare(
        `SELECT expiry_years, strike, is_atm, normal_vol
         FROM cap_vol_points WHERE market_id = ? ORDER BY seq`,
      )
      .all(marketId) as Array<{
      expiry_years: number;
      strike: number | null;
      is_atm: number;
      normal_vol: number;
    }>;
    const swpRows = this.db
      .prepare(
        `SELECT expiry_years, tenor_years, normal_vol
         FROM swaption_vol_points WHERE market_id = ? ORDER BY seq`,
      )
      .all(marketId) as Array<{ expiry_years: number; tenor_years: number; normal_vol: number }>;
    return {
      id: marketId,
      contentHash: doc.contentHash,
      asOf,
      curves,
      capVolSurface: capRows.map((r) => ({
        expiryYears: r.expiry_years,
        strike: r.strike,
        isAtm: r.is_atm === 1,
        normalVol: r.normal_vol,
      })),
      swaptionVolSurface: swpRows.map((r) => ({
        expiryYears: r.expiry_years,
        tenorYears: r.tenor_years,
        normalVol: r.normal_vol,
      })),
    };
  }

  /**
   * One curve across every mirrored snapshot, as a time series keyed by the
   * snapshot's as-of date (multiple snapshots line up chronologically).
   */
  curveSeries(curve: string): Array<{
    marketId: string;
    asOf: string;
    points: Array<{ term: string | null; tYears: number; value: number }>;
  }> {
    if (!(CURVE_NAMES as readonly string[]).includes(curve)) {
      throw new CatalogValidationError(
        `unknown curve "${curve}"; allowed: ${CURVE_NAMES.join(", ")}`,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT market_id, as_of, term, t_years, value
         FROM curve_points WHERE curve = ? ORDER BY as_of, market_id, seq`,
      )
      .all(curve) as Array<{
      market_id: string;
      as_of: string;
      term: string | null;
      t_years: number;
      value: number;
    }>;
    if (rows.length === 0) {
      throw new CatalogNotFoundError(
        `no mirrored market snapshot carries curve "${curve}"; ` +
          `a document written through the API, and a run at its end, sync at once; a 404 here means that sync failed (the server logged one line) or the document was stored by other means; the next boot sync lands it`,
      );
    }
    const out: Array<{
      marketId: string;
      asOf: string;
      points: Array<{ term: string | null; tYears: number; value: number }>;
    }> = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last === undefined || last.marketId !== r.market_id) {
        out.push({ marketId: r.market_id, asOf: r.as_of, points: [] });
      }
      out[out.length - 1].points.push({ term: r.term, tYears: r.t_years, value: r.value });
    }
    return out;
  }

  // -------------------------------------------------------------------- runs

  listRuns(): Array<{
    runId: string;
    state: string;
    label: string | null;
    submittedAt: string | null;
    endedAt: string | null;
    elapsedMs: number | null;
    platformRequestHash: string;
    engineInputsHash: string | null;
    resultContentHash: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT run_id, state, label, submitted_at, ended_at, elapsed_ms,
                platform_request_hash, engine_inputs_hash, result_content_hash
         FROM runs ORDER BY COALESCE(submitted_at, ingested_at), run_id`,
      )
      .all() as Array<{
      run_id: string;
      state: string;
      label: string | null;
      submitted_at: string | null;
      ended_at: string | null;
      elapsed_ms: number | null;
      platform_request_hash: string;
      engine_inputs_hash: string | null;
      result_content_hash: string | null;
    }>;
    return rows.map((r) => ({
      runId: r.run_id,
      state: r.state,
      label: r.label,
      submittedAt: r.submitted_at,
      endedAt: r.ended_at,
      elapsedMs: r.elapsed_ms,
      platformRequestHash: r.platform_request_hash,
      engineInputsHash: r.engine_inputs_hash,
      resultContentHash: r.result_content_hash,
    }));
  }

  /**
   * The complete resolved input set of a run, with content-hash pins: what
   * exactly this simulation consumed. Everything comes verbatim from the runs
   * row and its run_inputs pins (D1's ingest verified them against the store);
   * nothing here is recomputed.
   */
  runInputs(runId: string): {
    runId: string;
    state: string;
    seed: string | null;
    grid: unknown;
    engineContext: unknown;
    platformRequestHash: string;
    engineInputsHash: string | null;
    resultContentHash: string | null;
    resultBytes: number | null;
    submittedAt: string | null;
    endedAt: string | null;
    inputs: Array<{ role: string; ord: number; collection: string; id: string; contentHash: string }>;
  } {
    const row = this.db
      .prepare(
        `SELECT state, seed, grid_json, engine_context_json, platform_request_hash,
                engine_inputs_hash, result_content_hash, result_bytes, submitted_at, ended_at
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          state: string;
          seed: string | null;
          grid_json: string | null;
          engine_context_json: string | null;
          platform_request_hash: string;
          engine_inputs_hash: string | null;
          result_content_hash: string | null;
          result_bytes: number | null;
          submitted_at: string | null;
          ended_at: string | null;
        }
      | undefined;
    if (row === undefined) {
      throw new CatalogNotFoundError(
        `run "${runId}" is not mirrored in the platform database; ` +
          `a document written through the API, and a run at its end, sync at once; a 404 here means that sync failed (the server logged one line) or the document was stored by other means; the next boot sync lands it`,
      );
    }
    const pins = this.db
      .prepare(
        `SELECT role, ord, collection, doc_id, content_hash
         FROM run_inputs WHERE run_id = ? ORDER BY role, ord`,
      )
      .all(runId) as Array<{
      role: string;
      ord: number;
      collection: string;
      doc_id: string;
      content_hash: string;
    }>;
    return {
      runId,
      state: row.state,
      seed: row.seed,
      grid: row.grid_json === null ? null : JSON.parse(row.grid_json),
      engineContext: row.engine_context_json === null ? null : JSON.parse(row.engine_context_json),
      platformRequestHash: row.platform_request_hash,
      engineInputsHash: row.engine_inputs_hash,
      resultContentHash: row.result_content_hash,
      resultBytes: row.result_bytes,
      submittedAt: row.submitted_at,
      endedAt: row.ended_at,
      inputs: pins.map((p) => ({
        role: p.role,
        ord: p.ord,
        collection: p.collection,
        id: p.doc_id,
        contentHash: p.content_hash,
      })),
    };
  }

  /**
   * Lineage: which runs consumed a given document. The document must be
   * mirrored (typed 404 otherwise); a mirrored document no run has consumed
   * yet returns an honest empty `consumedBy`.
   */
  lineage(
    collection: string,
    docId: string,
  ): {
    collection: string;
    id: string;
    contentHash: string;
    consumedBy: Array<{
      runId: string;
      role: string;
      state: string;
      submittedAt: string | null;
      endedAt: string | null;
      pinnedContentHash: string;
    }>;
  } {
    if (!(LINEAGE_COLLECTIONS as readonly string[]).includes(collection)) {
      throw new CatalogValidationError(
        `lineage is defined over run-consumable collections (${LINEAGE_COLLECTIONS.join(", ")}); got "${collection}"`,
      );
    }
    const doc = this.requireDocument(collection, docId, `${collection} document`);
    const rows = this.db
      .prepare(
        `SELECT ri.run_id, ri.role, ri.content_hash, r.state, r.submitted_at, r.ended_at
         FROM run_inputs ri JOIN runs r ON r.run_id = ri.run_id
         WHERE ri.collection = ? AND ri.doc_id = ?
         ORDER BY COALESCE(r.submitted_at, r.ingested_at), ri.run_id`,
      )
      .all(collection, docId) as Array<{
      run_id: string;
      role: string;
      content_hash: string;
      state: string;
      submitted_at: string | null;
      ended_at: string | null;
    }>;
    return {
      collection,
      id: docId,
      contentHash: doc.contentHash,
      consumedBy: rows.map((r) => ({
        runId: r.run_id,
        role: r.role,
        state: r.state,
        submittedAt: r.submitted_at,
        endedAt: r.ended_at,
        pinnedContentHash: r.content_hash,
      })),
    };
  }
}
