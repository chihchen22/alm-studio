/**
 * Result model. Every number the engine produces lives in one of these typed
 * shapes and serializes to JSON with a stable schema; no number exists only as
 * a rendered pixel.
 *
 * Collections are arrays in a stable order (declared family order, ascending
 * COA node order, ascending bucket index), never Maps, so serialization does
 * not depend on map-iteration order and two runs byte-match.
 */
import type { NotImplemented } from "./errors";
import type { BalanceSheetSide, CoaNodeId, ProductFamilyId, ScenarioId } from "./ids";
import type { NewBusinessAmortization, NewBusinessFixedIndex, NewBusinessRateType, NewBusinessRule } from "./scenario";
import type { CellRef } from "./views";
import type { CommitmentDials, CommitmentDialsResult } from "../liquidity/commitmentDials";

// --- Bucketed cash flows -----------------------------------------------------

/**
 * Monthly bucket grid. Bucket k covers calendar month [asOf + k, asOf + k + 1),
 * for k in 0..horizonMonths-1. Calendar monthly, 360-month horizon.
 */
export interface BucketGrid {
  horizonMonths: number;
  /** ISO as-of date the buckets count from. */
  asOf: string;
}

/**
 * Aggregated cash flows for one series over the monthly grid. Each array is
 * length horizonMonths, indexed by bucket. These accumulate internally in
 * Float64Array and serialize as number[].
 */
export interface BucketedSeries {
  /** Outstanding balance at the start of each bucket. */
  balance: number[];
  /** Principal cash flow in each bucket (positive = runoff to the bank). */
  principal: number[];
  /** Interest cash flow in each bucket. */
  interest: number[];
}

export interface FamilyCashflows {
  familyId: ProductFamilyId;
  series: BucketedSeries;
  /**
   * Principal-runoff weighted average life of the family's projected in-horizon
   * principal, in years from the as-of date (schemaVersion 1.2.0 field set,
   * W3-A7; kernel `walFromCashflows` arithmetic: Σ principal[k]·(k+1)/12 over
   * the in-horizon buckets, divided by the in-horizon principal total). For a
   * book that fully amortizes inside the horizon this is the standard WAL; for
   * positions outliving the horizon it is the WAL of the in-horizon runoff only
   * (disclosed, not extrapolated). Absent when the family's in-horizon principal
   * total is not positive (an empty family has no WAL; the engine does not
   * print 0 where "undefined" is the truth) and on archived pre-1.2.0 envelopes.
   * Populated on the run envelope's cashflow block (after any dynamic
   * new-business merge); module-level aggregation leaves it unset.
   */
  walYears?: number;
}

/** One cell's bucketed series, beside the family rows, never instead of them. */
export interface CellCashflows {
  cellId: string;
  series: BucketedSeries;
}

export interface CoaNodeCashflows {
  coaNodeId: CoaNodeId;
  series: BucketedSeries;
}

export interface ScenarioCashflows {
  scenarioId: ScenarioId;
  byFamily: FamilyCashflows[];
  /** Roll-up up the COA tree, in ascending node order. */
  byCoaNode: CoaNodeCashflows[];
  /**
   * Per-cell series in cell order. Present only when the run declared
   * a view, and ABSENT on a scenario running dynamic new business even then.
   *
   * THE DYNAMIC ASYMMETRY, stated here because a consumer reads the contract
   * and not the limitations page. Every scenario reaches the cell-grain static pass, so
   * the contractual stage writes this arm for a dynamic scenario exactly as it
   * writes one for a static scenario. The balance stage then replaces that
   * scenario's Cashflow object with the dynamic projection's own, which carries
   * no cell index, and the envelope publishes the PRIMARY series, which is the
   * NII stage's resolved Cashflow edge (run/stages/assemble.ts). In the default
   * plan that edge is st-balance whenever ANY scenario is dynamic, but the
   * balance stage hands a static scenario its contractual object back
   * object-identically, so the loss is PER SCENARIO and not per run: in a
   * mixed envelope the static scenarios keep every arm and only the dynamic
   * ones lose this one and ScenarioNII.byCell. ScenarioEVE and GapLadder keep
   * theirs on every scenario: st-eve and st-gap name st-cashflow unconditionally
   * (run/defaultPlan.ts), and the gap ladders ride the RepricingSchedule
   * carrier, which the balance stage never produces at all.
   *
   * So on a dynamic scenario the pivot answers repricing, gapPrincipal and
   * evePv, and refuses balance, principal, interest and nii. The absence is
   * clean, not partial: the key is never created, so a serialized envelope
   * carries no empty arm to misread. Pinned by report/__tests__/pivot.test.ts.
   */
  byCell?: CellCashflows[];
}

export interface BucketedCashflowResult {
  grid: BucketGrid;
  byScenario: ScenarioCashflows[];
  /**
   * The cell dictionary, written ONCE. Every `cellId` in every block
   * indexes into it. Present only when the run declared a view.
   */
  cells?: CellRef[];
}

// --- NII ---------------------------------------------------------------------

/**
 * One horizon's side-signed NII window for a family (schemaVersion 1.2.0 field
 * set, W3-A7; additive). The window is the sum of the family's monthly
 * interest over the first `h` buckets, classified by the family's declared side
 * exactly as the pinned net12/net24 pairs are. A derivative family
 * books neither income nor expense: both are 0 and `net` is the signed net
 * settlement over the window.
 */
export interface HorizonNII {
  interestIncome: number;
  interestExpense: number;
  /** interestIncome - interestExpense over the window. */
  net: number;
}

/**
 * Horizon-keyed NII windows. Keys are horizon months (e.g. 12, 24). Serialized
 * as a JSON object whose integer-like keys enumerate in ascending numeric order
 * (the ECMAScript integer-key rule), so two runs byte-match without a Map.
 */
export type NIIByHorizon = { [horizonMonths: number]: HorizonNII };

/**
 * On a DERIVATIVE family's row, interestIncome* and interestExpense*
 * are 0 and net* carries the swap's net settlement (receive-leg interest minus
 * pay-leg interest; the family series is already net). Only there is net not
 * income minus expense. netMonthly is +interest[k].
 */
export interface FamilyNII {
  familyId: ProductFamilyId;
  interestIncome12: number;
  interestExpense12: number;
  net12: number;
  interestIncome24: number;
  interestExpense24: number;
  net24: number;
  /**
   * Flexible horizons (schemaVersion 1.2.0 field set, W3-A7; additive):
   * one HorizonNII per requested horizon, keyed by months. The pinned pairs are
   * NOT superseded: net12 === byHorizon[12].net and net24 === byHorizon[24].net
   * EXACTLY (same accumulation, copied, never recomputed) whenever 12 / 24 are
   * among the requested horizons — the default. Optional only because archived
   * pre-1.2.0 envelopes lack it; populated on every envelope from this wave on.
   */
  byHorizon?: NIIByHorizon;
  /**
   * The family's side-signed net interest per monthly bucket (bucket k is
   * calendar month k+1): +interest[k] for an asset family,
   * -interest[k] for a liability family, 0 for equity. The horizon nets are
   * exactly the ordered partial sums of this vector (asserted in tests), so a
   * consumer can compute any horizon the envelope did not pre-sum. Optional
   * only for archived pre-1.2.0 envelopes.
   */
  netMonthly?: number[];
}

/** FamilyNII with familyId replaced by cellId. Every field is additive. */
export interface CellNII {
  cellId: string;
  interestIncome12: number;
  interestExpense12: number;
  net12: number;
  interestIncome24: number;
  interestExpense24: number;
  net24: number;
  byHorizon?: NIIByHorizon;
  netMonthly?: number[];
}

/**
 * One family's reinvestment-target under-hit from a dynamic scenario, typed
 * (schemaVersion 1.1.0, additive). Before 1.1.0 this was
 * surfaced only as a free-text NotImplemented tag with the magnitude buried in
 * prose; the typed slot carries the family and the magnitude directly. Fields
 * mirror the dynamic projection's FamilyShortfall diagnostics verbatim — no
 * number is recomputed or rounded on the way into the envelope.
 */
export interface ReinvestmentShortfall {
  familyId: ProductFamilyId;
  /** The reinvestment rule whose target was missed. */
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
   * The magnitude of the under-hit: achievedBalanceEnd - targetBalanceEnd.
   * Positive means the book was held ABOVE a declining target the runoff could
   * not reach without disposals (the strategy only originates, never sells).
   */
  balanceGapEnd: number;
}

/** One family's origination notional per bucket, as the reinvestment sweep wrote it (index 0 is the opening bucket and is zero). */
export interface FamilyNewBusiness {
  familyId: ProductFamilyId;
  originations: number[];
  /**
   * What the new volume is and what it earned, written on every ruled family of a
   * scenario whose rules carry at least one product template, and on no other scenario, so a run that names no
   * template keeps its bytes. Optional, no schema version bump.
   */
  product?: NewVolumeProduct;
  /** The new volume's own balance at the start of each bucket (every tranche still outstanding). */
  balance?: number[];
  /**
   * The new volume's side-signed net interest per bucket: +interest for an asset family, -interest for a liability
   * family, the same sign rule as FamilyNII.netMonthly. The family's netMonthly is its opening book's run-off plus
   * this line.
   */
  netMonthly?: number[];
  /** The first month's coupon of the tranche originated at each bucket (decimal); null where nothing was originated. */
  couponAtOrigination?: Array<number | null>;
}

/** The product a family's new volume was minted as: a template, or today's fixed-rate bullet. */
export interface NewVolumeProduct {
  /** "template" when the rule carried one; "fixed-bullet" for today's rule. */
  source: "template" | "fixed-bullet";
  rateType: NewBusinessRateType;
  amortization: NewBusinessAmortization;
  /** The swap tenor a swap-priced fixed coupon is priced off, or a floater's index tenor and reset period, months. */
  indexTenorMonths: number;
  /** A fixed product's base rate: its matched funding rate, or a par swap rate (today's bullet is "swap"). Absent on a floater. */
  fixedIndex?: NewBusinessFixedIndex;
  termMonths: number;
  spreadOverIndexBp: number;
  /** The template asked for behavior ("family"). Absent on a contractual product. */
  behavior?: NewVolumeBehaviorNote;
}

/** The behavioral models new volume can carry. */
export type NewVolumeBehaviorModel = "four-factor-cpr" | "constant-cpr" | "nmd-decay" | "nmd-decay-beta" | "none";

/** What a behavioral template's tranches run. */
export interface NewVolumeBehaviorNote {
  /** The family's effective model, the one a new position of the family runs. */
  model: NewVolumeBehaviorModel;
  /** True when the tranches run it; false when the product cannot carry it and the tranches are contractual. */
  applied: boolean;
  /** Where the values come from: a binding of the run's assumption set, the family's own position values, or none. */
  source: "assumption-set" | "position" | "none";
  /** The model versions of the bindings that apply, in binding order; absent when none does. */
  modelVersions?: string[];
  /** One plain sentence: what each tranche runs, or why the new volume is contractual. */
  note: string;
}

export interface ScenarioNII {
  scenarioId: ScenarioId;
  byFamily: FamilyNII[];
  /**
   * Per-cell rows in cell order. The scenario totals keep folding
   * over byFamily and are NEVER recomputed from cells: no total on this block
   * is re-derived from this arm, and a second breakdown adds no second place
   * for one number to be wrong.
   *
   * That is a statement about re-derivation, not about bit-stability across
   * views. Under a declared view the family series is itself the ordered fold
   * of the family's cells (run/shard/chunk.ts, foldCellsToFamilies), so a
   * family holding two or more cells re-associates its own sum: its number, and
   * every total folded from it, can differ in the LAST BITS from the same book
   * run with no view, or under a view that partitions it differently. A family
   * holding one cell aliases that cell's array and is exact. Full statement:
   * The limitations page, the gaps registered at the close.
   *
   * ABSENT on a scenario running dynamic new business, for the same reason the
   * cashflow arm is: the NII stage reads the replaced Cashflow object. The
   * mechanism is stated in full at ScenarioCashflows.byCell.
   */
  byCell?: CellNII[];
  totalNet12: number;
  totalNet24: number;
  /**
   * Reinvestment shortfalls reported by this scenario's dynamic projection
   * (schemaVersion 1.1.0). Present only when the scenario ran dynamic new
   * business AND at least one family's target was under-hit; absent on static
   * scenarios and on dynamic scenarios that met every target, so the static
   * regulatory grid's serialized shape is unchanged by this field.
   */
  shortfalls?: ReinvestmentShortfall[];
  /**
   * Studio A+E contract 24: origination notional written at each bucket by the
   * reinvestment sweep, verbatim from the dynamic projection. Present on every
   * scenario that ran dynamic new business (an empty list when the scenario
   * rules no family) and on no other, so an absent key means static and a
   * static envelope is byte-identical.
   */
  newBusiness?: FamilyNewBusiness[];
  /**
   * Scenario-total net per requested horizon (schemaVersion 1.2.0 field set): totalNetByHorizon[h] is the sum of byFamily[*].byHorizon[h].net in
   * declared family order — the same accumulation order as totalNet12/totalNet24,
   * so totalNetByHorizon[12] === totalNet12 and totalNetByHorizon[24] ===
   * totalNet24 exactly under the default horizons. Optional only for archived
   * pre-1.2.0 envelopes.
   */
  totalNetByHorizon?: { [horizonMonths: number]: number };
  /**
   * Scenario-total side-signed net interest per monthly bucket: the sum of the
   * non-derivative family netMonthly vectors in declared family order, then
   * the derivative families' net settlement added once, last (nothing
   * is added on a book with no derivative family). Optional only for
   * archived pre-1.2.0 envelopes.
   */
  netMonthly?: number[];
  /**
   * The derivatives line. Sum of net over derivative families, summed
   * apart and added to totalNet12 / totalNet24 / totalNetByHorizon / netMonthly
   * once, last. Present only on a book with a derivative family.
   */
  derivativesNet12?: number;
  derivativesNet24?: number;
  derivativesNetByHorizon?: { [horizonMonths: number]: number };
}

export interface NIIResult {
  /**
   * Horizons reported, months, ascending. Default [12, 24]; from schemaVersion
   * 1.2.0 this is the actual requested list and byHorizon carries one entry per
   * element. The pinned net12/net24 fields are computed regardless of
   * what this list contains.
   */
  horizonsMonths: number[];
  byScenario: ScenarioNII[];
  /**
   * Schema 1.9.0: net interest margin in percent,
   * 100 x the BASE scenario's totalNet12 / total asset notional, on the engine's
   * runoff convention. Optional and left out, never 0, on a run that does not
   * opt in to the seg block; the book's constant-balance NIM lives on
   * SegResult.nimPct.
   */
  nimPct?: number;
  /**
   * Schema 1.11.0 (spec decision 118): the window
   * in months Results > NII opens on, from the run setup's default NII window.
   * Optional and left out when the window is 60 months.
   */
  windowMonths?: number;
}

// --- EVE ---------------------------------------------------------------------

export interface FamilyEVE {
  familyId: ProductFamilyId;
  /** PV of the family's cash flows on the discount basis. */
  pv: number;
  /** Effective duration; undefined where the sanity gate rejected it. */
  effectiveDuration?: number;
}

/** A cell's PV. No duration: a per-cell duration is a bump-and-reprice per cell. */
export interface CellEVE {
  cellId: string;
  pv: number;
}

export interface ScenarioEVE {
  scenarioId: ScenarioId;
  pvAssets: number;
  pvLiabilities: number;
  /**
   * PV of every swap leg in the book, discounted on the risk-free curve ALONE,
   * whatever `EVEResult.discountBasis` says (a cleared or
   * collateralized swap discounts on the OIS curve, and the engine's risk-free
   * curve stands in for it; on the public pack that is the Treasury curve). Present only on a book that carries a derivative family;
   * absent, never 0, on every other book.
   */
  pvDerivatives?: number;
  /** EVE = pvAssets - pvLiabilities, plus pvDerivatives when present (added last). */
  eve: number;
  /** 0 for the base scenario. */
  deltaEveVsBase: number;
  /**
   * UNIT PIN (schemaVersion 1.1.0): a DECIMAL FRACTION of base EVE, NOT a
   * percent. -0.05 means EVE is down 5% versus base. It is exactly
   * deltaEveVsBase / baseEve, guarded to 0 when base EVE is 0 (where a
   * fractional change is undefined). A consumer rendering a percent multiplies
   * by 100; the engine never does, because rounding and scaling for display are
   * presentation-layer computations.
   */
  deltaEvePct: number;
  byFamily: FamilyEVE[];
  /**
   * Per-cell PV in cell order. pvAssets, pvLiabilities, eve and the
   * deltas keep folding over families and are never recomputed from cells.
   * They can still differ in the LAST BITS between a run with a view and the
   * same book run without one, because under a view a family's series is the
   * ordered fold of its cells (run/shard/chunk.ts, foldCellsToFamilies) and a
   * family holding two or more cells re-associates its own sum. A family
   * holding one cell aliases and is exact. Full statement:
   * The limitations page, the gaps registered at the close.
   *
   * PRESENT on a dynamic scenario as well as a static one, unlike the cashflow
   * and NII arms: the EVE stage reads the static contractual series whatever
   * the new-business mode is. So a dynamic scenario's cell PVs, and the whole
   * EVE block with them, are the STATIC run-off present value while the same
   * scenario's NII is dynamic. Mechanism in full at ScenarioCashflows.byCell.
   */
  byCell?: CellEVE[];
  /**
   * Effective duration of equity. Present iff the EQUITY-LEVEL gate passed
   * (finiteness and magnitude; equity is any-sign because its sign depends on the
   * asset/liability duration gap). It is NOT nulled when `durationSanityPassed`
   * is false: a valid equity duration is kept even when an unrelated family was
   * rejected, because suppressing it would discard genuinely computed information
   * (wave5-duration-rootcause.md). In `base-only` duration mode
   * the shocked scenarios do not compute a duration block and this
   * field is undefined there. A surprising duration is a finding or a bug, never
   * silently patched (Lab rule).
   */
  effectiveDurationEquity?: number;
  /**
   * The conjunction (AND) over every family gate and the equity gate. Families
   * are gated on positive sign only at the BASE environment; at shocked
   * environments they are gated on finiteness and magnitude alone, since a
   * behavioral family's effective duration is legitimately negative there.
   * Equity is gated on finiteness and magnitude everywhere. So this
   * can be false while `effectiveDurationEquity` is present, when the rejection
   * came from a family rather than from equity. In `base-only` mode a shocked
   * scenario computes no gates and this is true as a vacuous AND.
   */
  durationSanityPassed: boolean;
}

/**
 * Duration measurement policy a run was executed under. Structurally
 * identical to the eve module's DurationMode; declared here so the contract
 * layer does not import from an engine implementation module.
 */
export type EveDurationMode = "per-scenario" | "base-only";

export interface EVEResult {
  discountBasis: "all-in" | "risk-free" | "spread-consistent";
  /**
   * Echo of the duration measurement policy the run was executed under,
   * so a reader can tell base-only from per-scenario directly
   * instead of inferring it from undefined duration fields — in base-only mode
   * a shocked scenario's `durationSanityPassed: true` is a vacuous AND, and
   * without this echo that reads identically to "evaluated and passed".
   * Populated on every envelope from schemaVersion 1.1.0; absent only on
   * pre-1.1.0 archived results.
   */
  durationMode?: EveDurationMode;
  byScenario: ScenarioEVE[];
  /**
   * Key-rate durations of equity at the base environment (schemaVersion 1.2.0
   * field set). Present ONLY when the run opted in via the pipeline
   * context (`keyRate`); the standard grid never computes it silently — the
   * measurement regenerates the whole book twice per curve node at two bump
   * sizes (the cost label lives on the context flag).
   */
  keyRate?: KeyRateResult;
  /**
   * Non-parallel channel decomposition of each shocked scenario's EVE delta
   * (schemaVersion 1.2.0 field set). Present ONLY when the run opted in
   * via the pipeline context (`eveChannels`); cost is three extra full-book
   * regenerations per shocked scenario.
   */
  channels?: EveChannelsResult;
  /**
   * Going-concern EVE, written only when the run opted in (`goingConcernEve`). Run-off EVE (the
   * blocks above) values the book held today; this adds the value of the new volume the scenario's own balance plan
   * makes over the grid, each tranche over its full life, on the same discount basis. A management view beside the
   * regulatory run-off measure, never in its place.
   */
  goingConcern?: GoingConcernEveResult;
}

/** Going-concern EVE: run-off EVE plus the value of the planned new volume. */
export interface GoingConcernEveResult {
  /** One plain sentence on what the measure includes and what it is not. */
  note: string;
  /**
   * Which new volume is counted: the tranches made in the first `months` months (ruling 2026-11-03: 12 months
   * by default, or the NII window when it is shorter; extendable up to the NII window, never past it). Each counted
   * tranche is valued over its full life.
   */
  span: { months: number };
  byScenario: ScenarioGoingConcernEve[];
}

/** One scenario's going-concern EVE. */
export interface ScenarioGoingConcernEve {
  scenarioId: ScenarioId;
  /** The scenario's run-off EVE, as `EVEResult.byScenario` carries it. */
  runoffEve: number;
  /**
   * The net value of the scenario's new volume on the same discount basis: per tranche, the PV of every cash flow of
   * its life less the notional paid out at its origination (an asset), or the notional taken in less the PV of its
   * cash flows (a liability). 0 on a static scenario, which makes no new volume.
   */
  newVolumeValue: number;
  /** runoffEve + newVolumeValue. */
  eve: number;
  /** 0 for the base scenario. */
  deltaEveVsBase: number;
  /** deltaEveVsBase / base going-concern EVE, a decimal fraction (the deltaEvePct unit pin); 0 when the base is 0. */
  deltaEvePct: number;
  /** The new volume's net value per ruled family, in the chart's declared family order. */
  byFamily: Array<{ familyId: ProductFamilyId; trancheCount: number; notional: number; value: number }>;
}

// --- Key-rate durations (opt-in) --------------------------------------
//
// Bump one curve node at a time (a tent in zero-rate space peaking at the node,
// zero at the adjacent nodes; the first and last tents extend flat to their
// side, so the LAST node stands in for the entire flat-extrapolated long end —
// it is not a 30-year exposure in the sense the interior keys are). Both legs
// regenerate per bump: the projection path is rebuilt from the node-bumped
// curve and the discount function reads the same bumped curve, so projection
// and discounting move together (forward-consistent). The tents sum pointwise
// to the parallel shift, which is what makes the decomposition additive.
//
// The gate is additivity PLUS convergence, not closeness (alm-eve convention):
// the node durations must sum to a parallel effective duration measured with
// the SAME machinery at the SAME bump, and the residual must fall roughly
// four-fold when the bump halves (a central-difference construction error that
// happens to be small at one bump size does not converge and is reported as
// `converged: false`, never patched).

/** One curve node's equity key-rate duration, in years. */
export interface KeyRateNodeDuration {
  /** The curve node's tenor, years (the curve's own bootstrap nodes). */
  tenorYears: number;
  /**
   * Equity key-rate duration at this node: (EVE_down − EVE_up) / (2·EVE_0·Δr)
   * with both legs regenerated under the node tent bump.
   */
  duration: number;
}

/** The additivity-plus-convergence gate, measured, never asserted silently. */
export interface KeyRateConvergence {
  /** The halved bump the residual was re-measured at, bp (= bumpBp / 2). */
  halvedBumpBp: number;
  /** Σ node durations − parallel reference, years, at the working bump. */
  residualYears: number;
  /** The same residual re-measured at the halved bump. */
  residualYearsAtHalvedBump: number;
  /**
   * |residualYears| / |residualYearsAtHalvedBump|. A clean second-order
   * construction gives ≈ 4. Absent when the halved-bump residual is below the
   * negligibility floor (a ratio against ~0 is noise, not a measurement).
   */
  ratio?: number;
  /**
   * True iff the ratio lies inside the convergence band, or both residuals are
   * below the negligibility floor (an exactly-additive book has nothing left
   * to converge). False is reported, never silently absorbed.
   */
  converged: boolean;
}

/** Key-rate decomposition of equity effective duration (base environment). */
export interface KeyRateResult {
  /** The base scenario the measurement anchors to. */
  scenarioId: ScenarioId;
  discountBasis: "all-in" | "risk-free" | "spread-consistent";
  /** Working node bump, bp. */
  bumpBp: number;
  /** Per-node equity durations, ascending tenor (the curve's node order). */
  nodes: KeyRateNodeDuration[];
  /** Σ node durations, in node order. */
  sum: number;
  /**
   * Parallel effective duration re-measured with the same curve-and-path
   * machinery at the same bump (a one-knot flat custom shift). This is the
   * number `sum` must reconcile to; it is measured, not copied from the
   * ±100bp duration engine, so the residual isolates decomposition error from
   * bump-size convexity.
   */
  parallelReference: number;
  convergence: KeyRateConvergence;
}

// --- EVE channel decomposition (opt-in) --------------------------------
//
// For each shocked scenario, EVE is regenerated full-life three ways: the
// projection leg shocked with discounting at base (the behavioral channel),
// discounting shocked with projection at base (the valuation channel), and
// both together (the total). The interaction remainder is total − projection −
// discounting BY DEFINITION — it is not an error term; it carries the
// projection-discounting interaction (the negative convexity), near zero on
// path-independent books and material where the shock moves a behavioral
// driver. Regeneration follows the run's own scenario convention (the shocked
// path is the DeterministicRatePath of the shocked curve; NMD warmup history
// is NOT re-leveled, matching the headline EVE's projection), so `totalDelta`
// reconciles to the bucketed `deltaEveVsBase` on books that mature inside the
// horizon; full-life vs horizon-truncated PV is the one disclosed difference.

/** One shocked scenario's EVE delta split into its two channels + remainder. */
export interface EveChannelRow {
  scenarioId: ScenarioId;
  /** Full-life regenerated EVE at the base environment (both legs base). */
  eveBase: number;
  /** Full-life regenerated EVE with both legs shocked. */
  eveShocked: number;
  /** eveShocked − eveBase. */
  totalDelta: number;
  /** EVE(projection shocked, discounting base) − eveBase: the behavioral leg. */
  projectionDelta: number;
  /** EVE(projection base, discounting shocked) − eveBase: the valuation leg. */
  discountingDelta: number;
  /**
   * totalDelta − projectionDelta − discountingDelta, exactly (definitional).
   * The projection-discounting interaction; reported, never absorbed into a
   * channel.
   */
  interactionResidual: number;
  /**
   * The swap legs' own share of `totalDelta`, on the risk-free curve:
   * derivative EVE with both legs shocked minus derivative EVE at base. The
   * swaps already sit inside the projection and discounting channels; this
   * says how much of the total they are. Present only on a book with a
   * derivative family.
   */
  derivativesDelta?: number;
}

/** Channel decomposition for every shocked scenario, in request order. */
export interface EveChannelsResult {
  discountBasis: "all-in" | "risk-free" | "spread-consistent";
  byScenario: EveChannelRow[];
}

// --- Gap ladders -------------------------------------------------------------

/** One time band in a gap ladder. endMonth is exclusive. */
export interface GapBand {
  label: string;
  startMonth: number;
  endMonth: number;
}

/**
 * One band. In the REPRICING ladder, a derivative (swap) family's
 * legs band into `assets`, signed (receive positive, pay negative), so a
 * pay-fixed swap adds its floating notional at the next reset and subtracts
 * its fixed notional at maturity. `gap` and `cumulativeGap` equal what they
 * would be with the pay leg booked as a liability. The LIQUIDITY ladder
 * carries nothing for a swap: the notional exchanges are never cash.
 */
export interface GapBucketRow {
  band: GapBand;
  assets: number;
  liabilities: number;
  /** assets - liabilities in this band. */
  gap: number;
  /** Running sum of `gap` through this band. */
  cumulativeGap: number;
}

export interface GapLadder {
  kind: "repricing" | "liquidity";
  scenarioId: ScenarioId;
  rows: GapBucketRow[];
  /** Roll-up by COA node for drill-down, ascending node order. */
  byCoaNode: Array<{ coaNodeId: CoaNodeId; rows: GapBucketRow[] }>;
  /**
   * Per-cell band rows in cell order, mirroring the byCoaNode arm.
   * The top-level `rows` keep folding over families and are never recomputed
   * from cells, so the headline gap is not re-derived because a reader asked
   * for a second breakdown.
   *
   * It can still move in the LAST BITS. Under a declared view a family's series
   * is the ordered fold of its cells (run/shard/chunk.ts, foldCellsToFamilies),
   * so a family holding two or more cells re-associates its own sum and a
   * banded number folded from it can differ in the last bits from the same book
   * run with no view, or under a different partition. A family holding one cell
   * aliases and is exact. Full statement: the limitations page, the gaps
   * registered at the close.
   *
   * PRESENT on a dynamic scenario as well as a static one, unlike the cashflow
   * and NII arms: both ladders ride the RepricingSchedule carrier, which only
   * the contractual stage produces, and the gap stage names that stage even
   * when a balance stage exists. Mechanism in full at ScenarioCashflows.byCell.
   */
  byCell?: Array<{ cellId: string; rows: GapBucketRow[] }>;
  /**
   * Schema 1.11.0 (spec decisions 107 and 108):
   * the ladder's top-level rows on the run's own bucket setting, beside the
   * nine standard bands in `rows`, which never change. `edgesMonths` is given
   * for a custom setting. Top-level rows only: no node or cell arm. Optional
   * and left out when the run names no bucket setting for this ladder.
   */
  userBuckets?: { kind: "monthly" | "custom"; edgesMonths?: number[]; rows: GapBucketRow[] };
  /**
   * Schema 1.12.0: the interest-inclusive liquidity
   * ladder, written on the LIQUIDITY ladder only and only when the run asked
   * for `liquidityFlows: "principal-plus-interest"`; absent otherwise, never
   * present and undefined. `rows`, `byCoaNode`, `byCell` and `userBuckets`
   * above stay principal only whatever the run asked.
   *
   * Each band is the principal of the ladder above plus the contractual
   * interest cash flow of the same static run-off pass, banded the same way,
   * on its payment date (Amendment A1). Deposit (nmd, nmd-b and
   * regulatory-convention child) interest is credited monthly and counts as
   * paid monthly. CD interest is paid with the principal it accrued on: at
   * maturity for a held CD, pro rata at an early exit. A swap's signed net
   * settlement is included and bands into `assets`, which the principal ladder
   * never carries. A commitment carries none. Equity families drop at banding.
   *
   * `rows` are the nine standard bands. `userBuckets` follows the ladder's own
   * bucket setting and is present exactly when the principal `userBuckets` is.
   * Top-level rows only: no node or cell arm.
   *
   * `interest` (Amendment A2) is the interest on its own, in the same shape:
   * per band, `assets` is interest income (with a swap's signed net
   * settlement), `liabilities` is interest expense, `gap` is net interest and
   * `cumulativeGap` its running sum. It is built from the interest carrier
   * directly, not as the difference of two ladders, so per band principal
   * plus interest equals the combined rows above within float tolerance. Its
   * `userBuckets` is present exactly when the combined `userBuckets` is.
   */
  withInterest?: {
    rows: GapBucketRow[];
    userBuckets?: { kind: "monthly" | "custom"; edgesMonths?: number[]; rows: GapBucketRow[] };
    interest: {
      rows: GapBucketRow[];
      userBuckets?: { kind: "monthly" | "custom"; edgesMonths?: number[]; rows: GapBucketRow[] };
    };
  };
}

/** One band of the next-reset ALCO ladder. Dollars. */
export interface NextResetLadderRow {
  /** The band label, one of GAP_BAND_LABELS. */
  band: string;
  assets: number;
  liabilities: number;
  /** assets - liabilities. */
  gap: number;
  /** Running sum of `gap` through this band. */
  cumulativeGap: number;
}

/**
 * The next-reset repricing ladder, the ALCO convention:
 * a floater's full current notional in the band
 * of its first reset, a fixed instrument's full notional in the band of its
 * contractual maturity (no amortisation), the repricing slice beta0 x N of an
 * interest-bearing deposit in band 0-1M, and the core of every deposit held out
 * in `coreExcluded`. Computed once per run on the base scenario, written only
 * on a run that opted in (`nextResetGap`).
 */
export interface NextResetLadder {
  /** The nine band labels, in band order. */
  bands: string[];
  rows: NextResetLadderRow[];
  /** Deposit notional held out of the ladder as core (not rate-sensitive), dollars. */
  coreExcluded: number;
  /** Positions the ladder does not place, each with the reason. */
  uncovered: { positionId: string; reason: string }[];
}

/**
 * The fixed-rate (rate-locked) gap ladder, the rate-locked half of the ALCO
 * 10.8 (schema 1.13.0). It asks when the money on a rate-locked
 * position comes back, where the next-reset ladder asks when its rate changes:
 * each rate-locked position's principal is booked in the band of the month it
 * is paid on the base scenario's path, so an amortising loan spreads over many
 * bands and its cumulative gap through the last band is the whole rate-locked
 * book. Rate-locked means fixed-loan, mortgage, cd, and an nmd slice the
 * regulatory convention holds out of repricing (`repricingTreatment:
 * "excluded"`); a floater, an nmd-b and a managed-rate nmd are not rate-locked
 * and are left out without a reason. Computed once per run on the base
 * scenario, written only on a run that opted in (`fixedRateGap`).
 */
export interface FixedRateLadder {
  /** The base scenario the cash flows were read on. */
  scenarioId: ScenarioId;
  /** The nine band labels, in band order; the last band is open. */
  bands: string[];
  rows: NextResetLadderRow[];
  /** Positions the ladder does not place, each with the reason. */
  uncovered: { positionId: string; reason: string }[];
}

export interface GapResult {
  /** Repricing gap off Instrument.repricingSchedule(), one ladder per scenario. */
  repricing: GapLadder[];
  /** Liquidity gap off principal cash flows, one ladder per scenario. */
  liquidity: GapLadder[];
  /** Schema 1.9.0: the next-reset ALCO ladder; absent unless the run opted in. */
  nextReset?: NextResetLadder;
  /** Schema 1.13.0: the fixed-rate gap ladder; absent unless the run opted in. */
  fixedRate?: FixedRateLadder;
  /**
   * The forecast gap arm, written only when the run opted in (`forecastGap`). Each ladder is the
   * contractual ladder above plus the new volume the scenario's balance plan makes, every tranche's cash flows booked
   * from its origination month (its funding at origination as negative principal, as a drawdown is). The contractual
   * `repricing` and `liquidity` ladders stay the default view.
   */
  forecast?: ForecastGapResult;
}

/** The forecast gap arm: the contractual ladders with the planned new volume added. */
export interface ForecastGapResult {
  /** One plain sentence on what the arm adds to the contractual ladders. */
  note: string;
  repricing: GapLadder[];
  liquidity: GapLadder[];
}

// --- FTP (deterministic) ----------------------------------------------
//
// Par-matched static-strip funds transfer pricing, wrapped from the kernel's
// ftp.ts (the code an independent spreadsheet par-match cross-checked outside
// this repository; cited, not reproduced). Three legs
// per position, aggregated to the COA family grain:
//   IR FTP     par-match against the risk-free zero curve alone;
//   all-in FTP par-match against the risk-free + TLP all-in funding curve;
//   LP FTP     the residual, all-in minus IR, additive by construction.
// ADR-018 pins the shocked-NII path convention at v1 semantics this window, so
// the FTP series exists for the BASE scenario only; `shockedScenarios` carries
// the typed refusal. Additive (part of the 1.2.0 field set; the
// version constant itself is bumped by the last wave-3 results.ts owner).

/**
 * One family's monthly FTP series over the run's bucket grid (bucket k is
 * calendar month k+1, ADR-004; arrays are length horizonMonths). Dollar
 * quantities, summed over the family's positions — never re-derived rates,
 * because a family-level "rate" without its weights would be a display
 * computation the engine refuses to bake in.
 */
export interface FtpFamilyMonthly {
  /** Outstanding balance at the start of each bucket (mirrors cashflows). */
  balance: number[];
  /** Realised coupon interest in each bucket, dollars (kernel interestPaid). */
  couponInterest: number[];
  /**
   * Transfer-priced funding accrual in each bucket, dollars:
   * sum over positions of ftpRate(m) * balance(m) * (1/12), where ftpRate(m)
   * is the kernel's monthly spot funding rate (flat par-matched all-in for
   * fixed instruments; reset-sampled risk-free forward + TLP for floaters; the
   * beta-blend for NMD-B). A charge on assets, a credit on liabilities.
   */
  ftpAccrual: number[];
}

/** One product family's FTP decomposition (base scenario). */
export interface FtpFamilyRow {
  familyId: ProductFamilyId;
  /** The family's declared COA side — the grain NII classifies by. */
  side: BalanceSheetSide;
  positionCount: number;
  /** Sum of position notionals (the rate-weighting mass). */
  notional: number;
  /**
   * Notional-weighted, balance-weighted realised coupon (the kernel's
   * assetRate: the yield earned on assets, the deposit cost on liabilities).
   * Absent when the family holds no positions — an empty family has no rate,
   * and the engine does not print 0 where "undefined" is the truth.
   */
  couponRate?: number;
  /** Notional-weighted par-matched rate against the risk-free curve alone. Absent when empty. */
  irFtpRate?: number;
  /** Notional-weighted LP residual = all-in minus IR. Absent when empty. */
  lpFtpRate?: number;
  /** Notional-weighted par-matched rate against the risk-free curve + TLP. Absent when empty. */
  allInFtpRate?: number;
  /**
   * Notional-weighted FTP margin, sign-flipped so franchise value reads
   * positive on both sides (asset: coupon − all-in; liability: all-in −
   * coupon). Absent when the family holds no positions.
   */
  ftpMarginRate?: number;
  /** Coupon interest dollars over the first NII horizon (12 months). */
  couponInterest12: number;
  /** FTP accrual dollars over the first NII horizon (12 months). */
  ftpAccrual12: number;
  /**
   * The family's 12-month franchise margin in dollars, side-signed:
   * asset couponInterest12 − ftpAccrual12; liability ftpAccrual12 −
   * couponInterest12.
   */
  margin12: number;
  monthly: FtpFamilyMonthly;
  /**
   * Present only on a family whose one deposit is priced on a replicating-portfolio credit
   * (its set's nmd-decay binding carries the construction). The family's IR, liquidity and all-in rates are then
   * this readout's rate, liquidity and total credit.
   */
  replicatingPortfolio?: ReplicatingPortfolioReadout;
  /**
   * Present only on a family whose one deposit is priced on a credit on its balance path or a
   * capped life. The family's IR, liquidity and all-in rates are then the base scenario's rate, liquidity and total.
   */
  scenarioCredit?: ScenarioCreditReadout;
  /**
   * The family's new volume, each tranche transfer-priced at its origination month on
   * the base curve as seen from that month (the forward curve), with the term liquidity premium curve as it stands
   * at the cut-off. Present only on a family that originated new volume on a base scenario whose rules carry a
   * product template; every other field of this row is the opening book's, unchanged.
   */
  newVolume?: FtpNewVolume;
}

/** One family's transfer-priced new volume on the base scenario. */
export interface FtpNewVolume {
  /**
   * Fix round M2: the same figures on the earnings window, the reading a report heads with: tranches made in the first
   * `months` months (the run's NII window, 60 months unless set; ruling 46: the tranches made at k = 1 .. months, a
   * tranche at k being made at the end of month k), their rates weighted by volume made, and the coupon, FTP and margin
   * dollars of the new volume over those months (cash flows in months 1 .. months). Every field below this one covers
   * the whole grid.
   */
  window: FtpNewVolumeWindow;
  /** Tranches originated over the grid. */
  trancheCount: number;
  /** Notional originated over the grid (the rate-weighting mass). */
  notional: number;
  /** Origination-notional-weighted coupon, IR, liquidity, all-in rates and margin over the whole grid, each locked at its tranche's origination. */
  couponRate: number;
  irFtpRate: number;
  lpFtpRate: number;
  allInFtpRate: number;
  ftpMarginRate: number;
  /** Coupon interest, FTP accrual and side-signed margin of the new volume over the first 12 months, dollars. */
  couponInterest12: number;
  ftpAccrual12: number;
  margin12: number;
  monthly: FtpFamilyMonthly;
  /** The all-in transfer rate locked at each bucket's origination (decimal); null where nothing was originated. */
  allInFtpRateAtOrigination: Array<number | null>;
}

/** The new volume of one family on the earnings window (fix round M2): what was made, at what rates, and what it earned. */
export interface FtpNewVolumeWindow {
  /** The window, months: the run's NII window, within the grid. */
  months: number;
  trancheCount: number;
  /** Notional made in the window. */
  notional: number;
  /** Volume-weighted over the tranches made in the window; absent (with the margins) when none was made. */
  couponRate?: number;
  irFtpRate?: number;
  lpFtpRate?: number;
  allInFtpRate?: number;
  ftpMarginRate?: number;
  /** Coupon interest, FTP accrual and side-signed margin of the new volume over the window's months, dollars. */
  couponInterest: number;
  ftpAccrual: number;
  margin: number;
}

/** One tranche of a rate replicating portfolio. */
export interface ReplicatingPortfolioTranche {
  /** "overnight": the beta share on a one-month bullet; "pillar": a k-month pillar; "strip": struck once on the runoff. */
  kind: "overnight" | "pillar" | "strip";
  /** The tenor in months: 1 overnight, k for a pillar, the runoff's months for the strip. */
  months: number;
  /** The share of the whole balance, a fraction; the tranches sum to 1. */
  weight: number;
  /** The tranche's rate on the benchmark curve, decimal annualised. */
  rate: number;
}

/**
 * The replicating-portfolio credit of one deposit. Rates are decimal
 * annualised; stocks are month-end dollars from the as-of (index 0) to the longest of the runoff and the pillars.
 */
export interface ReplicatingPortfolioReadout {
  positionId: string;
  construction: "life-target" | "pillar" | "strip";
  beta: number;
  /** n, the months of the deposit's straight-line runoff. */
  runoffMonths: number;
  /** The runoff's life in months, (n + 1) / 2: the life the rate portfolio is capped at and the premium is read at. */
  lifeMonths: number;
  tranches: ReplicatingPortfolioTranche[];
  /** sum of weight x rate over the tranches. */
  rateCredit: number;
  /** The term liquidity premium at lifeMonths, a bullet's par spread, on the whole balance. */
  liquidityCredit: number;
  /** rateCredit + liquidityCredit. */
  totalCredit: number;
  stock: {
    /** The deposit's own rate-locked balance: the book at month 0, then (1 - beta) of the runoff. */
    liabilityFixedRateGap: number[];
    /** The rate portfolio's stock: the book at month 0, then the pillars' (or the strip's) amortizing stock. */
    portfolio: number[];
    /** portfolio less liabilityFixedRateGap: Treasury's position. */
    net: number[];
    /** The whole balance's runoff, the beta share included. */
    liquidityLadder: number[];
  };
  /** Information beside the credit; none of these feeds it. */
  readings: {
    /** The premium matched to the runoff itself (a cross-check of the construction). */
    runoffPremium: number;
    /** Whether that reading is within 1 bp of liquidityCredit. */
    runoffWithinOneBp: boolean;
    /** The bullet premiums at the whole months around lifeMonths, interpolated linearly to it. */
    bracketPremium: number;
    /** The haircut reading: the premium at a shorter runoff's life, and the total credit it would give. */
    haircut?: { runoffMonths: number; lifeMonths: number; liquidityCredit: number; totalCredit: number };
  };
  /** The rate leg re-read on a steepened curve, or the reason it is left out. */
  steepener?:
    | { topBp: number; topYears: number; rateCredit: number; trancheRates: number[] }
    | { topBp: number; topYears: number; refused: string };
}

/**
 * The replicating-portfolio credit of a deposit whose life is not a straight-line runoff's:
 * the balance path of a component decay deposit or a capped life on a flat full-form deposit, read at every scenario
 * of the run. The top level is the base scenario's reading.
 */
export interface ScenarioCreditReadout {
  positionId: string;
  construction: "life-target" | "pillar" | "static-share";
  /** Where the life comes from: the deposit's own balance path run off in full, or a fixed cap. */
  lifeSource: "balance-path" | "capped";
  /** How a shocked scenario is read: the base curve held, or the scenario's own curve. Absent: base scenario only. */
  scenarioCurve?: "hold-base" | "shift";
  beta: number;
  /** The life in months the rate portfolio is capped at and the premium is read at. */
  lifeMonths: number;
  tranches: ReplicatingPortfolioTranche[];
  rateCredit: number;
  liquidityCredit: number;
  totalCredit: number;
  /** The liquidity ladder's legs; weight x premium sums to liquidityCredit. */
  liquidityLegs: ReplicatingPortfolioLiquidityLeg[];
  /** The deposit's equilibrium paid rate, decimal (a full-form deposit only): the run-rate the margin rows read. */
  paidRate?: number;
  /** The reading at every scenario of the run, in request order. */
  byScenario: ReplicatingPortfolioScenarioReading[];
}

/** One leg of the liquidity ladder: `weight` of the whole balance at the premium of a `months` life. */
export interface ReplicatingPortfolioLiquidityLeg {
  months: number;
  weight: number;
  /** The term liquidity premium at `months`, a bullet's par spread, decimal. */
  premium: number;
}

/** The replicating-portfolio credit at one scenario. */
export interface ReplicatingPortfolioScenarioReading {
  scenarioId: ScenarioId;
  beta: number;
  lifeMonths: number;
  tranches: ReplicatingPortfolioTranche[];
  rateCredit: number;
  liquidityCredit: number;
  totalCredit: number;
  liquidityLegs: ReplicatingPortfolioLiquidityLeg[];
  /** The deposit's equilibrium paid rate at this scenario, decimal (a full-form deposit only). */
  paidRate?: number;
}

/** Book-level FTP roll-up (base scenario). */
export interface FtpBookSummary {
  /**
   * Notional-weighted FTP margin across the book — the kernel computeFTP
   * bookNim formula: sum(margin_i * notional_i) / sum(notional_i). 0 on an
   * empty book (the kernel zero-notional guard; not a genuine rate there).
   */
  bookNimRate: number;
  /** 12-month FTP charges levied on asset families, dollars. */
  charges12: number;
  /** 12-month FTP credits granted to liability families, dollars. */
  credits12: number;
  /**
   * The central funding desk's 12-month residual: charges12 − credits12. The
   * rate-mismatch position the transfer pricing concentrates at the center.
   */
  mismatchCenter12: number;
}

/**
 * The NIM bridge: NII re-summed through the FTP decomposition. Welds the FTP
 * block to computeNII's already-validated number instead of letting it float
 * free: lendingMargin12 + fundingMargin12 + mismatchCenter12 must reconcile to
 * the base scenario's totalNet12 (asserted to 1e-9 in the module's tests).
 */
export interface FtpNimBridge {
  /** The NII horizon the bridge is summed over (the pinned first horizon, 12). */
  horizonMonths: number;
  /** Sum over asset families of (coupon interest − FTP charge), dollars. */
  lendingMargin12: number;
  /** Sum over liability families of (FTP credit − coupon cost), dollars. */
  fundingMargin12: number;
  /** charges12 − credits12, the central desk's take (same as book summary). */
  mismatchCenter12: number;
  /** lendingMargin12 + fundingMargin12 + mismatchCenter12, plus derivativesNet12 when present. */
  bridgeNet12: number;
  /** computeNII's base-scenario totalNet12, copied VERBATIM (never recomputed). */
  niiNet12: number;
  /**
   * The swaps' 12-month net settlement, copied VERBATIM from the NII
   * row's derivativesNet12. It is in NII and in no FTP leg, so the bridge adds
   * it: bridgeNet12 = lending + funding + mismatch + derivativesNet12. Present
   * only when the NII row carries it.
   */
  derivativesNet12?: number;
  /**
   * Studio A+E contract 19: on a base scenario that ran dynamic new business, the
   * part of niiNet12 the margins cannot explain, niiNet12 - bridgeNet12: the
   * interest the top-up tranches earned or cost in the bridge horizon. Absent on a
   * static base scenario, where bridgeNet12 already equals niiNet12.
   */
  newBusinessNet12?: number;
  /**
   * On a base scenario whose rules carry a product template, the new volume re-summed
   * through its own transfer prices. lendingMargin12 + fundingMargin12 + mismatchCenter12 = net12, the new volume's
   * 12-month net interest, which reconciles to newBusinessNet12 (asserted in the tests). Absent otherwise.
   */
  newVolume?: { lendingMargin12: number; fundingMargin12: number; mismatchCenter12: number; net12: number };
}

/** The additive FTP result block (base scenario only). */
export interface FtpResult {
  /** The base scenario the decomposition and series are computed for. */
  scenarioId: ScenarioId;
  /** Discount basis of the IR leg. */
  irBasis: "risk-free";
  /** Discount basis of the all-in leg. */
  allInBasis: "risk-free-plus-tlp";
  /** Per-family rows in declared family order. */
  byFamily: FtpFamilyRow[];
  book: FtpBookSummary;
  nimBridge: FtpNimBridge;
  /**
   * The typed refusal for shocked-scenario FTP series (the shocked
   * NII path convention is pinned at v1 semantics this window; a monthly FTP
   * series on a convention flagged wrong-by-one-coupon-month is not published).
   * Carried inside this block — NOT in RunResult.notImplemented — because the
   * base-scenario capability itself ran; the run-level register stays the
   * ledger of layers that did not run at all.
   */
  shockedScenarios: NotImplemented;
}

// --- Attribution -------------------------------------------------------------

/**
 * The drivers a headline delta decomposes into. Each contribution is the change
 * attributable to moving one driver for one family; the residual carries what
 * the decomposition does not explain (never absorbed into a driver).
 */
export type AttributionDriver =
  | "rate"
  | "volume"
  | "mix"
  | "prepay"
  | "deposit-beta"
  | "decay"
  | "new-business";

export interface DriverContribution {
  familyId: ProductFamilyId;
  driver: AttributionDriver;
  /** Contribution in the headline metric's units. */
  amount: number;
}

/** Decomposition of one headline number's change versus base. */
export interface HeadlineAttribution {
  metric: "nii-12m" | "nii-24m" | "eve";
  /** The shocked scenario being explained, relative to base. */
  scenarioId: ScenarioId;
  baseValue: number;
  scenarioValue: number;
  /** scenarioValue - baseValue. */
  totalDelta: number;
  contributions: DriverContribution[];
  /** sum(contributions) - totalDelta. A nonzero residual is reported, never hidden. */
  residual: number;
}

export interface AttributionResult {
  headlines: HeadlineAttribution[];
}

// --- SEG, EBP and constant-balance NII (schema 1.9.0, opt-in) ----------------

/**
 * Constant-balance net interest income over the NII horizon, signed
 * (assets +, liabilities -). Each monthly array has niiHorizonMonths entries,
 * month 1 first. The shocks start at step 1 (month 1 is unshocked), the book's
 * earnings convention, which differs from the engine's runoff NII.
 */
export interface SegNii {
  base12: number;
  up12: number;
  down12: number;
  baseMonthly: number[];
  upMonthly: number[];
  downMonthly: number[];
}

/** One sensitivity-equivalent-gap series: a position, a family or the whole book. */
export interface SegSeries {
  /** Constant-balance convention, signed (assets +, liabilities -). */
  nii: SegNii;
  /** 61 entries, t = 0..60, signed convention (a fixed asset reads +N at t = 0). */
  segOutstanding: number[];
  /** 61 entries; periodic(0) = 0. */
  segPeriodic: number[];
  /** 60 entries, t = 1..60, unsigned. */
  ebpAssets: number[];
  /** 60 entries, t = 1..60, unsigned. */
  ebpLiabilities: number[];
  /** max |segOutstanding| for t >= 1, and the month it occurs in. */
  segPeak: { value: number; month: number };
}

/**
 * The SEG / EBP / constant-balance NII block. Present only when the run opts in
 * to `seg`; a run without the opt-in carries no such key.
 */
export interface SegResult {
  convention: "constant-balance-sheet";
  /** The base scenario the block ran on. */
  scenarioId: string;
  /** SEG shock size in bp (10). */
  shockBp: number;
  /** NII shock size in bp (200). */
  niiShockBp: number;
  /** SEG horizon in months (60). */
  horizonMonths: number;
  /** NII horizon in months (12). */
  niiHorizonMonths: number;
  /** 100 x book.nii.base12 / total asset notional. */
  nimPct: number;
  totalAssetNotional: number;
  book: SegSeries;
  /**
   * 60 entries, the bank print: (NII_dn - NII_up)(i) x 12 / 0.002, index
   * i = month i + 1, positive = liability-sensitive.
   */
  segBank: number[];
  byFamily: Record<string, SegSeries>;
  /** Present when any position carries the dimension attributionGroup. */
  byAttributionGroup?: Record<string, SegNii>;
  /** Positions the block could not cover, each with a reason; nothing fakes a number. */
  uncovered: { positionId: string; reason: string }[];
}

// --- Liquidity stress ladder (schema 1.9.0, opt-in) --------------------------

export interface LiquidityStressParams {
  /** Monthly outflow rate of the HYS pool, decimal. */
  hysOutflowMonthly: number;
  /** Share of maturing wholesale funding that renews, decimal. */
  wholesaleRenewal: number;
  /** Monthly outflow rate of the non-interest-bearing pool, decimal. */
  nibOutflowMonthly: number;
  /** Share of the undrawn face drawn over the horizon, decimal. */
  drawRate: number;
  /**
   * The share of term deposits paying out in a month that renew, decimal. Absent, the
   * row reads no term deposit, as before the role existed.
   */
  cdRenewal?: number;
}

export interface LiquidityStressTable {
  bau: LiquidityStressParams;
  moderate: LiquidityStressParams;
  severe: LiquidityStressParams;
}

export interface LiquidityStressScenario {
  id: "bau" | "moderate" | "severe";
  params: LiquidityStressParams;
  /** 12 entries each, month 1..12. */
  inflow: number[];
  hysOut: number[];
  nibOut: number[];
  wholesaleOut: number[];
  /**
   * Term deposits leaving by month, maturity x (1 - cdRenewal) + early withdrawals (S3d fix round: the renewal
   * share rolls maturities only); present only on a row that states cdRenewal.
   */
  cdOut?: number[];
  draws: number[];
  net: number[];
  cumulative: number[];
  /** null means the buffer is never pierced within the horizon. */
  survivalMonths: number | null;
  /** Most negative cumulative position and the month it occurs in. */
  peakShortfall: number;
  peakMonth: number;
}

export interface LiquidityStressResult {
  horizonMonths: number;
  buffer: number;
  undrawnFace: number;
  pools: { hys: number; nib: number };
  /** 12 entries: wholesale funding maturing in each month. */
  wholesaleMaturities: number[];
  /**
   * S3d-1: 12 entries, term deposits maturing in each month on the base path (contractual maturities of the balance
   * still there); present when a row states cdRenewal. The S3d fix round splits out the early withdrawals.
   */
  cdMaturities?: number[];
  /** S3d fix round: 12 entries, term deposits withdrawn early in each month on the base path; present with cdMaturities. */
  cdEarlyWithdrawals?: number[];
  scenarios: LiquidityStressScenario[];
  /** How the buffer was formed from the hqla-stock positions; present only when the setup stated no buffer. */
  bufferDerivation?: LiquidityBufferDerivation;
  /** The commitment dials the setup set, what they give, and the severe draw rate they set. */
  commitmentDials?: LiquidityCommitmentDials;
  /** The survival path on the severe row; present only when the setup asked for it. */
  survivalPath?: SurvivalPathResult;
}

/** One hqla-stock position counted in a derived buffer. */
export interface LiquidityBufferPosition {
  positionId: string;
  familyId: string;
  /** The position's face at the as-of date, dollars. */
  notional: number;
  level: "l1" | "l2a" | "l2b";
  /** The level's haircut, a decimal. */
  haircut: number;
  /** notional x (1 - haircut). */
  counted: number;
}

/** The buffer read from the hqla-stock positions and their hqla-level tags. */
export interface LiquidityBufferDerivation {
  positions: LiquidityBufferPosition[];
  /** hqla-stock positions with no known hqla-level: not counted, each with its reason. */
  notCounted: Array<{ positionId: string; familyId: string; notional: number; reason: string }>;
  /** The counted dollars by level. */
  byLevel: { l1: number; l2a: number; l2b: number };
  /** The buffer: the counted dollars summed in book order. */
  total: number;
}

/**
 * S3d fix round (ruling 2026-11-05): the dials a ladder takes. The ladder's undrawn face is the amount undrawn now,
 * U; the dials read it, so they carry no face and no undrawn amount of their own (face = U / (1 - Ubar)).
 */
export type LiquidityLadderDials = Omit<CommitmentDials, "face" | "undrawn">;

/** The dials a setup set on its liquidity stress, what they give, and the severe draw rate they set. */
export interface LiquidityCommitmentDials {
  /** The dials as the ladder read them: the setup's, with `undrawn` the ladder's undrawn face. */
  dials: CommitmentDials;
  result: CommitmentDialsResult;
  /** The severe row's draw rate as the table stated it. */
  statedSevereDrawRate: number;
  /**
   * The severe row's draw rate the ladder ran: the dials' requirement, (U99 - Ubar) x face, over the undrawn face, which
   * is (U99 - Ubar) / (1 - Ubar). The severe draw is the requirement in dollars, spread evenly over 12 months.
   */
  severeDrawRate: number;
}

/** The run's balances the survival path reads, month 1..H. */
export interface SurvivalPathLegs {
  horizonMonths: number;
  pools: { hys: number; nib: number };
  /** Principal of the inflow assets on the base path. */
  inflow: number[];
  /** The same at each inflow asset's liquidity stress speed (the moderate and severe rows read it). */
  inflowStress: number[];
  wholesaleMaturities: number[];
  cdMaturities: number[];
  /** S3d fix round: term deposits withdrawn early, which leave in full; absent reads zeros. */
  cdEarlyWithdrawals?: number[];
  undrawnFace: number;
}

/** A facility the bank has received (its own borrowing capacity), counted in the survival path only. */
export interface SurvivalPathFacility {
  label: string;
  capacity: number;
  /** The share of the capacity not counted in the stress, a decimal. */
  haircut: number;
  /** capacity x (1 - haircut). */
  counted: number;
}

/** One month of the survival path. */
export interface SurvivalPathRow {
  month: number;
  /** month x 365 / 12. */
  days: number;
  inflow: number;
  hysOut: number;
  nibOut: number;
  wholesaleOut: number;
  cdOut: number;
  draws: number;
  net: number;
  cumulative: number;
}

/** Survival against one buffer: the crossing in months and in days, and what the buffer does not cover. */
export interface SurvivalPathReading {
  buffer: number;
  /** First crossing of the buffer, interpolated between months; null when it is never crossed on the path. */
  survivalMonths: number | null;
  /** survivalMonths x 365 / 12; null with it. */
  survivalDays: number | null;
  /** max(0, -peakShortfall - buffer). */
  termFundingNeed: number;
}

/** The survival path, the ladder's monthly recursion carried past month 12 on the run's balances. */
export interface SurvivalPathResult {
  scenarioId: LiquidityStressScenario["id"];
  horizonMonths: number;
  params: LiquidityStressParams;
  legs: SurvivalPathLegs;
  rows: SurvivalPathRow[];
  /** The most negative cumulative on the path (0 when nothing flows out) and its month (null then). */
  peakShortfall: number;
  peakMonth: number | null;
  /** Against the ladder's buffer alone. */
  ladderBuffer: SurvivalPathReading;
  /** Present with a facility: the facility, and survival against the ladder's buffer plus the facility as counted. */
  facility?: SurvivalPathFacility;
  withFacility?: SurvivalPathReading;
}

/** The survival path a setup asks for: its length in months and, optionally, one received facility. */
export interface SurvivalPathOptions {
  /** A whole number of months from 12 to 120. */
  horizonMonths: number;
  facility?: { label?: string; capacity: number; haircut: number };
}

/**
 * The liquidity stress opt-in. The 1.9.0 shape `{ table, buffer, undrawnFace }` is unchanged; the
 * buffer may be left out (it is then read from the hqla-stock positions), and two optional parts may be added.
 */
export interface LiquidityStressOptions {
  table: LiquidityStressTable;
  buffer?: number;
  undrawnFace: number;
  /** Set: the severe row draws the dials' requirement, (U99 - Ubar) x face with face = undrawnFace / (1 - Ubar). */
  dials?: LiquidityLadderDials;
  /** Set: the run writes the survival path on the severe row. */
  survivalPath?: SurvivalPathOptions;
}
