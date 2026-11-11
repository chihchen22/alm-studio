/**
 * Custom metric rows for the Results page Metrics tab. Every
 * expected value below is restated from the fixture literal, never read back
 * from the helper under test. A key absent from a row is null (unobservable).
 */
import { describe, expect, it } from "vitest";
import type { CustomMetricResult } from "@alm/engine";
import { UNOBSERVABLE, familyRows, formatValue, keyBars, scenarioRows, unitSuffix } from "../customMetricRows";

// Three keys: two at scenario grain, one (c-bp) family-only. S100 omits b-frac.
// byFamily exists on S0 only; its second family omits c-bp.
const M: CustomMetricResult = {
  metricId: "demo",
  label: "Demo metric",
  keys: [
    { id: "a-months", label: "A", unit: "months" },
    { id: "b-frac", label: "B", unit: "fraction" },
    { id: "c-bp", label: "C", unit: "bp" },
  ],
  byScenario: [
    {
      scenarioId: "S0",
      values: { "a-months": 38.164, "b-frac": 0.81228 },
      byFamily: [
        { familyId: "loans", values: { "a-months": 46.74, "c-bp": 12.49 } },
        { familyId: "cash", values: { "a-months": 1 } },
      ],
    },
    { scenarioId: "S100", values: { "a-months": 40.5 } },
  ],
};

describe("formatValue", () => {
  it("formats each declared unit", () => {
    expect(formatValue("currency", 1234567)).toBe("$1.2M");
    expect(formatValue("fraction", 0.81228)).toBe("81.23%");
    expect(formatValue("months", 38.164)).toBe("38.2 mo");
    expect(formatValue("bp", 12.49)).toBe("12.5 bp");
    expect(formatValue("count", 1234.6)).toBe("1,235");
  });
});

describe("unitSuffix", () => {
  it("gives a short suffix per unit and none for count", () => {
    expect(unitSuffix("currency")).toBe("$M");
    expect(unitSuffix("fraction")).toBe("%");
    expect(unitSuffix("months")).toBe("mo");
    expect(unitSuffix("bp")).toBe("bp");
    expect(unitSuffix("count")).toBe("");
  });
});

describe("UNOBSERVABLE", () => {
  it("is the word, not a dash or a zero", () => {
    expect(UNOBSERVABLE).toBe("unobservable");
  });
});

describe("scenarioRows", () => {
  it("returns one row per scenario in request order with null for absent keys", () => {
    expect(scenarioRows(M)).toEqual([
      { id: "S0", values: [38.164, 0.81228, null] },
      { id: "S100", values: [40.5, null, null] },
    ]);
  });
});

describe("familyRows", () => {
  it("returns the family rows of a scenario in envelope order with null for absent keys", () => {
    expect(familyRows(M, "S0")).toEqual([
      { id: "loans", values: [46.74, null, 12.49] },
      { id: "cash", values: [1, null, null] },
    ]);
  });

  it("returns null when the scenario carries no family rows or is not on the metric", () => {
    expect(familyRows(M, "S100")).toBeNull();
    expect(familyRows(M, "S999")).toBeNull();
  });
});

describe("keyBars", () => {
  it("returns the observed scenario values of a key in request order, absent scenarios skipped", () => {
    expect(keyBars(M, "a-months")).toEqual([
      { scenarioId: "S0", value: 38.164 },
      { scenarioId: "S100", value: 40.5 },
    ]);
    expect(keyBars(M, "b-frac")).toEqual([{ scenarioId: "S0", value: 0.81228 }]);
  });

  it("returns [] for a family-only key", () => {
    expect(keyBars(M, "c-bp")).toEqual([]);
  });

  it("throws naming an undeclared key", () => {
    expect(() => keyBars(M, "nope")).toThrow(/nope/);
  });
});
