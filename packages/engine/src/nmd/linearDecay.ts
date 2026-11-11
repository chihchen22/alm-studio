/**
 * The linear decay deposit: a teaching deposit, built engine-side beside the frozen
 * kernel deposit. Its balance falls by the same amount every month and is gone after n months:
 *
 *   B(t) = B(0) x max(0, 1 - t / n),   t = 0, 1, ..., n
 *
 * so B(t) is the month-end balance after t months, and its life on the monthly grid is (n + 1) / 2 months (one n-th of
 * the book leaves at the end of each month 1 to n). The deposit's repricing beta is its terms' `beta`, which the
 * kernel's readers already read: the beta share reprices at the next reset and the rest is rate-locked for as long as
 * it stays.
 *
 * The cash flows follow the kernel deposit's convention: each month's balance is the opening balance, its principal
 * the month's runoff, and the interest the terms' `depositRate` on the opening balance. The class extends the kernel
 * NMDeposit, so every reader that dispatches on the instrument sees an nmd.
 */
import { NMDeposit, type Cashflow, type RatePath } from "@alm/kernel";
import type { EngineNMDTerms, LinearDecayForm } from "../contracts/position";
import { linearDecayIssues } from "../contracts/paramSchema";

/** nmd terms that carry a linear decay. */
export type LinearDecayTerms = EngineNMDTerms & { linearDecay: LinearDecayForm };

/** True when nmd terms carry the engine-side linear decay. */
export function hasLinearDecay(terms: EngineNMDTerms): terms is LinearDecayTerms {
  return terms.linearDecay !== undefined;
}

/** The month-end balance of a straight-line runoff of `notional` over `months`, after `t` months: the book less t steps. */
export function linearBalance(notional: number, months: number, t: number): number {
  return t >= months ? 0 : notional - (notional / months) * t;
}

export class LinearDecayDeposit extends NMDeposit {
  declare readonly terms: LinearDecayTerms;

  constructor(terms: LinearDecayTerms) {
    super(terms);
    const issue = linearDecayIssues(terms.linearDecay, terms.maturityMonths)[0];
    if (issue !== undefined) throw new Error(`LinearDecayDeposit: position "${terms.id}" ${issue.path} ${issue.message}`);
    if (terms.componentDecay !== undefined) throw new Error(`LinearDecayDeposit: position "${terms.id}" also carries a component decay form`);
  }

  /** n, the months the runoff takes. */
  get horizonMonths(): number {
    return this.terms.linearDecay.horizonMonths;
  }

  /** The month-end balances B(0..n): B(0) is the book at the as-of, B(n) is 0. */
  balances(): number[] {
    const n = this.horizonMonths;
    return Array.from({ length: n + 1 }, (_, t) => linearBalance(this.terms.notional, n, t));
  }

  /** The runoff's life in months on the monthly grid: (n + 1) / 2. */
  lifeMonths(): number {
    return (this.horizonMonths + 1) / 2;
  }

  override simulateBook(_path?: RatePath): ReturnType<NMDeposit["simulateBook"]> {
    throw new Error(`LinearDecayDeposit: position "${this.terms.id}" carries a linear decay, which has no account-size buckets`);
  }

  override generateCashflows(_path?: RatePath): Cashflow[] {
    const { depositRate } = this.terms;
    const b = this.balances();
    const out: Cashflow[] = [];
    for (let m = 1; m < b.length; m++) {
      const opening = b[m - 1]!;
      out.push({
        monthOffset: m,
        balance: opening,
        // One step a month, so every month but the last books the same principal; the last books what is left.
        principalPaid: m < b.length - 1 ? this.terms.notional / this.horizonMonths : opening,
        interestPaid: (opening * depositRate) / 12,
        couponRate: depositRate,
      });
    }
    return out;
  }
}
