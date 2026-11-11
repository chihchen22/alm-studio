// apps/studio/src/scenarios/balanceShockModel.ts
/**
 * Data > Scenarios > Balance shocks. Pure functions over
 * the page's draft: one base balance plan, a list of ops (add, scale or set the
 * target balance of one listed family, at every knot or at one knot month), and
 * the request the two derive routes take. The server derives the plan, checks
 * that every target still lowers against the named book, and computes every
 * number the page prints; this file computes none. Types come from the
 * engine with import type only, and the request key is the local sorted-key
 * string of behavioralShockModel, so no hash module reaches the Studio bundle.
 */
import type { BalancePlan, BalanceShockOp, DerivationOpKind, NewBusinessRule } from "@alm/engine";
import { ApiError, type BalanceDeriveRequest, type DerivedBalancePlanSaveReply } from "@alm/reader";
import { ENTER_A_NUMBER } from "../assumptions/setEditModel";
import { usd } from "../balance/targetsModel";
import { pageErrText } from "../errText";
import { screenHref } from "../pageLinks";
import { problemMessages, readValue, type ShockNote } from "./behavioralShockModel";

/** One op row as typed: the family by id, the knot by month (null for every knot), the value as text. */
export interface BalanceOpDraft {
  key: number;
  familyId: string | null;
  month: number | null;
  op: DerivationOpKind;
  valueText: string;
}

export interface BalanceShockDraft {
  baseId: string | null;
  ops: BalanceOpDraft[];
  label: string;
  id: string;
  /** The key the next added op row takes: kept through removals, so React keys follow the row. */
  nextKey: number;
}

export function emptyBalanceShockDraft(): BalanceShockDraft {
  return { baseId: null, ops: [], label: "", id: "", nextKey: 0 };
}

/** Another base drops the ops: their families and months belong to the old base. */
export function setBalanceBase(d: BalanceShockDraft, baseId: string | null): BalanceShockDraft {
  return { ...d, baseId, ops: [] };
}

export function addBalanceOp(d: BalanceShockDraft): BalanceShockDraft {
  const row: BalanceOpDraft = { key: d.nextKey, familyId: null, month: null, op: "scale", valueText: "" };
  return { ...d, ops: [...d.ops, row], nextKey: d.nextKey + 1 };
}

export function removeBalanceOp(d: BalanceShockDraft, key: number): BalanceShockDraft {
  return { ...d, ops: d.ops.filter((o) => o.key !== key) };
}

/** Edit one op row. A different family resets the knot month to every knot, since the months belong to the old family's path. */
export function setBalanceOpField(d: BalanceShockDraft, key: number, patch: Partial<Omit<BalanceOpDraft, "key">>): BalanceShockDraft {
  return {
    ...d,
    ops: d.ops.map((o) => {
      if (o.key !== key) return o;
      const moved = patch.familyId !== undefined && patch.familyId !== o.familyId;
      return { ...o, ...(moved ? { month: null } : {}), ...patch };
    }),
  };
}

export interface FamilyChoice { familyId: string; text: string }

/** One option per target of the base plan: "<family>, 1 knot at month 12" or "<family>, 2 knots at months 6, 12". */
export function familyChoices(plan: BalancePlan): FamilyChoice[] {
  return plan.targets.map((t) => {
    const months = t.path.map((k) => String(k.month)).join(", ");
    const n = t.path.length;
    return { familyId: t.familyId, text: `${t.familyId}, ${n} ${n === 1 ? "knot at month" : "knots at months"} ${months}` };
  });
}

export interface KnotChoice { month: number | null; text: string }

/** "Every knot" first, then one option per stored knot of the family's path with its stored balance. Formatting only. */
export function knotChoices(plan: BalancePlan, familyId: string): KnotChoice[] {
  const target = plan.targets.find((t) => t.familyId === familyId);
  const knots = target === undefined ? [] : target.path.map((k) => ({ month: k.month, text: `Month ${k.month}, stored ${usd(k.balance)}` }));
  return [{ month: null, text: "Every knot" }, ...knots];
}

export type BalanceShockRequest = { body: BalanceDeriveRequest } | { block: string };

/** The request body the two derive routes take, or why there is none yet. id and label are trimmed and left out when empty. */
export function balanceRequestOf(d: BalanceShockDraft, base: BalancePlan | null, bookId: string | null): BalanceShockRequest {
  if (bookId === null) return { block: "Pick a book in the top bar" };
  if (d.baseId === null) return { block: "Pick a base plan" };
  if (base === null || base.id !== d.baseId) return { block: "Reading the base plan" };
  if (d.ops.length === 0) return { block: "Add an op" };
  const ops: BalanceShockOp[] = [];
  for (const row of d.ops) {
    const target = row.familyId === null ? undefined : base.targets.find((t) => t.familyId === row.familyId);
    if (row.familyId === null || target === undefined) return { block: "Pick a family" };
    if (row.month !== null && !target.path.some((k) => k.month === row.month)) return { block: "Pick a knot month" };
    if (row.op === "set" && row.month === null) return { block: "Set to needs a knot month" };
    const v = readValue(row.valueText);
    if (!("value" in v)) return { block: ENTER_A_NUMBER };
    ops.push({ target: row.month === null ? { familyId: row.familyId } : { familyId: row.familyId, month: row.month }, op: row.op, value: v.value });
  }
  const id = d.id.trim();
  const label = d.label.trim();
  return { body: { baseId: d.baseId, bookId, ops, ...(id !== "" ? { id } : {}), ...(label !== "" ? { label } : {}) } };
}

/** What the page says after a preview or a save: the same shape as the Behavioral shocks note. */
export function balanceSaveNoteOf(result: DerivedBalancePlanSaveReply | unknown): ShockNote {
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
  const reply = result as DerivedBalancePlanSaveReply;
  const id = reply.plan.id;
  return reply.outcome === "created"
    ? { kind: "created", text: `Saved as ${id}`, problems: [], savedId: id }
    : { kind: "unchanged", text: `${id} already saved with this content`, problems: [], savedId: id };
}

/** How the engine lowered a target, in words. The rule comes from the server. */
export function lowersToText(rule: NewBusinessRule): string {
  return rule.reinvest === "growth" ? "One growth rate" : rule.reinvest === "flat" ? "Hold flat" : "Run off";
}

/** The monthly growth rate as the server sent it, or "none" for a rule that carries none. */
export function growthRateText(rule: NewBusinessRule): string {
  return rule.monthlyGrowthRate === undefined ? "none" : String(rule.monthlyGrowthRate);
}

/** The scenario choice of Run setups, where the saved plan is bound after Add balance stage. */
export function setsLinkFor(ws: string, query: Record<string, string>): string {
  return screenHref({ ws, section: "run", screen: "setups" }, { ...query, tab: "scenarios" });
}
