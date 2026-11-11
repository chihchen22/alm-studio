// apps/studio/src/market/macroModel.ts
/**
 * Data > Market > Macro factors. Pure functions over a
 * stored market's macroFactors block and the page's projection draft: the series
 * table rows, the validator's problems, the chart points, the pasted projection
 * and the request the two derive routes take. The server derives the snapshot;
 * this file adds, scales, rounds and interpolates nothing. Types come from
 * the engine with import type only; the validator and monthAdd come by path from
 * a module with type-only imports, so no hash module reaches the Studio bundle.
 */
import type { DerivedMarketSnapshot, MacroBinding, MacroHistorySource, MacroSeries, MarketDeriveOp } from "@alm/engine";
import { monthAdd, validateMacroFactors } from "@alm/engine/src/macro/macroFactors";
import type { MarketDeriveRequest } from "@alm/reader";
import { baseOf } from "./rateIndexModel";

export const MACRO_COPY = {
  intro: "Read the monthly macro series a market carries, and load an authored house-price projection onto a market of its own. Pick a market to see its series, their source records and a chart of each. Nothing runs here: a saved market is attached on Market > Yield curves and named as a run setup's Market on Run > Setups.",
  history: "A history ends at the as-of month of the market and feeds no run. It is shown for context beside the projections.",
  projection: "A projection is a path its author wrote, from the month after the as-of, and never an engine forecast. It is held at its last value beyond its length.",
  unemployment: "Unemployment is shown as history only. It has no feeder, so no run reads it.",
  demonstration: "Every value here is a demonstration value. The shipped projections are synthetic and authored, and a saved projection is labelled an authored projection.",
  readers: "One feeder reads a macro series: the house-price response of the four-factor prepayment, its housing parameters. A stored assumption set that maps a series to a family is listed here.",
  housing: "The housing parameters: housing.asOfLtv, housing.refiLtvMid, housing.refiLtvSlope, housing.turnoverLtvMid, housing.turnoverLtvSlope, housing.turnoverFloorShare and housing.turnoverCprFloor. Every housing value is illustrative.",
  gap: "A month the provider did not publish is drawn as a gap in the line and never filled.",
  none: "No stored assumption set maps a macro series.",
  /** With no history on screen; vintageText names the retrieval dates from the source records when there is one. */
  vintage: "A history is the vintage named in each history's source record, revised since first release, not point-in-time at the as-of.",
} as const;

/**
 * The run rule for macro paths, under the Plan gates and the Dashboard By scenario table (spec v4 Sections 5
 * and 9). Shown on every run, mapped or not, so "at most one" (final-review Minor 4). Declared here once (mfu-3).
 */
export const MACRO_PATH_NOTE = "A run's scenarios share at most one macro path, inherited from the base scenario's assumption set.";

export interface MacroSeriesRow {
  id: string;
  label: string;
  kind: string;
  role: string;
  unit: string;
  firstMonth: string;
  endMonth: string;
  sourceText: string;
  gapsText: string | null;
}

const isHistorySource = (s: MacroSeries["source"]): s is MacroHistorySource => !("authored" in s);

/** The About card's vintage line: the distinct retrievedOn dates of the history series' source records, in first-seen order; MACRO_COPY.vintage with none (final-review Minor 4). */
export function vintageText(block: readonly MacroSeries[]): string {
  const dates: string[] = [];
  for (const s of block) if (isHistorySource(s.source) && !dates.includes(s.source.retrievedOn)) dates.push(s.source.retrievedOn);
  if (dates.length === 0) return MACRO_COPY.vintage;
  const on = dates.length === 1 ? dates[0]! : `${dates.slice(0, -1).join(", ")} and ${dates[dates.length - 1]!}`;
  return `The histories are the vintage retrieved on ${on}, revised since first release, not point-in-time at the as-of.`;
}

/** The stored series as the table prints them: the source record in words and the months the provider did not publish. Formatting only. */
export function macroRows(block: readonly MacroSeries[] | undefined): MacroSeriesRow[] {
  return (block ?? []).map((s) => {
    const src = s.source;
    const history = isHistorySource(src);
    return {
      id: s.id,
      label: s.label,
      kind: s.kind,
      role: s.role,
      unit: s.unit,
      firstMonth: s.firstMonth,
      endMonth: monthAdd(s.firstMonth, s.values.length - 1),
      sourceText: history ? `${src.provider}, series ${src.seriesId}, retrieved ${src.retrievedOn}, ${src.vintage}` : `Authored projection: ${src.note}`,
      gapsText: history && src.knownGaps.length > 0 ? `Not published by the provider: ${src.knownGaps.join(", ")}` : null,
    };
  });
}

/** The validator's problems on a stored block, as texts; a market with no block has none. */
export function macroProblems(block: unknown, asOfMonth: string): string[] {
  if (block === undefined) return [];
  return validateMacroFactors(block, asOfMonth).map((p) => p.message);
}

/** The chart points: x is the month index from firstMonth; a null stays null, so the line breaks there. */
export function seriesPoints(s: MacroSeries): Array<[number, number | null]> {
  return s.values.map((v, i): [number, number | null] => [i, v]);
}

/** The projection form: the market it builds on, the new series id and label, and the values as pasted or uploaded. */
export interface ProjectionDraft {
  marketId: string | null;
  id: string;
  label: string;
  valuesText: string;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** One number per line or per comma; blank entries are skipped; anything else blocks, naming its line. Never interpolates. */
export function parseProjectionText(text: string): { values: number[] } | { block: string } {
  const values: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const part of lines[i]!.split(",")) {
      const token = part.trim();
      if (token === "") continue;
      if (!NUMBER.test(token)) return { block: `Line ${i + 1}: ${JSON.stringify(token)} is not a number` };
      values.push(Number(token));
    }
  }
  return { values };
}

/**
 * The request the two derive routes take, or why there is none yet. The base is the
 * chosen market's immediate base and its own stored ops go first (the rateIndexModel
 * rule), then one set-macro-series op carrying the authored projection.
 */
export function projectionRequestOf(
  d: ProjectionDraft,
  chosen: { id: string; source: Pick<DerivedMarketSnapshot, "derivedFrom"> },
  asOfMonth: string,
): MarketDeriveRequest | { block: string } {
  if (d.marketId === null) return { block: "Pick a market" };
  const id = d.id.trim();
  const label = d.label.trim();
  if (id === "") return { block: "Enter a series id" };
  if (label === "") return { block: "Enter a label" };
  const parsed = parseProjectionText(d.valuesText);
  if ("block" in parsed) return parsed;
  if (parsed.values.length === 0) return { block: "Paste or upload the monthly values" };
  const { baseId, carried } = baseOf(chosen.id, chosen.source);
  const op: MarketDeriveOp = {
    op: "set-macro-series",
    id,
    label,
    kind: "index",
    role: "projection",
    unit: `ratio to ${asOfMonth}`,
    firstMonth: monthAdd(asOfMonth, 1),
    values: parsed.values,
    source: { authored: true, note: "Authored projection, pasted or uploaded in Studio." },
  };
  return { baseId, ops: [...carried, op], label: `${label} (authored projection, demonstration values)` };
}

/** Per stored set that maps a series: "<set id> maps <seriesId> to <familyId> (house-price response)"; none reads the none copy. */
export function readersText(sets: ReadonlyArray<{ id: string; macroBindings?: MacroBinding[] }>): string[] {
  const out: string[] = [];
  for (const s of sets) for (const b of s.macroBindings ?? []) out.push(`${s.id} maps ${b.seriesId} to ${b.familyId} (house-price response)`);
  return out.length === 0 ? [MACRO_COPY.none] : out;
}
