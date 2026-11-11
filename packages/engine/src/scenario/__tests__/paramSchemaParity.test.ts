/**
 * The parameter schema against the resolve-time guard. One failing overlay per resolve-time refusal in resolveAssumptions.ts
 * (resolvePrepay, resolveDepositBeta, resolveDecay, resolveCdRollover,
 * resolveCommitmentDraw): the resolver refuses it with OverlayParamError, the
 * schema refuses it at the restated path, and bindAssumptions refuses it at
 * that path first, so a bad value stops at save and never reaches a run.
 */
import { describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, MBS_DEFAULTS, NMD_DEFAULTS } from "@alm/kernel";
import type { AssumptionSet, BehavioralOverlay } from "../../contracts/assumptions";
import type { ProductFamilyDef } from "../../contracts/chartOfAccounts";
import { checkOverlayParams } from "../../contracts/paramSchema";
import { AssumptionValidationError, bindAssumptions } from "../bindAssumptions";
import { OverlayParamError, resolveAssumptions } from "../resolveAssumptions";

const FAMILIES: ProductFamilyDef[] = [
  { id: "MBS", label: "MBS", side: "asset", instrumentType: "mortgage", coaNodeId: "n-mbs" },
  { id: "MMA", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "n-mma" },
  { id: "DDA", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "n-dda" },
  { id: "CD", label: "CDs", side: "liability", instrumentType: "fixed-loan", coaNodeId: "n-cd" },
  { id: "LINES", label: "Lines", side: "asset", instrumentType: "commitment", coaNodeId: "n-lines" },
];

const four = (over: Record<string, unknown>): BehavioralOverlay => ({ kind: "prepay", model: "four-factor-cpr", params: { ...MBS_DEFAULTS, ...over } });
const decay = (over: Record<string, unknown>): BehavioralOverlay => ({ kind: "nmd-decay", params: { ...structuredClone(NMD_DEFAULTS), ...over } as never });
const beta = (over: Record<string, unknown>): BehavioralOverlay => ({ kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS, ...over } });
const cd = (over: Record<string, unknown>): BehavioralOverlay => ({ kind: "cd-rollover", renewalProbability: 0.6, offeredSpreadBp: 25, termMonths: 12, ...over } as never);
const draw = (over: Record<string, unknown>): BehavioralOverlay => ({ kind: "commitment-draw", rampRates: [0.35, 0.15, 0.1], steadyRate: 0.02, ...over } as never);

/** [what the resolver refuses, family, the failing overlay, the path the schema names], one row per resolve-time refusal. */
const CASES: Array<[string, string, BehavioralOverlay, string]> = [
  ["prepay: maxCpr > minCpr", "MBS", four({ maxCpr: 2, minCpr: 2 }), "params.maxCpr"],
  ["prepay: seasoningRamp positive", "MBS", four({ seasoningRamp: 0 }), "params.seasoningRamp"],
  ["prepay: constant annualCpr above 1", "MBS", { kind: "prepay", model: "constant-cpr", annualCpr: 1.5 }, "annualCpr"],
  ["prepay: constant annualCpr below 0", "MBS", { kind: "prepay", model: "constant-cpr", annualCpr: -0.01 }, "annualCpr"],
  ["deposit-beta: betaMin at least 0", "MMA", beta({ betaMin: -0.1 }), "params.betaMin"],
  ["deposit-beta: betaMax > betaMin", "MMA", beta({ betaMin: 0.5, betaMax: 0.1 }), "params.betaMax"],
  ["deposit-beta: lambda above 0", "MMA", beta({ lambda: 0 }), "params.lambda"],
  ["deposit-beta: lambda at most 1", "MMA", beta({ lambda: 1.5 }), "params.lambda"],
  ["nmd-decay: maPeriod positive", "DDA", decay({ maPeriod: 0 }), "params.maPeriod"],
  ["nmd-decay: buckets non-empty", "DDA", decay({ buckets: [] }), "params.buckets"],
  ["nmd-decay: buckets an array", "DDA", decay({ buckets: {} }), "params.buckets"],
  ["cd-rollover: renewalProbability above 1", "CD", cd({ renewalProbability: 1.4 }), "renewalProbability"],
  ["cd-rollover: renewalProbability below 0", "CD", cd({ renewalProbability: -0.1 }), "renewalProbability"],
  ["cd-rollover: termMonths positive", "CD", cd({ termMonths: 0 }), "termMonths"],
  ["commitment-draw: rampRates an array", "LINES", draw({ rampRates: 0.3 }), "rampRates"],
  ["commitment-draw: a ramp rate above 1", "LINES", draw({ rampRates: [0.35, 1.2] }), "rampRates[1]"],
  ["commitment-draw: a ramp rate not finite", "LINES", draw({ rampRates: [Number.NaN] }), "rampRates[0]"],
  ["commitment-draw: steadyRate below 0", "LINES", draw({ steadyRate: -0.01 }), "steadyRate"],
  ["commitment-draw: steadyRate not finite", "LINES", draw({ steadyRate: Number.NaN }), "steadyRate"],
];

const setOf = (familyId: string, overlay: BehavioralOverlay): AssumptionSet => ({
  schemaVersion: "1.0.0", id: "as-parity", label: "parity", bindings: [{ familyId, overlay, modelVersion: "v-1" }],
});

describe("schema parity with every resolve-time refusal", () => {
  for (const [what, familyId, overlay, path] of CASES) {
    it(what, () => {
      expect(() => resolveAssumptions(setOf(familyId, overlay), FAMILIES)).toThrow(OverlayParamError);
      expect(checkOverlayParams(overlay).map((i) => i.path)).toContain(path);
      let caught: unknown;
      try { bindAssumptions(setOf(familyId, overlay)); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(AssumptionValidationError);
      expect((caught as AssumptionValidationError).field).toBe(`bindings[0].overlay.${path}`);
    });
  }
});
