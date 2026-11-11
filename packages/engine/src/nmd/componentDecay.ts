/**
 * The component decay form of a non-maturity deposit: the component projection
 * form on a dated monthly rate path, built engine-side beside the frozen kernel deposit.
 *
 *   B(t) = B(0) x prod_{s=1..t} g_s,   g_s = R x (1 + mu0 + phi x x_s)
 *   x_s  = max(0, r_s + shift - rbar_s),   rbar_s the mean of the `lookbackMonths` realized month-ends before month s
 *
 * Projection month s reads month s of the dated window. The scenario's level shift is added to the window months only:
 * rbar_s is always the mean of the realized series, so a shift moves the level and not the benchmark. Past the window the driver holds its last window value, so every later month decays by the one factor
 * q = g at the window's last month, and the balance beyond the run's horizon is a geometric series with a closed form.
 *
 * The static bifurcation (`staticShare`): that share of the book runs off on the frozen base schedule (shift 0) in
 * every scenario and the rest leaves overnight. On the monthly grid the overnight cash falls in month 1.
 *
 * The cash flows follow the kernel deposit's convention: each month's balance is the opening balance, its principal is
 * the month's runoff, and the remaining balance leaves at maturity. The deposit pays its terms' `depositRate` on the
 * opening balance; the form prices volume, not the paid rate, so a book on it carries 0 and the run refuses the
 * NII block (componentDecayRun.ts).
 *
 * The WAL readout (`walCorrection`): the family WAL the run stamps is in-horizon, with the remainder at maturity. For a
 * component decay deposit the run adds this deposit's exact runoff past the horizon (the driver held flat, so the
 * tail is geometric) and, for the static bifurcation, counts the overnight remainder at zero life, so the WAL reads
 * the runoff in full. On the 360-month grid, with the remainder at month 360, the tail moves a deposit's WAL by a
 * few thousandths of a year.
 *
 * The class extends the kernel NMDeposit, so every reader that dispatches on the instrument sees an nmd.
 */
import { NMDeposit, type Cashflow, type RatePath } from "@alm/kernel";
import type { ComponentDecayForm, EngineNMDTerms } from "../contracts/position";
import { componentDecayIssues, monthsBetween } from "../contracts/paramSchema";

/** nmd terms that carry the component decay form. */
export type ComponentDecayTerms = EngineNMDTerms & { componentDecay: ComponentDecayForm };

/** True when nmd terms carry the engine-side component decay form. */
export function hasComponentDecay(terms: EngineNMDTerms): terms is ComponentDecayTerms {
  return terms.componentDecay !== undefined;
}

/** The dated window's length in months. */
export function windowMonths(form: ComponentDecayForm): number {
  return monthsBetween(form.window.firstMonth, form.window.lastMonth) + 1;
}

/** The trailing benchmark of each window month, percent: the mean of the realized month-ends before it. */
export function benchmarksPct(form: ComponentDecayForm): number[] {
  const start = monthsBetween(form.series.firstMonth, form.window.firstMonth);
  const out: number[] = [];
  for (let j = 0; j < windowMonths(form); j++) {
    let sum = 0;
    for (let k = start + j - form.lookbackMonths; k < start + j; k++) sum += form.series.valuesPct[k]!;
    out.push(sum / form.lookbackMonths);
  }
  return out;
}

/** The one-sided driver x_s of each window month, percent, with the level shifted by `shiftPct` in the window only. */
export function driverPct(form: ComponentDecayForm, shiftPct: number): number[] {
  const start = monthsBetween(form.series.firstMonth, form.window.firstMonth);
  return benchmarksPct(form).map((bench, j) => Math.max(0, form.series.valuesPct[start + j]! + shiftPct - bench));
}

/** The monthly survival factor g_s of each window month. The months past the window repeat the last one. */
export function monthlyFactors(form: ComponentDecayForm, shiftPct: number): number[] {
  return driverPct(form, shiftPct).map((x) => form.retention * (1 + form.drift + form.coefficientPerPp * x));
}

function refuse(terms: EngineNMDTerms, detail: string): never {
  throw new Error(`ComponentDecayDeposit: position "${terms.id}" ${detail}`);
}

/** A correction the WAL readout adds to a family's in-horizon fold: dollars of principal and dollar-years. */
export interface WalCorrection {
  principal: number;
  dollarYears: number;
}

export class ComponentDecayDeposit extends NMDeposit {
  declare readonly terms: ComponentDecayTerms;
  /** The scenario's level shift, percent; the static bifurcation reads the base schedule whatever it is. */
  readonly shiftPct: number;
  /** g_1..g_W of the schedule this deposit runs on. */
  private readonly factors: number[];

  constructor(terms: ComponentDecayTerms, shiftPct = 0) {
    super(terms);
    const issue = componentDecayIssues(terms.componentDecay)[0];
    if (issue !== undefined) refuse(terms, `${issue.path} ${issue.message}`);
    if (!Number.isFinite(shiftPct)) refuse(terms, `scenario shift must be a finite percent, got ${String(shiftPct)}`);
    this.shiftPct = shiftPct;
    this.factors = monthlyFactors(terms.componentDecay, terms.componentDecay.staticShare === undefined ? shiftPct : 0);
    if (this.factors.some((g) => !(g > 0))) refuse(terms, "has a monthly survival factor at or below zero on its dated path");
    const q = this.factors[this.factors.length - 1]!;
    if (!(q < 1)) refuse(terms, `holds the driver past the window at a survival factor of ${q}, which never runs the book off`);
  }

  /** g for projection month m (1-based): the window month, or the last window month past the window. */
  private factorAt(m: number): number {
    return this.factors[Math.min(m, this.factors.length) - 1]!;
  }

  /** The survival S(0..n) of the schedule: S(0) = 1, S(t) = prod of g over months 1 to t. */
  survival(n: number): number[] {
    const out = [1];
    for (let m = 1; m <= n; m++) out.push(out[m - 1]! * this.factorAt(m));
    return out;
  }

  /** The opening balance of each month 1..N and the balance after month N (the kernel reader's deposit shape). */
  balances(): number[] {
    const { notional, maturityMonths, componentDecay: form } = this.terms;
    const s = this.survival(maturityMonths);
    if (form.staticShare === undefined) return s.map((v) => notional * v);
    // The overnight remainder is on the book at the as-of and gone after month 1.
    return s.map((v, t) => (t === 0 ? notional : notional * form.staticShare! * v));
  }

  override simulateBook(_path?: RatePath): ReturnType<NMDeposit["simulateBook"]> {
    return refuse(this.terms, "carries the component decay form, which has no account-size buckets");
  }

  override generateCashflows(_path?: RatePath): Cashflow[] {
    const { maturityMonths, depositRate } = this.terms;
    const b = this.balances();
    const out: Cashflow[] = [];
    for (let m = 1; m <= maturityMonths; m++) {
      const opening = b[m - 1]!;
      out.push({
        monthOffset: m,
        balance: opening,
        principalPaid: m === maturityMonths ? opening : opening - b[m]!,
        interestPaid: (opening * depositRate) / 12,
        couponRate: depositRate,
      });
    }
    return out;
  }

  /**
   * Dollar-months of the runoff after month `t0` from the balance there: the window months one by one, then the
   * geometric tail at q, sum over k >= 0 of (m + k) b q^k (1 - q) = b (m + q / (1 - q)), m the first month after both.
   */
  private dollarMonthsAfter(t0: number, balance: number): number {
    let b = balance;
    let sum = 0;
    let m = t0 + 1;
    for (; m <= this.factors.length; m++) {
      const next = b * this.factorAt(m);
      sum += m * (b - next);
      b = next;
    }
    const q = this.factors[this.factors.length - 1]!;
    return sum + b * (m + q / (1 - q));
  }

  /**
   * The life, in months, of this deposit's schedule run off in full: the WAL of a unit balance
   * on it, the window months one by one and the geometric tail past them. On the static bifurcation the schedule is
   * the frozen base one, so this is the life of its stable share (the overnight remainder is not in it). The
   * replicating-portfolio credit caps its rate portfolio and reads its liquidity premium at this life.
   */
  fullRunoffLifeMonths(): number {
    return this.dollarMonthsAfter(0, 1);
  }

  /**
   * What the WAL readout adds to this deposit's in-horizon fold on a grid of `horizonMonths`, so the family WAL reads
   * the full runoff. On a grid that holds the maturity, the remainder already leaves there: the correction swaps it for
   * its runoff past maturity. On a shorter grid it adds the balance at the horizon and its whole runoff. The static
   * bifurcation also moves its overnight remainder from month 1 to zero life.
   */
  walCorrection(horizonMonths: number): WalCorrection {
    const { notional, maturityMonths, componentDecay: form } = this.terms;
    const share = form.staticShare ?? 1;
    const s = this.survival(Math.min(horizonMonths, maturityMonths));
    let principal: number;
    let dollarMonths: number;
    if (horizonMonths >= maturityMonths) {
      const left = notional * share * s[maturityMonths - 1]!;
      principal = 0;
      dollarMonths = this.dollarMonthsAfter(maturityMonths - 1, left) - maturityMonths * left;
    } else {
      const left = notional * share * s[horizonMonths]!;
      principal = left;
      dollarMonths = this.dollarMonthsAfter(horizonMonths, left);
    }
    if (form.staticShare !== undefined) dollarMonths -= notional * (1 - share);
    return { principal, dollarYears: dollarMonths / 12 };
  }
}
