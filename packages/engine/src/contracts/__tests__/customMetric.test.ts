/**
 * The fixed shape a custom metric returns, and the
 * validator that checks it (rules C1 to C5).
 *
 * validateCustomMetricResult is the ONLY shape check: the walker runs it on
 * whatever the registered function returned, and one problem fails the run. It
 * NEVER throws, including on a result whose fields are the wrong TYPE, because
 * what it is handed came from third-party code and not from a typed value.
 *
 * ABSENCE IS NOT A PROBLEM. A key left out of a row is the metric saying it
 * cannot observe that number for that scenario or family, which is the honesty
 * rule of this piece; rule C4 checks the keys that ARE present and never
 * requires a key on a row.
 */
import { describe, expect, it } from "vitest";
import type { CustomMetricResult } from "../customMetric";
import { CUSTOM_METRIC_ID_PATTERN, validateCustomMetricResult } from "../customMetric";

const EXPECTED = { metricId: "balance-summary", scenarioIds: ["S0", "S100"] };

/** A valid two-scenario result to mutate one field of per case. */
function ok(): CustomMetricResult {
  return {
    metricId: "balance-summary",
    label: "Balance summary (demonstration metric)",
    keys: [
      { id: "opening-balance", label: "Opening balance", unit: "currency" },
      { id: "runoff-share", label: "Runoff share", unit: "fraction" },
    ],
    byScenario: [
      {
        scenarioId: "S0",
        values: { "opening-balance": 1000, "runoff-share": 0.25 },
        byFamily: [
          { familyId: "FIXED", values: { "opening-balance": 600, "runoff-share": 0.5 } },
          { familyId: "DDA", values: { "opening-balance": 400 } },
        ],
      },
      { scenarioId: "S100", values: { "opening-balance": 1000 } },
    ],
  };
}

/**
 * Mutate one field to an arbitrary (possibly ill-typed) value, as a third-party
 * metric function would. The double cast is required and deliberate: the point
 * of these cases is that the validator is handed values of the WRONG TYPE,
 * which a single `as CustomMetricResult` will not permit.
 */
function withField(field: string, value: unknown): CustomMetricResult {
  return { ...ok(), [field]: value } as unknown as CustomMetricResult;
}

describe("validateCustomMetricResult", () => {
  it("reports no problem at all on a valid result, absent keys included", () => {
    expect(validateCustomMetricResult(ok(), EXPECTED)).toEqual([]);
  });

  it("C1 refuses a metricId that is not the registered one, and an empty label", () => {
    const wrongId = validateCustomMetricResult(withField("metricId", "something-else"), EXPECTED);
    expect(wrongId.map((p) => [p.rule, p.field])).toEqual([["C1", "metricId"]]);
    expect(wrongId[0]!.message).toContain("balance-summary");

    const noLabel = validateCustomMetricResult(withField("label", ""), EXPECTED);
    expect(noLabel.map((p) => [p.rule, p.field])).toEqual([["C1", "label"]]);
  });

  it("C2 refuses no keys, a duplicate key id, and a unit outside the five", () => {
    expect(validateCustomMetricResult(withField("keys", []), EXPECTED).map((p) => p.rule)).toEqual([
      "C2",
    ]);

    const dup = ok();
    dup.keys = [dup.keys[0]!, { ...dup.keys[0]! }];
    expect(validateCustomMetricResult(dup, EXPECTED).map((p) => [p.rule, p.field])).toEqual([
      ["C2", "keys[1].id"],
    ]);

    const unit = ok();
    unit.keys[0] = { ...unit.keys[0]!, unit: "furlongs" as never };
    const problems = validateCustomMetricResult(unit, EXPECTED);
    expect(problems.map((p) => [p.rule, p.field])).toEqual([["C2", "keys[0].unit"]]);
    expect(problems[0]!.message).toContain("currency");
  });

  it("C3 refuses a missing scenario, an extra scenario, and the wrong order", () => {
    const missing = ok();
    missing.byScenario = [missing.byScenario[0]!];
    expect(validateCustomMetricResult(missing, EXPECTED).map((p) => p.rule)).toEqual(["C3"]);

    const extra = ok();
    extra.byScenario = [...extra.byScenario, { scenarioId: "SGHOST", values: {} }];
    const extraProblems = validateCustomMetricResult(extra, EXPECTED);
    expect(extraProblems.map((p) => p.rule)).toEqual(["C3"]);
    expect(extraProblems[0]!.message).toContain("SGHOST");

    const swapped = ok();
    swapped.byScenario = [swapped.byScenario[1]!, swapped.byScenario[0]!];
    expect(validateCustomMetricResult(swapped, EXPECTED).map((p) => p.rule)).toEqual(["C3"]);
  });

  it("C4 refuses an undeclared key and a non-finite value, on a scenario row and on a family row", () => {
    const undeclared = ok();
    undeclared.byScenario[0]!.values = { ...undeclared.byScenario[0]!.values, "no-such-key": 1 };
    const u = validateCustomMetricResult(undeclared, EXPECTED);
    expect(u.map((p) => [p.rule, p.field])).toEqual([["C4", 'byScenario[0].values["no-such-key"]']]);

    const nan = ok();
    nan.byScenario[1]!.values = { "opening-balance": Number.NaN };
    expect(validateCustomMetricResult(nan, EXPECTED).map((p) => p.rule)).toEqual(["C4"]);

    const familyInfinity = ok();
    familyInfinity.byScenario[0]!.byFamily![1]!.values = {
      "opening-balance": Number.POSITIVE_INFINITY,
    };
    const f = validateCustomMetricResult(familyInfinity, EXPECTED);
    expect(f.map((p) => p.rule)).toEqual(["C4"]);
    expect(f[0]!.field).toContain("byFamily[1]");
  });

  it("C5 refuses two family rows with one family id in one scenario", () => {
    const dup = ok();
    dup.byScenario[0]!.byFamily = [
      { familyId: "FIXED", values: {} },
      { familyId: "FIXED", values: {} },
    ];
    const problems = validateCustomMetricResult(dup, EXPECTED);
    expect(problems.map((p) => p.rule)).toEqual(["C5"]);
    expect(problems[0]!.message).toContain("FIXED");
  });

  it("the id pattern refuses an upper-case id and a 65-character id", () => {
    expect(CUSTOM_METRIC_ID_PATTERN.test("balance-summary")).toBe(true);
    expect(CUSTOM_METRIC_ID_PATTERN.test("Balance-Summary")).toBe(false);
    expect(CUSTOM_METRIC_ID_PATTERN.test("a".repeat(64))).toBe(true);
    expect(CUSTOM_METRIC_ID_PATTERN.test("a".repeat(65))).toBe(false);
    // A leading digit and a leading hyphen are both refused: an id starts with
    // a lower-case letter, so it is always a legal object key read plainly.
    expect(CUSTOM_METRIC_ID_PATTERN.test("1-metric")).toBe(false);
    expect(CUSTOM_METRIC_ID_PATTERN.test("-metric")).toBe(false);
  });
});
