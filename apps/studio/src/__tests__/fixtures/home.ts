/** Hand-typed minimal route bodies for the Home reconciliation test. Only the fields the loader reads, with recognisable values. */
import type { CatalogAggregateResponse, CatalogGroupedAggregateResponse, CatalogLineage, CatalogRunInputs, RunLensesResponse } from "@alm/reader";
import type { EVEResult, NIIResult } from "@alm/engine";

export const LINEAGE = { collection: "portfolios", id: "book-a", contentHash: "h", consumedBy: [
  { runId: "run-old", role: "portfolio", state: "done", submittedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-01T00:10:00Z", pinnedContentHash: "h" },
  { runId: "run-new", role: "portfolio", state: "done", submittedAt: "2026-09-02T00:00:00Z", endedAt: "2026-09-02T00:10:00Z", pinnedContentHash: "h" },
  { runId: "run-err", role: "portfolio", state: "error", submittedAt: "2026-09-03T00:00:00Z", endedAt: "2026-09-03T00:01:00Z", pinnedContentHash: "h" } ] } as unknown as CatalogLineage;
export const EVE = { discountBasis: "all-in", byScenario: [
  { scenarioId: "S0", eve: 623336149, deltaEveVsBase: 0, deltaEvePct: 0, pvAssets: 1, pvLiabilities: 1, byFamily: [] },
  { scenarioId: "S200", eve: 438388281, deltaEveVsBase: -184947868, deltaEvePct: -0.2967, pvAssets: 1, pvLiabilities: 1, byFamily: [] } ] } as unknown as EVEResult;
export const NII = { horizonsMonths: [12, 24], byScenario: [
  { scenarioId: "S0", totalNet12: 13942069, totalNet24: 27000000, byFamily: [] },
  { scenarioId: "S200", totalNet12: 11000000, totalNet24: 22000000, byFamily: [] } ] } as unknown as NIIResult;
export const LENSES = { baseScenarioId: "S0", lenses: [
  { lensId: "rate-demo-v1", objective: "rate", baseScenarioId: "S0", byScenario: [], status: "breach", headline: -0.12 },
  { lensId: "capital-demo-v1", objective: "capital", baseScenarioId: "S0", byScenario: [], status: "unobservable" } ] } as unknown as RunLensesResponse;
export const AGG = { portfolioId: "book-a", filters: {}, groupBy: null, basis: "SUM(notional) over mirrored positions", aggregate: { positionCount: 2351, totalNotional: 5358726767, weightedAvgRate: null, ratedNotional: null, weightedAvgMaturityMonths: null, weightedAvgRemainingMaturityMonths: null } } as unknown as CatalogAggregateResponse;
export const INPUTS = { runId: "run-new", state: "done", seed: null, grid: null, engineContext: null, platformRequestHash: "req-hash-1", engineInputsHash: "in-hash-1", resultContentHash: "r", resultBytes: 1, submittedAt: null, endedAt: "2026-09-02T00:10:00Z", inputs: [] } as unknown as CatalogRunInputs;
export const AGG_SIDE = { portfolioId: "book-a", filters: {}, groupBy: "side", basis: "SUM(notional) over mirrored positions, grouped by side", groups: [
  { key: "asset", positionCount: 2000, totalNotional: 5358726767, weightedAvgRate: null, ratedNotional: null, weightedAvgMaturityMonths: null, weightedAvgRemainingMaturityMonths: null },
  { key: "liability", positionCount: 351, totalNotional: 4822854097, weightedAvgRate: null, ratedNotional: null, weightedAvgMaturityMonths: null, weightedAvgRemainingMaturityMonths: null } ] } as unknown as CatalogGroupedAggregateResponse;
