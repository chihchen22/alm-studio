/**
 * The values of the B3a index kinds on one rate path (v3 Section 5 rule 2). One IndexSeries per
 * (run table, path) holds one array per index id, filled forward from step 0, so each index is evaluated once per
 * path in dependency order and a beta index is computed month by month from its start. Values are pure functions
 * of the path and the table, so the order steps are asked in, the shard a position lands in and the stage that asks
 * cannot change a bit.
 *
 *   compounded window   IndexRatePath over the path (the reader a floater on that index uses, unchanged)
 *   constant-maturity   path.forwardRateAt(t, tenorYears) + basis (the folded basis carries any derived spread)
 *   formula, level      clip(coefficient x Q(t) + basis)
 *   formula, beta       v(0) = clip(start + basis + beta x (Q(0) - Q(-1))); v(t) = clip(v(t-1) + beta x (Q(t) - Q(t-1)))
 *
 * where Q(u) = parent(u - lag) for u - lag >= 0 and parentAtCutoff before the cut-off: the parent's month-0 value
 * on the run's unshocked curve, so a shocked path's move at month 0 enters as a change (ruling 2026-10-13, which amends decision 40). Step B3b: where the formula's entry carries parentBeforeCutoff (a
 * lagged formula whose parent carries an index history), Q(u) for u < 0 reads it in place of the anchor (spec v6
 * decision 52); month 0 of the beta form keeps the anchor for every u < 0, so history enters it from month 1 (B3b
 * ruling D1). clip applies the floor, then the cap; a beta index carries the
 * clipped value forward (decision 38). A compounded window or a swap index that still names a derived curve is
 * refused: the run entry folds the spread into the basis of every index it reads, so an unfolded entry means a
 * table that did not come through it.
 */
import type { RatePath } from "@alm/kernel";
import type { AnchoredFormulaIndex, FormulaIndex, RateIndex, RateIndexTable } from "../contracts/rateIndex";
import { IndexRatePath } from "./indexRatePath";

/** A formula index reached an evaluator without the value the run entry fixes; a call site was not threaded. */
export class RateIndexUnanchoredError extends Error {
  readonly rateIndexId: string;
  constructor(rateIndexId: string) {
    super(
      `rate index ${JSON.stringify(rateIndexId)} is a formula without its parent's value at the cut-off; ` +
        "a run's table comes from checkRateIndexRefs or resolveRunRateIndices, which fix it",
    );
    this.name = "RateIndexUnanchoredError";
    this.rateIndexId = rateIndexId;
  }
}

const clip = (e: FormulaIndex, x: number): number => (e.floor !== undefined && x < e.floor ? e.floor : e.cap !== undefined && x > e.cap ? e.cap : x);

export class IndexSeries {
  private readonly memo = new Map<string, number[]>();
  private readonly windows = new Map<string, IndexRatePath>();

  constructor(
    private readonly table: RateIndexTable,
    private readonly path: RatePath,
  ) {}

  /** The index's value at a whole step of at least 0. */
  valueAt(id: string, step: number): number {
    let s = this.memo.get(id);
    if (s === undefined) {
      s = [];
      this.memo.set(id, s);
    }
    if (step < s.length) return s[step]!;
    const e = this.table.get(id);
    if (e === undefined) throw new Error(`rate index ${JSON.stringify(id)} is not in the run's table`);
    // The run entry folds every index the run reads; an entry still naming a curve would silently miss its spread.
    if (e.kind !== "formula" && e.spreadCurve !== undefined) {
      throw new Error(
        `rate index ${JSON.stringify(id)} still names derived curve ${JSON.stringify(e.spreadCurve)}, so its spread is not in its basis; ` +
          "a run's table comes from checkRateIndexRefs or resolveRunRateIndices, which fold it",
      );
    }
    while (s.length <= step) s.push(this.next(e, s));
    return s[step]!;
  }

  private next(e: RateIndex, s: readonly number[]): number {
    const t = s.length;
    if (e.kind === "constant-maturity-swap") return this.path.forwardRateAt(t, e.tenorYears) + e.basis;
    if (e.kind !== "formula") {
      let w = this.windows.get(e.id);
      if (w === undefined) {
        w = new IndexRatePath(this.path, e);
        this.windows.set(e.id, w);
      }
      return w.rateAt(t);
    }
    // The months before the cut-off read the unshocked anchor, or the parent's history where it has
    // a value: parentBeforeCutoff[k - 1] is month -k, resolved once at the run entry.
    const anchor = (e as Partial<AnchoredFormulaIndex>).parentAtCutoff;
    if (anchor === undefined) throw new RateIndexUnanchoredError(e.id);
    const pre = (e as Partial<AnchoredFormulaIndex>).parentBeforeCutoff;
    const lag = e.lagMonths ?? 0;
    const q = (u: number): number => (u < 0 ? (pre?.[-u - 1] ?? anchor) : this.valueAt(e.parent, u));
    if (e.beta === undefined) return clip(e, e.coefficient! * q(t - lag) + e.basis);
    // Month 0 of the change form measures the change from the unshocked cut-off value only: the start is the fixing at
    // the cut-off, so a history change read there would count twice (B3b ruling D1). History enters from month 1.
    const q0 = (u: number): number => (u < 0 ? anchor : this.valueAt(e.parent, u));
    const r = t === 0 ? q0 : q;
    const before = t === 0 ? e.start! + e.basis : s[t - 1]!;
    return clip(e, before + e.beta * (r(t - lag) - r(t - 1 - lag)));
  }
}

/**
 * One series per (run table, path object): every position of a scenario, every path of a stochastic loop and the
 * base, up and down legs of effective duration (three interleaved paths) share one. Both keys are object identities
 * held weakly, so a hit needs the same table and the same path object, a stale value cannot reach another run or
 * another leg, and no series outlives its path.
 */
const seriesCache = new WeakMap<RateIndexTable, WeakMap<RatePath, IndexSeries>>();

export function seriesFor(table: RateIndexTable, path: RatePath): IndexSeries {
  let byPath = seriesCache.get(table);
  if (byPath === undefined) {
    byPath = new WeakMap<RatePath, IndexSeries>();
    seriesCache.set(table, byPath);
  }
  let series = byPath.get(path);
  if (series === undefined) {
    series = new IndexSeries(table, path);
    byPath.set(path, series);
  }
  return series;
}

/** The RatePath a kernel floater reads for a constant-maturity-swap or formula index. */
export class ResolvedIndexPath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly series: IndexSeries;

  constructor(
    private readonly base: RatePath,
    private readonly id: string,
    table: RateIndexTable,
  ) {
    this.nSteps = base.nSteps;
    this.times = base.times;
    this.series = seriesFor(table, base);
  }

  /** A negative step reads step 0: the index code clamps, since the deterministic path does not (ratePath.ts:36-43). */
  rateAt(step: number): number {
    return this.series.valueAt(this.id, step < 0 ? 0 : step);
  }

  forwardRateAt(step: number, tenorYears: number): number {
    return this.base.forwardRateAt(step, tenorYears);
  }
}
