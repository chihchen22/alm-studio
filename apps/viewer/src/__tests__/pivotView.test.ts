/**
 * The Views tab is a template over these helpers. Every value they
 * return is a verbatim field of the pivot result or the stored envelope; no
 * helper here adds, signs or rounds a number.
 */
import { describe, expect, it } from "vitest";
import type { PivotResult, RunResult } from "@alm/engine";
// A runtime import of the engine, allowed here only because test files sit
// outside the viewer bundle that the types-only rule governs.
import { PIVOT_METRICS as ENGINE_PIVOT_METRICS } from "@alm/engine";
import {
  EVE_PV_CAVEAT,
  PIVOT_METRICS,
  cellDetail,
  cellDetailValues,
  pivotHeaders,
  pivotRowValues,
  pivotTotalValues,
} from "@alm/reader";

const bands = [
  { label: "0-1m", startMonth: 0, endMonth: 1 },
  { label: "1-3m", startMonth: 1, endMonth: 3 },
];

function pivotOf(partial: Partial<PivotResult> & Pick<PivotResult, "metric">): PivotResult {
  return { viewId: "by-segment", scenarioId: "S0", groupBy: ["segment"], rows: [], ...partial };
}

/** A minimal envelope: one static scenario with every cell arm, one dynamic scenario missing the cashflow and NII arms. */
const envelope = {
  cashflows: {
    cells: [
      { id: "DDA|segment=relationship", familyId: "DDA", tags: { segment: "relationship" }, positionCount: 2 },
    ],
    byScenario: [
      {
        scenarioId: "S0",
        byCell: [{ cellId: "DDA|segment=relationship", series: { balance: [10, 9], principal: [1, 1], interest: [0.5, 0.4] } }],
      },
      { scenarioId: "S-DYN" },
    ],
  },
  gap: {
    repricing: [
      {
        kind: "repricing",
        scenarioId: "S0",
        rows: [],
        byCell: [
          {
            cellId: "DDA|segment=relationship",
            rows: [
              { band: bands[0], assets: 0, liabilities: 10, gap: -10, cumulativeGap: -10 },
              { band: bands[1], assets: 0, liabilities: 0, gap: 0, cumulativeGap: -10 },
            ],
          },
        ],
      },
      { kind: "repricing", scenarioId: "S-DYN", rows: [], byCell: [{ cellId: "DDA|segment=relationship", rows: [{ band: bands[0], assets: 0, liabilities: 7, gap: -7, cumulativeGap: -7 }] }] },
    ],
    liquidity: [
      { kind: "liquidity", scenarioId: "S0", rows: [], byCell: [{ cellId: "DDA|segment=relationship", rows: [{ band: bands[0], assets: 0, liabilities: 1, gap: -1, cumulativeGap: -1 }] }] },
      { kind: "liquidity", scenarioId: "S-DYN", rows: [], byCell: [] },
    ],
  },
  nii: {
    byScenario: [
      { scenarioId: "S0", byCell: [{ cellId: "DDA|segment=relationship", interestIncome12: 0, interestExpense12: 3, net12: -3, interestIncome24: 0, interestExpense24: 5, net24: -5 }] },
      { scenarioId: "S-DYN" },
    ],
  },
  eve: {
    byScenario: [
      { scenarioId: "S0", byCell: [{ cellId: "DDA|segment=relationship", pv: 9.5 }] },
      { scenarioId: "S-DYN", byCell: [{ cellId: "DDA|segment=relationship", pv: 9.1 }] },
    ],
  },
} as unknown as RunResult;

describe("pivot table helpers", () => {
  it("lists the seven metrics in contract order and pins the evePv caveat", () => {
    expect(PIVOT_METRICS).toEqual(["balance", "principal", "interest", "repricing", "gapPrincipal", "nii", "evePv"]);
    expect(EVE_PV_CAVEAT).toBe("unsigned gross present value, not EVE");
  });

  it("mirrors the engine's own PIVOT_METRICS, in the engine's order", () => {
    expect([...PIVOT_METRICS]).toEqual([...ENGINE_PIVOT_METRICS]);
  });

  it("heads a bucketed metric by bucket index, sized from the first row", () => {
    const p = pivotOf({ metric: "balance", rows: [{ key: { segment: "a" }, cellIds: ["c"], positionCount: 1, series: [3, 2, 1] }] });
    expect(pivotHeaders(p)).toEqual(["0", "1", "2"]);
    expect(pivotRowValues(p, p.rows[0]!)).toEqual([3, 2, 1]);
  });

  it("heads a gap metric by band label", () => {
    const p = pivotOf({ metric: "gapPrincipal", bands, rows: [{ key: { segment: "a" }, cellIds: ["c"], positionCount: 1, series: [-1, 0] }] });
    expect(pivotHeaders(p)).toEqual(["0-1m", "1-3m"]);
    expect(pivotRowValues(p, p.rows[0]!)).toEqual([-1, 0]);
  });

  it("lays nii out as its four additive fields and evePv as one pv", () => {
    const n = pivotOf({ metric: "nii", rows: [{ key: { segment: "a" }, cellIds: ["c"], positionCount: 1, nii: { net12: -3, net24: -5, interestIncome12: 0, interestExpense12: 3 } }] });
    expect(pivotHeaders(n)).toEqual(["net12", "net24", "interestIncome12", "interestExpense12"]);
    expect(pivotRowValues(n, n.rows[0]!)).toEqual([-3, -5, 0, 3]);
    const e = pivotOf({ metric: "evePv", rows: [{ key: { segment: "a" }, cellIds: ["c"], positionCount: 1, value: 9.5 }] });
    expect(pivotHeaders(e)).toEqual(["pv"]);
    expect(pivotRowValues(e, e.rows[0]!)).toEqual([9.5]);
  });

  it("returns the served total as a row, and no row when the route sent none", () => {
    expect(pivotTotalValues(pivotOf({ metric: "evePv", total: 19 }))).toEqual([19]);
    expect(pivotTotalValues(pivotOf({ metric: "balance", total: [5, 4] }))).toEqual([5, 4]);
    expect(pivotTotalValues(pivotOf({ metric: "nii" }))).toBeUndefined();
  });
});

describe("cellDetail", () => {
  const id = "DDA|segment=relationship";

  it("resolves the cell reference from the dictionary and returns ref undefined for an unknown id", () => {
    expect(cellDetail(envelope, "balance", "S0", id).ref).toEqual({ id, familyId: "DDA", tags: { segment: "relationship" }, positionCount: 2 });
    expect(cellDetail(envelope, "balance", "S0", "nope").ref).toBeUndefined();
  });

  it("reads each metric's arm on a static scenario", () => {
    expect(cellDetail(envelope, "balance", "S0", id).numbers).toEqual({ kind: "series", values: [10, 9] });
    expect(cellDetail(envelope, "principal", "S0", id).numbers).toEqual({ kind: "series", values: [1, 1] });
    expect(cellDetail(envelope, "interest", "S0", id).numbers).toEqual({ kind: "series", values: [0.5, 0.4] });
    expect(cellDetail(envelope, "repricing", "S0", id).numbers?.kind).toBe("bands");
    expect(cellDetailValues(cellDetail(envelope, "repricing", "S0", id))).toEqual([-10, 0]);
    expect(cellDetailValues(cellDetail(envelope, "gapPrincipal", "S0", id))).toEqual([-1]);
    expect(cellDetail(envelope, "nii", "S0", id).numbers).toEqual({ kind: "nii", net12: -3, net24: -5, interestIncome12: 0, interestExpense12: 3 });
    expect(cellDetail(envelope, "evePv", "S0", id).numbers).toEqual({ kind: "pv", pv: 9.5 });
  });

  it("returns numbers undefined where a scenario has no arm, and still answers gap and EVE there", () => {
    expect(cellDetail(envelope, "balance", "S-DYN", id).numbers).toBeUndefined();
    expect(cellDetail(envelope, "nii", "S-DYN", id).numbers).toBeUndefined();
    expect(cellDetail(envelope, "gapPrincipal", "S-DYN", id).numbers).toBeUndefined();
    expect(cellDetailValues(cellDetail(envelope, "repricing", "S-DYN", id))).toEqual([-7]);
    expect(cellDetail(envelope, "evePv", "S-DYN", id).numbers).toEqual({ kind: "pv", pv: 9.1 });
    expect(cellDetailValues(cellDetail(envelope, "balance", "S-DYN", id))).toBeUndefined();
  });

  it("lays a cell's numbers out under the same headers as the pivot row", () => {
    expect(cellDetailValues(cellDetail(envelope, "balance", "S0", id))).toEqual([10, 9]);
    expect(cellDetailValues(cellDetail(envelope, "nii", "S0", id))).toEqual([-3, -5, 0, 3]);
    expect(cellDetailValues(cellDetail(envelope, "evePv", "S0", id))).toEqual([9.5]);
  });
});
