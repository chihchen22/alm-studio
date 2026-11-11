/**
 * IndexRatePath: a RatePath whose reset rate is a
 * named index over the wrapped path. Engine-side; the kernel is untouched.
 *
 * The kernel FloatingLoan reads rateAt(step) on reset months and nothing else.
 * This wrapper answers rateAt with the index reset
 *
 *   I_n(s) = (12 / n) * [ prod_{k=0}^{n-1} (1 + r(s + k) / 12) - 1 ] + b
 *
 * where r is the wrapped path's own one-month rate, n the tenor in months and b
 * the basis (a decimal). Two readings of it:
 *
 *  - On a deterministic path r(s) = (DF(t) / DF(t + 1/12) - 1) * 12, so the
 *    product telescopes to DF(t) / DF(t + n/12) and I_n(s) - b is the curve's
 *    simple forward over the tenor.
 *  - On a stochastic path the product compounds the path's own one-month resets
 *    over the tenor, in arrears. It is not the analytic Hull-White forward.
 *
 * For tenor 1 and basis 0 the wrapped rate is returned unchanged, so the
 * identity with the unindexed floater is exact (Object.is). The basis is a
 * constant: it does not move with rates inside a run. forwardRateAt passes
 * through to the wrapped path (the quoted basis; no kernel floater reads it
 * here), and nSteps and times come from the wrapped path. Steps past the end
 * follow the wrapped path's own clamping.
 */
import type { RatePath } from "@alm/kernel";
import type { CompoundedWindowIndex } from "../contracts/rateIndex";

export class IndexRatePath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly tenorMonths: number;
  private readonly basis: number;

  constructor(
    private readonly base: RatePath,
    index: Pick<CompoundedWindowIndex, "tenorMonths" | "basis">,
  ) {
    this.nSteps = base.nSteps;
    this.times = base.times;
    this.tenorMonths = index.tenorMonths;
    this.basis = index.basis;
  }

  rateAt(step: number): number {
    let f: number;
    if (this.tenorMonths === 1) {
      f = this.base.rateAt(step);
    } else {
      let g = 1;
      for (let k = 0; k < this.tenorMonths; k++) g *= 1 + this.base.rateAt(step + k) / 12;
      f = ((g - 1) * 12) / this.tenorMonths;
    }
    return this.basis === 0 ? f : f + this.basis;
  }

  forwardRateAt(step: number, tenorYears: number): number {
    return this.base.forwardRateAt(step, tenorYears);
  }
}
