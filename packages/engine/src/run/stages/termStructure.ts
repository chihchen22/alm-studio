/**
 * term-structure: ZeroCurve -> RatePath and DiscountFactorPath, per scenario.
 *
 * Wraps `ratePaths.get(model)` by reference, once per scenario, with the model
 * the scenario names and "deterministic" when it names none. The registry lookup
 * is per SCENARIO, not per position, which is the speed rule's boundary; the
 * plugin that answered is asked of the registry and logged, never derived from a
 * naming convention.
 */
import type { RatePath, ZeroCurve } from "@alm/kernel";
import type { StageFn } from "./types";
import { requireRun } from "./types";

/** Cannot be reached once get() has succeeded; logged as a literal if it ever is. */
const UNREGISTERED = "<unregistered>";

export const runTermStructureStage: StageFn = (env, stage, input) => {
  const curve = requireRun<ZeroCurve>(env, stage, input, "ZeroCurve");
  const paths = new Map<string, RatePath>();
  for (const scenario of env.request.scenarios) {
    const modelId = scenario.ratePathModel ?? "deterministic";
    const path = env.ratePaths.get(modelId)(curve, scenario, env.horizonMonths);
    env.log({
      t: "resolve",
      key: "ratePaths",
      pluginId: env.ratePaths.providerOf(modelId) ?? UNREGISTERED,
      scope: { scenarioId: scenario.id, stageId: stage.id },
    });
    paths.set(scenario.id, path);
  }
  // One object carries both: the deterministic path holds its own discount
  // factors, so the DiscountFactorPath artifact IS the RatePath artifact. When a
  // model that separates them arrives, this is the line that splits.
  return { scenario: { RatePath: paths, DiscountFactorPath: paths } };
};
