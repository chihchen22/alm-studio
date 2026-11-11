/**
 * EVE engine: assemble the EVEResult for a regulatory grid.
 *
 * For each scenario the module reports two things kept deliberately separate:
 *
 *  - PV / EVE from the projection engine's bucketed cash flows (m05), discounted
 *    on that scenario's shocked all-in curve. pvAssets, pvLiabilities,
 *    per-family PV, EVE, and Δ-versus-base all come off these buckets, so the
 *    reported EVE reconciles to the cash flows that were projected — no second,
 *    independently-derived balance sheet.
 *
 *  - Effective duration (per family and of equity) from the effective-duration
 *    engine, which regenerates cash flows under a ±shock and re-levels behavior
 *    (effectiveDuration.ts), streaming the PV position by position and
 *    reusing the static-projection base-leg PV where a family is reuse-eligible.
 *    In the default `per-scenario` mode this runs around each scenario's own
 *    environment; the base scenario reproduces the Lab's single-instrument
 *    durations exactly. In `base-only` mode durations are computed once at the
 *    base environment and the shocked scenarios carry no duration block.
 *
 * Every computed duration passes the sanity gate before it is trusted
 * (sanityGate.ts): a rejected duration is left undefined and durationSanityPassed
 * goes false, never patched. The family sign check applies only at the base
 * environment; shocked environments gate on finiteness and magnitude, because a
 * behavioral family's effective duration is legitimately negative there
 * (wave5-duration-rootcause.md).
 *
 * Determinism: no clock, no RNG. Scenarios emit in the cash-flow input's order;
 * families accumulate in the COA's declared order; positions in array order.
 * Maps are lookup-only and never drive a numeric accumulation.
 *
 * Swaps: a derivative family's series is the net swap, and
 * it is discounted on the risk-free curve whatever the basis, into `pvDerivatives`, added to
 * EVE once and last. See ../swap/derivatives.ts.
 */
import type { TLPCurve, ZeroCurve } from "@alm/kernel";
import { isCommitmentFamily } from "../commitment/offBalanceSheet";
import { isNonRateFamily } from "../nonRate";
import type { PortfolioSpec, Position } from "../contracts/position";
import type {
  BucketedCashflowResult,
  CellEVE,
  EVEResult,
  FamilyEVE,
  ScenarioEVE,
} from "../contracts/results";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { RunMacro } from "../macro/runMacro";
import type { Scenario } from "../contracts/scenario";
import { NotImplementedError } from "../runtime/notImplemented";
import { shockedCurve } from "../scenario/rateEnvironment";
import { derivativeFamilyIds, hasDerivativeFamily, isDerivativeFamily } from "../swap/derivatives";
import { discountFunction, type DiscountBasis } from "./discount";
import {
  computeEnvironmentDurations,
  type FamilyPositions,
} from "./effectiveDuration";
import { familyDiscountSpreadBp, pvBucketedSeries } from "./pv";
import {
  applyDurationGate,
  DEFAULT_DURATION_BOUNDS,
  type DurationBounds,
} from "./sanityGate";

export interface EveInputs {
  /** The book under evaluation; supplies COA sides and positions for durations. */
  portfolio: PortfolioSpec;
  /** Per-scenario bucketed cash flows from the static-runoff projection (m05). */
  cashflows: BucketedCashflowResult;
  /** Scenario definitions, keyed by id, giving each scenario's rate shock. */
  scenarios: Scenario[];
  /** Base risk-free zero curve, bootstrapped once from the market snapshot. */
  baseCurve: ZeroCurve;
  /** Term-liquidity-premium overlay for the all-in funding curve. */
  tlp: TLPCurve;
  /**
   * Discount basis; "all-in" (default), the "risk-free" variant (no TLP), or
   * "spread-consistent" (all-in plus each position's own discountSpreadBp,
   * deposits forced to 0; one spread per family, see familyDiscountSpreadBp).
   */
  discountBasis?: DiscountBasis;
  /** Measurement bump for effective duration, bp. Default 100. */
  durationShockBp?: number;
  /** Sanity-gate bounds; defaults to DEFAULT_DURATION_BOUNDS. */
  bounds?: DurationBounds;
  /**
   * Where per-scenario effective durations are measured:
   *   - "per-scenario" (default): each scenario's durations at its own shocked
   *     environment (current behavior).
   *   - "base-only": durations computed once at the base environment; shocked
   *     scenarios carry no duration block (all fields undefined,
   *     durationSanityPassed true as a vacuous AND over evaluated gates). The
   *     EVE / Δ-EVE headline is unaffected — it comes from the bucketed PV pass,
   *     not the duration engine.
   */
  durationMode?: DurationMode;
  /**
   * The run's rate index table. Read only by the effective-duration
   * legs, which regenerate an indexed floater's cash flows on bumped paths;
   * the bucketed PV pass reads the projection and needs none. Absent when no
   * position names an index.
   */
  rateIndices?: RateIndexTable;
  /**
   * The run's resolved macro value, threaded beside rateIndices to every
   * makeInstrument call. A mortgage carrying a housing group without it throws
   * MacroUnresolvedError. Absent outside a run.
   */
  macro?: RunMacro;
  /**
   * The deposit warmup history per scenario id, present only when the
   * run named nmdWarmup. Each scenario's duration legs build its deposits on its
   * own history (re-levelled by the measurement bump for nmd), so the
   * base leg is the one the projection priced. Absent, the kernel warmup.
   */
  nmdWarmupByScenario?: ReadonlyMap<string, readonly number[]>;
  /**
   * Each scenario's short-rate shift in percent, present only when the run's sets bind a
   * full beta form. A full-form deposit's duration legs read the scenario's shift plus the measurement bump.
   */
  depositShiftByScenario?: ReadonlyMap<string, number>;
}

/** How the per-scenario effective durations are measured. */
export type DurationMode = "per-scenario" | "base-only";

interface ScenarioAgg {
  scenarioId: string;
  familyPv: Map<string, number>;
  pvAssets: number;
  pvLiabilities: number;
  pvDerivatives: number;
  eve: number;
  /** True iff this scenario's rate spec is the base (kind "base"). */
  isBase: boolean;
  /**
   * Environment durations for this scenario, or undefined when they were not
   * computed (base-only mode, a shocked scenario).
   */
  durations: ReturnType<typeof computeEnvironmentDurations> | undefined;
  /**
   * One PV per cell, present only when the cash-flow rows carry cell
   * series. pv is a pure function of the cell's bucketed series and the
   * discount function, so it costs one extra call per cell and is exact. No
   * duration: a per-cell effective duration is a bump-and-reprice per cell with
   * its own sanity gate, which is registered as a 2b gap rather than faked.
   */
  cellPv: CellEVE[] | undefined;
}

/** Compute the EVEResult for a run's scenarios. */
export function computeEve(inputs: EveInputs): EVEResult {
  const { portfolio, cashflows, scenarios, baseCurve, tlp } = inputs;
  const basis: DiscountBasis = inputs.discountBasis ?? "all-in";
  const shockBp = inputs.durationShockBp ?? 100;
  const bounds = inputs.bounds ?? DEFAULT_DURATION_BOUNDS;
  const durationMode: DurationMode = inputs.durationMode ?? "per-scenario";
  const horizon = cashflows.grid.horizonMonths;
  const coa = portfolio.coa;
  // Absent-key rule: a book with no derivative family carries no
  // pvDerivatives key and its EVE is computed exactly as before.
  const withDerivatives = hasDerivativeFamily(coa);
  const derivativeIds = derivativeFamilyIds(coa);
  const derivativeCells = new Set(
    (cashflows.cells ?? []).filter((c) => derivativeIds.has(c.familyId)).map((c) => c.id),
  );

  const scenarioById = new Map<string, Scenario>(scenarios.map((s) => [s.id, s]));

  // Positions grouped by family, in the COA's declared family order. The map is
  // seeded from the families array so unknown-family positions (already an error
  // upstream in the aggregator) simply do not contribute here.
  const positionsByFamily = new Map<string, Position[]>();
  for (const f of coa.families) positionsByFamily.set(f.id, []);
  for (const pos of portfolio.positions) {
    positionsByFamily.get(pos.familyId)?.push(pos);
  }
  // A commitment family carries UNDRAWN capacity, not a booked balance, and is
  // declared asset-side, so without this it would land in pvAssets and in the
  // duration pass with a negative (drawdown) principal stream. An undrawn line
  // has no PV to the bank and no effective duration to measure; excluding it is
  // the ruling that a draw moves cash and nothing else. Empty for every
  // book seeded before piece 7, so those runs are byte-identical.
  // Spread-consistent basis: the one spread each family's bucketed
  // series discounts at, resolved once, before any scenario. Every other basis
  // reads no spread, so this map stays empty and the PV pass is the pre-1.9.0
  // code path.
  const familySpreadBp = new Map<string, number>();
  if (basis === "spread-consistent") {
    for (const f of coa.families) {
      if (isCommitmentFamily(f) || isDerivativeFamily(f)) continue;
      familySpreadBp.set(f.id, familyDiscountSpreadBp(f.id, positionsByFamily.get(f.id) ?? []));
    }
  }
  const cellFamily = new Map<string, string>((cashflows.cells ?? []).map((c) => [c.id, c.familyId]));
  const nonRateFamilies = new Set(coa.families.filter((f) => isNonRateFamily(f)).map((f) => f.id));

  // S3a-1 follow-up: a non-rate-sensitive family is valued at book in every scenario and has no duration to measure.
  const famInputs: FamilyPositions[] = coa.families
    .filter((family) => !isCommitmentFamily(family) && !isNonRateFamily(family))
    .map((family) => ({
      family,
      positions: positionsByFamily.get(family.id) ?? [],
    }));

  // Pass A: per-scenario bucketed PV/EVE and environment durations.
  const aggs: ScenarioAgg[] = cashflows.byScenario.map((sc) => {
    const scenario = scenarioById.get(sc.scenarioId);
    if (!scenario) {
      throw new NotImplementedError(
        "eve",
        `cash flows carry scenario "${sc.scenarioId}" but no matching Scenario was supplied`,
      );
    }
    const scenarioCurve = shockedCurve(baseCurve, scenario.rateSpec);
    const df = discountFunction(scenarioCurve, tlp, 0, basis);
    // A swap leg discounts on the risk-free curve whatever the book's basis is.
    const dfRiskFree = discountFunction(scenarioCurve, tlp, 0, "risk-free");
    // A family at spread 0 (and every family on another basis) keeps `df` itself.
    const dfBySpread = new Map<number, (tYears: number) => number>([[0, df]]);
    const dfOf = (familyId: string): ((tYears: number) => number) => {
      const bp = familySpreadBp.get(familyId) ?? 0;
      let d = dfBySpread.get(bp);
      if (d === undefined) {
        d = discountFunction(scenarioCurve, tlp, 0, basis, bp);
        dfBySpread.set(bp, d);
      }
      return d;
    };

    const familyPv = new Map<string, number>();
    let pvAssets = 0;
    let pvLiabilities = 0;
    let pvDerivatives = 0;
    for (const f of coa.families) {
      // Off balance sheet: no PV row and no side contribution (see famInputs).
      // The FamilyEVE row below reads familyPv with a `?? 0` default, so the
      // family still appears, carrying the zero PV an undrawn line actually has.
      if (isCommitmentFamily(f)) continue;
      const fam = sc.byFamily.find((x) => x.familyId === f.id);
      if (isDerivativeFamily(f)) {
        // The family series is the NET swap (rows signed at
        // emission), so its PV is the swap's value. Accumulated apart and
        // added once, last, so the book figures are untouched.
        const pv = fam ? pvBucketedSeries(fam.series, dfRiskFree) : 0;
        familyPv.set(f.id, pv);
        pvDerivatives += pv;
        continue;
      }
      // S3a-1 follow-up: a non-rate-sensitive balance is valued at par, its book value (the balance the series holds at
      // the as-of date), in every scenario. No discounting, so base and shocked value carry the same amount.
      const pv = fam ? (isNonRateFamily(f) ? (fam.series.balance[0] ?? 0) : pvBucketedSeries(fam.series, dfOf(f.id))) : 0;
      familyPv.set(f.id, pv);
      if (f.side === "liability") pvLiabilities += pv;
      else if (f.side === "asset") pvAssets += pv;
    }
    const eve = withDerivatives ? pvAssets - pvLiabilities + pvDerivatives : pvAssets - pvLiabilities;
    const cellPv =
      sc.byCell === undefined
        ? undefined
        : sc.byCell.map(
            (c): CellEVE => ({
              cellId: c.cellId,
              pv: nonRateFamilies.has(cellFamily.get(c.cellId) ?? "")
                ? (c.series.balance[0] ?? 0)
                : pvBucketedSeries(
                    c.series,
                    derivativeCells.has(c.cellId) ? dfRiskFree : dfOf(cellFamily.get(c.cellId) ?? ""),
                  ),
            }),
          );
    // Durations run at this scenario's own environment (per-scenario mode) or
    // only at the base scenario (base-only mode). The static-projection family
    // PV is handed in as the reusable base-leg PV; effectiveDuration guards the
    // reuse per family against the horizon (EVE-OBS-1).
    const isBase = scenario.rateSpec.kind === "base";
    const durations =
      durationMode === "per-scenario" || isBase
        ? computeEnvironmentDurations(
            famInputs,
            scenarioCurve,
            tlp,
            horizon,
            shockBp,
            basis,
            {
              reuseBasePv: familyPv,
              rateIndices: inputs.rateIndices,
              macro: inputs.macro,
              ...(inputs.nmdWarmupByScenario?.has(sc.scenarioId) === true
                ? { nmdWarmup: inputs.nmdWarmupByScenario.get(sc.scenarioId)! }
                : {}),
              ...(inputs.depositShiftByScenario?.has(sc.scenarioId) === true
                ? { depositShiftPct: inputs.depositShiftByScenario.get(sc.scenarioId)! }
                : {}),
            },
          )
        : undefined;
    return {
      scenarioId: sc.scenarioId,
      familyPv,
      pvAssets,
      pvLiabilities,
      pvDerivatives,
      eve,
      isBase,
      durations,
      cellPv,
    };
  });

  // Base EVE anchors the deltas. The run contract guarantees a base scenario; its
  // absence is a hard precondition failure, not a number to invent.
  const baseAgg = aggs.find(
    (a) => scenarioById.get(a.scenarioId)?.rateSpec.kind === "base",
  );
  if (!baseAgg) {
    throw new NotImplementedError(
      "eve",
      "no base scenario (rateSpec kind \"base\") present; Δ-EVE versus base is undefined",
    );
  }
  const baseEve = baseAgg.eve;

  // Pass B: gate the durations and assemble the scenario rows.
  const byScenario: ScenarioEVE[] = aggs.map((a) => {
    const deltaEveVsBase = a.eve - baseEve;
    // Δ-EVE as a decimal fraction of base EVE (e.g. -0.05 = down 5%). Guarded at
    // zero base equity, where a fractional change is undefined.
    const deltaEvePct = baseEve !== 0 ? deltaEveVsBase / baseEve : 0;

    // Base-only mode, shocked scenario: no duration block. Every duration field
    // is left undefined and durationSanityPassed is true as a vacuous AND over
    // the (empty) set of evaluated gates — "not computed here".
    if (a.durations === undefined) {
      const byFamily: FamilyEVE[] = coa.families.map((f) => ({
        familyId: f.id,
        pv: a.familyPv.get(f.id) ?? 0,
      }));
      return {
        scenarioId: a.scenarioId,
        pvAssets: a.pvAssets,
        pvLiabilities: a.pvLiabilities,
        ...(withDerivatives ? { pvDerivatives: a.pvDerivatives } : {}),
        eve: a.eve,
        deltaEveVsBase,
        deltaEvePct,
        byFamily,
        ...(a.cellPv !== undefined ? { byCell: a.cellPv } : {}),
        durationSanityPassed: true,
      };
    }

    // Family sign gate applies only at the base environment; shocked
    // environments gate on finiteness and magnitude, since a behavioral family's
    // effective duration is legitimately negative there.
    const familySignGate = a.isBase ? "positive" : "any";
    const gate = applyDurationGate(
      a.durations.perFamily.map((p) => ({
        familyId: p.familyId,
        effectiveDuration: p.effectiveDuration,
      })),
      a.durations.effectiveDurationEquity,
      familySignGate,
      bounds,
    );

    const byFamily: FamilyEVE[] = coa.families.map((f) => {
      const fe: FamilyEVE = { familyId: f.id, pv: a.familyPv.get(f.id) ?? 0 };
      const ed = gate.familyDurations.get(f.id);
      if (ed !== undefined) fe.effectiveDuration = ed;
      return fe;
    });

    const se: ScenarioEVE = {
      scenarioId: a.scenarioId,
      pvAssets: a.pvAssets,
      pvLiabilities: a.pvLiabilities,
      ...(withDerivatives ? { pvDerivatives: a.pvDerivatives } : {}),
      eve: a.eve,
      deltaEveVsBase,
      deltaEvePct,
      byFamily,
      ...(a.cellPv !== undefined ? { byCell: a.cellPv } : {}),
      durationSanityPassed: gate.durationSanityPassed,
    };
    if (gate.effectiveDurationEquity !== undefined) {
      se.effectiveDurationEquity = gate.effectiveDurationEquity;
    }
    return se;
  });

  // Echo the resolved measurement policy into the result (schemaVersion 1.1.0)
  // so a reader can tell base-only from per-scenario without inferring it from
  // undefined duration fields.
  return { discountBasis: basis, durationMode, byScenario };
}
