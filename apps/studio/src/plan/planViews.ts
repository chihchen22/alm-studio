/**
 * The plan's views. Each edit is a pure function plan -> plan
 * that touches only `views`; the validate gate stays the judge of whether a view
 * is acceptable. viewDimensionOptions asks the engine's own shape check (rules
 * P1 and P2) which dimensions a book's taxonomy lets a view group by, so Studio
 * never restates those rules.
 */
import { DERIVED_DIMENSION_IDS, type DimensionTaxonomy } from "@alm/engine/src/contracts/dimensions";
import { checkViewShapes } from "@alm/engine/src/portfolio/cells";
import type { PlanDoc } from "./planGraph";

type View = NonNullable<PlanDoc["views"]>[number];

export interface ViewDimOption {
  id: string;
  label: string;
  /** true only for a derived id the taxonomy does not declare itself. */
  derived: boolean;
}

const DERIVED_LABEL: Record<string, string> = {
  productFamily: "Product family (derived)",
  side: "Side (derived)",
};

export function viewDimensionOptions(taxonomy: DimensionTaxonomy | undefined): ViewDimOption[] {
  const declared = (taxonomy?.dimensions ?? []).map((d) => ({ id: d.id, label: d.label, derived: false }));
  const declaredIds = new Set(declared.map((d) => d.id));
  const derived = DERIVED_DIMENSION_IDS.filter((id) => !declaredIds.has(id)).map((id) => ({
    id: id as string,
    label: DERIVED_LABEL[id] ?? `${id} (derived)`,
    derived: true,
  }));
  return [...declared, ...derived].filter((c) => {
    try {
      checkViewShapes([{ id: "probe", label: "probe", groupBy: [c.id] }], taxonomy);
      return true;
    } catch {
      return false;
    }
  });
}

/** The lowest free view-N in the plan. */
export function nextViewId(plan: PlanDoc): string {
  const taken = new Set((plan.views ?? []).map((v) => v.id));
  for (let n = 1; ; n += 1) if (!taken.has(`view-${n}`)) return `view-${n}`;
}

export function canAddView(label: string, groupBy: readonly string[]): boolean {
  return label.trim() !== "" && groupBy.length > 0 && new Set(groupBy).size === groupBy.length;
}

export function addView(plan: PlanDoc, label: string, groupBy: readonly string[]): PlanDoc {
  const text = label.trim();
  if (text === "") throw new Error("view label must not be blank");
  if (groupBy.length === 0) throw new Error("a view groups by at least one dimension");
  const seen = new Set<string>();
  for (const d of groupBy) {
    if (seen.has(d)) throw new Error(`dimension "${d}" is picked twice`);
    seen.add(d);
  }
  const view: View = { id: nextViewId(plan), label: text, groupBy: [...groupBy] };
  return { ...plan, views: [...(plan.views ?? []), view] };
}

export function removeView(plan: PlanDoc, viewId: string): PlanDoc {
  const views = plan.views ?? [];
  if (!views.some((v) => v.id === viewId)) throw new Error(`no view "${viewId}" in plan ${plan.planId}`);
  const rest = views.filter((v) => v.id !== viewId);
  if (rest.length > 0) return { ...plan, views: rest };
  const { views: _dropped, ...without } = plan;
  return without;
}

export function groupByText(groupBy: readonly string[]): string {
  return groupBy.join(" then ");
}
