/**
 * Non-parallel EVE channel decomposition (contract: contracts/results.ts
 * EveChannelsResult; the catalog's alm-eve component, three-way split).
 *
 * For each shocked scenario, EVE is regenerated FULL-LIFE four ways from the
 * same generator the key-rate module uses (one regeneration convention across
 * both analytics):
 *
 *   eveBase          projection base,    discounting base
 *   + projection leg projection shocked, discounting base   (behavioral channel)
 *   + discounting    projection base,    discounting shocked (valuation channel)
 *   eveShocked       projection shocked, discounting shocked (the total)
 *
 * The interaction remainder is total − projection − discounting BY DEFINITION.
 * It is not an error term: it is the projection-discounting interaction (the
 * negative convexity), exactly zero on a path-independent book (the fixed-rate
 * degeneracy the tests pin) and material where the shock moves a behavioral
 * driver.
 *
 * Convention parity with the run: the shocked projection path is the
 * DeterministicRatePath of the shocked curve — literally the same construction
 * as buildScenarioRatePath — and the NMD warmup history is NOT re-leveled,
 * because the run's own scenario projection (the headline EVE's cash flows)
 * does not re-level it. That keeps `totalDelta` reconcilable to the bucketed
 * `deltaEveVsBase` on books maturing inside the horizon; full-life vs
 * horizon-truncated PV is the one disclosed difference on longer books. (The
 * ±bump warmup re-level lives in the duration MEASUREMENT, ADR-008, and in the
 * key-rate module that reconciles to it — a different question from a
 * scenario's own EVE level.)
 *
 * Cost: three extra full-book regenerations per shocked scenario plus one base
 * leg — the reason this is an opt-in on the run pipeline context.
 *
 * Determinism: no clock, no RNG; scenarios emit in request order; positions
 * accumulate in COA declared family order.
 */
import { buildWarmupSOFR1M, DeterministicRatePath, type TLPCurve, type ZeroCurve } from "@alm/kernel";
import type { PortfolioSpec } from "../contracts/position";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { RunMacro } from "../macro/runMacro";
import type { EveChannelRow, EveChannelsResult } from "../contracts/results";
import type { Scenario } from "../contracts/scenario";
import { NotImplementedError } from "../runtime/notImplemented";
import { shockedCurve } from "../scenario/rateEnvironment";
import { hasDerivativeFamily } from "../swap/derivatives";
import type { DiscountBasis } from "./discount";
import {
  collectSidedPositions,
  derivativeEveOnLegs,
  discountPair,
  eveOnLegs,
  regeneratedEve,
  type SidedPosition,
} from "./keyRate";

/** Inputs for the standalone channel decomposition. */
export interface EveChannelsInputs {
  portfolio: PortfolioSpec;
  /** The run's scenarios; a base scenario (rateSpec kind "base") must exist. */
  scenarios: Scenario[];
  /** Base SOFR zero curve. */
  baseCurve: ZeroCurve;
  tlp: TLPCurve;
  horizonMonths: number;
  discountBasis?: DiscountBasis;
  /**
   * The run's rate index table, forwarded to every regenerated leg
   * so an indexed floater is wrapped. Absent when no position names an index.
   */
  rateIndices?: RateIndexTable;
  /**
   * The run's resolved macro value, threaded beside rateIndices to every
   * makeInstrument call. A mortgage carrying a housing group without it throws
   * MacroUnresolvedError. Absent outside a run.
   */
  macro?: RunMacro;
}

/**
 * Compute the channel decomposition for every non-base scenario. Throws typed
 * when no base scenario exists (every delta below is versus base; without a
 * base there is nothing to decompose, not a zero to invent).
 */
export function computeEveChannels(inputs: EveChannelsInputs): EveChannelsResult {
  const basis: DiscountBasis = inputs.discountBasis ?? "all-in";
  const { portfolio, scenarios, baseCurve, tlp, horizonMonths, rateIndices, macro } = inputs;
  if (!scenarios.some((s) => s.rateSpec.kind === "base")) {
    throw new NotImplementedError(
      "eve.channels",
      'no base scenario (rateSpec kind "base") present; every channel delta is ' +
        "measured versus base and is undefined without one",
    );
  }

  const sided: SidedPosition[] = collectSidedPositions(portfolio);
  const warmup = buildWarmupSOFR1M();

  // Base legs, computed once: the base-path cash flows and the base discount
  // pair serve every scenario's mixed legs.
  const eveBase = regeneratedEve(sided, baseCurve, tlp, basis, horizonMonths, warmup, 0, rateIndices, macro);
  const basePath = new DeterministicRatePath(baseCurve, horizonMonths);
  const dfBase = discountPair(baseCurve, tlp, basis);
  // Gate by FAMILY, the rule computeEve applies to pvDerivatives, so
  // a declared swap family with no swaps reports derivativesDelta 0 beside its
  // pvDerivatives 0. A book with no derivative family carries no key.
  const withDerivatives = hasDerivativeFamily(portfolio.coa);
  const derivBase = withDerivatives
    ? (derivativeEveOnLegs(sided, basePath, dfBase, warmup, 0, rateIndices, macro) ?? 0)
    : undefined;

  const byScenario: EveChannelRow[] = [];
  for (const scenario of scenarios) {
    if (scenario.rateSpec.kind === "base") continue;
    const cS = shockedCurve(baseCurve, scenario.rateSpec);
    const pathS = new DeterministicRatePath(cS, horizonMonths);
    const dfS = discountPair(cS, tlp, basis);

    // Three regenerated legs (the base leg above is the fourth). Warmup shift
    // is 0 on every leg, the run's scenario-projection convention (header).
    const eveShocked = eveOnLegs(sided, pathS, dfS, warmup, 0, rateIndices, macro);
    const eveProjOnly = eveOnLegs(sided, pathS, dfBase, warmup, 0, rateIndices, macro);
    const eveDiscOnly = eveOnLegs(sided, basePath, dfS, warmup, 0, rateIndices, macro);

    const totalDelta = eveShocked - eveBase;
    const projectionDelta = eveProjOnly - eveBase;
    const discountingDelta = eveDiscOnly - eveBase;
    const derivShocked =
      derivBase === undefined ? undefined : (derivativeEveOnLegs(sided, pathS, dfS, warmup, 0, rateIndices, macro) ?? 0);
    byScenario.push({
      scenarioId: scenario.id,
      eveBase,
      eveShocked,
      totalDelta,
      projectionDelta,
      discountingDelta,
      interactionResidual: totalDelta - projectionDelta - discountingDelta,
      ...(derivBase !== undefined && derivShocked !== undefined
        ? { derivativesDelta: derivShocked - derivBase }
        : {}),
    });
  }

  return { discountBasis: basis, byScenario };
}
