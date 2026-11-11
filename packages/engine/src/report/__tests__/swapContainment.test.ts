/**
 * A swap moves no balance, no WAL, no LCR and no survival reading.
 *
 * The method is piece 7's: two books identical but for a swap family, one
 * pipeline, every assertion an EQUALITY against the unhedged book, so a fold
 * that lets the swap in fails whatever the sign of the leak. The swap is
 * struck OFF par so its flows are not near zero and a leak would be large.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { CustomMetricInput } from "../../plugins/services";
import { HORIZON, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { hedgedBook, runBook, swapPosition, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import { computeBalanceSummary } from "../balanceSummary";
import { computeLcrRegulatory, computeLcrScenario } from "../lcr";
import { computeSurvivalHorizon } from "../survivalHorizon";
import { computeWalGap } from "../walGap";

let market: MarketSnapshot;
let book0: PortfolioSpec;
let book1: PortfolioSpec;
let run0: RunResult;
let run1: RunResult;

beforeAll(async () => {
  market = await loadMarket();
  book0 = twoSidedBook("PF-CONT-0");
  book1 = hedgedBook("PF-CONT-1", [swapPosition("SW1", SWAP_FAMILY_ID, { fixedRate: 0.08, maturityMonths: 60 })]);
  run0 = runBook(market, book0);
  run1 = runBook(market, book1);
}, 180_000);

/** Tags the metrics need, on the METRIC INPUT's book only. */
function tagged(book: PortfolioSpec): PortfolioSpec {
  const tags: Record<string, Record<string, string>> = {
    F1: { "hqla-level": "l1" },
    D1: { "lcr-category": "retail-stable" },
    B1: { "lcr-category": "retail-other" },
  };
  return { ...book, positions: book.positions.map((p) => (tags[p.id] ? { ...p, dimensions: tags[p.id] } : p)) };
}

function input(book: PortfolioSpec, run: RunResult): CustomMetricInput {
  return {
    horizonMonths: HORIZON,
    baseScenarioId: "S0",
    scenarios: run.cashflows.byScenario.map((sc) => ({ scenarioId: sc.scenarioId, assumptionSetId: "AS-BASE", cashflows: sc })),
    book,
  };
}

/** A copy of the hedged book whose swap family CLAIMS to be asset-side: the leak each metric must be able to see. */
function swapAsAsset(book: PortfolioSpec): PortfolioSpec {
  return {
    ...book,
    coa: { ...book.coa, families: book.coa.families.map((f) => (f.id === SWAP_FAMILY_ID ? { ...f, side: "asset" as const } : f)) },
  };
}

// Only the byFamily assertion guards the filter here. The scenario-value
// equalities hold with or without it: a swap's balance nets to 0 in the
// balance summary, and the WAL pools skip the derivative side, so they are
// kept as regression pins, not as evidence that the swap row is dropped.
describe("balance-summary and wal-gap drop the swap row", () => {
  it("balance-summary: no SWAPS row (scenario values unchanged, a pin the filter cannot move)", () => {
    const a = computeBalanceSummary(input(book0, run0));
    const b = computeBalanceSummary(input(book1, run1));
    for (let i = 0; i < a.byScenario.length; i++) {
      expect(b.byScenario[i]!.values, a.byScenario[i]!.scenarioId).toEqual(a.byScenario[i]!.values);
      expect(b.byScenario[i]!.byFamily!.map((f) => f.familyId)).not.toContain(SWAP_FAMILY_ID);
    }
  });

  it("wal-gap: no SWAPS row (scenario values unchanged, a pin the filter cannot move)", () => {
    const a = computeWalGap(input(book0, run0));
    const b = computeWalGap(input(book1, run1));
    for (let i = 0; i < a.byScenario.length; i++) {
      expect(b.byScenario[i]!.values, a.byScenario[i]!.scenarioId).toEqual(a.byScenario[i]!.values);
      expect(b.byScenario[i]!.byFamily!.map((f) => f.familyId)).not.toContain(SWAP_FAMILY_ID);
    }
  });
});

describe("the liquidity metrics never see a swap", () => {
  for (const [name, metric] of [
    ["lcr-scenario", computeLcrScenario],
    ["lcr-regulatory", computeLcrRegulatory],
    ["survival-horizon", computeSurvivalHorizon],
  ] as const) {
    it(`${name}: live on the tagged book, and bit-identical hedged versus unhedged`, () => {
      const a = metric(input(tagged(book0), run0));
      const b = metric(input(tagged(book1), run1));
      expect(Object.keys(a.byScenario[0]!.values).length, `${name} returned no keys; the comparison would be vacuous`).toBeGreaterThan(0);
      for (let i = 0; i < a.byScenario.length; i++) {
        expect(b.byScenario[i]!.values, `${name} ${a.byScenario[i]!.scenarioId}`).toEqual(a.byScenario[i]!.values);
      }
    });

    // If a metric's inflow cap absorbs the leak so this case passes vacuously,
    // record it and raise the swap's fixedRate in beforeAll until the case bites.
    it(`${name}: would see the swap if its family claimed to be asset-side (the comparison has teeth)`, () => {
      const a = metric(input(tagged(book0), run0));
      const leaked = metric(input(tagged(swapAsAsset(book1)), run1));
      expect(leaked.byScenario[0]!.values, `${name}: an asset-side swap family left the metric unmoved`).not.toEqual(a.byScenario[0]!.values);
    });
  }
});
