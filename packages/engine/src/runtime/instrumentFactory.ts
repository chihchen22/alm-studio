/**
 * Instrument factory.
 *
 * Dispatches a Position's `terms.type` to the correct concrete kernel
 * Instrument constructor. This is the one seam between the position layer
 * (which stores `terms`, a POJO) and the kernel math (which needs a live
 * Instrument to call generateCashflows on). The hot loop calls this once per
 * position, uses the returned instrument immediately, and drops it.
 *
 * Six arms: the five frozen kernel InstrumentType members plus the
 * engine-side "cd" cohort-book arm (the cds family only;
 * FHLB and borrowings stay bullets). No numeric logic lives here: the factory
 * only constructs. An unknown discriminant throws: the anti-fabrication rule
 * (errors.ts): a missing dispatch path never returns a plausible instrument or
 * a number.
 *
 * The cd arm returns the engine's `CdBookInstrument` adapter over the
 * kernel competing-risk cohort walk. Two deliberate seams:
 *
 *  - `options.cd` passes `CdAdapterOptions` (parameter overrides, the parallel
 *    `shockBp`, the renewals view) straight to the adapter constructor. No
 *    run-pipeline caller passes options, so every run constructs the RUN-OFF
 *    view with `shockBp` 0. On the original convention the scenario's rate path
 *    does NOT reach the CD hazard (the kernel CD model prices off its own
 *    vendored all-in curve): a shocked scenario prices the base behavioral
 *    stream on the shocked discount curve. On the corrected convention (slice
 *    K1) the run marks the CD book's terms at run entry
 *    (../cd/corrections.ts), and the adapter reads its curve off the path it
 *    is given, so every shock shape reaches the walk with no refusal and no
 *    option threading through the call sites.
 *
 *  - The return cast: `CdBookInstrument` carries the kernel `Instrument`
 *    method surface exactly (compile-time seam check in ../cd/cdInstrument.ts)
 *    and `CdTerms` is structurally `Omit<InstrumentTermsBase, "type">` plus
 *    the widened discriminant (seam check in ../cd/terms.ts). The ONLY nominal
 *    difference is `terms.type: "cd"`, which sits outside the frozen kernel
 *    union, so TypeScript cannot prove assignability and the cast below states
 *    it. Every downstream consumer reads `terms` structurally (id, label,
 *    notional, maturityMonths, side, originationOffsetMonths) or dispatches on
 *    `terms.type` with a non-"cd" guard falling through to the fixed-rate
 *    default (gap fold, kernel FTP, seasoning gate), verified per consumer in
 *    the report.
 *
 * The commitment arm returns `CommitmentInstrument` over an undrawn
 * committed line. It takes NO options: the scenario's rate path is not read
 * (v1 carries no rate response; see ../commitment/commitmentInstrument.ts), and
 * the draw path comes only from the position's terms, which an overlay
 * replaces. An unbound commitment (EMPTY_DRAW_PATH) therefore produces an EMPTY
 * stream rather than a row of zeros: no draw and a zero draw are different
 * statements, and only the first is true of a line nobody has drawn on.
 *
 * The floating-loan arm returns the kernel FloatingLoan for a floater
 * that names no rate index, and the engine's IndexedFloatingLoan wrapper for one
 * that does, resolved against `options.rateIndices` (see MakeInstrumentOptions).
 *
 * The swap arm returns `SwapInstrument`: two kernel bullet legs,
 * rows signed at emission (receive positive, pay negative) and tagged by leg.
 *
 * The mortgage arm returns the kernel Mortgage for terms that carry
 * no `housing` group, and the engine's HousingMortgage mirror for terms that do,
 * when `options.macro` carries the run's house-price path (see
 * MakeInstrumentOptions).
 */
import {
  FixedLoan,
  FloatingLoan,
  Mortgage,
  NMDeposit,
  NMDBeta,
  type Instrument,
} from "@alm/kernel";
import { CdBookInstrument, type CdAdapterOptions } from "../cd";
import { ConstantCprFixedLoan, hasLoanPrepay } from "../loanPrepay";
import { CommitmentInstrument } from "../commitment";
import { FullBetaDeposit, hasFullBeta } from "../nmd/fullBeta";
import { ComponentDecayDeposit, hasComponentDecay } from "../nmd/componentDecay";
import { LinearDecayDeposit, hasLinearDecay } from "../nmd/linearDecay";
import type { PositionTerms } from "../contracts/position";
import type { RateIndexTable } from "../contracts/rateIndex";
import { HousingMortgage } from "../macro/housingMortgage";
import { MacroUnresolvedError, housePriceIndexPathOf, isRunMacro, type RunMacro } from "../macro/runMacro";
import { IndexedFloatingLoan } from "../rateIndex/indexedFloatingLoan";
import { RateIndexUnresolvedError } from "../rateIndex/resolve";
import { SwapInstrument } from "../swap/swapInstrument";
import { NonRateInstrument } from "../nonRate";

/** Optional per-call construction options (currently the cd arm only). */
export interface MakeInstrumentOptions {
  /**
   * CD adapter options: parameter overrides (e.g. the zero-hazard degeneracy
   * set), the parallel scenario shock in bp on the kernel's SOFR leg, or the
   * going-concern renewals view. Ignored by every non-"cd" arm. Omitted by the
   * run pipeline today (base-environment run-off view; see module header).
   */
  cd?: CdAdapterOptions;
  /**
   * The run's resolved rate indices. Read by the
   * floating-loan arm only, and only for a position whose terms name an index:
   * an unindexed floater takes the kernel constructor exactly as before. A
   * floater that names an index this table does not hold, or a call given no
   * table at all, throws RateIndexUnresolvedError: an unthreaded call site fails
   * loudly and never falls back to the one-month benchmark.
   */
  rateIndices?: RateIndexTable;
  /**
   * The run's resolved macro value. Read by the mortgage arm only,
   * and only for a position whose terms carry a `housing` group: a mortgage
   * without one takes the kernel constructor exactly as before. NO_MACRO builds
   * the kernel Mortgage; a path builds HousingMortgage. A call given no value,
   * or a value the run did not resolve (an unbranded or cloned object), throws
   * MacroUnresolvedError: an unthreaded call site fails loudly and never falls
   * back to the kernel schedule.
   */
  macro?: RunMacro;
  /**
   * The moving-average warmup history, percent
   * per annum oldest first, handed to the nmd and nmd-b constructors. Ignored
   * by every other arm. Absent, both constructors take the kernel's own warmup
   * series exactly as before (nmd/warmup.ts).
   */
  nmdWarmup?: readonly number[];
  /**
   * The scenario's shift of the short rate at tenor zero, percent, read only by an nmd-b
   * whose terms carry the full beta form (its level driver). Absent, such a deposit runs at its base state.
   * An nmd whose terms carry the component decay form reads it too, as the level shift of its
   * dated window. Absent, such a deposit runs on the realized path.
   */
  depositShiftPct?: number;
}

/** Build the concrete kernel Instrument for a position's terms. */
export function makeInstrument(
  terms: PositionTerms,
  options?: MakeInstrumentOptions,
): Instrument {
  switch (terms.type) {
    case "fixed-loan":
      // Terms a constant-cpr overlay wrote carry `prepay`; any other fixed loan is the
      // kernel's, exactly as before.
      return hasLoanPrepay(terms) ? new ConstantCprFixedLoan(terms) : new FixedLoan(terms);
    case "floating-loan": {
      const indexId = terms.rateIndexId;
      if (indexId === undefined) return new FloatingLoan(terms);
      const index = options?.rateIndices?.get(indexId);
      if (index === undefined) throw new RateIndexUnresolvedError(terms.id, indexId);
      // The wrapper carries the Instrument members the engine reads (seam check
      // in ../rateIndex/indexedFloatingLoan.ts); the cast is the same one the
      // cd, commitment and swap arms state.
      return new IndexedFloatingLoan(terms, index, options?.rateIndices) as unknown as Instrument;
    }
    case "mortgage": {
      const housing = terms.housing;
      if (housing === undefined) return new Mortgage(terms);
      const macro = options?.macro;
      if (macro === undefined) throw new MacroUnresolvedError(terms.id, "this call was not given the run's macro path");
      if (!isRunMacro(macro)) throw new MacroUnresolvedError(terms.id, "the macro value it was given was not resolved by the run");
      const hpi = housePriceIndexPathOf(macro);
      if (hpi === undefined) return new Mortgage(terms);
      // The mirror carries the Instrument members the engine reads (seam check
      // in ../macro/housingMortgage.ts); the cast is the one the other wrapper arms state.
      return new HousingMortgage(terms, housing, hpi) as unknown as Instrument;
    }
    case "nmd":
      // Terms a component-decay overlay wrote carry `componentDecay`; any other nmd is the
      // kernel's, exactly as before.
      if (hasComponentDecay(terms)) {
        if (terms.linearDecay !== undefined) throw new Error(`makeInstrument: position "${terms.id}" carries both a component decay form and a linear decay`);
        return new ComponentDecayDeposit(terms, options?.depositShiftPct ?? 0);
      }
      // Terms that carry `linearDecay` run off in a straight line.
      if (hasLinearDecay(terms)) return new LinearDecayDeposit(terms);
      return new NMDeposit(terms, options?.nmdWarmup);
    case "nmd-b":
      // Terms a full-form deposit-beta overlay wrote carry `fullBeta`; any other nmd-b is
      // the kernel's, exactly as before.
      if (hasFullBeta(terms)) return new FullBetaDeposit(terms, options?.depositShiftPct ?? 0, options?.nmdWarmup);
      if (terms.depositSlotting !== undefined) {
        // A slotting mark is written only for a full-form deposit; reaching here means a later set dropped the form.
        throw new Error(`makeInstrument: position "${terms.id}" is marked "${terms.depositSlotting}" but carries no full beta form`);
      }
      return new NMDBeta(terms, options?.nmdWarmup);
    case "cd":
      // See the module header for why this cast is sound: method surface and
      // terms shape are pinned by compile-time seam checks; only the "cd"
      // discriminant sits outside the frozen kernel union.
      return new CdBookInstrument(terms, options?.cd) as unknown as Instrument;
    case "non-rate-sensitive":
      // S3a-1 follow-up: a balance held at book (../nonRate). The cast is the one the cd, commitment and swap arms state.
      return new NonRateInstrument(terms) as unknown as Instrument;
    case "commitment":
      // The cast is sound for the same reason the "cd" cast is: the method
      // surface is pinned by a compile-time seam check in
      // ../commitment/commitmentInstrument.ts and the terms shape by one in
      // ../commitment/terms.ts. Only the "commitment" discriminant sits
      // outside the frozen kernel union, so TypeScript cannot prove
      // assignability and this states it.
      return new CommitmentInstrument(terms) as unknown as Instrument;
    case "swap":
      // Sound for the reason the "cd" and "commitment" casts are: the method
      // surface is pinned by a seam check in ../swap/swapInstrument.ts and the
      // terms shape by one in ../swap/terms.ts. Rows come back signed and
      // tagged by leg; see that file.
      return new SwapInstrument(terms) as unknown as Instrument;
    default: {
      // `terms` is `never` here if the union is exhaustive; the cast reads the
      // discriminant off runtime data that slipped past the type system.
      const badType = (terms as { type: string }).type;
      throw new Error(`makeInstrument: unknown terms.type "${badType}"`);
    }
  }
}
