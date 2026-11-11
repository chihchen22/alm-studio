/**
 * Seasoning re-anchor (honesty defect D3a).
 *
 * The kernel base terms carry `originationOffsetMonths` ("origination month
 * offset relative to model time-zero, negative = seasoned"; kernel
 * `types.ts`), but the kernel instruments IGNORE it: every generated stream is
 * emitted in instrument time, `monthOffset` 1..N from instrument-time-zero.
 * This module is the engine-side ruling on what the field means and where it
 * is honored:
 *
 *   - `originationOffsetMonths === 0` (the default everywhere): the terms are
 *     the REMAINING representation, anchored at the portfolio as-of date.
 *     Instrument-time-zero IS the as-of; bucket = monthOffset - 1 is correct
 *     unchanged. This is the representation the synthetic generator emits and
 *     the one every committed golden was computed on.
 *
 *   - `originationOffsetMonths < 0` (seasoned): the terms are the ORIGINAL
 *     representation — the stream is anchored `-offset` months in the past.
 *     The engine re-anchors it: a cashflow at instrument month m lands in
 *     portfolio bucket m - 1 + offset; entries with a negative shifted bucket
 *     fell before the as-of date (already elapsed) and are dropped, and the
 *     truncation window at the horizon shifts by the same amount. Supported
 *     for `fixed-loan` terms ONLY, where the stream is path-independent and
 *     the shift is exact (a bullet or level-pay schedule does not depend on
 *     when it is observed). The other four types refuse loudly:
 *
 *       floating-loan — the kernel reads the coupon off the rate path in
 *         instrument time, so a shifted floater's coupons would be read at the
 *         wrong path steps, and the reset-grid phase re-anchor needs the same
 *         kernel seam as behavioral age (D3b, deferred by ADR-021). Import
 *         seasoned floaters in the remaining representation (offset 0); the
 *         reset cycle is then measured from the as-of date, which loses the
 *         mid-cycle phase (disclosed on the limitations page).
 *       mortgage — the kernel mortgage carries seasoning natively: remaining
 *         terms plus `ageMonths` (behavioral age at as-of). That representation
 *         is exact for both timing and the CPR seasoning/burnout state, and it
 *         is the one the generator and the Lab cross-check use. A nonzero
 *         offset would double-represent seasoning, so it refuses with that
 *         guidance.
 *       nmd / nmd-b — a deposit has no contractual origination schedule to
 *         re-anchor; the decay stream is defined on the current balance from
 *         the as-of date. Behavioral age re-anchoring (starting the decay
 *         age-ramp mid-life) is D3b.
 *
 *   - `originationOffsetMonths > 0` (forward start): refused. A position on
 *     the current book cannot originate in the future; the dynamic
 *     new-business module owns future originations (it stamps 0 and applies
 *     its own origination-bucket shift).
 *
 * THE RUN-PIPELINE GATE IS LIFTED (per the report NOTE 1).
 * The effective-duration engine (`eve/effectiveDuration.ts`) now re-anchors
 * seasoned streams to portfolio time before pricing (drop elapsed, shift the
 * rest, remaining-maturity reuse guard), and the sharded static pass
 * (`run/shard/chunk.ts`) applies the same bucket shift as the aggregator, so
 * a seasoned fixed-loan flows through the whole run: ladders, NII, EVE, and
 * durations all honor the re-anchor. `assertRunPipelineUnseasoned` is
 * retained below for compatibility but is no longer called by the pipeline.
 * ONE consumer still refuses: the FTP module par-matches full original
 * streams in instrument time, so a seasoned book's run omits the ftp block
 * and carries the typed `ftp.seasoned-book` register tag instead (see
 * run/orchestrate.ts and the report NOTE).
 *
 * BEHAVIORAL AGE IS NOT RE-ANCHORED BY ANY OF THIS. The shift moves where
 * cashflows land; it does not tell the kernel how old the instrument is. CPR
 * seasoning/burnout state (except through the mortgage's own `ageMonths`),
 * the NMD decay age ramp, and the floater reset phase all still start at
 * instrument-time-zero. That is D3b, declined this window because it needs a
 * kernel contract change and the kernel is frozen.
 */
import type { InstrumentTermsBase } from "@alm/kernel";
import type { CdTerms } from "../cd/terms";
import type { CommitmentTerms } from "../commitment/terms";
import type { SwapTerms } from "../swap/terms";
import type { NonRateTerms } from "../nonRate";
import type { PortfolioSpec } from "../contracts/position";
import { NotImplementedError } from "../runtime/notImplemented";

/**
 * Terms this module accepts: the kernel base shape, the engine's cd
 * cohort-book arm (W3-A2b widening), the engine's commitment arm, or
 * the engine's swap arm. Every engine arm is structurally
 * `Omit<InstrumentTermsBase, "type">` plus a widened discriminant, so every
 * field read below exists on all four members.
 * Purely a type widening: the arithmetic and every existing refusal are
 * unchanged.
 */
type SeasonableTerms = InstrumentTermsBase | CdTerms | CommitmentTerms | SwapTerms | NonRateTerms;

/**
 * Thrown when a position's `originationOffsetMonths` is malformed or names a
 * representation the engine cannot honor for that instrument type. A typed
 * domain refusal (D5 discipline): running the position as if it were
 * origination-aligned would silently ignore the caller's stated seasoning.
 */
export class SeasoningError extends Error {
  readonly instrumentId: string;
  readonly instrumentType: string;
  readonly originationOffsetMonths: number;
  constructor(terms: SeasonableTerms, detail: string) {
    super(
      `instrument "${terms.id}" (${terms.type}): originationOffsetMonths ` +
        `${terms.originationOffsetMonths}; ${detail}`,
    );
    this.name = "SeasoningError";
    this.instrumentId = terms.id;
    this.instrumentType = terms.type;
    this.originationOffsetMonths = terms.originationOffsetMonths;
  }
}

/**
 * Validate and return a position's origination offset (months, 0 or negative).
 * 0 passes for every type; a negative offset passes only for `fixed-loan`
 * terms (the exact, path-independent case). Everything else throws
 * SeasoningError with representation guidance. Cheap enough for the hot loop:
 * one integer check and one comparison on the overwhelmingly common 0 path.
 */
export function seasoningOffsetOf(terms: SeasonableTerms): number {
  const off = terms.originationOffsetMonths;
  if (off === 0) return 0;
  if (!Number.isInteger(off)) {
    throw new SeasoningError(
      terms,
      "must be a finite integer number of months (0 = anchored at the as-of date, negative = seasoned)",
    );
  }
  if (off > 0) {
    throw new SeasoningError(
      terms,
      "a positive offset is a forward-start position, which the static book does not support; " +
        "future originations belong to the dynamic new-business module",
    );
  }
  switch (terms.type) {
    case "fixed-loan":
      return off;
    case "floating-loan":
      throw new SeasoningError(
        terms,
        "cannot be applied to a floating loan; only a fixed-loan can be seasoned. Set the offset " +
          "to 0 and give the terms remaining at the as-of date; the reset cycle is then counted " +
          "from the as-of date",
      );
    case "mortgage":
      throw new SeasoningError(
        terms,
        "cannot be applied to a mortgage; only a fixed-loan can be seasoned. Set the offset to 0, " +
          "give the terms remaining at the as-of date and the months elapsed since origination in " +
          "ageMonths",
      );
    case "nmd":
    case "nmd-b":
      throw new SeasoningError(
        terms,
        "cannot be applied to a deposit; only a fixed-loan can be seasoned. Set the offset to 0 " +
          "and give the balance at the as-of date",
      );
    case "cd":
      // Unreachable through the adapter (validateCdTerms refuses nonzero at
      // construction), kept for direct callers: CD cohort seasoning is carried
      // per cohort by monthsToMaturity < termMonths, never by the offset.
      throw new SeasoningError(
        terms,
        "cannot be applied to a CD cohort; only a fixed-loan can be seasoned. Set the offset to " +
          "0; the age of a cohort is carried by monthsToMaturity",
      );
    case "non-rate-sensitive":
      // Unreachable through the factory (validateNonRateTerms refuses a nonzero offset), kept for direct callers.
      throw new SeasoningError(terms, "cannot be applied to a non-rate-sensitive balance; set the offset to 0 and give the book value at the as-of date");
    case "commitment":
      // Unreachable through the factory (validateCommitmentTerms refuses a
      // nonzero offset at construction), kept for direct callers: an undrawn
      // line has no origination schedule to re-anchor, and its draw path is
      // authored in months from the as-of date.
      throw new SeasoningError(
        terms,
        "cannot be applied to a commitment; only a fixed-loan can be seasoned. Set the offset to " +
          "0 and author the draw path in months from the as-of date",
      );
    case "swap":
      // Unreachable through the factory (validateSwapTerms refuses a nonzero
      // offset at construction), kept for direct callers: a swap is anchored
      // at the as-of date and both legs start there.
      throw new SeasoningError(
        terms,
        "cannot be applied to a swap; only a fixed-loan can be seasoned. Set the offset to 0; a " +
          "swap starts at the as-of date",
      );
    default:
      throw new SeasoningError(terms, "unknown instrument type; only a fixed-loan can be seasoned. Set the offset to 0");
  }
}

/** One position of a book that `seasoningOffsetOf` refuses, with the engine's message verbatim. */
export interface SeasoningRefusal {
  positionId: string;
  /** 1-based index into `positions[]`; a caller with its own row locator (a CSV line) uses that instead. */
  row?: number;
  message: string;
}

/**
 * Studio blank path D4: the book-level read of the rule above, so intake and
 * setup validation can refuse a position before a run reaches it. It calls
 * `seasoningOffsetOf` on every position and collects each `SeasoningError`
 * message; the refused set is therefore whatever that function refuses, never
 * a copied list. A position with no `originationOffsetMonths` is refused too,
 * as the engine refuses it. Any other error is re-thrown, never reported as a
 * seasoning refusal.
 */
export function seasoningRefusals(spec: Pick<PortfolioSpec, "positions">): SeasoningRefusal[] {
  const out: SeasoningRefusal[] = [];
  spec.positions.forEach((p, i) => {
    const terms = p.terms as SeasonableTerms;
    try {
      seasoningOffsetOf(terms);
    } catch (err) {
      if (!(err instanceof SeasoningError)) throw err;
      out.push({ positionId: p.id, row: i + 1, message: err.message });
    }
  });
  return out;
}

/**
 * SUPERSEDED: the run-pipeline gate this implemented was lifted
 * together with the duration-engine re-anchor, exactly as the report
 * NOTE 1 required — the two changes were one unit. The function is retained
 * (never deleted; supersede, do not erase) for any out-of-tree caller that
 * still wants the strict refusal, but the pipeline no longer calls it:
 * `run/shard/chunk.ts` now validates via `seasoningOffsetOf` and applies the
 * shift instead of throwing.
 */
export function assertRunPipelineUnseasoned(positionId: string, terms: SeasonableTerms): void {
  const off = seasoningOffsetOf(terms);
  if (off !== 0) {
    throw new NotImplementedError(
      "run.seasoning",
      `position "${positionId}" carries originationOffsetMonths ${off}: the run pipeline does ` +
        `not yet apply the seasoning re-anchor end to end (the effective-duration engine prices ` +
        `raw kernel streams in instrument time). ` +
        `Module-level aggregation and gap ladders support seasoned fixed-loan terms; the run ` +
        `refuses rather than printing a mis-timed duration.`,
    );
  }
}
