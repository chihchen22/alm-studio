/**
 * Run-level attribution assembly.
 *
 * The attribution engine (m10) owns the peel order and the residual accounting;
 * it consumes a per-family metric evaluator that the run layer must supply
 * (computeAttribution's INPUT header). This module builds that evaluator.
 *
 * What a peel state means here. In a regulatory grid every shocked scenario
 * shares the base scenario's assumption set and new-business strategy and runs
 * the same book, so the ONLY thing that differs from base is the rate
 * environment. The rate driver therefore carries the whole family delta and
 * every other driver is a genuine no-op: toggling it moves nothing because that
 * dimension is identical between base and scenario. The evaluator returns the
 * scenario family metric once "rate" is applied and the base family metric
 * before it, which is not a shortcut but the exact decomposition for a rate-only
 * shock (rate = totalDelta, all other drivers = 0, residual = 0 up to float
 * noise).
 *
 * A scenario that ALSO changes assumptions or new business is a genuine
 * multi-driver decomposition: reconstructing its intermediate peel states means
 * re-projecting the book under partial configurations, which this prototype does
 * not build. Rather than fabricate a split, such a scenario's headlines are
 * declined with a NotImplemented tag (anti-fabrication rule), and the rest of the
 * run proceeds.
 *
 * Determinism: metrics are read from the already-computed, deterministic NII and
 * EVE results; the evaluator is a pure lookup; families iterate in the COA's
 * declared order. No clock, no RNG, no Map iteration in a serialized number.
 */
import type { NotImplemented } from "../contracts/errors";
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import type { ProductFamilyId } from "../contracts/ids";
import type {
  AttributionResult,
  EVEResult,
  NIIResult,
  ScenarioEVE,
  ScenarioNII,
} from "../contracts/results";
import type { Scenario } from "../contracts/scenario";
import {
  computeAttribution,
  type FamilyMetricEvaluator,
  type HeadlineMetric,
  type HeadlineTarget,
} from "../attribution";
import { makeNotImplemented } from "../runtime";

const HEADLINE_METRICS: readonly HeadlineMetric[] = ["nii-12m", "nii-24m", "eve"];

/** One metric endpoint: the scenario total and each family's contribution to it. */
interface MetricEndpoint {
  total: number;
  byFamily: Map<ProductFamilyId, number>;
}

/** The result of assembling attribution for a run. */
export interface RunAttribution {
  result: AttributionResult;
  /** Scenarios whose multi-driver decomposition the prototype does not build. */
  notImplemented: NotImplemented[];
}

/** Two scenarios differ only in their rate environment (same set, same new business). */
function onlyRateDiffers(scenario: Scenario, base: Scenario): boolean {
  return (
    scenario.assumptionSetId === base.assumptionSetId &&
    JSON.stringify(scenario.newBusiness) === JSON.stringify(base.newBusiness)
  );
}

/** Assemble the AttributionResult (and any declined headlines) for a run. */
export function buildRunAttribution(
  nii: NIIResult,
  eve: EVEResult,
  scenarios: Scenario[],
  coa: ChartOfAccounts,
  baseScenario: Scenario,
): RunAttribution {
  const families = coa.families.map((f) => f.id);
  const sideById = new Map(coa.families.map((f) => [f.id, f.side] as const));

  const niiByScenario = new Map<string, ScenarioNII>();
  for (const s of nii.byScenario) niiByScenario.set(s.scenarioId, s);
  const eveByScenario = new Map<string, ScenarioEVE>();
  for (const s of eve.byScenario) eveByScenario.set(s.scenarioId, s);

  const endpoint = (metric: HeadlineMetric, scenarioId: string): MetricEndpoint => {
    if (metric === "eve") {
      const s = eveByScenario.get(scenarioId);
      if (!s) throw new Error(`attribution: EVE has no scenario "${scenarioId}"`);
      const byFamily = new Map<ProductFamilyId, number>();
      for (const f of s.byFamily) {
        // Signed contribution to EVE: assets and derivatives add, liabilities
        // subtract, so the family sum reconciles to
        // pvAssets - pvLiabilities + pvDerivatives = eve exactly.
        const sign = sideById.get(f.familyId) === "liability" ? -1 : 1;
        byFamily.set(f.familyId, sign * f.pv);
      }
      return { total: s.eve, byFamily };
    }
    const s = niiByScenario.get(scenarioId);
    if (!s) throw new Error(`attribution: NII has no scenario "${scenarioId}"`);
    const byFamily = new Map<ProductFamilyId, number>();
    for (const f of s.byFamily) {
      byFamily.set(f.familyId, metric === "nii-12m" ? f.net12 : f.net24);
    }
    return { total: metric === "nii-12m" ? s.totalNet12 : s.totalNet24, byFamily };
  };

  const headlines: HeadlineTarget[] = [];
  const notImplemented: NotImplemented[] = [];

  for (const scenario of scenarios) {
    if (scenario.id === baseScenario.id) continue;
    if (!onlyRateDiffers(scenario, baseScenario)) {
      notImplemented.push(
        makeNotImplemented(
          `attribution.${scenario.id}`,
          `scenario "${scenario.id}" changes assumptions or new business versus base; ` +
            `the multi-driver peel requires re-projecting partial configurations, which this prototype does not build`,
        ),
      );
      continue;
    }

    for (const metric of HEADLINE_METRICS) {
      // A block a run left without scenarios (its tag says why) has no headline to peel.
      if ((metric === "eve" ? eve.byScenario : nii.byScenario).length === 0) continue;
      const base = endpoint(metric, baseScenario.id);
      const shocked = endpoint(metric, scenario.id);
      const evaluate: FamilyMetricEvaluator = (familyId, applied) => {
        const src = applied.includes("rate") ? shocked.byFamily : base.byFamily;
        const v = src.get(familyId);
        if (v === undefined) {
          throw new Error(
            `attribution: family "${familyId}" missing for metric "${metric}" scenario "${scenario.id}"`,
          );
        }
        return v;
      };
      headlines.push({
        metric,
        scenarioId: scenario.id,
        baseValue: base.total,
        scenarioValue: shocked.total,
        families,
        evaluate,
      });
    }
  }

  return { result: computeAttribution({ headlines }), notImplemented };
}
