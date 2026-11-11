/**
 * The cohort-0 prepayment overlay of the SEG block.
 *
 * The kernel's `runStaticBalanceScenario` (analytics/seg.ts, frozen) builds every replacement vintage from the
 * instrument it walks, so a vintage carries cohort 0's prepayment model. The book's main route needs the two apart:
 * cohort 0 at 9% CPR under +25bp and 14% under -25bp, every replacement vintage at the family's base 10%. This module
 * restates the kernel loop, line for line in the kernel's order, with one change: the existing book is `existing`
 * and every vintage is built by the kernel's own `makeVintage` from `vintageParent`. With `existing ===
 * vintageParent` it is the kernel function, bit for bit (cprOverlay.test.ts holds that).
 *
 * A flat CPR reaches the kernel Mortgage through its four-factor parameters (the Mortgage takes no other prepayment
 * model): the minimum CPR is the target and the refinance midpoint sits at 1,000,000bp, an incentive no rate reaches,
 * so the S-curve term is exactly 0 and every month prepays at the minimum; seasoning ramp 1, no seasonality and no
 * burnout. The engine's own parameter check accepts it (minimum at least 0, maximum above it), where a slope-0 curve
 * with the minimum equal to the maximum would be refused. The kernel stays byte-identical, and the teach
 * slice B1 module `loanPrepay/` is not touched.
 */
import {
  Mortgage,
  makeVintage,
  type Instrument,
  type MBSParams,
  type MortgageTerms,
  type PortfolioTrajectory,
  type RatePath,
  type VintageRecord,
} from "@alm/kernel";

/** The refinance midpoint, bp, of a flat CPR: no incentive reaches it, so the logistic term is exactly 0. */
export const FLAT_CPR_MIDPOINT_BP = 1_000_000;

/** Four-factor parameters that prepay a flat `annualCpr` (decimal) every month; the spreads are kept. */
export function flatCprParams(params: MBSParams, annualCpr: number): MBSParams {
  const pct = annualCpr * 100;
  return {
    ...params,
    minCpr: pct,
    maxCpr: pct + 1,
    steepness: 1,
    inflection: FLAT_CPR_MIDPOINT_BP,
    seasoningRamp: 1,
    seasonalityAmp: 0,
    burnoutDecay: 0,
  };
}

/** Cohort 0 of a kernel Mortgage at a flat annual CPR; every other term as written. */
export function mortgageAtFlatCpr(inst: Mortgage, annualCpr: number): Mortgage {
  const t = inst.terms as MortgageTerms;
  return new Mortgage({ ...t, cprParams: flatCprParams(t.cprParams, annualCpr) });
}

/** The kernel's per-month extraction (analytics/seg.ts generateAndExtract), restated because the kernel keeps it private. */
function extract(instrument: Instrument, path: RatePath, horizon: number): PortfolioTrajectory["existing"] {
  const cf = instrument.generateCashflows(path);
  const balance = new Float64Array(horizon);
  const interest = new Float64Array(horizon);
  const principal = new Float64Array(horizon);
  const coupon = new Float64Array(horizon);
  const n = Math.min(cf.length, horizon);
  for (let i = 0; i < n; i++) {
    balance[i] = cf[i]!.balance;
    interest[i] = cf[i]!.interestPaid;
    principal[i] = cf[i]!.principalPaid;
    coupon[i] = cf[i]!.couponRate;
  }
  return { balance, interest, principal, coupon };
}

/** `runStaticBalanceScenario` with cohort 0 `existing` and every replacement vintage built from `vintageParent`. */
export function runStaticBalanceSplit(
  existing: Instrument,
  vintageParent: Instrument,
  existingPath: RatePath,
  shockedDetPath: RatePath,
  basePath: RatePath,
  horizon: number,
): PortfolioTrajectory {
  const ex = extract(existing, existingPath, horizon);
  const totalInterest = new Float64Array(horizon);
  const totalBalance = new Float64Array(horizon);
  const vintages: VintageRecord[] = [];

  for (let m = 1; m <= horizon; m++) {
    let bal = ex.balance[m - 1]!;
    let interest = ex.interest[m - 1]!;
    let runoff = ex.principal[m - 1]!;

    for (const v of vintages) {
      const localM = m - v.startMonth;
      if (localM >= 1 && localM <= v.cashflows.length) {
        const c = v.cashflows[localM - 1]!;
        bal += c.balance;
        interest += c.interestPaid;
        runoff += c.principalPaid;
      }
    }

    totalBalance[m - 1] = bal;
    totalInterest[m - 1] = interest;

    if (runoff > 1e-6 && m < horizon) {
      const built = makeVintage(vintageParent, m, runoff, shockedDetPath, basePath, horizon);
      if (built !== null) {
        const cashflows = built.instrument.generateCashflows(built.path);
        vintages.push({ startMonth: m, cashflows });
      }
    }
  }

  return { totalInterest, totalBalance, existing: ex, vintages };
}
