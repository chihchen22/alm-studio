/**
 * Catalog routes: the read surface over the platform database.
 * The author asked for a database holding instrument-level positions, curves,
 * rates, and every simulation input; D1 built the mirror, these routes let a
 * practitioner SEE and QUERY it. GET-only by construction, served from a
 * connection opened with `PRAGMA query_only = ON` on top of D1's
 * RAISE(ABORT) immutability triggers: this surface structurally cannot write.
 *
 * Endpoint table (frozen for W3-P7's UI step):
 *
 *   GET /api/catalog/portfolios
 *       -> [{ id, contentHash, ingestedAt, positionCount }]
 *   GET /api/catalog/portfolios/:id/positions
 *       ?familyId=&coaNodeId=&instrumentType=&limit=&offset=
 *       -> { portfolioId, filters, page: { limit, offset, total, returned }, positions: [...] }
 *       Pagination is mandatory: default limit 500, max 5,000.
 *   GET /api/catalog/portfolios/:id/positions/aggregate
 *       ?familyId=&coaNodeId=&instrumentType=&groupBy=family|instrumentType|coaNode|side
 *       -> without groupBy: { ..., aggregate: {...} }; with: { ..., groups: [{ key, ...}] }
 *       Aggregates (count, total notional, notional-weighted avg rate over the
 *       rate-bearing basis, notional-weighted avg contractual and remaining
 *       maturity) are computed IN SQL and served verbatim.
 *   GET /api/catalog/markets
 *       -> [{ id, contentHash, ingestedAt, asOf, curvePoints, capVolPoints, swaptionVolPoints,
 *            derivedFromMarketId? }]   (the last only on a derived market, read from its store meta)
 *   GET /api/catalog/markets/:id
 *       -> { id, contentHash, asOf, curves: { "risk-free": [...], "term-funding": [...], tlp: [...] },
 *            capVolSurface: [...], swaptionVolSurface: [...] }
 *   GET /api/catalog/curves/:curve/series        (curve = risk-free | term-funding | tlp)
 *       -> [{ marketId, asOf, points: [{ term, tYears, value }] }]  (time series by as-of)
 *   GET /api/catalog/runs
 *       -> [{ runId, state, label, submittedAt, endedAt, elapsedMs,
 *             platformRequestHash, engineInputsHash, resultContentHash }]
 *   GET /api/catalog/runs/:id/inputs
 *       -> the complete resolved input set the run consumed, with content-hash
 *          pins: { runId, state, seed, grid, engineContext, platformRequestHash,
 *          engineInputsHash, resultContentHash, resultBytes, inputs: [{ role,
 *          ord, collection, id, contentHash }] }
 *   GET /api/catalog/lineage/:collection/:id
 *       (collection = portfolios | market | scenario-slates | assumption-sets)
 *       -> { collection, id, contentHash, consumedBy: [{ runId, role, state,
 *            submittedAt, endedAt, pinnedContentHash }] }
 *
 * Error mapping: anything not mirrored is a typed 404 NAMING what is missing
 * (never an empty success); malformed inputs (unknown query params included —
 * a misspelled filter must not silently return the whole book) are typed 422.
 * Freshness caveat, stated here and in each 404: the mirror advances at
 * boot/seed/migrate; a document written through the API routes
 * (books, markets, assumption sets, scenario slates) syncs itself at once
 * (`mirrorBestEffort`) and a run syncs when it reaches a terminal state
 * (`syncRunToDb`, from the run queue), both best effort, so a 404 here after
 * a successful write means the sync failed and the next boot sync will land it.
 */
import type { PlatformContext } from "../../context";
import { defaultDbPath } from "../../db/database";
import {
  Catalog,
  CatalogNotFoundError,
  CatalogUnavailableError,
  CatalogValidationError,
  POSITIONS_PAGE_DEFAULT_LIMIT,
  POSITIONS_PAGE_MAX_LIMIT,
  type AggregateGroupBy,
  type PositionFilters,
} from "../../db/queries";
import { notFound, unprocessable } from "../errors";
import type { Router, RouteRequest } from "../router";

/** The slice of the platform context this read-only surface needs. */
export type CatalogContext = Pick<PlatformContext, "config">;

/** Map catalog-layer refusals onto the platform's typed HTTP errors. */
function catalogCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CatalogNotFoundError) throw notFound(err.message);
    if (err instanceof CatalogUnavailableError) throw notFound(err.message);
    if (err instanceof CatalogValidationError) throw unprocessable(err.message);
    throw err;
  }
}

/** Refuse unknown query parameters: a misspelled filter must never be ignored. */
function rejectUnknownParams(req: RouteRequest, allowed: readonly string[]): void {
  const unknown = [...new Set([...req.query.keys()])].filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw unprocessable(
      `unknown query parameter(s) ${unknown.map((k) => `"${k}"`).join(", ")}; ` +
        `allowed: ${allowed.join(", ")} — an unrecognized filter is refused, not silently ignored`,
    );
  }
}

function intParam(req: RouteRequest, name: string, fallback: number): number {
  const raw = req.query.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw unprocessable(`query parameter "${name}" must be an integer, got "${raw}"`);
  }
  return n;
}

function positionFilters(req: RouteRequest): PositionFilters {
  const f: PositionFilters = {};
  const familyId = req.query.get("familyId");
  const coaNodeId = req.query.get("coaNodeId");
  const instrumentType = req.query.get("instrumentType");
  if (familyId !== null) f.familyId = familyId;
  if (coaNodeId !== null) f.coaNodeId = coaNodeId;
  if (instrumentType !== null) f.instrumentType = instrumentType;
  return f;
}

const GROUP_BY_VALUES: readonly AggregateGroupBy[] = ["family", "instrumentType", "coaNode", "side"];

export function registerCatalogRoutes(router: Router, ctx: CatalogContext): void {
  // One read-only connection per server process, opened on first use so a
  // store seeded during boot is visible; WAL lets this reader see every
  // committed sync without reopening.
  let catalog: Catalog | undefined;
  const cat = (): Catalog => {
    if (catalog === undefined) {
      catalog = catalogCall(() => Catalog.open(defaultDbPath(ctx.config.storeRoot)));
    }
    return catalog;
  };

  router.add("GET", "/api/catalog/portfolios", (req) => {
    rejectUnknownParams(req, []);
    return { kind: "json", value: catalogCall(() => cat().listPortfolios()) };
  });

  router.add("GET", "/api/catalog/portfolios/:id/positions", (req) => {
    rejectUnknownParams(req, ["familyId", "coaNodeId", "instrumentType", "limit", "offset"]);
    const filters = positionFilters(req);
    const limit = intParam(req, "limit", POSITIONS_PAGE_DEFAULT_LIMIT);
    const offset = intParam(req, "offset", 0);
    if (limit > POSITIONS_PAGE_MAX_LIMIT || limit < 1) {
      throw unprocessable(
        `limit must be in [1, ${POSITIONS_PAGE_MAX_LIMIT}] (default ${POSITIONS_PAGE_DEFAULT_LIMIT}); ` +
          `got ${limit} — pagination is mandatory, an unbounded position dump is a defect`,
      );
    }
    const page = catalogCall(() => cat().positionsPage(req.params.id, filters, limit, offset));
    return {
      kind: "json",
      value: { portfolioId: req.params.id, filters, ...page },
    };
  });

  router.add("GET", "/api/catalog/portfolios/:id/positions/aggregate", (req) => {
    rejectUnknownParams(req, ["familyId", "coaNodeId", "instrumentType", "groupBy"]);
    const filters = positionFilters(req);
    const groupByRaw = req.query.get("groupBy");
    const basis =
      "computed in SQL over the mirrored positions table and served verbatim; " +
      "weightedAvgRate is notional-weighted over rate-bearing rows only (basis: ratedNotional; " +
      "nmd-b and cd scalar rates are honestly NULL), null when there is no basis";
    if (groupByRaw === null) {
      const aggregate = catalogCall(() => cat().positionsAggregate(req.params.id, filters));
      return {
        kind: "json",
        value: { portfolioId: req.params.id, filters, groupBy: null, basis, aggregate },
      };
    }
    if (!(GROUP_BY_VALUES as readonly string[]).includes(groupByRaw)) {
      throw unprocessable(
        `unknown groupBy "${groupByRaw}"; allowed: ${GROUP_BY_VALUES.join(", ")}`,
      );
    }
    const groups = catalogCall(() =>
      cat().positionsAggregateGrouped(req.params.id, filters, groupByRaw as AggregateGroupBy),
    );
    return {
      kind: "json",
      value: { portfolioId: req.params.id, filters, groupBy: groupByRaw, basis, groups },
    };
  });

  router.add("GET", "/api/catalog/markets", (req) => {
    rejectUnknownParams(req, []);
    return { kind: "json", value: catalogCall(() => cat().listMarkets()) };
  });

  router.add("GET", "/api/catalog/markets/:id", (req) => {
    rejectUnknownParams(req, []);
    return { kind: "json", value: catalogCall(() => cat().marketSnapshot(req.params.id)) };
  });

  router.add("GET", "/api/catalog/curves/:curve/series", (req) => {
    rejectUnknownParams(req, []);
    return {
      kind: "json",
      value: {
        curve: req.params.curve,
        series: catalogCall(() => cat().curveSeries(req.params.curve)),
      },
    };
  });

  router.add("GET", "/api/catalog/runs", (req) => {
    rejectUnknownParams(req, []);
    return { kind: "json", value: catalogCall(() => cat().listRuns()) };
  });

  router.add("GET", "/api/catalog/runs/:id/inputs", (req) => {
    rejectUnknownParams(req, []);
    return { kind: "json", value: catalogCall(() => cat().runInputs(req.params.id)) };
  });

  router.add("GET", "/api/catalog/lineage/:collection/:id", (req) => {
    rejectUnknownParams(req, []);
    return {
      kind: "json",
      value: catalogCall(() => cat().lineage(req.params.collection, req.params.id)),
    };
  });
}
