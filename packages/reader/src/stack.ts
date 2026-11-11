/**
 * The assumption stack (Studio S3b). BAU plus stress layers
 * flatten into ONE ordinary AssumptionSet, so the engine never sees a layer.
 * Merge rule (ruling 2026-09-26): whole-rule replace keyed by family,
 * registry kind and canonical selector. This module reshapes stored data; it
 * computes no number.
 */
import type { AssumptionSet, DimensionPredicate, OverlayBinding } from "@alm/engine";
import { overlayKindOf } from "@alm/engine/src/contracts/assumptions";
import { canonicalPredicate } from "@alm/engine/src/plan/dimensions";

export class StackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackError";
  }
}

/** The base and the layers carry different macro mappings; a stack carries one. */
export class MacroStackConflictError extends StackError {
  constructor(message: string) { super(message); this.name = "MacroStackConflictError"; }
}

/** A stable stringify with sorted keys, for comparing mappings (the reader may not import node:crypto). */
function canonicalJsonOf(v: unknown): string {
  if (v === undefined || v === null || typeof v !== "object") return v === undefined ? "null" : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJsonOf).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJsonOf(o[k])}`).join(",")}}`;
}

export interface StackRow { binding: OverlayBinding; sourceId: string }
export interface FlatStack { set: AssumptionSet; rows: StackRow[] }

export function bindingKey(b: OverlayBinding): string {
  return `${b.familyId}::${overlayKindOf(b.overlay)}::${canonicalPredicate(b.selector)}`;
}

/** The key packages/ai/src/compiler/diff.ts matches deltas on (overlay.kind, not the registry kind), restated. */
export function diffKey(familyId: string, overlayKind: string, selector: DimensionPredicate | undefined): string {
  return `${familyId}::${overlayKind}::${canonicalPredicate(selector)}`;
}

export function bindingParts(b: OverlayBinding): { familyId: string; kind: string; selector: string; modelVersion: string } {
  return { familyId: b.familyId, kind: overlayKindOf(b.overlay), selector: canonicalPredicate(b.selector), modelVersion: b.modelVersion };
}

export const isStackId = (id: string): boolean => id.startsWith("stack-");

export async function stackId(baseId: string, layerIds: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([baseId, ...layerIds]));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `stack-${hex.slice(0, 12)}`;
}

export function stackLabel(baseId: string, layerIds: readonly string[]): string {
  return `Stack: ${[baseId, ...layerIds].join(" + ")}`;
}

function keysOnce(s: AssumptionSet): void {
  const seen = new Set<string>();
  for (const b of s.bindings) {
    const k = bindingKey(b);
    if (seen.has(k)) throw new StackError(`set "${s.id}" binds ${k} twice; a stack cannot say which one wins`);
    seen.add(k);
  }
}

export async function flattenStack(base: AssumptionSet, layers: readonly AssumptionSet[]): Promise<FlatStack> {
  for (const l of layers) {
    if (isStackId(l.id)) throw new StackError(`stored stack "${l.id}" cannot be a layer; pick it as the base instead`);
  }
  for (const s of [base, ...layers]) keysOnce(s);
  const rows: StackRow[] = base.bindings.map((binding) => ({ binding, sourceId: base.id }));
  const at = new Map(rows.map((r, i) => [bindingKey(r.binding), i] as const));
  for (const layer of layers) {
    for (const binding of layer.bindings) {
      const k = bindingKey(binding);
      const i = at.get(k);
      if (i === undefined) {
        at.set(k, rows.length);
        rows.push({ binding, sourceId: layer.id });
      } else {
        rows[i] = { binding, sourceId: layer.id };
      }
    }
  }
  const layerIds = layers.map((l) => l.id);
  // One macro mapping per stack. The base's is kept, a layer may supply
  // one the base lacks or repeat it, and two different ones refuse the stack.
  const mapped = [base, ...layers].filter((s) => s.macroBindings !== undefined);
  const distinct = new Set(mapped.map((s) => canonicalJsonOf(s.macroBindings)));
  if (distinct.size > 1) {
    throw new MacroStackConflictError(
      `stack refused: ${mapped.map((s) => `"${s.id}"`).join(", ")} carry different macro mappings; a stack carries one mapping`);
  }
  const macroBindings = mapped[0]?.macroBindings;
  const set: AssumptionSet = {
    schemaVersion: base.schemaVersion,
    id: await stackId(base.id, layerIds),
    label: stackLabel(base.id, layerIds),
    bindings: rows.map((r) => r.binding),
    ...(macroBindings !== undefined ? { macroBindings } : {}),
  };
  return { set, rows };
}
