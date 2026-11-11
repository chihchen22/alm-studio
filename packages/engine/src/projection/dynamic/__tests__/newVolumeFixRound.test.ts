/**
 * Studio slice S2b-1 fix round (review M3 and L7), worked by hand.
 *
 * The expected values are computed here from the definitions: discount factors P(t) = exp(-z(t) t) with z linear
 * between the curve's nodes (flat outside), the term liquidity premium linear between its nodes, the level payment
 * from the annuity formula, and the par-match formula r = (N - sum D(t_i) P_i) / (sum D(t_i) B_{i-1} / 12) written out
 * in this file. Nothing is read back from the tranche builder or the FTP block they check.
 *
 *  M3: a fixed template's coupon is its own matched funding rate plus the spread, so a 0 bp product earns a 0 FTP
 *      margin (|m| < 0.01 bp) and a +50 bp product earns +50 bp: a 360-month level-pay and a 60-month bullet, minted
 *      at k > 0.
 *  L7: a floater's FTP refix and a level-pay tranche's FTP accrual, minted at k > 0, checked month by month.
 */
import { describe, expect, it } from "vitest";
import { buildTLPCurve, DeterministicRatePath, rehydrateCurve } from "@alm/kernel";
import type { ProductFamilyDef } from "../../../contracts/chartOfAccounts";
import type { PortfolioSpec } from "../../../contracts/position";
import type { NewBusinessTemplate } from "../../../contracts/scenario";
import { computeFtpResult } from "../../../ftp";
import { templateTranche } from "../templateTranche";
import { AS_OF, makeCoa } from "../../../portfolio/__tests__/fixtures";

// The curve: 3% to half a year, 3.5% at 2y, 4.5% at 10y, 5% at 30y, continuously compounded. TLP: 0 at 0, 25 bp at
// one year, 45 bp at five, 100 bp at 30.
const ZT = [0.5, 2, 10, 30];
const ZZ = [0.03, 0.035, 0.045, 0.05];
const LT = [0, 1, 5, 30];
const LS = [0, 0.0025, 0.0045, 0.01];
const lerp = (xs: number[], ys: number[], x: number): number => {
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
  for (let i = 0; i < xs.length - 1; i++) if (x <= xs[i + 1]!) return ys[i]! + ((ys[i + 1]! - ys[i]!) * (x - xs[i]!)) / (xs[i + 1]! - xs[i]!);
  return ys[ys.length - 1]!;
};
const P = (t: number): number => Math.exp(-lerp(ZT, ZZ, t) * t);
const tlpAt = (t: number): number => lerp(LT, LS, t);

const curve = rehydrateCurve({ t: ZT, z: ZZ });
const tlp = buildTLPCurve(LT.map((tYears, i) => ({ tYears, spread: LS[i]! })));
const path = new DeterministicRatePath(curve, 720);
const FAM: ProductFamilyDef = { id: "LOANS", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "fixed-loans" };
const coa = { ...makeCoa(), families: [FAM] };
const book: PortfolioSpec = { id: "PF-FR", label: "Empty book", asOf: AS_OF, coa, positions: [] };

/** The all-in discount factor a tranche minted at k sees for its month m: P(t0 + m/12) / P(t0) exp(-tlp(m/12) m/12). */
const dAll = (k: number, m: number): number => (P((k + m) / 12) / P(k / 12)) * Math.exp(-tlpAt(m / 12) * (m / 12));

/** The par-match formula on a schedule of { m, balance, principal } rows. */
function par(k: number, rows: Array<{ m: number; balance: number; principal: number }>, N: number): number {
  let pv = 0;
  let ann = 0;
  for (const r of rows) {
    pv += dAll(k, r.m) * r.principal;
    ann += (dAll(k, r.m) * r.balance) / 12;
  }
  return (N - pv) / ann;
}

/** A level-pay schedule written out: payment N i (1 + i)^n / ((1 + i)^n - 1), i = c / 12. */
function levelPay(N: number, n: number, c: number): Array<{ m: number; balance: number; principal: number }> {
  const i = c / 12;
  const pay = (N * i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
  const out: Array<{ m: number; balance: number; principal: number }> = [];
  let b = N;
  for (let m = 1; m <= n; m++) {
    const principal = m === n ? b : pay - b * i;
    out.push({ m, balance: b, principal });
    b -= principal;
  }
  return out;
}
const bullet = (N: number, n: number) => Array.from({ length: n }, (_, j) => ({ m: j + 1, balance: N, principal: j + 1 === n ? N : 0 }));

/** The FTP block of one tranche priced through the run's FTP code. */
function ftpOf(k: number, notional: number, term: number, spreadBp: number, template: NewBusinessTemplate) {
  const t = templateTranche(FAM, k, notional, term, spreadBp, template, path, tlp);
  const ftp = computeFtpResult({
    portfolio: book,
    scenarios: [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "dynamic", rules: [] } }],
    baseScenarioId: "S0",
    curve,
    tlp,
    path,
    horizonMonths: 720,
    niiBase: { scenarioId: "S0", totalNet12: 0 },
    newVolume: [{ familyId: "LOANS", bucket: k, notional, instrument: t.instrument, path: t.path }],
  });
  return { coupon: t.instrument.generateCashflows(t.path)[0]!.couponRate, nv: ftp.byFamily[0]!.newVolume!, cf: t.instrument.generateCashflows(t.path) };
}

const LEVEL360: NewBusinessTemplate = { rateType: "fixed", amortization: "level-pay", indexTenorMonths: 360, fixedIndex: "matched" };
const BULLET60: NewBusinessTemplate = { rateType: "fixed", amortization: "bullet", indexTenorMonths: 60 };
const BP = 1e-4;

describe("M3: a fixed template is priced at its matched funding rate", () => {
  it("a 360-month level-pay at 0 bp minted at k = 24: coupon = the hand fixed point, FTP margin under 0.01 bp", () => {
    // By hand: r = par(level-pay schedule at coupon r), iterated from 5% until it stops moving.
    let r = 0.05;
    for (let i = 0; i < 100; i++) r = par(24, levelPay(1000, 360, r), 1000);
    const { coupon, nv } = ftpOf(24, 1000, 360, 0, LEVEL360);
    expect(coupon).toBeCloseTo(r, 12);
    expect(Math.abs(nv.ftpMarginRate)).toBeLessThan(0.01 * BP);
    expect(nv.allInFtpRate).toBeCloseTo(r, 12);
    if (process.env.PRINT_M3 === "1") console.log(`M3 level360 0bp: coupon ${coupon} margin ${nv.ftpMarginRate / BP} bp`);
  });

  it("a 60-month bullet at 0 bp minted at k = 6 (no fixedIndex: matched is the default): coupon = (1 - D(60)) / sum D(i) / 12", () => {
    const r = par(6, bullet(1000, 60), 1000);
    const { coupon, nv } = ftpOf(6, 1000, 60, 0, BULLET60);
    expect(coupon).toBeCloseTo(r, 12);
    expect(Math.abs(nv.ftpMarginRate)).toBeLessThan(0.01 * BP);
    if (process.env.PRINT_M3 === "1") console.log(`M3 bullet60 0bp: coupon ${coupon} margin ${nv.ftpMarginRate / BP} bp`);
  });

  it("+50 bp earns +50 bp on both", () => {
    let r = 0.05;
    for (let i = 0; i < 100; i++) r = par(24, levelPay(1000, 360, r + 0.005), 1000);
    const lp = ftpOf(24, 1000, 360, 50, LEVEL360);
    expect(lp.coupon).toBeCloseTo(r + 0.005, 12);
    expect(Math.abs(lp.nv.ftpMarginRate - 50 * BP)).toBeLessThan(0.01 * BP);
    const bu = ftpOf(6, 1000, 60, 50, BULLET60);
    expect(bu.coupon).toBeCloseTo(par(6, bullet(1000, 60), 1000) + 0.005, 12);
    expect(Math.abs(bu.nv.ftpMarginRate - 50 * BP)).toBeLessThan(0.01 * BP);
    if (process.env.PRINT_M3 === "1") console.log(`M3 +50bp: level360 ${lp.nv.ftpMarginRate / BP} bp, bullet60 ${bu.nv.ftpMarginRate / BP} bp`);
  });

  it("a swap-priced fixed product is still offered, and its margin is the gap between the swap and the matched rate", () => {
    const { coupon, nv } = ftpOf(24, 1000, 360, 0, { ...LEVEL360, fixedIndex: "swap" });
    let r = 0.05;
    for (let i = 0; i < 100; i++) r = par(24, levelPay(1000, 360, coupon), 1000);
    expect(nv.ftpMarginRate).toBeCloseTo(coupon - r, 12);
    expect(Math.abs(nv.ftpMarginRate)).toBeGreaterThan(1 * BP);
  });
});

describe("L7: FTP of new tranches minted at k > 0, month by month", () => {
  it("a three-month floater minted at k = 12 refixes on the forward from its own months plus the 3-month premium", () => {
    const k = 12;
    const { nv, cf } = ftpOf(k, 1000, 24, 100, { rateType: "floating", amortization: "level-pay", indexTenorMonths: 3 });
    // Reset at months 1, 4, 7, ...: forward over [(k + m - 1)/12, +3/12] = (P(a) / P(b) - 1) / (b - a), plus tlp(3/12).
    const fwd = (m: number): number => {
      const a = (k + m - 1) / 12;
      const b = a + 3 / 12;
      return (P(a) / P(b) - 1) / (b - a) + tlpAt(3 / 12);
    };
    for (const [m, resetAt] of [[1, 1], [3, 1], [4, 4], [6, 4], [13, 13]] as const) {
      expect(nv.monthly.ftpAccrual[k + m - 1]).toBeCloseTo((fwd(resetAt) * cf[m - 1]!.balance) / 12, 9);
    }
    expect(nv.monthly.ftpAccrual[k - 1]).toBe(0);
  });

  it("a level-pay tranche minted at k = 24 accrues its locked all-in rate on its own balance, from bucket k", () => {
    const k = 24;
    let r = 0.05;
    for (let i = 0; i < 100; i++) r = par(k, levelPay(1000, 360, r), 1000);
    const sched = levelPay(1000, 360, r);
    const { nv } = ftpOf(k, 1000, 360, 0, LEVEL360);
    for (const m of [1, 2, 120, 360]) expect(nv.monthly.ftpAccrual[k + m - 1]).toBeCloseTo((r * sched[m - 1]!.balance) / 12, 8);
    expect(nv.monthly.ftpAccrual[k - 1]).toBe(0);
  });
});
