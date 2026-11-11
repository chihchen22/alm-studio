/**
 * Studio A+E contract 7: the monthly NII reader. A READ over the stored cash
 * flow block and the family side: income minus expense per month must equal the
 * stored netMonthly exactly, which is what these anchors pin. Expected values
 * are restated by hand; the golden supplies only the stored side of the equality.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { RunResult } from "../../contracts/run";
import { niiMonthly, niiMonthlyChart, NiiMonthlyUnavailableError } from "../niiMonthly";
// The demo COA is embedded in the data package; the golden's provenance names it. Read the families off the demo book builder.
import { buildDemoPortfolio } from "../../../../../data/src/demo/request";

const GOLDEN = fileURLToPath(new URL("../../run/__tests__/golden/demo-run.id-rename.json", import.meta.url));
const result = JSON.parse(readFileSync(GOLDEN, "utf8")) as RunResult;
const coa = buildDemoPortfolio().coa;

describe("niiMonthly", () => {
  it("income minus expense per month equals the stored netMonthly exactly, on every scenario and family", () => {
    const r = niiMonthly(result, coa);
    expect(r.kind).toBe("monthly");
    if (r.kind !== "monthly") return;
    expect(r.horizonMonths).toBe(result.cashflows.grid.horizonMonths);
    expect(r.byScenario.length).toBe(result.nii.byScenario.length);
    for (const sc of r.byScenario) {
      const stored = result.nii.byScenario.find((s) => s.scenarioId === sc.scenarioId)!;
      expect(sc.byFamily.length).toBe(stored.byFamily.length);
      for (const f of sc.byFamily) {
        const sf = stored.byFamily.find((x) => x.familyId === f.familyId)!;
        expect(f.net.length).toBe(r.horizonMonths);
        for (let k = 0; k < f.net.length; k++) {
          expect(f.net[k]).toBe(f.income[k]! - f.expense[k]!);
          expect(f.net[k]).toBe(sf.netMonthly![k]);
          if (f.side === "asset") expect(f.expense[k]).toBe(0);
          if (f.side === "liability") expect(f.income[k]).toBe(0);
        }
      }
      for (let k = 0; k < sc.net.length; k++) expect(sc.net[k]).toBe(stored.netMonthly![k]);
    }
  });

  it("returns the typed absent reply on an envelope without netMonthly", () => {
    const old = JSON.parse(JSON.stringify(result)) as RunResult;
    for (const s of old.nii.byScenario) {
      delete (s as { netMonthly?: number[] }).netMonthly;
      for (const f of s.byFamily) delete (f as { netMonthly?: number[] }).netMonthly;
    }
    expect(niiMonthly(old, coa)).toEqual({ kind: "absent", reason: "no-netMonthly" });
  });

  it("splits an asset, a liability and a derivative family by side, restated by hand", () => {
    // Two months. Asset interest 100, 50 is income; liability interest 30, 20 is
    // expense (net -30, -20); the derivative family's interest is already the net
    // settlement (-5, 7) and books neither income nor expense.
    const syntheticCoa = {
      families: [
        { id: "loans", side: "asset" },
        { id: "deposits", side: "liability" },
        { id: "swaps", side: "derivative" },
      ],
    } as unknown as ChartOfAccounts;
    const series = (interest: number[]) => ({ interest });
    const synthetic = {
      schemaVersion: "1.8.0",
      cashflows: {
        grid: { horizonMonths: 2 },
        byScenario: [
          {
            scenarioId: "base",
            byFamily: [
              { familyId: "loans", series: series([100, 50]) },
              { familyId: "deposits", series: series([30, 20]) },
              { familyId: "swaps", series: series([-5, 7]) },
            ],
          },
        ],
      },
      nii: { byScenario: [{ scenarioId: "base", netMonthly: [65, 37], byFamily: [] }] },
    } as unknown as RunResult;
    const r = niiMonthly(synthetic, syntheticCoa);
    expect(r).toEqual({
      kind: "monthly",
      horizonMonths: 2,
      byScenario: [
        {
          scenarioId: "base",
          byFamily: [
            { familyId: "loans", side: "asset", income: [100, 50], expense: [0, 0], net: [100, 50] },
            { familyId: "deposits", side: "liability", income: [0, 0], expense: [30, 20], net: [-30, -20] },
            { familyId: "swaps", side: "derivative", income: [0, 0], expense: [0, 0], net: [-5, 7] },
          ],
          income: [100, 50],
          expense: [30, 20],
          net: [65, 37],
        },
      ],
    });
  });

  it("keeps negative zero out of a liability month with no interest", () => {
    const syntheticCoa = { families: [{ id: "deposits", side: "liability" }] } as unknown as ChartOfAccounts;
    const synthetic = {
      schemaVersion: "1.8.0",
      cashflows: {
        grid: { horizonMonths: 1 },
        byScenario: [{ scenarioId: "base", byFamily: [{ familyId: "deposits", series: { interest: [0] } }] }],
      },
      nii: { byScenario: [{ scenarioId: "base", netMonthly: [0], byFamily: [] }] },
    } as unknown as RunResult;
    const r = niiMonthly(synthetic, syntheticCoa);
    if (r.kind !== "monthly") throw new Error("expected monthly");
    expect(Object.is(r.byScenario[0]!.byFamily[0]!.net[0], 0)).toBe(true);
    expect(Object.is(r.byScenario[0]!.net[0], 0)).toBe(true);
  });

  it("refuses a cash flow family the chart does not carry with a typed error naming it", () => {
    const syntheticCoa = { families: [{ id: "deposits", side: "liability" }] } as unknown as ChartOfAccounts;
    const synthetic = {
      schemaVersion: "1.8.0",
      cashflows: {
        grid: { horizonMonths: 1 },
        byScenario: [{ scenarioId: "base", byFamily: [{ familyId: "loans", series: { interest: [1] } }] }],
      },
      nii: { byScenario: [{ scenarioId: "base", netMonthly: [1], byFamily: [] }] },
    } as unknown as RunResult;
    let caught: unknown;
    try {
      niiMonthly(synthetic, syntheticCoa);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NiiMonthlyUnavailableError);
    expect((caught as NiiMonthlyUnavailableError).name).toBe("NiiMonthlyUnavailableError");
    expect((caught as NiiMonthlyUnavailableError).familyId).toBe("loans");
    expect((caught as Error).message).toBe('monthly NII cannot be read from this run: family "loans" is in the cash flow block and not in the chart of accounts');
  });

  it("writes no chart of its own: the route adds the chart beside the reply", () => {
    expect(Object.keys(niiMonthly(result, coa))).toEqual(["kind", "horizonMonths", "byScenario"]);
  });

  it("carries the node tree and each family's side and instrument type, nothing else of the book", () => {
    const chart = niiMonthlyChart(coa);
    expect(chart.nodes).toEqual(coa.nodes.map((n) => ({ id: n.id, label: n.label, parentId: n.parentId, isLeaf: n.isLeaf, ...(n.familyId !== undefined ? { familyId: n.familyId } : {}) })));
    expect(chart.families).toEqual(coa.families.map((f) => ({ id: f.id, side: f.side, instrumentType: f.instrumentType })));
    expect(Object.keys(chart.nodes.find((n) => !n.isLeaf)!)).toEqual(["id", "label", "parentId", "isLeaf"]);
  });
});
