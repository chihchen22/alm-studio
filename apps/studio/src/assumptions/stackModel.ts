// apps/studio/src/assumptions/stackModel.ts
/**
 * The assumptions view model (Studio S3b). Reads stored sets, flattens
 * a base plus layers through the reader, asks the server for the diff and
 * reshapes both into rows a page prints. It computes no number: every value in
 * a row is a stored or returned value turned into text.
 */
import type { AssumptionDiff, AssumptionSet, MacroBinding, OverlayBinding } from "@alm/engine";
import { macroTargetIdentity } from "@alm/engine/src/macro/targetKey";
import {
  ApiError,
  bindingParts,
  createAssumptionSet,
  diffAssumptionSets,
  diffKey,
  flattenStack,
  getAssumptionSet,
  type FlatStack,
  type StackRow,
} from "@alm/reader";
import { errText } from "../errText";
import { leafView, NOT_STORED, type AbsentView, type LeafView } from "../format/leaf";
import { pathText } from "./pathText";
import { selectorText } from "./selectorText";

export interface BindingRowView {
  familyId: string;
  kind: string;
  selector: string;
  modelVersion: string;
  sourceId: string;
  fromLayer: boolean;
}

export function bindingRows(rows: StackRow[], baseId: string): BindingRowView[] {
  return rows.map(({ binding, sourceId }) => {
    const p = bindingParts(binding);
    return { familyId: p.familyId, kind: p.kind, selector: selectorText(binding.selector), modelVersion: p.modelVersion, sourceId, fromLayer: sourceId !== baseId };
  });
}

export interface DeltaRowView {
  familyId: string;
  kind: string;
  selector: string;
  /** In brackets (pathText); the engine's diff path is dotted. */
  path: string;
  change: "added" | "removed" | "changed";
  /**
   * A stored leaf through the shared leaf view (format/leaf.ts: Polish 4 T4, moved there by Polish 5 T1); a stored
   * null is the text leaf none. A side whose binding stores no leaf at the delta's path (the base on an added row,
   * the candidate on a removed row, a side of a changed row the other side lengthens or shortens) is the absence
   * Not stored instead, By kind's word for the same fact (Polish 5 Task 6 fix I1, Polish 6 T1).
   */
  from: LeafView | AbsentView<typeof NOT_STORED>;
  to: LeafView | AbsentView<typeof NOT_STORED>;
}

/**
 * Whether an overlay stores a leaf at an engine diff path. The engine's collectLeaves (packages/ai/src/compiler/diff.ts)
 * builds the path from the overlay down, object keys joined by "." and an array element by ".<index>", and keeps only
 * a number, string, boolean or null at its end; this walks the path the same way. A missing key, an index past the
 * end, or an object or array at the end is no leaf; a stored null is a leaf.
 */
function storesLeaf(overlay: unknown, path: string): boolean {
  let at: unknown = overlay;
  for (const seg of path.split(".")) {
    if (Array.isArray(at)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= at.length) return false;
      at = at[Number(seg)];
    } else if (at !== null && typeof at === "object" && Object.hasOwn(at, seg)) {
      at = (at as Record<string, unknown>)[seg];
    } else {
      return false;
    }
  }
  return at === null || typeof at === "number" || typeof at === "string" || typeof at === "boolean";
}

/**
 * One row per delta. The change is read from where the delta's binding key
 * lives (candidate only: added, base only: removed, both: changed), never from
 * a null value, since a leaf can be null on a binding present on both sides.
 * Each side is read from its own binding (Polish 6 T1): a side whose binding
 * stores no leaf at the delta's path prints Not stored; a stored leaf, null
 * included, prints the value the route returned. A macro mapping change
 * follows as one last row, macroDeltaRow.
 */
export function deltaRows(diff: AssumptionDiff, base: AssumptionSet, candidate: AssumptionSet): DeltaRowView[] {
  const byKey = (s: AssumptionSet) => new Map<string, OverlayBinding>(s.bindings.map((b) => [diffKey(b.familyId, b.overlay.kind, b.selector), b]));
  const inBase = byKey(base);
  const inCand = byKey(candidate);
  const macro = macroDeltaRow(diff);
  const rows = diff.deltas.map((d): DeltaRowView => {
    const key = diffKey(d.familyId, d.overlayKind, d.selector);
    const b = inBase.get(key);
    const c = inCand.get(key);
    const change = c !== undefined && b === undefined ? "added" : b !== undefined && c === undefined ? "removed" : "changed";
    return {
      familyId: d.familyId, kind: d.overlayKind, selector: selectorText(d.selector), path: pathText(d.path), change,
      from: b !== undefined && storesLeaf(b.overlay, d.path) ? leafView(d.from) : notStored,
      to: c !== undefined && storesLeaf(c.overlay, d.path) ? leafView(d.to) : notStored,
    };
  });
  return macro === null ? rows : [...rows, macro];
}

const notStored = { kind: "absent", text: NOT_STORED } as const;

/** The Kind cell of the one row a macro mapping change prints. */
export const MACRO_MAPPING_KIND = "macro mapping";

/** One macro binding as a diff side reads it: series, feeder, family and selector. */
function macroBindingText(b: MacroBinding): string {
  return `${b.seriesId} via ${b.feeder} to ${b.familyId}, ${selectorText(b.selector)}`;
}

/**
 * The one row the macro mapping prints when the route's diff carries it (the set diff
 * lists the field). The engine lists the mapping whole, never as leaf deltas, so the row does too: Family and
 * Selector name every family and selector either side maps, Path is the field, and each side lists its bindings in
 * stored order. A side with no mapping is Not stored. Null when the mapping does not differ.
 */
export function macroDeltaRow(diff: AssumptionDiff): DeltaRowView | null {
  const m = diff.macroBindings;
  if (m === undefined) return null;
  const all = [...(m.from ?? []), ...(m.to ?? [])];
  const side = (bs: MacroBinding[] | null) => (bs === null ? notStored : { kind: "text" as const, text: bs.map(macroBindingText).join("; ") });
  return {
    familyId: [...new Set(all.map((b) => b.familyId))].join(", "),
    kind: MACRO_MAPPING_KIND,
    selector: [...new Set(all.map((b) => selectorText(b.selector)))].join("; "),
    path: "macroBindings",
    change: m.from === null ? "added" : m.to === null ? "removed" : "changed",
    from: side(m.from),
    to: side(m.to),
  };
}

export type StackLoad =
  | { kind: "ok"; base: AssumptionSet; flat: FlatStack; diff: { kind: "ok"; rows: DeltaRowView[] } | { kind: "error"; text: string } }
  | { kind: "refused"; text: string };

export async function loadStack(baseId: string, layerIds: string[]): Promise<StackLoad> {
  let base: AssumptionSet;
  let flat: FlatStack;
  try {
    base = await getAssumptionSet(baseId);
    const layers = await Promise.all(layerIds.map(getAssumptionSet));
    flat = await flattenStack(base, layers);
  } catch (e) {
    return { kind: "refused", text: errText(e) };
  }
  try {
    const diff = await diffAssumptionSets({ baseId, candidate: flat.set });
    return { kind: "ok", base, flat, diff: { kind: "ok", rows: deltaRows(diff, base, flat.set) } };
  } catch (e) {
    return { kind: "ok", base, flat, diff: { kind: "error", text: errText(e) } };
  }
}

/**
 * Piece 7b follow-up (mfu2-a): why Save stack is off because the composed stack's mapping reads a family that lost
 * its house-price response, or null. For each macro binding of the stack the set must hold a four-factor prepay
 * binding on that family and selector with the housing group present; the engine's bind check
 * (scenario/macroBindings.ts) refuses the save otherwise, and a layer can cause it because flattenStack replaces a
 * binding by its key and keeps the one mapping. A stack with no mapping, or a family the mapping does not name, is
 * never held. Family and selector match by the engine's target identity (macro/targetKey), as Edit a set's mappedGap does.
 */
export function stackMappedGap(set: AssumptionSet): string | null {
  for (const m of set.macroBindings ?? []) {
    const at = macroTargetIdentity(m.familyId, m.selector);
    const cards = set.bindings.filter((b) => b.overlay.kind === "prepay" && b.overlay.model === "four-factor-cpr" && macroTargetIdentity(b.familyId, b.selector) === at);
    if (cards.length === 0) return `Off: the stack maps a series to ${m.familyId}, which has no four-factor prepay binding, and the engine refuses that at save`;
    if (!cards.some((b) => b.overlay.kind === "prepay" && b.overlay.model === "four-factor-cpr" && b.overlay.housing !== undefined)) {
      return `Off: the stack maps a series to ${m.familyId}, whose four-factor prepay binding carries no housing group, and the engine refuses that at save`;
    }
  }
  return null;
}

export type SaveOutcome =
  | { kind: "saved"; id: string }
  | { kind: "already-saved"; id: string }
  | { kind: "conflict"; id: string; text: string }
  | { kind: "refused"; text: string };

/**
 * Stores the flat set. A 409 means the id is taken: the stored set is read and
 * its bindings compared as canonical JSON, so a stack saved twice is
 * already-saved and a different set under the same id is a conflict.
 */
export async function saveStack(set: AssumptionSet): Promise<SaveOutcome> {
  try {
    const stored = await createAssumptionSet(set);
    return { kind: "saved", id: stored.id };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) return { kind: "refused", text: errText(e) };
    try {
      const stored = await getAssumptionSet(set.id);
      return canonicalJson(stored.bindings) === canonicalJson(set.bindings)
        ? { kind: "already-saved", id: set.id }
        : { kind: "conflict", id: set.id, text: errText(e) };
    } catch (readErr) {
      return { kind: "refused", text: errText(readErr) };
    }
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonical(v));
}
