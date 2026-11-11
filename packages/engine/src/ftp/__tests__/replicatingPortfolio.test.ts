/**
 * The replicating-portfolio credit on hand cases. A flat curve at 4% continuous and a flat
 * premium of 30 bp give closed forms: a k-month bullet's par rate under monthly accrual is (1 - D_k) / (sum D_m / 12),
 * D_m = exp(-0.04 m / 12), and its premium is the same with 4.30%. The life-target weights are worked by hand from the
 * pillar lives (k + 1) / 2: a 24-month life sits between 36 months (18.5) and 60 months (30.5), 13/24 on the first.
 */
import { describe, expect, it } from "vitest";
import type { MarketSnapshot, TLPCurve, ZeroCurve } from "@alm/kernel";
import { replicatingPortfolioIssues } from "../../contracts/paramSchema";
import { ReplicatingPortfolioCredit, RpPricer, bulletCashflows, lifeTargetBlend, steepenedSnapshot } from "../replicatingPortfolio";

const flatCurve = (r: number): ZeroCurve =>
  ({
    t: [0, 30],
    z: [r, r],
    convention: "annual_act360",
    zeroRate: () => r,
    discountFactor: (t: number) => Math.exp(-r * t),
    forwardRate: () => r,
    forwardRateBey: () => r,
    forwardSwapRate: () => r,
  }) as unknown as ZeroCurve;
const flatTlp = (s: number): TLPCurve => ({ t: [0, 30], spread: [s, s], tlp: () => s });

/** The closed-form monthly-pay par rate of a k-month bullet on a flat continuous curve. */
function handBullet(r: number, k: number): number {
  let annuity = 0;
  for (let m = 1; m <= k; m++) annuity += Math.exp((-r * m) / 12) / 12;
  return (1 - Math.exp((-r * k) / 12)) / annuity;
}

const GRID = [1, 3, 6, 12, 24, 36, 60, 84, 120];
const deposit = { positionId: "dep", notional: 100e6, beta: 0.5, runoffMonths: 24 };

describe("the pricer", () => {
  it("prices a bullet at its par rate and its premium as the all-in less the benchmark", () => {
    const p = new RpPricer(flatCurve(0.04), flatTlp(0.003));
    for (const k of [1, 24, 60]) {
      expect(p.bulletRate(k)).toBeCloseTo(handBullet(0.04, k), 14);
      expect(p.bulletPremium(k)).toBeCloseTo(handBullet(0.043, k) - handBullet(0.04, k), 14);
    }
  });

  it("gives a fractional bullet a final stub whose accrual weight is the stub", () => {
    const cfs = bulletCashflows(1, 12.5);
    expect(cfs.length).toBe(13);
    expect(cfs[11]).toEqual({ monthOffset: 12, balance: 1, principalPaid: 0 });
    expect(cfs[12]).toEqual({ monthOffset: 12.5, balance: 0.5, principalPaid: 1 });
    expect(bulletCashflows(1, 24).at(-1)).toEqual({ monthOffset: 24, balance: 1, principalPaid: 1 });
  });
});

describe("the life-target blend", () => {
  it("lays the share on the pillar whose life is the deposit's, or blends the two that bracket it", () => {
    expect(lifeTargetBlend(GRID, 12.5)).toEqual([{ months: 24, weight: 1 }]);
    const mma = lifeTargetBlend(GRID, 24);
    expect(mma.map((b) => b.months)).toEqual([36, 60]);
    expect(mma[0]!.weight).toBeCloseTo(13 / 24, 15);
    expect(mma[0]!.weight * 18.5 + mma[1]!.weight * 30.5).toBeCloseTo(24, 12);
    expect(lifeTargetBlend(GRID, 36).map((b) => b.months)).toEqual([60, 84]);
    expect(() => lifeTargetBlend([24, 36], 6)).toThrow(/no two pillars of \[24, 36\] months bracket a life of 6 months/);
  });
});

describe("the credit", () => {
  const curve = flatCurve(0.04);
  const tlp = flatTlp(0.003);

  it("RP-A on a $100M, beta 0.50, 24-month straight-line deposit: half overnight, half on the 24-month pillar, the premium at 12.5 months", () => {
    const r = new ReplicatingPortfolioCredit(deposit, { construction: "life-target", pillarGridMonths: GRID }).readout(curve, tlp);
    const p = new RpPricer(curve, tlp);
    expect(r.lifeMonths).toBe(12.5);
    expect(r.tranches.map((t) => [t.kind, t.months, t.weight])).toEqual([["overnight", 1, 0.5], ["pillar", 24, 0.5]]);
    expect(r.rateCredit).toBeCloseTo(0.5 * handBullet(0.04, 1) + 0.5 * handBullet(0.04, 24), 14);
    expect(r.liquidityCredit).toBe(p.bulletPremium(12.5));
    expect(r.totalCredit).toBe(r.rateCredit + r.liquidityCredit);
  });

  it("the stock schedule: the liability's rate-locked half, the pillar's stock, Treasury's net and the liquidity ladder", () => {
    const a = new ReplicatingPortfolioCredit(deposit, { construction: "life-target", pillarGridMonths: GRID }).readout(curve, tlp);
    const b = new ReplicatingPortfolioCredit(deposit, { construction: "pillar", pillarMonths: 60 }).readout(curve, tlp);
    expect(a.stock.liabilityFixedRateGap[0]).toBe(100e6);
    expect(a.stock.liabilityFixedRateGap[1]).toBeCloseTo(50e6 * (23 / 24), 6);
    expect(a.stock.net.every((v) => Math.abs(v) < 1e-6)).toBe(true);
    expect(a.stock.liquidityLadder[12]).toBeCloseTo(50e6, 6);
    expect(b.stock.portfolio.length).toBe(61);
    expect(b.stock.portfolio[24]).toBeCloseTo(30e6, 6);
    expect(b.stock.net[1]).toBeCloseTo(1.25e6, 6);
    expect(b.stock.net[24]).toBeCloseTo(30e6, 6);
  });

  it("the strip strikes the share once on the runoff; the readings sit beside the credit and do not feed it", () => {
    const s = new ReplicatingPortfolioCredit(deposit, { construction: "strip", haircutMonths: 18 }).readout(curve, tlp);
    const p = new RpPricer(curve, tlp);
    expect(s.tranches[1]).toEqual({ kind: "strip", months: 24, weight: 0.5, rate: p.runoffRate(24) });
    expect(s.readings.runoffPremium).toBe(p.runoffPremium(24));
    expect(s.readings.haircut).toEqual({ runoffMonths: 18, lifeMonths: 9.5, liquidityCredit: p.bulletPremium(9.5), totalCredit: s.rateCredit + p.bulletPremium(9.5) });
    expect(s.readings.bracketPremium).toBeCloseTo((p.bulletPremium(12) + p.bulletPremium(13)) / 2, 15);
    expect(s.liquidityCredit).toBe(p.bulletPremium(12.5));
  });

  it("a deposit with beta 0 has no overnight tranche, and the steepener is left out with its reason when no market is handed", () => {
    const r = new ReplicatingPortfolioCredit({ ...deposit, beta: 0, runoffMonths: 71 }, { construction: "life-target", pillarGridMonths: GRID, steepener: { topBp: 50, topYears: 5 } }).readout(curve, tlp);
    expect(r.tranches.map((t) => t.months)).toEqual([60, 84]);
    expect(r.steepener).toEqual({ topBp: 50, topYears: 5, refused: "the run's market snapshot was not handed to the FTP block" });
    expect(() => new ReplicatingPortfolioCredit({ ...deposit, beta: 1.2 }, { construction: "strip" })).toThrow(/beta share must be a fraction/);
  });
});

describe("the steepened snapshot", () => {
  it("shifts each par quote by 50 x (t - t1) / (5 - t1) bp below five years and 50 bp from there; the shortest is unshifted", () => {
    const snap = {
      curveQuotes: [
        { term: "1M", tYears: 1 / 12, instrumentType: "deposit", rate: 0.0374 },
        { term: "2Y", tYears: 2, instrumentType: "swap", rate: 0.0379 },
        { term: "5Y", tYears: 5, instrumentType: "swap", rate: 0.0392 },
        { term: "10Y", tYears: 10, instrumentType: "swap", rate: 0.043 },
      ],
    } as unknown as MarketSnapshot;
    const s = steepenedSnapshot(snap, 50, 5).curveQuotes.map((q) => q.rate);
    expect(s[0]).toBe(0.0374);
    expect(s[1]).toBeCloseTo(0.0379 + (0.005 * (2 - 1 / 12)) / (5 - 1 / 12), 15);
    expect(s[2]).toBeCloseTo(0.0442, 15);
    expect(s[3]).toBeCloseTo(0.048, 15);
    expect(snap.curveQuotes[2]!.rate).toBe(0.0392);
  });
});

describe("the construction's rules", () => {
  it("refuses a construction it does not know, a grid out of order, a pillar on the wrong construction and an unknown field", () => {
    expect(replicatingPortfolioIssues({ construction: "ladder" })[0]?.message).toMatch(/must be one of "life-target", "pillar", "strip"/);
    expect(replicatingPortfolioIssues({ construction: "life-target", pillarGridMonths: [24, 12] })[0]?.message).toBe("must be longer than the pillar before it");
    expect(replicatingPortfolioIssues({ construction: "strip", pillarMonths: 60 })[0]?.message).toMatch(/"pillar" construction only/);
    expect(replicatingPortfolioIssues({ construction: "pillar" })[0]?.path).toBe("replicatingPortfolio.pillarMonths");
    expect(replicatingPortfolioIssues({ construction: "strip", tranches: 3 })[0]?.path).toBe("replicatingPortfolio.tranches");
    expect(replicatingPortfolioIssues({ construction: "strip", steepener: { topBp: 50, topYears: 0 } })[0]?.path).toBe("replicatingPortfolio.steepener.topYears");
    expect(replicatingPortfolioIssues({ construction: "life-target", pillarGridMonths: GRID, haircutMonths: 18, steepener: { topBp: 50, topYears: 5 } })).toEqual([]);
  });
});
