/**
 * Data > Balance sheet > Targets and new business (ALM Studio P2): the form
 * model. A family is Run off (omitted from the plan), Hold flat (one knot at
 * month 1 carrying the SERVED opening balance, copied unchanged), Reach (one
 * knot as typed), or Stored (a loaded multi-knot path, kept verbatim). The
 * engine derives the rate; this module adds, scales and rounds nothing.
 */
import type { BalancePlan } from "@alm/engine";
import type { CoaNodeLike } from "./coaModel";

export type TargetKind = "runoff" | "flat" | "reach" | "stored";

export interface TargetRow {
  familyId: string;
  /** Served totalNotional for the family; null when not served (not in the book, or a null total). */
  opening: number | null;
  inBook: boolean;
  kind: TargetKind;
  balance: string;   // Reach only, typed USD
  month: string;     // Reach only
  spreadBp: string;
  termMonths: string;
  /** A loaded multi-knot path, kept verbatim for kind "stored". */
  storedPath: Array<{ month: number; balance: number }> | null;
}

const MINUS = "−";

/** Grouping commas, every digit kept, a true minus sign; a printed magnitude of "0" takes no sign. Formatting only. */
export function usd(v: number): string {
  const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 20 });
  return v < 0 && s !== "0" ? `${MINUS}${s}` : s;
}

/** The typed Reach balance read back grouped ("= 700,000,000"), or null when it does not parse as a finite number. Formatting only. */
export function balanceReadBack(typed: string): string | null {
  const t = typed.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? `= ${usd(n)}` : null;
}

const empty = (familyId: string, opening: number | null, inBook: boolean): TargetRow => ({
  familyId, opening, inBook, kind: "runoff", balance: "", month: "", spreadBp: "", termMonths: "", storedPath: null,
});

export function familyRows(groups: Array<{ key: string | null; totalNotional: number | null }>, plan: BalancePlan | null): TargetRow[] {
  const rows = new Map<string, TargetRow>();
  for (const g of groups) if (g.key !== null) rows.set(g.key, empty(g.key, g.totalNotional, true));
  for (const t of plan?.targets ?? []) {
    const base = rows.get(t.familyId) ?? empty(t.familyId, null, false);
    const pricing = { spreadBp: String(t.newBusinessPricing.spreadOverIndexBp), termMonths: String(t.newBusinessPricing.termMonths) };
    const only = t.path.length === 1 ? t.path[0]! : null;
    let next: TargetRow;
    if (only !== null && only.month === 1 && base.opening !== null && only.balance === base.opening) next = { ...base, ...pricing, kind: "flat" };
    else if (only !== null) next = { ...base, ...pricing, kind: "reach", balance: String(only.balance), month: String(only.month) };
    else next = { ...base, ...pricing, kind: "stored", storedPath: t.path.map((k) => ({ ...k })) };
    rows.set(t.familyId, next);
  }
  return [...rows.values()].sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0));
}

export function withKind(row: TargetRow, kind: TargetKind): TargetRow {
  return { ...row, kind };
}

const num = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const wholeAtLeastOne = (s: string): boolean => {
  const n = num(s);
  return n !== null && Number.isInteger(n) && n >= 1;
};

/** `hasNodeTargets`: a plan with a node target is complete with every family running off. */
export function checkRows(rows: TargetRow[], hasNodeTargets = false): string[] {
  const out: string[] = [];
  if (rows.every((r) => r.kind === "runoff")) {
    if (hasNodeTargets) return [];
    return ["Every family runs off: set at least one target before saving."];
  }
  for (const r of rows) {
    if (r.kind === "runoff") continue;
    if (!r.inBook) { out.push(`${r.familyId}: the family is not in this book; set it to Run off.`); continue; }
    if (r.kind === "reach") {
      const b = num(r.balance);
      if (b === null || !(b > 0)) out.push(`${r.familyId}: the balance must be a number above zero.`);
      if (!wholeAtLeastOne(r.month)) out.push(`${r.familyId}: the month must be a whole number of 1 or more.`);
    }
    if (r.kind === "stored" && r.storedPath === null) out.push(`${r.familyId}: no stored path is loaded for this family; pick another target.`);
    if (r.kind === "flat" && r.opening === null) out.push(`${r.familyId}: Hold flat needs the served opening balance, and none is served.`);
    if (num(r.spreadBp) === null) out.push(`${r.familyId}: the spread must be a number of basis points.`);
    if (!wholeAtLeastOne(r.termMonths)) out.push(`${r.familyId}: the term must be a whole number of months, 1 or more.`);
  }
  return out;
}

/**
 * One node-target row as typed (contract 25): a chart of accounts node, a path (one knot as typed, or a loaded
 * multi-knot path kept verbatim) and the pricing of its new business. The engine allocates it to the node's leaf
 * families pro rata on opening balance; nothing is allocated here.
 */
export interface NodeTargetRow {
  coaNodeId: string;
  balance: string;
  month: string;
  spreadBp: string;
  termMonths: string;
  storedPath: Array<{ month: number; balance: number }> | null;
}

export function emptyNodeRow(): NodeTargetRow {
  return { coaNodeId: "", balance: "", month: "", spreadBp: "", termMonths: "", storedPath: null };
}

/** The plan's node targets as rows; none for a plan without them or no plan. */
export function nodeRowsOf(plan: BalancePlan | null): NodeTargetRow[] {
  return (plan?.nodeTargets ?? []).map((t) => {
    const pricing = { spreadBp: String(t.newBusinessPricing.spreadOverIndexBp), termMonths: String(t.newBusinessPricing.termMonths) };
    const only = t.path.length === 1 ? t.path[0]! : null;
    return only !== null
      ? { coaNodeId: t.coaNodeId, balance: String(only.balance), month: String(only.month), ...pricing, storedPath: null }
      : { coaNodeId: t.coaNodeId, balance: "", month: "", ...pricing, storedPath: t.path.map((k) => ({ ...k })) };
  });
}

/** The chart nodes at or under `id`, the node itself first. */
function subtreeOf(nodes: CoaNodeLike[], id: string): CoaNodeLike[] {
  const out: CoaNodeLike[] = [];
  const walk = (parent: string) => {
    for (const n of nodes) {
      if (n.id === parent && !out.includes(n)) out.push(n);
    }
    for (const n of nodes) if ((n.parentId ?? null) === parent) walk(n.id);
  };
  walk(id);
  return out;
}

/** The problems that stop a save, said before the engine says them: one list item per row problem, rows counted from 1. */
export function checkNodeRows(rows: NodeTargetRow[], nodes: CoaNodeLike[], families: TargetRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const targeted = new Set(families.filter((f) => f.kind !== "runoff").map((f) => f.familyId));
  rows.forEach((r, i) => {
    const at = `Node target ${i + 1}`;
    if (r.coaNodeId === "") { out.push(`${at}: pick a chart of accounts node.`); return; }
    if (seen.has(r.coaNodeId)) out.push(`${at}: ${r.coaNodeId} already has a node target.`);
    seen.add(r.coaNodeId);
    const label = nodes.find((n) => n.id === r.coaNodeId)?.label ?? r.coaNodeId;
    const under = subtreeOf(nodes, r.coaNodeId).map((n) => n.familyId).filter((f): f is string => f !== undefined);
    if (under.length === 0) out.push(`${at}: ${label} holds no family, so there is nothing to allocate to.`);
    const clash = under.filter((f) => targeted.has(f));
    if (clash.length > 0) out.push(`${at}: ${label} holds ${clash.join(", ")}, which also ${clash.length === 1 ? "has a family target" : "have family targets"}; set it to Run off or drop the node target.`);
    if (r.storedPath === null) {
      const b = num(r.balance);
      if (b === null || !(b > 0)) out.push(`${at}: the balance must be a number above zero.`);
      if (!wholeAtLeastOne(r.month)) out.push(`${at}: the month must be a whole number of 1 or more.`);
    }
    if (num(r.spreadBp) === null) out.push(`${at}: the spread must be a number of basis points.`);
    if (!wholeAtLeastOne(r.termMonths)) out.push(`${at}: the term must be a whole number of months, 1 or more.`);
  });
  return out;
}

/** The plan to POST. Call only on rows checkRows and checkNodeRows passed. */
export function toBalancePlan(meta: { id: string; label: string; asOf: string }, rows: TargetRow[], nodeRows: NodeTargetRow[] = []): BalancePlan {
  const targets: BalancePlan["targets"] = [];
  for (const r of rows) {
    if (r.kind === "runoff") continue;
    const newBusinessPricing = { spreadOverIndexBp: Number(r.spreadBp.trim()), termMonths: Number(r.termMonths.trim()) };
    const path = r.kind === "flat" ? [{ month: 1, balance: r.opening! }]
      : r.kind === "reach" ? [{ month: Number(r.month.trim()), balance: Number(r.balance.trim()) }]
      : r.storedPath!.map((k) => ({ ...k }));
    targets.push({ familyId: r.familyId, path, newBusinessPricing });
  }
  const plan: BalancePlan = { schemaVersion: "1.0.0", id: meta.id, label: meta.label, asOf: meta.asOf, targets, unlistedFamilies: "runoff" };
  // The key is written only when a node target exists, so a plan without one hashes exactly as it did.
  if (nodeRows.length === 0) return plan;
  return {
    ...plan,
    nodeTargets: nodeRows.map((r) => ({
      coaNodeId: r.coaNodeId,
      path: r.storedPath !== null ? r.storedPath.map((k) => ({ ...k })) : [{ month: Number(r.month.trim()), balance: Number(r.balance.trim()) }],
      newBusinessPricing: { spreadOverIndexBp: Number(r.spreadBp.trim()), termMonths: Number(r.termMonths.trim()) },
    })),
  };
}
