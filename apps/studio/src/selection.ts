/**
 * The book and snapshot pair some pages still take as a prop, and the sort orders the catalog lists use. A page in a
 * workspace is given the ids the workspace head names (pages/pageFor.tsx idsOf); nothing resolves a selection from the
 * query any more (Piece E2).
 */
import type { CatalogMarketListItem, CatalogPortfolio, RunPlanMeta } from "@alm/reader";

export interface Selection {
  bookId: string | null;
  marketId: string | null;
}

export function withSelection(query: Record<string, string>, sel: Partial<Selection>): Record<string, string> {
  const next = { ...query };
  if (sel.bookId !== undefined) {
    if (sel.bookId === null) delete next.book;
    else next.book = sel.bookId;
  }
  if (sel.marketId !== undefined) {
    if (sel.marketId === null) delete next.asOf;
    else next.asOf = sel.marketId;
  }
  return next;
}

/** Books by id ascending. */
export function compareBooks(a: CatalogPortfolio, b: CatalogPortfolio): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Plans by id ascending. */
export function comparePlans(a: RunPlanMeta, b: RunPlanMeta): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Markets by asOf descending (newest first; a null asOf sorts last), ties by id ascending. */
export function compareMarkets(a: CatalogMarketListItem, b: CatalogMarketListItem): number {
  const x = a.asOf ?? "";
  const y = b.asOf ?? "";
  if (x !== y) return x < y ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * First book by id ascending; the market with the newest asOf, ties by id. A derived market copies its
 * base's as-of date, and "derived-mk-..." sorts ahead of a plain id on the tie, so the default is picked from the
 * markets that are not derived whenever there is one; a derived market is still picked by an explicit asOf.
 */
export function defaultSelection(books: CatalogPortfolio[], markets: CatalogMarketListItem[]): Selection {
  const book = [...books].sort(compareBooks)[0];
  const plain = markets.filter((m) => m.derivedFromMarketId === undefined);
  const market = [...(plain.length > 0 ? plain : markets)].sort(compareMarkets)[0];
  return { bookId: book?.id ?? null, marketId: market?.id ?? null };
}
