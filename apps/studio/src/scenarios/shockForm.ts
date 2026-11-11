// apps/studio/src/scenarios/shockForm.ts
/**
 * The custom rate shock builder's form. Pure: no React, no fetch. A form holds the typed text; checkForm reads
 * it into a rate spec with shape checks only (plain decimals, the id rules, at
 * least one knot), and shapeSpec reads the shape alone, without the id rules,
 * for the preview. Value rules (a positive pivot inside the curve, ascending
 * knots) belong to the engine and reach the page as the preview's refusal.
 * Nothing here adds, scales, rounds or sorts a typed or served number: Number()
 * reads only a string that already matched PLAIN_DECIMAL, and knot rows keep
 * the typed order. The row key counter (nextKey) is an identity, not a figure.
 */
import type { PlanScenarioRef, RateSpec, RunPlan, ScenarioDefinition, ScenarioLibrary } from "@alm/engine";
import { lookupRef, scenarioIdOf } from "./scenarioEdits";

export type Shape = "parallel" | "twist" | "custom";

/** One tenor-knot row as typed. `key` is the row's identity for the view (Studio Polish 1 S6): stable while the row lives, never reused in a form. */
export interface KnotRow { key: number; tenorYears: string; shockBp: string }

export interface ShockForm {
  shape: Shape;
  parallelBp: string;
  twist: { shortBp: string; pivotYears: string; longBp: string };
  knots: KnotRow[];
  /** The key the next added knot row takes. */
  nextKey: number;
  id: string;
  label: string;
}

/** A fresh blank form: parallel, every field empty, one empty knot row. */
export function blankForm(): ShockForm {
  return { shape: "parallel", parallelBp: "", twist: { shortBp: "", pivotYears: "", longBp: "" }, knots: [{ key: 0, tenorYears: "", shockBp: "" }], nextKey: 1, id: "", label: "" };
}

/** Optional minus sign, digits, optional decimal part. Hex, exponent, a plus sign, spaces and empty text never match. */
export const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;
/** Letters, digits, dash or underscore, one to forty, starting with a letter or digit. No dot: engine tags put a dot before a scenario id. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** Ids the Rates layer uses as chart row keys (reader rateChartRows RESERVED_KEYS). */
export const RESERVED_IDS: readonly string[] = ["t", "month", "base"];
export const TYPE_A_NUMBER = "Type a number";

/** The typed text as a number, or null when it is not a plain decimal. */
export function readNumber(text: string): number | null {
  return PLAIN_DECIMAL.test(text) ? Number(text) : null;
}

export interface FieldError { field: string; message: string }

export type FormCheck =
  | { ok: true; id: string; label: string | undefined; rateSpec: RateSpec }
  | { ok: false; errors: FieldError[] };

/**
 * The shape fields as a rate spec, with every number and knot error. The one
 * reading checkForm and shapeSpec share, so the preview and the action can
 * never read the shape differently.
 */
function readShape(form: ShockForm): { rateSpec: RateSpec; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const num = (field: string, text: string): number => {
    const v = readNumber(text);
    if (v === null) errors.push({ field, message: TYPE_A_NUMBER });
    return v ?? 0;
  };
  let rateSpec: RateSpec;
  if (form.shape === "parallel") {
    rateSpec = { kind: "parallel", shockBp: num("parallelBp", form.parallelBp) };
  } else if (form.shape === "twist") {
    const shortBp = num("twist.shortBp", form.twist.shortBp);
    const pivotYears = num("twist.pivotYears", form.twist.pivotYears);
    const longBp = num("twist.longBp", form.twist.longBp);
    rateSpec = { kind: "twist", shortBp, longBp, pivotYears };
  } else {
    if (form.knots.length === 0) errors.push({ field: "knots", message: "Add at least one knot" });
    rateSpec = {
      kind: "custom",
      shocks: form.knots.map((k, i) => ({ tenorYears: num(`knots[${i}].tenorYears`, k.tenorYears), shockBp: num(`knots[${i}].shockBp`, k.shockBp) })),
    };
  }
  return { rateSpec, errors };
}

/**
 * The shape as a rate spec once its number and knot checks pass, else null.
 * No id rule applies: the preview reads the shape alone (spec Section 5.1
 * item 4), so a copied shock shows its curve before it has an id. The action
 * still needs checkForm to pass (item 5).
 */
export function shapeSpec(form: ShockForm): RateSpec | null {
  const { rateSpec, errors } = readShape(form);
  return errors.length === 0 ? rateSpec : null;
}

/**
 * The form as a scenario, or every shape error it has. `taken` holds the ids
 * the plan already uses, less the scenario being edited (takenIds);
 * `libraryHeld` holds every scenario id a library holds (libraryIds). The id
 * rules run in order: empty, pattern, reserved, plan (`taken`), library
 * (`libraryHeld`), and the first that fails is the id's one message. Field
 * names: parallelBp, twist.shortBp, twist.pivotYears, twist.longBp,
 * knots[i].tenorYears, knots[i].shockBp, knots, id.
 */
export function checkForm(form: ShockForm, taken: ReadonlySet<string>, libraryHeld: ReadonlySet<string>): FormCheck {
  const { rateSpec, errors } = readShape(form);
  const id = form.id;
  if (id === "") errors.push({ field: "id", message: "Type an id" });
  else if (!ID_PATTERN.test(id)) errors.push({ field: "id", message: "Use letters, digits, dash or underscore, up to 40 characters, starting with a letter or digit" });
  else if (RESERVED_IDS.includes(id)) errors.push({ field: "id", message: `"${id}" is reserved: the Rates layer uses it as a chart key` });
  else if (taken.has(id)) errors.push({ field: "id", message: `The plan already holds a scenario "${id}"` });
  else if (libraryHeld.has(id)) errors.push({ field: "id", message: `A library holds a scenario "${id}"; give this scenario its own id` });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, id, label: form.label === "" ? undefined : form.label, rateSpec };
}

/** The first message for a field, or null. */
export function errorFor(check: FormCheck, field: string): string | null {
  if (check.ok) return null;
  return check.errors.find((e) => e.field === field)?.message ?? null;
}

/** A form holding a stored spec's shape and sizes, with the caller's id and label. The builder never builds or edits a base spec. */
export function fromRateSpec(spec: RateSpec, keep: { id: string; label: string }): ShockForm {
  const f: ShockForm = { ...blankForm(), ...keep };
  switch (spec.kind) {
    case "parallel":
      return { ...f, shape: "parallel", parallelBp: String(spec.shockBp) };
    case "twist":
      return { ...f, shape: "twist", twist: { shortBp: String(spec.shortBp), pivotYears: String(spec.pivotYears), longBp: String(spec.longBp) } };
    case "custom":
      return { ...f, shape: "custom", knots: spec.shocks.map((s, i) => ({ key: i, tenorYears: String(s.tenorYears), shockBp: String(s.shockBp) })), nextKey: spec.shocks.length };
    case "base":
      throw new Error("the builder does not build or edit a base scenario");
  }
}

export function addKnot(form: ShockForm): ShockForm {
  return { ...form, knots: [...form.knots, { key: form.nextKey, tenorYears: "", shockBp: "" }], nextKey: form.nextKey + 1 };
}

export function removeKnot(form: ShockForm, index: number): ShockForm {
  return { ...form, knots: form.knots.filter((_, i) => i !== index) };
}

/**
 * Where keyboard focus goes once row `index` is removed: the key of the row that follows it, whose Remove button
 * then sits where the removed one was, or "add" (the Add knot button) when no row follows (Task 8 fix S6 focus).
 */
export function focusAfterRemove(form: ShockForm, index: number): number | "add" {
  return form.knots[index + 1]?.key ?? "add";
}

export function setKnot(form: ShockForm, index: number, row: KnotRow): ShockForm {
  return { ...form, knots: form.knots.map((k, i) => (i === index ? row : k)) };
}

/** The definition behind a plan scenario: inline as stored, a ref as its library holds it, undefined for a ref no library holds. */
export function definitionOf(s: PlanScenarioRef, libraries: ScenarioLibrary[]): ScenarioDefinition | undefined {
  return "ref" in s ? lookupRef(s.ref, libraries) : s;
}

/** Whether some library holds a scenario with this id; the scenario cards label an inline scenario "inline copy of" by the id alone. */
function libraryHoldsId(id: string, libraries: ScenarioLibrary[]): boolean {
  return libraries.some((l) => l.scenarios.some((s) => s.id === id));
}

export type EditRule = "edit" | "copy" | "none";

/**
 * Spec Section 5.3. "edit": an inline scenario no library holds by id, not of
 * kind base, with no ramp timing and no environment, whose id the builder's id
 * rules accept (ID_PATTERN, not in RESERVED_IDS): an edit keeps the id, and
 * checkForm would refuse any other, so Update could never turn on. "none": a
 * base scenario, or a ref no library holds. "copy": every other scenario.
 */
export function editRule(s: PlanScenarioRef, libraries: ScenarioLibrary[]): EditRule {
  const def = definitionOf(s, libraries);
  if (def === undefined || def.rateSpec.kind === "base") return "none";
  if ("ref" in s) return "copy";
  if (libraryHoldsId(s.id, libraries) || s.timing?.kind === "ramp" || s.environment !== undefined) return "copy";
  if (!ID_PATTERN.test(s.id) || RESERVED_IDS.includes(s.id)) return "copy";
  return "edit";
}

export type BuilderMode = { kind: "new" } | { kind: "edit"; id: string };

export interface BuilderState {
  mode: BuilderMode;
  /** The Start from option the form was filled from: "" for Blank, else a StartOption key. */
  start: string;
  form: ShockForm;
  /** One line: why the builder opened blank for the query's scenario, or the last Update; null otherwise. */
  note: string | null;
  /** What the last Update wrote. Its line shows only while the plan's scenario still holds this shock and label (reconcile). */
  updated?: { id: string; rateSpec: RateSpec; label: string | undefined };
}

export function newBuilder(): BuilderState {
  return { mode: { kind: "new" }, start: "", form: blankForm(), note: null };
}

/** A change to the form. The note (why the builder opened blank, or the last Update and its record) does not outlive it. */
export function withForm(b: BuilderState, form: ShockForm): BuilderState {
  const { updated: _dropped, ...rest } = b;
  return { ...rest, form, note: null };
}

/**
 * After Update: one line naming the updated scenario (spec Section 5.1 item 7),
 * with the shock and label the Update wrote, so reconcile can drop the line
 * once the plan no longer holds them. The next change to the form clears both.
 */
export function afterUpdate(b: BuilderState, id: string, rateSpec: RateSpec, label: string | undefined): BuilderState {
  return { ...b, note: `Updated "${id}" in the plan. Save as keeps it.`, updated: { id, rateSpec, label } };
}

/**
 * Whether the plan's inline scenario still holds the shock and label an Update
 * wrote, by value (the spec's JSON). A spec equal by value but stored with its
 * keys in another order reads as changed, so the line can drop but never claims
 * an update the plan does not hold.
 */
function holdsUpdate(plan: RunPlan, u: NonNullable<BuilderState["updated"]>): boolean {
  const s = plan.scenarios.find((x) => scenarioIdOf(x) === u.id);
  return s !== undefined && !("ref" in s) && s.label === u.label && JSON.stringify(s.rateSpec) === JSON.stringify(u.rateSpec);
}

/** Spec Section 5.3 item 4: the builder for `scenario=<id>`, read against the plan as edited. */
export function openBuilder(plan: RunPlan, libraries: ScenarioLibrary[], scenarioId: string | undefined): BuilderState {
  if (scenarioId === undefined || scenarioId === "") return newBuilder();
  const s = plan.scenarios.find((x) => scenarioIdOf(x) === scenarioId);
  if (s === undefined) return { ...newBuilder(), note: `The plan holds no scenario "${scenarioId}".` };
  const def = definitionOf(s, libraries);
  if (def === undefined) return { ...newBuilder(), note: `No library holds ${"ref" in s ? s.ref : scenarioId}, so its shock cannot be read.` };
  if (def.rateSpec.kind === "base") {
    return { ...newBuilder(), note: `"${scenarioId}" is the base scenario. The builder does not build or edit a base scenario.` };
  }
  if (editRule(s, libraries) === "edit") {
    return { mode: { kind: "edit", id: scenarioId }, start: "", form: fromRateSpec(def.rateSpec, { id: scenarioId, label: def.label ?? "" }), note: null };
  }
  return { mode: { kind: "new" }, start: `plan:${scenarioId}`, form: fromRateSpec(def.rateSpec, { id: "", label: "" }), note: null };
}

/**
 * The builder state for the plan as it stands. An edit whose scenario the plan
 * no longer holds (Reset, or a Sets edit, removed it) opens as openBuilder
 * would for that id, blank with the reason. The last Update's line stays only
 * while the plan's scenario holds the shock and label that Update wrote; once
 * it does not (Reset put the stored shock back), the line and its record go.
 * Any other state is returned as is.
 */
export function reconcile(b: BuilderState, plan: RunPlan, libraries: ScenarioLibrary[]): BuilderState {
  if (b.mode.kind === "edit") {
    const id = b.mode.id;
    if (!plan.scenarios.some((s) => scenarioIdOf(s) === id)) return openBuilder(plan, libraries, id);
  }
  if (b.updated === undefined || holdsUpdate(plan, b.updated)) return b;
  const { updated: _dropped, ...rest } = b;
  return { ...rest, note: null };
}

/** The ids a scenario may not take: every plan scenario id, less the one being edited. */
export function takenIds(plan: RunPlan, mode: BuilderMode): Set<string> {
  const ids = new Set(plan.scenarios.map(scenarioIdOf));
  if (mode.kind === "edit") ids.delete(mode.id);
  return ids;
}

/**
 * Every scenario id any library holds. checkForm refuses them (spec Section 5.1
 * item 3): a card would read a shock under a library id as an inline copy of
 * the library scenario, and the edit rule would then refuse to edit it in place.
 */
export function libraryIds(libraries: ScenarioLibrary[]): Set<string> {
  return new Set(libraries.flatMap((l) => l.scenarios.map((s) => s.id)));
}

export interface StartOption { key: string; text: string; rateSpec: RateSpec }

function optionText(id: string, label: string | undefined, where: string): string {
  return `${id}${label !== undefined && label !== id ? `: ${label}` : ""} (${where})`;
}

/** Spec Section 5.1 item 2: the plan's scenarios, then the library scenarios the plan lacks; never a base, never a ref no library holds. */
export function startOptions(plan: RunPlan, libraries: ScenarioLibrary[]): StartOption[] {
  const out: StartOption[] = [];
  const have = new Set<string>();
  for (const s of plan.scenarios) {
    const id = scenarioIdOf(s);
    have.add(id);
    const def = definitionOf(s, libraries);
    if (def === undefined || def.rateSpec.kind === "base") continue;
    out.push({ key: `plan:${id}`, text: optionText(id, def.label, "in the plan"), rateSpec: def.rateSpec });
  }
  for (const l of libraries) {
    for (const s of l.scenarios) {
      if (have.has(s.id) || s.rateSpec.kind === "base") continue;
      out.push({ key: `lib:${l.id}#${s.id}`, text: optionText(s.id, s.label, `library ${l.id}`), rateSpec: s.rateSpec });
    }
  }
  return out;
}

/**
 * Start from: Blank clears the shape and sizes, an option fills them; the typed
 * id and label stay, and the note clears as on any form change. An unknown key
 * changes nothing.
 */
export function chooseStart(b: BuilderState, key: string, options: StartOption[]): BuilderState {
  const keep = { id: b.form.id, label: b.form.label };
  if (key === "") return withForm({ ...b, start: "" }, { ...blankForm(), ...keep });
  const o = options.find((x) => x.key === key);
  return o === undefined ? b : withForm({ ...b, start: key }, fromRateSpec(o.rateSpec, keep));
}
