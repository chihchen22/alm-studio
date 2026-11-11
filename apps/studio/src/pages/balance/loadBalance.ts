/**
 * Balance Sheet loaders. loadBalance: four parallel reads (the grouped
 * aggregate under the page's filters, the unfiltered by-family aggregate for
 * the family chips, the book's lineage, the book itself), then, when a done
 * run exists, the run's lens reading (for its base scenario id) and its
 * cashflows section. loadPositionsPage: one page of positions, loaded on its
 * own so paging refetches nothing else. Every value is carried verbatim; no
 * family or side is summed.
 */
import {
  getCatalogAggregateGrouped,
  getCatalogLineage,
  getCatalogPositions,
  getPortfolio,
  getResultSection,
  getRunLenses,
  type CatalogGroupBy,
  type CatalogPositionFilters,
  type CatalogPositionsPage,
} from "@alm/reader";
import { groupRows, sideOf, type GroupRow } from "../../rows/balanceRows";
import { doneRunsNewestFirst } from "../../rows/homeRows";

export const PAGE_SIZE = 50;

export interface BalanceModel {
  bookId: string; groupBy: CatalogGroupBy; basis: string; groups: GroupRow[];
  /** groups of the unfiltered groupBy=family read, so every family stays selectable as a filter chip. */
  familyGroups: GroupRow[];
  filters: CatalogPositionFilters;
  /**
   * null when the book has no done run. byFamily is cashflows.byScenario[base].byFamily
   * in envelope order, balance copied; it is empty when the envelope has no entry for the base id.
   */
  runoff: null | { runId: string; scenarioId: string; asOf: string; horizonMonths: number; byFamily: Array<{ familyId: string; side: "asset" | "liability" | undefined; balance: number[] }> };
}

function filterParams(filters: CatalogPositionFilters): URLSearchParams {
  const qs = new URLSearchParams();
  if (filters.familyId !== undefined) qs.set("familyId", filters.familyId);
  if (filters.coaNodeId !== undefined) qs.set("coaNodeId", filters.coaNodeId);
  if (filters.instrumentType !== undefined) qs.set("instrumentType", filters.instrumentType);
  return qs;
}

/** The request path the grouped aggregate was read from, encoded and in the query order the reader sends. For the source line. */
export function aggregateRoute(bookId: string, filters: CatalogPositionFilters, groupBy: CatalogGroupBy): string {
  const qs = filterParams(filters);
  qs.set("groupBy", groupBy);
  return `/api/catalog/portfolios/${encodeURIComponent(bookId)}/positions/aggregate?${qs.toString()}`;
}

/** The request path of one positions page, encoded and in the query order the reader sends. For the source line. */
export function positionsRoute(bookId: string, filters: CatalogPositionFilters, offset: number): string {
  const qs = filterParams(filters);
  qs.set("limit", String(PAGE_SIZE));
  qs.set("offset", String(offset));
  return `/api/catalog/portfolios/${encodeURIComponent(bookId)}/positions?${qs.toString()}`;
}

/** One page of positions (limit PAGE_SIZE), verbatim. */
export function loadPositionsPage(bookId: string, filters: CatalogPositionFilters, offset: number): Promise<CatalogPositionsPage> {
  return getCatalogPositions(bookId, filters, PAGE_SIZE, offset);
}

export async function loadBalance(bookId: string, groupBy: CatalogGroupBy, filters: CatalogPositionFilters): Promise<BalanceModel> {
  const [grouped, byFamily, lineage, book] = await Promise.all([
    getCatalogAggregateGrouped(bookId, filters, groupBy),
    getCatalogAggregateGrouped(bookId, {}, "family"),
    getCatalogLineage("portfolios", bookId),
    getPortfolio(bookId),
  ]);
  const base = { bookId, groupBy, basis: grouped.basis, groups: groupRows(grouped), familyGroups: groupRows(byFamily), filters };
  // The newest run may be one with no cashflows section (a stochastic run): take the newest that serves one.
  const candidates = doneRunsNewestFirst(lineage);
  if (candidates.length === 0) return { ...base, runoff: null };
  let found: { runId: string; lenses: Awaited<ReturnType<typeof getRunLenses>>; cashflows: Awaited<ReturnType<typeof getResultSection<"cashflows">>> } | null = null;
  let firstError: unknown;
  for (const runId of candidates) {
    try {
      const [lenses, cashflows] = await Promise.all([getRunLenses(runId), getResultSection(runId, "cashflows")]);
      found = { runId, lenses, cashflows };
      break;
    } catch (e) {
      firstError ??= e;
    }
  }
  if (found === null) throw firstError;
  const { runId, lenses, cashflows } = found;
  const scenarioId = lenses.baseScenarioId;
  const side = sideOf(book);
  const scen = cashflows.byScenario.find((s) => s.scenarioId === scenarioId);
  return {
    ...base,
    runoff: {
      runId,
      scenarioId,
      asOf: cashflows.grid.asOf,
      horizonMonths: cashflows.grid.horizonMonths,
      byFamily: (scen?.byFamily ?? []).map((f) => ({ familyId: f.familyId, side: side(f.familyId), balance: f.series.balance })),
    },
  };
}
