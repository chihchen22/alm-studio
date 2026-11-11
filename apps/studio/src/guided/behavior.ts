// apps/studio/src/guided/behavior.ts
/**
 * The guided Behavior step. It starts from the user's own families,
 * not from stored sets: for each family, its instrument type, the behavioral roles that type has (how it prepays,
 * decays or reprices), and for each role the model that will apply to every position, from one of three places:
 *
 *   set      a binding in the workspace's default assumption set covers the position (its selector, if any, matches)
 *   book     no binding covers it, and the position carries its own parameter block (a JSON book's inline block, or the
 *            kernel default the CSV path filled in): the engine runs that block
 *   none     neither: the role does not run for that position
 *
 * A "choose a model" control offers, per role, only what is valid for the instrument type: keep the book's values,
 * the kernel's published illustrative default for that type (badged "default, not fitted"), or the saved model when
 * the set has one. Saving writes one assumption set behind the scenes and makes it the workspace default. Bindings the
 * guided roles do not cover (a CD rollover, a constant CPR on a loan, a registered overlay) are carried over unchanged.
 *
 * Pure: the page fetches the book, the set and the published defaults (GET /api/guided/behavior-models).
 */
import type { AssumptionSet, BehavioralOverlay, DimensionPredicate, OverlayBinding, PortfolioSpec, Position } from "@alm/engine";
import { selectorMatchesBag } from "@alm/engine/src/plan/dimensions";

export type BehaviorRole = "prepayment" | "decay" | "repricing";

/** One published default, as GET /api/guided/behavior-models serves it. */
export interface PublishedModel {
  key: string;
  role: BehaviorRole;
  label: string;
  instrumentTypes: string[];
  overlay: BehavioralOverlay;
  modelVersion: string;
  preview: string;
  source: string;
  /** The server's badge for these values; absent on an older server, read as "default, not fitted". */
  badge?: string;
}

/** The badge a published default shows: the server's own words, else the S2a wording. */
export function publishedBadge(m: Pick<PublishedModel, "badge"> | null | undefined): string {
  return m?.badge ?? "default, not fitted";
}

/**
 * A saved binding whose model version starts "illustrative" carries round illustrative values (the
 * example bank's illustrative set): badged "illustrative", never "fitted".
 */
export function isIllustrativeVersion(modelVersion: string | null): boolean {
  return modelVersion !== null && modelVersion.startsWith("illustrative");
}

export const ROLE_LABEL: Record<BehaviorRole, string> = { prepayment: "Prepayment", decay: "Deposit decay", repricing: "Deposit repricing" };

/** The overlay kind that plays each role. */
const ROLE_KIND: Record<BehaviorRole, BehavioralOverlay["kind"]> = { prepayment: "prepay", decay: "nmd-decay", repricing: "deposit-beta" };

/** The roles each instrument type has in the guided step: those with a published default. */
export function rolesOf(instrumentType: string): BehaviorRole[] {
  if (instrumentType === "mortgage") return ["prepayment"];
  if (instrumentType === "nmd") return ["decay"];
  if (instrumentType === "nmd-b") return ["decay", "repricing"];
  return [];
}

/** What a family with no guided role does, in one sentence. */
export function noRoleSentence(instrumentType: string): string {
  switch (instrumentType) {
    case "fixed-loan": return "Contractual cash flows: no behavioral model by default. A constant CPR or a CD rollover is set under Advanced.";
    case "floating-loan": return "Contractual cash flows, resetting on its index: no behavioral model.";
    case "cd": return "Term deposits: the renewal rule each position carries applies.";
    case "commitment": return "Committed lines: the draw path each position carries applies; a draw model is set under Advanced.";
    case "swap": return "A swap: contractual legs, no behavioral model.";
    case "non-rate-sensitive": return "Held at book value: no interest, no runoff and no behavioral model.";
    default: return "No behavioral model applies to this instrument type.";
  }
}

/** The parameter block a position carries for a role, as an overlay; null when it carries none. */
export function inlineOverlay(p: Position, role: BehaviorRole): BehavioralOverlay | null {
  const t = p.terms as unknown as Record<string, unknown>;
  if (role === "prepayment" && t.type === "mortgage" && t.cprParams !== undefined) return { kind: "prepay", model: "four-factor-cpr", params: t.cprParams } as BehavioralOverlay;
  if (role === "decay" && (t.type === "nmd" || t.type === "nmd-b") && t.nmdParams !== undefined) return { kind: "nmd-decay", params: t.nmdParams } as BehavioralOverlay;
  if (role === "repricing" && t.type === "nmd-b" && t.sCurve !== undefined) return { kind: "deposit-beta", params: t.sCurve } as BehavioralOverlay;
  return null;
}

/** The authored tags plus the two a selector may also read off the family, as the engine's matcher sees them. */
function bagOf(p: Position, side: string): Record<string, string | string[]> {
  return { ...(p.dimensions ?? {}), productFamily: p.familyId, side };
}

/** The binding that covers a position for a role: the first binding of the role's kind on its family whose selector matches. */
export function bindingFor(set: AssumptionSet | null, p: Position, side: string, role: BehaviorRole): OverlayBinding | null {
  if (set === null) return null;
  const kind = ROLE_KIND[role];
  return set.bindings.find((b) => b.familyId === p.familyId && b.overlay.kind === kind && selectorMatchesBag(b.selector, bagOf(p, side))) ?? null;
}

/** Deep equality over JSON values, key order ignored. */
export function sameValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameValues(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The published default for a role on an instrument type, or null. */
export function publishedFor(models: readonly PublishedModel[], role: BehaviorRole, instrumentType: string): PublishedModel | null {
  return models.find((m) => m.role === role && m.instrumentTypes.includes(instrumentType)) ?? null;
}

export type Source = "set" | "book" | "none";

/** The model that will apply to one position for one role. */
export interface EffectiveModel {
  source: Source;
  overlay: BehavioralOverlay | null;
  /** The binding's model version on a set source; null otherwise. */
  modelVersion: string | null;
  /** The values equal the published default for the instrument type: badged "default, not fitted". */
  isDefault: boolean;
  /** The binding's selector, when the set binds a part of the family. */
  selector: DimensionPredicate | null;
}

export function effectiveFor(set: AssumptionSet | null, models: readonly PublishedModel[], p: Position, side: string, instrumentType: string, role: BehaviorRole): EffectiveModel {
  const published = publishedFor(models, role, instrumentType);
  const b = bindingFor(set, p, side, role);
  if (b !== null) {
    return { source: "set", overlay: b.overlay, modelVersion: b.modelVersion, isDefault: published !== null && sameValues(b.overlay, published.overlay), selector: b.selector ?? null };
  }
  const inline = inlineOverlay(p, role);
  if (inline !== null) return { source: "book", overlay: inline, modelVersion: null, isDefault: published !== null && sameValues(inline, published.overlay), selector: null };
  return { source: "none", overlay: null, modelVersion: null, isDefault: false, selector: null };
}

/** What the user picks for one family role. `tag` narrows a published default to the positions carrying one tag. */
export type RoleChoice = { kind: "book" } | { kind: "default"; tag?: { dimension: string; value: string } } | { kind: "set" };

export interface RoleRow {
  role: BehaviorRole;
  /** The positions of the family, each with its effective model now. */
  positions: Array<{ id: string; label: string; effective: EffectiveModel }>;
  /** One line for the family: every position from one source, or how they split. */
  summary: string;
  /** The choices valid here, in display order. */
  options: RoleChoice["kind"][];
  /** The choice the control opens on: the saved model when the set has one, else the book's values, else the default. */
  initial: RoleChoice["kind"];
  published: PublishedModel | null;
}

export interface FamilyRow {
  familyId: string;
  label: string;
  side: string;
  instrumentType: string;
  positionCount: number;
  roles: RoleRow[];
  /** Bindings of the default set on this family that no guided role covers, carried over as they are. */
  otherBindings: OverlayBinding[];
  /** The tags the family's positions carry, dimension to values, for a tag-narrowed choice. */
  tags: Record<string, string[]>;
}

function sourceWord(e: EffectiveModel): string {
  if (e.source === "set") return `your saved model (${e.modelVersion})${e.isDefault ? ", the published default" : ""}`;
  if (e.source === "book") return e.isDefault ? "its own position values, equal to the published default" : "its own position values";
  return "no model";
}

export function summaryOf(positions: Array<{ effective: EffectiveModel }>): string {
  if (positions.length === 0) return "No positions.";
  const words = positions.map((p) => sourceWord(p.effective));
  const first = words[0]!;
  if (words.every((w) => w === first)) return `Every position runs on ${first}.`;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return `Mixed: ${[...counts.entries()].map(([w, n]) => `${n} on ${w}`).join("; ")}.`;
}

/** The rows the step shows, one per family with positions, in chart-of-accounts order, with the effective model per position and role. */
export function familyRows(book: PortfolioSpec, set: AssumptionSet | null, models: readonly PublishedModel[]): FamilyRow[] {
  const out: FamilyRow[] = [];
  for (const f of book.coa.families) {
    const positions = book.positions.filter((p) => p.familyId === f.id);
    // A family the chart declares but the book holds no position in gets no row and no binding: a binding there
    // only earns a warning ("binds a family the book holds no position in").
    if (positions.length === 0) continue;
    const roles = rolesOf(f.instrumentType).map((role): RoleRow => {
      const rows = positions.map((p) => ({ id: p.id, label: (p.terms as { label?: string }).label ?? p.id, effective: effectiveFor(set, models, p, f.side, f.instrumentType, role) }));
      const published = publishedFor(models, role, f.instrumentType);
      const hasSet = rows.some((r) => r.effective.source === "set");
      const allInline = positions.length > 0 && positions.every((p) => inlineOverlay(p, role) !== null);
      const options: RoleChoice["kind"][] = [];
      if (hasSet) options.push("set");
      if (allInline) options.push("book");
      if (published !== null) options.push("default");
      return { role, positions: rows, summary: summaryOf(rows), options, initial: hasSet ? "set" : allInline ? "book" : "default", published };
    });
    const kinds = new Set(rolesOf(f.instrumentType).map((r) => ROLE_KIND[r]));
    const otherBindings = set === null ? [] : set.bindings.filter((b) => b.familyId === f.id && !kinds.has(b.overlay.kind));
    const tags: Record<string, string[]> = {};
    for (const p of positions) {
      for (const [d, v] of Object.entries(p.dimensions ?? {})) {
        if (d === "behavioralClasses") continue;
        const vals = Array.isArray(v) ? v : [v];
        const list = (tags[d] ??= []);
        for (const x of vals) if (!list.includes(x)) list.push(x);
      }
    }
    out.push({ familyId: f.id, label: f.label, side: f.side, instrumentType: f.instrumentType, positionCount: positions.length, roles, otherBindings, tags });
  }
  return out;
}

/** The choice key of one family role: `<familyId>::<role>`. */
export const choiceKey = (familyId: string, role: BehaviorRole): string => `${familyId}::${role}`;

/**
 * The assumption set the choices save as. A family role on "set" keeps the set's bindings of that kind on that family
 * as they are; on "default" it binds the published default (to the whole family, or to the positions with one tag);
 * on "book" it binds nothing, so the positions' own blocks run. Every other binding of the current set is carried over.
 * Throws a sentence for a choice the row does not offer.
 */
export function setFromChoices(
  meta: { id: string; label: string },
  rows: readonly FamilyRow[],
  current: AssumptionSet | null,
  choices: Readonly<Record<string, RoleChoice>>,
): AssumptionSet {
  const bindings: OverlayBinding[] = [];
  for (const f of rows) {
    for (const r of f.roles) {
      const choice = choices[choiceKey(f.familyId, r.role)] ?? { kind: r.initial };
      if (!r.options.includes(choice.kind)) throw new Error(`${f.label}, ${ROLE_LABEL[r.role]}: "${choice.kind}" is not a choice here`);
      if (choice.kind === "set") {
        for (const b of current?.bindings ?? []) if (b.familyId === f.familyId && b.overlay.kind === ROLE_KIND[r.role]) bindings.push(b);
      } else if (choice.kind === "default") {
        const pub = r.published!;
        const binding: OverlayBinding = { familyId: f.familyId, overlay: JSON.parse(JSON.stringify(pub.overlay)) as BehavioralOverlay, modelVersion: pub.modelVersion };
        bindings.push(choice.tag === undefined ? binding : { ...binding, selector: { [choice.tag.dimension]: choice.tag.value } });
      }
    }
    bindings.push(...f.otherBindings);
  }
  // Bindings on families the book does not hold are dropped: they are what would put the workspace in Error.
  return { schemaVersion: "1.0.0", id: meta.id, label: meta.label, bindings };
}

/** The guided sets of this workspace still attached to its block, other than the one just saved: the ones to detach (L6). */
export function guidedSetsToDetach(ws: string, attached: readonly string[], keep: string): string[] {
  const stem = `guided-${ws.replace(/^ws-/, "")}`.slice(0, 60);
  return attached.filter((id) => id !== keep && id.startsWith(`${stem}-`) && /^\d+$/.test(id.slice(stem.length + 1)));
}

/** The next free guided set id for a workspace, `guided-<ws>-<n>`, given the ids already stored. */
export function nextGuidedSetId(ws: string, taken: readonly string[]): string {
  const stem = `guided-${ws.replace(/^ws-/, "")}`.slice(0, 60);
  let n = 1;
  while (taken.includes(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}
