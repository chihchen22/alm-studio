/**
 * Typed-array bucket accumulator for the cash-flow hot loop.
 *
 * The whole performance story (architecture Section 8): a position's Cashflow[]
 * reduces straight into three Float64Arrays keyed by month bucket, and no
 * per-position result object survives. One accumulator holds the running
 * balance, principal, and interest totals over the monthly grid for one
 * (scenario, family). The add path is allocation-free — a bounded index and a
 * few `+=` — so the 100k x 360 reduction stays a tight numeric loop.
 *
 * Bucketing is by integer month offset: the caller resolves a
 * Cashflow's monthOffset to a bucket index and passes it in. An out-of-range
 * index throws rather than silently dropping cash: the horizon-truncation
 * decision belongs to the aggregation layer, made explicitly, not absorbed here.
 */
import type { Cashflow } from "@alm/kernel";

export class BucketAccumulator {
  readonly length: number;
  readonly balance: Float64Array;
  readonly principal: Float64Array;
  readonly interest: Float64Array;

  constructor(horizonMonths: number) {
    if (!Number.isInteger(horizonMonths) || horizonMonths <= 0) {
      throw new Error("BucketAccumulator: horizonMonths must be a positive integer");
    }
    this.length = horizonMonths;
    this.balance = new Float64Array(horizonMonths);
    this.principal = new Float64Array(horizonMonths);
    this.interest = new Float64Array(horizonMonths);
  }

  /** Add one leg into `bucket`. Allocation-free; throws if bucket is out of range. */
  add(bucket: number, balance: number, principal: number, interest: number): void {
    if (bucket < 0 || bucket >= this.length) {
      throw new RangeError(`BucketAccumulator.add: bucket ${bucket} out of [0, ${this.length})`);
    }
    this.balance[bucket] += balance;
    this.principal[bucket] += principal;
    this.interest[bucket] += interest;
  }

  /** Reduce one Cashflow leg into `bucket` (its balance / principal / interest). */
  addCashflow(bucket: number, cf: Cashflow): void {
    this.add(bucket, cf.balance, cf.principalPaid, cf.interestPaid);
  }

  /** Zero the accumulators in place for reuse across scenarios (no reallocation). */
  reset(): void {
    this.balance.fill(0);
    this.principal.fill(0);
    this.interest.fill(0);
  }
}
