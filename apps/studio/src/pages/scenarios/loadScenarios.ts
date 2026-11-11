// apps/studio/src/pages/scenarios/loadScenarios.ts
/** Scenarios route reads: the stored plans, the scenario library, the assumption sets and the balance plans. Nothing is computed. */
import type { ScenarioLibrary } from "@alm/engine";
import {
  getPlanLibrary,
  listAssumptionSets,
  listBalancePlans,
  listRunPlans,
  type AssumptionSetListItem,
  type BalancePlanListItem,
  type RunPlanMeta,
} from "@alm/reader";

export interface ScenariosData {
  plans: RunPlanMeta[];
  libraries: ScenarioLibrary[];
  sets: AssumptionSetListItem[];
  balancePlans: BalancePlanListItem[];
}

export async function loadScenarios(): Promise<ScenariosData> {
  const [plans, libraries, sets, balancePlans] = await Promise.all([listRunPlans(), getPlanLibrary(), listAssumptionSets(), listBalancePlans()]);
  return { plans, libraries, sets, balancePlans };
}
