// apps/studio/src/pages/analysis/charts.ts
/** Axis ticks the guided steps' charts share. Formatting only. */
import type { XTick } from "../../charts/plotScale";

const TENOR_MONTHS = [1, 3, 6, 12, 24, 36, 60, 84, 120, 240, 360];

/** Tenor ticks in months on a square-root axis: 1M to 30Y, those inside the shown range. */
export function tenorTicks(lo: number, hi: number): XTick[] {
  return TENOR_MONTHS.filter((m) => m >= lo && m <= hi).map((m) => ({ value: m, label: m % 12 === 0 ? `${m / 12}Y` : `${m}M` }));
}

/** Tenor ticks in years: 3M to 30Y, those inside the shown range. */
export function yearTicks(lo: number, hi: number): XTick[] {
  return [0.25, 1, 2, 5, 10, 20, 30].filter((t) => t >= lo && t <= hi).map((t) => ({ value: t, label: t < 1 ? `${Math.round(t * 12)}M` : `${t}Y` }));
}

/** Plain linear ticks: about six round steps over the range. */
export function linearTicks(lo: number, hi: number): XTick[] {
  const span = hi - lo;
  if (!(span > 0)) return [{ value: lo, label: String(lo) }];
  const raw = span / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: XTick[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push({ value: Number(v.toFixed(6)), label: String(Number(v.toFixed(6))) });
  return out;
}
