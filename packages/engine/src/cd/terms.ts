/**
 * CD position terms for the competing-risk adapter.
 *
 * `CdTerms` is the terms POJO a CD-family position will carry once wave 3
 * widens the engine `PositionTerms` union with a `cd` arm.
 * This wave the type lives here, standalone: contracts/position.ts and the
 * instrument factory are explicitly out of this module's ownership.
 *
 * Shape decisions:
 *
 *  - One CD instrument represents a COHORT BOOK, not a single ticket. The
 *    kernel's severity part-1 log-balance covariate is standardized LIVE each
 *    walk month against the cross-section of live cohorts, so walking cohorts
 *    one position at a time is NOT the same model as walking them jointly
 *    (each isolated cohort would see a degenerate cross-section and a zeroed
 *    covariate). Carrying the whole cohort book on one position preserves the
 *    kernel's joint dynamics exactly.
 *
 *  - Cohort balances are in the kernel's STYLIZED units, not dollars: the walk
 *    runs at `balance * walkScale` dollars (default 1e7, so a 100-unit book is
 *    $1B) because three $1 constants and the hazard's log-balance covariate
 *    live on the dollar scale.
 *    `notional` (dollars) only scales the OUTPUT cashflow stream. A builder
 *    mapping a real book must therefore choose stylized balances so that
 *    `balance * walkScale` matches the actual cohort dollar sizes; scaling by
 *    `notional / bookTotal` instead would silently move the hazard covariate.
 *    That mapping belongs to W3-A2b and is documented in its NOTE.
 *
 *  - Cohort seasoning is carried by `monthsToMaturity < termMonths`; the
 *    engine-wide `originationOffsetMonths` (the re-anchor) must stay 0 on
 *    CD terms so age is never double-counted. The constructor refuses nonzero.
 */
import type { InstrumentTermsBase } from "@alm/kernel";
import { termBucketOf } from "@alm/kernel";

/** One CD cohort at the as-of date (kernel `CdBookRow` shape, engine-owned). */
export interface CdCohortSpec {
  /** ORIGINAL term in months. Must be a kernel term-bucket member (1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60). */
  termMonths: number;
  /** Whole months to contractual maturity from model time-zero; 1..termMonths. */
  monthsToMaturity: number;
  /** Cohort balance in stylized units (see module header for the scale convention). */
  balance: number;
  /** Contract rate, decimal per annum. */
  contractRate: number;
}

/** Terms for a CD cohort-book position. Satisfies `Omit<InstrumentTermsBase, "type">`. */
export interface CdTerms {
  id: string;
  type: "cd";
  label?: string;
  /** Dollar notional the stylized cohort book's cashflows are scaled to. */
  notional: number;
  /** Months to the book's last contractual maturity: max over cohorts of monthsToMaturity. */
  maturityMonths: number;
  /** Must be 0: CD seasoning is carried per-cohort by monthsToMaturity (module header). */
  originationOffsetMonths: number;
  /** Contractually a bullet per cohort; behavior comes from the kernel walk, not amortization. */
  amortType: "bullet";
  side?: "asset" | "liability";
  /** The cohort book, walked jointly. At least one cohort. */
  cohorts: readonly CdCohortSpec[];
  /**
   * The corrections the run applies to this book's walk, written at run entry by `markCdBook`
   * (./corrections.ts) when the run's model convention names them; never authored on a book. Absent, the walk is the
   * original convention: the kernel's vendored parameters, its fixed 2026-03-31 grid, and no scenario.
   */
  walk?: CdWalkMark;
}

/** The corrections a run writes on a CD book at run entry. */
export interface CdWalkMark {
  /** K1 point 3: the minimum live balance in walk dollars (the kernel header's $1). Absent, the vendored $1,000. */
  minLiveBalance?: number;
  /**
   * K1 points 1 and 2: the run's funding spread (TLP) at 1, 2, ... months, decimal, held static across scenarios as
   * the kernel holds its own. Present, the walk reads its zero curve off the rate path it is projected on and adds
   * this spread, for its moneyness, its offer prices and its own discounting; it then reacts to the scenario's shock,
   * of any shape, and to the run's market. Absent, the walk reads the kernel's fixed grid and no scenario.
   */
  tlpSpreadByMonth?: readonly number[];
}

/**
 * The longest tenor the walk reads, in months: a cohort's moneyness reads its remaining term (at most its original
 * term) and a renewal's offer reads the original term, so the longest original term bounds both.
 */
export function cdCurveMonths(cohorts: readonly CdCohortSpec[]): number {
  let max = 1;
  for (const c of cohorts) max = Math.max(max, c.termMonths, c.monthsToMaturity);
  return max;
}

// Compile-time seam check: CdTerms must stay assignable to the kernel terms
// base minus the discriminant, so the union widening is purely additive.
type _CdTermsSeamCheck = CdTerms extends Omit<InstrumentTermsBase, "type"> ? true : never;
const _cdTermsSeamCheck: _CdTermsSeamCheck = true;
void _cdTermsSeamCheck;

/** Typed refusal for anything wrong with CD terms or adapter configuration. */
export class CdAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CdAdapterError";
    this.code = code;
  }
}

/** The book's contractual final maturity: max monthsToMaturity over cohorts. */
export function cdMaturityMonths(cohorts: readonly CdCohortSpec[]): number {
  let max = 0;
  for (const c of cohorts) max = Math.max(max, c.monthsToMaturity);
  return max;
}

/**
 * Validate a `CdTerms` object; throws `CdAdapterError` naming the defect and
 * the offending cohort index. Called by the adapter constructor so a malformed
 * position refuses at construction, never mid-walk.
 */
export function validateCdTerms(terms: CdTerms): void {
  const fail = (code: string, msg: string): never => {
    throw new CdAdapterError(code, `CD terms "${terms.id}": ${msg}`);
  };
  if (terms.type !== "cd") fail("cd-terms-type", `terms.type must be "cd", got "${terms.type}"`);
  if (terms.amortType !== "bullet") {
    fail("cd-terms-amort", `amortType must be "bullet", got "${terms.amortType}"`);
  }
  if (!Number.isFinite(terms.notional) || terms.notional <= 0) {
    fail("cd-terms-notional", `notional must be a positive finite number, got ${terms.notional}`);
  }
  if (terms.originationOffsetMonths !== 0) {
    fail(
      "cd-terms-origination-offset",
      `originationOffsetMonths must be 0 (CD seasoning is carried per-cohort by ` +
        `monthsToMaturity; a nonzero offset would double-count age), got ` +
        `${terms.originationOffsetMonths}`,
    );
  }
  if (!Array.isArray(terms.cohorts) || terms.cohorts.length === 0) {
    fail("cd-terms-cohorts-empty", "cohorts must be a non-empty array");
  }
  terms.cohorts.forEach((c, i) => {
    const where = `cohort[${i}]`;
    if (!Number.isInteger(c.termMonths)) {
      fail("cd-terms-term", `${where}: termMonths must be an integer, got ${c.termMonths}`);
    }
    try {
      termBucketOf(c.termMonths);
    } catch {
      fail(
        "cd-terms-term",
        `${where}: termMonths ${c.termMonths} is not a kernel term-bucket member ` +
          `(supported: 1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60)`,
      );
    }
    if (!Number.isInteger(c.monthsToMaturity) || c.monthsToMaturity < 1) {
      fail(
        "cd-terms-mtm",
        `${where}: monthsToMaturity must be an integer >= 1, got ${c.monthsToMaturity}`,
      );
    }
    if (c.monthsToMaturity > c.termMonths) {
      fail(
        "cd-terms-mtm",
        `${where}: monthsToMaturity ${c.monthsToMaturity} exceeds original term ${c.termMonths}`,
      );
    }
    if (!Number.isFinite(c.balance) || c.balance <= 0) {
      fail("cd-terms-balance", `${where}: balance must be a positive finite number, got ${c.balance}`);
    }
    if (!Number.isFinite(c.contractRate) || c.contractRate < 0) {
      fail(
        "cd-terms-rate",
        `${where}: contractRate must be a finite number >= 0, got ${c.contractRate}`,
      );
    }
  });
  if (terms.walk !== undefined) {
    const w = terms.walk;
    if (w.minLiveBalance !== undefined && !(Number.isFinite(w.minLiveBalance) && w.minLiveBalance >= 0)) {
      fail("cd-terms-walk", `walk.minLiveBalance must be a finite number of walk dollars, at least 0, got ${w.minLiveBalance}`);
    }
    if (w.tlpSpreadByMonth !== undefined) {
      const need = cdCurveMonths(terms.cohorts);
      const got = Array.isArray(w.tlpSpreadByMonth) ? w.tlpSpreadByMonth.length : 0;
      if (got < need) fail("cd-terms-walk", `walk.tlpSpreadByMonth must hold at least ${need} months (the book's longest term), got ${got}`);
      const bad = w.tlpSpreadByMonth.findIndex((x) => !Number.isFinite(x));
      if (bad !== -1) fail("cd-terms-walk", `walk.tlpSpreadByMonth[${bad}] must be a finite number, got ${String(w.tlpSpreadByMonth[bad])}`);
    }
  }
  const mat = cdMaturityMonths(terms.cohorts);
  if (terms.maturityMonths !== mat) {
    fail(
      "cd-terms-maturity",
      `maturityMonths ${terms.maturityMonths} does not equal the cohort book's final ` +
        `maturity ${mat} (use cdMaturityMonths(cohorts))`,
    );
  }
}
