// apps/studio/src/assumptions/byKindModel.ts
/**
 * Data > Assumptions, one page per behavioral kind (ALM Studio P1). Stored
 * sets side by side, read-only. No parameter schema exists, so a row is a
 * stored leaf named by its path. A cell is the stored leaf through the leaf
 * view the Stack diff uses (format/leaf.ts, Polish 5 T1): a number is a figure,
 * grouped, with its stored text kept for the title; any other leaf is text. A
 * set with no leaf at the path gets an absence word instead.
 */
import type { AssumptionSet } from "@alm/engine";
// The contracts module, not the engine barrel: the barrel pulls node:crypto into the browser build (as reader stack.ts does).
import { overlayKindOf } from "@alm/engine/src/contracts/assumptions";
import { bindingKey } from "@alm/reader";
import { selectorText } from "./selectorText";
import { leafView, NOT_STORED, type AbsentView, type LeafValue, type LeafView } from "../format/leaf";

export type ByKindLayer = "data/assumptions/prepay" | "data/assumptions/decay" | "data/assumptions/deposit-repricing" | "data/assumptions/renewal-draws" | "data/assumptions/loan-repricing";

export const KIND_OF_LAYER: Record<ByKindLayer, string[]> = {
  "data/assumptions/prepay": ["prepay"],
  "data/assumptions/decay": ["nmd-decay"],
  "data/assumptions/deposit-repricing": ["deposit-beta"],
  "data/assumptions/renewal-draws": ["cd-rollover", "commitment-draw"],
  "data/assumptions/loan-repricing": ["loan-client-rate"],
};

/** The set binds no rule for this (family, kind, selector) group. */
export const NOT_BOUND = "Not bound";
// NOT_STORED, the word Not stored (format/leaf.ts): the set binds the group, but its stored overlay has no leaf at this
// path (another prepay model, a shorter ramp). One constant, shared with the Stack diff (Polish 6 T1).

/** A By kind cell: a stored leaf as the shared leaf view prints it, or a word saying the set holds no leaf there. */
export type ByKindCell = LeafView | AbsentView<typeof NOT_BOUND | typeof NOT_STORED>;

/** Every stored leaf under an overlay, by path, with its stored value (Polish 5 T1: the value, not its text). */
export function leaves(value: unknown, prefix = ""): Array<{ path: string; value: LeafValue }> {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${prefix}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !(prefix === "" && k === "kind"))
      .flatMap(([k, v]) => leaves(v, prefix === "" ? k : `${prefix}.${k}`));
  }
  // A stored overlay is JSON, so a value that is neither an array nor an object is a number, string, boolean or null.
  return [{ path: prefix, value: value as LeafValue }];
}

export interface ByKindModel {
  columns: Array<{ id: string; label: string }>;
  rows: Array<{ key: string; familyId: string; selector: string; path: string; cells: ByKindCell[] }>;
}

export function byKindModel(sets: AssumptionSet[], kinds: string[]): ByKindModel {
  const binds = (s: AssumptionSet) => s.bindings.filter((b) => kinds.includes(overlayKindOf(b.overlay)));
  const cols = sets.filter((s) => binds(s).length > 0);
  const rowKeys: Array<{ key: string; group: string; familyId: string; selector: string; path: string }> = [];
  const values = new Map<string, Map<string, LeafValue>>(); // row key -> set id -> stored value
  const bound = new Map<string, Set<string>>(); // set id -> the groups it binds
  for (const s of cols) {
    const groups = new Set<string>();
    bound.set(s.id, groups);
    for (const b of binds(s)) {
      // The group is the reader's binding key (family, registry kind, canonical selector), so key order cannot split a row.
      const group = bindingKey(b);
      groups.add(group);
      // The selector in words (Polish 2 A5); the group above stays the canonical key.
      const selector = selectorText(b.selector);
      for (const leaf of leaves(b.overlay)) {
        const key = `${group}|${leaf.path}`;
        if (!values.has(key)) {
          values.set(key, new Map());
          rowKeys.push({ key, group, familyId: b.familyId, selector, path: leaf.path });
        }
        values.get(key)!.set(s.id, leaf.value);
      }
    }
  }
  // has(), not ??: a stored null is a leaf (it prints "none"), not an absence.
  const cell = (key: string, group: string, setId: string): ByKindCell => {
    const bySet = values.get(key)!;
    if (bySet.has(setId)) return leafView(bySet.get(setId) as LeafValue);
    return { kind: "absent", text: bound.get(setId)!.has(group) ? NOT_STORED : NOT_BOUND };
  };
  return {
    columns: cols.map((s) => ({ id: s.id, label: s.label })),
    rows: rowKeys.map(({ group, ...r }) => ({ ...r, cells: cols.map((s) => cell(r.key, group, s.id)) })),
  };
}

/** The identity columns' header labels, in order (pages/assumptions/ByKindPage.tsx). */
export const IDENTITY_LABELS = ["Family", "Selector", "Parameter"] as const;

/**
 * The identity columns' widths for one By kind page, in px (Polish 6 Task 6 fix I2): each column's longest text,
 * its header label included, at the 12 px cell size (tokens.css --fs-1), rounded up, plus the cell padding (2 x
 * --sp-3), plus 1 px on Parameter for the line on its right edge. A character is 0.61 em in the mono face (ui-monospace
 * measures 0.6016 em), 0.55 em in the body face (a margin over the widest seeded selector, 0.49 em), and 0.75 em in an
 * uppercase header label with its tracking (widest measured 0.726 em). The page sets them on its table as --w1, --w2
 * and --w3; app.css reads them for the sticky widths and left offsets, whole px so the offsets stay exact.
 */
export function identityWidths(rows: ByKindModel["rows"]): { w1: number; w2: number; w3: number } {
  const FS1 = 12, MONO = 0.61, BODY = 0.55, LABEL = 0.75, PAD = 24;
  const px = (label: string, em: number, texts: string[]) =>
    Math.ceil(Math.max(label.length * LABEL, ...texts.map((t) => t.length * em)) * FS1 - 1e-9) + PAD;
  const [family, selector, parameter] = IDENTITY_LABELS;
  return {
    w1: px(family, MONO, rows.map((r) => r.familyId)),
    w2: px(selector, BODY, rows.map((r) => r.selector)),
    w3: px(parameter, MONO, rows.map((r) => r.path)) + 1,
  };
}
