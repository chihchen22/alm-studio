// apps/studio/src/results/waterfall.ts
/**
 * Waterfall geometry for one stored attribution headline (Studio S3a). The
 * printed amounts are stored fields: the base value, each contribution, the
 * scenario value. The running position below places bars and is never
 * printed. There is no residual bar: the residual is printed as stored, so no
 * bar is ever derived from base, contributions and scenario.
 */
import type { HeadlineAttribution } from "@alm/engine";
import { driverLabel } from "@alm/reader";

export interface WfBar {
  key: string;
  label: string;
  amount: number;
  from: number;
  to: number;
  kind: "anchor" | "up" | "down";
}

export interface WfLayout {
  bars: WfBar[];
  lo: number;
  hi: number;
}

export function waterfallLayout(h: HeadlineAttribution, dropZeros = true): WfLayout {
  const bars: WfBar[] = [{ key: "base", label: "Base", amount: h.baseValue, from: 0, to: h.baseValue, kind: "anchor" }];
  let at = h.baseValue;
  h.contributions.forEach((c, i) => {
    if (dropZeros && c.amount === 0) return;
    const to = at + c.amount;
    bars.push({ key: `c${i}`, label: `${c.familyId} ${driverLabel(c.driver)}`, amount: c.amount, from: at, to, kind: c.amount >= 0 ? "up" : "down" });
    at = to;
  });
  bars.push({ key: "scenario", label: "Scenario", amount: h.scenarioValue, from: 0, to: h.scenarioValue, kind: "anchor" });
  const ends = bars.flatMap((b) => [b.from, b.to]);
  return { bars, lo: Math.min(0, ...ends), hi: Math.max(0, ...ends) };
}

/** A bar's left edge and width in percent of the track. */
export function barBox(b: WfBar, lo: number, hi: number): { left: number; width: number } {
  const span = hi - lo || 1;
  return { left: ((Math.min(b.from, b.to) - lo) / span) * 100, width: (Math.abs(b.to - b.from) / span) * 100 };
}
