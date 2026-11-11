/**
 * The second built-in custom metric, asset and liability WAL.
 *
 * The fixture is HAND-BUILT and the WAL formula is RESTATED here from the
 * principal arrays: bucket k is calendar month k+1, so the principal-weighted
 * average life in months is the sum of principal[k] * (k+1) over the buckets,
 * divided by the in-horizon principal total. Nothing is imported from the
 * aggregation module: a check that borrowed `familyWalYears` from the code it
 * checks would agree with whatever that code does.
 *
 * ABSENCE, not zero. A side with no family, a side whose pooled principal is
 * zero, and a family with no principal all report NO value; the ratio is
 * additionally absent when the asset WAL is zero.
 */
import { describe, expect, it } from "vitest";
import type { ScenarioCashflows } from "../../contracts/results";
import { validateCustomMetricResult } from "../../contracts/customMetric";
import type { CustomMetricInput } from "../../plugins/services";
import type { PortfolioSpec } from "../../contracts/position";
import { computeWalGap } from "../walGap";

const H = 4;

/** One family's series. Only `principal` is read; balance and interest are shape. */
function family(familyId: string, principal: number[]): ScenarioCashflows["byFamily"][number] {
  return {
    familyId,
    series: {
      balance: principal.map(() => 0),
      principal,
      interest: principal.map(() => 0),
    },
  };
}

/**
 * The formula, restated. Sum of principal[k] * (k+1) / 12 over the buckets,
 * divided by the in-horizon principal total, times 12 to read in months.
 */
function walMonths(principal: number[]): number {
  const total = principal.reduce((a, b) => a + b, 0);
  let weightedYears = 0;
  for (let k = 0; k < principal.length; k++) weightedYears += (principal[k]! * (k + 1)) / 12;
  return (weightedYears / total) * 12;
}

/** A book whose COA classifies the named families and nothing else. */
function book(sides: Record<string, "asset" | "liability">): PortfolioSpec {
  return {
    id: "PF-WAL",
    label: "test",
    asOf: "2026-01-01",
    coa: {
      families: Object.entries(sides).map(([id, side]) => ({
        id,
        label: id,
        side,
        instrumentType: "fixed",
        coaNodeId: `N-${id}`,
      })),
      nodes: [],
    },
    positions: [],
  } as unknown as PortfolioSpec;
}

const A1 = [100, 100, 100, 100];
const A2 = [0, 0, 200, 0];
const ZERO = [0, 0, 0, 0];
const L1 = [300, 100, 0, 0];
const OFF = [1000, 0, 0, 0];

/** Both scenarios carry every family; the second has no liability family at all. */
const WITH_L: ScenarioCashflows = {
  scenarioId: "S0",
  byFamily: [family("A1", A1), family("A2", A2), family("ZED", ZERO), family("L1", L1), family("OFF", OFF)],
  byCoaNode: [],
};
const NO_L: ScenarioCashflows = {
  scenarioId: "S100",
  byFamily: [family("A1", A1), family("A2", A2)],
  byCoaNode: [],
};

function input(): CustomMetricInput {
  return {
    horizonMonths: H,
    baseScenarioId: "S0",
    scenarios: [
      { scenarioId: "S0", assumptionSetId: "AS", cashflows: WITH_L },
      { scenarioId: "S100", assumptionSetId: "AS", cashflows: NO_L },
    ],
    // OFF is deliberately NOT in the chart of accounts: it belongs to neither
    // side pool, and its 1000 at bucket 0 would drag the asset WAL down hard
    // if the metric pooled what the COA does not classify.
    book: book({ A1: "asset", A2: "asset", ZED: "asset", L1: "liability" }),
  };
}

describe("computeWalGap", () => {
  it("pools each side's principal element-wise and reports the four scenario keys", () => {
    const row = computeWalGap(input()).byScenario[0]!;
    // RESTATED: the asset pool is A1 + A2 + ZED, element by element.
    const assetPool = [100 + 0 + 0, 100 + 0 + 0, 100 + 200 + 0, 100 + 0 + 0];
    const assetWal = walMonths(assetPool);
    const liabilityWal = walMonths(L1);
    expect(row.values["asset-wal"]).toBeCloseTo(assetWal, 12);
    expect(row.values["liability-wal"]).toBeCloseTo(liabilityWal, 12);
    expect(row.values["wal-gap"]).toBeCloseTo(assetWal - liabilityWal, 12);
    expect(row.values["wal-ratio"]).toBeCloseTo(liabilityWal / assetWal, 12);
    // Hand-computed, independent of the helper: 1600/600 and 500/400.
    expect(row.values["asset-wal"]).toBeCloseTo(1600 / 600, 12);
    expect(row.values["liability-wal"]).toBeCloseTo(1.25, 12);
  });

  it("gives every family with principal its own wal, in cashflow order", () => {
    const row = computeWalGap(input()).byScenario[0]!;
    expect(row.byFamily!.map((f) => f.familyId)).toEqual(["A1", "A2", "ZED", "L1", "OFF"]);
    const walOf = (id: string) => row.byFamily!.find((f) => f.familyId === id)!.values["wal"];
    expect(walOf("A1")).toBeCloseTo(walMonths(A1), 12);
    expect(walOf("A1")).toBeCloseTo(2.5, 12);
    expect(walOf("A2")).toBeCloseTo(3, 12);
    expect(walOf("L1")).toBeCloseTo(1.25, 12);
    // A family the COA does not classify is excluded from the POOLS, not from
    // its own row: the series is observable even when the side is not.
    expect(walOf("OFF")).toBeCloseTo(1, 12);
  });

  it("leaves wal OUT of a family whose principal is zero throughout", () => {
    const zed = computeWalGap(input()).byScenario[0]!.byFamily!.find((f) => f.familyId === "ZED")!;
    expect("wal" in zed.values).toBe(false);
    expect(zed.values["wal"]).toBeUndefined();
  });

  it("leaves the liability keys, the gap and the ratio out when no liability family runs", () => {
    const row = computeWalGap(input()).byScenario[1]!;
    const assetWal = walMonths([100, 100, 300, 100]);
    expect(row.values["asset-wal"]).toBeCloseTo(assetWal, 12);
    expect("liability-wal" in row.values).toBe(false);
    expect("wal-gap" in row.values).toBe(false);
    expect("wal-ratio" in row.values).toBe(false);
  });

  it("excludes an unclassified family from both pools", () => {
    const withOff = computeWalGap(input()).byScenario[0]!.values["asset-wal"]!;
    // The same fixture with OFF classified as an asset moves the pooled number,
    // which is what makes the exclusion above a real check and not a tautology.
    const classified = input();
    classified.book = book({ A1: "asset", A2: "asset", ZED: "asset", L1: "liability", OFF: "asset" });
    const withOffPooled = computeWalGap(classified).byScenario[0]!.values["asset-wal"]!;
    expect(withOffPooled).toBeCloseTo(walMonths([1100, 100, 300, 100]), 12);
    expect(withOffPooled).not.toBeCloseTo(withOff, 6);
  });

  it("pools by principal, so two families equal one family carrying their sum", () => {
    const split: CustomMetricInput = {
      horizonMonths: H,
      baseScenarioId: "S0",
      scenarios: [
        {
          scenarioId: "S0",
          assumptionSetId: "AS",
          // Different lengths on purpose: the shorter series contributes 0 to
          // the buckets it does not reach, never a dropped bucket.
          cashflows: {
            scenarioId: "S0",
            byFamily: [family("A1", [100, 50]), family("A2", [0, 25, 200, 75])],
            byCoaNode: [],
          },
          },
      ],
      book: book({ A1: "asset", A2: "asset" }),
    };
    const merged: CustomMetricInput = {
      ...split,
      scenarios: [
        {
          scenarioId: "S0",
          assumptionSetId: "AS",
          cashflows: {
            scenarioId: "S0",
            byFamily: [family("A1", [100, 75, 200, 75])],
            byCoaNode: [],
          },
        },
      ],
      book: book({ A1: "asset" }),
    };
    const a = computeWalGap(split).byScenario[0]!.values["asset-wal"]!;
    const b = computeWalGap(merged).byScenario[0]!.values["asset-wal"]!;
    expect(a).toBeCloseTo(b, 12);
    expect(a).toBeCloseTo(walMonths([100, 75, 200, 75]), 12);
  });

  it("declares its keys and satisfies the contract's own validator", () => {
    const result = computeWalGap(input());
    expect(result.metricId).toBe("wal-gap");
    expect(result.keys.map((k) => k.id)).toEqual([
      "asset-wal",
      "liability-wal",
      "wal-gap",
      "wal-ratio",
      "wal",
    ]);
    expect(result.keys.map((k) => k.unit)).toEqual([
      "months",
      "months",
      "months",
      "fraction",
      "months",
    ]);
    expect(result.byScenario.map((s) => s.scenarioId)).toEqual(["S0", "S100"]);
    expect(
      validateCustomMetricResult(result, { metricId: "wal-gap", scenarioIds: ["S0", "S100"] }),
    ).toEqual([]);
  });

  it("keeps the per-family key out of a scenario row", () => {
    for (const row of computeWalGap(input()).byScenario) {
      expect("wal" in row.values).toBe(false);
    }
  });
});
