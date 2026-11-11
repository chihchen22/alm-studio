/**
 * The plan's scenario edits (Studio S3b). Each is a pure function plan -> plan
 * that touches only `scenarios` and `inputs`, leaves the input object untouched
 * and keeps key order (object spread), so the serialized plan differs only
 * where the edit landed.
 *
 * A library ref cannot carry an assumption set (PlanScenarioRef is a
 * definition or a bare `{ ref }`), so giving one scenario its own set inlines
 * the library definition. The compiler's default set is
 * `inputs.assumptionSets[0]`; every S3b edit ends with syncSets, which keeps
 * that list equal to the default followed by the inline sets in scenario order.
 *
 * Piece 2 adds the balance plan bindings (`balancePlan`, `scenarioBalancePlans`) and the balance stage edit, which also touches `stages`.
 *
 * Piece 3 adds the shock builder's inline scenario edits (addInlineScenario, updateScenarioShock) and the base guard on removeScenario (isOnlyBase). The two builder edits do not call syncSets: they touch no set (an added scenario names none, an updated one keeps its own).
 */
import type { PlanScenarioRef, PlanStage, RateSpec, RunPlan, ScenarioDefinition, ScenarioLibrary } from "@alm/engine";

/** The scenario id: a ref's text after "#", or an inline definition's id. */
export function scenarioIdOf(r: PlanScenarioRef): string {
  return "ref" in r ? r.ref.slice(r.ref.indexOf("#") + 1) : r.id;
}

/** The library definition a ref names, or undefined when no library holds it. */
export function lookupRef(ref: string, libraries: ScenarioLibrary[]): ScenarioDefinition | undefined {
  const hash = ref.indexOf("#");
  if (hash <= 0) return undefined;
  const lib = libraries.find((l) => l.id === ref.slice(0, hash));
  return lib?.scenarios.find((s) => s.id === ref.slice(hash + 1));
}

function scenarioAt(plan: RunPlan, index: number): PlanScenarioRef {
  const s = plan.scenarios[index];
  if (s === undefined) throw new Error(`no scenario at index ${index} in plan ${plan.planId}`);
  return s;
}

/**
 * `inputs.assumptionSets` becomes [default, ...inline set ids in scenario
 * order], deduplicated, the default being the current first entry. A plan that
 * states no list keeps none; validate refuses such a plan until a default set
 * is named.
 */
export function syncSets(plan: RunPlan): RunPlan {
  const current = plan.inputs.assumptionSets;
  if (current === undefined) return plan;
  const inline = plan.scenarios.flatMap((s) => ("ref" in s || s.assumptionSetId === undefined ? [] : [s.assumptionSetId]));
  const head = current[0] === undefined ? [] : [current[0]];
  const next = [...new Set([...head, ...inline])];
  return { ...plan, inputs: { ...plan.inputs, assumptionSets: next } };
}

/** Appends `{ ref }`; returns the same plan when a scenario with that id is already present. */
export function addLibraryScenario(plan: RunPlan, ref: string): RunPlan {
  const id = scenarioIdOf({ ref });
  if (plan.scenarios.some((s) => scenarioIdOf(s) === id)) return plan;
  return syncSets({ ...plan, scenarios: [...plan.scenarios, { ref }] });
}

/** A run needs one base scenario (spec P3 Section 5.2 item 4); the Sets layer shows this as the Remove button's title. */
export const ONLY_BASE = "A run needs one base scenario";

/** A plan scenario's rate spec kind: inline as stored, a ref as its library holds it; undefined for a ref no library holds. */
function kindOf(s: PlanScenarioRef, libraries: ScenarioLibrary[]): RateSpec["kind"] | undefined {
  return ("ref" in s ? lookupRef(s.ref, libraries) : s)?.rateSpec.kind;
}

/** True when the scenario at `index` is the plan's only scenario of kind base; a ref no library holds counts as not base. */
export function isOnlyBase(plan: RunPlan, index: number, libraries: ScenarioLibrary[]): boolean {
  if (kindOf(scenarioAt(plan, index), libraries) !== "base") return false;
  return plan.scenarios.filter((s) => kindOf(s, libraries) === "base").length === 1;
}

/** Removes scenario `index` and its scenarioBalancePlans entry. Throws for the plan's only base scenario (isOnlyBase). */
export function removeScenario(plan: RunPlan, index: number, libraries: ScenarioLibrary[]): RunPlan {
  const id = scenarioIdOf(scenarioAt(plan, index));
  if (isOnlyBase(plan, index, libraries)) throw new Error(`${ONLY_BASE}: "${id}" is the only one in plan ${plan.planId}`);
  const next = syncSets({ ...plan, scenarios: plan.scenarios.filter((_, i) => i !== index) });
  return plan.scenarioBalancePlans?.[id] === undefined ? next : setScenarioBalancePlan(next, id, null);
}

/**
 * Gives scenario `index` its own set. A `{ ref }` becomes the library
 * definition plus `assumptionSetId`. `null` on an inline scenario deletes its
 * `assumptionSetId` (it stays inline); `null` on a ref is a no-op.
 */
export function setScenarioSet(plan: RunPlan, index: number, setId: string | null, libraries: ScenarioLibrary[]): RunPlan {
  const s = scenarioAt(plan, index);
  let next: PlanScenarioRef;
  if ("ref" in s) {
    if (setId === null) return plan;
    const def = lookupRef(s.ref, libraries);
    if (def === undefined) throw new Error(`unknown scenario ref "${s.ref}"`);
    next = { ...def, assumptionSetId: setId };
  } else if (setId === null) {
    const { assumptionSetId: _dropped, ...rest } = s;
    next = rest;
  } else {
    next = { ...s, assumptionSetId: setId };
  }
  return syncSets({ ...plan, scenarios: plan.scenarios.map((x, i) => (i === index ? next : x)) });
}

/** Makes `setId` the plan default (the first entry of `inputs.assumptionSets`). */
export function setDefaultSet(plan: RunPlan, setId: string): RunPlan {
  const rest = (plan.inputs.assumptionSets ?? []).slice(1);
  return syncSets({ ...plan, inputs: { ...plan.inputs, assumptionSets: [setId, ...rest] } });
}

/** The plan default balance plan; null removes the field. */
export function setPlanBalancePlan(plan: RunPlan, id: string | null): RunPlan {
  if (id !== null) return { ...plan, balancePlan: id };
  const { balancePlan: _dropped, ...rest } = plan;
  return rest as RunPlan;
}

/** One scenario's balance plan; null removes its entry, and an empty map is removed. */
export function setScenarioBalancePlan(plan: RunPlan, scenarioId: string, id: string | null): RunPlan {
  const map = { ...(plan.scenarioBalancePlans ?? {}) };
  if (id === null) delete map[scenarioId];
  else map[scenarioId] = id;
  if (Object.keys(map).length > 0) return { ...plan, scenarioBalancePlans: map };
  const { scenarioBalancePlans: _dropped, ...rest } = plan;
  return rest as RunPlan;
}

export function bindsBalancePlan(plan: RunPlan): boolean {
  return plan.balancePlan !== undefined || Object.keys(plan.scenarioBalancePlans ?? {}).length > 0;
}

export function hasBalanceStage(plan: RunPlan): boolean {
  return plan.stages.some((s) => s.kind === "balance-new-business");
}

export type StageEdit = { kind: "ok"; plan: RunPlan } | { kind: "refused"; text: string };

const NO_PLACE = "The chain has no NII stage that reads the contractual stage, so Studio cannot place the balance stage. Add it on the Model chain page.";

/**
 * Inserts the balance stage the way the server's balance-plan run test wires
 * it: it reads the contractual and term-structure stages, and the NII stage
 * reads it in place of the contractual stage (two Cashflow producers on one
 * edge is a T1 refusal). Every other stage keeps its edges.
 */
export function addBalanceStage(plan: RunPlan): StageEdit {
  if (hasBalanceStage(plan)) return { kind: "ok", plan };
  const contractual = plan.stages.find((s) => s.kind === "contractual-cashflow");
  const term = plan.stages.find((s) => s.kind === "term-structure" && s.produces.includes("RatePath"));
  const nii = plan.stages.find((s) => s.kind === "metric" && s.produces.includes("NiiResult"));
  if (contractual === undefined || term === undefined || nii === undefined || !(nii.dependsOn ?? []).includes(contractual.id)) {
    return { kind: "refused", text: NO_PLACE };
  }
  const taken = new Set(plan.stages.map((s) => s.id));
  let id = "st-balance";
  for (let n = 2; taken.has(id); n += 1) id = `st-balance-${n}`;
  const stage = {
    id, component: "engine.balance-plan", kind: "balance-new-business" as const,
    consumes: ["Position", "RatePath", "Cashflow"], produces: ["Cashflow"], dependsOn: [contractual.id, term.id],
  } as PlanStage;
  const stages = plan.stages.map((s) => (s.id === nii.id ? { ...s, dependsOn: (s.dependsOn ?? []).map((d) => (d === contractual.id ? id : d)) } : s));
  stages.splice(stages.findIndex((s) => s.id === contractual.id) + 1, 0, stage);
  return { kind: "ok", plan: { ...plan, stages } };
}

/**
 * A scenario built by the shock builder, appended as `{ id, label?,
 * rateSpec }`. It carries no assumption set, new business or path model, so it
 * follows the plan defaults. `inputs` is untouched (no syncSets: the scenario
 * names no set). Throws when the id is taken; the builder checks first and
 * compile's duplicate refusal is the backstop.
 */
export function addInlineScenario(plan: RunPlan, def: { id: string; label?: string; rateSpec: RateSpec }): RunPlan {
  if (plan.scenarios.some((s) => scenarioIdOf(s) === def.id)) throw new Error(`plan ${plan.planId} already holds a scenario "${def.id}"`);
  const next: ScenarioDefinition = def.label === undefined ? { id: def.id, rateSpec: def.rateSpec } : { id: def.id, label: def.label, rateSpec: def.rateSpec };
  return { ...plan, scenarios: [...plan.scenarios, next] };
}

/**
 * Replaces the rate spec and label of the inline scenario `id`. Its id,
 * position and every other field (assumption set, new business, path model)
 * are kept, so a scenarioBalancePlans entry keyed by the id stays valid.
 * `label` undefined removes the label. Throws for a ref, an unknown id, or a
 * base scenario on either side.
 */
export function updateScenarioShock(plan: RunPlan, id: string, rateSpec: RateSpec, label: string | undefined): RunPlan {
  const index = plan.scenarios.findIndex((s) => scenarioIdOf(s) === id);
  const s = plan.scenarios[index];
  if (s === undefined) throw new Error(`no scenario "${id}" in plan ${plan.planId}`);
  if ("ref" in s) throw new Error(`scenario "${id}" is a library ref; copy it under a new id instead`);
  if (s.rateSpec.kind === "base" || rateSpec.kind === "base") throw new Error(`the builder does not build or edit a base scenario ("${id}")`);
  let next: ScenarioDefinition;
  if (label === undefined) {
    const { label: _dropped, ...rest } = s;
    next = { ...rest, rateSpec };
  } else {
    next = { ...s, label, rateSpec };
  }
  return { ...plan, scenarios: plan.scenarios.map((x, i) => (i === index ? next : x)) };
}
