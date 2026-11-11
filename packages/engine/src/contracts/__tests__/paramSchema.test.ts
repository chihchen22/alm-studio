/**
 * Parameter schema tests.
 * The bounds, paths and messages are restated here from the spec's Section 4.2
 * table, never read back from the schema under test.
 */
import { describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, buildWarmupSOFR1M, MBS_DEFAULTS, NMD_B_TERMS_DEFAULTS, NMD_DEFAULTS, runNMDOnPaths } from "@alm/kernel";
import type { BehavioralOverlay } from "../assumptions";
import { checkOverlayParams, columnSum, PARAM_SCHEMAS, schemaKeyOf, type SchemaKey } from "../paramSchema";

/** One overlay per built-in model: the kernel defaults where the kernel has them, fixtures for the three it does not. */
const FIXTURES: Record<SchemaKey, BehavioralOverlay> = {
  "prepay/four-factor-cpr": { kind: "prepay", model: "four-factor-cpr", params: structuredClone(MBS_DEFAULTS) },
  "prepay/constant-cpr": { kind: "prepay", model: "constant-cpr", annualCpr: 0.06 },
  "nmd-decay": { kind: "nmd-decay", params: structuredClone(NMD_DEFAULTS) },
  "deposit-beta": { kind: "deposit-beta", params: structuredClone(BETA_S_CURVE_DEFAULTS) },
  "cd-rollover": { kind: "cd-rollover", renewalProbability: 0.6, offeredSpreadBp: 25, termMonths: 12 },
  "commitment-draw": { kind: "commitment-draw", rampRates: [0.35, 0.15, 0.1], steadyRate: 0.02 },
  "loan-client-rate": { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 250 },
};
const KEYS = Object.keys(FIXTURES) as SchemaKey[];
const EM_DASH = new RegExp(String.fromCharCode(0x2014));

/** A fresh copy of the fixture with `path` (dotted, [i] for an array index) set to `value`; undefined deletes the key. */
function withValue(key: SchemaKey, path: string, value: unknown): BehavioralOverlay {
  const o = structuredClone(FIXTURES[key]) as unknown as Record<string, unknown>;
  const steps = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let at: Record<string, unknown> = o;
  for (const s of steps.slice(0, -1)) at = at[s] as Record<string, unknown>;
  const last = steps[steps.length - 1]!;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return o as unknown as BehavioralOverlay;
}

const messagesAt = (o: BehavioralOverlay, path: string) => checkOverlayParams(o).filter((i) => i.path === path).map((i) => i.message);

/** Every leaf path of an overlay, `kind` and `model` aside; arrays by index. Restated, so the test does not read the schema's walk. */
function leafPaths(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leafPaths(x, `${prefix}[${i}]`));
  if (v !== null && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !(prefix === "" && (k === "kind" || k === "model")))
      .flatMap(([k, x]) => leafPaths(x, prefix === "" ? k : `${prefix}.${k}`));
  }
  return [prefix];
}

/** The paths a schema declares, expanded over the fixture's rows. */
function declaredPaths(key: SchemaKey, overlay: BehavioralOverlay): string[] {
  const at = (path: string): unknown => path.split(".").reduce<unknown>((o, s) => (o as Record<string, unknown>)[s], overlay);
  return PARAM_SCHEMAS[key].fields.flatMap((f) => {
    if (f.shape === "number") return [f.path];
    const rows = at(f.path) as unknown[];
    return f.shape === "list" ? rows.map((_, i) => `${f.path}[${i}]`) : rows.flatMap((_, i) => f.columns.map((c) => `${f.path}[${i}].${c.key}`));
  });
}

describe("PARAM_SCHEMAS against the kernel defaults and fixtures (spec Section 4.4 item 1)", () => {
  it("has exactly the seven built-in model keys", () => {
    expect(Object.keys(PARAM_SCHEMAS).sort()).toEqual(["cd-rollover", "commitment-draw", "deposit-beta", "loan-client-rate", "nmd-decay", "prepay/constant-cpr", "prepay/four-factor-cpr"]);
  });
  for (const key of KEYS) {
    it(`${key}: every declared field is a real leaf, and every leaf is declared`, () => {
      expect(declaredPaths(key, FIXTURES[key]).sort()).toEqual(leafPaths(FIXTURES[key]).sort());
    });
    it(`${key}: the fixture passes`, () => {
      expect(checkOverlayParams(FIXTURES[key])).toEqual([]);
    });
  }
  it("the interest-bearing decay defaults pass too", () => {
    expect(checkOverlayParams({ kind: "nmd-decay", params: structuredClone(NMD_B_TERMS_DEFAULTS.nmdParams) })).toEqual([]);
  });
  it("every field has a label, a unit where it holds numbers, and a one-sentence help line with no em-dash", () => {
    for (const key of KEYS) {
      for (const f of PARAM_SCHEMAS[key].fields) {
        expect(f.label, f.path).not.toBe("");
        expect(f.help, f.path).toMatch(/^[A-Z].*\.$/);
        expect(f.help, f.path).not.toMatch(EM_DASH);
        if (f.shape !== "table") expect(f.unit, f.path).not.toBe("");
      }
    }
  });
});

describe("schemaKeyOf", () => {
  it("names each built-in model and nothing for a registered overlay", () => {
    for (const key of KEYS) expect(schemaKeyOf(FIXTURES[key])).toBe(key);
    expect(schemaKeyOf({ kind: "registered", registeredKind: "acme-decay", params: { rate: 5 } })).toBeUndefined();
  });
  it("reads a prepay model other than four-factor-cpr as constant CPR, as the resolver does", () => {
    const o = { kind: "prepay", model: "constant", annualCpr: 0.08 } as unknown as BehavioralOverlay;
    expect(schemaKeyOf(o)).toBe("prepay/constant-cpr");
    expect(checkOverlayParams(o)).toEqual([]);
  });
});

/** [schema key, path, a value inside, a value outside, the message outside], restated from spec Section 4.2. */
const BOUNDS: Array<[SchemaKey, string, number, number, string]> = [
  ["prepay/four-factor-cpr", "params.minCpr", 0, -0.5, "must be at least 0"],
  ["prepay/four-factor-cpr", "params.minCpr", 50, 100.5, "must be at most 100"],
  ["prepay/four-factor-cpr", "params.maxCpr", 100, 100.5, "must be at most 100"],
  ["prepay/four-factor-cpr", "params.maxCpr", 2.5, 2, "must be above the minimum CPR"],
  ["prepay/four-factor-cpr", "params.wac", 0, -0.1, "must be at least 0"],
  ["prepay/four-factor-cpr", "params.seasoningRamp", 0.5, 0, "must be above 0"],
  ["prepay/four-factor-cpr", "params.seasonalityAmp", 0, -1, "must be at least 0"],
  ["prepay/four-factor-cpr", "params.seasonalityAmp", 100, 101, "must be at most 100"],
  ["prepay/four-factor-cpr", "params.burnoutDecay", 0, -0.01, "must be at least 0"],
  ["prepay/constant-cpr", "annualCpr", 0, -0.01, "must be at least 0"],
  ["prepay/constant-cpr", "annualCpr", 1, 1.01, "must be at most 1"],
  ["nmd-decay", "params.closureSteady", 0, -0.1, "must be at least 0"],
  ["nmd-decay", "params.closureSteady", 100, 100.5, "must be at most 100"],
  ["nmd-decay", "params.closureInitial", 0, -0.1, "must be at least 0"],
  ["nmd-decay", "params.closureInitial", 100, 100.5, "must be at most 100"],
  ["nmd-decay", "params.closureTauMonths", 0.5, 0, "must be above 0"],
  ["nmd-decay", "params.burnoutLambda", 0, -0.1, "must be at least 0"],
  ["nmd-decay", "params.regimeAlpha", 0, -0.1, "must be at least 0"],
  ["nmd-decay", "params.maPeriod", 1, 0, "must be at least 1"],
  ["nmd-decay", "params.maPeriod", 12, 12.5, "must be a whole number"],
  ["nmd-decay", "params.maPeriod", 297, 298, "must be at most 297"],
  ["nmd-decay", "params.balanceSize", 1, 0, "must be above 0"],
  ["nmd-decay", "params.sens.gMin", 0, -0.1, "must be at least 0"],
  ["nmd-decay", "params.sens.gMax", 0.15, 0.1, "must be at least the sensitivity floor"],
  ["nmd-decay", "params.sens.bStar", 1, 0, "must be above 0"],
  ["nmd-decay", "params.buckets[0].repBalance", 1, 0, "must be above 0"],
  ["nmd-decay", "params.buckets[1].share", 0, -0.1, "must be at least 0"],
  ["nmd-decay", "params.buckets[1].share", 1, 1.2, "must be at most 1"],
  ["deposit-beta", "params.betaMin", 0, -0.01, "must be at least 0"],
  ["deposit-beta", "params.betaMax", 0.9, 0.45, "must be above the beta floor"],
  ["deposit-beta", "params.lambda", 1, 0, "must be above 0"],
  ["deposit-beta", "params.lambda", 0.01, 1.01, "must be at most 1"],
  ["cd-rollover", "renewalProbability", 0, -0.1, "must be at least 0"],
  ["cd-rollover", "renewalProbability", 1, 1.1, "must be at most 1"],
  ["cd-rollover", "termMonths", 1, 0, "must be at least 1"],
  ["cd-rollover", "termMonths", 6, 6.5, "must be a whole number"],
  ["commitment-draw", "rampRates[1]", 0, -0.1, "must be at least 0"],
  ["commitment-draw", "rampRates[1]", 1, 1.2, "must be at most 1"],
  ["commitment-draw", "steadyRate", 0, -0.01, "must be at least 0"],
  ["commitment-draw", "steadyRate", 1, 1.5, "must be at most 1"],
];

describe("hard bounds (spec Section 4.2, item 2 of Section 4.4)", () => {
  for (const [key, path, inside, outside, message] of BOUNDS) {
    it(`${key} ${path}: ${inside} passes, ${outside} is refused (${message})`, () => {
      expect(messagesAt(withValue(key, path, inside), path)).toEqual([]);
      expect(messagesAt(withValue(key, path, outside), path)).toContain(message);
    });
  }
  it("a finite-only field takes any finite value", () => {
    for (const [key, path, v] of [
      ["prepay/four-factor-cpr", "params.secSpread", -500], ["prepay/four-factor-cpr", "params.inflection", -80], ["prepay/four-factor-cpr", "params.steepness", 0],
      ["nmd-decay", "params.maxRateGrowth", -1], ["nmd-decay", "params.maxRateDecay", 40], ["nmd-decay", "params.logisticMidpoint", -3], ["nmd-decay", "params.sens.kappaB", -2],
      ["deposit-beta", "params.k", -1], ["deposit-beta", "params.m", 0], ["deposit-beta", "params.betaMax", 1.5], ["cd-rollover", "offeredSpreadBp", -50],
    ] as Array<[SchemaKey, string, number]>) {
      expect(checkOverlayParams(withValue(key, path, v)), `${key} ${path}`).toEqual([]);
    }
  });
  it("every number must be present, a number and finite; JSON carries NaN as null", () => {
    expect(messagesAt(withValue("nmd-decay", "params.sens.bStar", Number.NaN), "params.sens.bStar")).toEqual(["must be a finite number"]);
    expect(messagesAt(withValue("nmd-decay", "params.sens.bStar", Number.POSITIVE_INFINITY), "params.sens.bStar")).toEqual(["must be a finite number"]);
    expect(messagesAt(withValue("nmd-decay", "params.sens.bStar", null), "params.sens.bStar")).toEqual(["must be a number"]);
    expect(messagesAt(withValue("nmd-decay", "params.sens.bStar", "1100000"), "params.sens.bStar")).toEqual(["must be a number"]);
    expect(messagesAt(withValue("nmd-decay", "params.sens.bStar", undefined), "params.sens.bStar")).toEqual(["is missing"]);
    expect(messagesAt(withValue("prepay/four-factor-cpr", "params.secSpread", Number.NaN), "params.secSpread")).toEqual(["must be a finite number"]);
  });
  it("a table or list must be an array; the buckets need a row, a label and shares that sum above 0", () => {
    expect(messagesAt(withValue("nmd-decay", "params.buckets", {}), "params.buckets")).toEqual(["must be a list"]);
    expect(messagesAt(withValue("nmd-decay", "params.buckets", []), "params.buckets")).toEqual(["needs at least 1 row"]);
    expect(messagesAt(withValue("commitment-draw", "rampRates", 0.3), "rampRates")).toEqual(["must be a list"]);
    expect(checkOverlayParams(withValue("commitment-draw", "rampRates", []))).toEqual([]);
    expect(messagesAt(withValue("nmd-decay", "params.buckets[2].label", ""), "params.buckets[2].label")).toEqual(["must be non-empty text"]);
    const zero = withValue("nmd-decay", "params.buckets", [{ label: "a", repBalance: 1, share: 0 }, { label: "b", repBalance: 2, share: 0 }]);
    expect(messagesAt(zero, "params.buckets")).toEqual(["shares must sum to more than 0"]);
    const half = withValue("nmd-decay", "params.buckets", [{ label: "a", repBalance: 1, share: 0.2 }, { label: "b", repBalance: 2, share: 0.3 }]);
    expect(checkOverlayParams(half)).toEqual([]);
  });
  it("names a refused table cell and list item with the column or month and its row", () => {
    expect(checkOverlayParams(withValue("nmd-decay", "params.buckets[1].share", 1.2))).toEqual([
      { path: "params.buckets[1].share", label: "Share, row 2", message: "must be at most 1" },
    ]);
    expect(checkOverlayParams(withValue("commitment-draw", "rampRates[2]", -0.1))).toEqual([
      { path: "rampRates[2]", label: "Draw ramp, month 3", message: "must be at least 0" },
    ]);
  });
  it("puts a cross-rule issue at the second field, with that field's label", () => {
    expect(checkOverlayParams(withValue("deposit-beta", "params.betaMax", 0.45))).toEqual([
      { path: "params.betaMax", label: "Beta ceiling", message: "must be above the beta floor" },
    ]);
  });
  it("returns nothing for a registered overlay: its params belong to its plugin", () => {
    expect(checkOverlayParams({ kind: "registered", registeredKind: "acme-decay", params: { rate: Number.NaN } as never })).toEqual([]);
  });
});

describe("the two upper bounds added at Piece 4b (spec Section 4.2 amendment)", () => {
  it("the regime window stops at the engine's warm-up history, 297 months, and one month more reads past it", () => {
    // Restated: the kernel's warm-up history (Jan 2001 to Sep 2025) is 297 months. If it changes, this test and the bound move together.
    expect(buildWarmupSOFR1M().length).toBe(297);
    const path = [new Float64Array(12).fill(0.04)];
    const decayAt = (maPeriod: number) => runNMDOnPaths(path, { ...NMD_DEFAULTS, maPeriod }, buildWarmupSOFR1M()).decayMean[0]!;
    expect(Number.isFinite(decayAt(297))).toBe(true);
    expect(decayAt(298)).toBeNaN();
    expect(messagesAt(withValue("nmd-decay", "params.maPeriod", 297), "params.maPeriod")).toEqual([]);
    expect(messagesAt(withValue("nmd-decay", "params.maPeriod", 298), "params.maPeriod")).toEqual(["must be at most 297"]);
  });
  it("a closure rate above 100 percent a month makes the kernel report a month's run-off above the book and a negative balance", () => {
    // Measured (Polish 2 C4): the kernel clamps each bucket's balance at 0, not the month's run-off, so 100.5 reports
    // about 100.49 percent run-off and a balance of about -0.49 percent of the opening balance in month 1, where 100
    // reports exactly 100 and 0.
    const path = [new Float64Array(12).fill(0.04)];
    const at = (closure: number) => runNMDOnPaths(path, { ...NMD_DEFAULTS, closureSteady: closure, closureInitial: closure }, buildWarmupSOFR1M());
    expect(at(100).decayMean[0]).toBe(100);
    expect(at(100).balMean[0]).toBe(0);
    expect(at(100.5).decayMean[0]!).toBeGreaterThan(100);
    expect(at(100.5).balMean[0]!).toBeLessThan(0);
    expect(checkOverlayParams(withValue("nmd-decay", "params.closureSteady", 150))).toEqual([
      { path: "params.closureSteady", label: "Steady closure rate", message: "must be at most 100" },
    ]);
    expect(checkOverlayParams(withValue("nmd-decay", "params.closureInitial", 150))).toEqual([
      { path: "params.closureInitial", label: "Initial closure rate", message: "must be at most 100" },
    ]);
  });
});

describe("ALM Studio Polish 2 (spec Section 5.1 A4, Section 5.3 C2)", () => {
  it("the regime window's help line and bound are built from one number, the kernel's warm-up history (C2)", () => {
    const months = buildWarmupSOFR1M().length;
    const f = PARAM_SCHEMAS["nmd-decay"].fields.find((x) => x.path === "params.maPeriod");
    expect(f).toMatchObject({ shape: "number", max: months });
    expect(f!.help).toBe(`Months in the trailing average rate that sets the regime, at most the ${months} months of rate history the engine holds before the first path month.`);
  });
  it("names the deposit-beta model Deposit repricing, the name of Studio's layer, add picker and group heading (A4)", () => {
    expect(PARAM_SCHEMAS["deposit-beta"].label).toBe("Deposit repricing");
  });
});

describe("columnSum", () => {
  it("sums a column, and is null while a value is not a finite number", () => {
    expect(columnSum([{ share: 0.2 }, { share: 0.3 }], "share")).toBe(0.5);
    expect(columnSum([{ share: 0.2 }, { share: Number.NaN }], "share")).toBeNull();
    expect(columnSum([], "share")).toBe(0);
    expect(columnSum("x", "share")).toBeNull();
  });
});

describe("loan-client-rate schema (piece 9, flat carry)", () => {
  const overlay = (over: Record<string, unknown>): BehavioralOverlay =>
    ({ kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 175, ...over }) as unknown as BehavioralOverlay;
  const dropped = (key: string): BehavioralOverlay => {
    const o = overlay({}) as unknown as Record<string, unknown>;
    delete o[key];
    return o as unknown as BehavioralOverlay;
  };

  it("has exactly one field, at the overlay root, in bp", () => {
    const fields = PARAM_SCHEMAS["loan-client-rate"].fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]!.path).toBe("totalSpreadBp");
    expect(fields[0]!.shape).toBe("number");
    expect((fields[0] as { unit: string }).unit).toBe("bp");
    expect(PARAM_SCHEMAS["loan-client-rate"].label).toBe("Loan client rate, flat carry");
    expect(PARAM_SCHEMAS["loan-client-rate"].rules).toEqual([]);
  });
  it("names the kind", () => {
    expect(schemaKeyOf(overlay({}))).toBe("loan-client-rate");
  });
  it("accepts 0 and 1000 inclusive", () => {
    expect(checkOverlayParams(overlay({ totalSpreadBp: 0 }))).toEqual([]);
    expect(checkOverlayParams(overlay({ totalSpreadBp: 1000 }))).toEqual([]);
  });
  it("refuses -1, 1000.5 and NaN with the shared messages", () => {
    expect(checkOverlayParams(overlay({ totalSpreadBp: -1 }))).toEqual([{ path: "totalSpreadBp", label: "Total spread", message: "must be at least 0" }]);
    expect(checkOverlayParams(overlay({ totalSpreadBp: 1000.5 }))).toEqual([{ path: "totalSpreadBp", label: "Total spread", message: "must be at most 1000" }]);
    expect(checkOverlayParams(overlay({ totalSpreadBp: Number.NaN }))).toEqual([{ path: "totalSpreadBp", label: "Total spread", message: "must be a finite number" }]);
  });
  it("refuses a missing spread", () => {
    expect(checkOverlayParams(dropped("totalSpreadBp"))).toEqual([{ path: "totalSpreadBp", label: "Total spread", message: "is missing" }]);
  });
  it("refuses any model other than flat-carry, and a missing one, before the field walk", () => {
    expect(checkOverlayParams(overlay({ model: "reverting" }))).toEqual([{ path: "model", label: "Model", message: 'must be "flat-carry"' }]);
    expect(checkOverlayParams(dropped("model"))).toEqual([{ path: "model", label: "Model", message: "is missing" }]);
    // The model issue comes first when both are wrong.
    expect(checkOverlayParams(overlay({ model: "reverting", totalSpreadBp: -1 }))).toEqual([
      { path: "model", label: "Model", message: 'must be "flat-carry"' },
      { path: "totalSpreadBp", label: "Total spread", message: "must be at least 0" },
    ]);
  });
});
