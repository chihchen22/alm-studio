/**
 * The one builder of a stored rate index record. The validator's key lists, the derive's
 * fresh() and set apply, and the run's fold all go through this file, so a field added to an index kind is carried
 * by all of them or by none. RATE_INDEX_KEYS is also the stored key order; a compounded window writes no `kind`, so
 * its bytes are the bytes written before B3a. historyId is last on every kind, and a set-index that names
 * none keeps the one the index carries (ruling R2). Type imports only: no cycle with rateIndices.ts or resolve.ts.
 */
import type { CompoundedWindowIndex, ConstantMaturitySwapIndex, RateIndex, RateIndexKind, RateIndexSetOp } from "../contracts/rateIndex";

export const RATE_INDEX_KEYS: Readonly<Record<RateIndexKind, readonly string[]>> = {
  "compounded-window": ["id", "label", "kind", "tenorMonths", "basis", "spreadCurve", "historyId"],
  "constant-maturity-swap": ["id", "label", "kind", "tenorYears", "basis", "spreadCurve", "historyId"],
  formula: ["id", "label", "kind", "parent", "coefficient", "beta", "start", "lagMonths", "floor", "cap", "basis", "historyId"],
};

export function indexKindOf(r: { readonly kind?: RateIndexKind }): RateIndexKind {
  return r.kind ?? "compounded-window";
}

/** A fresh record in the stored key order, each key only when set. A run-time field (parentAtCutoff) is dropped. */
export function indexRecord(r: RateIndex): RateIndex {
  const kind = indexKindOf(r);
  const src = r as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RATE_INDEX_KEYS[kind]) {
    if (key === "kind" && kind === "compounded-window") continue;
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out as unknown as RateIndex;
}

/**
 * Round to 12 significant digits, which removes float noise without losing real precision; -0 becomes 0. The
 * market derivation's rounding (deriveMarketSnapshot.ts imports it from here), shared so a stored decimal is
 * rounded one way.
 */
export const round12 = (v: number): number => {
  const r = Number(v.toPrecision(12));
  return r === 0 ? 0 : r;
};

/** Basis points to a stored decimal, rounded by round12. */
export function bpToDecimal(bp: number): number {
  return round12(bp / 10000);
}

/**
 * The stored record a set-index op writes: levels in basis points become decimals; a lag of 0 is left out. The
 * op's historyId when it names one, else keptHistoryId, the id the index already carries.
 */
export function indexFromSetOp(o: RateIndexSetOp, keptHistoryId?: string): RateIndex {
  const historyId = o.historyId ?? keptHistoryId;
  const basis = bpToDecimal(o.basisBp);
  if (o.kind === "constant-maturity-swap") {
    return indexRecord({ id: o.id, label: o.label, kind: "constant-maturity-swap", tenorYears: o.tenorYears, basis, spreadCurve: o.spreadCurve, historyId });
  }
  if (o.kind === "formula") {
    return indexRecord({
      id: o.id,
      label: o.label,
      kind: "formula",
      parent: o.parent,
      coefficient: o.coefficient,
      beta: o.beta,
      start: o.startBp === undefined ? undefined : bpToDecimal(o.startBp),
      lagMonths: o.lagMonths === 0 ? undefined : o.lagMonths,
      floor: o.floorBp === undefined ? undefined : bpToDecimal(o.floorBp),
      cap: o.capBp === undefined ? undefined : bpToDecimal(o.capBp),
      basis,
      historyId,
    });
  }
  return indexRecord({ id: o.id, label: o.label, tenorMonths: o.tenorMonths, basis, spreadCurve: o.spreadCurve, historyId });
}

/** The run's folded entry: the spread is in the basis and spreadCurve is gone, so nothing downstream folds twice. */
export function foldedIndex(r: CompoundedWindowIndex | ConstantMaturitySwapIndex, basis: number): RateIndex {
  return indexRecord({ ...r, basis, spreadCurve: undefined });
}

/** The grid tenor a derived curve is read at: the window's months, or 12 x the swap tenor in years (decision 36). */
export function spreadTenorMonthsOf(r: CompoundedWindowIndex | ConstantMaturitySwapIndex): number {
  return r.kind === "constant-maturity-swap" ? 12 * r.tenorYears : r.tenorMonths;
}
