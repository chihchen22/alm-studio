/**
 * The two-leg swap.
 *
 * `SwapInstrument` exposes the kernel `Instrument` method surface over a plain
 * vanilla swap: two kernel bullet legs on one notional, a `FixedLoan` and a
 * `FloatingLoan` on 1M SOFR. No numeric logic of its own: the kernel legs do
 * every coupon, and this file only signs and tags their rows.
 *
 * ROWS ARE SIGNED HERE, AT EMISSION. Receive leg positive, pay leg negative,
 * on `balance`, `principalPaid` and `interestPaid`; `couponRate` stays the
 * leg's own unsigned rate. The engine's hot loop folds those three fields and
 * never reads a tag, so signing here makes a swap family's series the NET swap
 * without a hot-loop change. The `leg` tag is for the two consumers that hold
 * the instrument and need each leg's repricing date: the gap fold and the
 * single-instrument drill.
 *
 * The two bullet principals cancel in value in the same month. They exist so
 * the repricing ladder sees the fixed leg reprice at maturity and the floating
 * leg at its next reset. They are never cash; the liquidity ladder ignores
 * them (../gap/gapEngine.ts).
 *
 * ROW ORDER IS FIXED: fixed leg first, then floating leg, whatever the
 * direction. That makes a pay-fixed swap's rows the exact IEEE negation of the
 * same receive-fixed swap's rows, row for row, which is what lets an offset
 * pair in two families net to exactly zero (invariant 2).
 */
import {
  FixedLoan,
  FloatingLoan,
  type Cashflow,
  type Instrument,
  type RatePath,
} from "@alm/kernel";
import { validateSwapTerms, type SwapTerms } from "./terms";

export type SwapLeg = "receive" | "pay";

/** A kernel Cashflow tagged with its leg. Money fields are signed: receive positive, pay negative. */
export interface SwapCashflow extends Cashflow {
  leg: SwapLeg;
}

export class SwapInstrument {
  readonly terms: SwapTerms;
  readonly fixed: FixedLoan;
  readonly floating: FloatingLoan;
  /** The fixed leg's direction for the bank: "pay" on a pay-fixed swap. */
  readonly fixedLeg: SwapLeg;
  /** The floating leg's direction for the bank: "receive" on a pay-fixed swap. */
  readonly floatingLeg: SwapLeg;

  constructor(terms: SwapTerms) {
    validateSwapTerms(terms);
    this.terms = terms;
    this.fixed = new FixedLoan({
      id: `${terms.id}~fixed`,
      type: "fixed-loan",
      notional: terms.notional,
      maturityMonths: terms.maturityMonths,
      originationOffsetMonths: 0,
      amortType: "bullet",
      coupon: terms.fixedRate,
    });
    this.floating = new FloatingLoan({
      id: `${terms.id}~float`,
      type: "floating-loan",
      notional: terms.notional,
      maturityMonths: terms.maturityMonths,
      originationOffsetMonths: 0,
      amortType: "bullet",
      indexTenorMonths: 1,
      margin: terms.floatMargin ?? 0,
      resetFrequencyMonths: terms.resetFrequencyMonths ?? 1,
    });
    this.fixedLeg = terms.direction === "pay-fixed" ? "pay" : "receive";
    this.floatingLeg = terms.direction === "pay-fixed" ? "receive" : "pay";
  }

  /** The floating leg's reset grid; the fixed leg has none. */
  repricingSchedule(): number[] {
    return this.floating.repricingSchedule();
  }

  /** Both legs, signed and tagged, fixed leg first. */
  generateCashflows(path: RatePath): SwapCashflow[] {
    return [
      ...signLeg(this.fixed.generateCashflows(path), this.fixedLeg),
      ...signLeg(this.floating.generateCashflows(path), this.floatingLeg),
    ];
  }
}

function signLeg(rows: readonly Cashflow[], leg: SwapLeg): SwapCashflow[] {
  const s = leg === "receive" ? 1 : -1;
  return rows.map((cf) => ({
    monthOffset: cf.monthOffset,
    balance: s * cf.balance,
    principalPaid: s * cf.principalPaid,
    interestPaid: s * cf.interestPaid,
    couponRate: cf.couponRate,
    leg,
  }));
}

// Compile-time seam check, the CommitmentInstrument precedent: the two members
// the factory relies on stay assignable to the kernel Instrument's own, so a
// signature change breaks HERE. The factory casts through `unknown`, which
// erases every check at the call site.
type _SwapSeamCheck = SwapInstrument extends Pick<Instrument, "generateCashflows" | "repricingSchedule">
  ? true
  : never;
const _swapSeamCheck: _SwapSeamCheck = true;
void _swapSeamCheck;
