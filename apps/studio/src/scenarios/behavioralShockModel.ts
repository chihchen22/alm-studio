// apps/studio/src/scenarios/behavioralShockModel.ts
/**
 * Data > Scenarios > Behavioral shocks. Pure functions over
 * the page's draft: one base set, a list of ops (add, scale or set one number
 * parameter of one binding), and the request the two derive routes take. The
 * server derives the set and computes every number the page prints; this file
 * computes none. It reads the engine's parameter schema by path, as the
 * Edit a set model does, and never imports the engine barrel, the content hash
 * module or node:crypto: the request key below is a local sorted-key string, so
 * nothing from the hash reaches the Studio bundle.
 */
import type { AssumptionSet, DerivationChange, DerivationOp, DerivationOpKind, DimensionPredicate, OverlayBinding } from "@alm/engine";
import { overlayKindOf } from "@alm/engine/src/contracts/assumptions";
import { numberFieldsOf, PARAM_SCHEMAS, schemaKeyOf, valueAt, type NumberBounds } from "@alm/engine/src/contracts/paramSchema";
import { ApiError, type DeriveRequest, type DerivedSetSaveReply } from "@alm/reader";
import { selectorText } from "../assumptions/selectorText";
import { ENTER_A_NUMBER, readDraft } from "../assumptions/setEditModel";
import { pageErrText } from "../errText";
import { screenHref } from "../pageLinks";

/** One op row as typed: the binding by its index in the base set, the parameter by its dotted path, the value as text. */
export interface OpDraft {
  key: number;
  bindingIndex: number | null;
  path: string | null;
  op: DerivationOpKind;
  valueText: string;
}

export interface ShockDraft {
  baseId: string | null;
  ops: OpDraft[];
  label: string;
  id: string;
  /** The key the next added op row takes: kept through removals, so React keys follow the row. */
  nextKey: number;
}

export const OP_CHOICES: ReadonlyArray<{ op: DerivationOpKind; text: string }> = [
  { op: "add", text: "Add" },
  { op: "scale", text: "Scale by" },
  { op: "set", text: "Set to" },
];

export function emptyShockDraft(): ShockDraft {
  return { baseId: null, ops: [], label: "", id: "", nextKey: 0 };
}

/** Another base drops the ops: their binding indices belong to the old base. */
export function setBase(d: ShockDraft, baseId: string | null): ShockDraft {
  return { ...d, baseId, ops: [] };
}

export function addOp(d: ShockDraft): ShockDraft {
  const row: OpDraft = { key: d.nextKey, bindingIndex: null, path: null, op: "add", valueText: "" };
  return { ...d, ops: [...d.ops, row], nextKey: d.nextKey + 1 };
}

export function removeOp(d: ShockDraft, key: number): ShockDraft {
  return { ...d, ops: d.ops.filter((o) => o.key !== key) };
}

/** Edit one op row. A different binding clears the parameter, which belongs to the old binding's schema. */
export function setOpField(d: ShockDraft, key: number, patch: Partial<Omit<OpDraft, "key">>): ShockDraft {
  return {
    ...d,
    ops: d.ops.map((o) => {
      if (o.key !== key) return o;
      const moved = patch.bindingIndex !== undefined && patch.bindingIndex !== o.bindingIndex;
      return { ...o, ...(moved ? { path: null } : {}), ...patch };
    }),
  };
}

export interface BindingChoice { index: number; text: string; disabled: boolean }

/** One option per binding of the base set: "<family>, <model>[, <selector in words>]". A registered binding is shown but off. */
export function bindingChoices(set: AssumptionSet): BindingChoice[] {
  return set.bindings.map((b, index) => {
    const key = schemaKeyOf(b.overlay);
    const model = key === undefined ? overlayKindOf(b.overlay) : PARAM_SCHEMAS[key].label;
    const where = b.selector === undefined ? "" : `, ${selectorText(b.selector)}`;
    const text = `${b.familyId}, ${model}${where}`;
    return key === undefined ? { index, text: `${text} (registered, not offered)`, disabled: true } : { index, text, disabled: false };
  });
}

export interface ParamChoice { path: string; text: string }

/** The number parameters a binding offers, in schema order, each "<label> (<unit>)". Tables and lists are not offered. */
export function paramChoices(b: OverlayBinding): ParamChoice[] {
  return numberFieldsOf(b.overlay).map((f) => ({ path: f.path, text: `${f.label} (${f.unit})` }));
}

/** A parameter's hard bounds in words: "0 to 100", "above 0, at most 1", "whole number, at least 1", "no bound". Shown only; the server enforces them. */
export function boundsText(f: NumberBounds): string {
  const parts: string[] = [];
  if (f.integer === true) parts.push("whole number");
  if (f.min !== undefined && f.max !== undefined && f.minExclusive !== true && f.maxExclusive !== true) {
    parts.push(`${String(f.min)} to ${String(f.max)}`);
  } else {
    if (f.min !== undefined) parts.push(`${f.minExclusive === true ? "above" : "at least"} ${String(f.min)}`);
    if (f.max !== undefined) parts.push(`${f.maxExclusive === true ? "below" : "at most"} ${String(f.max)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no bound";
}

/** The base set's stored value at a parameter, as JavaScript prints it; empty when the path holds no number. */
export function storedValueText(set: AssumptionSet, bindingIndex: number, path: string): string {
  const b = set.bindings[bindingIndex];
  if (b === undefined) return "";
  const v = valueAt(b.overlay, path);
  return typeof v === "number" ? String(v) : "";
}

/** The typed value as a finite number, or the block text. Never a coerced 0. */
export function readValue(text: string): { value: number } | { block: string } {
  const v = readDraft(text);
  return v !== null && Number.isFinite(v) ? { value: v } : { block: ENTER_A_NUMBER };
}

export type ShockRequest = { body: DeriveRequest } | { block: string };

/** The request body the two derive routes take, or why there is none yet. id and label are left out when empty. */
export function requestOf(d: ShockDraft, base: AssumptionSet | null): ShockRequest {
  if (d.baseId === null) return { block: "Pick a base set" };
  if (base === null || base.id !== d.baseId) return { block: "Reading the base set" };
  if (d.ops.length === 0) return { block: "Add an op" };
  const ops: DerivationOp[] = [];
  for (const row of d.ops) {
    const b = row.bindingIndex === null ? undefined : base.bindings[row.bindingIndex];
    if (b === undefined || schemaKeyOf(b.overlay) === undefined) return { block: "Pick a binding" };
    if (row.path === null || !numberFieldsOf(b.overlay).some((f) => f.path === row.path)) return { block: "Pick a parameter" };
    const v = readValue(row.valueText);
    if (!("value" in v)) return v;
    const target: DerivationOp["target"] = { familyId: b.familyId, kind: overlayKindOf(b.overlay), ...(b.selector !== undefined ? { selector: b.selector } : {}) };
    ops.push({ target, path: row.path, op: row.op, value: v.value });
  }
  const id = d.id.trim();
  const label = d.label.trim();
  return { body: { baseId: d.baseId, ops, ...(id !== "" ? { id } : {}), ...(label !== "" ? { label } : {}) } };
}

/** A string for any JSON value with object keys in sorted order at every depth and arrays in order. Local, so no hash module reaches the bundle. */
function sortedKeyStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedKeyStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${sortedKeyStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The identity of a request: equal requests give equal keys whatever the key order. */
export function requestKey(body: object): string {
  return sortedKeyStringify(body);
}

/** The stale guard: a preview stays on screen only while the request on the form is the one it was made for. */
export function previewShown(previewKey: string | null, currentKey: string | null): boolean {
  return previewKey !== null && currentKey !== null && previewKey === currentKey;
}

/** A change row's binding in words: "<family>, <kind>[, <selector>]". The numbers come from the server. */
export function changeBindingText(c: Pick<DerivationChange, "familyId" | "kind" | "selector">): string {
  const sel: DimensionPredicate | undefined = c.selector;
  return `${c.familyId}, ${c.kind}${sel === undefined ? "" : `, ${selectorText(sel)}`}`;
}

export type ShockNoteKind = "created" | "unchanged" | "conflict" | "refused" | "error";

/** What the page says after a preview or a save: one line, the server's problems when it listed any, and the id to link when a set was stored. */
export interface ShockNote {
  kind: ShockNoteKind;
  text: string;
  problems: string[];
  savedId: string | null;
}

export function problemMessages(detail: unknown): string[] {
  const list = detail !== null && typeof detail === "object" ? (detail as { problems?: unknown }).problems : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => (p !== null && typeof p === "object" && typeof (p as { message?: unknown }).message === "string" ? [(p as { message: string }).message] : []));
}

export function saveNoteOf(result: DerivedSetSaveReply | unknown): ShockNote {
  if (result instanceof ApiError || result instanceof Error) {
    if (result instanceof ApiError && result.status === 409) return { kind: "conflict", text: pageErrText(result), problems: [], savedId: null };
    if (result instanceof ApiError && result.status === 422) {
      const problems = problemMessages(result.detail);
      return problems.length > 0
        ? { kind: "refused", text: "Refused: every problem is listed.", problems, savedId: null }
        : { kind: "refused", text: pageErrText(result), problems: [], savedId: null };
    }
    return { kind: "error", text: pageErrText(result), problems: [], savedId: null };
  }
  const reply = result as DerivedSetSaveReply;
  const id = reply.set.id;
  return reply.outcome === "created"
    ? { kind: "created", text: `Saved as ${id}`, problems: [], savedId: id }
    : { kind: "unchanged", text: `${id} already saved with this content`, problems: [], savedId: id };
}

/** The scenario choice of Run setups with the saved set carried in the query, where its hint names the set. */
export function setsHref(ws: string, query: Record<string, string>, id: string): string {
  return screenHref({ ws, section: "run", screen: "setups" }, { ...query, tab: "scenarios", set: id });
}
