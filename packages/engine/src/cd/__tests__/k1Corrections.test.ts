/**
 * The CD corrections, each pinned against an expectation derived here by hand, never read from the
 * adapter under test.
 *
 *  - K1 point 1, rate shocks: under the corrections the first month's early withdrawal of a one-cohort book on a
 *    shocked flat curve equals the H7 hazard written out below at the shocked rate; under the original convention the
 *    shocked and base streams are identical.
 *  - K1 point 2, the run's market: on an unshocked flat curve the corrected walk's moneyness reads that curve plus the
 *    run's funding spread; the original convention reads the kernel's own grid, so it does not match.
 *  - K1 point 3, the minimum live balance: a cohort that starts at $500 of walk balance runs to maturity under the
 *    corrections (the stream pays out the whole notional, by conservation) and vanishes under the original convention.
 *
 * The cohort books are hand-set round values.
 */
import { describe, expect, it } from "vitest";
import { CD_DEFAULT_PARAMS, type RatePath, type TLPCurve } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import { modelCorrectionsOf } from "../../corrections";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { CdAdapterError, type CdCohortSpec, type CdTerms } from "../terms";
import { markCdBook } from "../corrections";

/** A flat continuously compounded curve at `z` as a monthly path: the one-month accrual rate is (e^{z dt} - 1) / dt. */
function flatPath(z: number, nSteps = 360): RatePath {
  const dt = 1 / 12;
  const r = (Math.exp(z * dt) - 1) / dt;
  return {
    nSteps,
    times: Array.from({ length: nSteps + 1 }, (_, k) => k * dt),
    rateAt: () => r,
    forwardRateAt: () => r,
  };
}

/** A flat funding spread. */
function flatTlp(s: number): TLPCurve {
  return { t: [0, 30], spread: [s, s], tlp: () => s };
}

function terms(cohorts: readonly CdCohortSpec[], notional = 50_000_000): CdTerms {
  let mat = 0;
  for (const c of cohorts) mat = Math.max(mat, c.monthsToMaturity);
  return { id: "cd-k1", type: "cd", notional, maturityMonths: mat, originationOffsetMonths: 0, amortType: "bullet", side: "liability", cohorts };
}

function bookOf(t: CdTerms): PortfolioSpec {
  return {
    id: "k1-cd-book",
    label: "K1 CD test book",
    asOf: "2026-03-31",
    coa: { families: [{ id: "cds", label: "CDs", side: "liability" }] },
    positions: [{ id: t.id, familyId: "cds", terms: t }],
  } as unknown as PortfolioSpec;
}

function marked(t: CdTerms, convention: "book" | "corrected-v1", tlp = 0.005): CdTerms {
  return markCdBook(bookOf(t), modelCorrectionsOf(convention), flatTlp(tlp)).positions[0]!.terms as CdTerms;
}

const expit = (x: number, clip: number) => 1 / (1 + Math.exp(-Math.min(clip, Math.max(-clip, x))));

/**
 * The first month's early withdrawal, in output dollars, of a ONE-cohort book whose cohort is not at maturity, written
 * out from the H7 hazard and the two-part severity (kernel header, equations 1, 3 and 4). With one live cohort the
 * live log-balance covariate is 0 (its standard deviation falls back to 1 and the cohort sits on the mean).
 */
function handMonthOneWithdrawal(c: CdCohortSpec, notional: number, marketRate: number): number {
  const p = CD_DEFAULT_PARAMS;
  const hz = p.hazard;
  const m = marketRate - c.contractRate;
  const walkBalance = c.balance * p.walkScale;
  const zTtm = (Math.log(c.monthsToMaturity) - hz.lnTtmMean) / hz.lnTtmStd;
  const zBal = (Math.log(walkBalance) - hz.lnBalMean) / hz.lnBalStd;
  const h = expit(hz.intercept + hz.b1Moneyness * m + hz.bLogTtmStd * zTtm + hz.bLogBalStd * zBal, hz.logitClip);
  const tb = c.termMonths === 18 || c.termMonths === 24 ? p.severityPart1.tbMedium : p.severityPart1.tbShort;
  const pf = expit(tb + p.severityPart1.moneyness * m, hz.logitClip);
  const pi = h * (pf + (1 - pf) * p.eSevPartial);
  return pi * notional; // one cohort: the output scale is notional / balance, times the withdrawn balance pi * balance
}

const ONE: CdCohortSpec = { termMonths: 12, monthsToMaturity: 9, balance: 100, contractRate: 0.04 };

describe("K1 point 1: the CD book reacts to rate shocks", () => {
  it("corrected: month 1 withdrawal on a +200bp curve is the hazard at the shocked rate, and differs from base", () => {
    const t = marked(terms([ONE]), "corrected-v1");
    const up = makeInstrument(t).generateCashflows(flatPath(0.06));
    const base = makeInstrument(t).generateCashflows(flatPath(0.04));
    expect(up[0]!.principalPaid).toBeCloseTo(handMonthOneWithdrawal(ONE, 50_000_000, 0.06 + 0.005), 6);
    expect(base[0]!.principalPaid).toBeCloseTo(handMonthOneWithdrawal(ONE, 50_000_000, 0.04 + 0.005), 6);
    // Higher market rate, more money in the withdrawal put: more early withdrawal.
    expect(up[0]!.principalPaid).toBeGreaterThan(base[0]!.principalPaid * 1.5);
  });

  it("original convention: the shocked and the base stream are the same, bit for bit", () => {
    const t = marked(terms([ONE]), "book");
    expect(t.walk).toBeUndefined();
    const up = makeInstrument(t).generateCashflows(flatPath(0.06));
    const base = makeInstrument(t).generateCashflows(flatPath(0.04));
    expect(up).toEqual(base);
  });

  it("corrected: a twist reaches the walk through the path, tenor by tenor", () => {
    // A path whose one-month accrual rate rises with time: the zero rate at 9 months is the average of the first nine.
    const dt = 1 / 12;
    const path: RatePath = { nSteps: 360, times: Array.from({ length: 361 }, (_, k) => k * dt), rateAt: (j) => 0.03 + 0.001 * j, forwardRateAt: () => 0 };
    let s = 0;
    for (let j = 0; j < 9; j++) s += Math.log1p((0.03 + 0.001 * j) * dt);
    const z9 = s / (9 / 12);
    const got = makeInstrument(marked(terms([ONE]), "corrected-v1")).generateCashflows(path);
    expect(got[0]!.principalPaid).toBeCloseTo(handMonthOneWithdrawal(ONE, 50_000_000, z9 + 0.005), 6);
  });

  it("corrected: a path shorter than the book's longest remaining term is refused in words (fix round L4)", () => {
    const t = marked(terms([ONE]), "corrected-v1");
    expect(() => makeInstrument(t).generateCashflows(flatPath(0.04, 6))).toThrow(CdAdapterError);
    expect(() => makeInstrument(t).generateCashflows(flatPath(0.04, 6))).toThrow(/lengthen the run's grid to at least 9 months/);
  });
});

describe("K1 point 2: the CD walk reads the run's market", () => {
  it("corrected reads the run's curve and funding spread; the original convention reads the kernel grid instead", () => {
    // A market far from the kernel's 2026-03-31 grid: a flat 1 percent curve and a 50bp funding spread.
    const want = handMonthOneWithdrawal(ONE, 50_000_000, 0.01 + 0.005);
    const corrected = makeInstrument(marked(terms([ONE]), "corrected-v1")).generateCashflows(flatPath(0.01));
    const book = makeInstrument(marked(terms([ONE]), "book")).generateCashflows(flatPath(0.01));
    expect(corrected[0]!.principalPaid).toBeCloseTo(want, 6);
    expect(Math.abs(book[0]!.principalPaid - want)).toBeGreaterThan(want * 0.5);
  });

  it("the mark carries the run's funding spread month by month, 60 months", () => {
    const tlp: TLPCurve = { t: [0, 30], spread: [0, 0.03], tlp: (x) => 0.001 * x };
    const t = markCdBook(bookOf(terms([ONE])), modelCorrectionsOf("corrected-v1"), tlp).positions[0]!.terms as CdTerms;
    expect(t.walk?.tlpSpreadByMonth?.length).toBe(60);
    expect(t.walk?.tlpSpreadByMonth?.[11]).toBeCloseTo(0.001, 15);
    expect(t.walk?.tlpSpreadByMonth?.[59]).toBeCloseTo(0.005, 15);
  });
});

describe("K1 point 3: the CD minimum live balance is the documented $1", () => {
  // A big cohort plus one that starts at $500 of walk balance (0.001 units at the $500,000 walk scale).
  const BIG: CdCohortSpec = { termMonths: 12, monthsToMaturity: 6, balance: 100, contractRate: 0.04 };
  const TINY: CdCohortSpec = { termMonths: 12, monthsToMaturity: 6, balance: 0.001, contractRate: 0.04 };
  const notional = 50_000_000;
  const paid = (cfs: ReturnType<ReturnType<typeof makeInstrument>["generateCashflows"]>) => cfs.reduce((s, c) => s + c.principalPaid, 0);

  it("the vendored walk scale puts the small cohort at $500 of walk balance, between the two thresholds", () => {
    expect(TINY.balance * CD_DEFAULT_PARAMS.walkScale).toBe(500);
    expect(CD_DEFAULT_PARAMS.minLiveBalance).toBe(1000);
  });

  it("corrected: the small cohort runs to maturity, so the stream pays out the whole notional", () => {
    const cfs = makeInstrument(marked(terms([BIG, TINY], notional), "corrected-v1")).generateCashflows(flatPath(0.04));
    expect(Math.abs(paid(cfs) - notional)).toBeLessThan(1e-6);
  });

  it("original convention: the small cohort vanishes after month 1, and its balance is never paid", () => {
    const cfs = makeInstrument(marked(terms([BIG, TINY], notional), "book")).generateCashflows(flatPath(0.04));
    const tinyDollars = (notional * TINY.balance) / (BIG.balance + TINY.balance);
    expect(notional - paid(cfs)).toBeGreaterThan(tinyDollars * 0.9);
  });
});
