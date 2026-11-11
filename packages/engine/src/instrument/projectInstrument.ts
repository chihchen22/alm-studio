/**
 * The single-instrument drill.
 *
 * ONE position, projected under one or more deterministic scenarios, returning
 * the monthly schedule the kernel produces and what that schedule is worth.
 * This is the drill a practitioner does first when test-driving a cash-flow
 * engine: the rate the instrument saw, the balance it carried, the principal
 * and interest it paid, and the PV, WAL and effective duration of that stream.
 *
 * PURE. No store, no clock, no I/O, no cache. It composes the seams the static
 * pass already uses and adds NO model:
 *
 *   curve     buildBaseCurve + shockedCurve      (scenario/rateEnvironment.ts)
 *   path      buildRatePath                      (scenario/rateEnvironment.ts)
 *   schedule  makeInstrument().generateCashflows  (runtime/instrumentFactory.ts)
 *   WAL       familyWalYears                     (portfolio/aggregate.ts)
 *   discount  discountFunction                   (eve/discount.ts)
 *
 * so a drilled month is the same month the same position contributes to a run.
 *
 * TWO DIFFERENCES from a run, both deliberate and both registered as gaps in
 * the spec's Section 9:
 *
 *  - the effective duration here is a TWO-SIDED BUMP OF ONE INSTRUMENT. It does
 *    NOT call computeEnvironmentDurations, which prices FAMILIES, and it does
 *    not apply the Non-IB NMD warmup re-leveling that module applies,
 *    so a non-interest-bearing deposit's drill duration can differ from its
 *    family duration in a run. The reply states the bump so a reader knows the
 *    measurement;
 *  - nothing is stored. A run id, a queue entry and an audit trail are what the
 *    plan path is for; this is a live read.
 *
 * TRUNCATION is the drill's, not the kernel's. The kernel instruments loop to
 * their own maturity and never read path.nSteps, so the horizon is applied here
 * exactly as run/shard/chunk.ts applies it to a run's buckets: a row survives
 * when 1 <= month <= horizonMonths, and a seasoned position's months are
 * shifted by seasoningOffsetOf first, so an elapsed month is dropped rather
 * than counted at the as-of date.
 *
 * A COMMITMENT IS REFUSED, not priced. An undrawn committed line is off balance
 * sheet and has no present value, so the drill raises ProjectInstrumentError on
 * `terms.type === "commitment"` rather than answering the negative PV its
 * negative draw stream discounts to. See the guard in projectInstrument for the
 * measured number and for why the discriminant is the position's terms.
 *
 * A SWAP IS ANSWERED: its net schedule, both leg schedules, its PV
 * on the risk-free curve (pvAllIn equals pvRiskFree) and a duration per unit of
 * notional, because a swap near par has a PV near zero to divide by.
 *
 * ABSENCE IS THE HONESTY RULE. walMonths and effectiveDuration are LEFT OUT
 * when they cannot be observed (no in-horizon principal; a zero base PV), never
 * 0 and never NaN.
 */
import {
  buildTLPCurve,
  DEFAULT_TLP_CURVE,
  type Cashflow,
  type MarketSnapshot,
  type RatePath,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import { COMMITMENT_INSTRUMENT_TYPE } from "../commitment/offBalanceSheet";
import { NON_RATE_INSTRUMENT_TYPE } from "../nonRate";
import type { AssumptionSet, BehavioralOverlay } from "../contracts/assumptions";
import type { DimensionBag } from "../contracts/dimensions";
import type { IndexHistoryEntry } from "../contracts/indexHistory";
import type { BalanceSheetSide, ProductFamilyId } from "../contracts/ids";
import type { PortfolioSpec, PositionTerms } from "../contracts/position";
import type { RateSpec, Scenario } from "../contracts/scenario";
import { discountFunction } from "../eve/discount";
import { selectorMatchesBag } from "../plan/dimensions";
import { MAX_HORIZON } from "../plan/typeGate";
import { familyWalYears } from "../portfolio/aggregate";
import { seasoningOffsetOf } from "../portfolio/seasoning";
import { applyOverlayToTerms, mergeHousingTerms } from "../projection/static/applyOverlays";
import { macroTargetKey, macroTargetsOf, resolveRunMacro, type RunMacro } from "../macro/runMacro";
import type { RateIndexTable } from "../contracts/rateIndex";
import { RateIndexRefusedError, checkRateIndexRefs } from "../rateIndex/resolve";
import { makeInstrument } from "../runtime/instrumentFactory";
import type { ModelConvention } from "../contracts/run";
import { modelConventionConfigError, modelCorrectionsOf } from "../corrections";
import { cdWalkMarkOf, markCdTerms } from "../cd/corrections";
import type { CdTerms } from "../cd/terms";
import { NotImplementedError } from "../runtime/notImplemented";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../scenario/rateEnvironment";
import { SWAP_INSTRUMENT_TYPE } from "../swap/derivatives";
import { SwapInstrument } from "../swap/swapInstrument";
import type { SwapTerms } from "../swap/terms";

/** Horizon the drill bounds the schedule and the path at when none is named. */
export const DRILL_DEFAULT_HORIZON_MONTHS = MAX_HORIZON;

/**
 * The longest horizon the drill will run: the plan type gate's own MAX_HORIZON,
 * imported rather than restated, so a drill and a run cannot disagree on what
 * is too long. The cap is not cosmetic. Every month asked for is a rate-path
 * step and a schedule row, allocated three times per scenario (the base
 * schedule plus the two duration bumps), so an unbounded horizon turns one
 * request into gigabytes inside the handler that serves it.
 */
export const DRILL_MAX_HORIZON_MONTHS = MAX_HORIZON;

/** Two-sided parallel bump, in bp, the effective duration is measured at. */
export const DRILL_DEFAULT_DURATION_BUMP_BP = 100;

/**
 * An argument the drill cannot run on. Distinct from NotImplementedError, which
 * says a LAYER does not exist: this says the caller's own number is not a
 * number the drill can use, and it names the field.
 */
export class ProjectInstrumentError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`projectInstrument: ${field} ${detail}`);
    this.name = "ProjectInstrumentError";
    this.field = field;
  }
}

export interface ProjectInstrumentInput {
  /** The position's terms, already resolved by the caller (picked or typed). */
  terms: PositionTerms;
  /** The family the position belongs to. Drives side and the overlay lookup. */
  familyId: ProductFamilyId;
  side: BalanceSheetSide;
  /** The market snapshot the curve is bootstrapped from. */
  marketSnapshot: MarketSnapshot;
  /** One or more scenarios, in request order. Each must be static new-business mode. */
  scenarios: Scenario[];
  /**
   * Optional. When present, every binding whose `familyId` matches, and whose
   * `selector` matches `dimensions`, applies to `terms` in binding order,
   * exactly as applyLicensedOverlays applies them to a book.
   */
  assumptions?: AssumptionSet;
  /**
   * The position's dimension bag, which a binding's selector is matched
   * against. A picked position carries the bag `dimensionsOf` derives; a TYPED
   * instrument carries none, and no selector matches an absent tag.
   */
  dimensions?: DimensionBag;
  /** Default 360. Bounds the schedule and the rate path. */
  horizonMonths?: number;
  /** Duration bump in bp, default 100. Restated in the reply. */
  durationBumpBp?: number;
  /** The index histories a lagged index on this position reads; the drill route passes every history the market names. */
  indexHistories?: IndexHistoryEntry[];
  /**
   * The model convention, applied to a CD book exactly as a run applies it (the run's mark,
   * ../cd/corrections.ts). Absent is the original convention, as on a run. A `walk` the terms carry is never read.
   */
  modelConvention?: ModelConvention;
}

export interface InstrumentScheduleRow {
  /** 1-based month from the as-of date. */
  month: number;
  /**
   * The 1M path rate the kernel read when it produced this row (the unshifted
   * step for a seasoned position), decimal annualised.
   */
  pathRate: number;
  /** Coupon or accrual rate applied this month, decimal annualised. */
  couponRate: number;
  /** Outstanding at the START of the month. */
  balance: number;
  principal: number;
  interest: number;
  /** principal + interest. */
  payment: number;
  /**
   * Studio A+E contract 8: the factors `pvOf` evaluates at month/12 and the
   * row's own PV, so a reader multiplies nothing. On a swap both carry the
   * risk-free leg.
   */
  discountFactorAllIn: number;
  discountFactorRiskFree: number;
  /** discountFactorAllIn * (principal + interest). */
  pvAllIn: number;
  /** discountFactorRiskFree * (principal + interest). */
  pvRiskFree: number;
}

/**
 * A schedule row before its discount factors are attached: what the kernel
 * cashflow and the swap netting produce. Exported for the netSwapLegs test only.
 */
export type BareScheduleRow = Omit<
  InstrumentScheduleRow,
  "discountFactorAllIn" | "discountFactorRiskFree" | "pvAllIn" | "pvRiskFree"
>;

export interface InstrumentScenarioProjection {
  scenarioId: string;
  rateSpec: RateSpec;
  rows: InstrumentScheduleRow[];
  /** Month offsets at which the coupon resets; [] for a fixed-rate instrument. */
  repricingMonths: number[];
  /** Principal-weighted average life in months, in-horizon; absent when in-horizon principal is not positive. */
  walMonths?: number;
  /** PV of principal + interest under the all-in discount (risk-free curve plus term liquidity premium). */
  pvAllIn: number;
  /** PV under the risk-free discount (no TLP). */
  pvRiskFree: number;
  /**
   * Effective duration from a plus and minus `durationBumpBp` parallel bump of
   * THIS scenario's path and discount: (pvDown - pvUp) / (2 * pvBase * bump).
   * Absent when pvBase is 0. One instrument, not a family: the Non-IB NMD
   * warmup re-leveling of the family duration engine is NOT applied.
   *
   * The bump here moves the ZERO CURVE and rebuilds the path from it, where the
   * family duration engine shifts the forward path additively (ParallelShockPath)
   * and the discount through shockCurve. A fixed coupon cannot tell the two
   * apart, but a floater's or a mortgage's coupon path moves by the FORWARD
   * IMAGE of a zero-curve shift, which is not exactly the bump, so a
   * rate-sensitive coupon's drill duration can differ in the small from the
   * same instrument's contribution to its family duration in a run.
   */
  effectiveDuration?: number;
  /**
   * A swap's two leg schedules, signed (receive positive, pay
   * negative). Present only for a swap; `rows` is then the NET schedule, and
   * `pvAllIn` equals `pvRiskFree`, because a swap's legs discount on the risk-free curve on every
   * basis.
   */
  legs?: { receive: InstrumentScheduleRow[]; pay: InstrumentScheduleRow[] };
  /**
   * "notional" for a swap, whose effectiveDuration is
   * (pvDown - pvUp) / (2 * notional * bump): a swap near par has a PV near
   * zero, so a duration per unit of its own PV would be noise.
   */
  durationBasis?: "notional";
  /**
   * Studio A+E contract 8: present only for a swap, whose rows and legs carry
   * the risk-free factor and PV in both the all-in and the risk-free fields.
   */
  discountBasisNote?: "swap: risk-free on both bases";
}

export interface ProjectInstrumentResult {
  /** The terms actually projected: the input terms after any overlay. */
  terms: PositionTerms;
  familyId: ProductFamilyId;
  side: BalanceSheetSide;
  horizonMonths: number;
  durationBumpBp: number;
  /**
   * The overlay kind that actually CHANGED the terms, or "none". A binding that
   * matched but handed back the terms object unchanged (`===` the input, which
   * is what the `cd-rollover` applier does, being new-business only with no
   * static-runoff effect) reports "none": the field says what moved this
   * schedule, not what the assumption set happened to name.
   */
  overlayApplied: BehavioralOverlay["kind"] | "none";
  byScenario: InstrumentScenarioProjection[];
  /** The model convention the drill ran, written only when the input named one. */
  modelConvention?: ModelConvention;
}

/**
 * Shallow copy, so the reply never aliases an object the caller still holds: a
 * caller that mutates its own terms or rate spec afterwards cannot reach back
 * into a projection it has already been given.
 */
function copyOf<T extends object>(value: T): T {
  return { ...value };
}

/** The all-in funding overlay: the snapshot's nodes, or the kernel default. */
function tlpFromSnapshot(snapshot: MarketSnapshot): TLPCurve {
  return snapshot.tlpNodes.length > 0 ? buildTLPCurve(snapshot.tlpNodes) : DEFAULT_TLP_CURVE;
}

/**
 * One kernel cashflow as a drill row landing on `month`. Shared by scheduleOn
 * and swapSchedulesOn, so a swap leg row and any other instrument's row are
 * built by the same code, field for field and in the same key order.
 */
function rowOf(cf: Cashflow, month: number, path: RatePath): BareScheduleRow {
  return {
    month,
    // The UNSHIFTED step: the kernel was handed the path as-is and read it in
    // instrument time, so the rate that set this coupon is the one at the
    // cashflow's own month offset, not at the as-of month it lands on.
    pathRate: path.rateAt(cf.monthOffset - 1),
    couponRate: cf.couponRate,
    balance: cf.balance,
    principal: cf.principalPaid,
    interest: cf.interestPaid,
    payment: cf.principalPaid + cf.interestPaid,
  };
}

/**
 * One instrument's in-horizon schedule on one curve. The seasoning shift and
 * the horizon truncation are the ones run/shard/chunk.ts applies.
 */
function scheduleOn(
  terms: PositionTerms,
  curve: ZeroCurve,
  horizonMonths: number,
  offsetMonths: number,
  rateIndices: RateIndexTable | undefined,
  macro: RunMacro,
): BareScheduleRow[] {
  const path: RatePath = buildRatePath(curve, horizonMonths);
  const rows: BareScheduleRow[] = [];
  for (const cf of makeInstrument(terms, { rateIndices, macro }).generateCashflows(path)) {
    const month = cf.monthOffset + offsetMonths;
    if (month < 1 || month > horizonMonths) continue;
    rows.push(rowOf(cf, month, path));
  }
  return rows;
}

/**
 * Refuse a schedule carrying a number that is not a number.
 *
 * ABSENCE is the honesty rule for what cannot be OBSERVED. A NaN is a different
 * thing: it is arithmetic that did not happen, and a row of NaNs answered as a
 * schedule is a wrong number wearing the shape of a right one. It reaches here
 * only from terms the kernel constructors do not themselves refuse (a coupon or
 * a margin that is NaN), so the check is on the schedule, where the damage
 * shows, and it covers every row field and both present values.
 */
function refuseNonFinite(
  rows: readonly BareScheduleRow[],
  pvAllIn: number,
  pvRiskFree: number,
): void {
  const bad =
    !Number.isFinite(pvAllIn) ||
    !Number.isFinite(pvRiskFree) ||
    rows.some(
      (r) =>
        !Number.isFinite(r.pathRate) ||
        !Number.isFinite(r.couponRate) ||
        !Number.isFinite(r.balance) ||
        !Number.isFinite(r.principal) ||
        !Number.isFinite(r.interest) ||
        !Number.isFinite(r.payment),
    );
  if (bad) {
    throw new ProjectInstrumentError(
      "terms",
      "the schedule carries a non-finite number; check the terms",
    );
  }
}

/** The same fold pvBucketedSeries runs: df((k+1)/12) over principal + interest. */
function pvOf(rows: readonly BareScheduleRow[], df: (tYears: number) => number): number {
  let pv = 0;
  for (const row of rows) pv += df(row.month / 12) * (row.principal + row.interest);
  return pv;
}

/**
 * Studio A+E contract 8: attach the factors pvOf evaluates at month/12 and the
 * row's own PV under each. The row PVs sum, in row order, to what pvOf answers
 * on the same factor, so the scenario PV and its rows cannot disagree.
 */
function withDiscounts(
  rows: readonly BareScheduleRow[],
  dfAllIn: (tYears: number) => number,
  dfRiskFree: (tYears: number) => number,
): InstrumentScheduleRow[] {
  return rows.map((r): InstrumentScheduleRow => {
    const a = dfAllIn(r.month / 12);
    const f = dfRiskFree(r.month / 12);
    return {
      ...r,
      discountFactorAllIn: a,
      discountFactorRiskFree: f,
      pvAllIn: a * (r.principal + r.interest),
      pvRiskFree: f * (r.principal + r.interest),
    };
  });
}

/** WAL in months off the row principal, or undefined when there is none to weight. */
function walMonthsOf(
  rows: readonly BareScheduleRow[],
  horizonMonths: number,
): number | undefined {
  const principal = new Array<number>(horizonMonths).fill(0);
  for (const row of rows) principal[row.month - 1] += row.principal;
  const years = familyWalYears(principal);
  return years === undefined ? undefined : years * 12;
}

/**
 * A swap's net, receive and pay schedules on one curve. Both legs
 * carry the same months, so the net row is receive plus pay, month for month:
 * the same sum, in the same fields, the run's family series accumulates. A
 * swap carries no seasoning (validateSwapTerms refuses it), so a row lands on
 * its own month offset.
 */
function swapSchedulesOn(
  terms: SwapTerms,
  curve: ZeroCurve,
  horizonMonths: number,
): { net: BareScheduleRow[]; receive: BareScheduleRow[]; pay: BareScheduleRow[] } {
  const path: RatePath = buildRatePath(curve, horizonMonths);
  const receive: BareScheduleRow[] = [];
  const pay: BareScheduleRow[] = [];
  for (const cf of new SwapInstrument(terms).generateCashflows(path)) {
    if (cf.monthOffset < 1 || cf.monthOffset > horizonMonths) continue;
    (cf.leg === "receive" ? receive : pay).push(rowOf(cf, cf.monthOffset, path));
  }
  return { net: netSwapLegs(receive, pay), receive, pay };
}

/**
 * The net schedule of a swap: receive plus pay, month for month. Exported for
 * its guard's test only. The legs must be the same length and carry the same
 * months; a length mismatch is refused before pairing, so a longer pay leg's
 * tail is never dropped and a shorter one never reads past its end.
 */
export function netSwapLegs(
  receive: readonly BareScheduleRow[],
  pay: readonly BareScheduleRow[],
): BareScheduleRow[] {
  if (receive.length !== pay.length) {
    throw new ProjectInstrumentError(
      "terms",
      `swap legs disagree in length: ${receive.length} receive rows versus ${pay.length} pay rows`,
    );
  }
  return receive.map((r, i): BareScheduleRow => {
    const p = pay[i]!;
    if (p.month !== r.month) {
      throw new ProjectInstrumentError("terms", `swap legs disagree on month ${r.month} versus ${p.month}`);
    }
    return {
      month: r.month,
      pathRate: r.pathRate,
      couponRate: r.couponRate - p.couponRate,
      balance: r.balance + p.balance,
      principal: r.principal + p.principal,
      interest: r.interest + p.interest,
      payment: r.payment + p.payment,
    };
  });
}

/** The drill's answer for a swap. See InstrumentScenarioProjection.legs. */
function projectSwap(
  input: ProjectInstrumentInput,
  terms: SwapTerms,
  horizonMonths: number,
  durationBumpBp: number,
): ProjectInstrumentResult {
  if (input.assumptions?.bindings.some((b) => b.familyId === input.familyId)) {
    throw new ProjectInstrumentError(
      "assumptions",
      `bind an overlay to family "${input.familyId}", which holds a swap; no behavioral overlay binds ` +
        `to a swap family, because both legs are contractual`,
    );
  }
  const base = buildBaseCurve(input.marketSnapshot);
  const tlp = tlpFromSnapshot(input.marketSnapshot);
  const bumpUp: RateSpec = { kind: "parallel", shockBp: durationBumpBp };
  const bumpDown: RateSpec = { kind: "parallel", shockBp: -durationBumpBp };
  const repricingMonths = new SwapInstrument(terms)
    .repricingSchedule()
    .filter((m) => m >= 1 && m <= horizonMonths);

  const byScenario = input.scenarios.map((scenario): InstrumentScenarioProjection => {
    const curve = shockedCurve(base, scenario.rateSpec);
    const { net, receive, pay } = swapSchedulesOn(terms, curve, horizonMonths);
    const dfR = discountFunction(curve, tlp, 0, "risk-free");
    const pvRiskFree = pvOf(net, dfR);
    refuseNonFinite([...net, ...receive, ...pay], pvRiskFree, pvRiskFree);
    const curveUp = shockedCurve(curve, bumpUp);
    const curveDown = shockedCurve(curve, bumpDown);
    const pvUp = pvOf(swapSchedulesOn(terms, curveUp, horizonMonths).net, discountFunction(curveUp, tlp, 0, "risk-free"));
    const pvDown = pvOf(swapSchedulesOn(terms, curveDown, horizonMonths).net, discountFunction(curveDown, tlp, 0, "risk-free"));
    return {
      scenarioId: scenario.id,
      rateSpec: copyOf(scenario.rateSpec),
      rows: withDiscounts(net, dfR, dfR),
      repricingMonths: [...repricingMonths],
      pvAllIn: pvRiskFree,
      pvRiskFree,
      effectiveDuration: (pvDown - pvUp) / (2 * terms.notional * (durationBumpBp / 1e4)),
      durationBasis: "notional",
      legs: { receive: withDiscounts(receive, dfR, dfR), pay: withDiscounts(pay, dfR, dfR) },
      discountBasisNote: "swap: risk-free on both bases",
    };
  });

  return {
    terms: copyOf(terms) as unknown as PositionTerms,
    familyId: input.familyId,
    side: input.side,
    horizonMonths,
    durationBumpBp,
    overlayApplied: "none",
    byScenario,
  };
}

/**
 * The terms the drill actually projects, and the kind that got them there.
 *
 * The selection rule is applyLicensedOverlays' own, narrowed to one position:
 * a binding applies when its familyId is the position's and its selector (if
 * it carries one) matches the bag. Several matching bindings apply in BINDING
 * ORDER; `overlayApplied` then names the LAST kind that CHANGED the terms,
 * because the field is one string and the terms are what the reply actually
 * carries. A kind whose applier returned the terms unchanged did not move this
 * schedule and is not named; "none" is then the honest answer. The type
 * mismatch StaticOverlayError raises propagates: an overlay that cannot drive
 * this instrument is a misconfigured request, never a silent no-op.
 *
 * It is the APPLY half only. A run reaches applyLicensedOverlays through
 * resolveAssumptions, which validates the overlay parameters and refuses an
 * unknown family, and through checkBindingOverlap, which refuses two bindings
 * of one kind on one family; both read the chart of accounts, which the drill
 * does not hold. So a set the run would refuse can still be drilled, and the
 * numbers it returns are the numbers those bindings produce in the order they
 * are written, not a claim that the set is well formed. A caller that does
 * hold a book runs checkBindingOverlap(portfolio, set) before calling here;
 * the typed-instrument path has no book to check against and stays
 * unvalidated, which the spec registers as a gap.
 */
function resolveTerms(input: ProjectInstrumentInput, mapped: ReadonlySet<string>): {
  terms: PositionTerms;
  overlayApplied: BehavioralOverlay["kind"] | "none";
} {
  const set = input.assumptions;
  if (set === undefined) return { terms: input.terms, overlayApplied: "none" };
  const bag: DimensionBag = input.dimensions ?? {};
  let terms = input.terms;
  let overlayApplied: BehavioralOverlay["kind"] | "none" = "none";
  for (const binding of set.bindings) {
    if (binding.familyId !== input.familyId) continue;
    if (!selectorMatchesBag(binding.selector, bag)) continue;
    // The housing group reaches the terms only for a mapped family and selector.
    const next = mergeHousingTerms(applyOverlayToTerms(terms, binding.overlay, terms.id), binding.overlay,
      mapped.has(macroTargetKey(binding.familyId, binding.selector)));
    // IDENTITY means the applier was a no-op on a static-runoff schedule
    // (cd-rollover is new business only), so naming its kind would claim a
    // change the rows do not carry.
    if (next !== terms) overlayApplied = binding.overlay.kind;
    terms = next;
  }
  return { terms, overlayApplied };
}

/**
 * Project one instrument under one or more scenarios. Pure; deterministic; the
 * same input produces byte-identical JSON.
 */
export function projectInstrument(input: ProjectInstrumentInput): ProjectInstrumentResult {
  const horizonMonths = input.horizonMonths ?? DRILL_DEFAULT_HORIZON_MONTHS;
  if (!Number.isInteger(horizonMonths) || horizonMonths <= 0) {
    throw new ProjectInstrumentError(
      "horizonMonths",
      `must be a positive integer number of months, got ${String(input.horizonMonths)}`,
    );
  }
  if (horizonMonths > DRILL_MAX_HORIZON_MONTHS) {
    throw new ProjectInstrumentError(
      "horizonMonths",
      `must be at most ${DRILL_MAX_HORIZON_MONTHS} months, the cap the plan type gate applies ` +
        `to a run, got ${String(horizonMonths)}`,
    );
  }
  const durationBumpBp = input.durationBumpBp ?? DRILL_DEFAULT_DURATION_BUMP_BP;
  if (!Number.isFinite(durationBumpBp) || durationBumpBp <= 0) {
    throw new ProjectInstrumentError(
      "durationBumpBp",
      `must be a positive finite number of basis points, got ${String(input.durationBumpBp)}`,
    );
  }
  if (input.modelConvention !== undefined) {
    const problem = modelConventionConfigError(input.modelConvention, "modelConvention");
    if (problem !== undefined) throw new ProjectInstrumentError("modelConvention", problem.slice("modelConvention ".length));
  }
  if (input.scenarios.length === 0) {
    throw new ProjectInstrumentError(
      "scenarios",
      "must carry at least one scenario: a drill with nothing to project has no reply to give",
    );
  }
  // The static-runoff refusal, character for character as projectStaticScenario
  // raises it, so a caller cannot tell the drill's refusal from a run's.
  for (const s of input.scenarios) {
    if (s.newBusiness.mode !== "static") {
      throw new NotImplementedError(
        "projection.static",
        `scenario "${s.id}" has new-business mode "${s.newBusiness.mode}"; ` +
          `static runoff requires mode "static" (dynamic reinvestment is the dynamic projection module)`,
      );
    }
  }

  // AN UNDRAWN COMMITTED LINE HAS NO PRICE. It is off
  // balance sheet: the bank does not own the money, it is obliged to hand it
  // over if the borrower asks, and the engine books the cash going out and not
  // the resulting asset. So there is no present value to discount and no
  // duration to bump. Without this refusal the drill priced one anyway:
  // CommitmentInstrument emits `principalPaid: -draw`, so pvOf answers a
  // NEGATIVE pvAllIn, and that number being finite and non-zero let the bump
  // report an effectiveDuration measured off it. Measured on a 50,000,000 line
  // with a 0.35 / 0.20 / 0.02 draw path: pvAllIn -40,382,141.42, duration
  // 0.9156. No throw, a plausible-looking number, which is the defect class
  // this piece caught three times.
  //
  // THE DISCRIMINANT IS THE POSITION'S `terms.type`, not a family's
  // `instrumentType`, and for the same reason `gap/gapEngine.ts` uses it: the
  // drill holds terms and no family definition. `commitment/offBalanceSheet.ts`
  // states the invariant under which the two readings agree.
  //
  // The route's TYPED path already refused this, because its ENGINE_TYPES list
  // carries no `commitment`; its PICK path did not, because a stored position's
  // terms are taken as validated at intake. The refusal belongs HERE, in the
  // function that must not answer a PV, so both paths and every other caller
  // agree rather than one of them.
  if ((input.terms.type as string) === NON_RATE_INSTRUMENT_TYPE) {
    throw new ProjectInstrumentError(
      "terms",
      `carry type "${NON_RATE_INSTRUMENT_TYPE}", a balance held at book value: it pays nothing, repays nothing and is ` +
        `valued at par in every scenario, so the drill has no schedule to project and no duration to measure.`,
    );
  }
  if (input.terms.type === COMMITMENT_INSTRUMENT_TYPE) {
    throw new ProjectInstrumentError(
      "terms",
      `carry type "${COMMITMENT_INSTRUMENT_TYPE}", which is off balance sheet and has no ` +
        `present value and no duration, so the drill has nothing to price. A line's draws are ` +
        `observable as an OUTFLOW, through the lcr-scenario, lcr-regulatory and ` +
        `survival-horizon metrics on the plan route.`,
    );
  }

  // Resolve the position's rate index against the market the
  // drill prices on, before any number. A floater naming an index this market
  // does not carry is refused, never priced on the one-month benchmark, and a
  // swap or any other type carrying the key is refused the same way (only a
  // floating loan resets on a rate index). The table is built from this one
  // position, so the refusal text is the run's, with "the run's market" as the
  // market name (the drill holds a snapshot, not its catalog id).
  const indexCheck = checkRateIndexRefs(
    { positions: [{ id: input.terms.id, familyId: input.familyId, coaNodeId: input.familyId, terms: input.terms }] } as unknown as PortfolioSpec,
    input.marketSnapshot,
    undefined,
    input.indexHistories ?? [],
  );
  if (indexCheck.message !== undefined) {
    throw new RateIndexRefusedError(indexCheck.message, indexCheck.first!.positionId, indexCheck.first!.rateIndexId);
  }
  const rateIndices = indexCheck.table;
  // The drill resolves the set's macro mapping on this market, as a run
  // with one base scenario on that set would, and refuses as the run refuses.
  // With no set, the resolver finds no base set and answers NO_MACRO itself (rule 1).
  const macro = resolveRunMacro({
    scenarios: [{ id: "drill", rateSpec: { kind: "base" }, assumptionSetId: input.assumptions?.id ?? "" }],
    assumptionSets: input.assumptions === undefined ? [] : [input.assumptions],
    grid: { horizonMonths },
  }, input.marketSnapshot);

  // A SWAP HAS A PRICE, unlike an undrawn line: it is answered, on
  // the risk-free curve, with both legs, and a duration per unit of notional. See projectSwap.
  // The discriminant is terms.type, for the reason the commitment guard gives.
  if (input.terms.type === SWAP_INSTRUMENT_TYPE) {
    return projectSwap(input, input.terms as SwapTerms, horizonMonths, durationBumpBp);
  }

  const { terms: resolved, overlayApplied } = resolveTerms(input, new Set(macroTargetsOf(macro).map((t) => macroTargetKey(t.familyId, t.selector))));
  const base = buildBaseCurve(input.marketSnapshot);
  const tlp = tlpFromSnapshot(input.marketSnapshot);
  // A CD book walks under the drill's model convention, marked as a run marks it; any `walk`
  // the terms carried is dropped first (M2). Every other type is projected as resolved.
  const isCd = (resolved.type as string) === "cd";
  const terms: PositionTerms = isCd
    ? (markCdTerms(resolved as unknown as CdTerms, cdWalkMarkOf(modelCorrectionsOf(input.modelConvention), tlp)) as unknown as PositionTerms)
    : resolved;
  const offsetMonths = seasoningOffsetOf(terms);
  const bumpUp: RateSpec = { kind: "parallel", shockBp: durationBumpBp };
  const bumpDown: RateSpec = { kind: "parallel", shockBp: -durationBumpBp };
  const repricingMonths = makeInstrument(terms, { rateIndices, macro })
    .repricingSchedule()
    .map((m) => m + offsetMonths)
    .filter((m) => m >= 1 && m <= horizonMonths);

  const byScenario = input.scenarios.map((scenario): InstrumentScenarioProjection => {
    const curve = shockedCurve(base, scenario.rateSpec);
    const rows = scheduleOn(terms, curve, horizonMonths, offsetMonths, rateIndices, macro);
    const dfA = discountFunction(curve, tlp, 0, "all-in");
    const dfR = discountFunction(curve, tlp, 0, "risk-free");
    const pvAllIn = pvOf(rows, dfA);
    const pvRiskFree = pvOf(rows, dfR);
    const walMonths = walMonthsOf(rows, horizonMonths);
    refuseNonFinite(rows, pvAllIn, pvRiskFree);

    // The bump composes ON TOP of this scenario's own spec, so a twist or a
    // custom vector is bumped in parallel about its own shocked curve.
    let effectiveDuration: number | undefined;
    // Finite AND non-zero: refuseNonFinite already refuses a NaN base PV, and
    // the belt-and-braces guard here is what keeps every OTHER caller of this
    // pure function from receiving a NaN under a present effectiveDuration key.
    if (Number.isFinite(pvAllIn) && pvAllIn !== 0) {
      const curveUp = shockedCurve(curve, bumpUp);
      const curveDown = shockedCurve(curve, bumpDown);
      const pvUp = pvOf(
        scheduleOn(terms, curveUp, horizonMonths, offsetMonths, rateIndices, macro),
        discountFunction(curveUp, tlp, 0, "all-in"),
      );
      const pvDown = pvOf(
        scheduleOn(terms, curveDown, horizonMonths, offsetMonths, rateIndices, macro),
        discountFunction(curveDown, tlp, 0, "all-in"),
      );
      effectiveDuration = (pvDown - pvUp) / (2 * pvAllIn * (durationBumpBp / 1e4));
    }

    return {
      scenarioId: scenario.id,
      rateSpec: copyOf(scenario.rateSpec),
      rows: withDiscounts(rows, dfA, dfR),
      repricingMonths: [...repricingMonths],
      ...(walMonths !== undefined ? { walMonths } : {}),
      pvAllIn,
      pvRiskFree,
      ...(effectiveDuration !== undefined ? { effectiveDuration } : {}),
    };
  });

  return {
    // The terms as resolved, without the run's mark: the mark is the convention's, not the position's.
    terms: copyOf(isCd ? (markCdTerms(resolved as unknown as CdTerms, undefined) as unknown as PositionTerms) : resolved),
    familyId: input.familyId,
    side: input.side,
    horizonMonths,
    durationBumpBp,
    overlayApplied,
    byScenario,
    ...(input.modelConvention !== undefined ? { modelConvention: input.modelConvention } : {}),
  };
}
