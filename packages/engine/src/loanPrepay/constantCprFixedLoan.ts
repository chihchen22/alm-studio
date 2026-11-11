/**
 * A level-pay fixed-rate loan that prepays at a constant CPR: the
 * build v8's `ConstantCPRFixedLoan`, on the frozen kernel's own pieces. No amortisation arithmetic is new: the cash
 * flows are the kernel's `amortizeMortgage` driver run on the kernel's `ConstantCPR` schedule. Each month m:
 *
 *   scheduled   = B(m-1) x c / ((1 + c)^n(m) - 1), the principal share of the level payment on the remaining term
 *   SMM         = 1 - (1 - CPR)^(1/12)
 *   prepaid     = SMM x (B(m-1) - scheduled), on the balance left after scheduled principal
 *   interest    = B(m-1) x c
 *
 * with c the coupon over 12 and n(m) the months left. The payment re-amortises on the surviving balance. The CPR is
 * constant from month 1, with no seasoning ramp, and no rate path moves it, so the path argument is not read.
 *
 * The class extends the kernel FixedLoan, so every reader that dispatches on the instrument (the kernel's
 * replacement-vintage rule among them) sees a fixed loan. Its terms carry the engine-side `prepay` group, and a
 * vintage built from them by the kernel copies that group, so `vintageOf` rebuilds the vintage at the parent's CPR:
 * a replaced dollar prepays like the book it replaces, as the build's `_make_vintage_v6` does.
 *
 * Level-pay only. The overlay merge refuses a bullet (applyOverlays.ts), as the build's constructor does.
 */
import {
  ConstantCPR,
  FixedLoan,
  NMDBeta,
  NMDeposit,
  amortizeMortgage,
  type Cashflow,
  type Instrument,
  type NMDBetaTerms,
  type NMDTerms,
  type RatePath,
} from "@alm/kernel";
import type { EngineFixedLoanTerms, FixedLoanPrepay } from "../contracts/position";

/** Fixed-loan terms that carry a prepay group. */
export type PrepayingFixedLoanTerms = EngineFixedLoanTerms & { prepay: FixedLoanPrepay };

/** True when fixed-loan terms carry the engine-side prepay group. */
export function hasLoanPrepay(terms: EngineFixedLoanTerms): terms is PrepayingFixedLoanTerms {
  return terms.prepay !== undefined;
}

export class ConstantCprFixedLoan extends FixedLoan {
  declare readonly terms: PrepayingFixedLoanTerms;

  constructor(terms: PrepayingFixedLoanTerms) {
    super(terms);
    if (terms.amortType !== "level-pay") {
      throw new Error(`ConstantCprFixedLoan: position "${terms.id}" is ${terms.amortType}; a constant CPR applies to a level-pay loan only`);
    }
  }

  /** The annual CPR the cash flows run at. */
  get annualCpr(): number {
    return this.terms.prepay.annualCpr;
  }

  override generateCashflows(_path?: RatePath): Cashflow[] {
    const { notional, maturityMonths, coupon } = this.terms;
    const cprSchedule = new ConstantCPR(this.annualCpr).cprSchedule({
      term: maturityMonths,
      age: 0,
      noteRate: coupon,
      mortgageRateAt: () => 0,
    });
    return amortizeMortgage({ notional, noteRate: coupon, term: maturityMonths, cprSchedule });
  }

  /**
   * The same loan at its liquidity stress speed: `stressAnnualCpr` when the terms carry one, else this loan's own
   * CPR. The moderate and severe rows of the liquidity stress ladder read this one.
   */
  atStress(): ConstantCprFixedLoan {
    const { annualCpr, stressAnnualCpr } = this.terms.prepay;
    const cpr = stressAnnualCpr ?? annualCpr;
    return new ConstantCprFixedLoan({ ...this.terms, prepay: { annualCpr: cpr, stressAnnualCpr: cpr } });
  }
}

/**
 * The replacement vintage at the parent's CPR: the kernel vintage, rebuilt as a ConstantCprFixedLoan from its own
 * terms (which carry the parent's prepay group) when the parent prepays; any other vintage is returned untouched.
 */
export function vintageOf(parent: Instrument, vintage: Instrument, depositHistory?: readonly number[]): Instrument {
  if (parent instanceof ConstantCprFixedLoan) return new ConstantCprFixedLoan(vintage.terms as PrepayingFixedLoanTerms);
  // A kernel deposit's vintage, rebuilt on the history the run built its parent on. The
  // kernel's makeVintage builds it from terms only, so it would read the kernel's own warmup series.
  if (depositHistory !== undefined && isKernelDeposit(parent)) {
    if (vintage instanceof NMDBeta) return new NMDBeta(vintage.terms as NMDBetaTerms, depositHistory);
    if (vintage instanceof NMDeposit) return new NMDeposit(vintage.terms as NMDTerms, depositHistory);
  }
  return vintage;
}

/**
 * True for a plain kernel deposit (NMDeposit or NMDBeta itself, not an engine subclass): the deposits whose SEG
 * vintages the kernel builds as the same class from terms only. The engine's own deposit forms are refused beside SEG
 * or carry their own rules, so they are left as they are.
 */
export function isKernelDeposit(instrument: Instrument): boolean {
  return instrument.constructor === NMDeposit || instrument.constructor === NMDBeta;
}
