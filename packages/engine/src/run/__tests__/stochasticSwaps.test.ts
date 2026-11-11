// packages/engine/src/run/__tests__/stochasticSwaps.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { RunRequest } from "../../contracts/run";
import { clearPortfolios } from "../../portfolio/registry";
import { buildBaseCurve } from "../../scenario";
import {
  engineParRate,
  hedgedBook,
  N_SWAP,
  payerPvRiskFree,
  swapPosition,
  SWAP_FAMILY_ID,
} from "../../swap/__tests__/fixtures";
import { createEngine } from "../index";
import { runStochastic } from "../stochastic";
import { loadMarket, makeRunRequest, regulatoryScenarios, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function req(portfolioId: string): RunRequest {
  return makeRunRequest(market, { portfolioId, scenarios: regulatoryScenarios().slice(0, 1) });
}

describe("stochastic EVE carries swaps on the risk-free curve", () => {
  it("at zero volatility, the hedged mean exceeds the unhedged mean by the deterministic pvDerivatives", () => {
    const curve = buildBaseCurve(market);
    const rate = engineParRate(curve, 60) + 0.004;
    const book0 = twoSidedBook("PF-STO-0");
    const book1 = hedgedBook("PF-STO-1", [swapPosition("SW1", SWAP_FAMILY_ID, { fixedRate: rate })]);
    const zeroVol = { nPaths: 20, modelParams: { a: 0.05, sigma: 0, reason: "zero-vol swap anchor" } };
    const s0 = runStochastic(req(book0.id), book0, zeroVol);
    const s1 = runStochastic(req(book1.id), book1, zeroVol);
    clearPortfolios();
    const engine = createEngine();
    engine.loadPortfolio(book1);
    const det = engine.run(req(book1.id)).eve.byScenario[0]!.pvDerivatives!;
    const diff = s1.eveDistribution.mean - s0.eveDistribution.mean;
    expect(Math.abs(diff - det), `stochastic swap value ${diff} deterministic ${det}`).toBeLessThanOrEqual(1e-6 * N_SWAP);
    // Ruling P13: the expected value is also restated from the base
    // curve's discount factors alone, never borrowed from a fold. A zero-vol
    // path reduces to the base curve.
    const restated = payerPvRiskFree(curve, N_SWAP, rate, 60);
    expect(Math.abs(diff - restated), `stochastic swap value ${diff} restated risk-free ${restated}`).toBeLessThanOrEqual(
      1e-6 * N_SWAP,
    );
  });

  it("an offset pair in two families leaves both distributions bit-identical", () => {
    const fams = ["SWAPS-PAY", "SWAPS-REC"];
    const book0 = twoSidedBook("PF-STO-2");
    const book1 = hedgedBook(
      "PF-STO-3",
      [
        swapPosition("SWP", "SWAPS-PAY", { direction: "pay-fixed", fixedRate: 0.045 }),
        swapPosition("SWR", "SWAPS-REC", { direction: "receive-fixed", fixedRate: 0.045 }),
      ],
      fams,
    );
    const vol = { nPaths: 20, modelParams: { a: 0.05, sigma: 0.01, reason: "offset anchor" } };
    const s0 = runStochastic(req(book0.id), book0, vol);
    const s1 = runStochastic(req(book1.id), book1, vol);
    expect(s1.eveDistribution, `eve mean ${s1.eveDistribution.mean} vs ${s0.eveDistribution.mean}`).toEqual(
      s0.eveDistribution,
    );
    expect(s1.nii12mDistribution, `nii mean ${s1.nii12mDistribution.mean} vs ${s0.nii12mDistribution.mean}`).toEqual(
      s0.nii12mDistribution,
    );
  });
});
