/**
 * An undrawn committed line is OFF the balance sheet.
 *
 * The ruling this file enforces has two halves, and both are the
 * silent-wrong-number class rather than the crash class:
 *
 *  - a draw is a CASH OUTFLOW ONLY. The engine does not book the resulting
 *    earning asset, so NII, EVE, the two gap ladders and the FTP block must not
 *    move by one cent when a line draws;
 *  - an undrawn line is NOT AN ASSET. Counting its notional, or its running
 *    undrawn balance, in any asset aggregate inflates total assets by money the
 *    bank does not own and breaks every asset-side ratio downstream.
 *
 * The method is a pair of books identical except for one commitment family, run
 * through the same pipeline, and compared. Every assertion is an EQUALITY
 * against the commitment-free book, so a fold that lets a commitment in fails
 * here whatever the sign of the leak.
 *
 * The commitment in the WITH book DRAWS: an unbound line emits no cash flows at
 * all (EMPTY_DRAW_PATH), which would make every equality below pass vacuously.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot, ZeroCurve } from "@alm/kernel";
import { buildTLPCurve, DEFAULT_TLP_CURVE } from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import type { CustomMetricInput } from "../../plugins/services";
import { computeFtpResult } from "../../ftp";
import { clearPortfolios } from "../../portfolio/registry";
import { buildScenarioRatePath } from "../../projection/static";
import { createEngine, resolveDefaultContext } from "../../run";
import { buildBaseCurve } from "../../scenario";
import {
  HORIZON,
  loadMarket,
  makeCoa,
  makeRunRequest,
  twoSidedBook,
} from "../../run/__tests__/fixtures";
import { computeBalanceSummary } from "../balanceSummary";
import { computeSurvivalHorizon } from "../survivalHorizon";
import { computeWalGap } from "../walGap";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const COMMIT_NOTIONAL = 50_000_000;

/** The commitment family's COA node is a ROOT, as the seeded book's is. */
function coaWithCommitments(): ChartOfAccounts {
  const coa = makeCoa();
  return {
    ...coa,
    nodes: [
      ...coa.nodes,
      {
        id: "commitments",
        label: "Undrawn committed lines",
        parentId: null,
        side: "asset",
        isLeaf: true,
        familyId: "COMMIT",
        order: 2,
      },
    ],
    families: [
      ...coa.families,
      {
        id: "COMMIT",
        label: "Undrawn committed lines",
        side: "asset",
        instrumentType: "commitment",
        coaNodeId: "commitments",
      },
    ],
  };
}

/** A line that actually draws, so every equality below has something to catch. */
function commitmentPosition(): Position {
  return {
    id: "C1",
    familyId: "COMMIT",
    coaNodeId: "commitments",
    terms: {
      id: "C1",
      type: "commitment",
      notional: COMMIT_NOTIONAL,
      maturityMonths: 36,
      originationOffsetMonths: 0,
      amortType: "bullet",
      side: "asset",
      draw: { rampRates: [0.35, 0.15, 0.1], steadyRate: 0.02 },
    },
  } as unknown as Position;
}

function bookWithoutCommitments(): PortfolioSpec {
  return twoSidedBook("PF-NO-COMMIT");
}

function bookWithCommitments(): PortfolioSpec {
  const book = twoSidedBook("PF-COMMIT");
  return { ...book, coa: coaWithCommitments(), positions: [...book.positions, commitmentPosition()] };
}

function runBook(book: PortfolioSpec): RunResult {
  clearPortfolios();
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(book);
  return engine.run(makeRunRequest(market, { portfolioId: book.id }));
}

/** The CustomMetricInput a metric stage hands a custom metric, off a real run. */
function metricInput(book: PortfolioSpec, result: RunResult): CustomMetricInput {
  return {
    horizonMonths: HORIZON,
    baseScenarioId: "S0",
    scenarios: result.cashflows.byScenario.map((sc) => ({
      scenarioId: sc.scenarioId,
      assumptionSetId: "AS-BASE",
      cashflows: sc,
    })),
    book,
  };
}

/**
 * The same book with F1 tagged `hqla-level: "l1"`, so `survival-horizon` has a
 * buffer family and emits values at all (it returns `{}` otherwise).
 *
 * Applied to the METRIC INPUT only, never to the book that was run: the tag
 * changes no cash flow, and re-running two 360-month books to add one dimension
 * would put every other assertion in this file at risk for nothing. A metric
 * stage reads the book for family definitions and position tags, which is
 * exactly what this supplies.
 */
function taggedForBuffer(book: PortfolioSpec): PortfolioSpec {
  return {
    ...book,
    positions: book.positions.map((p) =>
      p.id === "F1" ? ({ ...p, dimensions: { "hqla-level": "l1" } } as typeof p) : p,
    ),
  };
}

function baseScenario(): Scenario {
  return {
    id: "S0",
    label: "S0",
    rateSpec: { kind: "base" },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "static", rules: [] },
  };
}

function ftpFor(book: PortfolioSpec, curve: ZeroCurve) {
  const tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
  const scenario = baseScenario();
  return computeFtpResult({
    portfolio: book,
    scenarios: [scenario],
    baseScenarioId: "S0",
    curve,
    tlp,
    path: buildScenarioRatePath(curve, scenario, HORIZON),
    horizonMonths: HORIZON,
    niiBase: { scenarioId: "S0", totalNet12: 0 },
  });
}

/** Sum of a ladder's asset column over every band: the whole asset side of the ladder. */
function ladderAssets(rows: ReadonlyArray<{ assets: number }>): number {
  return rows.reduce((a, r) => a + r.assets, 0);
}

describe("an undrawn committed line is off the balance sheet", () => {
  let withoutRun: RunResult;
  let withRun: RunResult;
  let bookNo: PortfolioSpec;
  let bookYes: PortfolioSpec;

  beforeAll(() => {
    bookNo = bookWithoutCommitments();
    bookYes = bookWithCommitments();
    withoutRun = runBook(bookNo);
    withRun = runBook(bookYes);
  });

  it("the fixture actually draws, so the equalities below are not vacuous", () => {
    // Month 1 is 35 percent of the whole undrawn line; the draw walk signs it
    // as a NEGATIVE principalPaid, so this is the number every fold could leak.
    const commit = withRun.cashflows.byScenario[0]!.byFamily.find((f) => f.familyId === "COMMIT");
    expect(commit, "the commitment family must reach the cash-flow layer").toBeDefined();
    expect(commit!.series.principal[0]).toBeCloseTo(-0.35 * COMMIT_NOTIONAL, 6);
  });

  // --- the balance-summary aggregate (the plan's named assertion) -------------

  it("does not add its notional to the balance-summary total", () => {
    const without = computeBalanceSummary(metricInput(bookNo, withoutRun)).byScenario[0]!.values;
    const withCommit = computeBalanceSummary(metricInput(bookYes, withRun)).byScenario[0]!.values;
    expect(withCommit["opening-balance"]).toBeCloseTo(without["opening-balance"]!, 6);
    expect(withCommit["final-bucket-balance"]).toBeCloseTo(without["final-bucket-balance"]!, 6);
  });

  // --- one assertion per fold the task-8a enumeration found -------------------

  it("does not move EVE, in any scenario", () => {
    for (const a of withoutRun.eve.byScenario) {
      const b = withRun.eve.byScenario.find((x) => x.scenarioId === a.scenarioId)!;
      expect(b.pvAssets, a.scenarioId).toBeCloseTo(a.pvAssets, 6);
      expect(b.eve, a.scenarioId).toBeCloseTo(a.eve, 6);
      expect(b.deltaEveVsBase, a.scenarioId).toBeCloseTo(a.deltaEveVsBase, 6);
    }
  });

  it("does not move the equity effective duration or the duration sanity gate", () => {
    for (const a of withoutRun.eve.byScenario) {
      const b = withRun.eve.byScenario.find((x) => x.scenarioId === a.scenarioId)!;
      expect(b.durationSanityPassed, a.scenarioId).toBe(a.durationSanityPassed);
      expect(b.effectiveDurationEquity, a.scenarioId).toBe(a.effectiveDurationEquity);
    }
  });

  it("does not move NII, in any scenario", () => {
    for (const a of withoutRun.nii.byScenario) {
      const b = withRun.nii.byScenario.find((x) => x.scenarioId === a.scenarioId)!;
      expect(b.totalNet12, a.scenarioId).toBeCloseTo(a.totalNet12, 6);
      expect(b.totalNet24, a.scenarioId).toBeCloseTo(a.totalNet24, 6);
    }
  });

  it("does not move either gap ladder", () => {
    for (const kind of ["repricing", "liquidity"] as const) {
      for (const a of withoutRun.gap[kind]) {
        const b = withRun.gap[kind].find((x) => x.scenarioId === a.scenarioId)!;
        expect(ladderAssets(b.rows), `${kind}/${a.scenarioId}`).toBeCloseTo(ladderAssets(a.rows), 6);
        for (let i = 0; i < a.rows.length; i++) {
          expect(b.rows[i]!.assets, `${kind}/${a.scenarioId}/band${i}`).toBeCloseTo(a.rows[i]!.assets, 6);
          expect(b.rows[i]!.gap, `${kind}/${a.scenarioId}/band${i}`).toBeCloseTo(a.rows[i]!.gap, 6);
        }
      }
    }
  });

  it("does not move the FTP block", () => {
    const curve = buildBaseCurve(market);
    const without = ftpFor(bookNo, curve);
    const withCommit = ftpFor(bookYes, curve);
    expect(withCommit.book.charges12).toBeCloseTo(without.book.charges12, 6);
    expect(withCommit.book.credits12).toBeCloseTo(without.book.credits12, 6);
    expect(withCommit.book.mismatchCenter12).toBeCloseTo(without.book.mismatchCenter12, 6);
    expect(withCommit.book.bookNimRate).toBeCloseTo(without.book.bookNimRate, 12);
    expect(withCommit.nimBridge.lendingMargin12).toBeCloseTo(without.nimBridge.lendingMargin12, 6);
  });

  // --- survival-horizon: the draw must arrive at FULL weight --------------
  //
  // The one fold in the piece that SHOULD see the draw, and the one place the
  // draw must not be haircut. `assetInflowFactor` (0.5) is a stress discount on
  // asset inflows the bank merely HOPES will arrive. A committed-line draw is
  // not a hoped-for inflow, it is a contractual obligation to pay out, so the
  // asset branch's half weight understates the stress in precisely the
  // unconservative direction the piece exists to correct. Ruling,
  // overriding spec 7.4, which asserted draws reach this metric "for free": true
  // of the sign, false of the magnitude.
  //
  // The assertion is the MAGNITUDE, not the direction, so it fails at half
  // weight rather than passing on a coincidence of sign.

  it("a commitment row carries structurally zero interest, so the half weight cannot hide there", () => {
    const commit = withRun.cashflows.byScenario[0]!.byFamily.find((f) => f.familyId === "COMMIT")!;
    for (let k = 0; k < 36; k++) expect(commit.series.interest[k] ?? 0).toBe(0);
  });

  it("adds the FULL month-1 draw to the survival-horizon outflow, not half of it", () => {
    const without = computeSurvivalHorizon(
      metricInput(taggedForBuffer(bookNo), withoutRun),
    ).byScenario[0]!.values;
    const withCommit = computeSurvivalHorizon(
      metricInput(taggedForBuffer(bookYes), withRun),
    ).byScenario[0]!.values;

    // The metric must actually be live: without a buffer family it returns {}.
    expect(without["month1-coverage"]).toBeDefined();
    expect(withCommit["month1-coverage"]).toBeDefined();
    // Same buffer family, same positions, same tag: the buffer must not move,
    // or the comparison below would be measuring two different books.
    expect(withCommit.buffer).toBeCloseTo(without.buffer!, 6);

    // month1-coverage is buffer / outflow[0], so outflow[0] is recoverable.
    const outflow0 = (v: Record<string, number>) => v.buffer! / v["month1-coverage"]!;
    const delta = outflow0(withCommit) - outflow0(without);

    const FULL_MONTH1_DRAW = 0.35 * COMMIT_NOTIONAL; // 17,500,000
    expect(delta).toBeCloseTo(FULL_MONTH1_DRAW, 6);
    // Said the other way, so the failure message names the bug: the old asset
    // branch contributed assetInflowFactor * draw, which is exactly half.
    expect(delta).not.toBeCloseTo(0.5 * FULL_MONTH1_DRAW, 6);
  });

  it("the draw makes survival strictly worse, never better", () => {
    const without = computeSurvivalHorizon(
      metricInput(taggedForBuffer(bookNo), withoutRun),
    ).byScenario[0]!.values;
    const withCommit = computeSurvivalHorizon(
      metricInput(taggedForBuffer(bookYes), withRun),
    ).byScenario[0]!.values;
    expect(withCommit["min-headroom"]!).toBeLessThan(without["min-headroom"]!);
  });

  it("does not move the pooled asset WAL", () => {
    const without = computeWalGap(metricInput(bookNo, withoutRun)).byScenario[0]!.values;
    const withCommit = computeWalGap(metricInput(bookYes, withRun)).byScenario[0]!.values;
    expect(withCommit["asset-wal"]).toBeCloseTo(without["asset-wal"]!, 6);
    expect(withCommit["wal-gap"]).toBeCloseTo(without["wal-gap"]!, 6);
  });
});
