import { describe, it, expect } from "vitest";
import { composeAnswer } from "../compose";
import {
  SUPPORTED,
  SUPPORTED_NO_MATERIAL,
  NOT_SUPPORTED_RESIDUAL,
  NOT_SUPPORTED_NO_HEADLINE,
  allowedFigures,
} from "./fixtures";

/** Signed decimal tokens; label ids in the fixtures carry no digits. */
const NUMERIC = /-?\d+(?:\.\d+)?/g;

const ALL_DRIVERS = [
  "rate",
  "volume",
  "mix",
  "prepay",
  "deposit-beta",
  "decay",
  "new-business",
] as const;

describe("composeAnswer, supported", () => {
  it("narrates the movement and cites every material driver in citation order", () => {
    const out = composeAnswer(SUPPORTED);
    expect(out).toContain("parallelUp");
    expect(out).toContain("eve");
    const mtgAt = out.indexOf("Mortgages");
    const mmaAt = out.indexOf("MMA");
    expect(mtgAt).toBeGreaterThanOrEqual(0);
    // Largest-first order is preserved from the citations array.
    expect(mmaAt).toBeGreaterThan(mtgAt);
    expect(out).toContain("-120.25");
    expect(out).toContain("-30");
  });

  it("cites only drivers present in the attribution", () => {
    const out = composeAnswer(SUPPORTED);
    // The immaterial DDA / volume contribution is not among the citations.
    expect(out).not.toContain("volume");
    expect(out).not.toContain("DDA");
    // Only the cited driver name may appear.
    for (const d of ALL_DRIVERS) {
      if (d === "rate") continue;
      expect(out).not.toContain(d);
    }
  });

  it("surfaces no figure that is not an attribution field", () => {
    const out = composeAnswer(SUPPORTED);
    const allowed = allowedFigures(SUPPORTED.attribution!);
    const found = out.match(NUMERIC) ?? [];
    for (const tok of found) {
      expect(allowed.has(tok)).toBe(true);
    }
    // It does surface the headline delta and the residual, read verbatim.
    expect(found).toContain("-150.25");
    expect(found).toContain("0");
  });

  it("states no material driver when citations are empty", () => {
    const out = composeAnswer(SUPPORTED_NO_MATERIAL);
    expect(out.toLowerCase()).toContain("no single driver");
    const allowed = allowedFigures(SUPPORTED_NO_MATERIAL.attribution!);
    for (const tok of out.match(NUMERIC) ?? []) {
      expect(allowed.has(tok)).toBe(true);
    }
  });
});

describe("composeAnswer, not supported", () => {
  it("says the decomposition cannot support the question on a too-large residual", () => {
    const out = composeAnswer(NOT_SUPPORTED_RESIDUAL);
    expect(out.toLowerCase()).toContain("cannot support");
    const allowed = allowedFigures(NOT_SUPPORTED_RESIDUAL.attribution!);
    for (const tok of out.match(NUMERIC) ?? []) {
      expect(allowed.has(tok)).toBe(true);
    }
    // The residual it read verbatim is surfaced.
    expect(out).toContain("5");
  });

  it("says the decomposition cannot support the question when no headline exists", () => {
    const out = composeAnswer(NOT_SUPPORTED_NO_HEADLINE);
    expect(out.toLowerCase()).toContain("cannot support");
    // No headline, so there is no number to surface.
    expect(out.match(NUMERIC)).toBeNull();
  });

  it("cites no driver in a not-supported answer", () => {
    const out = composeAnswer(NOT_SUPPORTED_RESIDUAL);
    for (const d of ALL_DRIVERS) {
      expect(out).not.toContain(d);
    }
  });
});

describe("composeAnswer, precondition", () => {
  it("throws on a supported Explanation whose attribution is null", () => {
    expect(() =>
      composeAnswer({ supported: true, answer: "", attribution: null, citations: [] }),
    ).toThrow();
  });

  it("is a pure function of its input (repeated calls match)", () => {
    expect(composeAnswer(SUPPORTED)).toBe(composeAnswer(SUPPORTED));
  });
});
