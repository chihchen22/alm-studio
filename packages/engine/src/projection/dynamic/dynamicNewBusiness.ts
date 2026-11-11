/**
 * Dynamic new-business and reinvestment projection engine.
 *
 * Given a portfolio and a scenario whose NewBusinessStrategy.mode is "dynamic",
 * project the existing book's runoff (exactly the static engine) AND originate
 * new-instrument tranches that reinvest that runoff, priced at the reinvestment
 * index plus a spread. New-business cash flows land in the SAME per-family and
 * COA accumulators the static runoff fills; the sum is what drives projected NII
 * (architecture Section 4: "one field, not two engines").
 *
 * The three reinvestment modes (scenario.ts NewBusinessRule.reinvest):
 *   - "runoff": each month originate exactly the principal that ran off in the
 *     prior month (existing book plus already-originated tranches). Self-funding.
 *   - "flat":   hold the family balance at its month-zero level.
 *   - "growth": grow the family balance at monthlyGrowthRate per month.
 *
 * Achievability and the honest shortfall. New business can only be ORIGINATED;
 * the strategy never forces an existing position to mature early or be sold. So
 * a target BELOW the book's natural runoff trajectory (a declining target the
 * book does not run off fast enough to reach) cannot be hit without disposals:
 * origination clamps at zero, the balance stays above target, and the gap is
 * reported as a FamilyShortfall, never silently absorbed (a silent under-hit
 * is a rejected behavior). Flat and non-negative growth are always
 * reachable (top up the deficit), so they never shortfall.
 *
 * New tranches are kernel instruments built through the m01 factory: this module
 * writes no cash-flow math of its own. The reinvestment vehicle is a fixed-rate
 * bullet at the reinvestment index plus spread (see fixedBulletTranche); its
 * per-month interest and its maturity principal are the kernel's, bucketed here
 * with an origination-month shift the aggregator does not itself apply.
 *
 * A rule that carries a product template mints its
 * tranches through templateTranche.ts instead (fixed or floating; bullet,
 * level-pay or linear), each generated on the scenario path shifted to its own
 * origination month (forwardStart.ts). A rule without one runs the code above,
 * unchanged, so every stored result keeps its bytes.
 *
 * A template with `behavior: "family"` mints
 * tranches that carry the family's own behavioral model (familyBehavior.ts),
 * aged from their origination. The sweep needs no new sizing rule: it already
 * sizes each month's origination against the running balance, and a behavioral
 * tranche's balance already carries its prepayment or decay, so the runoff the
 * behavior creates is replaced like any other runoff.
 *
 * Determinism: no clock, no RNG. Coupons come from the scenario's rate path,
 * cash flows from the kernel, and every reduction runs in fixed index order.
 * Same inputs -> byte-identical result.
 */
import { isNonRateFamily } from "../../nonRate";
import {
  makeInstrument,
} from "../../runtime/instrumentFactory";
import { NotImplementedError } from "../../runtime/notImplemented";
import { isDerivativeFamily } from "../../swap/derivatives";
import { aggregateScenario } from "../../portfolio/aggregate";
import type { BehavioralRegistry } from "../../plugins/services";
import { applyStaticOverlays } from "../static";
import type { Cashflow, FixedLoanTerms, Instrument, RatePath, TLPCurve } from "@alm/kernel";
import { ForwardStartPath } from "./forwardStart";
import { templateTranche } from "./templateTranche";
import { behaviorNoteOf, familyBehavior, type FamilyBehavior } from "./familyBehavior";
import { DEFAULT_NEW_BUSINESS_TERM_MONTHS } from "../../plan/newVolumeTemplate";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { ChartOfAccounts, ProductFamilyDef } from "../../contracts/chartOfAccounts";
import type { CoaNodeId, ProductFamilyId } from "../../contracts/ids";
import type { PortfolioSpec } from "../../contracts/position";
import type { RateIndexTable } from "../../contracts/rateIndex";
import { NO_MACRO, macroTargetsOf, type RunMacro } from "../../macro/runMacro";
import type {
  BucketedSeries,
  BucketGrid,
  FamilyNewBusiness,
  NewVolumeProduct,
  ScenarioCashflows,
} from "../../contracts/results";
import type { NewBusinessRule, Scenario } from "../../contracts/scenario";

/** Default reinvestment tranche term when a rule omits termMonths (60; defined beside the template rule). */
export { DEFAULT_NEW_BUSINESS_TERM_MONTHS };

/**
 * Below this dollar magnitude an origination (or a target overshoot) is treated
 * as zero: it filters floating-point dust from the balance recursion so the
 * sweep does not mint negligible tranches or spurious shortfalls.
 */
const ORIGINATION_EPS = 1e-6;

/**
 * The reinvestment coupon locked at origination: the path's index rate for the
 * tranche term plus the rule's spread. The index is the par forward-swap rate
 * over the tranche tenor (RatePath.forwardRateAt), the same convention the
 * deterministic path uses for every other term driver. Coupon = index + spread,
 * exactly, at origination — the acceptance property the tests pin.
 */
export function reinvestmentCoupon(
  path: RatePath,
  originationStep: number,
  termMonths: number,
  spreadOverIndexBp: number,
): number {
  const index = path.forwardRateAt(originationStep, termMonths / 12);
  return index + spreadOverIndexBp / 1e4;
}

/**
 * The family balance a rule targets at bucket k, from its opening balance b0: b0 for "flat", b0 (1 + g)^k for
 * "growth" (g the monthly growth rate), null for "runoff" (origination is last month's run-off, no balance target).
 * One steady rate per family is the only shape a rule carries. Exported so the guided New volume step draws
 * the very path the sweep aims at, read from the engine rather than restated.
 */
export function reinvestmentTarget(reinvest: NewBusinessRule["reinvest"], b0: number, monthlyGrowthRate: number, k: number): number | null {
  switch (reinvest) {
    case "flat":
      return b0;
    case "growth":
      return b0 * Math.pow(1 + monthlyGrowthRate, k);
    case "runoff":
      return null; // runoff-driven: origination is last month's runoff, no balance target
  }
}

/**
 * A reinvestment tranche as fixed-rate bullet terms. Bullet, because the
 * reinvestment vehicle in an NII projection is a representative fixed-term
 * instrument earning the reinvestment rate: it holds its notional until
 * maturity, then that principal itself becomes runoff the sweep reinvests. The
 * id encodes the family and origination bucket so two runs mint identical terms.
 */
function fixedBulletTranche(
  family: ProductFamilyDef,
  originationBucket: number,
  notional: number,
  coupon: number,
  termMonths: number,
): FixedLoanTerms {
  return {
    id: `${family.id}~nb~${originationBucket}`,
    type: "fixed-loan",
    label: `${family.label} new business @${originationBucket}`,
    notional,
    maturityMonths: termMonths,
    originationOffsetMonths: 0,
    amortType: "bullet",
    coupon,
    side: family.side === "liability" ? "liability" : "asset",
  };
}

/** Raw typed-array triple for one family's new-business contribution. */
export interface SeriesDelta {
  balance: Float64Array;
  principal: Float64Array;
  interest: Float64Array;
}

/**
 * One family's reinvestment target under-hit. Populated only when the target
 * could not be reached without disposing of existing positions; a null result
 * from the sweep means every month's target was met.
 */
export interface FamilyShortfall {
  familyId: ProductFamilyId;
  reinvest: NewBusinessRule["reinvest"];
  /** First bucket where origination was clamped to zero (target unreachable). */
  firstBucket: number;
  /** Count of buckets whose target the strategy could not hit. */
  clampedBuckets: number;
  /** Target family balance at the final bucket. */
  targetBalanceEnd: number;
  /** Achieved family balance at the final bucket. */
  achievedBalanceEnd: number;
  /**
   * achievedBalanceEnd - targetBalanceEnd. Positive means the book was held
   * ABOVE a declining target the runoff could not reach without disposals.
   */
  balanceGapEnd: number;
}

/** The sweep's output for one family: its new-business delta plus diagnostics. */
export interface FamilyReinvestment {
  delta: SeriesDelta;
  /** Origination notional written at each bucket (0 where none). */
  originations: Float64Array;
  shortfall: FamilyShortfall | null;
  /**
   * The first month's coupon of the tranche minted at each bucket, null where none. Written only when the
   * sweep was asked to record (a scenario whose rules carry a template).
   */
  couponAtOrigination?: Array<number | null>;
  /** Every tranche minted, in bucket order, kept only when asked (the base scenario's FTP reads them). */
  tranches?: SweptTranche[];
}

/** One tranche the sweep minted, as the FTP block prices it at its origination. */
export interface SweptTranche {
  familyId: ProductFamilyId;
  /** The origination bucket k: month 1 of the tranche is bucket k. */
  bucket: number;
  notional: number;
  instrument: Instrument;
  /** The scenario path shifted to the origination month, the path the tranche's own months read. */
  path: RatePath;
}

/** What the sweep records beside the delta. Absent, the sweep records nothing new. */
export interface SweepRecording {
  /** Write couponAtOrigination. */
  coupons: boolean;
  /** Keep every tranche minted. */
  tranches: boolean;
}

/**
 * The reinvestment sweep for one family. Walks buckets forward, deciding each
 * month's origination against the family's TOTAL running series (existing book
 * plus every tranche already originated), then adds the new tranche's kernel
 * cash flows both to that running series (so later months see its runoff) and to
 * the returned new-business-only delta.
 *
 * The origination at bucket k reinvests bucket-(k-1) runoff: a tranche minted at
 * k starts contributing balance at bucket k, so its cash flow at kernel
 * monthOffset m lands in bucket k + m - 1. This is the same integer month shift
 * the aggregator applies (bucket = monthOffset - 1) composed with the tranche's
 * origination bucket; the kernel instruments ignore originationOffsetMonths, so
 * the shift lives here.
 */
export function sweepFamilyReinvestment(
  baseSeries: BucketedSeries,
  rule: NewBusinessRule,
  path: RatePath,
  family: ProductFamilyDef,
  horizon: number,
  record?: SweepRecording,
  /** The run's term liquidity premium curve, read by a matched fixed template only (fix round M3). */
  tlp?: TLPCurve,
  /** The family's model, read by a template with `behavior: "family"` only. */
  behavior?: FamilyBehavior,
): FamilyReinvestment {
  // Running family totals: existing book, grown as tranches are added. Interest
  // is not a decision input, so only balance and principal are tracked running.
  const runBalance = Float64Array.from(baseSeries.balance);
  const runPrincipal = Float64Array.from(baseSeries.principal);

  const dBalance = new Float64Array(horizon);
  const dPrincipal = new Float64Array(horizon);
  const dInterest = new Float64Array(horizon);
  const originations = new Float64Array(horizon);

  const termMonths = rule.termMonths ?? DEFAULT_NEW_BUSINESS_TERM_MONTHS;
  const spreadBp = rule.spreadOverIndexBp ?? 0;
  const b0 = baseSeries.balance[0];
  const growth = rule.monthlyGrowthRate ?? 0;

  const targetBalance = (k: number): number | null => reinvestmentTarget(rule.reinvest, b0, growth, k);

  let firstClamp = -1;
  let clampedBuckets = 0;
  const coupons: Array<number | null> | undefined = record?.coupons === true ? new Array<number | null>(horizon).fill(null) : undefined;
  const kept: SweptTranche[] | undefined = record?.tranches === true ? [] : undefined;
  const template = rule.template;

  for (let k = 1; k < horizon; k++) {
    let origination: number;
    if (rule.reinvest === "runoff") {
      origination = runPrincipal[k - 1];
    } else {
      const target = targetBalance(k) as number;
      const desired = target - runBalance[k];
      if (desired < -ORIGINATION_EPS) {
        // Target sits below the achievable balance and the strategy will not
        // dispose: clamp origination, let the balance overshoot, record the gap.
        if (firstClamp < 0) firstClamp = k;
        clampedBuckets++;
        continue;
      }
      origination = desired;
    }
    if (origination <= ORIGINATION_EPS) continue;

    originations[k] = origination;
    let cfs: Cashflow[];
    if (template === undefined) {
      // Today's rule, the code it always ran: a fixed bullet reads no rate after origination, so the scenario path
      // from step 0 is harmless here (the coupon is locked from step k above).
      const coupon = reinvestmentCoupon(path, k, termMonths, spreadBp);
      const terms = fixedBulletTranche(family, k, origination, coupon, termMonths);
      // A fixed bullet carries no housing group; the sentinel states it.
      const inst = makeInstrument(terms, { macro: NO_MACRO });
      cfs = inst.generateCashflows(path);
      if (kept !== undefined) kept.push({ familyId: family.id, bucket: k, notional: origination, instrument: inst, path: new ForwardStartPath(path, k) });
    } else {
      // The template tranche reads the path from its own origination month (forwardStart.ts).
      const t = templateTranche(family, k, origination, termMonths, spreadBp, template, path, tlp, behavior);
      cfs = t.instrument.generateCashflows(t.path);
      if (kept !== undefined) kept.push({ familyId: family.id, bucket: k, notional: origination, instrument: t.instrument, path: t.path });
    }
    if (coupons !== undefined) coupons[k] = cfs[0]?.couponRate ?? null;
    for (let c = 0; c < cfs.length; c++) {
      const cf = cfs[c];
      const bucket = k + cf.monthOffset - 1;
      if (bucket < 0 || bucket >= horizon) continue; // explicit horizon truncation
      runBalance[bucket] += cf.balance;
      runPrincipal[bucket] += cf.principalPaid;
      dBalance[bucket] += cf.balance;
      dPrincipal[bucket] += cf.principalPaid;
      dInterest[bucket] += cf.interestPaid;
    }
  }

  let shortfall: FamilyShortfall | null = null;
  if (firstClamp >= 0) {
    const end = horizon - 1;
    const targetEnd = targetBalance(end) as number;
    shortfall = {
      familyId: family.id,
      reinvest: rule.reinvest,
      firstBucket: firstClamp,
      clampedBuckets,
      targetBalanceEnd: targetEnd,
      achievedBalanceEnd: runBalance[end],
      balanceGapEnd: runBalance[end] - targetEnd,
    };
  }

  return {
    delta: { balance: dBalance, principal: dPrincipal, interest: dInterest },
    originations,
    shortfall,
    ...(coupons !== undefined ? { couponAtOrigination: coupons } : {}),
    ...(kept !== undefined ? { tranches: kept } : {}),
  };
}

/** A dynamic scenario paired with its shocked rate path and optional overlays. */
export interface DynamicScenarioLeg {
  scenario: Scenario;
  /** The scenario's shocked path; build it with buildScenarioRatePath (m05). */
  ratePath: RatePath;
  /** Behavioral overlays applied to the EXISTING book before reinvestment. */
  assumptions?: AssumptionSet;
}

/** A dynamic projection: the combined cash flows plus any reported shortfalls. */
export interface DynamicScenarioResult {
  cashflows: ScenarioCashflows;
  /** Families whose reinvestment target could not be reached without disposals. */
  shortfalls: FamilyShortfall[];
  /**
   * Origination notional the sweep wrote at each bucket, one entry per ruled
   * family in the portfolio's declared family order (Studio A+E contract 24).
   * Always present on the projection result; the run envelope carries it only
   * on a dynamic scenario.
   */
  originations: FamilyNewBusiness[];
  /**
   * Every tranche minted, in family then bucket order, when the caller asked to keep them and the scenario's
   * rules carry a template (the base scenario's FTP prices them). Absent otherwise.
   */
  tranches?: SweptTranche[];
  /** Every tranche minted, in family then bucket order, when the caller asked (`keepAllTranches`). */
  allTranches?: SweptTranche[];
}

/** Options a caller may pass to projectDynamicScenario. */
export interface DynamicProjectionOptions {
  /** Keep every minted tranche on the result (the run keeps the base scenario's for FTP). */
  keepTranches?: boolean;
  /** The run's term liquidity premium curve, which a matched fixed template prices off (fix round M3). */
  tlp?: TLPCurve;
  /**
   * Keep every minted tranche of every ruled family, template or not, on `allTranches` (the opt-in forecast gap
   * and going-concern EVE value them). It writes nothing else: the NII detail stays as the rules decide.
   */
  keepAllTranches?: boolean;
  /**
   * The deposit history of a run that named a "history" warmup, for this scenario. The
   * opening book's deposits are built on it, and each new deposit cohort reads it followed by the scenario's own path
   * to the month the cohort is made. Absent, both read the kernel's own series exactly as before.
   */
  nmdWarmup?: readonly number[];
}

/**
 * The product a rule mints, as the result states it. A behavioral template's product carries the note
 * of the model its tranches run, after the template's own fields (`behavior` is then the note, not the template's
 * "family" flag, which the note's presence states).
 */
export function newVolumeProductOf(rule: NewBusinessRule, behavior?: FamilyBehavior): NewVolumeProduct {
  const termMonths = rule.termMonths ?? DEFAULT_NEW_BUSINESS_TERM_MONTHS;
  const spreadOverIndexBp = rule.spreadOverIndexBp ?? 0;
  if (rule.template === undefined) {
    return { source: "fixed-bullet", rateType: "fixed", amortization: "bullet", indexTenorMonths: termMonths, fixedIndex: "swap", termMonths, spreadOverIndexBp };
  }
  const { behavior: flag, ...rest } = rule.template;
  if (flag !== "family" || behavior === undefined) return { source: "template", ...rest, termMonths, spreadOverIndexBp };
  return { source: "template", ...rest, termMonths, spreadOverIndexBp, behavior: behaviorNoteOf(rule.template, behavior) };
}

/** Map a family id to the chain of COA node ids from its leaf up to the root. */
function coaAncestors(coa: ChartOfAccounts, coaNodeId: CoaNodeId): CoaNodeId[] {
  const byId = new Map<CoaNodeId, { parentId: CoaNodeId | null }>();
  for (const node of coa.nodes) byId.set(node.id, { parentId: node.parentId });
  const chain: CoaNodeId[] = [];
  let cursor: CoaNodeId | null = coaNodeId;
  while (cursor !== null) {
    chain.push(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    cursor = node.parentId;
  }
  return chain;
}

/** Add a new-business delta into a mutable number[] series in place. */
function addDelta(series: BucketedSeries, delta: SeriesDelta): void {
  for (let k = 0; k < delta.balance.length; k++) {
    series.balance[k] += delta.balance[k];
    series.principal[k] += delta.principal[k];
    series.interest[k] += delta.interest[k];
  }
}

/**
 * Project one dynamic scenario over a portfolio. The existing book runs off
 * exactly as the static engine projects it (same overlays, same aggregator);
 * this layer then adds each ruled family's reinvestment tranches into the same
 * per-family and COA-rolled-up series. Guards the dynamic mode: a static
 * scenario is the static module's job and is rejected here rather than having
 * its (absent) rules silently produce a pure-runoff result under the wrong call.
 *
 * `behavioral` is the mounted behavioral registry, passed straight
 * through to applyStaticOverlays so a dynamic scenario can carry a registered
 * overlay kind. Omitted, the built-in switch applies every overlay as before.
 *
 * `rateIndices` is the run's resolved rate index table. The
 * contractual aggregate below projects the whole effective book, indexed
 * floaters included, so it reaches the factory here. The reinvested tranches
 * (the fixed-bullet site above) read no index. Omitted on an indexed book, the
 * factory throws RateIndexUnresolvedError. `macro` is the run's
 * RunMacro, threaded the same way; the fixed bullets pass NO_MACRO.
 */
export function projectDynamicScenario(
  portfolio: PortfolioSpec,
  leg: DynamicScenarioLeg,
  grid: BucketGrid,
  behavioral?: BehavioralRegistry,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
  options?: DynamicProjectionOptions,
): DynamicScenarioResult {
  const { scenario, ratePath, assumptions } = leg;
  if (scenario.newBusiness.mode !== "dynamic") {
    throw new NotImplementedError(
      "projection.dynamic",
      `scenario "${scenario.id}" has new-business mode "${scenario.newBusiness.mode}"; ` +
        `dynamic reinvestment requires mode "dynamic" (static runoff is the static projection module)`,
    );
  }
  // A swap family has no funded balance to reinvest (its legs net to
  // zero notional), so a new-business rule on it is meaningless. Today the
  // netted balance is 0 and the sweep would originate nothing; the refusal
  // guards against any future gross or one-sided aggregation of swap legs
  // that would let a rule originate tranches into the family.
  for (const rule of scenario.newBusiness.rules) {
    const fam = portfolio.coa.families.find((f) => f.id === rule.familyId);
    if (fam !== undefined && isNonRateFamily(fam)) {
      throw new NotImplementedError("projection.dynamic", `scenario "${scenario.id}" carries a new-business rule for family "${rule.familyId}", which is non-rate-sensitive: it is held at book value and does not run off, so new volume has nothing to replace`);
    }
    if (fam !== undefined && isDerivativeFamily(fam)) {
      throw new NotImplementedError(
        "projection.dynamic",
        `scenario "${scenario.id}" carries a new-business rule for family "${rule.familyId}", which is a ` +
          `derivative family (side "derivative"); swaps are not reinvested, so the rule is refused`,
      );
    }
  }

  const effective = assumptions
    ? applyStaticOverlays(portfolio, assumptions, behavioral, macro === undefined ? undefined : macroTargetsOf(macro))
    : portfolio;
  const cashflows = aggregateScenario(
    effective,
    { scenarioId: scenario.id, path: ratePath },
    grid,
    rateIndices,
    macro,
    options?.nmdWarmup,
  );

  const horizon = grid.horizonMonths;
  const familyById = new Map<ProductFamilyId, ProductFamilyDef>();
  for (const fam of portfolio.coa.families) familyById.set(fam.id, fam);

  const famSeries = new Map<ProductFamilyId, BucketedSeries>();
  for (const fam of cashflows.byFamily) famSeries.set(fam.familyId, fam.series);
  const nodeSeries = new Map<CoaNodeId, BucketedSeries>();
  for (const node of cashflows.byCoaNode) nodeSeries.set(node.coaNodeId, node.series);

  const shortfalls: FamilyShortfall[] = [];
  const originations: FamilyNewBusiness[] = [];

  // Rules apply in the portfolio's declared family order, not the rules array
  // order, so the result is independent of how the caller ordered the rules.
  const ruleByFamily = new Map<ProductFamilyId, NewBusinessRule>();
  for (const rule of scenario.newBusiness.rules) ruleByFamily.set(rule.familyId, rule);
  // A scenario whose rules carry a template writes the new-volume detail on every ruled family (and keeps its
  // tranches when asked); a scenario with none writes exactly what it wrote before.
  const detail = scenario.newBusiness.rules.some((r) => r.template !== undefined);
  const keep = detail && options?.keepTranches === true;
  const keepAll = options?.keepAllTranches === true;
  const tranches: SweptTranche[] = [];
  const allTranches: SweptTranche[] = [];
  const macroTargets = macro === undefined ? undefined : macroTargetsOf(macro);

  for (const family of portfolio.coa.families) {
    const rule = ruleByFamily.get(family.id);
    if (!rule) continue;
    const base = famSeries.get(family.id);
    if (!base) {
      throw new Error(
        `projectDynamicScenario: rule for family "${family.id}" has no aggregated series`,
      );
    }

    // The family's model, derived only for a template that asks for it.
    const derived = rule.template?.behavior === "family" ? familyBehavior(portfolio, family, assumptions, behavioral, macroTargets) : undefined;
    // A "history" warmup reaches the new deposit cohorts through the family's model.
    const behavior = derived !== undefined && options?.nmdWarmup !== undefined ? { ...derived, warmupHistory: options.nmdWarmup } : derived;
    const record: SweepRecording | undefined = detail || keepAll ? { coupons: detail, tranches: keep || keepAll } : undefined;
    const swept = sweepFamilyReinvestment(base, rule, ratePath, family, horizon, record, options?.tlp, behavior);
    addDelta(base, swept.delta);
    for (const nodeId of coaAncestors(portfolio.coa, family.coaNodeId)) {
      const target = nodeSeries.get(nodeId);
      if (target) addDelta(target, swept.delta);
    }
    if (swept.shortfall) shortfalls.push(swept.shortfall);
    const nb: FamilyNewBusiness = { familyId: family.id, originations: Array.from(swept.originations) };
    if (detail) {
      // The sign rule of computeNII's netMonthly: +interest on an asset family, -interest on a liability, -0 as +0.
      const sign = family.side === "liability" ? -1 : 1;
      nb.product = newVolumeProductOf(rule, behavior);
      nb.balance = Array.from(swept.delta.balance);
      nb.netMonthly = Array.from(swept.delta.interest, (x) => {
        const v = sign * x;
        return v === 0 ? 0 : v;
      });
      nb.couponAtOrigination = swept.couponAtOrigination ?? [];
      if (keep) tranches.push(...(swept.tranches ?? []));
    }
    if (keepAll) allTranches.push(...(swept.tranches ?? []));
    originations.push(nb);
  }

  return { cashflows, shortfalls, originations, ...(keep ? { tranches } : {}), ...(keepAll ? { allTranches } : {}) };
}

/**
 * Project a portfolio across every dynamic scenario leg. Scenarios emit in leg
 * order; each is an independent reinvestment of the same book under its own
 * shocked path and overlays.
 */
export function projectDynamicAll(
  portfolio: PortfolioSpec,
  legs: DynamicScenarioLeg[],
  grid: BucketGrid,
  behavioral?: BehavioralRegistry,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): DynamicScenarioResult[] {
  return legs.map((leg) => projectDynamicScenario(portfolio, leg, grid, behavioral, rateIndices, macro));
}
