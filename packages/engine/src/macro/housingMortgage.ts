/**
 * HousingMortgage: an engine-side MIRROR of the kernel Mortgage.generateCashflows body, not a
 * delegating wrapper; the kernel has no CPR seam. Same operation order: benchmark tenor 10 as a literal,
 * (sec + prim) / 1e4, the wac: noteRate * 100 override, then amortizeMortgage. Guard: A2 parity, named in
 * packages/kernel/DIVERGENCE.md ("Engine mirrors of kernel code") and run on every re-vendor.
 *
 * The house-price response rescales the two parts of the kernel schedule K: the
 * turnover part T (a second kernel call with maxCpr = minCpr) and the refinancing remainder K - T, each
 * by a logistic in current LTV normalized to its value at the as-of price, with an absolute turnover
 * floor. Every parameter is illustrative.
 */
import { FourFactorCPR, Mortgage, amortizeMortgage, type Cashflow, type MortgageTerms, type PrepayContext, type RatePath, type Instrument } from "@alm/kernel";
import type { HousingParams } from "../contracts/macroFactors";

/**
 * The house-price-adjusted annual CPR schedule, month m at index m - 1. `k` is the kernel schedule,
 * `t` the turnover-only kernel schedule, `hpi` the mapped index path (series index m - 1, held at its
 * last value beyond its length). A month whose two multipliers are exactly 1 writes K unchanged.
 */
export function housingCprSchedule(k: ArrayLike<number>, t: ArrayLike<number>, h: HousingParams,
  hpi: readonly number[], noteRate: number, term: number): Float64Array {
  const out = new Float64Array(term);
  const i = noteRate / 12;
  const g = Math.pow(1 + i, term);
  const sR = (L: number) => 1 / (1 + Math.exp(h.refiLtvSlope * (L - h.refiLtvMid)));
  const sT = (L: number) => h.turnoverFloorShare + (1 - h.turnoverFloorShare) / (1 + Math.exp(h.turnoverLtvSlope * (L - h.turnoverLtvMid)));
  const floorCpr = h.turnoverCprFloor / 100;
  for (let m = 1; m <= term; m++) {
    // Start-of-month scheduled balance fraction b(m-1); the zero-rate branch mirrors amortizeMortgage's (prepay.ts:206-209).
    const b = i > 1e-12 ? (g - Math.pow(1 + i, m - 1)) / (g - 1) : 1 - (m - 1) / term;
    const H = hpi[Math.min(m - 1, hpi.length - 1)]!;
    const lBar = h.asOfLtv * b;
    const L = lBar / H;
    const mR = sR(L) / sR(lBar);
    const mT = sT(L) / sT(lBar);
    const K = k[m - 1]!;
    if (mR === 1 && mT === 1) { out[m - 1] = K; continue; }   // keyed on the computed multipliers, never on H
    const T = t[m - 1]!;
    out[m - 1] = Math.min(1, (K - T) * mR + Math.max(T * mT, Math.min(T, floorCpr)));
  }
  return out;
}

/** A kernel Mortgage whose CPR schedule reads a mapped house-price path. */
export class HousingMortgage {
  readonly terms: MortgageTerms;
  private readonly inner: Mortgage;
  constructor(terms: MortgageTerms, private readonly housing: HousingParams, private readonly hpi: readonly number[]) {
    this.inner = new Mortgage(terms);  // the kernel constructor checks
    this.terms = this.inner.terms;
    // An empty path reads hpi[-1] and a non-finite value carries through: either would emit NaN cashflows silently.
    if (hpi.length === 0 || !hpi.every((v) => Number.isFinite(v))) {
      throw new Error("HousingMortgage: the house-price index path must be a non-empty list of finite numbers");
    }
  }
  repricingSchedule(): number[] { return this.inner.repricingSchedule(); }
  generateCashflows(path: RatePath): Cashflow[] {
    const { notional, maturityMonths, noteRate, ageMonths, cprParams } = this.terms;
    const totalSpread = (cprParams.secSpread + cprParams.primSpread) / 1e4;
    const ctx: PrepayContext = { term: maturityMonths, age: ageMonths, noteRate,
      mortgageRateAt: (m) => path.forwardRateAt(m - 1, 10) + totalSpread };
    const params = { ...cprParams, wac: noteRate * 100 };
    const k = new FourFactorCPR(params).cprSchedule(ctx);
    const t = new FourFactorCPR({ ...params, maxCpr: params.minCpr }).cprSchedule(ctx);
    const cprSchedule = housingCprSchedule(k, t, this.housing, this.hpi, noteRate, maturityMonths);
    return amortizeMortgage({ notional, noteRate, term: maturityMonths, cprSchedule });
  }
}
type _HousingSeamCheck = HousingMortgage extends Pick<Instrument, "generateCashflows" | "repricingSchedule"> ? true : never;
const _housingSeamCheck: _HousingSeamCheck = true;
void _housingSeamCheck;
