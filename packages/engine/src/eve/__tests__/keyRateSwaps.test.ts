// packages/engine/src/eve/__tests__/keyRateSwaps.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildTLPCurve,
  buildWarmupSOFR1M,
  DEFAULT_TLP_CURVE,
  type MarketSnapshot,
  type TLPCurve,
  type ZeroCurve,
} from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import { loadMarket, regulatoryScenarios, twoSidedBook } from "../../run/__tests__/fixtures";
import { buildBaseCurve, shockedCurve } from "../../scenario/rateEnvironment";
import {
  engineParRate,
  hedgedBook,
  N_SWAP,
  payerPvRiskFree,
  runBook,
  swapPosition,
  SWAP_FAMILY_ID,
} from "../../swap/__tests__/fixtures";
import { computeEveChannels } from "../channels";
import { collectSidedPositions, computeKeyRateDurations, regeneratedEve } from "../keyRate";

let market: MarketSnapshot;
let base: ZeroCurve;
let tlp: TLPCurve;
beforeAll(async () => {
  market = await loadMarket();
  base = buildBaseCurve(market);
  tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
});

const H = 360;

/** The fixture book without the Non-IB NMD, whose regime amplifier makes key rates refuse. */
function cleanBook(id: string): PortfolioSpec {
  const b = twoSidedBook(id);
  return { ...b, positions: b.positions.filter((p) => p.id !== "D1") };
}

describe("the key-rate machinery values a swap on the risk-free curve", () => {
  it("regenerated EVE moves by exactly the swap's restated risk-free value", () => {
    const rate = engineParRate(base, 60) + 0.005;
    const book0 = cleanBook("PF-KR-0");
    const book1 = hedgedBook("PF-KR-1", [swapPosition("SW1", SWAP_FAMILY_ID, { fixedRate: rate })], [SWAP_FAMILY_ID], book0);
    const warmup = buildWarmupSOFR1M();
    const e0 = regeneratedEve(collectSidedPositions(book0), base, tlp, "all-in", H, warmup, 0);
    const e1 = regeneratedEve(collectSidedPositions(book1), base, tlp, "all-in", H, warmup, 0);
    const expected = payerPvRiskFree(base, N_SWAP, rate, 60);
    expect(Math.abs(e1 - e0 - expected), `delta=${e1 - e0} restated risk-free=${expected}`).toBeLessThanOrEqual(1e-9 * N_SWAP);
  });

  it("a pay-fixed 5y swap lowers the equity key-rate duration at the node nearest 5 years", () => {
    const book0 = cleanBook("PF-KR-2");
    const book1 = hedgedBook(
      "PF-KR-3",
      [swapPosition("SW1", SWAP_FAMILY_ID, { fixedRate: engineParRate(base, 60), notional: 1_000_000 })],
      [SWAP_FAMILY_ID],
      book0,
    );
    const krd = (b: PortfolioSpec) =>
      computeKeyRateDurations({ portfolio: b, scenarioId: "S0", curve: base, tlp, horizonMonths: H, discountBasis: "all-in" });
    const k0 = krd(book0);
    const k1 = krd(book1);
    // The key-rate nodes are the curve's quote tenors (quoteTenorsOf), as production reads them; the default curve
    // now carries 360 dense nodes, so the node is chosen by its tenor, not by an index into base.t. Deltas Step 1.
    const j = k0.nodes.reduce((best, n, i) => (Math.abs(n.tenorYears - 5) < Math.abs(k0.nodes[best]!.tenorYears - 5) ? i : best), 0);
    expect(k0.nodes[j]!.tenorYears).toBe(5);
    expect(k1.nodes[j]!.tenorYears).toBe(5);
    expect(k1.nodes[j]!.duration, `hedged ${k1.nodes[j]!.duration} unhedged ${k0.nodes[j]!.duration}`).toBeLessThan(
      k0.nodes[j]!.duration,
    );
    expect(k1.convergence.converged).toBe(true);
  });
});

describe("the channels carry a derivativesDelta", () => {
  it("equals the swap's restated risk-free change in every shocked scenario", () => {
    const rate = engineParRate(base, 60);
    const book = hedgedBook("PF-CH-1", [swapPosition("SW1", SWAP_FAMILY_ID, { fixedRate: rate })]);
    const ch = computeEveChannels({ portfolio: book, scenarios: regulatoryScenarios(), baseCurve: base, tlp, horizonMonths: H, discountBasis: "all-in" });
    const v0 = payerPvRiskFree(base, N_SWAP, rate, 60);
    for (const row of ch.byScenario) {
      const sc = regulatoryScenarios().find((s) => s.id === row.scenarioId)!;
      const expected = payerPvRiskFree(shockedCurve(base, sc.rateSpec), N_SWAP, rate, 60) - v0;
      expect(Math.abs(row.derivativesDelta! - expected), `${row.scenarioId}: ${row.derivativesDelta} vs ${expected}`).toBeLessThanOrEqual(
        1e-9 * N_SWAP,
      );
    }
  });

  it("leaves the key out of a book with no derivative family", () => {
    const ch = computeEveChannels({
      portfolio: twoSidedBook("PF-CH-0"),
      scenarios: regulatoryScenarios(),
      baseCurve: base,
      tlp,
      horizonMonths: H,
      discountBasis: "all-in",
    });
    for (const row of ch.byScenario) expect("derivativesDelta" in row, row.scenarioId).toBe(false);
  });
});

describe("the channels gate derivativesDelta by family, as EVE gates pvDerivatives", () => {
  const channelsOf = (book: PortfolioSpec) =>
    computeEveChannels({ portfolio: book, scenarios: regulatoryScenarios(), baseCurve: base, tlp, horizonMonths: H, discountBasis: "all-in" });

  it("a declared swap family with zero swaps carries both keys, derivativesDelta 0", () => {
    const book = hedgedBook("PF-CH-EMPTY", []);
    const run = runBook(market, book);
    for (const s of run.eve.byScenario) {
      expect(s.pvDerivatives, `${s.scenarioId}: pvDerivatives=${s.pvDerivatives}`).toBe(0);
    }
    for (const row of channelsOf(book).byScenario) {
      expect(row.derivativesDelta, `${row.scenarioId}: derivativesDelta=${row.derivativesDelta}`).toBe(0);
    }
  });

  it("an unhedged book (no derivative family) carries neither key", () => {
    const book = twoSidedBook("PF-CH-NONE");
    const run = runBook(market, book);
    for (const s of run.eve.byScenario) expect("pvDerivatives" in s, s.scenarioId).toBe(false);
    for (const row of channelsOf(book).byScenario) expect("derivativesDelta" in row, row.scenarioId).toBe(false);
  });
});
