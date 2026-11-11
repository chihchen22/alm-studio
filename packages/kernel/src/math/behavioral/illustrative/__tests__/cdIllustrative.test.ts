/**
 * Pins every CD illustrative value to spec v2 Section 3.3 (slider table and
 * the non-slider structure list) and Section 2.3 (the three branch choices).
 * A failure here means a value moved; the fix is a new spec version, not an
 * edit to the test.
 */
import { describe, expect, it } from "vitest";
import { LAB_CURVE_PUBLIC } from "../../defaults/labCurvePublic";
import {
  CD_BOOK_ILLUSTRATIVE,
  CD_BOOK_SHARES,
  CD_BOOK_TERMS,
  CD_COHORT_COUNT,
  CD_COHORT_FRACTIONS,
  CD_CURVE_DATE,
  CD_ILLUSTRATIVE_PARAMS as P,
  CD_ILLUSTRATIVE_SPEC,
  CD_NOTIONAL_USD,
  CD_OFFER_SPREAD_BY_TERM,
  CD_OFFER_SPREAD_LONG,
  CD_OFFER_SPREAD_SHORT,
  CD_STATIC_RHO,
  CD_WALK_SCALE,
  cdParAllInRate,
} from "../cdIllustrative";

const expit = (x: number) => 1 / (1 + Math.exp(-x));

describe("CD illustrative parameters (spec v2, Section 3.3)", () => {
  it("names the spec version of record", () => {
    expect(CD_ILLUSTRATIVE_SPEC).toBe("illustrative-deposit-parameterization v3 (2026-09-08)");
  });

  it("pins the hazard coefficients", () => {
    expect(P.hazard.intercept).toBe(-5.5);
    expect(P.hazard.b1Moneyness).toBe(40);
    expect(P.hazard.bLogTtmStd).toBe(0.4);
    expect(P.hazard.bLogBalStd).toBe(0.2);
  });

  it("reproduces the Section 3.3 hazard anchor readings", () => {
    // At the money: 0.4 percent monthly, about 5 percent annual.
    const atm = expit(P.hazard.intercept);
    expect(atm).toBeCloseTo(0.004, 3);
    expect(1 - (1 - atm) ** 12).toBeCloseTo(0.05, 2);
    // At +200 bp: about 0.9 percent monthly, about 10 percent annual.
    const up200 = expit(P.hazard.intercept + P.hazard.b1Moneyness * 0.02);
    expect(up200).toBeCloseTo(0.009, 3);
    expect(1 - (1 - up200) ** 12).toBeCloseTo(0.1, 2);
    // At -200 bp: about 2 percent annual.
    const dn200 = expit(P.hazard.intercept - P.hazard.b1Moneyness * 0.02);
    expect(1 - (1 - dn200) ** 12).toBeCloseTo(0.02, 2);
  });

  it("pins the persisted standardisation constants", () => {
    expect(P.hazard.lnTtmMean).toBe(2.2);
    expect(P.hazard.lnTtmStd).toBe(0.9);
    expect(P.hazard.lnBalMean).toBe(15);
    expect(P.hazard.lnBalStd).toBe(1);
  });

  it("pins the fitted moneyness domain and the logit clip", () => {
    expect(P.hazard.fittedMoneynessDomainLo).toBe(-0.03);
    expect(P.hazard.fittedMoneynessDomainHi).toBe(0.03);
    expect(P.hazard.logitClip).toBe(15);
  });

  it("pins the renewal coefficients and their base renewal readings", () => {
    expect(P.renewal.segShort).toBe(1.4);
    expect(P.renewal.segMedium).toBe(1.1);
    expect(P.renewal.segLong).toBe(0.85);
    expect(P.renewal.gammaMoneyness).toBe(-15);
    expect(P.renewal.delta24m).toBe(-0.2);
    expect(expit(P.renewal.segShort)).toBeCloseTo(0.8, 2);
    expect(expit(P.renewal.segMedium)).toBeCloseTo(0.75, 2);
    expect(expit(P.renewal.segLong)).toBeCloseTo(0.7, 2);
    // The 24-month renewal must read below the 18-month one.
    const m24 = expit(P.renewal.segMedium + P.renewal.delta24m);
    expect(m24).toBeCloseTo(0.71, 2);
    expect(m24).toBeLessThan(expit(P.renewal.segMedium));
    // A +200 bp offer-over-expiring gap moves SHORT renewal from 80 to 75.
    expect(expit(P.renewal.segShort + P.renewal.gammaMoneyness * 0.02)).toBeCloseTo(0.75, 2);
  });

  it("pins the severity coefficients", () => {
    expect(P.severityPart1.tbShort).toBe(0.85);
    expect(P.severityPart1.tbMedium).toBe(0.6);
    expect(P.severityPart1.moneyness).toBe(10);
    expect(P.severityPart1.logBalanceStd).toBe(-0.3);
    expect(P.eSevPartial).toBe(0.4);
    // 70 and 65 percent of withdrawal events are full closures.
    expect(expit(P.severityPart1.tbShort)).toBeCloseTo(0.7, 2);
    expect(expit(P.severityPart1.tbMedium)).toBeCloseTo(0.65, 2);
  });

  it("pins the static renewal comparator and the notional", () => {
    expect(CD_STATIC_RHO).toBe(0.75);
    expect(CD_NOTIONAL_USD).toBe(50_000_000);
    expect(CD_WALK_SCALE).toBe(500_000);
  });

  it("pins the offer spreads by term", () => {
    expect(CD_OFFER_SPREAD_SHORT).toBe(-0.0025);
    expect(CD_OFFER_SPREAD_LONG).toBe(-0.005);
    for (const t of [1, 2, 3, 6, 9, 12]) expect(CD_OFFER_SPREAD_BY_TERM[t]).toBe(-0.0025);
    for (const t of [18, 24, 36, 48, 60]) expect(CD_OFFER_SPREAD_BY_TERM[t]).toBe(-0.005);
  });

  it("pins the walk conventions", () => {
    expect(P.horizonMonths).toBe(120);
    expect(P.maxRenewalGenerations).toBe(3);
    expect(P.minLiveBalance).toBe(1000);
    expect(P.walkScale).toBe(CD_WALK_SCALE);
  });

  it("prices on the public Lab discount grid", () => {
    expect(P.curve.t).toBe(LAB_CURVE_PUBLIC.t);
    expect(P.curve.z).toBe(LAB_CURVE_PUBLIC.z);
    expect(P.curve.tlpSpread).toBe(LAB_CURVE_PUBLIC.tlpSpread);
  });

  it("builds the cohort book by the Section 3.3 rule", () => {
    expect([...CD_BOOK_TERMS]).toEqual([6, 12, 18, 24, 36, 60]);
    expect([...CD_BOOK_SHARES]).toEqual([0.15, 0.4, 0.1, 0.15, 0.1, 0.1]);
    expect([...CD_COHORT_FRACTIONS]).toEqual([0.25, 0.5, 0.75]);
    expect(CD_BOOK_SHARES.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
    // Eighteen cohorts, per-100 units summing to 100.
    expect(CD_BOOK_ILLUSTRATIVE).toHaveLength(18);
    expect(CD_COHORT_COUNT).toBe(18);
    expect(CD_CURVE_DATE).toBe("2026-03-31");
    expect(CD_BOOK_ILLUSTRATIVE.reduce((s, r) => s + r.balance, 0)).toBeCloseTo(100, 10);
    // Walk dollars equal notional dollars.
    expect(
      CD_BOOK_ILLUSTRATIVE.reduce((s, r) => s + r.balance, 0) * P.walkScale,
    ).toBeCloseTo(CD_NOTIONAL_USD, 6);
  });

  it("starts the base book at the money", () => {
    for (const row of CD_BOOK_ILLUSTRATIVE) {
      const par = cdParAllInRate(row.termMonths / 12) + CD_OFFER_SPREAD_BY_TERM[row.termMonths];
      expect(row.contractRate).toBeCloseTo(par, 12);
    }
  });

  it("splits each term at a quarter, a half and three quarters remaining", () => {
    const byTerm = new Map<number, number[]>();
    for (const row of CD_BOOK_ILLUSTRATIVE) {
      byTerm.set(row.termMonths, [...(byTerm.get(row.termMonths) ?? []), row.monthsToMaturity]);
    }
    expect(byTerm.get(6)).toEqual([2, 3, 5]);
    expect(byTerm.get(12)).toEqual([3, 6, 9]);
    expect(byTerm.get(18)).toEqual([5, 9, 14]);
    expect(byTerm.get(24)).toEqual([6, 12, 18]);
    expect(byTerm.get(36)).toEqual([9, 18, 27]);
    expect(byTerm.get(60)).toEqual([15, 30, 45]);
  });
});
