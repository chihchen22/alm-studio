// apps/studio/src/market/rateIndexModel.ts
/**
 * Data > Market > Rate indices. Pure functions over the
 * page's draft: one chosen market, a list of rate index ops (set an index of one
 * of three kinds, a compounded window, a constant-maturity swap or a formula on a
 * parent index, Piece B, step B3a; shift the basis of one; or point one at a
 * stored index history), and the request
 * the two derive routes take. The server derives the snapshot and computes every
 * number the page prints as a result; this file adds, scales and rounds none of
 * them. The one exception is input help: levelEcho reads a basis-point
 * level as typed back as a percent, beside the field, and the request sends the
 * typed number unchanged. Types come from the engine with import type only, and
 * the words for an index from the pure engine module rateIndex/describe.ts by
 * path (type imports only), so no hash module reaches the
 * Studio bundle.
 *
 * A derive request names a base and the ops that build on it. The base is the
 * chosen market's immediate base (derivedFrom.baseId, else the chosen market),
 * not necessarily the root, and the chosen market's own stored ops go first, so
 * the derived market keeps what the chosen one carries.
 */
import type { DerivedMarketSnapshot, MarketDeriveOp, RateIndex, RateIndexKind, RateIndexTenor, SwapTenorYears } from "@alm/engine";
import { indexSettingsText } from "@alm/engine/src/rateIndex/describe";
import { pct, type DerivedCurveListRow, type MarketDeriveRequest } from "@alm/reader";
import { ENTER_A_NUMBER } from "../assumptions/setEditModel";
import { fundingSaveNoteOf } from "../scenarios/fundingSpreadShockModel";
import type { ShockNote } from "../scenarios/behavioralShockModel";
import { readValue } from "../scenarios/behavioralShockModel";

export { planLinkFor } from "../scenarios/fundingSpreadShockModel";

/**
 * set: add an index or replace the one with the same id; shift: add basis points to the basis of one the market
 * carries; history: point one at a stored index history, or clear it.
 */
export type RateIndexRowKind = "set" | "shift" | "history";

/** The two forms of a formula index: a coefficient on the parent's level, or a beta on its monthly change. */
export type FormulaForm = "level" | "change";

/**
 * One op row as typed. indexId is the id typed (set) or picked (shift, history); label
 * and the index kind's fields are read on a set row only: tenorMonths on a
 * compounded window, tenorYears on a swap, parent, form and the typed factor,
 * start, lag, floor and cap on a formula, and spreadCurve on the two kinds that
 * are not formulas. valueText is the basis in basis points (set; a formula's
 * spread) or the shift in basis points (shift).
 */
export interface RateIndexOpDraft {
  key: number;
  kind: RateIndexRowKind;
  indexId: string;
  label: string;
  tenorMonths: RateIndexTenor;
  valueText: string;
  /** The derived curve's own id; absent or empty for the base curve alone. */
  spreadCurve?: string;
  /** B3a: the kind on a set row; absent reads compounded-window. */
  indexKind?: RateIndexKind;
  tenorYears?: SwapTenorYears;
  parent?: string;
  form?: FormulaForm;
  /** The coefficient or the beta as typed. */
  factorText?: string;
  /** Basis points as typed; empty is none (start is required for a beta row). */
  startText?: string;
  lagText?: string;
  floorText?: string;
  capText?: string;
  /** Step B3b: a history row's id (from an import), or null to clear the index's history. */
  historyId?: string | null;
}

export interface RateIndexDraft {
  marketId: string | null;
  ops: RateIndexOpDraft[];
  label: string;
  id: string;
  /** The key the next added row takes: kept through removals, so React keys follow the row. */
  nextKey: number;
}

export function emptyRateIndexDraft(): RateIndexDraft {
  return { marketId: null, ops: [], label: "", id: "", nextKey: 0 };
}

/** Another market drops the rows: they name the old market's indices. */
export function setRateIndexMarket(d: RateIndexDraft, marketId: string | null): RateIndexDraft {
  return { ...d, marketId, ops: [] };
}

export function addRateIndexOp(d: RateIndexDraft, kind: RateIndexRowKind): RateIndexDraft {
  const row: RateIndexOpDraft = { key: d.nextKey, kind, indexId: "", label: "", tenorMonths: 1, valueText: "" };
  return { ...d, ops: [...d.ops, row], nextKey: d.nextKey + 1 };
}

/** A history row: point an index at a stored history, or clear it with null. */
export function addHistoryOp(d: RateIndexDraft, indexId: string, historyId: string | null): RateIndexDraft {
  const row: RateIndexOpDraft = { key: d.nextKey, kind: "history", indexId, label: "", tenorMonths: 1, valueText: "", historyId };
  return { ...d, ops: [...d.ops, row], nextKey: d.nextKey + 1 };
}

export function removeRateIndexOp(d: RateIndexDraft, key: number): RateIndexDraft {
  return { ...d, ops: d.ops.filter((o) => o.key !== key) };
}

export function setRateIndexOpField(d: RateIndexDraft, key: number, patch: Partial<Omit<RateIndexOpDraft, "key">>): RateIndexDraft {
  return { ...d, ops: d.ops.map((o) => (o.key === key ? { ...o, ...patch } : o)) };
}

export const RATE_INDEX_TENOR_CHOICES: ReadonlyArray<{ tenorMonths: RateIndexTenor; text: string }> = [
  { tenorMonths: 1, text: "1 month" },
  { tenorMonths: 3, text: "3 months" },
  { tenorMonths: 6, text: "6 months" },
  { tenorMonths: 12, text: "12 months" },
];

export const RATE_INDEX_KIND_CHOICES: ReadonlyArray<{ kind: RateIndexKind; text: string }> = [
  { kind: "compounded-window", text: "Compounded window" },
  { kind: "constant-maturity-swap", text: "Constant-maturity swap" },
  { kind: "formula", text: "Formula on another index" },
];

export const SWAP_TENOR_CHOICES: ReadonlyArray<{ tenorYears: SwapTenorYears; text: string }> = ([1, 2, 3, 5, 7, 10, 20, 30] as const).map((y) => ({
  tenorYears: y,
  text: y === 1 ? "1 year" : `${y} years`,
}));

export const FORMULA_FORM_CHOICES: ReadonlyArray<{ form: FormulaForm; text: string }> = [
  { form: "level", text: "Coefficient (level)" },
  { form: "change", text: "Beta (change)" },
];

/** The fields a kind switch sets: a swap starts at 10 years; a formula starts on the level form and names no derived curve. */
export function kindDefaults(kind: RateIndexKind): Partial<Omit<RateIndexOpDraft, "key">> {
  if (kind === "constant-maturity-swap") return { indexKind: kind, tenorYears: 10 };
  if (kind === "formula") return { indexKind: kind, form: "level", spreadCurve: undefined };
  return { indexKind: kind };
}

/**
 * The part of a stored market the page reads: its rate indices and the record of its base, and its calibration date,
 * whose month is the cut-off a History panel measures its gap to.
 */
export type RateIndexSource = Pick<DerivedMarketSnapshot, "rateIndices" | "derivedFrom"> & { calibrationDate?: string };

export function tenorText(months: number): string {
  return months === 1 ? "1 month" : `${months} months`;
}

/** The Settings cell: a compounded window's months as before, the kind and settings of the two B3a kinds. */
export function indexTenorText(r: RateIndex): string {
  return r.kind === "constant-maturity-swap" || r.kind === "formula" ? indexSettingsText(r) : tenorText(r.tenorMonths);
}

/** spreadCurve and historyId are carried only when the index names one, as on the engine's RateIndex. */
export interface RateIndexRow { id: string; label: string; tenorText: string; basisText: string; spreadCurve?: string; historyId?: string }

/** The stored indices as the table prints them: the basis as a percent to four places. Formatting only. */
export function indexRows(source: RateIndexSource): RateIndexRow[] {
  return (source.rateIndices ?? []).map((r: RateIndex) => ({
    id: r.id, label: r.label, tenorText: indexTenorText(r), basisText: pct(r.basis, 4),
    ...(r.spreadCurve === undefined ? {} : { spreadCurve: r.spreadCurve }),
    ...(r.historyId === undefined ? {} : { historyId: r.historyId }),
  }));
}

/** The words for an index that names no derived curve: it reads the run's base curve alone. */
export const NO_SPREAD_CURVE = "None (base curve)";

/** The Derived curve cell of a table: the curve's own id, or the base-curve words. */
export function spreadCurveText(spreadCurve: string | undefined): string {
  return spreadCurve === undefined || spreadCurve === "" ? NO_SPREAD_CURVE : spreadCurve;
}

export interface SpreadCurveChoice { id: string; text: string }

/**
 * The derived curves a set row may name, in the listed order. The option value is the
 * curve's own id (curveId), the id an index's spreadCurve carries; never the document id.
 * The base is named because a curve on a base other than the run's is refused.
 */
export function spreadCurveChoices(rows: readonly DerivedCurveListRow[]): SpreadCurveChoice[] {
  return rows.map((r) => ({ id: r.curveId, text: `${r.label === "" ? r.curveId : `${r.curveId}: ${r.label}`} (on ${r.base})` }));
}

/** The basis of a stored or derived index as the preview prints it. */
export function basisText(basis: number): string {
  return pct(basis, 4);
}

export interface RateIndexBase { baseId: string; carried: MarketDeriveOp[] }

/**
 * The base a derive request names, and the ops that first build the chosen market
 * on it. This is the chosen market's immediate base, not necessarily the root.
 */
export function baseOf(chosenId: string, source: RateIndexSource): RateIndexBase {
  const from = source.derivedFrom;
  return from === undefined ? { baseId: chosenId, carried: [] } : { baseId: from.baseId, carried: from.ops };
}

export interface ShiftChoice { id: string; text: string }

/**
 * The indices a shift row may name: those the chosen market carries, then those a
 * set row above this one adds, because the engine applies ops in order.
 */
export function shiftChoices(source: RateIndexSource, d: RateIndexDraft, key: number): ShiftChoice[] {
  const out: ShiftChoice[] = (source.rateIndices ?? []).map((r) => ({ id: r.id, text: `${r.id}: ${r.label}` }));
  for (const row of d.ops) {
    if (row.key === key) break;
    const id = row.indexId.trim();
    if (row.kind === "set" && id !== "" && !out.some((c) => c.id === id)) {
      const label = row.label.trim();
      out.push({ id, text: label === "" ? id : `${id}: ${label}` });
    }
  }
  return out;
}

/** The parents a formula row may name: shiftChoices without the row's own id. */
export function parentChoices(source: RateIndexSource, d: RateIndexDraft, key: number): ShiftChoice[] {
  const own = d.ops.find((o) => o.key === key)?.indexId.trim() ?? "";
  return shiftChoices(source, d, key).filter((c) => c.id !== own);
}

/** Input help, formatting only: a typed basis-point level read back as a percent, so 4.33 typed for 4.33 percent shows as 0.0433 percent. */
export function levelEcho(text: string | undefined): string | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  const r = readValue(t);
  return "value" in r ? `${t} bp is ${String(Number((r.value / 100).toFixed(4)))} percent` : null;
}

export type RateIndexRequest = { body: MarketDeriveRequest } | { block: string };

/** The request body the two derive routes take, or why there is none yet. id and label are trimmed and left out when empty. */
export function rateIndexRequestOf(d: RateIndexDraft, source: RateIndexSource | null): RateIndexRequest {
  if (d.marketId === null) return { block: "Pick a market" };
  if (source === null) return { block: "Reading the market" };
  if (d.ops.length === 0) return { block: "Add an op" };
  const { baseId, carried } = baseOf(d.marketId, source);
  const ops: MarketDeriveOp[] = [...carried];
  for (const row of d.ops) {
    const indexId = row.indexId.trim();
    if (row.kind === "set") {
      const label = row.label.trim();
      if (indexId === "") return { block: "Enter an index id" };
      if (label === "") return { block: "Enter a label" };
      const v = readValue(row.valueText);
      if (!("value" in v)) return { block: ENTER_A_NUMBER };
      const kind = row.indexKind ?? "compounded-window";
      const spreadCurve = (row.spreadCurve ?? "").trim();
      const curve = spreadCurve === "" ? {} : { spreadCurve };
      if (kind === "compounded-window") {
        // A compounded window sends the pre-B3a op, with no kind key, so its hash does not move.
        ops.push({ op: "set-index", id: indexId, label, tenorMonths: row.tenorMonths, basisBp: v.value, ...curve });
      } else if (kind === "constant-maturity-swap") {
        ops.push({ op: "set-index", id: indexId, label, kind, tenorYears: row.tenorYears ?? 10, basisBp: v.value, ...curve });
      } else {
        const parent = (row.parent ?? "").trim();
        if (parent === "") return { block: "Pick a parent index" };
        const change = row.form === "change";
        const factor = readValue(row.factorText ?? "");
        if ((row.factorText ?? "").trim() === "" || !("value" in factor)) return { block: change ? "Enter a beta" : "Enter a coefficient" };
        // An optional field: empty is none (left out of the op), a number is sent as typed, anything else blocks.
        const optional = (t: string | undefined): number | null | "bad" => {
          if ((t ?? "").trim() === "") return null;
          const r = readValue(t!);
          return "value" in r ? r.value : "bad";
        };
        const start = change ? optional(row.startText) : null;
        if (change && start === null) return { block: "Enter a start value" };
        const lag = optional(row.lagText);
        const floor = optional(row.floorText);
        const cap = optional(row.capText);
        if (start === "bad" || lag === "bad" || floor === "bad" || cap === "bad") return { block: ENTER_A_NUMBER };
        // A formula names no derived curve: it reads its parent's full rate.
        ops.push({
          op: "set-index", id: indexId, label, kind: "formula", parent,
          ...(change ? { beta: factor.value } : { coefficient: factor.value }),
          ...(start !== null ? { startBp: start } : {}),
          ...(lag !== null ? { lagMonths: lag } : {}),
          ...(floor !== null ? { floorBp: floor } : {}),
          ...(cap !== null ? { capBp: cap } : {}),
          basisBp: v.value,
        });
      }
    } else if (row.kind === "history") {
      // A history row adds no index and sends no basis: it points one the market carries at an imported history, or clears it.
      if (indexId === "") return { block: "Pick an index" };
      if (row.historyId === undefined) return { block: "Import a history first" };
      ops.push({ op: "set-index-history", indexId, historyId: row.historyId });
    } else {
      if (indexId === "") return { block: "Pick an index" };
      const v = readValue(row.valueText);
      if (!("value" in v)) return { block: ENTER_A_NUMBER };
      ops.push({ op: "add-index-basis", indexId, value: v.value });
    }
  }
  const id = d.id.trim();
  const label = d.label.trim();
  return { body: { baseId, ops, ...(id !== "" ? { id } : {}), ...(label !== "" ? { label } : {}) } };
}

/** What the page says after a preview or a save: the same shape as the funding spread shock note. */
export function rateIndexSaveNoteOf(result: unknown): ShockNote {
  return fundingSaveNoteOf(result);
}
