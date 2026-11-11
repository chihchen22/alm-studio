/**
 * The plan's market picker. A plan names one market snapshot;
 * Funding spread shocks, Rate indices and Volatility shocks store a derived copy of it
 * whose listing row carries derivedFromMarketId. The picker offers the base and
 * the direct copies of that base, and nothing else, so a plan is never pointed at an unrelated market.
 */
import type { PlanDoc } from "./planGraph";

/** The listing fields the picker reads (a subset of the reader's MarketListItem). */
export interface MarketRow {
  id: string;
  derivedFromMarketId?: string;
}

export interface MarketOption {
  id: string;
  /** false for the base market. */
  derived: boolean;
}

export interface MarketChoices {
  base: string;
  options: MarketOption[];
}

export function marketChoices(planMarket: string, rows: readonly MarketRow[]): MarketChoices {
  const listed = new Set(rows.map((r) => r.id));
  const parent = rows.find((r) => r.id === planMarket)?.derivedFromMarketId;
  const base = parent !== undefined && listed.has(parent) ? parent : planMarket;
  const copies = rows
    .filter((r) => r.derivedFromMarketId === base && r.id !== base)
    .map((r) => r.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => ({ id, derived: true }));
  return { base, options: [{ id: base, derived: false }, ...copies] };
}

export function marketOptionText(option: MarketOption, base: string): string {
  return option.id === base ? `${option.id} (base)` : option.id;
}

export function marketNote(choices: MarketChoices): string {
  const n = choices.options.length - 1;
  if (n === 0) {
    return `No derived copy of ${choices.base} is stored; derive one on Funding spread shocks, Rate indices or Volatility shocks.`;
  }
  return `${choices.base} and ${n} derived ${n === 1 ? "copy" : "copies"}`;
}

/**
 * Point the plan at another market. Only inputs.marketSnapshot changes, in place,
 * so the serialized plan differs on that one line; choosing the loaded market
 * again gives the loaded plan back exactly.
 */
export function withMarket(plan: PlanDoc, loaded: PlanDoc, marketId: string): PlanDoc {
  const next = marketId === loaded.inputs.marketSnapshot ? loaded.inputs.marketSnapshot : marketId;
  return { ...plan, inputs: { ...plan.inputs, marketSnapshot: next } };
}
