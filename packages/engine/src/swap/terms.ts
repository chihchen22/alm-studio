/**
 * Interest rate swap position terms.
 *
 * A plain vanilla swap on one notional: a fixed leg at `fixedRate` against a
 * floating leg at 1M SOFR plus `floatMargin`, reset every
 * `resetFrequencyMonths`. `direction` names the leg the bank PAYS.
 *
 * `SwapTerms` is structurally `Omit<InstrumentTermsBase, "type">` plus the
 * widened discriminant, the shape `CdTerms` and `CommitmentTerms` carry. Two
 * fields exist for that structure and are stated because nothing else states
 * them:
 *  - `amortType` is always "bullet": both legs are bullets on the notional,
 *    and the two notional exchanges cancel in value (they are never cash).
 *  - `originationOffsetMonths` must be 0: a swap is anchored at the as-of date
 *    and seasoning is refused, as for every non fixed-loan type.
 * The kernel `InstrumentType` union is untouched.
 *
 * `side` is declared optional only so that consumers reading `pos.terms.side`
 * across the whole `PositionTerms` union (the FTP side check) keep compiling,
 * the `CdTerms` precedent. A swap's side comes from its family, "derivative",
 * so validation refuses any terms that carry `side` at all.
 *
 * Not modeled, and refused rather than approximated: amortizing, forward
 * starting, basis, capped or floored swaps (the swaps
 * entry).
 */
import type { InstrumentTermsBase } from "@alm/kernel";

/** The leg the bank pays: "pay-fixed" pays the fixed leg and receives the floating leg. */
export type SwapDirection = "pay-fixed" | "receive-fixed";

/** Terms for a plain vanilla interest rate swap. Satisfies `Omit<InstrumentTermsBase, "type">`. */
export interface SwapTerms {
  id: string;
  type: "swap";
  label?: string;
  /** Notional of both legs, currency units, positive. */
  notional: number;
  /** Months to the final exchange, integer, at least 1. */
  maturityMonths: number;
  /** Must be 0; a swap carries no seasoning re-anchor. */
  originationOffsetMonths: number;
  /** Structural only; both legs are bullets. */
  amortType: "bullet";
  /** Must be absent; refused by validateSwapTerms (the family side is "derivative"). */
  side?: "asset" | "liability";
  direction: SwapDirection;
  /** Fixed leg coupon, annual decimal (0.0375 is 3.75 percent), monthly 30/360 accrual. */
  fixedRate: number;
  /** Floating leg margin over 1M SOFR, annual decimal. Default 0. */
  floatMargin?: number;
  /** Floating leg reset cadence in months. Default 1. */
  resetFrequencyMonths?: number;
}

/** Compile-time seam check: the terms are the kernel base shape plus the widened discriminant. */
type _SwapTermsSeamCheck = SwapTerms extends Omit<InstrumentTermsBase, "type"> ? true : never;
const _swapTermsSeamCheck: _SwapTermsSeamCheck = true;
void _swapTermsSeamCheck;

export class SwapTermsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SwapTermsError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new SwapTermsError(code, message);
}

/** Refuse terms the two-leg build cannot honor. Throws; never returns repaired terms. */
export function validateSwapTerms(terms: SwapTerms): void {
  const where = `swap terms "${terms.id}"`;
  if (terms.type !== "swap") {
    fail("swap-terms-type", `${where}: type must be "swap", got ${JSON.stringify(terms.type)}`);
  }
  if (!Number.isFinite(terms.notional) || terms.notional <= 0) {
    fail("swap-terms-notional", `${where}: notional must be a positive finite number, got ${String(terms.notional)}`);
  }
  if (!Number.isInteger(terms.maturityMonths) || terms.maturityMonths < 1) {
    fail("swap-terms-maturity", `${where}: maturityMonths must be an integer of at least 1, got ${String(terms.maturityMonths)}`);
  }
  if (terms.originationOffsetMonths !== 0) {
    fail(
      "swap-terms-offset",
      `${where}: originationOffsetMonths must be 0 (a swap is anchored at the as-of date), got ${String(terms.originationOffsetMonths)}`,
    );
  }
  if (terms.amortType !== "bullet") {
    fail("swap-terms-amort", `${where}: amortType must be "bullet"; amortizing swaps are not modeled, got ${JSON.stringify(terms.amortType)}`);
  }
  if (terms.side !== undefined) {
    fail(
      "swap-terms-side",
      `${where}: side must be absent (a swap's side comes from its family, "derivative"), got ${JSON.stringify(terms.side)}`,
    );
  }
  if (terms.direction !== "pay-fixed" && terms.direction !== "receive-fixed") {
    fail("swap-terms-direction", `${where}: direction must be "pay-fixed" or "receive-fixed", got ${JSON.stringify(terms.direction)}`);
  }
  if (!Number.isFinite(terms.fixedRate)) {
    fail("swap-terms-fixed-rate", `${where}: fixedRate must be a finite annual decimal, got ${String(terms.fixedRate)}`);
  }
  if (terms.floatMargin !== undefined && !Number.isFinite(terms.floatMargin)) {
    fail("swap-terms-margin", `${where}: floatMargin must be a finite annual decimal, got ${String(terms.floatMargin)}`);
  }
  const r = terms.resetFrequencyMonths;
  if (r !== undefined && (!Number.isInteger(r) || r < 1 || r > terms.maturityMonths)) {
    fail(
      "swap-terms-reset",
      `${where}: resetFrequencyMonths must be an integer from 1 to maturityMonths (${terms.maturityMonths}), got ${String(r)}`,
    );
  }
}
