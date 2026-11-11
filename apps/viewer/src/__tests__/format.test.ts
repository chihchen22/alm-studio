/**
 * Formatter unit tests.
 *
 * The workbench honesty rule is that every number on a results or compare
 * screen is a verbatim envelope field rendered through ONE tested formatter.
 * These tests pin that formatter's behavior, including the two load-bearing
 * unit conventions:
 *   - deltaEvePct is stored as a decimal FRACTION;
 *     signedPct/pct multiply by 100 for display and that multiplication is
 *     asserted here.
 *   - The one permitted client-side computation is the comparison delta
 *     deriveDelta(a, b) = b - a, labeled with the exact string
 *     "derived: B - A"; both are asserted here.
 */
import { describe, expect, it } from "vitest";
import type { RateSpec } from "@alm/engine";
import {
  driverLabel,
  familyNetAtHorizon,
  formatScenarioLabel,
  pct,
  predicateLabel,
  scenarioNetAtHorizon,
  sig,
  signClass,
  signedMM,
  signedPct,
  stat,
  usd,
  usdMM,
  years,
} from "@alm/reader";
import { DELTA_LABEL, deriveDelta } from "../components/DeltaTable";

describe("currency formatters", () => {
  it("usd renders full dollars", () => {
    expect(usd(1_234_567)).toBe("$1,234,567");
    expect(usd(0)).toBe("$0");
  });

  it("usdMM scales to millions with one decimal (display scaling, not computation)", () => {
    expect(usdMM(1_234_560_000)).toBe("$1,234.6M");
    expect(usdMM(4_500_000)).toBe("$4.5M");
    expect(usdMM(0)).toBe("$0.0M");
  });

  it("signedMM carries an explicit sign and no sign at zero", () => {
    expect(signedMM(12_300_000)).toBe("+$12.3M");
    expect(signedMM(-4_500_000)).toBe("-$4.5M");
    expect(signedMM(0)).toBe("$0.0M");
  });
});

describe("percent formatters (deltaEvePct unit pin)", () => {
  it("pct multiplies a stored decimal fraction by 100 for display", () => {
    expect(pct(0.1214)).toBe("12.14%");
    expect(pct(1)).toBe("100.00%");
    expect(pct(0)).toBe("0.00%");
  });

  it("signedPct displays deltaEvePct (a decimal fraction, the limitations page) as a percent", () => {
    // The envelope stores -0.05 to mean "down 5% of base EVE". The display
    // MUST multiply by 100; rendering "-0.05%" would be a 100x lie.
    expect(signedPct(-0.05)).toBe("-5.00%");
    expect(signedPct(0.0123)).toBe("+1.23%");
    expect(signedPct(0)).toBe("0.00%");
  });
});

describe("years and sign class", () => {
  it("years renders two decimals", () => {
    expect(years(5.43)).toBe("5.43");
    expect(years(-2.5)).toBe("-2.50");
  });

  it("signClass buckets by sign", () => {
    expect(signClass(3)).toBe("pos");
    expect(signClass(-1)).toBe("neg");
    expect(signClass(0)).toBe("zero");
  });
});

describe("scenario and driver labels", () => {
  const meta = (rateSpec: RateSpec, label = "authored") => ({ id: "S1", label, rateSpec });

  it("labels by the typed rateSpec, not the id", () => {
    expect(formatScenarioLabel(meta({ kind: "base" }), "S1")).toBe("Base");
    expect(formatScenarioLabel(meta({ kind: "parallel", shockBp: 100 }), "S1")).toBe("+100bp");
    expect(formatScenarioLabel(meta({ kind: "parallel", shockBp: -200 }), "S1")).toBe("-200bp");
    expect(formatScenarioLabel(meta({ kind: "parallel", shockBp: 0 }), "S1")).toBe("Base");
    expect(
      formatScenarioLabel(meta({ kind: "twist", shortBp: -100, longBp: 50, pivotYears: 2 }), "S1"),
    ).toBe("Twist -100/+50bp");
  });

  it("falls back to the raw id when there is no metadata", () => {
    expect(formatScenarioLabel(undefined, "S-200")).toBe("S-200");
  });

  // RE-EXPECTATION: this test formerly used { kind: "custom" } as its
  // "unknown kind" sample. W3-A6 made "custom" a TYPED RateSpec arm, so the
  // label now derives from the shock vector like every other kind; the
  // unknown-kind fallback is re-pinned with a kind that really is outside the
  // union. Old expectation: authored label. New: the typed custom label.
  it("labels a custom vector by its knots (small) or knot count (large)", () => {
    const small: RateSpec = {
      kind: "custom",
      shocks: [
        { tenorYears: 0, shockBp: -150 },
        { tenorYears: 5, shockBp: 0 },
        { tenorYears: 30, shockBp: 200 },
      ],
    };
    expect(formatScenarioLabel(meta(small), "S1")).toBe("Custom 0y-150 / 5y0 / 30y+200bp");
    const large: RateSpec = {
      kind: "custom",
      shocks: [1, 2, 3, 5, 7, 10].map((t) => ({ tenorYears: t, shockBp: 10 })),
    };
    expect(formatScenarioLabel(meta(large), "S1")).toBe("Custom (6 knots)");
  });

  it("falls back to the authored label for an unknown rateSpec kind", () => {
    const unknownSpec = { kind: "ramp" } as unknown as RateSpec;
    expect(formatScenarioLabel(meta(unknownSpec, "Ramped shock"), "S1")).toBe("Ramped shock");
  });

  it("driverLabel maps known drivers and echoes unknown ids verbatim", () => {
    expect(driverLabel("deposit-beta")).toBe("Deposit beta");
    expect(driverLabel("some-new-driver")).toBe("some-new-driver");
  });
});

describe("sig and stat (W3-P7 diagnostic and distribution formatters)", () => {
  it("sig preserves leading digits at any magnitude and never renders nonzero as 0", () => {
    expect(sig(5.4237104)).toBe("5.42371");
    expect(sig(2.5)).toBe("2.5");
    expect(sig(-3.203e-4)).toBe("-0.0003203");
    expect(sig(1.44e-11)).toBe("1.44e-11");
    expect(sig(0)).toBe("0");
    expect(sig(7.77594321, 5)).toBe("7.7759");
  });

  it("stat renders dollar-scale statistics with cents and small values by significance", () => {
    expect(stat(123300764.36163631)).toBe("123,300,764.36");
    expect(stat(88814.41)).toBe("88,814.41");
    expect(stat(-4500)).toBe("-4,500.00");
    // A tiny nonzero SE must never display as "0.00"; a fixed-decimal format
    // would lie about a point mass that is not one.
    expect(stat(0.0034)).toBe("0.0034");
    // Exactly zero (a degenerate zero-vol point mass) is honestly "0".
    expect(stat(0)).toBe("0");
  });

  it("pct at 4 digits carries FTP-rate resolution (decimal fraction x100)", () => {
    expect(pct(0.039984, 4)).toBe("3.9984%");
    expect(pct(-0.002898, 4)).toBe("-0.2898%");
  });
});

describe("horizon net lookups (W3-A7 byHorizon surfaces; verbatim reads, never 0 for absent)", () => {
  const fam = {
    familyId: "f1",
    interestIncome12: 10,
    interestExpense12: 4,
    net12: 6,
    interestIncome24: 20,
    interestExpense24: 8,
    net24: 12,
    byHorizon: { 12: { interestIncome: 10, interestExpense: 4, net: 6 }, 36: { interestIncome: 30, interestExpense: 12, net: 18 } },
  };
  const scen = {
    scenarioId: "S0",
    byFamily: [fam],
    totalNet12: 6,
    totalNet24: 12,
    totalNetByHorizon: { 12: 6, 24: 12, 36: 18 },
  };
  // Minimal envelope-shaped objects; the helpers are lookups over these exact
  // contract fields (typed via the engine contract in src/format.ts).

  it("12 and 24 months read the pinned fields", () => {
    expect(scenarioNetAtHorizon(scen as never, 12)).toBe(6);
    expect(scenarioNetAtHorizon(scen as never, 24)).toBe(12);
    expect(familyNetAtHorizon(fam as never, 12)).toBe(6);
    expect(familyNetAtHorizon(fam as never, 24)).toBe(12);
  });

  it("other horizons read the byHorizon block verbatim", () => {
    expect(scenarioNetAtHorizon(scen as never, 36)).toBe(18);
    expect(familyNetAtHorizon(fam as never, 36)).toBe(18);
  });

  it("an absent horizon (pre-1.2.0 envelope) is undefined, never zero", () => {
    const old = { scenarioId: "S0", byFamily: [], totalNet12: 6, totalNet24: 12 };
    expect(scenarioNetAtHorizon(old as never, 36)).toBeUndefined();
    const oldFam = { ...fam, byHorizon: undefined };
    expect(familyNetAtHorizon(oldFam as never, 36)).toBeUndefined();
  });
});

describe("comparison delta (the one permitted client-side computation)", () => {
  it("is labeled with the exact honesty-contract string", () => {
    expect(DELTA_LABEL).toBe("derived: B - A");
  });

  it("computes exactly B - A", () => {
    expect(deriveDelta(2, 5)).toBe(3);
    expect(deriveDelta(5, 2)).toBe(-3);
    // Floating point verbatim: the derived value is the raw difference, never
    // rounded before display.
    expect(deriveDelta(0.1, 0.3)).toBe(0.3 - 0.1);
  });

  it("is undefined, never zero, when either original is absent or non-finite", () => {
    expect(deriveDelta(undefined, 5)).toBeUndefined();
    expect(deriveDelta(5, undefined)).toBeUndefined();
    expect(deriveDelta(undefined, undefined)).toBeUndefined();
    expect(deriveDelta(Number.NaN, 5)).toBeUndefined();
    expect(deriveDelta(5, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("predicateLabel", () => {
  it("renders a scalar and a one-element list identically", () => {
    expect(predicateLabel({ segment: "relationship" })).toBe("segment=relationship");
    expect(predicateLabel({ segment: ["relationship"] })).toBe("segment=relationship");
  });

  it("sorts keys, sorts and de-duplicates values", () => {
    expect(predicateLabel({ vintage: ["2021", "2019", "2021"], segment: ["relationship", "rate-shopper"] })).toBe(
      "segment=rate-shopper|relationship; vintage=2019|2021",
    );
  });

  it("renders an empty predicate as the empty string", () => {
    expect(predicateLabel({})).toBe("");
  });
});
