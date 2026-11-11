import { describe, expect, it } from "vitest";
import { LEGACY_TEST_TLP_CURVE } from "../../rates/__tests__/legacyTlpFixture";
import { computeNmdFtp, newMoneyFtpYields, type NmdFtpInputs } from "../ftpNmd";
import type { CurveQuote } from "../../rates/marketData";

/**
 * Hand-pinned fixture. LEGACY_TEST_TLP_CURVE node values at the pillar tenors:
 *   tlp(0.25) = 0.0019, tlp(1) = 0.0031, tlp(2) = 0.0043,
 *   tlp(5)    = 0.0056, tlp(10) = 0.0091
 * Equal 20% weights → stableRpTlp = 0.0048, stableRpYield = 0.034.
 */
const BASE: NmdFtpInputs = {
  pillars: [3, 12, 24, 60, 120],
  weights: [0.2, 0.2, 0.2, 0.2, 0.2],
  pillarYields: [0.03, 0.032, 0.034, 0.036, 0.038],
  nonStableYield: 0.029,
  overnightYield: 0.028,
  clientRate: 0,
  tlp: LEGACY_TEST_TLP_CURVE,
  assumptions: { stableShare: 0.8, lcrRunoff: 0.2, bufferTarget: 1.2, carryBp: 15 },
};

describe("computeNmdFtp — worked examples from the spec", () => {
  it("Non-IB defaults (80/20 split, 20% runoff): stress exactly consumes non-stable", () => {
    const r = computeNmdFtp(BASE);
    expect(r.slices.stressed).toBeCloseTo(0.2, 12);
    expect(r.slices.nonStableSurviving).toBeCloseTo(0, 12);
    expect(r.slices.stableAfterStress).toBeCloseTo(0.8, 12);
    expect(r.stableRpYield).toBeCloseTo(0.034, 12);
    expect(r.stableRpTlp).toBeCloseTo(0.0048, 12);
    // IR leg: stable 0.8·0.034 + non-stable 0 + stress 0.2·0.028(O/N) = 0.0328
    expect(r.irCredit).toBeCloseTo(0.0328, 12);
    // TLP leg: 0.8·0.0048 (stable only — non-stable fully stressed, stress O/N has no TLP)
    expect(r.tlpCredit).toBeCloseTo(0.00384, 12);
    // Buffer: 1.2 × 20% × 15bp = 3.6bp
    expect(r.bufferCharge).toBeCloseTo(0.00036, 12);
    expect(r.allInCredit).toBeCloseTo(0.03628, 12);
    expect(r.ftpMargin).toBeCloseTo(0.03628, 12);
  });

  it("10% runoff: surviving non-stable earns TLP(3M), stable untouched", () => {
    const r = computeNmdFtp({
      ...BASE,
      assumptions: { ...BASE.assumptions, lcrRunoff: 0.1 },
    });
    expect(r.slices.stressed).toBeCloseTo(0.1, 12);
    expect(r.slices.nonStableSurviving).toBeCloseTo(0.1, 12);
    expect(r.slices.stableAfterStress).toBeCloseTo(0.8, 12);
    // 0.1·tlp(3M) + 0.8·stableRpTlp = 0.1·0.0019 + 0.8·0.0048
    expect(r.tlpCredit).toBeCloseTo(0.00403, 12);
    expect(r.bufferCharge).toBeCloseTo(0.00018, 12);
    // IR: 0.8·0.034 + 0.1·0.029 + 0.1·0.028(O/N) = 0.0329; all-in = 0.0329 + 0.00403 − 0.00018
    expect(r.irCredit).toBeCloseTo(0.0329, 12);
    expect(r.allInCredit).toBeCloseTo(0.03675, 12);
  });

  it("IB defaults (40% runoff > 20% non-stable): stress bites 20% into stable on the TLP leg", () => {
    const r = computeNmdFtp({
      ...BASE,
      clientRate: 0.02,
      assumptions: { ...BASE.assumptions, lcrRunoff: 0.4 },
    });
    expect(r.slices.stressed).toBeCloseTo(0.4, 12);
    expect(r.slices.nonStableSurviving).toBeCloseTo(0, 12);
    expect(r.slices.stableAfterStress).toBeCloseTo(0.6, 12);
    expect(r.tlpCredit).toBeCloseTo(0.6 * 0.0048, 12);
    // Buffer: 1.2 × 40% × 15bp = 7.2bp
    expect(r.bufferCharge).toBeCloseTo(0.00072, 12);
    // IR: 0.6·0.034 + 0 + 0.4·0.028(O/N) = 0.0316; all-in = 0.0316 + 0.00288 − 0.00072
    expect(r.irCredit).toBeCloseTo(0.0316, 12);
    expect(r.allInCredit).toBeCloseTo(0.03376, 12);
    expect(r.ftpMargin).toBeCloseTo(0.01376, 12);
  });

  it("stress column earns the overnight rate, no TLP, and bears the buffer charge", () => {
    const r = computeNmdFtp({ ...BASE, assumptions: { ...BASE.assumptions, lcrRunoff: 0.2 } });
    expect(r.matrix.stress.ir).toBeCloseTo(0.2 * 0.028, 12);
    expect(r.matrix.stress.tlp).toBeCloseTo(0, 12);
    expect(r.matrix.stress.buffer).toBeCloseTo(-r.bufferCharge, 12);
    expect(r.matrix.stable.buffer).toBeCloseTo(0, 12);
    expect(r.matrix.nonStable.buffer).toBeCloseTo(0, 12);
    // Row totals reconcile with the column matrix.
    expect(r.matrix.stable.ir + r.matrix.nonStable.ir + r.matrix.stress.ir).toBeCloseTo(r.irCredit, 12);
    expect(
      r.matrix.stable.allIn + r.matrix.nonStable.allIn + r.matrix.stress.allIn,
    ).toBeCloseTo(r.allInCredit, 12);
  });

  it("100% runoff: TLP leg fully stressed to zero, buffer at full drag", () => {
    const r = computeNmdFtp({
      ...BASE,
      assumptions: { ...BASE.assumptions, lcrRunoff: 1.0 },
    });
    expect(r.slices.stableAfterStress).toBeCloseTo(0, 12);
    expect(r.slices.nonStableSurviving).toBeCloseTo(0, 12);
    expect(r.tlpCredit).toBeCloseTo(0, 12);
    expect(r.bufferCharge).toBeCloseTo(0.0018, 12);
    // Whole book is stressed → IR is the overnight rate; all-in = 0.028 − buffer.
    expect(r.irCredit).toBeCloseTo(0.028, 12);
    expect(r.allInCredit).toBeCloseTo(0.028 - 0.0018, 12);
  });

  it("slices always partition the book: stressed + surviving + stable = 1", () => {
    for (const ws of [0.6, 0.8, 0.9]) {
      for (const s of [0, 0.05, 0.2, 0.4, 0.7, 1.0]) {
        const r = computeNmdFtp({
          ...BASE,
          assumptions: { ...BASE.assumptions, stableShare: ws, lcrRunoff: s },
        });
        const total =
          r.slices.stressed + r.slices.nonStableSurviving + r.slices.stableAfterStress;
        expect(total).toBeCloseTo(1, 12);
      }
    }
  });

  it("validation: rejects out-of-range runoff, bad weights, non-finite yields", () => {
    expect(() =>
      computeNmdFtp({ ...BASE, assumptions: { ...BASE.assumptions, lcrRunoff: 1.2 } }),
    ).toThrow(/lcrRunoff/);
    expect(() =>
      computeNmdFtp({ ...BASE, weights: [0.2, 0.2, 0.2, 0.2, 0.1] }),
    ).toThrow(/weights sum/);
    expect(() =>
      computeNmdFtp({ ...BASE, pillarYields: [0.03, NaN, 0.034, 0.036, 0.038] }),
    ).toThrow(/not finite/);
    expect(() =>
      computeNmdFtp({ ...BASE, assumptions: { ...BASE.assumptions, stableShare: -0.1 } }),
    ).toThrow(/stableShare/);
  });
});

/**
 * New-money (marginal) FTP yields: each pillar priced at today's curve par rate
 * via newMoneyYield, plus the non-stable (3M) and overnight (1D cash) legs. This
 * is the asset-side input that the marginal block feeds to computeNmdFtp, in
 * contrast to the stock block's trailing-MA pillarTrailingYields.
 */
describe("newMoneyFtpYields: marginal curve pricing", () => {
  // Exact-node curve so interpolation is predictable: 1D cash, then SOFR-OIS
  // swap nodes at 0.25 / 1 / 2 / 5 / 10 years.
  const QUOTES: CurveQuote[] = [
    { term: "1D", tYears: 1 / 365, instrumentType: "CASH", rate: 0.03 },
    { term: "3M", tYears: 0.25, instrumentType: "CASH", rate: 0.032 },
    { term: "1Y", tYears: 1, instrumentType: "SWAP", rate: 0.034 },
    { term: "2Y", tYears: 2, instrumentType: "SWAP", rate: 0.036 },
    { term: "5Y", tYears: 5, instrumentType: "SWAP", rate: 0.04 },
    { term: "10Y", tYears: 10, instrumentType: "SWAP", rate: 0.044 },
  ];

  it("prices each pillar at its curve node, non-stable at 3M, overnight at 1D cash", () => {
    const r = newMoneyFtpYields([3, 12, 24, 60, 120], QUOTES);
    expect(r.pillarYields).toEqual([0.032, 0.034, 0.036, 0.04, 0.044].map((v) => expect.closeTo(v, 12)));
    expect(r.nonStableYield).toBeCloseTo(0.032, 12); // 3M node
    expect(r.overnightYield).toBeCloseTo(0.03, 12); // 1D cash (k <= 1 clause)
  });

  it("interpolates linearly between curve nodes for off-node pillars", () => {
    // 36M = 3y, between the 2y (0.036) and 5y (0.040) nodes: w = (3-2)/(5-2).
    const r = newMoneyFtpYields([36], QUOTES);
    expect(r.pillarYields[0]).toBeCloseTo(0.036 + (1 / 3) * (0.04 - 0.036), 12);
  });

  it("feeds computeNmdFtp without throwing (marginal decomposition is finite)", () => {
    const y = newMoneyFtpYields([3, 12, 24, 60, 120], QUOTES);
    const r = computeNmdFtp({
      pillars: [3, 12, 24, 60, 120],
      weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      pillarYields: y.pillarYields,
      nonStableYield: y.nonStableYield,
      overnightYield: y.overnightYield,
      clientRate: 0,
      tlp: LEGACY_TEST_TLP_CURVE,
      assumptions: { stableShare: 0.8, lcrRunoff: 0.2, bufferTarget: 1.2, carryBp: 15 },
    });
    expect(Number.isFinite(r.allInCredit)).toBe(true);
  });
});
