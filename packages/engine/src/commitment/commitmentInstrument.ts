/**
 * The commitment draw walk.
 *
 * `CommitmentInstrument` exposes the kernel `Instrument` method surface over an
 * undrawn committed line: `terms`, `generateCashflows(path)`, and
 * `repricingSchedule()`. A draw is cash leaving the bank and nothing else. The
 * resulting loan is NOT booked, so no interest
 * and no coupon appear on any row, and NII, EVE and gap do not move when a line
 * is drawn.
 *
 * THE RATE PATH ARGUMENT IS NOT READ. v1 carries no rate response: the draw
 * path comes only from the assumption set the scenario names. A rate-responsive
 * draw curve is a calibrated behavioral model, and inventing its coefficients
 * would be fabricated precision. Registered as a gap in the spec, Section 11.
 *
 * Three silences are deliberate, because a zero row and no row are different
 * statements and only one of them is true here:
 *  - an unbound commitment (EMPTY_DRAW_PATH) emits NOTHING;
 *  - a month whose draw is zero emits NOTHING;
 *  - expiry emits NOTHING, because a lapsing line moves no cash.
 */
import type { Cashflow, Instrument } from "@alm/kernel";
import { validateCommitmentTerms, type CommitmentTerms } from "./terms";

export class CommitmentInstrument {
  readonly terms: CommitmentTerms;

  constructor(terms: CommitmentTerms) {
    validateCommitmentTerms(terms);
    this.terms = terms;
  }

  /** An undrawn line has no reset schedule: it carries no booked balance to reprice. */
  repricingSchedule(): number[] {
    return [];
  }

  /**
   * The draw walk. `_path` is accepted to satisfy the kernel Instrument surface
   * and is deliberately unused; see the module header.
   */
  generateCashflows(_path?: unknown): Cashflow[] {
    const { rampRates, steadyRate } = this.terms.draw;
    const rows: Cashflow[] = [];
    let undrawn = this.terms.notional;
    for (let month = 1; month <= this.terms.maturityMonths; month++) {
      const rate = month <= rampRates.length ? rampRates[month - 1]! : steadyRate;
      const draw = undrawn * rate;
      if (draw <= 0) continue;
      rows.push({
        monthOffset: month,
        balance: undrawn,
        principalPaid: -draw,
        interestPaid: 0,
        couponRate: 0,
      });
      undrawn -= draw;
    }
    return rows;
  }
}

// Compile-time seam check: the class's `generateCashflows` and
// `repricingSchedule` must stay assignable to the kernel Instrument's own two
// members, anchored to the kernel type itself rather than to a structural
// literal, so a SIGNATURE change to either one breaks HERE. It does NOT catch a
// kernel that gains a third required member: `Pick` of two named members is
// blind to everything outside the pick. The factory casts through `unknown`
// (../runtime/instrumentFactory.ts), which erases every check at the call site,
// so this is the only thing pinning these two.
type _CommitmentSeamCheck = CommitmentInstrument extends Pick<Instrument, "generateCashflows" | "repricingSchedule">
  ? true
  : never;
const _commitmentSeamCheck: _CommitmentSeamCheck = true;
void _commitmentSeamCheck;
