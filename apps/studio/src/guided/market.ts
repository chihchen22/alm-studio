// apps/studio/src/guided/market.ts
/**
 * The guided Market step (S2a spec point 3): what a snapshot holds, the plain market template, and the in-place curve
 * edit that saves as a named variant (a curve setup, activated) with the snapshot's own curve drawn beside it.
 *
 * The edit starts from the snapshot's quotes as the Curve setups screen fills them (fillFromSnapshot), keeps the
 * snapshot's convention and interpolates log-linear on discount factor, the platform default. A rate is typed in
 * percent and stored as the decimal the grid would read. The template is two columns, tenor and par rate in percent:
 * the same layout the paste box reads, so a downloaded template, edited in a spreadsheet, pastes straight back.
 */
import type { CurveSetupBlock } from "@alm/engine";
import { blockFromState, parsePaste, tenorTextOf, type GridRow } from "../market/curveSetupModel";

export interface SnapshotLike {
  calibrationDate?: string;
  curveQuotes?: ReadonlyArray<{ term?: string; tYears: number; instrumentType: string; rate: number }>;
  curveConvention?: string;
  capQuotes?: ReadonlyArray<{ expiryYears: number; strike: number; isAtm?: boolean }>;
  swaptionATMQuotes?: ReadonlyArray<{ expiryYears: number; tenorYears: number }>;
  termFundingCurveQuotes?: ReadonlyArray<unknown>;
  tlpNodes?: ReadonlyArray<unknown>;
  /** "RFR" marks the public snapshot, whose funding premium and volatility surfaces are constructed (kernel MarketSnapshot). */
  discountingIndex?: string;
}

/**
 * The snapshot's funding premium and volatility surfaces are constructed illustrative values, not
 * market quotes. The kernel marks such a snapshot with the benchmark label "RFR" (its curve is published Treasury par
 * yields; its funding spreads and volatility surfaces are hand-set or realized-anchored analogs).
 */
export function isIllustrativePack(s: Pick<SnapshotLike, "discountingIndex">): boolean {
  return s.discountingIndex === "RFR";
}

export interface SnapshotSummary {
  date: string | null;
  curvePoints: number;
  /** "1M to 30Y" from the quotes' terms; null with no quotes. */
  curveSpan: string | null;
  capExpiries: number;
  capStrikes: number;
  hasAtmCaps: boolean;
  swaptionExpiries: number;
  swaptionTenors: number;
  fundingPoints: number;
  sentence: string;
}

const distinct = (xs: readonly number[]): number => new Set(xs).size;

export function summarizeSnapshot(s: SnapshotLike): SnapshotSummary {
  const q = s.curveQuotes ?? [];
  const caps = s.capQuotes ?? [];
  const sw = s.swaptionATMQuotes ?? [];
  const sorted = [...q].sort((a, b) => a.tYears - b.tYears);
  const termOf = (x: (typeof q)[number]): string => x.term ?? `${x.tYears}Y`;
  const curveSpan = sorted.length === 0 ? null : `${termOf(sorted[0]!)} to ${termOf(sorted[sorted.length - 1]!)}`;
  const capExpiries = distinct(caps.map((c) => c.expiryYears));
  const capStrikes = distinct(caps.map((c) => c.strike));
  const swaptionExpiries = distinct(sw.map((c) => c.expiryYears));
  const swaptionTenors = distinct(sw.map((c) => c.tenorYears));
  const parts: string[] = [];
  parts.push(q.length === 0 ? "no yield curve quotes" : `a yield curve of ${q.length} quotes, ${curveSpan}`);
  parts.push(caps.length === 0 ? "no cap volatilities" : `cap volatilities at ${capExpiries} expiries and ${capStrikes} strikes`);
  parts.push(sw.length === 0 ? "no swaption volatilities" : `swaption volatilities at ${swaptionExpiries} expiries and ${swaptionTenors} tenors`);
  return {
    date: s.calibrationDate ?? null,
    curvePoints: q.length,
    curveSpan,
    capExpiries,
    capStrikes,
    hasAtmCaps: caps.some((c) => c.isAtm === true),
    swaptionExpiries,
    swaptionTenors,
    fundingPoints: s.termFundingCurveQuotes?.length ?? 0,
    sentence: `Holds ${parts.join("; ")}.`,
  };
}

/** A decimal rate as percent text with no float noise: 0.0374 is "3.74". */
export function percentText(rate: number): string {
  return String(Number((rate * 100).toPrecision(12)));
}

/** The plain market template: tenor and par rate in percent, one row per curve quote of at least one month. */
export function marketTemplateCsv(s: SnapshotLike): string {
  const rows = (s.curveQuotes ?? [])
    .map((q) => ({ months: Math.round(q.tYears * 12), rate: q.rate }))
    .filter((r) => r.months >= 1)
    .map((r) => `${tenorTextOf(r.months)},${percentText(r.rate)}`);
  return `Tenor,Par rate percent\n${rows.join("\n")}\n`;
}

/**
 * The template as the editor holds it (L12): the rates as typed, so a downloaded template carries your edit, not only
 * the snapshot's quotes. A blank rate is left out.
 */
export function templateFromRows(rows: readonly CurveEditRow[]): string {
  const lines = rows.filter((r) => r.editPercent.trim() !== "").map((r) => `${tenorTextOf(r.tenorMonths)},${r.editPercent.trim()}`);
  return `Tenor,Par rate percent\n${lines.join("\n")}\n`;
}

/** One editable curve row: the snapshot's quote and the rate as the user typed it, both in percent. */
export interface CurveEditRow {
  tenorMonths: number;
  instrument: GridRow["instrument"];
  snapshotPercent: string;
  editPercent: string;
}

/** The rows the editor opens on: the snapshot's quotes of at least one month, the edit equal to the quote. */
export function editRowsOf(s: SnapshotLike): CurveEditRow[] {
  return (s.curveQuotes ?? [])
    .filter((q) => Number.isFinite(q.tYears) && Math.round(q.tYears * 12) >= 1)
    .map((q) => {
      const p = percentText(q.rate);
      return { tenorMonths: Math.round(q.tYears * 12), instrument: q.instrumentType === "CASH" ? "cash" : "ois-swap", snapshotPercent: p, editPercent: p };
    });
}

/** Pasted text (the template's layout, or two columns from a spreadsheet) laid over the rows by tenor; unknown tenors are named. */
export function applyPaste(rows: readonly CurveEditRow[], text: string): { rows: CurveEditRow[]; notes: string[] } {
  const parsed = parsePaste(text, { unit: "auto" });
  const notes = parsed.skipped.filter((s) => !s.why.endsWith("header row skipped")).map((s) => s.why);
  const out = rows.map((r) => ({ ...r }));
  for (const p of parsed.rows) {
    const r = out.find((x) => x.tenorMonths === p.tenorMonths);
    if (r === undefined) notes.push(`${tenorTextOf(p.tenorMonths)} is not a tenor of this curve; it was left out.`);
    else r.editPercent = percentText(p.value);
  }
  return { rows: out, notes };
}

/** The rows the user changed, by tenor, with the change in basis points. */
export function changedRows(rows: readonly CurveEditRow[]): Array<{ tenor: string; fromPercent: string; toPercent: string; changeBp: number }> {
  return rows
    .filter((r) => r.editPercent.trim() !== r.snapshotPercent)
    .map((r) => ({ tenor: tenorTextOf(r.tenorMonths), fromPercent: r.snapshotPercent, toPercent: r.editPercent.trim(), changeBp: Math.round((Number(r.editPercent) - Number(r.snapshotPercent)) * 100 * 1e6) / 1e6 }));
}

function convention(curveConvention: string | undefined): { dayCount: CurveSetupBlock["dayCount"]; compounding: CurveSetupBlock["compounding"]; baseCurve: string } {
  if (curveConvention === "semiannual_bond") return { dayCount: "ACT/365", compounding: "semi-annual", baseCurve: "UST" };
  return { dayCount: "ACT/360", compounding: "annual", baseCurve: "SOFR" };
}

/**
 * The curve setup for one side of the picture: "snapshot" builds from the quotes as the snapshot holds them, "edit"
 * from the typed rates. Returns the problems by row (in plain words) when a typed rate is not a number.
 */
export function curveBlockOf(s: SnapshotLike, rows: readonly CurveEditRow[], side: "snapshot" | "edit", id: string, label: string): { block: CurveSetupBlock | null; problems: string[] } {
  const conv = convention(s.curveConvention);
  const grid: GridRow[] = rows.map((r) => {
    const text = (side === "snapshot" ? r.snapshotPercent : r.editPercent).trim();
    return { instrument: r.instrument, tenorText: tenorTextOf(r.tenorMonths), quoteType: "par-rate", valueText: text === "" ? "" : `${text}%`, convexityText: "" };
  });
  const built = blockFromState({ id, label, baseCurve: conv.baseCurve, interpolation: "log-linear-df", dayCount: conv.dayCount, compounding: conv.compounding, rows: grid });
  return { block: built.block, problems: built.problems.map((p) => `${tenorTextOf(rows[p.row - 1]!.tenorMonths)}: ${p.why}`) };
}

/** The next variant name: `edited-<n>` with the first n no saved setup holds. */
export function nextVariantId(taken: readonly string[]): string {
  let n = 1;
  while (taken.includes(`edited-${n}`)) n++;
  return `edited-${n}`;
}
