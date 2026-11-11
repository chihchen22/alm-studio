/**
 * Static runoff projection engine.
 *
 * Given a portfolio and a scenario whose NewBusinessStrategy.mode is "static",
 * project the existing book's contractual + behavioral runoff under the
 * scenario's shocked rate path, with no new business. This is the driver behind
 * EVE and both gap ladders (architecture Section 4): the cash-flow core is the
 * m03 aggregator, and static runoff adds three things around it — the static-
 * mode guard, overlay application (applyStaticOverlays), and the scenario's
 * shocked-path wiring.
 *
 * "One field, not two engines": the same per-position generator and bucket
 * aggregator serve static and dynamic. This module simply supplies no
 * reinvestment tranches; the dynamic module adds them to the same accumulators.
 *
 * Determinism: no clock, no RNG. The rate path is the DeterministicRatePath
 * built from the scenario's shocked curve; aggregation runs positions in array
 * order into typed-array buckets (m03). Same inputs -> byte-identical result.
 */
import type { RatePath, ZeroCurve } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { PortfolioSpec } from "../../contracts/position";
import type { RateIndexTable } from "../../contracts/rateIndex";
import { macroTargetsOf, type RunMacro } from "../../macro/runMacro";
import type {
  BucketedCashflowResult,
  BucketGrid,
  ScenarioCashflows,
} from "../../contracts/results";
import type { Scenario } from "../../contracts/scenario";
import { aggregateScenario } from "../../portfolio/aggregate";
import { NotImplementedError } from "../../runtime/notImplemented";
import { buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { applyStaticOverlays } from "./applyOverlays";

/** A scenario paired with its ready shocked rate path and optional overlays. */
export interface StaticScenarioLeg {
  scenario: Scenario;
  /** The scenario's shocked path; build it with buildScenarioRatePath. */
  ratePath: RatePath;
  /** Behavioral overlays to apply; omit to project the positions' own terms. */
  assumptions?: AssumptionSet;
}

/**
 * Build the scenario's shocked rate path from a base curve. Composes the m04
 * seam: apply the RateSpec to the base curve (shockedCurve), then wrap it in a
 * DeterministicRatePath of the requested length. This is the "scenario's shocked
 * path" the aggregator consumes.
 */
export function buildScenarioRatePath(
  base: ZeroCurve,
  scenario: Scenario,
  nSteps: number,
  dtYears?: number,
): RatePath {
  return buildRatePath(shockedCurve(base, scenario.rateSpec), nSteps, dtYears);
}

/**
 * Project one static scenario over a portfolio into bucketed cash flows. The
 * portfolio is a separate argument (not on the leg) because a run projects the
 * SAME book under every scenario; keeping it out of the leg makes that explicit.
 * Guards the static mode: a dynamic scenario is the dynamic module's job, so it
 * is rejected here rather than silently ignoring its reinvestment rules.
 *
 * `rateIndices` is the run's resolved rate index table,
 * handed to aggregateScenario; an indexed floater without it is refused by the
 * factory rather than priced on the one-month benchmark. `macro` is
 * the run's RunMacro: its targets decide which families' terms carry housing,
 * and it reaches the factory the same way.
 */
export function projectStaticScenario(
  portfolio: PortfolioSpec,
  leg: StaticScenarioLeg,
  grid: BucketGrid,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): ScenarioCashflows {
  const { scenario, ratePath, assumptions } = leg;
  if (scenario.newBusiness.mode !== "static") {
    throw new NotImplementedError(
      "projection.static",
      `scenario "${scenario.id}" has new-business mode "${scenario.newBusiness.mode}"; ` +
        `static runoff requires mode "static" (dynamic reinvestment is the dynamic projection module)`,
    );
  }
  const effective = assumptions ? applyStaticOverlays(portfolio, assumptions, undefined, macro === undefined ? undefined : macroTargetsOf(macro)) : portfolio;
  return aggregateScenario(effective, { scenarioId: scenario.id, path: ratePath }, grid, rateIndices, macro);
}

/**
 * Project a portfolio across every static scenario leg, producing the
 * per-scenario BucketedCashflowResult. Scenarios emit in leg order; each is an
 * independent runoff of the same book under its own shocked path and overlays.
 */
export function projectStaticRunoffAll(
  portfolio: PortfolioSpec,
  legs: StaticScenarioLeg[],
  grid: BucketGrid,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): BucketedCashflowResult {
  const byScenario = legs.map((leg) => projectStaticScenario(portfolio, leg, grid, rateIndices, macro));
  return { grid, byScenario };
}

/** A negative balance in a bucketed series: the family, bucket index, and value. */
export interface NegativeBalanceHit {
  familyId: string;
  bucket: number;
  value: number;
}

/**
 * Scan a scenario's per-family balance series for a negative outstanding
 * balance, the invariant static runoff must never break. Returns the first hit
 * (family order, ascending bucket) or null. The COA roll-up is a sum of
 * non-negative family series, so checking the families is sufficient.
 */
export function findNegativeBalance(result: ScenarioCashflows): NegativeBalanceHit | null {
  for (const fam of result.byFamily) {
    const balance = fam.series.balance;
    for (let k = 0; k < balance.length; k++) {
      if (balance[k] < 0) return { familyId: fam.familyId, bucket: k, value: balance[k] };
    }
  }
  return null;
}
