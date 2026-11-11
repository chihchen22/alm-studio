/**
 * A "history" deposit warmup reaches a dynamic scenario. Its opening book's deposits are
 * built on the history, and a new deposit cohort made at bucket k reads the history followed by the scenario's own
 * one-month rate at steps 0 to k - 1. The expected streams are built here straight from the kernel constructors on a
 * history written out by hand, never read back from the projection.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DeterministicRatePath, NMDeposit, NMD_TERMS_DEFAULTS, buildWarmupSOFR1M, type RatePath } from "@alm/kernel";
import { loadMarket } from "../../../run/__tests__/fixtures";
import { buildBaseCurve } from "../../../scenario";
import { aggregateScenario } from "../../../portfolio/aggregate";
import { cohortWarmup } from "../templateTranche";
import type { PortfolioSpec } from "../../../contracts/position";

let path: RatePath;
beforeAll(async () => {
  path = new DeterministicRatePath(buildBaseCurve(await loadMarket()), 360);
});
// 30 made-up months, 1.00 to 1.58 percent: well below the fixture path, so the regime amplifier fires and the history matters.
const history = Array.from({ length: 30 }, (_, i) => 1 + (2 * i) / 100);

describe("cohortWarmup with a history", () => {
  it("is the history followed by the scenario's path, in percent, to the month before the cohort", () => {
    const got = cohortWarmup(path, 3, history);
    expect(got).toEqual([...history, path.rateAt(0) * 100, path.rateAt(1) * 100, path.rateAt(2) * 100]);
  });
  it("without one it is the kernel's own series, as before", () => {
    expect(cohortWarmup(path, 2)).toEqual([...buildWarmupSOFR1M(), path.rateAt(0) * 100, path.rateAt(1) * 100]);
  });
});

describe("aggregateScenario with a history", () => {
  const terms = { ...NMD_TERMS_DEFAULTS, id: "D", notional: 5_000_000, maturityMonths: 360, nmdParams: { ...NMD_TERMS_DEFAULTS.nmdParams, regimeAlpha: 1.5 } };
  const book: PortfolioSpec = {
    id: "h", label: "h", asOf: "2026-03-31",
    coa: {
      schemaVersion: "1.0.0",
      nodes: [{ id: "n", label: "Deposits", parentId: null, side: "liability", isLeaf: true, familyId: "dep", order: 0 }],
      families: [{ id: "dep", label: "Deposits", side: "liability", instrumentType: "nmd", coaNodeId: "n" }],
    },
    positions: [{ id: "D", familyId: "dep", coaNodeId: "n", terms }],
  };
  it("builds the opening deposits on the history, and without one exactly as before", () => {
    const grid = { horizonMonths: 120, asOf: "2026-03-31" };
    const withHistory = aggregateScenario(book, { scenarioId: "S", path }, grid, undefined, undefined, history);
    const expected = new NMDeposit(terms, history).generateCashflows(path).slice(0, 120).map((c) => c.balance);
    expect(withHistory.byFamily[0]!.series.balance).toEqual(expected);
    const without = aggregateScenario(book, { scenarioId: "S", path }, grid);
    expect(without.byFamily[0]!.series.balance).toEqual(new NMDeposit(terms).generateCashflows(path).slice(0, 120).map((c) => c.balance));
    expect(withHistory.byFamily[0]!.series.balance).not.toEqual(without.byFamily[0]!.series.balance);
  });
});
