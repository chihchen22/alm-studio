/**
 * CD competing-risk adapter: kernel `cdBook` cohort walk behind the engine's
 * Instrument-shaped seam (ADR-020 phase 1).
 *
 * `CdBookInstrument` exposes exactly the kernel `Instrument` surface —
 * `terms`, `generateCashflows(path)`, `repricingSchedule()` — over the
 * kernel's competing-risk early-withdrawal model (`runCohortWalk`), replacing
 * the fixed-bullet degradation for the CD family. This wave the class
 * stands alone: nothing constructs it from the factory, no contract or data
 * file references it. Integration is W3-A2b.
 *
 * Semantics:
 *
 *  - The cashflow row construction is operation-for-operation the kernel's own
 *    `cdCashflows` Lab-integration adapter (same unit scaling, same opening-
 *    balance chain, same couponRate definition), generalized only by the
 *    parallel `shockBp` argument the kernel walk already accepts. At
 *    `shockBp = 0` the stream is bit-identical to a direct `cdCashflows` call
 *    — that identity is the module's primary acceptance anchor.
 *
 *  - `renewals: false` (default) is the RUN-OFF view: the EVE / repricing
 *    headline convention (a renewal is new business, not a continuation).
 *    `renewals: true` is the going-concern liquidity view (renewal-generation
 *    chain, horizon-truncated like `cdCashflows`; the residual tail is
 *    disclosed via `walkDetail()`, never silently dropped into a row).
 *
 *  - Under the original convention THE RATE PATH ARGUMENT IS NOT READ. The kernel
 *    CD model carries its own vendored all-in curve inside `CdModelParams` and
 *    takes rate scenarios as a parallel shock in bp on the SOFR leg (the
 *    explicit `shockBp` option, which no run caller sets), so the book's CD
 *    behavior ignores the scenario and the run's market.
 *
 *  - Slice K1: a book the run marked (`terms.walk`, ./corrections.ts)
 *    reads its zero curve off the path it is given, plus the run's funding
 *    spread held static, so the walk reacts to the scenario's shock of any
 *    shape and to the run's market through the one curve source every other
 *    instrument reads; and it walks at the documented $1 minimum live balance.
 *    `shockBp` stays a further parallel shock on that curve (0 in every run).
 *
 * Anti-fabrication guards:
 *  - run-off with a horizon shorter than the book's final maturity refuses
 *    (principal would silently vanish past the horizon);
 *  - renewals with a term missing from `offerSpreadByTerm` refuses at
 *    construction (the kernel would throw mid-walk anyway; this surfaces it
 *    with the position id before any number is produced).
 */
import type { Cashflow, CdBookRow, CdModelParams, Instrument, RatePath } from "@alm/kernel";
import { runCohortWalk } from "@alm/kernel";
import { cdCurveFromPath } from "./corrections";
import { resolveCdParams } from "./params";
import { CdAdapterError, validateCdTerms, type CdTerms } from "./terms";

/** Adapter configuration (run/scenario-level, deliberately NOT on the terms). */
export interface CdAdapterOptions {
  /** false (default) = run-off headline view; true = going-concern renewal chain. */
  renewals?: boolean;
  /** Parallel shock in bp on the SOFR leg of the kernel's all-in curve. Default 0. */
  shockBp?: number;
  /** Kernel model parameters; default is the vendored calibrated set. */
  params?: CdModelParams;
}

/** Scaled walk tail detail: what the horizon-truncated stream does not carry. */
export interface CdWalkDetail {
  /** Balance still live at the horizon, in `notional` dollars. */
  residualBalance: number;
  /** PV time for the residual stub, years (horizonMonths / 12). */
  residualTYears: number;
  /** Last month the walk produced a record for. */
  finalMonth: number;
}

export class CdBookInstrument {
  readonly terms: CdTerms;
  readonly renewals: boolean;
  readonly shockBp: number;
  readonly params: CdModelParams;

  constructor(terms: CdTerms, options: CdAdapterOptions = {}) {
    validateCdTerms(terms);
    const renewals = options.renewals ?? false;
    const shockBp = options.shockBp ?? 0;
    const params = options.params ?? resolveCdParams();
    if (!Number.isFinite(shockBp)) {
      throw new CdAdapterError(
        "cd-shock-invalid",
        `CD terms "${terms.id}": shockBp must be a finite number, got ${shockBp}`,
      );
    }
    if (!renewals && terms.maturityMonths > params.horizonMonths) {
      throw new CdAdapterError(
        "cd-horizon-short",
        `CD terms "${terms.id}": run-off view needs horizonMonths >= final maturity ` +
          `${terms.maturityMonths}, got ${params.horizonMonths} (principal past the ` +
          `horizon would be silently dropped)`,
      );
    }
    if (renewals) {
      for (const c of terms.cohorts) {
        if (params.offerSpreadByTerm[c.termMonths] === undefined) {
          throw new CdAdapterError(
            "cd-offer-spread-missing",
            `CD terms "${terms.id}": renewals view needs an offerSpreadByTerm entry ` +
              `for term ${c.termMonths}m and the parameter set has none`,
          );
        }
      }
    }
    this.terms = terms;
    this.renewals = renewals;
    this.shockBp = shockBp;
    // A book the run marked walks at the documented $1 minimum live balance.
    const minLive = terms.walk?.minLiveBalance;
    this.params = minLive === undefined ? params : { ...params, minLiveBalance: minLive };
  }

  /**
   * The parameters one walk reads. On a book marked for the scenario curve, the curve is read off
   * the path the walk is projected on, plus the run's funding spread (./corrections.ts); otherwise the parameters as
   * constructed, the original convention.
   */
  private paramsFor(path: RatePath | undefined): CdModelParams {
    const spread = this.terms.walk?.tlpSpreadByMonth;
    if (spread === undefined) return this.params;
    if (path === undefined) {
      throw new CdAdapterError("cd-path-missing", `CD terms "${this.terms.id}": the corrected walk reads the scenario's curve, so it needs the rate path`);
    }
    return { ...this.params, curve: cdCurveFromPath(this.terms, path, spread, this.renewals) };
  }

  /**
   * Fixed-rate to contractual maturity in the run-off view: no reset schedule,
   * matching the bullet it replaces. Renewal spawns in the
   * going-concern view are newly-originated instruments (the cd-eve
   * convention), not resets of this position, so they do not appear here.
   */
  repricingSchedule(): number[] {
    return [];
  }

  /**
   * Per-month cashflow schedule from the kernel cohort walk. Under the book
   * convention `path` is not read (module header); on a book marked for the
   * scenario curve the walk's curve is read off it.
   */
  generateCashflows(path: RatePath): Cashflow[] {
    const { book, bookTotal, unitScale } = this.bookRows();
    const params = this.paramsFor(path);
    const walk = runCohortWalk(book, this.shockBp, { renewals: this.renewals }, params);

    if (!this.renewals) {
      // Anti-fabrication guard: in run-off every cohort matures inside the
      // horizon (enforced at construction), so any residual beyond cull dust
      // (cohorts dropped at the minimum live balance) means principal is
      // missing from the stream.
      const dustTol =
        ((book.length + 1) * params.minLiveBalance) / params.walkScale;
      if (walk.residualBalance > dustTol) {
        throw new CdAdapterError(
          "cd-runoff-residual",
          `CD terms "${this.terms.id}": run-off walk left residual balance ` +
            `${walk.residualBalance} (stylized units) past month ${walk.finalMonth}; ` +
            `the stream would drop principal`,
        );
      }
    }

    // Row construction mirrors kernel cdCashflows operation-for-operation so
    // the shockBp = 0 stream is bit-identical to a direct kernel call.
    const rows: Cashflow[] = [];
    let opening = bookTotal;
    for (const rec of walk.records) {
      const principal = rec.earlyWithdrawal + rec.maturityOutflow;
      rows.push({
        monthOffset: rec.month,
        balance: opening * unitScale,
        principalPaid: principal * unitScale,
        interestPaid: rec.coupon * unitScale,
        couponRate: opening > 0 ? (rec.coupon * 12) / opening : 0,
      });
      opening = rec.survivingBalance;
    }
    return rows;
  }

  /**
   * Studio slice S3d fix round: the principal of `generateCashflows`, split into the contractual maturities (the balance
   * still there when a cohort matures) and the early withdrawals, per month, in notional dollars. Read by the liquidity
   * stress ladder, which rolls a renewal share of maturities only. `generateCashflows` is unchanged.
   */
  principalSplit(path: RatePath): Array<{ monthOffset: number; maturity: number; early: number }> {
    const { book, unitScale } = this.bookRows();
    const walk = runCohortWalk(book, this.shockBp, { renewals: this.renewals }, this.paramsFor(path));
    return walk.records.map((rec) => ({ monthOffset: rec.month, maturity: rec.maturityOutflow * unitScale, early: rec.earlyWithdrawal * unitScale }));
  }

  /**
   * The horizon tail the truncated stream does not carry, scaled to notional
   * dollars. Zero (to cull dust) in the run-off view; in the going-concern
   * view this is the renewal chain still live at the horizon, which any PV
   * consumer must account for explicitly.
   */
  walkDetail(path?: RatePath): CdWalkDetail {
    const { book, unitScale } = this.bookRows();
    const walk = runCohortWalk(book, this.shockBp, { renewals: this.renewals }, this.paramsFor(path));
    return {
      residualBalance: walk.residualBalance * unitScale,
      residualTYears: walk.residualTYears,
      finalMonth: walk.finalMonth,
    };
  }

  /** Kernel book rows plus the cdCashflows scaling constants. */
  private bookRows(): { book: CdBookRow[]; bookTotal: number; unitScale: number } {
    const book: CdBookRow[] = this.terms.cohorts.map((c) => ({
      termMonths: c.termMonths,
      monthsToMaturity: c.monthsToMaturity,
      balance: c.balance,
      contractRate: c.contractRate,
    }));
    let bookTotal = 0;
    for (const r of book) bookTotal += r.balance;
    const unitScale = bookTotal > 0 ? this.terms.notional / bookTotal : 0;
    return { book, bookTotal, unitScale };
  }
}

// Compile-time seam check: the adapter's `generateCashflows` and
// `repricingSchedule` must stay assignable to the kernel Instrument's own two
// members (terms carries the widened "cd" discriminant, which is the one
// deliberate difference the union widening absorbs). What it catches is a
// SIGNATURE change to those two. It does NOT catch a kernel that gains a third
// required member: `Pick` of two named members is blind to everything outside
// the pick, so a new member would surface at a call site or not at all.
type _CdSeamCheck = CdBookInstrument extends Pick<Instrument, "generateCashflows" | "repricingSchedule">
  ? true
  : never;
const _cdSeamCheck: _CdSeamCheck = true;
void _cdSeamCheck;
