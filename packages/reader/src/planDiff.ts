// packages/reader/src/planDiff.ts
/**
 * Structural diff of two run plans (Studio S3a confirm sheet). Compares stage
 * ids, each stage's component and the dependsOn wires. It carries no number:
 * params, scenarios and inputs are outside it by design (the spec's diff is
 * structural). Order: stages and wires in the order the plans list them.
 */
import type { RunPlan } from "@alm/engine";

/** The edge from -> to: stage `to` lists `from` in its dependsOn. */
export interface PlanWire {
  from: string;
  to: string;
}

export interface PlanDiff {
  componentChanges: Array<{ stageId: string; from: string; to: string }>;
  wiresAdded: PlanWire[];
  wiresRemoved: PlanWire[];
  stagesAdded: string[];
  stagesRemoved: string[];
}

function wiresOf(plan: RunPlan): PlanWire[] {
  return plan.stages.flatMap((s) => (s.dependsOn ?? []).map((d) => ({ from: d, to: s.id })));
}

const keyOf = (w: PlanWire) => `${w.from}\u0000${w.to}`;

export function planDiff(base: RunPlan, plan: RunPlan): PlanDiff {
  const baseStages = new Map(base.stages.map((s) => [s.id, s]));
  const planIds = new Set(plan.stages.map((s) => s.id));
  const componentChanges: PlanDiff["componentChanges"] = [];
  for (const s of plan.stages) {
    const b = baseStages.get(s.id);
    if (b !== undefined && b.component !== s.component) componentChanges.push({ stageId: s.id, from: b.component, to: s.component });
  }
  const baseWires = wiresOf(base);
  const planWires = wiresOf(plan);
  const baseKeys = new Set(baseWires.map(keyOf));
  const planKeys = new Set(planWires.map(keyOf));
  return {
    componentChanges,
    wiresAdded: planWires.filter((w) => !baseKeys.has(keyOf(w))),
    wiresRemoved: baseWires.filter((w) => !planKeys.has(keyOf(w))),
    stagesAdded: plan.stages.filter((s) => !baseStages.has(s.id)).map((s) => s.id),
    stagesRemoved: base.stages.filter((s) => !planIds.has(s.id)).map((s) => s.id),
  };
}

export function planDiffIsEmpty(d: PlanDiff): boolean {
  return d.componentChanges.length === 0 && d.wiresAdded.length === 0 && d.wiresRemoved.length === 0
    && d.stagesAdded.length === 0 && d.stagesRemoved.length === 0;
}

/** The seed names one plan per demo book `plan-<positionBook>` (apps/server/scripts/seedRunPlans.ts). */
export function seededPlanIdFor(positionBook: string): string {
  return `plan-${positionBook}`;
}
