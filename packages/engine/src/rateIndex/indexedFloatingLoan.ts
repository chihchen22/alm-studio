/**
 * IndexedFloatingLoan: a floating loan whose reset
 * rate is a named index. A thin engine wrapper over the kernel FloatingLoan: it
 * hands the inner loan an IndexRatePath for a compounded window, or a
 * ResolvedIndexPath over the run's table for a constant-maturity-swap or formula
 * index, so the kernel reads the index reset where it would
 * have read the one-month rate. The kernel is untouched, and a position that
 * names no index never reaches this class.
 *
 * repricingSchedule is the inner loan's: the reset grid does not depend on the
 * index, so the repricing ladder is unchanged.
 */
import { FloatingLoan } from "@alm/kernel";
import type { Cashflow, FloatingLoanTerms, Instrument, RatePath } from "@alm/kernel";
import type { RateIndex, RateIndexTable } from "../contracts/rateIndex";
import { IndexRatePath } from "./indexRatePath";
import { ResolvedIndexPath } from "./indexSeries";
import { RateIndexUnresolvedError } from "./resolve";

export class IndexedFloatingLoan {
  readonly terms: FloatingLoanTerms;
  private readonly inner: FloatingLoan;

  constructor(
    terms: FloatingLoanTerms,
    private readonly index: RateIndex,
    /** The run's table; a constant-maturity-swap or formula index reads its series from it (B3a). */
    private readonly table?: RateIndexTable,
  ) {
    this.inner = new FloatingLoan(terms);
    this.terms = this.inner.terms;
  }

  repricingSchedule(): number[] {
    return this.inner.repricingSchedule();
  }

  generateCashflows(path: RatePath): Cashflow[] {
    const index = this.index;
    if (index.kind === "constant-maturity-swap" || index.kind === "formula") {
      if (this.table === undefined) throw new RateIndexUnresolvedError(this.terms.id, index.id);
      return this.inner.generateCashflows(new ResolvedIndexPath(path, index.id, this.table));
    }
    // A compounded window: the reader before B3a, unchanged, so a run on such indices only is byte-identical.
    return this.inner.generateCashflows(new IndexRatePath(path, index));
  }
}

// Compile-time seam check: the wrapper's two Instrument members must stay
// assignable to the kernel Instrument's. Pick of two names is blind to a new
// required member, as in the other engine adapters.
type _IndexedSeamCheck = IndexedFloatingLoan extends Pick<Instrument, "generateCashflows" | "repricingSchedule"> ? true : never;
const _indexedSeamCheck: _IndexedSeamCheck = true;
void _indexedSeamCheck;
