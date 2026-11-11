// apps/studio/src/pages/results/monthlyDetail.ts
/**
 * The monthly detail of the NII card (spec decisions 124 to 126): balance, principal and interest as
 * stored per family and per account node, the yield worked out here, and originations, all read from the envelope the
 * page already holds. Net interest and originations are stored per family only, so a summation node sums its family
 * rows here and says so. A series that is not present is a sentence, never a column of zeros. The chart of accounts
 * (node tree, family side and instrument type) is not on the envelope; it arrives as the `coa` field of the
 * GET /result/nii/monthly reply, which the route reads from the run's book.
 */
import type { RunResult } from "@alm/engine";
import type { NiiMonthlyChart, NiiMonthlyScenario } from "@alm/reader";

export const SUMMED = "summed here from the family rows";
export const WORKED_OUT = "worked out here";
export const NEXT_SENTENCE = "Next on this card: marginal yield on new business, and prepayment speed.";

export type Coa = NiiMonthlyChart;
export interface Col { id: string; label: string; values: (number | null)[]; note?: string }
export interface Detail { cols: Col[]; notes: string[] }

/** Annualized interest over start-of-bucket balance, interest times 12 over balance; null where the balance is zero. */
export function derivedYield(interest: number[], balance: number[]): (number | null)[] {
  return interest.map((v, k) => (balance[k] ? (v * 12) / balance[k]! : null));
}

/** The families on the leaves under a node, the node itself included, in chart order. */
export function familiesUnder(coa: Coa, nodeId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const n of coa.nodes) {
      if (n.id === id && n.familyId !== undefined) out.push(n.familyId);
      if (n.parentId === id) walk(n.id);
    }
  };
  walk(nodeId);
  return out;
}

/** Element-wise sum of rows in the order given; null when there is no row to sum. */
export function sumRows(rows: number[][]): number[] | null {
  if (rows.length === 0) return null;
  const out = rows[0]!.map(() => 0);
  for (const r of rows) for (let k = 0; k < out.length; k++) out[k]! += r[k] ?? 0;
  return out;
}

/** Income, expense and net for a node: the member families' reader rows, summed here. */
export function nodeIncome(s: NiiMonthlyScenario, members: string[]): { income: number[]; expense: number[]; net: number[] } | null {
  const rows = s.byFamily.filter((f) => members.includes(f.familyId));
  const income = sumRows(rows.map((f) => f.income));
  if (income === null) return null;
  return { income, expense: sumRows(rows.map((f) => f.expense))!, net: sumRows(rows.map((f) => f.net))! };
}

/**
 * The extra columns for one family or one node of one scenario, and the sentences for what is not present.
 * `coa` null means the chart is not at hand: stored series still show; yield and node sums say why they do not.
 */
export function monthlyDetail(a: {
  result: RunResult;
  scenarioId: string;
  label: string;
  pick: { kind: "family" | "node"; id: string };
  coa: Coa | null;
}): Detail {
  const { result, scenarioId, label, pick, coa } = a;
  const cols: Col[] = [];
  const notes: string[] = [];
  const cf = result.cashflows.byScenario.find((s) => s.scenarioId === scenarioId);
  const stored = pick.kind === "family"
    ? cf?.byFamily.find((f) => f.familyId === pick.id)?.series
    : cf?.byCoaNode.find((n) => n.coaNodeId === pick.id)?.series;
  const members = pick.kind === "family" ? [pick.id] : coa === null ? null : familiesUnder(coa, pick.id);
  if (stored === undefined) {
    notes.push(`Balance, principal and interest are not present for ${pick.id} on ${label}.`);
  } else {
    cols.push({ id: "balance", label: "Balance, start of month", values: stored.balance });
    cols.push({ id: "principal", label: "Principal", values: stored.principal });
    cols.push({ id: "interest", label: "Interest", values: stored.interest });
    const defs = members === null || coa === null ? null : coa.families.filter((f) => members.includes(f.id));
    const why = defs === null ? null
      : defs.some((f) => f.side === "derivative") ? "net settlement over a notional is not a yield"
      : defs.some((f) => f.instrumentType === "commitment") ? "undrawn face is not a balance"
      : defs.some((f) => f.side === "asset") && defs.some((f) => f.side === "liability") ? "it holds asset and liability families"
      : null;
    if (why !== null) notes.push(`Yield is not worked out for ${pick.id}: ${why}.`);
    else if (defs !== null) cols.push({ id: "yield", label: "Yield, annualized", values: derivedYield(stored.interest, stored.balance), note: WORKED_OUT });
  }
  const nii = result.nii.byScenario.find((s) => s.scenarioId === scenarioId);
  const arm = nii?.newBusiness;
  if (arm === undefined) {
    notes.push(result.nii.byScenario.some((s) => s.newBusiness !== undefined)
      ? `Originations are not present on ${label}: a static scenario writes none.`
      : "Originations are not present on this envelope: no scenario of the run wrote new business.");
  } else if (members !== null) {
    const rows = arm.filter((f) => members.includes(f.familyId)).map((f) => f.originations);
    const sum = pick.kind === "family" ? rows[0] ?? null : sumRows(rows);
    if (sum === null) notes.push(`Originations are not present for ${pick.id} on ${label}: the reinvestment sweep holds no target for it.`);
    else cols.push({ id: "originations", label: "Originations", values: sum, ...(pick.kind === "node" ? { note: SUMMED } : {}) });
  }
  if (result.cashflows.cells !== undefined && cf !== undefined && cf.byCell === undefined) {
    notes.push(`Per-cell series are not present on ${label}: a dynamic scenario carries no cell index, so this card reads family and node rows only.`);
  }
  if (coa === null) notes.push("The chart of accounts is not at hand, so yield and a node's summed rows are not shown.");
  return { cols, notes };
}

/** Every shown series for the scenario and pick, to the grid horizon: month, then one column per series. */
export function detailCsv(cols: Col[]): string {
  const n = Math.max(0, ...cols.map((c) => c.values.length));
  const head = ["Month", ...cols.map((c) => (c.note === undefined ? c.label : `${c.label} (${c.note})`))];
  const lines = [head.map((h) => `"${h}"`).join(",")];
  for (let k = 0; k < n; k++) lines.push([k + 1, ...cols.map((c) => c.values[k] ?? "")].join(","));
  return lines.join("\n") + "\n";
}
