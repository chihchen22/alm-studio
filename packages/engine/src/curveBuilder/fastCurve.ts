/**
 * Engine-side fast curve.
 *
 * The kernel's curve factory reads a zero rate through a linear scan of the
 * nodes. On the kernel's own 11 quote nodes that is cheap; on the 360 dense
 * monthly nodes a log-linear-df, cubic-zero or monotone-convex setup writes,
 * the Hull-White term forward's discount-factor reads made a whole run 4x to
 * 6.5x slower (Task 7b measurement). The maintainer ruled (2026-10-12) to fix it on
 * the engine side with the kernel untouched: ZeroCurve is a structural
 * interface, so the engine supplies its own object.
 *
 * makeFastCurve reproduces the kernel factory BIT FOR BIT. Same lerp
 * semantics: no nodes read 0; at or before the first node the first zero; at
 * or after the last node the last zero; inside, the FIRST interval i with
 * x <= t[i+1], weighted w = (x - t[i]) / (t[i+1] - t[i]) and read
 * z[i]*(1-w) + z[i+1]*w. Only the search differs: a lower-bound binary search
 * for the first node at or above x, which on ascending nodes is the same
 * interval the kernel's scan stops at, ties at an exact node included. The
 * other reads are the kernel's expressions verbatim, through `this` as the
 * kernel's are, and the quoted forwards go through the kernel's exported
 * beyForwardFromDf and parForwardFromDf.
 *
 * isFastCurve marks the objects this factory made (a WeakSet), so the shock
 * code can keep a fast base fast and leave a kernel base on the kernel.
 */
import { beyForwardFromDf, parForwardFromDf, shockCurve } from "@alm/kernel";
import type { CurveConvention, ZeroCurve } from "@alm/kernel";

const fastCurves = new WeakSet<ZeroCurve>();

/** The kernel's lerp, with the interval found by binary search. */
function lerp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  // A NaN x matches no interval and falls through to the last zero, as the
  // kernel's scan does.
  if (x !== x) return ys[n - 1];
  // First k in [1, n-1] with xs[k] >= x; it exists because x < xs[n-1].
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] >= x) hi = mid;
    else lo = mid + 1;
  }
  const i = lo - 1;
  const x0 = xs[i];
  const w = (x - x0) / (xs[lo] - x0);
  return ys[i] * (1 - w) + ys[lo] * w;
}

/** A ZeroCurve over (t, z) that reads like the kernel's, in logarithmic time. */
export function makeFastCurve(t: number[], z: number[], convention: CurveConvention): ZeroCurve {
  const curve: ZeroCurve = {
    t,
    z,
    convention,
    zeroRate(time: number): number {
      return lerp(t, z, time);
    },
    discountFactor(time: number): number {
      return Math.exp(-this.zeroRate(time) * time);
    },
    forwardRate(t1: number, t2: number): number {
      if (t2 <= t1) {
        throw new Error(`forwardRate: t2=${t2} must exceed t1=${t1}`);
      }
      return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / (t2 - t1);
    },
    forwardRateBey(t1: number, t2: number): number {
      return beyForwardFromDf((u) => this.discountFactor(u), t1, t2, convention);
    },
    forwardSwapRate(t1: number, t2: number): number {
      return parForwardFromDf((u) => this.discountFactor(u), t1, t2, convention);
    },
  };
  fastCurves.add(curve);
  return curve;
}

/** True for a curve made by makeFastCurve. */
export function isFastCurve(curve: ZeroCurve): boolean {
  return fastCurves.has(curve);
}

/**
 * Parallel shift by shockBp basis points. A fast curve shifts to a fast curve
 * with the kernel shockCurve's arithmetic (every zero plus shockBp / 1e4, the
 * nodes copied); any other curve goes to the kernel shockCurve unchanged.
 */
export function shiftCurveParallel(curve: ZeroCurve, shockBp: number): ZeroCurve {
  if (!isFastCurve(curve)) return shockCurve(curve, shockBp);
  const s = shockBp / 1e4;
  return makeFastCurve([...curve.t], curve.z.map((v) => v + s), curve.convention);
}
