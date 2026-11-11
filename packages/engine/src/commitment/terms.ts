/**
 * Commitment position terms.
 *
 * An undrawn committed credit line. It is OFF balance sheet: the bank does not
 * own the money, it is obliged to hand it over if the borrower asks. The engine
 * models the cash going out and nothing else; the drawn asset is NOT booked.
 *
 * `CommitmentTerms` is structurally `Omit<InstrumentTermsBase, "type">` plus the
 * widened discriminant and the draw path, the same shape `CdTerms` carries. The
 * kernel `InstrumentType` union is untouched.
 *
 * Field meanings differ from a funded instrument and are stated because nothing
 * else states them:
 *  - `notional` is the UNDRAWN optional capacity at the portfolio as-of date.
 *  - `maturityMonths` is months until the line EXPIRES, not until it repays.
 *  - `amortType` is carried for structural compatibility and is NOT read.
 *  - `originationOffsetMonths` must be 0, as for every non-fixed-loan type.
 *
 * ONLY OPTIONAL CAPACITY. A line's contractually scheduled draws (construction
 * milestones, committed-but-undisbursed term loans) are NOT represented by this
 * type at all. That is a scope boundary, not a refinement;
 */
import type { InstrumentTermsBase } from "@alm/kernel";

/**
 * The authored monthly draw path. `rampRates[k-1]` is month k's fraction;
 * `steadyRate` holds from month `rampRates.length + 1` onward.
 *
 * Each rate is a fraction of what is STILL UNDRAWN, not of the original limit.
 * Three consequences, each load-bearing:
 *  - the model can never draw more than the line, structurally;
 *  - it is the 5c deposit run-off convention, so both legs of the squeeze share
 *    one convention;
 *  - month 1's draw is exactly `notional * rampRates[0]`, and the LCR reads
 *    month 1 only, so the authored number is the number the LCR sees.
 *
 * A separate `steadyRate` rather than a longer list because the codebase refuses
 * to extend a short array silently (`EnvironmentSpec` calls a short macro path
 * "a compile refusal, never a silently extended one"). This says what happens
 * after the ramp out loud, without making an author write 360 entries.
 */
export interface CommitmentDrawPath {
  /** Monthly draw fractions, month 1 first. Each finite and in [0, 1]. May be empty. */
  rampRates: number[];
  /** The fraction holding from month rampRates.length + 1 onward. Finite, in [0, 1]. */
  steadyRate: number;
}

/** Draws nothing. The path a position carries until an overlay replaces it. */
export const EMPTY_DRAW_PATH: CommitmentDrawPath = Object.freeze({
  rampRates: Object.freeze([]) as unknown as number[],
  steadyRate: 0,
});

/** Terms for an undrawn committed line. Satisfies `Omit<InstrumentTermsBase, "type">`. */
export interface CommitmentTerms {
  id: string;
  type: "commitment";
  label?: string;
  /** UNDRAWN optional capacity at model time-zero, in dollars. */
  notional: number;
  /** Months until the line expires. */
  maturityMonths: number;
  /** Must be 0; a commitment carries no seasoning re-anchor. */
  originationOffsetMonths: number;
  /** Structural only; not read. */
  amortType: "bullet";
  /** Always "asset": a line is extended by the bank. */
  side: "asset";
  /**
   * The draw path. A position's own value is EMPTY_DRAW_PATH; a
   * `commitment-draw` overlay REPLACES it, the relationship a Mortgage's
   * `cprParams` has with a `prepay` overlay.
   */
  draw: CommitmentDrawPath;
}

/** Compile-time seam check: the terms are the kernel base shape plus the widened discriminant. */
type _CommitmentTermsSeamCheck = CommitmentTerms extends Omit<InstrumentTermsBase, "type">
  ? true
  : never;
const _commitmentTermsSeamCheck: _CommitmentTermsSeamCheck = true;
void _commitmentTermsSeamCheck;

export class CommitmentTermsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommitmentTermsError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CommitmentTermsError(code, message);
}

function checkFraction(value: number, code: string, where: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(code, `${where} must be a finite fraction in [0, 1], got ${String(value)}`);
  }
}

/** Refuse terms no draw walk can honor. Throws; never returns a repaired object. */
export function validateCommitmentTerms(terms: CommitmentTerms): void {
  const where = `commitment terms "${terms.id}"`;
  if (!Number.isFinite(terms.notional) || terms.notional <= 0) {
    fail(
      "commitment-terms-notional",
      `${where}: notional is the undrawn capacity and must be a positive finite number, got ${String(terms.notional)}`,
    );
  }
  if (!Number.isInteger(terms.maturityMonths) || terms.maturityMonths <= 0) {
    fail(
      "commitment-terms-maturity",
      `${where}: maturityMonths is months until the line expires and must be a positive integer, got ${String(terms.maturityMonths)}`,
    );
  }
  if (terms.originationOffsetMonths !== 0) {
    fail(
      "commitment-terms-offset",
      `${where}: originationOffsetMonths must be 0 (a commitment carries no seasoning re-anchor), got ${String(terms.originationOffsetMonths)}`,
    );
  }
  const draw = terms.draw;
  if (draw === null || typeof draw !== "object" || !Array.isArray(draw.rampRates)) {
    fail("commitment-terms-draw", `${where}: draw must be { rampRates: number[], steadyRate: number }`);
  }
  draw.rampRates.forEach((r, i) => {
    checkFraction(r, "commitment-terms-ramp", `${where}: draw.rampRates[${i}]`);
  });
  checkFraction(draw.steadyRate, "commitment-terms-steady", `${where}: draw.steadyRate`);
}
