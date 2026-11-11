/**
 * The forward-start views a new-volume tranche reads. Engine-side; the kernel is
 * untouched.
 *
 * Kernel instruments start at their own month zero and ignore `originationOffsetMonths`: a floater's month m reads
 * `path.rateAt(m - 1)`. The reinvestment sweep books a tranche minted at bucket k so that its month m lands in bucket
 * k + m - 1, so the rate that month carries on the scenario's path is step k + m - 1. Handing the tranche the scenario
 * path itself would make it read step m - 1: right for a fixed bullet (no later rate is read), silently wrong for a
 * floater or anything that reads the path after origination. ForwardStartPath shifts every step by k, so the tranche's
 * own step s is the scenario's step s + k.
 *
 * forwardStartCurve is the same shift on a zero curve, for pricing a tranche at its origination: the discount factor
 * the tranche sees for time t is the scenario curve's forward discount factor from t0 = k / 12 to t0 + t.
 */
import { beyForwardFromDf, parForwardFromDf, type RatePath, type ZeroCurve } from "@alm/kernel";

/** A RatePath whose step s is the wrapped path's step s + offset. */
export class ForwardStartPath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;

  constructor(
    private readonly base: RatePath,
    /** The origination step: a whole number of months, 0 or more. */
    readonly offset: number,
  ) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`ForwardStartPath: offset must be a whole number of months from 0, got ${offset}`);
    this.nSteps = Math.max(0, base.nSteps - offset);
    const t0 = base.times[offset] ?? offset / 12;
    const times = new Array<number>(this.nSteps + 1);
    for (let s = 0; s <= this.nSteps; s++) times[s] = (base.times[s + offset] ?? (s + offset) / 12) - t0;
    this.times = times;
  }

  rateAt(step: number): number {
    return this.base.rateAt(step + this.offset);
  }

  forwardRateAt(step: number, tenorYears: number): number {
    return this.base.forwardRateAt(step + this.offset, tenorYears);
  }
}

/**
 * The zero curve as seen from time t0 (years): P'(t) = P(t0 + t) / P(t0). Forwards are the wrapped curve's forwards
 * over the shifted window; the swap and bond-equivalent forwards are the kernel's own formulas on P'. The node arrays
 * are the wrapped curve's nodes after t0, re-expressed as continuously compounded zero rates of P'.
 */
export function forwardStartCurve(curve: ZeroCurve, t0: number): ZeroCurve {
  if (!(t0 >= 0) || !Number.isFinite(t0)) throw new Error(`forwardStartCurve: t0 must be a finite time from 0, got ${t0}`);
  if (t0 === 0) return curve;
  const p0 = curve.discountFactor(t0);
  const df = (t: number): number => (t <= 0 ? 1 : curve.discountFactor(t0 + t) / p0);
  const t: number[] = [];
  const z: number[] = [];
  for (const node of curve.t) {
    if (node <= t0) continue;
    const u = node - t0;
    t.push(u);
    z.push(-Math.log(df(u)) / u);
  }
  return {
    t,
    z,
    convention: curve.convention,
    zeroRate(time: number): number {
      if (time <= 0) return curve.forwardRate(t0, t0 + 1 / 365);
      return -Math.log(df(time)) / time;
    },
    discountFactor: df,
    forwardRate(t1: number, t2: number): number {
      return curve.forwardRate(t0 + t1, t0 + t2);
    },
    forwardRateBey(t1: number, t2: number): number {
      return beyForwardFromDf(df, t1, t2, curve.convention);
    },
    forwardSwapRate(t1: number, t2: number): number {
      return parForwardFromDf(df, t1, t2, curve.convention);
    },
  };
}
