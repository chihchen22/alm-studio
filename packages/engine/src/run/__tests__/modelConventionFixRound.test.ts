/**
 * Slice K1 fix round: the drill, an authored `walk`, and the bumps.
 *
 *  - M1: the single-instrument drill walks a CD book on the convention it is given, exactly as a run does: a
 *    corrected drill at +200bp gives the corrected run's CD family PV, and a book drill the book run's.
 *  - M2: a `walk` written into a CD book file is never read, on the original convention, on the corrected one, on the
 *    stochastic route and in the drill: the numbers equal those of the same book without it.
 *  - L7: EVE duration legs and key-rate bumps reach the corrected walk. On the original convention the CD stream does not
 *    move with a bump; corrected, early withdrawals rise with rates, so the CD family's duration is shorter and the
 *    book's key-rate measure moves by far more than the base-flow change alone.
 *  - L4: a run-off walk needs the path to reach the book's longest remaining term only.
 *
 * Every comparison is between two runs of the engine that differ in one input; no expected value is read from the
 * module under test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { CdCohortSpec, CdTerms } from "../../cd/terms";
import { stripCdMarks } from "../../cd/corrections";
import { projectInstrument } from "../../instrument/projectInstrument";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { resolveDefaultContext } from "../index";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { runStochastic } from "../stochastic";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const COHORTS: CdCohortSpec[] = [
  { termMonths: 12, monthsToMaturity: 9, balance: 60, contractRate: 0.035 },
  { termMonths: 60, monthsToMaturity: 20, balance: 40, contractRate: 0.04 },
];

function cdTerms(walk?: CdTerms["walk"]): CdTerms {
  return { id: "C1", type: "cd", notional: 50_000_000, maturityMonths: 20, originationOffsetMonths: 0, amortType: "bullet", side: "liability", cohorts: COHORTS, ...(walk !== undefined ? { walk } : {}) };
}

/** An authored walk that, if read, would move every number: a $10 billion minimum and a 5 percent funding spread. */
const AUTHORED: CdTerms["walk"] = { minLiveBalance: 1e10, tlpSpreadByMonth: new Array<number>(60).fill(0.05) };

function bookWithCd(walk?: CdTerms["walk"]): PortfolioSpec {
  const b = twoSidedBook();
  return {
    ...b,
    coa: {
      ...b.coa,
      nodes: [...b.coa.nodes, { id: "cds", label: "CDs", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "CDS", order: 2 }],
      families: [...b.coa.families, { id: "CDS", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "cds" }],
    },
    positions: [...b.positions, { id: "C1", familyId: "CDS", coaNodeId: "cds", terms: cdTerms(walk) }],
  } as PortfolioSpec;
}

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

function cdFamily(r: RunResult, scenarioId: string) {
  return r.eve.byScenario.find((s) => s.scenarioId === scenarioId)!.byFamily.find((f) => f.familyId === "CDS")!;
}

describe("M1: the drill applies the model convention as a run does", () => {
  for (const convention of ["corrected-v1", "book"] as const) {
    it(`a ${convention} drill of the CD book at +200bp gives the ${convention} run's CD family PV`, () => {
      const book = bookWithCd();
      const run = buildRunResult(makeRunRequest(market, { portfolioId: book.id }), book, ctx({ modelConvention: convention }));
      const drill = projectInstrument({
        terms: cdTerms(),
        familyId: "CDS",
        side: "liability",
        marketSnapshot: market,
        scenarios: [{ id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: "none", newBusiness: { mode: "static", rules: [] } }],
        modelConvention: convention,
      });
      expect(drill.modelConvention).toBe(convention);
      expect(drill.terms).not.toHaveProperty("walk");
      expect(drill.byScenario[0]!.pvAllIn).toBeCloseTo(cdFamily(run, "S200").pv, 4);
    });
  }

  it("corrected and book drills differ at +200bp, as the runs do", () => {
    const at = (convention: "corrected-v1" | "book") =>
      projectInstrument({
        terms: cdTerms(), familyId: "CDS", side: "liability", marketSnapshot: market, modelConvention: convention,
        scenarios: [{ id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: "none", newBusiness: { mode: "static", rules: [] } }],
      }).byScenario[0]!.pvAllIn;
    expect(Math.abs(at("corrected-v1") - at("book"))).toBeGreaterThan(10_000);
  });
});

describe("M2: an authored walk is never read", () => {
  for (const convention of [undefined, "book", "corrected-v1"] as const) {
    it(`a run on ${convention ?? "no convention"} gives the same result with and without an authored walk`, () => {
      const plain = buildRunResult(makeRunRequest(market, { portfolioId: "PF-RUN" }), bookWithCd(), ctx(convention === undefined ? {} : { modelConvention: convention }));
      const authored = buildRunResult(makeRunRequest(market, { portfolioId: "PF-RUN" }), bookWithCd(AUTHORED), ctx(convention === undefined ? {} : { modelConvention: convention }));
      expect(JSON.stringify(authored)).toBe(JSON.stringify(plain));
    });
  }

  it("the drill and the stochastic entry drop it too", () => {
    const drill = (walk?: CdTerms["walk"]) =>
      projectInstrument({ terms: cdTerms(walk), familyId: "CDS", side: "liability", marketSnapshot: market, modelConvention: "book", scenarios: [{ id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "none", newBusiness: { mode: "static", rules: [] } }] });
    expect(JSON.stringify(drill(AUTHORED))).toBe(JSON.stringify(drill()));
    // The stochastic entry's own view of the book: no walk survives.
    expect((stripCdMarks(bookWithCd(AUTHORED)).positions.at(-1)!.terms as CdTerms).walk).toBeUndefined();
    // And the factory, handed the authored terms directly, would have read it: the guard is the entry, not the adapter.
    const path = { nSteps: 360, times: Array.from({ length: 361 }, (_, k) => k / 12), rateAt: () => 0.04, forwardRateAt: () => 0.04 };
    expect(JSON.stringify(makeInstrument(cdTerms(AUTHORED)).generateCashflows(path))).not.toBe(JSON.stringify(makeInstrument(cdTerms()).generateCashflows(path)));
  });

  it("a stochastic run gives the same envelope with and without an authored walk", () => {
    const request = makeRunRequest(market, { portfolioId: "PF-RUN", scenarios: makeRunRequest(market).scenarios.filter((s) => s.rateSpec.kind === "base") });
    const plain = runStochastic(request, bookWithCd(), { nPaths: 20 });
    const authored = runStochastic(request, bookWithCd(AUTHORED), { nPaths: 20 });
    expect(JSON.stringify(authored)).toBe(JSON.stringify(plain));
  });
});

describe("L7: duration and key-rate bumps reach the corrected walk", () => {
  it("the CD family's effective duration is shorter corrected than on the original convention", () => {
    const book = bookWithCd();
    const req = makeRunRequest(market, { portfolioId: book.id });
    const b = cdFamily(buildRunResult(req, book, ctx({ modelConvention: "book" })), "S0").effectiveDuration!;
    const c = cdFamily(buildRunResult(req, book, ctx({ modelConvention: "corrected-v1" })), "S0").effectiveDuration!;
    expect(Number.isFinite(b) && Number.isFinite(c)).toBe(true);
    expect(c).toBeLessThan(b - 1e-4);
  });

  it("the key-rate parallel reference moves far more than the base-flow change alone", () => {
    // Key rates refuse a deposit with the regime amplifier, so the fixture's plain deposit is left out here.
    const full = bookWithCd();
    const book = { ...full, positions: full.positions.filter((p) => p.id !== "D1") };
    const req = makeRunRequest(market, { portfolioId: book.id });
    const kb = buildRunResult(req, book, ctx({ modelConvention: "book", keyRate: true }));
    const kc = buildRunResult(req, book, ctx({ modelConvention: "corrected-v1", keyRate: true }));
    const relKey = Math.abs(kc.eve.keyRate!.parallelReference - kb.eve.keyRate!.parallelReference) / Math.abs(kb.eve.keyRate!.parallelReference);
    const baseEve = (r: RunResult) => r.eve.byScenario.find((s) => s.scenarioId === "S0")!.eve;
    const relBase = Math.abs(baseEve(kc) - baseEve(kb)) / Math.abs(baseEve(kb));
    expect(relKey).toBeGreaterThan(100 * relBase);
  });
});

describe("L4: a run-off walk needs the path to its longest remaining term only", () => {
  it("a 24-month grid runs a book whose 60-month cohort has 20 months left", () => {
    const book = bookWithCd();
    const r = buildRunResult(makeRunRequest(market, { portfolioId: book.id, grid: { horizonMonths: 24, asOf: "2026-01-01" } }), book, ctx({ modelConvention: "corrected-v1" }));
    expect(Number.isFinite(cdFamily(r, "S0").pv)).toBe(true);
  });

  it("an 18-month grid is refused, naming the 20 months the walk reads", () => {
    const book = bookWithCd();
    expect(() => buildRunResult(makeRunRequest(market, { portfolioId: book.id, grid: { horizonMonths: 18, asOf: "2026-01-01" } }), book, ctx({ modelConvention: "corrected-v1" }))).toThrow(
      /reads the scenario's curve to 20 months \(the book's longest remaining term\)/,
    );
  });
});
