/**
 * The constant-balance walk for a prepaying fixed loan.
 *
 * The kernel's `runStaticBalanceScenario` (analytics/seg.ts, frozen) replaces each month's runoff with a vintage from
 * its own `makeVintage`, which for a fixed loan is a plain kernel FixedLoan: a replaced dollar would stop prepaying.
 * The capstone build v8 wraps that rule so the vintage inherits the parent's CPR. This module does the same for the
 * one instrument that needs it and nothing else:
 *
 *   - any instrument that is not a ConstantCprFixedLoan goes straight to the kernel function, so every other number
 *     is the kernel's, bit for bit;
 *   - a ConstantCprFixedLoan runs the same loop, line for line in the kernel's order, with the kernel's vintage
 *     rebuilt at the parent's CPR (`vintageOf`).
 *
 * The loop is restated here only because the kernel exposes no seam for the vintage; the kernel stays byte-identical.
 */
import {
  makeVintage,
  runStaticBalanceScenario,
  type Instrument,
  type PortfolioTrajectory,
  type RatePath,
  type VintageRecord,
} from "@alm/kernel";
import { ConstantCprFixedLoan, isKernelDeposit, vintageOf } from "./constantCprFixedLoan";

/** The kernel's per-month extraction (analytics/seg.ts generateAndExtract), restated for the prepaying loan only. */
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

/**
 * `runStaticBalanceScenario` with replacement vintages that inherit a prepaying parent's CPR, and (D6) a kernel deposit's vintages built on `depositHistory` when it is given. Absent, a deposit goes to the kernel
 * function and its vintages read the kernel's own warmup series, the original convention.
 */
export function runStaticBalance(
  instrument: Instrument,
  existingPath: RatePath,
  shockedDetPath: RatePath,
  basePath: RatePath,
  horizon: number,
  depositHistory?: readonly number[],
): PortfolioTrajectory {
  const ownVintages = instrument instanceof ConstantCprFixedLoan || (depositHistory !== undefined && isKernelDeposit(instrument));
  if (!ownVintages) {
    return runStaticBalanceScenario(instrument, existingPath, shockedDetPath, basePath, horizon);
  }
  const existing = extract(instrument, existingPath, horizon);
  const totalInterest = new Float64Array(horizon);
  const totalBalance = new Float64Array(horizon);
  const vintages: VintageRecord[] = [];

  for (let m = 1; m <= horizon; m++) {
    let bal = existing.balance[m - 1]!;
    let interest = existing.interest[m - 1]!;
    let runoff = existing.principal[m - 1]!;

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
      const built = makeVintage(instrument, m, runoff, shockedDetPath, basePath, horizon);
      if (built !== null) {
        const cashflows = vintageOf(instrument, built.instrument, depositHistory).generateCashflows(built.path);
        vintages.push({ startMonth: m, cashflows });
      }
    }
  }

  return { totalInterest, totalBalance, existing, vintages };
}
