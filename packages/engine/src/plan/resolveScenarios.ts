/**
 * Plan scenario refs and inline definitions to engine Scenarios. Ramp timing
 * and environment paths are typed but unexecuted, so each is a REFUSAL rather
 * than a tag (round-2 ruling 12): a scenario that cannot run as declared would
 * otherwise produce numbers for a different scenario than the one authored.
 * The NotImplemented channel stays in the return shape for the tags a later
 * piece raises here; nothing writes to it today.
 */
import type { NotImplemented } from "../contracts/errors";
import type { AssumptionSetId, ScenarioId } from "../contracts/ids";
import type { PlanScenarioRef } from "../contracts/plan";
import type { NewBusinessStrategy, Scenario, ScenarioDefinition, ScenarioLibrary } from "../contracts/scenario";
import { defineScenario } from "../scenario/defineScenario";
import { ScenarioNotExecutableError } from "./compile";

export class ScenarioRefError extends Error {
  readonly ref: string;
  constructor(ref: string, detail: string) {
    super(`scenario ref "${ref}": ${detail}`);
    this.name = "ScenarioRefError";
    this.ref = ref;
  }
}

function lookup(ref: string, libraries: ScenarioLibrary[]): ScenarioDefinition {
  const hash = ref.indexOf("#");
  if (hash <= 0) throw new ScenarioRefError(ref, 'expected "<library id>#<scenario id>"');
  const libId = ref.slice(0, hash);
  const scId = ref.slice(hash + 1);
  const lib = libraries.find((l) => l.id === libId);
  if (!lib) throw new ScenarioRefError(ref, `no library "${libId}" (have: ${libraries.map((l) => l.id).join(", ")})`);
  const def = lib.scenarios.find((s) => s.id === scId);
  if (!def) throw new ScenarioRefError(ref, `library "${libId}" has no scenario "${scId}"`);
  return def;
}

export function resolveScenarios(
  refs: PlanScenarioRef[],
  libraries: ScenarioLibrary[],
  defaultNewBusiness: (id: ScenarioId) => NewBusinessStrategy,
  defaultAssumptionSetId: AssumptionSetId,
  horizonMonths: number,
): { scenarios: Scenario[]; notImplemented: NotImplemented[] } {
  const scenarios: Scenario[] = [];
  const notImplemented: NotImplemented[] = [];
  for (const r of refs) {
    const def: ScenarioDefinition = "ref" in r ? lookup(r.ref, libraries) : r;
    if (def.timing?.kind === "ramp") {
      throw new ScenarioNotExecutableError(
        def.id,
        `ramp timing over ${def.timing.months} months is typed but no rate-path model executes a ` +
          `time-varying shock; a scenario that cannot run as declared produces no numbers`,
      );
    }
    if (def.environment !== undefined) {
      // The length check runs first so an author fixing an array gets that
      // message before the blanket refusal, which is the honest state after it:
      // a correctly sized path still has no consumer.
      for (const key of ["housePriceIndexPath", "unemploymentPath"] as const) {
        const path = def.environment[key];
        if (path === undefined) continue;
        if (path.length < horizonMonths) {
          throw new ScenarioNotExecutableError(
            def.id,
            `environment.${key} has ${path.length} months and the run horizon is ${horizonMonths}`,
          );
        }
      }
      throw new ScenarioNotExecutableError(
        def.id,
        "environment paths on a scenario are refused; a macro path is market data, mapped in the assumption set's macroBindings, and every scenario in a run shares the base's path",
      );
    }
    const scenario = defineScenario({
      id: def.id,
      label: def.label ?? def.id,
      rateSpec: def.rateSpec,
      assumptionSetId: def.assumptionSetId ?? defaultAssumptionSetId,
      newBusiness: def.newBusiness ?? defaultNewBusiness(def.id),
    });
    // Attached here rather than through defineScenario: the model id is a
    // plan-level routing choice, so the structural gate stays where it is.
    if (def.ratePathModel !== undefined) scenario.ratePathModel = def.ratePathModel;
    scenarios.push(scenario);
  }
  return { scenarios, notImplemented };
}
