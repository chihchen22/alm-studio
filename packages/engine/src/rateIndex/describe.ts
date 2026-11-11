/**
 * The words for a rate index: the compile and stochastic note and the Studio Rate
 * indices page print the same text. Type imports only, so Studio may import this file by path.
 */
import type { RateIndex } from "../contracts/rateIndex";

const num = (x: number): string => String(Number(x.toFixed(6)));
const months = (n: number): string => (n === 1 ? "1 month" : `${n} months`);
const years = (n: number): string => (n === 1 ? "1 year" : `${n} years`);

export const bpText = (decimal: number): string => `${num(decimal * 10000)} bp`;
export const percentText = (decimal: number): string => `${String(Number((decimal * 100).toFixed(4)))} percent`;

/** The kind and its settings, without the id and the basis. */
export function indexSettingsText(r: RateIndex): string {
  if (r.kind === "constant-maturity-swap") return `constant-maturity swap, ${years(r.tenorYears)}`;
  if (r.kind === "formula") {
    const form = r.beta !== undefined
      ? `beta (change) ${String(r.beta)} from a start of ${r.start === undefined ? "none" : `${percentText(r.start)} plus basis`}`
      : `coefficient (level) ${String(r.coefficient)}`;
    const lag = r.lagMonths === undefined ? "lag none" : `lag ${months(r.lagMonths)}`;
    const floor = r.floor === undefined ? "floor none" : `floor ${percentText(r.floor)}`;
    const cap = r.cap === undefined ? "cap none" : `cap ${percentText(r.cap)}`;
    return `formula on ${r.parent}, ${form}, ${lag}, ${floor}, ${cap}`;
  }
  return `compounded window, ${months(r.tenorMonths)}`;
}

/** One index as the results note lists it: id, kind and settings, basis, and the derived curve when it names one. */
export function indexFormulaText(r: RateIndex): string {
  return `${r.id}: ${indexSettingsText(r)}, basis ${bpText(r.basis)}${r.spreadCurve !== undefined ? `, derived curve ${r.spreadCurve}` : ""}${r.historyId !== undefined ? `, history ${r.historyId}` : ""}`;
}
