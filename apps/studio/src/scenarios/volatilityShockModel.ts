// apps/studio/src/scenarios/volatilityShockModel.ts
/**
 * Data > Scenarios > Volatility shocks. Pure functions over
 * the page's draft: one base market, a list of ops (scale, or add basis points
 * of normal volatility to, the constructed short-rate volatilities, at every
 * expiry or at one at-the-money expiry), and the request the two derive routes
 * take. The server derives the snapshot and computes every number the page
 * prints; this file computes none. Types come from the engine with
 * import type only, so no hash module reaches the Studio bundle.
 */
import type { DerivedMarketSnapshot, ShortRateVolOp, ShortRateVolOpKind } from "@alm/engine";
import { volBpText, type MarketDeriveRequest } from "@alm/reader";
import { ENTER_A_NUMBER } from "../assumptions/setEditModel";
import { tenorLabel } from "../format/tenor";
import { readValue } from "./behavioralShockModel";

export { fundingSaveNoteOf, planLinkFor } from "./fundingSpreadShockModel";

/** One op row as typed: the expiry in years (null for every expiry), the op kind, the value as text. */
export interface VolOpDraft {
  key: number;
  expiryYears: number | null;
  op: ShortRateVolOpKind;
  valueText: string;
}

export interface VolShockDraft {
  baseId: string | null;
  ops: VolOpDraft[];
  label: string;
  id: string;
  /** The key the next added op row takes: kept through removals, so React keys follow the row. */
  nextKey: number;
}

export function emptyVolShockDraft(): VolShockDraft {
  return { baseId: null, ops: [], label: "", id: "", nextKey: 0 };
}

/** Another base drops the ops: their expiries belong to the old base. */
export function setVolBase(d: VolShockDraft, baseId: string | null): VolShockDraft {
  return { ...d, baseId, ops: [] };
}

export function addVolOp(d: VolShockDraft): VolShockDraft {
  const row: VolOpDraft = { key: d.nextKey, expiryYears: null, op: "scale-short-rate-vol", valueText: "" };
  return { ...d, ops: [...d.ops, row], nextKey: d.nextKey + 1 };
}

export function removeVolOp(d: VolShockDraft, key: number): VolShockDraft {
  return { ...d, ops: d.ops.filter((o) => o.key !== key) };
}

export function setVolOpField(d: VolShockDraft, key: number, patch: Partial<Omit<VolOpDraft, "key">>): VolShockDraft {
  return { ...d, ops: d.ops.map((o) => (o.key === key ? { ...o, ...patch } : o)) };
}

export const VOL_OP_CHOICES: ReadonlyArray<{ op: ShortRateVolOpKind; text: string }> = [
  { op: "scale-short-rate-vol", text: "Scale by" },
  { op: "add-short-rate-vol", text: "Add (bp)" },
];

/** The part of a stored market the page reads: its short-rate volatility quotes (the engine's capQuotes key). */
export type VolBase = Pick<DerivedMarketSnapshot, "capQuotes">;

export interface AtmRow { expiryYears: number; normalVol: number }

/** The at-the-money quotes in stored order, as stored. Only this column feeds the calibration. */
export function atmRows(base: VolBase): AtmRow[] {
  return base.capQuotes.filter((q) => q.isAtm).map((q) => ({ expiryYears: q.expiryYears, normalVol: q.normalVol }));
}

export interface ExpiryChoice { expiryYears: number | null; text: string }

/** "Every expiry" first, then one option per at-the-money expiry with its stored volatility in basis points. */
export function expiryChoices(base: VolBase): ExpiryChoice[] {
  const rows = atmRows(base).map((r) => ({ expiryYears: r.expiryYears, text: `${tenorLabel(r.expiryYears)}, stored ${volBpText(r.normalVol)} bp` }));
  return [{ expiryYears: null, text: "Every expiry" }, ...rows];
}

export type VolShockRequest = { body: MarketDeriveRequest } | { block: string };

/** The request body the two derive routes take, or why there is none yet. target is left out for every expiry; id and label are trimmed and left out when empty. */
export function volRequestOf(d: VolShockDraft, base: VolBase | null): VolShockRequest {
  if (d.baseId === null) return { block: "Pick a base market" };
  if (base === null) return { block: "Reading the base market" };
  if (d.ops.length === 0) return { block: "Add an op" };
  const ops: ShortRateVolOp[] = [];
  for (const row of d.ops) {
    const v = readValue(row.valueText);
    if (!("value" in v)) return { block: ENTER_A_NUMBER };
    ops.push({ ...(row.expiryYears === null ? {} : { target: { expiryYears: row.expiryYears } }), op: row.op, value: v.value });
  }
  const id = d.id.trim();
  const label = d.label.trim();
  return { body: { baseId: d.baseId, ops, ...(id !== "" ? { id } : {}), ...(label !== "" ? { label } : {}) } };
}
