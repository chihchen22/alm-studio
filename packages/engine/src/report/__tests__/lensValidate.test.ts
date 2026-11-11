/**
 * Piece 3a, spec Section 2 (rules V1 to V5) and Section 3 (the band domain).
 *
 * validateLens is the ONLY validator: the seed runs it before a write and both
 * read routes run it again on the stored document, so a hand-edited store file
 * cannot produce a reading. It returns one problem per rule broken and never
 * throws, including on a document whose fields are the wrong TYPE, because the
 * thing it is handed on the route is parsed JSON and not a typed value.
 */
import { describe, expect, it } from "vitest";
import type { LensDefinition } from "../../contracts/lens";
import { buildBands, GAP_BAND_LABELS } from "../../gap/bands";
import { validateLens } from "../lensValidate";

/** The four demo definitions of spec Section 6, inline. Task 4 ships them as a fixture file. */
const DEMO_LENSES: LensDefinition[] = [
  {
    id: "liquidity-demo-v1",
    label: "Liquidity (demonstration limits)",
    objective: "liquidity",
    constraints: [
      {
        id: "cum-gap-1m",
        reader: "cumulativeLiquidityGap",
        params: { band: "0-1M" },
        op: "atLeast",
        limit: -50000000,
      },
      {
        id: "cum-gap-3m",
        reader: "cumulativeLiquidityGap",
        params: { band: "1-3M" },
        op: "atLeast",
        limit: -100000000,
      },
    ],
  },
  {
    id: "rate-demo-v1",
    label: "Interest-rate risk (demonstration limits)",
    objective: "rate",
    constraints: [
      { id: "eve-15", reader: "deltaEvePct", op: "atLeast", limit: -0.15 },
      {
        id: "nii-12",
        reader: "deltaNiiPct",
        params: { horizonMonths: 12 },
        op: "atLeast",
        limit: -0.1,
      },
    ],
  },
  {
    id: "capital-demo-v1",
    label: "Capital (demonstration limits)",
    objective: "capital",
    constraints: [{ id: "cet1", reader: "capitalRatio", op: "atLeast", limit: 0.08 }],
  },
  {
    id: "strategy-demo-v1",
    label: "Management strategy (demonstration limits)",
    objective: "strategy",
    constraints: [
      { id: "no-shortfall", reader: "shortfallCount", op: "atMost", limit: 0 },
      {
        id: "nii-24",
        reader: "deltaNiiPct",
        params: { horizonMonths: 24 },
        op: "atLeast",
        limit: -0.05,
      },
    ],
  },
  {
    id: "balance-demo-v1",
    label: "Balance runoff (demonstration limits, reads the demonstration metric)",
    objective: "strategy",
    constraints: [
      {
        id: "runoff-50",
        reader: "customValue",
        params: { metricId: "balance-summary", key: "runoff-share" },
        op: "atMost",
        limit: 0.5,
      },
    ],
  },
];

/** A valid single-constraint lens to mutate one field of per case. */
function ok(): LensDefinition {
  return {
    id: "probe-v1",
    label: "Probe",
    objective: "rate",
    constraints: [{ id: "eve", reader: "deltaEvePct", op: "atLeast", limit: -0.15 }],
  };
}

/**
 * Mutate one field to an arbitrary (possibly ill-typed) value, as a hand-edited
 * store file would. The double cast is required and deliberate: the point of
 * these cases is that validateLens is handed values of the WRONG TYPE, which a
 * single `as LensDefinition` will not permit.
 */
function withField(field: string, value: unknown): LensDefinition {
  return { ...ok(), [field]: value } as unknown as LensDefinition;
}

function withConstraint(patch: Record<string, unknown>): LensDefinition {
  const base = ok();
  return {
    ...base,
    constraints: [{ ...base.constraints[0], ...patch } as unknown as LensDefinition["constraints"][number]],
  };
}

describe("validateLens", () => {
  it("accepts the four demo definitions with no problem at all", () => {
    for (const lens of DEMO_LENSES) expect(validateLens(lens)).toEqual([]);
  });

  /**
   * The threat model is a hand-edited store file, so the document itself may not
   * be an object at all. A validator that reached into `null` would throw where
   * it is contracted to report.
   */
  it("V1 reports rather than throws on a document that is not an object", () => {
    expect(() => validateLens(null as unknown as LensDefinition)).not.toThrow();
    expect(validateLens(null as unknown as LensDefinition).map((p) => p.rule)).toEqual(["V1"]);
    expect(validateLens([] as unknown as LensDefinition).map((p) => p.rule)).toEqual(["V1"]);
    expect(validateLens("lens" as unknown as LensDefinition).map((p) => p.rule)).toEqual(["V1"]);
  });

  it("V1 refuses an id that is not a store id", () => {
    const problems = validateLens(withField("id", "not a store id"));
    expect(problems.map((p) => [p.rule, p.field])).toEqual([["V1", "id"]]);
    expect(problems[0].message).toContain("not a store id");
  });

  it("V1 refuses an empty label and an objective outside the four", () => {
    expect(validateLens(withField("label", "")).map((p) => [p.rule, p.field])).toEqual([
      ["V1", "label"],
    ]);
    const bad = validateLens(withField("objective", "profitability"));
    expect(bad.map((p) => [p.rule, p.field])).toEqual([["V1", "objective"]]);
    expect(bad[0].message).toContain("liquidity, rate, capital, strategy");
  });

  it("V2 refuses a lens with no constraint", () => {
    const problems = validateLens(withField("constraints", []));
    expect(problems.map((p) => [p.rule, p.field])).toEqual([["V2", "constraints"]]);
  });

  it("V2 refuses a duplicate constraint id and a constraint id that is not a store id", () => {
    const base = ok();
    const dup = validateLens({
      ...base,
      constraints: [base.constraints[0], { ...base.constraints[0] }],
    });
    expect(dup.map((p) => [p.rule, p.constraintId])).toEqual([["V2", "eve"]]);
    expect(dup[0].message).toContain("declared twice");

    const badId = validateLens(withConstraint({ id: "has a space" }));
    expect(badId.map((p) => p.rule)).toEqual(["V2"]);
  });

  it("V3 refuses a reader outside the closed set, listing the set", () => {
    const problems = validateLens(withConstraint({ reader: "lcr" }));
    expect(problems.map((p) => [p.rule, p.field])).toEqual([["V3", "reader"]]);
    expect(problems[0].message).toContain("cumulativeLiquidityGap");
  });

  it("V4 refuses a missing required parameter and an unknown parameter key", () => {
    const missing = validateLens(
      withConstraint({ reader: "deltaNiiPct", params: undefined, limit: -0.1 }),
    );
    expect(missing.map((p) => [p.rule, p.field])).toEqual([["V4", "params.horizonMonths"]]);

    const unknown = validateLens(withConstraint({ params: { horizonMonths: 12 } }));
    expect(unknown.map((p) => [p.rule, p.field])).toEqual([["V4", "params.horizonMonths"]]);
    expect(unknown[0].message).toContain("takes no parameter");
  });

  it("V4 refuses a band the gap module does not label and a non-integer horizon", () => {
    const band = validateLens(
      withConstraint({ reader: "cumulativeLiquidityGap", params: { band: "0-2M" } }),
    );
    expect(band.map((p) => [p.rule, p.field])).toEqual([["V4", "params.band"]]);
    expect(band[0].message).toContain("0-1M");

    const horizon = validateLens(
      withConstraint({ reader: "deltaNiiPct", params: { horizonMonths: 12.5 } }),
    );
    expect(horizon.map((p) => [p.rule, p.field])).toEqual([["V4", "params.horizonMonths"]]);
  });

  it("V5 refuses a non-finite limit and an op outside the two", () => {
    expect(validateLens(withConstraint({ limit: "-0.15" })).map((p) => [p.rule, p.field])).toEqual([
      ["V5", "limit"],
    ]);
    expect(validateLens(withConstraint({ op: "below" })).map((p) => [p.rule, p.field])).toEqual([
      ["V5", "op"],
    ]);
  });

  /**
   * The pin is the literal list, restated here by hand. buildBands labels its
   * rows by indexing GAP_BAND_LABELS, so comparing the two would compare the
   * thing under test with itself and would pass through any label change.
   * The buildBands comparison is kept underneath as a WIRING check only: it
   * says the labeller still reads this list in this order, not that the labels
   * are right.
   */
  it("GAP_BAND_LABELS is the nine standard band labels, in band order", () => {
    expect([...GAP_BAND_LABELS]).toEqual([
      "0-1M",
      "1-3M",
      "3-6M",
      "6-12M",
      "1-2Y",
      "2-3Y",
      "3-5Y",
      "5-10Y",
      "10Y+",
    ]);
    expect(buildBands(360).map((b) => b.label)).toEqual([...GAP_BAND_LABELS]);
  });

  /** The sixth reader and its two parameters. */
  it("V3 accepts customValue and V4 requires both of its parameters", () => {
    expect(
      validateLens(
        withConstraint({
          reader: "customValue",
          params: { metricId: "balance-summary", key: "runoff-share" },
        }),
      ),
    ).toEqual([]);

    const missingKey = validateLens(
      withConstraint({ reader: "customValue", params: { metricId: "balance-summary" } }),
    );
    expect(missingKey.map((p) => [p.rule, p.field])).toEqual([["V4", "params.key"]]);

    const extra = validateLens(
      withConstraint({
        reader: "customValue",
        params: { metricId: "balance-summary", key: "runoff-share", scale: 2 },
      }),
    );
    expect(extra.map((p) => [p.rule, p.field])).toEqual([["V4", "params.scale"]]);
    expect(extra[0]!.message).toContain("takes only metricId, key");
  });

  it("V4 refuses a metricId or a key that is not a custom metric id", () => {
    const badMetric = validateLens(
      withConstraint({ reader: "customValue", params: { metricId: "Balance Summary", key: "runoff-share" } }),
    );
    expect(badMetric.map((p) => [p.rule, p.field])).toEqual([["V4", "params.metricId"]]);
    expect(badMetric[0]!.message).toContain("must match");

    const badKey = validateLens(
      withConstraint({ reader: "customValue", params: { metricId: "balance-summary", key: "runoffShare" } }),
    );
    expect(badKey.map((p) => [p.rule, p.field])).toEqual([["V4", "params.key"]]);
  });
});
