/**
 * resolveAssumptions tests. Acceptance: each OverlayBinding resolves into a
 * constructed, executable kernel behavioral object (or validated param bundle
 * where the executable is position-dependent), and an overlay targeting an
 * unknown family raises an inspectable error, never a silent drop.
 */
import { describe, expect, it } from "vitest";
import {
  BETA_S_CURVE_DEFAULTS,
  betaAtRate,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
} from "@alm/kernel";
import type { ProductFamilyDef } from "../../contracts/chartOfAccounts";
import type { AssumptionSet } from "../../contracts/assumptions";
import {
  resolveAssumptions,
  checkOverlayCompatibility,
  DuplicateOverlayError,
  IncompatibleOverlayError,
  OVERLAY_INSTRUMENT_COMPATIBILITY,
  UnknownFamilyError,
  OverlayParamError,
} from "../resolveAssumptions";
import { baseAssumptions, makeCoa } from "../../run/__tests__/fixtures";

const FAMILIES: ProductFamilyDef[] = [
  { id: "MBS", label: "MBS", side: "asset", instrumentType: "mortgage", coaNodeId: "n-mbs" },
  { id: "MMA", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "n-mma" },
  { id: "DDA", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "n-dda" },
  { id: "CD", label: "CDs", side: "liability", instrumentType: "fixed-loan", coaNodeId: "n-cd" },
];

function fullSet(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: "as-1",
    label: "full",
    bindings: [
      {
        familyId: "MBS",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: { ...MBS_DEFAULTS } },
        modelVersion: "mbs-1",
      },
      {
        familyId: "MMA",
        overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS } },
        modelVersion: "beta-1",
      },
      {
        familyId: "MMA",
        overlay: { kind: "nmd-decay", params: { ...NMD_DEFAULTS } },
        modelVersion: "decay-1",
      },
      {
        familyId: "CD",
        overlay: { kind: "cd-rollover", renewalProbability: 0.7, offeredSpreadBp: 20, termMonths: 24 },
        modelVersion: "cd-1",
      },
    ],
  };
}

describe("resolveAssumptions", () => {
  it("resolves overlays in binding order, keyed for lookup by family", () => {
    const r = resolveAssumptions(fullSet(), FAMILIES);
    expect(r.overlays.map((o) => o.kind)).toEqual([
      "prepay",
      "deposit-beta",
      "nmd-decay",
      "cd-rollover",
    ]);
    // A single family can legitimately carry more than one overlay kind
    // (an interest-bearing NMD needs both a beta and a decay overlay).
    expect(r.byFamily.get("MMA")!.map((o) => o.kind)).toEqual(["deposit-beta", "nmd-decay"]);
  });

  it("constructs an executable prepay model (four-factor CPR)", () => {
    const r = resolveAssumptions(fullSet(), FAMILIES);
    const prepay = r.byFamily.get("MBS")![0];
    if (prepay.kind !== "prepay") throw new Error("expected prepay");
    const schedule = prepay.model.cprSchedule({
      term: 360,
      age: 0,
      noteRate: 0.065,
      mortgageRateAt: () => 0.05,
    });
    expect(schedule.length).toBe(360);
    expect(schedule.every((c) => c >= 0 && c <= 1)).toBe(true);
  });

  it("constructs a constant-CPR prepay model", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-const",
      label: "const",
      bindings: [
        {
          familyId: "MBS",
          overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.06 },
          modelVersion: "mbs-c",
        },
      ],
    };
    const r = resolveAssumptions(set, FAMILIES);
    const prepay = r.byFamily.get("MBS")![0];
    if (prepay.kind !== "prepay") throw new Error("expected prepay");
    expect(prepay.model.cpr(1, { term: 12, age: 0, noteRate: 0.065, mortgageRateAt: () => 0.05 })).toBe(
      0.06,
    );
  });

  it("resolves a deposit-beta overlay to the kernel betaAtRate closure", () => {
    const r = resolveAssumptions(fullSet(), FAMILIES);
    const beta = r.byFamily.get("MMA")!.find((o) => o.kind === "deposit-beta");
    if (!beta || beta.kind !== "deposit-beta") throw new Error("expected deposit-beta");
    for (const rate of [0, 2, 4, 6, 8]) {
      expect(beta.betaAt(rate)).toBe(betaAtRate(rate, BETA_S_CURVE_DEFAULTS));
    }
  });

  it("carries validated decay params", () => {
    const r = resolveAssumptions(fullSet(), FAMILIES);
    const decay = r.byFamily.get("MMA")!.find((o) => o.kind === "nmd-decay");
    if (!decay || decay.kind !== "nmd-decay") throw new Error("expected nmd-decay");
    expect(decay.params.maPeriod).toBe(NMD_DEFAULTS.maPeriod);
  });

  it("carries cd-rollover knobs", () => {
    const r = resolveAssumptions(fullSet(), FAMILIES);
    const cd = r.byFamily.get("CD")![0];
    if (cd.kind !== "cd-rollover") throw new Error("expected cd-rollover");
    expect(cd.renewalProbability).toBe(0.7);
    expect(cd.termMonths).toBe(24);
  });

  it("raises an inspectable UnknownFamilyError, never a silent drop", () => {
    const set = fullSet();
    set.bindings.push({
      familyId: "GHOST",
      overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 0.05 },
      modelVersion: "x",
    });
    try {
      resolveAssumptions(set, FAMILIES);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownFamilyError);
      expect((e as UnknownFamilyError).familyId).toBe("GHOST");
      expect((e as UnknownFamilyError).knownFamilies).toEqual(["MBS", "MMA", "DDA", "CD"]);
    }
  });

  it("raises DuplicateOverlayError when one family gets two overlays of the same kind", () => {
    const set = fullSet();
    set.bindings.push({
      familyId: "MMA",
      overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS } },
      modelVersion: "beta-2",
    });
    expect(() => resolveAssumptions(set, FAMILIES)).toThrow(DuplicateOverlayError);
  });

  it("rejects out-of-domain beta params with an inspectable OverlayParamError", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-bad",
      label: "bad",
      bindings: [
        {
          familyId: "MMA",
          overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS, betaMax: 0.1, betaMin: 0.5 } },
          modelVersion: "beta-bad",
        },
      ],
    };
    expect(() => resolveAssumptions(set, FAMILIES)).toThrow(OverlayParamError);
  });

  it("rejects a constant CPR outside [0,1]", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-bad2",
      label: "bad2",
      bindings: [
        {
          familyId: "MBS",
          overlay: { kind: "prepay", model: "constant-cpr", annualCpr: 1.5 },
          modelVersion: "x",
        },
      ],
    };
    expect(() => resolveAssumptions(set, FAMILIES)).toThrow(OverlayParamError);
  });

  it("refuses a deposit-beta overlay bound to a non-interest-bearing NMD family (D5)", () => {
    // DDA has instrumentType "nmd": no deposit rate exists for a beta to drive.
    // Formerly this ran green and the overlay was silently skipped in runoff.
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-incompat-beta",
      label: "beta on non-IB",
      bindings: [
        {
          familyId: "DDA",
          overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS } },
          modelVersion: "beta-x",
        },
      ],
    };
    try {
      resolveAssumptions(set, FAMILIES);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompatibleOverlayError);
      const err = e as IncompatibleOverlayError;
      expect(err.familyId).toBe("DDA");
      expect(err.overlayKind).toBe("deposit-beta");
      expect(err.instrumentType).toBe("nmd");
      // The message names all three, plus the permitted set.
      expect(err.message).toContain("DDA");
      expect(err.message).toContain("deposit-beta");
      expect(err.message).toContain("nmd");
      expect(err.message).toContain("nmd-b");
    }
  });

  it("refuses a prepay overlay bound to a fixed-loan family (D5)", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-incompat-prepay",
      label: "prepay on fixed loan",
      bindings: [
        {
          familyId: "CD",
          overlay: { kind: "prepay", model: "four-factor-cpr", params: { ...MBS_DEFAULTS } },
          modelVersion: "cpr-x",
        },
      ],
    };
    try {
      resolveAssumptions(set, FAMILIES);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompatibleOverlayError);
      const err = e as IncompatibleOverlayError;
      expect(err.familyId).toBe("CD");
      expect(err.overlayKind).toBe("prepay");
      expect(err.instrumentType).toBe("fixed-loan");
      expect(err.message).toContain("CD");
      expect(err.message).toContain("prepay");
      expect(err.message).toContain("fixed-loan");
      expect(err.message).toContain("mortgage");
    }
  });

  it("refuses an nmd-decay overlay bound to a loan family (D5)", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-incompat-decay",
      label: "decay on loan",
      bindings: [
        {
          familyId: "CD",
          overlay: { kind: "nmd-decay", params: { ...NMD_DEFAULTS } },
          modelVersion: "decay-x",
        },
      ],
    };
    try {
      resolveAssumptions(set, FAMILIES);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompatibleOverlayError);
      const err = e as IncompatibleOverlayError;
      expect(err.familyId).toBe("CD");
      expect(err.overlayKind).toBe("nmd-decay");
      expect(err.instrumentType).toBe("fixed-loan");
      expect(err.message).toContain("CD");
      expect(err.message).toContain("nmd-decay");
      expect(err.message).toContain("fixed-loan");
    }
  });

  it("refuses a cd-rollover overlay bound to an NMD family (D5)", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-incompat-cd",
      label: "rollover on NMD",
      bindings: [
        {
          familyId: "MMA",
          overlay: { kind: "cd-rollover", renewalProbability: 0.5, offeredSpreadBp: 10, termMonths: 12 },
          modelVersion: "cd-x",
        },
      ],
    };
    expect(() => resolveAssumptions(set, FAMILIES)).toThrow(IncompatibleOverlayError);
  });

  it("permits every declared (kind, instrument type) pair in the shared table", () => {
    // The positive direction of the gate, driven off the exported table so a
    // widened entry (e.g. the wave-3 cd terms arm) is automatically covered.
    for (const [kind, types] of Object.entries(OVERLAY_INSTRUMENT_COMPATIBILITY)) {
      for (const t of types) {
        expect(() =>
          checkOverlayCompatibility("FAM", kind as keyof typeof OVERLAY_INSTRUMENT_COMPATIBILITY, t),
        ).not.toThrow();
      }
    }
  });

  it("rejects a renewal probability outside [0,1]", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "as-bad3",
      label: "bad3",
      bindings: [
        {
          familyId: "CD",
          overlay: { kind: "cd-rollover", renewalProbability: 1.4, offeredSpreadBp: 10, termMonths: 12 },
          modelVersion: "x",
        },
      ],
    };
    expect(() => resolveAssumptions(set, FAMILIES)).toThrow(OverlayParamError);
  });
});

describe("duplicate rule with selectors", () => {
  it("still refuses two unselected bindings of one kind on one family", () => {
    const set = baseAssumptions();
    set.bindings.push({ ...set.bindings[1]! });
    expect(() => resolveAssumptions(set, makeCoa().families)).toThrow(DuplicateOverlayError);
  });
  it("passes two bindings of one kind on one family when at least one carries a selector", () => {
    const set = baseAssumptions();
    set.bindings.push({ ...set.bindings[1]!, selector: { segment: "rate-shopper" } });
    expect(() => resolveAssumptions(set, makeCoa().families)).not.toThrow();
    const both = baseAssumptions();
    both.bindings[1] = { ...both.bindings[1]!, selector: { segment: "relationship" } };
    both.bindings.push({ ...both.bindings[1]!, selector: { segment: "rate-shopper" } });
    expect(() => resolveAssumptions(both, makeCoa().families)).not.toThrow();
  });
});
