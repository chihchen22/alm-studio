/**
 * The plan's book picker. A plan names one book; Hierarchies
 * and mapping stores a re-tagged copy of it as <base>--<hierarchy>. The picker
 * offers the base and the copies of that base for each stored hierarchy, and
 * nothing else, so a plan is never pointed at an unrelated book.
 */
import type { PlanDoc } from "./planGraph";

export interface BookOption {
  id: string;
  /** null for the base book. */
  hierarchyId: string | null;
}

export interface BookChoices {
  base: string;
  options: BookOption[];
}

export function bookChoices(
  planBook: string,
  bookIds: readonly string[],
  hierarchyIds: readonly string[],
): BookChoices {
  const books = new Set(bookIds);
  const hierarchies = new Set(hierarchyIds);
  const i = planBook.lastIndexOf("--");
  const isCopy = i > 0 && hierarchies.has(planBook.slice(i + 2)) && books.has(planBook.slice(0, i));
  const base = isCopy ? planBook.slice(0, i) : planBook;
  const copies = [...hierarchies]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .filter((h) => books.has(`${base}--${h}`))
    .map((h) => ({ id: `${base}--${h}`, hierarchyId: h }));
  return { base, options: [{ id: base, hierarchyId: null }, ...copies] };
}

export function bookOptionText(option: BookOption, base: string): string {
  return option.id === base ? `${option.id} (base)` : option.id;
}

export function bookNote(choices: BookChoices): string {
  const n = choices.options.length - 1;
  if (n === 0) {
    return `No re-tagged copy of ${choices.base} is stored; apply a hierarchy to it on Hierarchies and mapping to make one.`;
  }
  return `${choices.base} and ${n} re-tagged ${n === 1 ? "copy" : "copies"}`;
}

/**
 * Point the plan at another book. inputs.dimensionTaxonomy only cross-checks the
 * book's own taxonomy, and a re-tagged copy carries a composed one, so a switch
 * drops it; choosing the loaded book again restores the loaded inputs exactly,
 * except the market, which the Market picker owns and a book switch never undoes.
 */
export function withBook(plan: PlanDoc, loaded: PlanDoc, bookId: string): PlanDoc {
  if (bookId === loaded.inputs.positionBook) {
    return { ...plan, inputs: { ...loaded.inputs, marketSnapshot: plan.inputs.marketSnapshot } };
  }
  const { dimensionTaxonomy: _dropped, ...rest } = plan.inputs;
  return { ...plan, inputs: { ...rest, positionBook: bookId } };
}
