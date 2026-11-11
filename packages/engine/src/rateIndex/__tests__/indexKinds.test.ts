import { describe, expect, it } from "vitest";
import { ParallelShockPath, type Cashflow, type FloatingLoanTerms, type RatePath } from "@alm/kernel";
import type { AnchoredFormulaIndex, RateIndex, RateIndexTable } from "../../contracts/rateIndex";
import { bpToDecimal, foldedIndex, indexFromSetOp, indexRecord, spreadTenorMonthsOf } from "../record";
import { indexFormulaText, indexSettingsText } from "../describe";
import { IndexSeries, RateIndexUnanchoredError, ResolvedIndexPath, seriesFor } from "../indexSeries";
import { IndexedFloatingLoan } from "../indexedFloatingLoan";

/** A stub path: rateAt from a function, counting reads; forwardRateAt from another. */
class Stub implements RatePath {
  readonly nSteps = 400;
  readonly times: number[] = [];
  reads = 0;
  constructor(private readonly r: (s: number) => number, private readonly fwd: (s: number, y: number) => number = () => Number.NaN) {}
  rateAt(s: number): number {
    this.reads++;
    return this.r(s);
  }
  forwardRateAt(s: number, y: number): number {
    return this.fwd(s, y);
  }
}
const rising = () => new Stub((s) => 0.03 + 0.001 * s, (s, y) => 0.04 + 0.0001 * s + 0.001 * y);
const P1: RateIndex = { id: "p1", label: "One-month", tenorMonths: 1, basis: 0 };
const formula = (over: Partial<AnchoredFormulaIndex>): AnchoredFormulaIndex => ({ id: "f", label: "F", kind: "formula", parent: "p1", basis: 0, parentAtCutoff: 0.03, ...over });
const tableOf = (...rows: RateIndex[]): RateIndexTable => new Map(rows.map((r) => [r.id, r]));

describe("the record builder", () => {
  it("writes each kind in its stored key order, a compounded window without kind, and drops run-time fields", () => {
    expect(Object.keys(indexRecord({ id: "a", label: "A", kind: "compounded-window", tenorMonths: 3, basis: 0, spreadCurve: "c" }))).toEqual(["id", "label", "tenorMonths", "basis", "spreadCurve"]);
    expect(Object.keys(indexRecord({ spreadCurve: "c", basis: 0, tenorYears: 10, kind: "constant-maturity-swap", label: "C", id: "c10" }))).toEqual(["id", "label", "kind", "tenorYears", "basis", "spreadCurve"]);
    expect(Object.keys(indexRecord(formula({ beta: 0.4, start: 0.0433, lagMonths: 2, floor: 0, cap: 0.08 })))).toEqual(["id", "label", "kind", "parent", "beta", "start", "lagMonths", "floor", "cap", "basis"]);
  });
  it("converts a set-index op: basis points to decimals, lag 0 left out", () => {
    expect(indexFromSetOp({ op: "set-index", id: "a", label: "A", kind: "formula", parent: "p1", beta: 0.4, startBp: 433, lagMonths: 0, floorBp: 0, capBp: 800, basisBp: 25 })).toEqual({
      id: "a", label: "A", kind: "formula", parent: "p1", beta: 0.4, start: 0.0433, floor: 0, cap: 0.08, basis: 0.0025,
    });
    expect(indexFromSetOp({ op: "set-index", id: "w", label: "W", tenorMonths: 3, basisBp: 300 })).toEqual({ id: "w", label: "W", tenorMonths: 3, basis: 0.03 });
    expect(bpToDecimal(-0)).toBe(0);
  });
  it("folds a spread into the basis and leaves spreadCurve out; a swap index reads the grid at 12 x tenor months", () => {
    expect(foldedIndex({ id: "w", label: "W", tenorMonths: 3, basis: 0.001, spreadCurve: "c" }, 0.0022)).toEqual({ id: "w", label: "W", tenorMonths: 3, basis: 0.0022 });
    expect(spreadTenorMonthsOf({ id: "c10", label: "C", kind: "constant-maturity-swap", tenorYears: 10, basis: 0 })).toBe(120);
    expect(spreadTenorMonthsOf({ id: "w", label: "W", tenorMonths: 6, basis: 0 })).toBe(6);
  });
});

describe("the formula text (decision 43)", () => {
  it("names the kind, the form by its name, and every formula field", () => {
    expect(indexFormulaText({ id: "rfr-3m", label: "x", tenorMonths: 3, basis: 0, spreadCurve: "ust-sofr" })).toBe("rfr-3m: compounded window, 3 months, basis 0 bp, derived curve ust-sofr");
    expect(indexFormulaText({ id: "cms-10y", label: "x", kind: "constant-maturity-swap", tenorYears: 10, basis: 0.0015 })).toBe("cms-10y: constant-maturity swap, 10 years, basis 15 bp");
    expect(indexSettingsText({ id: "a", label: "x", kind: "formula", parent: "rfr-1m", beta: 0.4, start: 0.0433, lagMonths: 2, floor: 0, cap: 0.08, basis: 0 })).toBe(
      "formula on rfr-1m, beta (change) 0.4 from a start of 4.33 percent plus basis, lag 2 months, floor 0 percent, cap 8 percent",
    );
    expect(indexSettingsText({ id: "p", label: "x", kind: "formula", parent: "rfr-1m", coefficient: 1, basis: 0.03 })).toBe("formula on rfr-1m, coefficient (level) 1, lag none, floor none, cap none");
  });
});

describe("IndexSeries", () => {
  it("level: coefficient x parent + basis, clipped", () => {
    const s = new IndexSeries(tableOf(P1, formula({ coefficient: 0.5, basis: 0.01, cap: 0.035 })), rising());
    expect(s.valueAt("f", 0)).toBeCloseTo(0.5 * 0.03 + 0.01, 15);
    expect(s.valueAt("f", 4)).toBeCloseTo(0.5 * 0.034 + 0.01, 15);
    expect(s.valueAt("f", 30)).toBe(0.035);
  });
  it("lag: the months before the cut-off read parentAtCutoff, not the path's own month 0", () => {
    const s = new IndexSeries(tableOf(P1, formula({ coefficient: 0.5, basis: 0.01, lagMonths: 2, parentAtCutoff: 0.02 })), rising());
    expect([0, 1].map((t) => s.valueAt("f", t))).toEqual([0.5 * 0.02 + 0.01, 0.5 * 0.02 + 0.01]);
    expect(s.valueAt("f", 2)).toBeCloseTo(0.5 * 0.03 + 0.01, 15);
    expect(s.valueAt("f", 3)).toBeCloseTo(0.5 * 0.031 + 0.01, 15);
  });
  it("beta: starts at start + basis when month 0 equals the anchor, then moves by beta x each month's change", () => {
    const s = new IndexSeries(tableOf(P1, formula({ beta: 0.4, start: 0.02 })), rising());
    expect(s.valueAt("f", 0)).toBe(0.02);
    expect(s.valueAt("f", 5)).toBeCloseTo(0.02 + 5 * 0.4 * 0.001, 15);
  });
  it("beta: the basis enters once, through the start, and is not added again each month", () => {
    // rising(): the one-month parent reads 0.03 + 0.001 x s, so it rises 0.001 a step; the anchor is 0.03, its month 0.
    const s = new IndexSeries(tableOf(P1, formula({ beta: 0.4, start: 0.02, basis: 0.0025 })), rising());
    expect(s.valueAt("f", 0)).toBe(0.02 + 0.0025);
    expect(s.valueAt("f", 5)).toBeCloseTo(0.02 + 0.0025 + 5 * 0.4 * 0.001, 15);
  });
  it("beta carries the clipped value forward (decision 38): floor 0, index at 0, parent +25 bp, beta 0.5 gives 12.5 bp", () => {
    const steps = [0.03, 0.01, 0.0125];
    const path = new Stub((s) => steps[Math.min(s, 2)]!);
    const s = new IndexSeries(tableOf(P1, formula({ beta: 0.5, start: 0, floor: 0 })), path);
    expect([0, 1].map((t) => s.valueAt("f", t))).toEqual([0, 0]);
    expect(s.valueAt("f", 2)).toBeCloseTo(0.00125, 15);
  });
  it("Review Focus 1: a parallel shock reaches a beta index at month 0 and stays", () => {
    const base = rising();
    const table = tableOf(P1, formula({ beta: 0.4, start: 0.02, parentAtCutoff: 0.03 }));
    const shocked = new ParallelShockPath(base, 100);
    const b = new IndexSeries(table, base);
    const u = new IndexSeries(table, shocked);
    for (const t of [0, 1, 12, 120]) expect(u.valueAt("f", t) - b.valueAt("f", t)).toBeCloseTo(0.4 * 0.01, 14);
  });
  it("a constant-maturity-swap index reads the path's forward par swap rate at its tenor, plus its basis", () => {
    const s = new IndexSeries(tableOf({ id: "c10", label: "C", kind: "constant-maturity-swap", tenorYears: 10, basis: 0.002 }), rising());
    expect(s.valueAt("c10", 3)).toBeCloseTo(0.04 + 0.0003 + 0.01 + 0.002, 15);
  });
  it("memoizes: a beta chain three deep reads each base step once, whatever order the steps are asked in (Review Focus 2)", () => {
    const table = tableOf(P1, formula({ id: "f1", parent: "p1", beta: 0.5, start: 0.02 }), formula({ id: "f2", parent: "f1", beta: 0.5, start: 0.01, parentAtCutoff: 0.02 }));
    const down = rising();
    const a = new IndexSeries(table, down);
    const descending = [359, 200, 17, 0].map((t) => a.valueAt("f2", t));
    expect(down.reads).toBe(360);
    const up = rising();
    const b = new IndexSeries(table, up);
    const ascending = [0, 17, 200, 359].map((t) => b.valueAt("f2", t));
    expect(ascending.reverse().every((v, i) => Object.is(v, descending[i]))).toBe(true);
  });
  it("refuses a formula that reached it without parentAtCutoff", () => {
    const { parentAtCutoff: _drop, ...bare } = formula({ coefficient: 1 });
    void _drop;
    expect(() => new IndexSeries(tableOf(P1, bare), rising()).valueAt("f", 0)).toThrow(RateIndexUnanchoredError);
  });
  it("refuses a compounded window or a swap index that still names a derived curve, naming the index (an unfolded entry would miss its spread)", () => {
    const window: RateIndex = { id: "w3", label: "W", tenorMonths: 3, basis: 0.001, spreadCurve: "ust-sofr" };
    const swap: RateIndex = { id: "c10", label: "C", kind: "constant-maturity-swap", tenorYears: 10, basis: 0, spreadCurve: "flat-25" };
    const asWindow = () => new IndexSeries(tableOf(window), rising()).valueAt("w3", 0);
    const asSwap = () => new IndexSeries(tableOf(swap), rising()).valueAt("c10", 4);
    const asParent = () => new IndexSeries(tableOf(window, formula({ parent: "w3", coefficient: 1 })), rising()).valueAt("f", 0);
    for (const call of [asWindow, asParent]) {
      expect(call).toThrow(`rate index "w3" still names derived curve "ust-sofr"`);
      expect(call).not.toThrow(RateIndexUnanchoredError);
    }
    expect(asSwap).toThrow(`rate index "c10" still names derived curve "flat-25"`);
    // The folded entry (spread in the basis, no spreadCurve) reads: the three-month window compounds 0.030, 0.031, 0.032, plus 0.0035.
    const g = (1 + 0.03 / 12) * (1 + 0.031 / 12) * (1 + 0.032 / 12);
    expect(new IndexSeries(tableOf(foldedIndex(window as never, 0.0035)), rising()).valueAt("w3", 0)).toBeCloseTo(((g - 1) * 12) / 3 + 0.0035, 15);
  });
  it("seriesFor shares one series per table and path object, and no other", () => {
    const table = tableOf(P1);
    const p = rising();
    const first = seriesFor(table, p);
    for (let i = 0; i < 10; i++) seriesFor(table, rising());
    expect(seriesFor(table, p)).toBe(first);
    expect(seriesFor(table, rising())).not.toBe(first);
    expect(seriesFor(tableOf(P1), p)).not.toBe(first);
  });
});

describe("ResolvedIndexPath and IndexedFloatingLoan", () => {
  const terms: FloatingLoanTerms = {
    id: "F", type: "floating-loan", notional: 1_000_000, maturityMonths: 12, originationOffsetMonths: 0, amortType: "bullet",
    side: "asset", indexTenorMonths: 1, margin: 0.0125, resetFrequencyMonths: 1,
  };
  it("reads step 0 for a negative step and passes forwardRateAt, nSteps and times through", () => {
    const path = rising();
    const w = new ResolvedIndexPath(path, "f", tableOf(P1, formula({ coefficient: 1 })));
    expect(w.rateAt(-3)).toBe(w.rateAt(0));
    expect(w.forwardRateAt(2, 10)).toBe(path.forwardRateAt(2, 10));
    expect(w.nSteps).toBe(path.nSteps);
  });
  it("a coefficient-1, basis-0 formula gives the parent's cash flows bit for bit", () => {
    const path = rising();
    const table = tableOf(P1, formula({ coefficient: 1 }));
    const viaParent: Cashflow[] = new IndexedFloatingLoan(terms, P1, table).generateCashflows(path);
    const viaFormula: Cashflow[] = new IndexedFloatingLoan(terms, table.get("f")!, table).generateCashflows(path);
    expect(JSON.stringify(viaFormula)).toBe(JSON.stringify(viaParent));
  });
  it("a beta floater's month-1 coupon is start + basis + margin", () => {
    const table = tableOf(P1, formula({ beta: 0.4, start: 0.0433 }));
    expect(new IndexedFloatingLoan(terms, table.get("f")!, table).generateCashflows(rising())[0]!.couponRate).toBeCloseTo(0.0433 + 0.0125, 15);
  });
});
