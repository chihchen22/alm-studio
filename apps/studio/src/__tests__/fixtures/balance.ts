/** Hand-typed minimal route bodies for the Balance Sheet reconciliation test. Only the fields the loader reads, with recognisable values. */
import type { CatalogGroupedAggregateResponse, CatalogPositionsPage } from "@alm/reader";
import type { BucketedCashflowResult, PortfolioSpec } from "@alm/engine";

export { LINEAGE, LENSES } from "./home";

const agg = (key: string | null, positionCount: number, totalNotional: number | null, weightedAvgRate: number | null) =>
  ({ key, positionCount, totalNotional, weightedAvgRate, ratedNotional: null, weightedAvgMaturityMonths: null, weightedAvgRemainingMaturityMonths: null });

export const GROUPED = { portfolioId: "book-a", filters: {}, groupBy: "family", basis: "SUM(notional) over mirrored positions, grouped by family", groups: [
  agg("loans", 1200, 3358726767, 0.0612),
  agg("dda", 1100, 2000000000, null),
  agg(null, 51, 17000000, 0.041) ] } as unknown as CatalogGroupedAggregateResponse;

const row = (positionId: string, familyId: string, side: string, rate: number | null) => ({
  positionId, familyId, coaNodeId: `coa-${familyId}`, side, instrumentType: familyId === "dda" ? "nmd" : "fixed-loan",
  notional: 1250000, rate, rateKind: rate === null ? "beta-s-curve" : "fixed", maturityMonths: 60, originationOffsetMonths: 0,
  amortType: "level-pay", behavioral: null });

export const PAGE = { portfolioId: "book-a", filters: {}, page: { limit: 50, offset: 0, total: 2351, returned: 2 }, positions: [
  row("pos-loan-0001", "loans", "asset", 0.0625),
  row("pos-dda-0002", "dda", "liability", null) ] } as unknown as CatalogPositionsPage;

export const CASHFLOWS = { grid: { horizonMonths: 3, asOf: "2026-03-31" }, byScenario: [{ scenarioId: "S0", byFamily: [
  { familyId: "loans", series: { balance: [100, 90, 80], principal: [10, 10, 10], interest: [1, 1, 1] } },
  { familyId: "dda", series: { balance: [50, 49, 48], principal: [1, 1, 1], interest: [0, 0, 0] } } ], byCoaNode: [] }] } as unknown as BucketedCashflowResult;

export const BOOK = { id: "book-a", coa: { schemaVersion: "1", nodes: [], families: [{ id: "loans", side: "asset" }, { id: "dda", side: "liability" }] }, positions: [] } as unknown as PortfolioSpec;
