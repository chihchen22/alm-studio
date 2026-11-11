/**
 * Studio A+E contract 7: interest income, expense and net per month per family,
 * read off the stored cash flow block's `interest` and the family side. A READ:
 * net is income minus expense and must equal the stored netMonthly exactly, which
 * the test pins. Nothing here computes a balance-sheet number the engine did not.
 *
 * Why the arithmetic mirrors nii/computeNII.ts. The scenario net is a floating
 * point sum, so it equals the stored scenario netMonthly to the bit only if it is
 * accumulated in the same order: the non-derivative families first, in cash flow
 * order, then the derivative line summed apart and added once, last. A derivative
 * family books neither income nor expense: its interest is already the
 * net settlement, signed at emission, so its row carries zero income and expense
 * and a net equal to the signed interest. Exact zeros are normalized to +0 on
 * every vector, as computeNII does, so a -0 never reaches the wire.
 */
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import type { BalanceSheetSide, ProductFamilyId, ScenarioId } from "../contracts/ids";
import type { RunResult } from "../contracts/run";
import { DERIVATIVE_SIDE, hasDerivativeFamily } from "../swap/derivatives";

export interface NiiMonthlyFamilyRow {
  familyId: ProductFamilyId;
  side: BalanceSheetSide;
  income: number[];
  expense: number[];
  net: number[];
}
export interface NiiMonthlyScenario {
  scenarioId: ScenarioId;
  byFamily: NiiMonthlyFamilyRow[];
  income: number[];
  expense: number[];
  net: number[];
}
/**
 * Slice three (spec decisions 125 and 126): the run's chart of accounts as the monthly card needs it, the node tree
 * and each family's side and instrument type, which the envelope does not carry. Written by the route beside the
 * reader's reply (the route already reads the book); the reader's own fields are unchanged.
 */
export interface NiiMonthlyChart {
  nodes: Array<{ id: string; label: string; parentId: string | null; isLeaf: boolean; familyId?: ProductFamilyId }>;
  families: Array<{ id: ProductFamilyId; side: BalanceSheetSide; instrumentType: string }>;
}
export type NiiMonthlyReply =
  | { kind: "monthly"; horizonMonths: number; byScenario: NiiMonthlyScenario[]; coa?: NiiMonthlyChart }
  | { kind: "absent"; reason: "no-netMonthly" | "stochastic" };

/** The chart fields the card reads, in a fixed key order; nothing else of the book leaves the server. */
export function niiMonthlyChart(coa: ChartOfAccounts): NiiMonthlyChart {
  return {
    nodes: coa.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      parentId: n.parentId,
      isLeaf: n.isLeaf,
      ...(n.familyId !== undefined ? { familyId: n.familyId } : {}),
    })),
    families: coa.families.map((f) => ({ id: f.id, side: f.side, instrumentType: f.instrumentType })),
  };
}

/**
 * The reader cannot answer from this run: a cash flow family the chart of
 * accounts does not carry has no side to split by. A request error, not a
 * crash; the route maps it to a 422 naming the family.
 */
export class NiiMonthlyUnavailableError extends Error {
  readonly familyId: ProductFamilyId;
  constructor(familyId: ProductFamilyId) {
    super(`monthly NII cannot be read from this run: family "${familyId}" is in the cash flow block and not in the chart of accounts`);
    this.name = "NiiMonthlyUnavailableError";
    this.familyId = familyId;
  }
}

/** -0 becomes +0; every other value is unchanged. */
const plusZero = (x: number): number => (x === 0 ? 0 : x);

export function niiMonthly(
  result: Pick<RunResult, "schemaVersion" | "cashflows" | "nii">,
  coa: ChartOfAccounts,
): NiiMonthlyReply {
  if (result.nii.byScenario.some((s) => s.netMonthly === undefined)) {
    return { kind: "absent", reason: "no-netMonthly" };
  }
  const side = new Map(coa.families.map((f) => [f.id, f.side] as const));
  const withDerivatives = hasDerivativeFamily(coa);
  const horizon = result.cashflows.grid.horizonMonths;
  const byScenario = result.cashflows.byScenario.map((scn): NiiMonthlyScenario => {
    const income = new Array<number>(horizon).fill(0);
    const expense = new Array<number>(horizon).fill(0);
    const net = new Array<number>(horizon).fill(0);
    const derivativesNet = new Array<number>(horizon).fill(0);
    const byFamily = scn.byFamily.map((f): NiiMonthlyFamilyRow => {
      const s = side.get(f.familyId);
      if (s === undefined) throw new NiiMonthlyUnavailableError(f.familyId);
      const inc = new Array<number>(horizon).fill(0);
      const exp = new Array<number>(horizon).fill(0);
      const n = new Array<number>(horizon).fill(0);
      for (let k = 0; k < horizon; k++) {
        const v = f.series.interest[k] ?? 0;
        if (s === "asset") {
          inc[k] = plusZero(v);
          n[k] = plusZero(v);
        } else if (s === "liability") {
          exp[k] = plusZero(v);
          n[k] = plusZero(-v);
        } else if (s === DERIVATIVE_SIDE) {
          n[k] = plusZero(v);
        }
        if (s === DERIVATIVE_SIDE) {
          derivativesNet[k]! += n[k]!;
        } else {
          income[k]! += inc[k]!;
          expense[k]! += exp[k]!;
          net[k]! += n[k]!;
        }
      }
      return { familyId: f.familyId, side: s, income: inc, expense: exp, net: n };
    });
    if (withDerivatives) {
      for (let k = 0; k < horizon; k++) net[k]! += derivativesNet[k]!;
    }
    return { scenarioId: scn.scenarioId, byFamily, income, expense, net };
  });
  return { kind: "monthly", horizonMonths: horizon, byScenario };
}
