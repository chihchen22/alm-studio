/**
 * Typed fetch client over the catalog read API (closing the W4-U1
 * "catalog has no UI" gap). One function per endpoint of
 * apps/server/src/http/routes/catalog.ts's frozen table, shapes
 * confirmed against the running server, nothing invented.
 *
 * Honesty rules, identical to api/client.ts: every value returned here is a
 * verbatim server read over the W3-D1 SQLite mirror; this client never rounds,
 * sums, or re-derives a number. SQL aggregates arrive computed server-side
 * with their `basis` string and are rendered verbatim, NULLs included — a
 * weighted-average rate with no rate-bearing basis is null here and "n/a" on
 * screen, never 0. Errors are the server's typed body rethrown as ApiError;
 * the mirror-freshness 404 message is shown verbatim, never softened into an
 * empty table.
 *
 * The frozen W1-P3 client (api/client.ts) is deliberately not edited; this
 * file carries its own small transport with the same error contract.
 */
import { ApiError, type ApiErrorBody } from "./client";

const BASE = "/api/catalog";

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body (proxy failure, server down): surface the raw status.
    }
    if (body?.error) {
      throw new ApiError(res.status, body.error.code, body.error.message, body.error.detail);
    }
    throw new ApiError(res.status, "http-error", `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

// --- Shapes (verbatim from apps/server/src/db/queries.ts, camelCase layer) ---

export interface CatalogPortfolio {
  id: string;
  contentHash: string;
  ingestedAt: string;
  positionCount: number;
}

export interface CatalogPositionFilters {
  familyId?: string;
  coaNodeId?: string;
  instrumentType?: string;
}

export interface CatalogPositionRow {
  positionId: string;
  familyId: string;
  coaNodeId: string;
  side: string | null;
  instrumentType: string;
  notional: number;
  /** NULL when the rate is model-implied (rateKind beta-s-curve / cohort-book). */
  rate: number | null;
  rateKind: string;
  maturityMonths: number;
  originationOffsetMonths: number;
  amortType: string;
  behavioral: string | null;
}

export interface CatalogPositionsPage {
  portfolioId: string;
  filters: CatalogPositionFilters;
  page: { limit: number; offset: number; total: number; returned: number };
  positions: CatalogPositionRow[];
}

/** One SQL aggregate row, served verbatim; NULLs are honest absences. */
export interface CatalogAggregate {
  positionCount: number;
  totalNotional: number | null;
  weightedAvgRate: number | null;
  ratedNotional: number | null;
  weightedAvgMaturityMonths: number | null;
  weightedAvgRemainingMaturityMonths: number | null;
}

export type CatalogGroupBy = "family" | "instrumentType" | "coaNode" | "side";

/** The server's grouping keys, mirrored here so no unknown value is ever sent. */
export const CATALOG_GROUP_BY: readonly CatalogGroupBy[] = [
  "family",
  "instrumentType",
  "coaNode",
  "side",
];

export interface CatalogAggregateResponse {
  portfolioId: string;
  filters: CatalogPositionFilters;
  groupBy: null;
  /** The server's own statement of how the aggregates were computed. Render it. */
  basis: string;
  aggregate: CatalogAggregate;
}

export interface CatalogGroupedAggregateResponse {
  portfolioId: string;
  filters: CatalogPositionFilters;
  groupBy: CatalogGroupBy;
  basis: string;
  groups: Array<{ key: string | null } & CatalogAggregate>;
}

export interface CatalogMarketListItem {
  id: string;
  contentHash: string;
  ingestedAt: string;
  asOf: string | null;
  curvePoints: number;
  capVolPoints: number;
  swaptionVolPoints: number;
  /** The base market a derived market was made from; absent on a plain market. */
  derivedFromMarketId?: string;
}

export type CatalogCurveName = "risk-free" | "term-funding" | "tlp";
export const CATALOG_CURVES: readonly CatalogCurveName[] = ["risk-free", "term-funding", "tlp"];

export interface CatalogCurvePoint {
  term: string | null;
  tYears: number;
  instrumentType: string | null;
  value: number;
}

export interface CatalogMarketSnapshot {
  id: string;
  contentHash: string;
  asOf: string | null;
  curves: Record<CatalogCurveName, CatalogCurvePoint[]>;
  capVolSurface: Array<{
    expiryYears: number;
    strike: number | null;
    isAtm: boolean;
    normalVol: number;
  }>;
  swaptionVolSurface: Array<{ expiryYears: number; tenorYears: number; normalVol: number }>;
}

export interface CatalogCurveSeries {
  curve: string;
  series: Array<{
    marketId: string;
    asOf: string;
    points: Array<{ term: string | null; tYears: number; value: number }>;
  }>;
}

export interface CatalogRunListItem {
  runId: string;
  state: string;
  label: string | null;
  submittedAt: string | null;
  endedAt: string | null;
  elapsedMs: number | null;
  platformRequestHash: string;
  engineInputsHash: string | null;
  resultContentHash: string | null;
}

export interface CatalogRunInputs {
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
}

export type CatalogLineageCollection =
  | "portfolios"
  | "market"
  | "scenario-slates"
  | "assumption-sets";

/** The server's run-consumable collections, mirrored so no unknown value is sent. */
export const CATALOG_LINEAGE_COLLECTIONS: readonly CatalogLineageCollection[] = [
  "portfolios",
  "market",
  "scenario-slates",
  "assumption-sets",
];

export interface CatalogLineage {
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
}

// --- Endpoint table, verbatim (catalog.ts header) ---------------------

/** GET /api/catalog/portfolios */
export function listCatalogPortfolios(): Promise<CatalogPortfolio[]> {
  return request<CatalogPortfolio[]>("/portfolios");
}

function filterQs(filters: CatalogPositionFilters): string {
  const qs = new URLSearchParams();
  if (filters.familyId !== undefined) qs.set("familyId", filters.familyId);
  if (filters.coaNodeId !== undefined) qs.set("coaNodeId", filters.coaNodeId);
  if (filters.instrumentType !== undefined) qs.set("instrumentType", filters.instrumentType);
  return qs.toString();
}

/** GET /api/catalog/portfolios/:id/positions (pagination mandatory server-side). */
export function getCatalogPositions(
  portfolioId: string,
  filters: CatalogPositionFilters,
  limit: number,
  offset: number,
): Promise<CatalogPositionsPage> {
  const qs = filterQs(filters);
  return request<CatalogPositionsPage>(
    `/portfolios/${enc(portfolioId)}/positions?${qs === "" ? "" : `${qs}&`}limit=${limit}&offset=${offset}`,
  );
}

/** GET /api/catalog/portfolios/:id/positions/aggregate (ungrouped). */
export function getCatalogAggregate(
  portfolioId: string,
  filters: CatalogPositionFilters,
): Promise<CatalogAggregateResponse> {
  const qs = filterQs(filters);
  return request<CatalogAggregateResponse>(
    `/portfolios/${enc(portfolioId)}/positions/aggregate${qs === "" ? "" : `?${qs}`}`,
  );
}

/** GET /api/catalog/portfolios/:id/positions/aggregate?groupBy= */
export function getCatalogAggregateGrouped(
  portfolioId: string,
  filters: CatalogPositionFilters,
  groupBy: CatalogGroupBy,
): Promise<CatalogGroupedAggregateResponse> {
  const qs = filterQs(filters);
  return request<CatalogGroupedAggregateResponse>(
    `/portfolios/${enc(portfolioId)}/positions/aggregate?${qs === "" ? "" : `${qs}&`}groupBy=${groupBy}`,
  );
}

/** GET /api/catalog/markets */
export function listCatalogMarkets(): Promise<CatalogMarketListItem[]> {
  return request<CatalogMarketListItem[]>("/markets");
}

/** GET /api/catalog/markets/:id */
export function getCatalogMarketSnapshot(id: string): Promise<CatalogMarketSnapshot> {
  return request<CatalogMarketSnapshot>(`/markets/${enc(id)}`);
}

/** GET /api/catalog/curves/:curve/series */
export function getCatalogCurveSeries(curve: CatalogCurveName): Promise<CatalogCurveSeries> {
  return request<CatalogCurveSeries>(`/curves/${enc(curve)}/series`);
}

/** GET /api/catalog/runs */
export function listCatalogRuns(): Promise<CatalogRunListItem[]> {
  return request<CatalogRunListItem[]>("/runs");
}

/** GET /api/catalog/runs/:id/inputs */
export function getCatalogRunInputs(runId: string): Promise<CatalogRunInputs> {
  return request<CatalogRunInputs>(`/runs/${enc(runId)}/inputs`);
}

/** GET /api/catalog/lineage/:collection/:id */
export function getCatalogLineage(
  collection: CatalogLineageCollection,
  id: string,
): Promise<CatalogLineage> {
  return request<CatalogLineage>(`/lineage/${enc(collection)}/${enc(id)}`);
}
