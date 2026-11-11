import { describe, expect, it } from "vitest";
import { SwapTermsError, validateSwapTerms, type SwapTerms } from "../terms";

function base(over: Partial<SwapTerms> = {}): SwapTerms {
  return {
    id: "swap-1",
    type: "swap",
    notional: 10_000_000,
    maturityMonths: 60,
    originationOffsetMonths: 0,
    amortType: "bullet",
    direction: "pay-fixed",
    fixedRate: 0.0375,
    ...over,
  };
}

/** The refusal code as a string, so a RED run prints what the validator did instead. */
function outcomeOf(terms: SwapTerms): string {
  try {
    validateSwapTerms(terms);
    return "ACCEPTED";
  } catch (err) {
    return err instanceof SwapTermsError ? `REFUSED ${err.code}: ${err.message}` : `WRONG ERROR: ${String(err)}`;
  }
}

describe("validateSwapTerms", () => {
  it("accepts a plain pay-fixed swap", () => {
    expect(outcomeOf(base())).toBe("ACCEPTED");
  });

  it("accepts a receive-fixed swap with a margin and a quarterly reset", () => {
    expect(
      outcomeOf(base({ direction: "receive-fixed", floatMargin: 0.001, resetFrequencyMonths: 3 })),
    ).toBe("ACCEPTED");
  });

  it("accepts a negative fixed rate, because a rate below zero is a rate", () => {
    expect(outcomeOf(base({ fixedRate: -0.001 }))).toBe("ACCEPTED");
  });

  it("refuses a nonzero originationOffsetMonths", () => {
    expect(outcomeOf(base({ originationOffsetMonths: -12 }))).toMatch(/^REFUSED swap-terms-offset/);
  });

  it("refuses a non-positive notional", () => {
    expect(outcomeOf(base({ notional: 0 }))).toMatch(/^REFUSED swap-terms-notional/);
  });

  it("refuses a non-integer maturity", () => {
    expect(outcomeOf(base({ maturityMonths: 12.5 }))).toMatch(/^REFUSED swap-terms-maturity/);
  });

  it("refuses an unknown direction", () => {
    expect(outcomeOf(base({ direction: "pay-float" as SwapTerms["direction"] }))).toMatch(
      /^REFUSED swap-terms-direction/,
    );
  });

  it("refuses a non-finite fixed rate", () => {
    expect(outcomeOf(base({ fixedRate: Number.NaN }))).toMatch(/^REFUSED swap-terms-fixed-rate/);
  });

  it("refuses a non-finite margin", () => {
    expect(outcomeOf(base({ floatMargin: Number.POSITIVE_INFINITY }))).toMatch(/^REFUSED swap-terms-margin/);
  });

  it("refuses a reset cadence below one month or past maturity", () => {
    expect(outcomeOf(base({ resetFrequencyMonths: 0 }))).toMatch(/^REFUSED swap-terms-reset/);
    expect(outcomeOf(base({ resetFrequencyMonths: 61 }))).toMatch(/^REFUSED swap-terms-reset/);
  });

  it("refuses an amortizing swap, which this piece does not model", () => {
    expect(outcomeOf(base({ amortType: "level-pay" as "bullet" }))).toMatch(/^REFUSED swap-terms-amort/);
  });

  it("refuses terms that carry a side, because a swap's side comes from its derivative family", () => {
    expect(outcomeOf(base({ side: "asset" }))).toMatch(/^REFUSED swap-terms-side/);
    expect(outcomeOf(base({ side: "liability" }))).toMatch(/^REFUSED swap-terms-side/);
  });
});
