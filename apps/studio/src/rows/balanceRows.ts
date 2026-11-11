/**
 * Balance Sheet rows. Field copies out of the served catalog aggregate and the
 * book's chart of accounts. No arithmetic: nothing here sums a family or a side.
 */
import type { CatalogGroupedAggregateResponse } from "@alm/reader";
import type { PortfolioSpec } from "@alm/engine";

export interface GroupRow { key: string; positionCount: number; totalNotional: number | null; weightedAvgRate: number | null }

/** groups in route order; a null key (positions with no value for the grouping) prints as "(none)". Fields copied. */
export function groupRows(r: CatalogGroupedAggregateResponse): GroupRow[] {
  return r.groups.map((g) => ({ key: g.key ?? "(none)", positionCount: g.positionCount, totalNotional: g.totalNotional, weightedAvgRate: g.weightedAvgRate }));
}

/**
 * The declared side of a family, read from book.coa.families[].side
 * (ProductFamilyDef.side). undefined for a family the book does not declare,
 * and for the equity and derivative sides, which the runoff colouring does not
 * split out: it colours assets and liabilities only.
 */
export function sideOf(book: PortfolioSpec): (familyId: string) => "asset" | "liability" | undefined {
  const sides = new Map<string, "asset" | "liability">();
  for (const f of book.coa.families) if (f.side === "asset" || f.side === "liability") sides.set(f.id, f.side);
  return (familyId) => sides.get(familyId);
}
