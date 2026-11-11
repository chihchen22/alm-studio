/**
 * New-volume product templates, worked by hand.
 *
 * Every expected value here is computed in the test from the definition (a stub rate path whose rates are a written
 * formula, a level payment from the annuity formula, a par-matched transfer rate from discount factors written out
 * with the curve's own interpolation rule), never read back from the code under test.
 *
 *  (a) A floating tranche originated at month k reads the scenario's rate path from k: its coupon in bucket b is the
 *      path's rate at step b plus the margin, and reading from step 0 would give a different number.
 *  (b) Level-pay and linear schedules checked row by row.
 *  (c) A new tranche's transfer rate at origination checked by hand against the FTP curve as seen from its month.
 */
import { describe, expect, it } from "vitest";
import { buildTLPCurve, rehydrateCurve, DeterministicRatePath, type RatePath } from "@alm/kernel";
import type { BucketedSeries } from "../../../contracts/results";
import type { ProductFamilyDef } from "../../../contracts/chartOfAccounts";
import type { NewBusinessRule, NewBusinessTemplate } from "../../../contracts/scenario";
import type { PortfolioSpec } from "../../../contracts/position";
import { computeFtpResult } from "../../../ftp";
import { sweepFamilyReinvestment } from "../dynamicNewBusiness";
import { ForwardStartPath, forwardStartCurve } from "../forwardStart";
import { suggestedTemplate, templateTranche } from "../templateTranche";
import { newVolumeTemplateProblem } from "../../../plan/newVolumeTemplate";
import { AS_OF, makeCoa } from "../../../portfolio/__tests__/fixtures";

/** A stub path whose one-month rate rises 5 bp a month and whose term forward rises 10 bp a month. */
const r = (s: number): number => 0.02 + 0.0005 * s;
const fwd = (s: number): number => 0.04 + 0.001 * s;
function stubPath(nSteps = 400): RatePath {
  return {
    nSteps,
    times: Array.from({ length: nSteps + 1 }, (_, i) => i / 12),
    rateAt: (s) => r(s),
    forwardRateAt: (s, _tenor) => fwd(s),
  };
}

const ASSET: ProductFamilyDef = { id: "LOANS", label: "Loans", side: "asset", instrumentType: "floating-loan", coaNodeId: "loans" };
const LIAB: ProductFamilyDef = { id: "FUND", label: "Funding", side: "liability", instrumentType: "fixed-loan", coaNodeId: "fund" };

/** An opening book of 1,000 that matures in bucket 2: a flat rule replaces it with one tranche at k = 3. */
function bookMaturingAt2(horizon: number): BucketedSeries {
  const balance = new Array<number>(horizon).fill(0);
  const principal = new Array<number>(horizon).fill(0);
  balance[0] = 1000; balance[1] = 1000; balance[2] = 1000;
  principal[2] = 1000;
  return { balance, principal, interest: new Array<number>(horizon).fill(0) };
}

const rule = (template: NewBusinessTemplate | undefined, termMonths: number, spreadOverIndexBp: number): NewBusinessRule => ({
  familyId: "LOANS", reinvest: "flat", termMonths, spreadOverIndexBp, ...(template !== undefined ? { template } : {}),
});

describe("(a) the forward-start rate path: a floating tranche originated at month k", () => {
  const H = 12;
  it("a one-month floater minted at k = 3 earns the path's rate at step b in bucket b, not at step b - 3", () => {
    const swept = sweepFamilyReinvestment(bookMaturingAt2(H), rule({ rateType: "floating", amortization: "bullet", indexTenorMonths: 1 }, 12, 100), stubPath(), ASSET, H, { coupons: true, tranches: false });
    expect(Array.from(swept.originations)).toEqual([0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0]);
    // Bucket 3: 1,000 x (2% + 0.05% x 3 + 1%) / 12 = 1,000 x 3.15% / 12 = 2.625.
    expect(swept.delta.interest[3]).toBeCloseTo(2.625, 12);
    // Read from step 0 it would be 1,000 x 3.00% / 12 = 2.5: the two differ, so the test bites.
    expect(Math.abs(swept.delta.interest[3]! - 2.5)).toBeGreaterThan(0.1);
    // Every later bucket b: 1,000 x (3% + 0.05% x b) / 12. Bucket 11: 1,000 x 3.55% / 12 = 2.958333...
    expect(swept.delta.interest[11]).toBeCloseTo(2.9583333333333335, 12);
    for (let b = 3; b < H; b++) expect(swept.delta.interest[b]).toBeCloseTo((1000 * (0.03 + 0.0005 * b)) / 12, 12);
    expect(swept.couponAtOrigination![3]).toBeCloseTo(0.0315, 14);
    expect(swept.couponAtOrigination![4]).toBeNull();
  });

  it("a three-month floater resets every three months on the one-month rate compounded from its own months", () => {
    const swept = sweepFamilyReinvestment(bookMaturingAt2(H), rule({ rateType: "floating", amortization: "bullet", indexTenorMonths: 3 }, 12, 100), stubPath(), ASSET, H);
    // The three-month index at step s: 4 x [(1 + r(s)/12)(1 + r(s+1)/12)(1 + r(s+2)/12) - 1].
    const idx3 = (s: number): number => 4 * ((1 + r(s) / 12) * (1 + r(s + 1) / 12) * (1 + r(s + 2) / 12) - 1);
    // Resets at the tranche's months 1, 4, 7 (buckets 3, 6, 9), each held three months.
    for (const [from, step] of [[3, 3], [6, 6], [9, 9]] as const) {
      for (let b = from; b < from + 3; b++) expect(swept.delta.interest[b]).toBeCloseTo((1000 * (idx3(step) + 0.01)) / 12, 12);
    }
    // Read from step 0 the first reset would be idx3(0): a different coupon.
    expect(Math.abs(idx3(3) - idx3(0))).toBeGreaterThan(0.001);
  });

  it("ForwardStartPath shifts every step, and the forward-start curve is the forward discount factor", () => {
    const p = new ForwardStartPath(stubPath(24), 5);
    expect(p.rateAt(0)).toBe(r(5));
    expect(p.forwardRateAt(2, 5)).toBe(fwd(7));
    expect(p.nSteps).toBe(19);
    const c = rehydrateCurve({ t: [0.5, 2], z: [0.03, 0.05] });
    const f = forwardStartCurve(c, 1);
    // P(t) = exp(-z(t) t), z linear between 0.5y and 2y: z(1) = 0.03 + 0.02 x (0.5 / 1.5), z(1.5) = 0.03 + 0.02 x (1 / 1.5).
    const z = (t: number): number => (t <= 0.5 ? 0.03 : t >= 2 ? 0.05 : 0.03 + 0.02 * ((t - 0.5) / 1.5));
    const P = (t: number): number => Math.exp(-z(t) * t);
    expect(f.discountFactor(0.5)).toBeCloseTo(P(1.5) / P(1), 15);
  });

  it("an explicit fixed bullet template at the term's swap tenor is today's rule, number for number", () => {
    const today = sweepFamilyReinvestment(bookMaturingAt2(H), rule(undefined, 12, 25), stubPath(), LIAB, H);
    const tpl = sweepFamilyReinvestment(bookMaturingAt2(H), rule({ rateType: "fixed", amortization: "bullet", indexTenorMonths: 12, fixedIndex: "swap" }, 12, 25), stubPath(), LIAB, H);
    expect(Array.from(tpl.delta.interest)).toEqual(Array.from(today.delta.interest));
    expect(Array.from(tpl.delta.principal)).toEqual(Array.from(today.delta.principal));
    // And today's coupon is the forward at the origination step: 1,000 x (4% + 0.1% x 3 + 0.25%) / 12.
    expect(today.delta.interest[3]).toBeCloseTo((1000 * (0.043 + 0.0025)) / 12, 12);
  });
});

describe("(b) amortizing schedules by hand", () => {
  const flatFwd: RatePath = { ...stubPath(), forwardRateAt: () => 0.05 };
  it("level pay: 1,200 over three months at 6% (5% swap plus 100 bp) pays 404.00665 a month", () => {
    const t = templateTranche(ASSET, 0, 1200, 3, 100, { rateType: "fixed", amortization: "level-pay", indexTenorMonths: 3, fixedIndex: "swap" }, flatFwd);
    const cf = t.instrument.generateCashflows(t.path);
    // Payment = 1,200 x 0.005 x 1.005^3 / (1.005^3 - 1) = 404.0066500277872.
    const rows = [
      { balance: 1200, interest: 6, principal: 398.0066500277872 },
      { balance: 801.9933499722129, interest: 4.009966749861064, principal: 399.99668327792614 },
      { balance: 401.9966666942867, interest: 2.0099833334714337, principal: 401.9966666942867 },
    ];
    expect(cf).toHaveLength(3);
    rows.forEach((row, i) => {
      expect(cf[i]!.balance).toBeCloseTo(row.balance, 9);
      expect(cf[i]!.interestPaid).toBeCloseTo(row.interest, 9);
      expect(cf[i]!.principalPaid).toBeCloseTo(row.principal, 9);
      expect(cf[i]!.couponRate).toBeCloseTo(0.06, 15);
    });
  });

  it("linear: 1,200 over three months repays 400 a month, interest 6, 4 and 2", () => {
    const t = templateTranche(ASSET, 0, 1200, 3, 100, { rateType: "fixed", amortization: "linear", indexTenorMonths: 3, fixedIndex: "swap" }, flatFwd);
    const cf = t.instrument.generateCashflows(t.path);
    const want = [[1200, 400, 6], [800, 400, 4], [400, 400, 2]];
    expect(cf).toHaveLength(3);
    cf.forEach((c, i) => {
      expect(c.balance).toBeCloseTo(want[i]![0]!, 12);
      expect(c.principalPaid).toBeCloseTo(want[i]![1]!, 12);
      expect(c.interestPaid).toBeCloseTo(want[i]![2]!, 12);
    });
  });

  it("a floating linear tranche minted at k = 2 accrues on its own months' one-month rate", () => {
    const t = templateTranche(ASSET, 2, 1200, 3, 50, { rateType: "floating", amortization: "linear", indexTenorMonths: 1 }, stubPath());
    const cf = t.instrument.generateCashflows(t.path);
    // Month m reads step 2 + m - 1: rates 2.10%, 2.15%, 2.20% plus 0.50%.
    expect(cf.map((c) => c.interestPaid)).toEqual([(1200 * 0.026) / 12, (800 * 0.0265) / 12, (400 * 0.027) / 12].map((x) => expect.closeTo(x, 12)));
    expect(t.instrument.repricingSchedule()).toEqual([1, 2, 3]);
  });

  it("a level-pay tranche in the sweep lands month m in bucket k + m - 1 and the flat rule tops up what it repaid", () => {
    const H = 6;
    const book: BucketedSeries = { balance: [1200, 0, 0, 0, 0, 0], principal: [1200, 0, 0, 0, 0, 0], interest: [0, 0, 0, 0, 0, 0] };
    const swept = sweepFamilyReinvestment(book, rule({ rateType: "fixed", amortization: "level-pay", indexTenorMonths: 3, fixedIndex: "swap" }, 3, 100), flatFwd, ASSET, H);
    expect(swept.originations[1]).toBe(1200);
    expect(swept.delta.interest[1]).toBeCloseTo(6, 12);
    // Bucket 1 carries only the first tranche's month 1 (the next tranche starts at bucket 2).
    expect(swept.delta.principal[1]).toBeCloseTo(398.0066500277872, 9);
    // The book at bucket 2 is the first tranche's month-2 balance, 801.99335; the flat rule tops up the difference.
    expect(swept.originations[2]).toBeCloseTo(398.0066500277872, 9);
  });
});

describe("(c) a new tranche's transfer price at origination, by hand against the FTP curve", () => {
  // Zero curve: continuously compounded, 3% to 0.5 years, linear to 5% at 2 years, flat after. TLP flat at 40 bp.
  const curve = rehydrateCurve({ t: [0.5, 2], z: [0.03, 0.05] });
  const tlp = buildTLPCurve([{ tYears: 0, spread: 0.004 }, { tYears: 30, spread: 0.004 }]);
  const z = (t: number): number => (t <= 0.5 ? 0.03 : t >= 2 ? 0.05 : 0.03 + 0.02 * ((t - 0.5) / 1.5));
  const P = (t: number): number => Math.exp(-z(t) * t);

  const coa = { ...makeCoa(), families: [{ id: "LOANS", label: "Loans", side: "asset" as const, instrumentType: "fixed-loan" as const, coaNodeId: "fixed-loans" }] };
  const book: PortfolioSpec = { id: "PF-NV", label: "Empty book", asOf: AS_OF, coa, positions: [] };
  const path = new DeterministicRatePath(curve, 36);

  it("a 12-month fixed bullet of 1,000 minted at k = 6 is priced on P(0.5 + t) / P(0.5), locked for its life", () => {
    const k = 6;
    const tranche = templateTranche(coa.families[0]!, k, 1000, 12, 50, { rateType: "fixed", amortization: "bullet", indexTenorMonths: 12, fixedIndex: "swap" }, path);
    const ftp = computeFtpResult({
      portfolio: book,
      scenarios: [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "dynamic", rules: [] } }],
      baseScenarioId: "S0",
      curve,
      tlp,
      path,
      horizonMonths: 36,
      niiBase: { scenarioId: "S0", totalNet12: 0 },
      newVolume: [{ familyId: "LOANS", bucket: k, notional: 1000, instrument: tranche.instrument, path: tranche.path }],
    });
    // Par match of a bullet: r = (1 - D(1)) / sum_{i=1..12} D(i/12) / 12, with D the curve seen from 0.5 years.
    const t0 = k / 12;
    const D = (t: number): number => P(t0 + t) / P(t0);
    const Dall = (t: number): number => D(t) * Math.exp(-0.004 * t);
    const par = (df: (t: number) => number): number => {
      let annuity = 0;
      for (let i = 1; i <= 12; i++) annuity += df(i / 12) / 12;
      return (1 - df(1)) / annuity;
    };
    const nv = ftp.byFamily[0]!.newVolume!;
    expect(nv.trancheCount).toBe(1);
    expect(nv.irFtpRate).toBeCloseTo(par(D), 12);
    expect(nv.allInFtpRate).toBeCloseTo(par(Dall), 12);
    expect(nv.allInFtpRateAtOrigination[k]).toBeCloseTo(par(Dall), 12);
    // Priced from the cut-off instead, the rate would differ: the forward start bites.
    const Dspot = (t: number): number => P(t) * Math.exp(-0.004 * t);
    expect(Math.abs(par(Dall) - par(Dspot))).toBeGreaterThan(0.002);
    // The accrual: the locked all-in rate on 1,000 for a month, from bucket 6 to bucket 17, nothing before.
    expect(nv.monthly.ftpAccrual[5]).toBe(0);
    expect(nv.monthly.ftpAccrual[6]).toBeCloseTo((par(Dall) * 1000) / 12, 10);
    expect(nv.monthly.ftpAccrual[17]).toBeCloseTo((par(Dall) * 1000) / 12, 10);
    expect(nv.monthly.ftpAccrual[18]).toBe(0);
    // The coupon: the curve's annual-fix swap forward from 0.5 to 1.5 years, a one-period simple rate, plus 50 bp.
    const swap = (P(0.5) / P(1.5) - 1) + 0.005;
    expect(nv.couponRate).toBeCloseTo(swap, 12);
    // Nothing in the first 12 months of the new volume falls before bucket 6.
    expect(nv.ftpAccrual12).toBeCloseTo((6 * par(Dall) * 1000) / 12, 9);
  });
});

describe("the template rule and the suggestion", () => {
  it("refuses what the engine does not run, in a sentence", () => {
    expect(newVolumeTemplateProblem({ rateType: "floating", amortization: "bullet", indexTenorMonths: 2 }, 12)).toMatch(/one of 1, 3, 6, 12/);
    expect(newVolumeTemplateProblem({ rateType: "floating", amortization: "bullet", indexTenorMonths: 12 }, 6)).toMatch(/longer than its term/);
    expect(newVolumeTemplateProblem({ rateType: "fixed", amortization: "level-pay", indexTenorMonths: 120 }, 361)).toMatch(/from 1 to 360/);
    expect(newVolumeTemplateProblem({ rateType: "fixed", amortization: "linear", indexTenorMonths: 120 }, 360)).toBeNull();
  });

  it("suggests the family's own product: rate type and amortization of its largest position, notional-weighted term", () => {
    const fam = { id: "F", side: "asset" as const };
    const pos = (id: string, n: number, m: number, amortType: "bullet" | "level-pay") => ({
      id, familyId: "F", coaNodeId: "n",
      terms: { id, type: "fixed-loan" as const, notional: n, maturityMonths: m, originationOffsetMonths: 0, amortType, coupon: 0.05 },
    });
    const s = suggestedTemplate(fam, [pos("a", 100, 36, "level-pay"), pos("b", 300, 84, "level-pay")]);
    // Term: (100 x 36 + 300 x 84) / 400 = 72 months.
    expect(s).toEqual({ template: { rateType: "fixed", amortization: "level-pay", indexTenorMonths: 72, fixedIndex: "matched", behavior: "family" }, termMonths: 72, basis: expect.any(String) });
    const dep = suggestedTemplate({ id: "D", side: "liability" }, [{ id: "d", familyId: "D", coaNodeId: "n", terms: { id: "d", type: "nmd", notional: 1, maturityMonths: 360, originationOffsetMonths: 0, amortType: "level-pay", depositRate: 0, beta: 0 } as never }]);
    // A deposit family is suggested a deposit cohort of its own kind, over its positions' life.
    expect(dep).toEqual({ template: { rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family" }, termMonths: 360, basis: expect.any(String) });
  });
});

describe("ruling 46: the FTP window of N months holds the tranches made in months 1 .. N", () => {
  const curve = rehydrateCurve({ t: [0.5, 2], z: [0.03, 0.05] });
  const tlp = buildTLPCurve([{ tYears: 0, spread: 0.004 }, { tYears: 30, spread: 0.004 }]);
  const coa = { ...makeCoa(), families: [{ id: "LOANS", label: "Loans", side: "asset" as const, instrumentType: "fixed-loan" as const, coaNodeId: "fixed-loans" }] };
  const book: PortfolioSpec = { id: "PF-NV", label: "Empty book", asOf: AS_OF, coa, positions: [] };
  const path = new DeterministicRatePath(curve, 48);

  it("a window of 12 counts the tranches made at k = 11 and 12 and leaves out k = 13", () => {
    // Three 6-month fixed bullets of 100, 200 and 400 made at k = 11, 12 and 13: by hand the window holds 100 + 200.
    const made: Array<[number, number]> = [[11, 100], [12, 200], [13, 400]];
    const newVolume = made.map(([k, n]) => {
      const t = templateTranche(coa.families[0]!, k, n, 6, 25, { rateType: "fixed", amortization: "bullet", indexTenorMonths: 6, fixedIndex: "swap" }, path);
      return { familyId: "LOANS", bucket: k, notional: n, instrument: t.instrument, path: t.path };
    });
    const ftp = computeFtpResult({
      portfolio: book,
      scenarios: [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "dynamic", rules: [] } }],
      baseScenarioId: "S0", curve, tlp, path, horizonMonths: 48,
      niiBase: { scenarioId: "S0", totalNet12: 0 },
      newVolume, newVolumeWindowMonths: 12,
    });
    const nv = ftp.byFamily[0]!.newVolume!;
    expect(nv.window.months).toBe(12);
    expect(nv.window.trancheCount).toBe(2);
    expect(nv.window.notional).toBe(300);
    expect(nv.trancheCount).toBe(3);
    expect(nv.notional).toBe(700);
  });
});
