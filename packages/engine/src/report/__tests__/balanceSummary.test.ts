/**
 * The shipped demonstration metric.
 *
 * The fixture is HAND-BUILT and every expected number is RESTATED from the
 * fixture arrays inside the test. Nothing is imported from the module under
 * test except the function itself: a check that borrowed its expected value
 * from the code it checks would agree with whatever that code does.
 *
 * ABSENCE, not zero. A family whose opening balance is 0 has no runoff share,
 * because a share of nothing is undefined; the key is left out of the row, and
 * these cases pin that it is left out rather than written as 0 or NaN.
 */
import { describe, expect, it } from "vitest";
import type { ScenarioCashflows } from "../../contracts/results";
import { validateCustomMetricResult } from "../../contracts/customMetric";
import type { CustomMetricInput } from "../../plugins/services";
import type { PortfolioSpec } from "../../contracts/position";
import { computeBalanceSummary } from "../balanceSummary";

const H = 4;

/** One family's series over four buckets. Only `balance` is read; the rest is shape. */
function family(familyId: string, balance: number[]): ScenarioCashflows["byFamily"][number] {
  return {
    familyId,
    series: { balance, principal: [0, 0, 0, 0], interest: [0, 0, 0, 0] },
  };
}

/** Two families, two scenarios. FIXED runs off; EMPTY is flat at zero throughout. */
function scenario(scenarioId: string, fixed: number[]): ScenarioCashflows {
  return {
    scenarioId,
    byFamily: [family("FIXED", fixed), family("EMPTY", [0, 0, 0, 0])],
    byCoaNode: [],
  };
}

const S0 = scenario("S0", [1000, 900, 800, 700]);
const S100 = scenario("S100", [1000, 950, 900, 850]);

function input(): CustomMetricInput {
  return {
    horizonMonths: H,
    baseScenarioId: "S0",
    scenarios: [
      { scenarioId: "S0", assumptionSetId: "AS", cashflows: S0 },
      { scenarioId: "S100", assumptionSetId: "AS", cashflows: S100 },
    ],
    // The metric reads the series, not the book; an empty book is honest here
    // and keeps the fixture to the arrays the assertions restate.
    book: { id: "PF-TEST", label: "test", asOf: "2026-01-01", coa: { families: [], nodes: [] }, positions: [] } as unknown as PortfolioSpec,
  };
}

describe("computeBalanceSummary", () => {
  it("sums the family balances at the first and the final bucket", () => {
    const result = computeBalanceSummary(input());
    // RESTATED from the fixture arrays: opening is bucket 0, final is H-1 = 3.
    const openingS0 = 1000 + 0;
    const finalS0 = 700 + 0;
    const row = result.byScenario[0]!;
    expect(row.values["opening-balance"]).toBe(openingS0);
    expect(row.values["final-bucket-balance"]).toBe(finalS0);

    const fixed = row.byFamily!.find((f) => f.familyId === "FIXED")!;
    expect(fixed.values["opening-balance"]).toBe(1000);
    expect(fixed.values["final-bucket-balance"]).toBe(700);
  });

  it("runoff share is 1 minus final over opening, restated from the arrays", () => {
    const result = computeBalanceSummary(input());
    expect(result.byScenario[0]!.values["runoff-share"]).toBeCloseTo(1 - 700 / 1000, 12);
    expect(result.byScenario[1]!.values["runoff-share"]).toBeCloseTo(1 - 850 / 1000, 12);
    const fixed = result.byScenario[1]!.byFamily!.find((f) => f.familyId === "FIXED")!;
    expect(fixed.values["runoff-share"]).toBeCloseTo(1 - 850 / 1000, 12);
  });

  it("leaves runoff share OUT of a zero-opening row, and out of the total when every family is zero", () => {
    const result = computeBalanceSummary(input());
    const empty = result.byScenario[0]!.byFamily!.find((f) => f.familyId === "EMPTY")!;
    expect(empty.values["opening-balance"]).toBe(0);
    expect("runoff-share" in empty.values).toBe(false);
    expect(empty.values["runoff-share"]).toBeUndefined();

    const allZero = input();
    allZero.scenarios = [{ scenarioId: "S0", assumptionSetId: "AS", cashflows: scenario("S0", [0, 0, 0, 0]) }];
    const zero = computeBalanceSummary(allZero);
    expect(zero.byScenario[0]!.values["opening-balance"]).toBe(0);
    expect("runoff-share" in zero.byScenario[0]!.values).toBe(false);
  });

  it("keeps input scenario order and satisfies the contract's own validator", () => {
    const result = computeBalanceSummary(input());
    expect(result.byScenario.map((s) => s.scenarioId)).toEqual(["S0", "S100"]);
    expect(result.metricId).toBe("balance-summary");
    expect(result.label.toLowerCase()).toContain("demonstration");
    expect(result.keys.map((k) => k.id)).toEqual([
      "opening-balance",
      "final-bucket-balance",
      "runoff-share",
    ]);
    expect(
      validateCustomMetricResult(result, { metricId: "balance-summary", scenarioIds: ["S0", "S100"] }),
    ).toEqual([]);
  });
});
