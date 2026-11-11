/**
 * The non-rate-sensitive position (Studio slice S3a-1 follow-up, ruling 2026-11-04: "fix first, small change").
 *
 * A balance that carries no interest rate risk: an asset such as cash and due from banks, premises and equipment or
 * other assets, or a liability such as other liabilities. It is held at book value:
 *   - its balance holds at its notional for the whole of `maturityMonths` (the projection grid, normally 360);
 *   - it pays no interest, so its net interest income is 0;
 *   - it repays no principal and has no reset, so it sits in neither gap ladder;
 *   - EVE values it at par, its book value, in every scenario (eve/computeEve.ts), so it adds the same amount to base
 *     and shocked value and has no effective duration;
 *   - FTP charges and credits it nothing (ftp/computeFtp.ts leaves the family out, as it leaves out an undrawn line);
 *   - a balance plan or a new-volume rule may not target it: it does not run off, so nothing replaces it.
 *
 * The kernel `InstrumentType` union is untouched: like `cd`, `commitment` and `swap`, this is an engine-side
 * arm, built by the instrument factory and cast through `unknown` there.
 */
import type { Cashflow, Instrument, InstrumentTermsBase } from "@alm/kernel";
import type { ProductFamilyDef } from "../contracts/chartOfAccounts";

/** The terms discriminant and the family instrument type of a non-rate-sensitive balance. */
export const NON_RATE_INSTRUMENT_TYPE = "non-rate-sensitive";

/** Terms for a non-rate-sensitive balance. Satisfies `Omit<InstrumentTermsBase, "type">`. */
export interface NonRateTerms {
  id: string;
  type: "non-rate-sensitive";
  label?: string;
  /** The book value, in dollars, held for the whole projection. */
  notional: number;
  /** How many months the balance is held: the projection grid (360 on every shipped setup). */
  maturityMonths: number;
  /** Must be 0: a book balance carries no seasoning. */
  originationOffsetMonths: number;
  /** Structural only; nothing amortizes. */
  amortType: "bullet";
  /** The family's side: an asset (cash and due, premises, other assets) or a liability (other liabilities). */
  side?: "asset" | "liability";
}

type _NonRateTermsSeamCheck = NonRateTerms extends Omit<InstrumentTermsBase, "type"> ? true : never;
const _nonRateTermsSeamCheck: _NonRateTermsSeamCheck = true;
void _nonRateTermsSeamCheck;

export class NonRateTermsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NonRateTermsError";
    this.code = code;
  }
}

/** Refuse terms a book balance cannot carry. Throws; never returns repaired terms. */
export function validateNonRateTerms(terms: NonRateTerms): void {
  const where = `non-rate-sensitive terms "${terms.id}"`;
  const fail = (code: string, message: string): never => {
    throw new NonRateTermsError(code, `${where}: ${message}`);
  };
  if (terms.type !== NON_RATE_INSTRUMENT_TYPE) fail("non-rate-terms-type", `type must be "${NON_RATE_INSTRUMENT_TYPE}", got ${JSON.stringify(terms.type)}`);
  if (!Number.isFinite(terms.notional) || terms.notional <= 0) fail("non-rate-terms-notional", `notional is the book value and must be a positive finite number, got ${String(terms.notional)}`);
  if (!Number.isInteger(terms.maturityMonths) || terms.maturityMonths < 1) {
    fail("non-rate-terms-maturity", `maturityMonths is how long the balance is held and must be a whole number of months from 1, got ${String(terms.maturityMonths)}`);
  }
  if (terms.originationOffsetMonths !== 0) fail("non-rate-terms-offset", `originationOffsetMonths must be 0 (a book balance carries no seasoning), got ${String(terms.originationOffsetMonths)}`);
  if (terms.amortType !== "bullet") fail("non-rate-terms-amort", `amortType must be "bullet" (nothing amortizes), got ${JSON.stringify(terms.amortType)}`);
  if (terms.side !== undefined && terms.side !== "asset" && terms.side !== "liability") fail("non-rate-terms-side", `side must be "asset" or "liability", got ${JSON.stringify(terms.side)}`);
}

/** The balance held at book: the notional every month, no interest, no principal, no reset. */
export class NonRateInstrument {
  readonly terms: NonRateTerms;

  constructor(terms: NonRateTerms) {
    validateNonRateTerms(terms);
    this.terms = terms;
  }

  repricingSchedule(): number[] {
    return [];
  }

  generateCashflows(_path?: unknown): Cashflow[] {
    const rows: Cashflow[] = [];
    for (let month = 1; month <= this.terms.maturityMonths; month++) {
      rows.push({ monthOffset: month, balance: this.terms.notional, principalPaid: 0, interestPaid: 0, couponRate: 0 });
    }
    return rows;
  }
}

type _NonRateSeamCheck = NonRateInstrument extends Pick<Instrument, "generateCashflows" | "repricingSchedule"> ? true : never;
const _nonRateSeamCheck: _NonRateSeamCheck = true;
void _nonRateSeamCheck;

/** True when the family holds non-rate-sensitive balances. */
export function isNonRateFamily(def: Pick<ProductFamilyDef, "instrumentType">): boolean {
  return def.instrumentType === NON_RATE_INSTRUMENT_TYPE;
}
