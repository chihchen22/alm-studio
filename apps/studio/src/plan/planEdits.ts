/**
 * The canvas's edits (Studio S2). Each is a pure function plan -> plan that
 * changes exactly one field and leaves the input object untouched. Object
 * spread keeps key order, so the serialized plan differs only where the edit
 * landed.
 */
import type { ContractTypeName } from "@alm/engine";
import type { PlanDoc } from "./planGraph";

type Stage = PlanDoc["stages"][number];

export function serializePlan(plan: PlanDoc): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function mapStage(plan: PlanDoc, stageId: string, fn: (s: Stage) => Stage): PlanDoc {
  if (!plan.stages.some((s) => s.id === stageId)) throw new Error(`no stage "${stageId}" in plan ${plan.planId}`);
  return { ...plan, stages: plan.stages.map((s) => (s.id === stageId ? fn(s) : s)) };
}

export function swapComponent(plan: PlanDoc, stageId: string, component: string): PlanDoc {
  return mapStage(plan, stageId, (s) => ({ ...s, component }));
}

export function canConnect(plan: PlanDoc, from: string, to: string, type: string): boolean {
  if (from === to) return false;
  const a = plan.stages.find((s) => s.id === from);
  const b = plan.stages.find((s) => s.id === to);
  return a !== undefined && b !== undefined && a.produces.includes(type as ContractTypeName) && b.consumes.includes(type as ContractTypeName);
}

export function addWire(plan: PlanDoc, from: string, to: string): PlanDoc {
  if (!plan.stages.some((s) => s.id === from)) throw new Error(`no stage "${from}" in plan ${plan.planId}`);
  const target = plan.stages.find((s) => s.id === to);
  if (target?.dependsOn?.includes(from)) return plan;
  return mapStage(plan, to, (s) => ({ ...s, dependsOn: [...(s.dependsOn ?? []), from] }));
}

export function removeWire(plan: PlanDoc, from: string, to: string): PlanDoc {
  return mapStage(plan, to, (s) => ({ ...s, dependsOn: (s.dependsOn ?? []).filter((d) => d !== from) }));
}

export function withPlanId(plan: PlanDoc, planId: string): PlanDoc {
  return { ...plan, planId };
}

const MAX_ID = 64; // apps/server/src/store/paths.ts ID_PATTERN

export function nextEditId(baseId: string, taken: ReadonlySet<string>): string {
  const base = baseId.replace(/-edit-\d+$/, "");
  for (let n = 1; ; n += 1) {
    const suffix = `-edit-${n}`;
    const id = `${base.slice(0, MAX_ID - suffix.length)}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

export function editedStageIds(loaded: PlanDoc, current: PlanDoc): Set<string> {
  const before = new Map(loaded.stages.map((s) => [s.id, JSON.stringify(s)]));
  return new Set(current.stages.filter((s) => before.get(s.id) !== JSON.stringify(s)).map((s) => s.id));
}

export interface PlanEditSummary {
  stageIds: Set<string>;
  views: boolean;
  /** Any input other than the market changed (the book, or the taxonomy cross-check that rides with it). */
  book: boolean;
  /** Inputs.marketSnapshot changed. */
  market: boolean;
  /** The loaded plan named a taxonomy and the current one does not. */
  taxonomyDropped: boolean;
}

/** The plan inputs without the market, which is counted as its own edit. */
function inputsWithoutMarket(plan: PlanDoc): string {
  const { marketSnapshot: _market, ...rest } = plan.inputs;
  return JSON.stringify(rest);
}

export function planEditSummary(loaded: PlanDoc, current: PlanDoc): PlanEditSummary {
  return {
    stageIds: editedStageIds(loaded, current),
    views: JSON.stringify(loaded.views ?? []) !== JSON.stringify(current.views ?? []),
    book: inputsWithoutMarket(loaded) !== inputsWithoutMarket(current),
    market: loaded.inputs.marketSnapshot !== current.inputs.marketSnapshot,
    taxonomyDropped: loaded.inputs.dimensionTaxonomy !== undefined && current.inputs.dimensionTaxonomy === undefined,
  };
}

export function editCount(s: PlanEditSummary): number {
  return s.stageIds.size + (s.views ? 1 : 0) + (s.book ? 1 : 0) + (s.market ? 1 : 0);
}

export function editsText(s: PlanEditSummary): string {
  const parts: string[] = [];
  if (s.stageIds.size > 0) parts.push(s.stageIds.size === 1 ? "1 stage edited" : `${s.stageIds.size} stages edited`);
  if (s.views) parts.push("views changed");
  if (s.book) parts.push(s.taxonomyDropped ? "book changed, taxonomy cross-check dropped" : "book changed");
  if (s.market) parts.push("market changed");
  return parts.length === 0 ? "No edits" : parts.join("; ");
}
