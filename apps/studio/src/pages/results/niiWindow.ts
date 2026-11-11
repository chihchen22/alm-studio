// apps/studio/src/pages/results/niiWindow.ts
/**
 * The NII window (spec v3.1 Section 5.4 and 6.1): months shown on the NII screen, 60 by default, from 12 up
 * to the grid length, carried as the `window` page-state key. Pure helpers only; the one sum here is a roll-up of a
 * stored series, always printed as derived.
 */
import type { Query } from "../../router";

export const DEFAULT_WINDOW = 60;
export const MIN_WINDOW = 12;
const QUICK_CHOICES = [12, 24, 36, 60, 120, 240, 360];

/** The quick choices that fit the grid, then the whole grid. */
export function windowChoices(gridMonths: number): number[] {
  const out = QUICK_CHOICES.filter((m) => m <= gridMonths);
  if (!out.includes(gridMonths) && gridMonths > 0) out.push(gridMonths);
  return out;
}

/**
 * `?window=` when it is a whole number from 12 to the grid length; otherwise the run's own opening window
 * (`nii.windowMonths`, slice three decision 118) when it carries one, else 60, either clamped to 12 to the grid
 * length (the setup parser already holds a window to that range; an API-submitted one may sit below 12).
 */
export function windowOf(query: Query, gridMonths: number, runWindow?: number): number {
  const fallback = Math.max(Math.min(MIN_WINDOW, gridMonths), Math.min(runWindow ?? DEFAULT_WINDOW, gridMonths));
  const raw = query.window;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= Math.min(MIN_WINDOW, gridMonths) && n <= gridMonths ? n : fallback;
}

/** The figure caption every NII figure carries: the window, then the basis label by provenance. */
export function niiCaption(window: number, basisLabel: string | null): string {
  return `NII, ${window} months, ${basisLabel ?? "basis not recorded"}`;
}

/** The sum of the first `months` entries of a stored monthly series; null when the series is shorter. */
export function rollUp(series: number[], months: number): number | null {
  if (series.length < months) return null;
  let s = 0;
  for (let k = 0; k < months; k++) s += series[k]!;
  return s;
}

/**
 * Sets one page-state key on the address in place (a client-side control: the screen is the one the address already
 * names, only the key moves). The hash is parsed and written back, so a screen needs no knowledge of its workspace.
 */
export function setHashParam(key: string, value: string | null): void {
  setHashParams({ [key]: value });
}

/** Sets several page-state keys in one write, so a family pick and a node pick replace each other in one step. */
export function setHashParams(patch: Record<string, string | null>): void {
  const hash = window.location.hash;
  const at = hash.indexOf("?");
  const path = at === -1 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at === -1 ? "" : hash.slice(at + 1));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  window.location.hash = qs === "" ? path : `${path}?${qs}`;
}
