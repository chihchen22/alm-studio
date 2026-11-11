// packages/engine/src/nii/__tests__/niiSwaps.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, DEFAULT_TLP_CURVE, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { computeFtpResult } from "../../ftp";
import { buildScenarioRatePath } from "../../projection/static";
import { HORIZON, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { buildBaseCurve } from "../../scenario";
import {
  engineParRate,
  floatForward,
  hedgedBook,
  N_SWAP,
  runBook,
  swapPosition,
  SWAP_FAMILY_ID,
} from "../../swap/__tests__/fixtures";

let market: MarketSnapshot;
let base: ZeroCurve;
let rate: number;
let book0: PortfolioSpec;
let book1: PortfolioSpec;
let unhedged: RunResult;
let hedged: RunResult;

beforeAll(async () => {
  market = await loadMarket();
  base = buildBaseCurve(market);
  rate = engineParRate(base, 60);
  book0 = twoSidedBook("PF-NII-0");
  book1 = hedgedBook("PF-NII-1", [swapPosition("SW1", SWAP_FAMILY_ID, { fixedRate: rate })]);
  unhedged = runBook(market, book0);
  hedged = runBook(market, book1);
}, 180_000);

const s0 = (r: RunResult) => r.nii.byScenario.find((s) => s.scenarioId === "S0")!;

describe("the NII derivatives line", () => {
  it("adds the swap's net settlement to every total exactly once, last", () => {
    for (const a of unhedged.nii.byScenario) {
      const b = hedged.nii.byScenario.find((s) => s.scenarioId === a.scenarioId)!;
      expect(b.totalNet12, a.scenarioId).toBe(a.totalNet12 + b.derivativesNet12!);
      expect(b.totalNet24, a.scenarioId).toBe(a.totalNet24 + b.derivativesNet24!);
      expect(b.totalNetByHorizon![12], a.scenarioId).toBe(a.totalNetByHorizon![12]! + b.derivativesNetByHorizon![12]!);
      const row = b.byFamily.find((f) => f.familyId === SWAP_FAMILY_ID)!;
      for (let k = 0; k < a.netMonthly!.length; k++) {
        expect(b.netMonthly![k], `${a.scenarioId}/${k}`).toBe(a.netMonthly![k]! + row.netMonthly![k]!);
      }
    }
  });

  it("is receive-leg interest minus pay-leg interest, restated from forwards, at base", () => {
    let expected = 0;
    for (let m = 1; m <= 12; m++) expected += N_SWAP * (floatForward(base, m) / 12) - N_SWAP * (rate / 12);
    const got = s0(hedged).derivativesNet12!;
    expect(Math.abs(got - expected), `derivativesNet12=${got} restated=${expected}`).toBeLessThanOrEqual(1e-6);
  });

  it("books no interest income or expense on the swap row, only a net", () => {
    const row = s0(hedged).byFamily.find((f) => f.familyId === SWAP_FAMILY_ID)!;
    expect([row.interestIncome12, row.interestExpense12, row.interestIncome24, row.interestExpense24]).toEqual([0, 0, 0, 0]);
    expect(row.net12).toBe(s0(hedged).derivativesNet12);
  });

  it("leaves the three keys out of a book with no derivative family", () => {
    for (const s of unhedged.nii.byScenario) {
      expect(["derivativesNet12", "derivativesNet24", "derivativesNetByHorizon"].filter((k) => k in s), s.scenarioId).toEqual([]);
    }
  });

  it("carries the three keys at 0 on a declared swap family with zero swaps (gated by family, T7a)", () => {
    const run = runBook(market, hedgedBook("PF-NII-EMPTY", []));
    for (const s of run.nii.byScenario) {
      expect(s.derivativesNet12, `${s.scenarioId}: derivativesNet12=${s.derivativesNet12}`).toBe(0);
      expect(s.derivativesNet24, `${s.scenarioId}: derivativesNet24=${s.derivativesNet24}`).toBe(0);
      expect(s.derivativesNetByHorizon, s.scenarioId).toEqual({ 12: 0, 24: 0 });
    }
  }, 180_000);
});

describe("the NIM bridge carries the derivatives term", () => {
  function ftpFor(book: PortfolioSpec, nii: RunResult) {
    const scenario: Scenario = { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } };
    const tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
    return computeFtpResult({
      portfolio: book,
      scenarios: [scenario],
      baseScenarioId: "S0",
      curve: base,
      tlp,
      path: buildScenarioRatePath(base, scenario, HORIZON),
      horizonMonths: HORIZON,
      niiBase: s0(nii),
    });
  }

  it("moves bridgeNet12 by exactly the copied derivativesNet12, and nothing else", () => {
    const a = ftpFor(book0, unhedged).nimBridge;
    const b = ftpFor(book1, hedged).nimBridge;
    expect(b.derivativesNet12).toBe(s0(hedged).derivativesNet12);
    expect([b.lendingMargin12, b.fundingMargin12, b.mismatchCenter12]).toEqual([a.lendingMargin12, a.fundingMargin12, a.mismatchCenter12]);
    expect(b.bridgeNet12, `hedged ${b.bridgeNet12} unhedged ${a.bridgeNet12} term ${b.derivativesNet12}`).toBe(
      b.lendingMargin12 + b.fundingMargin12 + b.mismatchCenter12 + b.derivativesNet12!,
    );
    expect("derivativesNet12" in a).toBe(false);
  });

  it("still reconciles to niiNet12 on the hedged book", () => {
    const b = ftpFor(book1, hedged).nimBridge;
    expect(Math.abs(b.bridgeNet12 - b.niiNet12), `bridgeNet12=${b.bridgeNet12} niiNet12=${b.niiNet12}`).toBeLessThanOrEqual(1e-6);
  });
});
