/**
 * Duration sanity gate. The acceptance rule: a sign flip is rejected and the
 * scenario's durationSanityPassed goes false; a rejected duration is dropped, not
 * patched.
 */
import { describe, expect, it } from "vitest";
import {
  applyDurationGate,
  checkDurationSanity,
  DEFAULT_DURATION_BOUNDS,
} from "../sanityGate";

describe("checkDurationSanity", () => {
  it("passes a plausible positive duration", () => {
    expect(checkDurationSanity(3.4, "positive").passed).toBe(true);
    expect(checkDurationSanity(0, "positive").passed).toBe(true); // a par floater ≈ 0
  });

  it("rejects a sign flip under the positive-sign gate", () => {
    const g = checkDurationSanity(-2.1, "positive");
    expect(g.passed).toBe(false);
    expect(g.reason).toMatch(/negative|sign flip/i);
  });

  it("allows a negative value under the any-sign gate (equity)", () => {
    expect(checkDurationSanity(-2.1, "any").passed).toBe(true);
  });

  it("rejects a non-finite duration under either sign gate", () => {
    expect(checkDurationSanity(NaN, "any").passed).toBe(false);
    expect(checkDurationSanity(Infinity, "positive").passed).toBe(false);
  });

  it("rejects an implausible magnitude (blow-up) under either sign gate", () => {
    expect(checkDurationSanity(500, "any").passed).toBe(false);
    expect(checkDurationSanity(-500, "positive").passed).toBe(false);
  });

  it("tolerates tiny negative numeric noise on the positive gate", () => {
    expect(checkDurationSanity(-1e-6, "positive").passed).toBe(true);
  });
});

describe("applyDurationGate", () => {
  const families = [
    { familyId: "FIXED", effectiveDuration: 3.9 },
    { familyId: "DDA", effectiveDuration: 2.8 },
  ];

  it("passes a healthy set and keeps every duration", () => {
    const g = applyDurationGate(families, 5.2);
    expect(g.durationSanityPassed).toBe(true);
    expect(g.familyDurations.get("FIXED")).toBeCloseTo(3.9);
    expect(g.familyDurations.get("DDA")).toBeCloseTo(2.8);
    expect(g.effectiveDurationEquity).toBeCloseTo(5.2);
  });

  it("drops a sign-flipped family and fails the scenario", () => {
    const bad = [
      { familyId: "FIXED", effectiveDuration: 3.9 },
      { familyId: "DDA", effectiveDuration: -1.5 },
    ];
    const g = applyDurationGate(bad, 5.2);
    expect(g.durationSanityPassed).toBe(false);
    expect(g.familyDurations.get("FIXED")).toBeCloseTo(3.9); // healthy one survives
    expect(g.familyDurations.get("DDA")).toBeUndefined(); // rejected, not patched
    expect(g.effectiveDurationEquity).toBeCloseTo(5.2); // equity itself still fine
  });

  it("drops a non-finite equity duration and fails the scenario", () => {
    const g = applyDurationGate(families, NaN);
    expect(g.durationSanityPassed).toBe(false);
    expect(g.effectiveDurationEquity).toBeUndefined();
    // families are individually fine
    expect(g.familyDurations.get("FIXED")).toBeCloseTo(3.9);
  });

  it("honors tightened bounds (magnitude cap)", () => {
    const g = applyDurationGate(families, 5.2, "positive", {
      ...DEFAULT_DURATION_BOUNDS,
      maxAbsYears: 3.0,
    });
    // FIXED (3.9) and equity (5.2) exceed the 3.0 cap; DDA (2.8) survives.
    expect(g.familyDurations.get("FIXED")).toBeUndefined();
    expect(g.familyDurations.get("DDA")).toBeCloseTo(2.8);
    expect(g.effectiveDurationEquity).toBeUndefined();
    expect(g.durationSanityPassed).toBe(false);
  });

  it("defaults the family sign gate to positive (base-environment policy)", () => {
    // No explicit gate argument: the base-environment default rejects a family
    // sign flip, exactly as before this policy split.
    const bad = [
      { familyId: "FIXED", effectiveDuration: 3.9 },
      { familyId: "MORTGAGE", effectiveDuration: -2.0 },
    ];
    const g = applyDurationGate(bad, 5.2);
    expect(g.durationSanityPassed).toBe(false);
    expect(g.familyDurations.get("MORTGAGE")).toBeUndefined();
  });
});

describe("applyDurationGate — gate policy 1a", () => {
  // A behavioral family reports a genuinely negative effective duration at a
  // shocked environment (mortgage down-bump into the refi wave, MMA up-bump into
  // the beta S-curve). The base-environment sign gate would flag it; the
  // shocked-environment policy must let it through as real optionality.
  const shockedFamilies = [
    { familyId: "FIXED", effectiveDuration: 2.3 },
    { familyId: "MORTGAGE", effectiveDuration: -0.71 }, // genuine negative convexity
  ];

  it("a shocked-environment negative family duration passes under the any-sign gate", () => {
    const g = applyDurationGate(shockedFamilies, -3.42, "any");
    expect(g.durationSanityPassed).toBe(true);
    expect(g.familyDurations.get("MORTGAGE")).toBeCloseTo(-0.71);
    expect(g.familyDurations.get("FIXED")).toBeCloseTo(2.3);
    // Equity is any-sign everywhere: a negative equity duration is fine.
    expect(g.effectiveDurationEquity).toBeCloseTo(-3.42);
  });

  it("the same negative family duration still fails under the base-environment positive gate", () => {
    const g = applyDurationGate(shockedFamilies, -3.42, "positive");
    expect(g.durationSanityPassed).toBe(false);
    expect(g.familyDurations.get("MORTGAGE")).toBeUndefined();
    expect(g.familyDurations.get("FIXED")).toBeCloseTo(2.3);
  });

  it("the shocked-environment gate still rejects a non-finite or blown-up family duration", () => {
    const g = applyDurationGate(
      [
        { familyId: "FIXED", effectiveDuration: 2.3 },
        { familyId: "MORTGAGE", effectiveDuration: Number.NEGATIVE_INFINITY },
      ],
      -3.42,
      "any",
    );
    expect(g.durationSanityPassed).toBe(false);
    expect(g.familyDurations.get("MORTGAGE")).toBeUndefined();
  });
});
