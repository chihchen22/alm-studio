/**
 * The model convention end to end through the run pipeline.
 *
 * A run that names no convention carries no key and is the original convention; "book" changes nothing but the echo.
 * "corrected-v1" moves the CD book with the scenario: its month 1 early withdrawal under +200bp is the H7 hazard at the
 * shocked run curve plus the run's funding spread, both read here from the market through the curve builders (never
 * from the CD adapter). A malformed value is refused before the walk.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CD_DEFAULT_PARAMS, buildTLPCurve, type MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { CdCohortSpec } from "../../cd/terms";
import { buildBaseCurve } from "../../scenario";
import { shockedCurve } from "../../scenario/rateEnvironment";
import { resolveDefaultContext } from "../index";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const COHORT: CdCohortSpec = { termMonths: 12, monthsToMaturity: 9, balance: 100, contractRate: 0.035 };

function bookWithCd(): PortfolioSpec {
  const b = twoSidedBook();
  return {
    ...b,
    coa: {
      ...b.coa,
      nodes: [...b.coa.nodes, { id: "cds", label: "CDs", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "CDS", order: 2 }],
      families: [...b.coa.families, { id: "CDS", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "cds" }],
    },
    positions: [
      ...b.positions,
      { id: "C1", familyId: "CDS", coaNodeId: "cds", terms: { id: "C1", type: "cd", notional: 50_000_000, maturityMonths: 9, originationOffsetMonths: 0, amortType: "bullet", side: "liability", cohorts: [COHORT] } },
    ],
  } as PortfolioSpec;
}

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

function cdPrincipal(r: RunResult, scenarioId: string): number[] {
  return r.cashflows.byScenario.find((s) => s.scenarioId === scenarioId)!.byFamily.find((f) => f.familyId === "CDS")!.series.principal;
}

const expit = (x: number, clip: number) => 1 / (1 + Math.exp(-Math.min(clip, Math.max(-clip, x))));

/** The month 1 early withdrawal of the one-cohort book at a market rate (kernel header, equations 1, 3 and 4). */
function handMonthOne(marketRate: number): number {
  const p = CD_DEFAULT_PARAMS;
  const hz = p.hazard;
  const m = marketRate - COHORT.contractRate;
  const zTtm = (Math.log(COHORT.monthsToMaturity) - hz.lnTtmMean) / hz.lnTtmStd;
  const zBal = (Math.log(COHORT.balance * p.walkScale) - hz.lnBalMean) / hz.lnBalStd;
  const h = expit(hz.intercept + hz.b1Moneyness * m + hz.bLogTtmStd * zTtm + hz.bLogBalStd * zBal, hz.logitClip);
  const pf = expit(p.severityPart1.tbShort + p.severityPart1.moneyness * m, hz.logitClip);
  return h * (pf + (1 - pf) * p.eSevPartial) * 50_000_000;
}

describe("run pipeline: model convention (K1)", () => {
  it("no convention carries no key; book changes only the echo", () => {
    const book = bookWithCd();
    const request = makeRunRequest(market, { portfolioId: book.id });
    const none = buildRunResult(request, book, ctx());
    const named = buildRunResult(request, book, ctx({ modelConvention: "book" }));
    expect("modelConvention" in none).toBe(false);
    expect(named.modelConvention).toBe("book");
    const { modelConvention: _drop, ...rest } = named;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(none));
  });

  it("original convention: the CD stream is the same in every scenario", () => {
    const book = bookWithCd();
    const r = buildRunResult(makeRunRequest(market, { portfolioId: book.id }), book, ctx());
    expect(cdPrincipal(r, "S200")).toEqual(cdPrincipal(r, "S0"));
  });

  it("corrected-v1: the CD month 1 withdrawal under each scenario is the hazard at that scenario's run curve plus TLP", () => {
    const book = bookWithCd();
    const r = buildRunResult(makeRunRequest(market, { portfolioId: book.id }), book, ctx({ modelConvention: "corrected-v1" }));
    expect(r.modelConvention).toBe("corrected-v1");
    const base = buildBaseCurve(market);
    const tlp = buildTLPCurve(market.tlpNodes);
    const tau = COHORT.monthsToMaturity / 12;
    for (const [sid, bp] of [["S0", 0], ["S200", 200], ["S-200", -200]] as const) {
      const curve = shockedCurve(base, bp === 0 ? { kind: "base" } : { kind: "parallel", shockBp: bp });
      expect(cdPrincipal(r, sid)[0]).toBeCloseTo(handMonthOne(curve.zeroRate(tau) + tlp.tlp(tau)), 4);
    }
    expect(cdPrincipal(r, "S200")[0]).toBeGreaterThan(cdPrincipal(r, "S0")[0]!);
  });

  it("refuses a malformed convention before the walk", () => {
    const book = bookWithCd();
    expect(() => buildRunResult(makeRunRequest(market, { portfolioId: book.id }), book, ctx({ modelConvention: "k1" as never }))).toThrow(
      /context.modelConvention must be "corrected-v1"/,
    );
  });
});
