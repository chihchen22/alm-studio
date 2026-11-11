/**
 * Canvas interaction state as pure functions (Studio S2). The canvas passes
 * nodes and edges to xyflow as controlled props, and xyflow 12 applies no
 * change to controlled items by itself: a click only reports a "select" change
 * and the Delete key only removes items that already carry `selected: true`.
 * So the canvas keeps the selected edge ids itself (from onEdgesChange) and
 * hands them back as flags; these helpers do that bookkeeping.
 */
import type { EdgeChange } from "@xyflow/react";
import { canConnect } from "./planEdits";
import type { PlanDoc } from "./planGraph";

/** The contract type a handle id names, or null when the id lacks the direction prefix. */
export function handleType(handle: string | null | undefined, prefix: "in:" | "out:"): string | null {
  return handle?.startsWith(prefix) ? handle.slice(prefix.length) : null;
}

export interface WireAttempt {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** A drag from an out-port to an in-port of the same type, between two different stages that the plan lets connect. */
export function connectionAllowed(plan: PlanDoc, c: WireAttempt): boolean {
  const out = handleType(c.sourceHandle, "out:");
  const inp = handleType(c.targetHandle, "in:");
  return c.source !== c.target && out !== null && out === inp && canConnect(plan, c.source, c.target, out);
}

/** The selected edge ids after xyflow's changes: "select" sets or clears one, "remove" drops it. */
export function applyEdgeSelection(selected: ReadonlySet<string>, changes: readonly EdgeChange[]): Set<string> {
  const next = new Set(selected);
  for (const c of changes) {
    if (c.type === "select") {
      if (c.selected) next.add(c.id);
      else next.delete(c.id);
    } else if (c.type === "remove") {
      next.delete(c.id);
    }
  }
  return next;
}

/**
 * Items with an explicit selected flag. xyflow only emits a deselect change for
 * an item whose flag is defined, so every item gets true or false.
 */
export function markSelected<T extends { id: string }>(items: readonly T[], selected: ReadonlySet<string>): Array<T & { selected: boolean }> {
  return items.map((it) => ({ ...it, selected: selected.has(it.id) }));
}

export interface ClickState {
  open: string | null;
  edges: ReadonlySet<string>;
}

/**
 * The canvas state after a node click. A stage opens its swap menu and clears
 * the wire selection, so Delete or Backspace pressed on the menu cannot remove a
 * wire behind it. A lane band (stageId null) changes nothing.
 */
export function afterNodeClick(stageId: string | null, s: ClickState): ClickState {
  return stageId === null ? s : { open: stageId, edges: new Set() };
}

/** Deleted edges back to plan wires, for onRemoveWire. */
export function wiresOf(edges: ReadonlyArray<{ source: string; target: string }>): Array<{ from: string; to: string }> {
  return edges.map((e) => ({ from: e.source, to: e.target }));
}
