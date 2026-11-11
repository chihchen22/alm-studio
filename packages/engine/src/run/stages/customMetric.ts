/**
 * The custom metric arm.
 *
 * It is NOT a case of runMetricStage, because it needs the stage's PLUGIN ID:
 * the four built-in arms are chosen by the contract type they produce, and a
 * custom metric is chosen by which plugin registered it. The executor closes
 * over the plugin id when it resolves a metric stage producing
 * CustomMetricResult; every other metric stage keeps returning runMetricStage.
 *
 * The shape check runs on EVERY result, including the shipped demonstration
 * metric's. The function is third-party code reached through a seam, so the
 * walker never trusts what it returns; one broken rule fails the run.
 */
import type { PlanStage } from "../../contracts/plan";
import { validateCustomMetricResult } from "../../contracts/customMetric";
import type { ScenarioCashflows } from "../../contracts/results";
import type { CustomMetricInput } from "../../plugins/services";
import { CustomMetricShapeError, PlanGraphError } from "../executorErrors";
import type { StageInput, StageResult, StageRunEnv } from "./types";
import { positionsFor, requireScenario } from "./types";

export function runCustomMetricStage(
  pluginId: string,
  env: StageRunEnv,
  stage: PlanStage,
  input: StageInput,
): StageResult {
  const registered = env.metrics.customByPlugin(pluginId);
  if (registered === undefined) {
    throw new PlanGraphError(stage.id, `component "${pluginId}" registers no custom metric`);
  }

  // Ruling 6: exactly Cashflow and Position. The scenario order is the REQUEST
  // order, which is the order rule C3 requires the returned rows to be in.
  const scenarios = env.request.scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    assumptionSetId: scenario.assumptionSetId,
    cashflows: requireScenario<ScenarioCashflows>(env, stage, input, "Cashflow", scenario.id),
  }));
  const metricInput: CustomMetricInput = {
    horizonMonths: env.horizonMonths,
    baseScenarioId: env.baseScenario.id,
    scenarios,
    book: positionsFor(env, stage, input, env.baseScenario.assumptionSetId),
  };

  const result = registered.fn(metricInput);
  const problems = validateCustomMetricResult(result, {
    metricId: registered.metricId,
    scenarioIds: scenarios.map((s) => s.scenarioId),
  });
  const first = problems[0];
  if (first !== undefined) {
    throw new CustomMetricShapeError(registered.metricId, stage.id, first.rule, first.message);
  }

  for (const scenario of scenarios) {
    env.log({
      t: "resolve",
      key: "metrics",
      pluginId,
      scope: { scenarioId: scenario.scenarioId, metricId: registered.metricId, stageId: stage.id },
    });
  }
  return { run: { CustomMetricResult: result } };
}
