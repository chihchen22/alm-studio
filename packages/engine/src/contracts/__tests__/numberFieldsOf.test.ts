/**
 * numberFieldsOf: the declared number fields of a
 * built-in overlay's schema, in schema order; a registered overlay has none.
 * Paths are restated here from the schema, never imported.
 */
import { describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, MBS_DEFAULTS, NMD_DEFAULTS } from "@alm/kernel";
import type { BehavioralOverlay } from "../assumptions";
import { numberFieldsOf } from "../paramSchema";

const paths = (o: BehavioralOverlay): string[] => numberFieldsOf(o).map((f) => f.path);

describe("numberFieldsOf", () => {
  it("four-factor CPR: ten parameters, schema order", () => {
    expect(paths({ kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS })).toEqual([
      "params.secSpread",
      "params.primSpread",
      "params.wac",
      "params.minCpr",
      "params.maxCpr",
      "params.steepness",
      "params.inflection",
      "params.seasoningRamp",
      "params.seasonalityAmp",
      "params.burnoutDecay",
    ]);
  });

  it("nmd-decay: fifteen number paths, no buckets table", () => {
    const got = paths({ kind: "nmd-decay", params: NMD_DEFAULTS });
    expect(got).toEqual([
      "params.closureSteady",
      "params.closureInitial",
      "params.closureTauMonths",
      "params.burnoutLambda",
      "params.maxRateDecay",
      "params.maxRateGrowth",
      "params.logisticK",
      "params.logisticMidpoint",
      "params.maPeriod",
      "params.regimeAlpha",
      "params.balanceSize",
      "params.sens.gMin",
      "params.sens.gMax",
      "params.sens.bStar",
      "params.sens.kappaB",
    ]);
    expect(got).toHaveLength(15);
    expect(got).not.toContain("params.buckets");
  });

  it("the other built-in kinds", () => {
    expect(paths({ kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS })).toEqual([
      "params.betaMin",
      "params.betaMax",
      "params.k",
      "params.m",
      "params.lambda",
    ]);
    expect(paths({ kind: "cd-rollover", renewalProbability: 0.5, offeredSpreadBp: 10, termMonths: 12 })).toEqual([
      "renewalProbability",
      "offeredSpreadBp",
      "termMonths",
    ]);
    expect(paths({ kind: "prepay", model: "constant-cpr", annualCpr: 0.06 })).toEqual(["annualCpr"]);
    expect(paths({ kind: "commitment-draw", rampRates: [0.1], steadyRate: 0.02 })).toEqual(["steadyRate"]);
    expect(paths({ kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 250 })).toEqual(["totalSpreadBp"]);
  });

  it("a registered overlay has none; every entry is a number field with a label and unit", () => {
    expect(paths({ kind: "registered", registeredKind: "plug", params: { a: 1 } })).toEqual([]);
    for (const f of numberFieldsOf({ kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS })) {
      expect(f.shape).toBe("number");
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.unit.length).toBeGreaterThan(0);
    }
  });
});
