/**
 * EVE carries swaps on the risk-free curve.
 *
 * Every expected value is RESTATED from discount factors (swap/__tests__/fixtures.ts):
 * a pay-fixed swap's risk-free value is N(1 - DF(M)) - N(c/12) sum DF(m/12), because
 * the monthly floating leg plus its notional telescopes to N. The all-in value
 * of the same legs differs by the term liquidity premium, so a fold that
 * discounts a swap on the book's basis fails here by that amount.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, DEFAULT_TLP_CURVE, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import type { RunResult } from "../../contracts/run";
import { loadMarket, regulatoryScenarios, twoSidedBook } from "../../run/__tests__/fixtures";
import { buildBaseCurve, shockedCurve } from "../../scenario/rateEnvironment";
import {
  engineParRate,
  floatForward,
  hedgedBook,
  N_SWAP,
  payerPvRiskFree,
  runBook,
  swapPosition,
  SWAP_FAMILY_ID,
} from "../../swap/__tests__/fixtures";
import { computeEnvironmentDurations } from "../effectiveDuration";

let market: MarketSnapshot;
let base: ZeroCurve;
let rate: number;
let unhedged: RunResult;
let hedged: RunResult;

beforeAll(async () => {
  market = await loadMarket();
  base = buildBaseCurve(market);
  rate = engineParRate(base, 60);
  unhedged = runBook(market, twoSidedBook("PF-EVE-0"));
  hedged = runBook(
    market,
    hedgedBook("PF-EVE-1", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60, fixedRate: rate })]),
  );
}, 180_000);

const byId = (r: RunResult, id: string) => r.eve.byScenario.find((s) => s.scenarioId === id)!;

describe("EVE with a pay-fixed swap", () => {
  it("leaves pvAssets and pvLiabilities bit-identical in every scenario", () => {
    for (const a of unhedged.eve.byScenario) {
      const b = byId(hedged, a.scenarioId);
      expect(b.pvAssets, a.scenarioId).toBe(a.pvAssets);
      expect(b.pvLiabilities, a.scenarioId).toBe(a.pvLiabilities);
    }
  });

  it("is exactly the unhedged EVE plus pvDerivatives", () => {
    for (const a of unhedged.eve.byScenario) {
      const b = byId(hedged, a.scenarioId);
      expect(b.eve, a.scenarioId).toBe(a.eve + b.pvDerivatives!);
    }
  });

  it("values the swap on the risk-free curve in every scenario, whatever the book's basis", () => {
    expect(hedged.eve.discountBasis).toBe("all-in");
    for (const sc of regulatoryScenarios()) {
      const expected = payerPvRiskFree(shockedCurve(base, sc.rateSpec), N_SWAP, rate, 60);
      const got = byId(hedged, sc.id).pvDerivatives!;
      expect(Math.abs(got - expected), `${sc.id}: pvDerivatives=${got} restated risk-free=${expected}`).toBeLessThanOrEqual(
        1e-9 * N_SWAP,
      );
    }
  });

  it("carries the swap family row with its risk-free pv and no effective duration", () => {
    for (const s of hedged.eve.byScenario) {
      const row = s.byFamily.find((f) => f.familyId === SWAP_FAMILY_ID)!;
      expect(row.pv, s.scenarioId).toBe(s.pvDerivatives);
      expect("effectiveDuration" in row, s.scenarioId).toBe(false);
    }
  });

  it("leaves the key out of a book with no derivative family", () => {
    for (const s of unhedged.eve.byScenario) expect("pvDerivatives" in s, s.scenarioId).toBe(false);
  });

  it("shortens equity duration at base, and the gate still passes", () => {
    const a = byId(unhedged, "S0");
    const b = byId(hedged, "S0");
    expect(b.durationSanityPassed).toBe(a.durationSanityPassed);
    expect(b.effectiveDurationEquity, `hedged ${b.effectiveDurationEquity} unhedged ${a.effectiveDurationEquity}`).toBeLessThan(
      a.effectiveDurationEquity!,
    );
  });
});

describe("the duration engine prices a swap family on the risk-free curve", () => {
  it("reports pvDerivatives equal to the restated risk-free value, and no family row", () => {
    const book = hedgedBook("PF-DUR", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60, fixedRate: 0.03 })]);
    const swapFamily = book.coa.families.find((f) => f.id === SWAP_FAMILY_ID)!;
    const tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
    const out = computeEnvironmentDurations(
      [{ family: swapFamily, positions: book.positions.filter((p) => p.familyId === SWAP_FAMILY_ID) }],
      base,
      tlp,
      360,
      100,
      "all-in",
    );
    const expected = payerPvRiskFree(base, N_SWAP, 0.03, 60);
    expect(Math.abs(out.pvDerivatives - expected), `pvDerivatives=${out.pvDerivatives} restated=${expected}`).toBeLessThanOrEqual(
      1e-9 * N_SWAP,
    );
    expect(out.perFamily).toEqual([]);
    expect(out.pvAssets).toBe(0);
    expect(out.eve).toBe(out.pvDerivatives);
  });

  it("shocks the swap legs on the risk-free curve: equity duration equals the restated risk-free finite difference", () => {
    // The engine's convention, restated exactly: bump +/-shockBp (100 here); the shocked legs are
    // discounted on shockCurve(base, +/-shockBp), which is shockedCurve with a parallel spec, while
    // the floating leg fixes off ParallelShockPath, the BASE 1M forward plus the bump. So the
    // shocked floating coupon is floatForward(base, m) + bump, not the shocked curve's own forward,
    // and the shocked value does not telescope; payerPvRiskFree on the shocked curve alone misses by
    // about 0.5 of duration (-161.53 against the engine's -161.04), so the legs are written out.
    const shockBp = 100;
    const c = 0.03;
    const M = 60;
    const book = hedgedBook("PF-DUR-SH", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: M, fixedRate: c })]);
    const swapFamily = book.coa.families.find((f) => f.id === SWAP_FAMILY_ID)!;
    const tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
    const out = computeEnvironmentDurations(
      [{ family: swapFamily, positions: book.positions.filter((p) => p.familyId === SWAP_FAMILY_ID) }],
      base,
      tlp,
      360,
      shockBp,
      "all-in",
    );
    const shockedPayer = (bp: number): number => {
      const riskFree = shockedCurve(base, { kind: "parallel", shockBp: bp });
      let pv = 0;
      for (let m = 1; m <= M; m++) {
        const floatCoupon = (floatForward(base, m) + bp / 1e4) / 12;
        pv += N_SWAP * (floatCoupon - c / 12) * riskFree.discountFactor(m / 12);
      }
      return pv; // the two bullet principals cancel at M
    };
    const pv0 = payerPvRiskFree(base, N_SWAP, c, M);
    const expected = (shockedPayer(-shockBp) - shockedPayer(+shockBp)) / (2 * pv0 * (shockBp / 1e4));
    const got = out.effectiveDurationEquity;
    expect(
      Math.abs(got - expected),
      `effectiveDurationEquity=${got} restated risk-free=${expected}`,
    ).toBeLessThanOrEqual(1e-9 * Math.abs(expected));
  });
});
