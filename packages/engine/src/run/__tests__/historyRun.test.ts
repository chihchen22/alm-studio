/**
 * Index history through the run (Review Focus 2 and 6).
 *
 * The run request carries the histories a lagged formula reads (`indexHistories`); the run, stochastic and drill
 * entries pass them to the rate index check, which puts the resolved pre-cut-off months on the anchored table entry,
 * so shard workers and Hull-White paths read them through the table. History is unshocked: a scenario reaches a
 * lagged index at month lag + 1, never before. Expected values are restated as arithmetic on fixture inputs, never
 * read back from the code under test.
 *
 * Markets, both on the public pack:
 *   plain: rfr-1m, rfr-3m, prime-demo and three formulas on rfr-1m: lag-hist (level, lag 3), admin-hist (beta 0.5
 *          from 4.33 percent, lag 2) and level-now (level, no lag).
 *   full:  plain, with the FULL synthetic history attached to rfr-1m.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { IndexHistoryEntry } from "../../contracts/indexHistory";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { indexHistoryIdOf } from "../../indexHistory/id";
import { projectInstrument } from "../../instrument/projectInstrument";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy } from "../../plan/__tests__/fixtures";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { ResolvedIndexPath } from "../../rateIndex/indexSeries";
import { checkRateIndexRefs, RateIndexRefusedError } from "../../rateIndex/resolve";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { buildStochasticEnvironment } from "../../scenario/stochasticEnvironment";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { resolveDefaultContext } from "../index";
import { runStochastic } from "../stochastic";
import { SHARD_CHUNK } from "../shard/chunk";
import { AS_OF, baseAssumptions, loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

const BASE_ID = "market-public-2026-03-31";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];

const SOURCE = { fileName: "synthetic-rfr-1m.csv", fileSha256: "a".repeat(64), format: "csv" as const, frequency: "monthly" as const, rows: 6, unit: "decimal" as const };
/** Six synthetic month-end fixings, 2025-10 to 2026-03 (the public pack's as-of month). */
const FULL = { label: "Synthetic one-month benchmark history (demonstration values)", firstMonth: "2025-10", values: [0.041, 0.0415, 0.042, 0.0425, 0.043, 0.0435], source: SOURCE };
/** The same series cut at 2025-12, three months before the cut-off month. */
const SHORT = { ...FULL, values: [0.041, 0.0415, 0.042], source: { ...SOURCE, rows: 3 } };
void SHORT;
const LAG3 = { op: "set-index", id: "lag-hist", label: "The one-month rate three months late (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, lagMonths: 3, basisBp: 0 };
const BETA2 = { op: "set-index", id: "admin-hist", label: "Half the one-month change, two months late (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.5, startBp: 433, lagMonths: 2, basisBp: 0 };
const NOW = { op: "set-index", id: "level-now", label: "The one-month rate through a formula (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, basisBp: 0 };
const E_FULL = { id: indexHistoryIdOf(FULL), history: FULL };

let plain: MarketSnapshot;
let full: MarketSnapshot;
beforeAll(async () => {
  plain = deriveMarketSnapshot(structuredClone(await loadMarket()), [...SEED_OPS, LAG3, BETA2, NOW], { baseId: BASE_ID }).snapshot;
  full = deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: E_FULL.id }], { baseId: BASE_ID }).snapshot;
});

function floaterPosition(id: string, rateIndexId?: string, notional = 1_000_000): Position {
  const terms = {
    id,
    type: "floating-loan",
    notional,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    ...(rateIndexId !== undefined ? { rateIndexId } : {}),
  } as unknown as PositionTerms;
  return { id, familyId: "floaters", coaNodeId: "floaters", terms };
}

function handBook(id: string, positions: Position[]): PortfolioSpec {
  return {
    id,
    label: "hand book H",
    asOf: AS_OF,
    coa: {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "floaters", label: "Floaters", parentId: "assets", side: "asset", isLeaf: true, familyId: "floaters", order: 0 },
      ],
      families: [{ id: "floaters", label: "Floaters", side: "asset", instrumentType: "floating-loan", coaNodeId: "floaters" }],
    },
    positions,
  };
}

const N = 1_000_000;
const MARGIN = 0.0125;
function runBook(book: PortfolioSpec, market: MarketSnapshot, histories?: IndexHistoryEntry[], extra?: Partial<RunPipelineContext>, runId = "IH-E2E") {
  return buildRunResult(
    makeRunRequest(market, { runId, portfolioId: book.id, assumptionSets: [{ ...baseAssumptions(), bindings: [] }], ...(histories !== undefined ? { indexHistories: histories } : {}) }),
    book,
    { ...resolveDefaultContext(), ...extra },
  );
}
type E2eResult = ReturnType<typeof runBook>;
/** The provenance hashes the market, which differs between the markets compared; every number is outside it. */
const numbers = (r: E2eResult): string => {
  const { provenance: _p, ...rest } = r;
  void _p;
  return JSON.stringify(rest);
};
const interestIn = (r: E2eResult, scenarioId: string) =>
  r.cashflows.byScenario.find((s) => s.scenarioId === scenarioId)!.byFamily.find((f) => f.familyId === "floaters")!.series.interest;

/** A mixed book spanning two chunks: a quarter each on the lagged level, the lagged beta, the unlagged level and rfr-3m. */
function manyFloaters(n: number): Position[] {
  const ids = ["lag-hist", "admin-hist", "level-now", "rfr-3m"];
  const out: Position[] = [];
  for (let i = 0; i < n; i++) out.push(floaterPosition(`F${i}`, ids[i % 4], 100_000 + (i % 7) * 1_000));
  return out;
}

/** The refusal, restated. */
const REFUSAL = `run refused: 1 rate index history problem(s), and a lag never reads a flat fill in place of a history the market names: rate index "lag-hist" lags on "rfr-1m", which reads index history "${E_FULL.id}", and the run was not given that history`;

describe("index history through the deterministic run (R1)", () => {
  it("(1) byte identity: a history that no lagged formula reads moves no number", () => {
    const book = handBook("PF-IH-PLAIN", [floaterPosition("F", "rfr-1m"), floaterPosition("G", "level-now")]);
    expect(numbers(runBook(book, full))).toBe(numbers(runBook(book, plain)));
  });

  it("(2) a lag-3 floater's first three months read 2025-12, 2026-01 and 2026-02 from history", () => {
    const r = runBook(handBook("PF-IH-LAG", [floaterPosition("F", "lag-hist")]), full, [E_FULL]);
    const s0 = interestIn(r, "S0");
    expect(s0[0]!).toBeCloseTo((N * (0.042 + MARGIN)) / 12, 10);
    expect(s0[1]!).toBeCloseTo((N * (0.0425 + MARGIN)) / 12, 10);
    expect(s0[2]!).toBeCloseTo((N * (0.043 + MARGIN)) / 12, 10);
  });

  it("(3) Review Focus 2: the history is unshocked, so S100 equals S0 for the lagged months and the shock arrives at month lag + 1", () => {
    const r = runBook(handBook("PF-IH-LAG", [floaterPosition("F", "lag-hist")]), full, [E_FULL]);
    const s0 = interestIn(r, "S0");
    const s100 = interestIn(r, "S100");
    for (const k of [0, 1, 2]) expect(s100[k]!).toBe(s0[k]!);
    expect(s100[3]!).not.toBe(s0[3]!);
  });

  it("(6a) Review Focus 2 on the change form: a lag-2 beta index matches S0 before month lag + 1, then moves by beta x the parent's month-0 move", () => {
    const base = buildBaseCurve(full);
    const p0 = buildRatePath(shockedCurve(base, { kind: "base" }), 360).rateAt(0);
    const p100 = buildRatePath(shockedCurve(base, { kind: "parallel", shockBp: 100 }), 360).rateAt(0);
    expect(p100 - p0).not.toBe(0);
    const r = runBook(handBook("PF-IH-BETA", [floaterPosition("F", "admin-hist")]), full, [E_FULL]);
    const s0 = interestIn(r, "S0");
    const s100 = interestIn(r, "S100");
    for (const k of [0, 1]) expect(s100[k]!).toBe(s0[k]!);
    const diff = s100[2]! - s0[2]!;
    expect(diff).not.toBe(0);
    expect(diff).toBeCloseTo((N * 0.5 * (p100 - p0)) / 12, 6);
  });

  it("(7) a run not given the history its lag reads is refused with the Task 3 sentence", () => {
    let caught: unknown;
    try {
      runBook(handBook("PF-IH-R", [floaterPosition("F", "lag-hist")]), full);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateIndexRefusedError);
    expect((caught as Error).message).toBe(REFUSAL);
  });
});

describe("Review Focus 2 and 6: Hull-White paths, shards and the stochastic run", () => {
  it("(4) every Hull-White path reads the same history months; the paths part at step 4", () => {
    const env = buildStochasticEnvironment(full, buildBaseCurve(full), { horizonMonths: 360, nPaths: 8, seed: 42n });
    const table = checkRateIndexRefs(handBook("PF-HW", [floaterPosition("F", "lag-hist")]), full, undefined, [E_FULL]).table!;
    for (const p of env.paths) {
      expect([0, 1, 2].map((t) => new ResolvedIndexPath(p, "lag-hist", table).rateAt(t))).toEqual([0.042, 0.0425, 0.043]);
    }
    expect(env.paths.some((p) => new ResolvedIndexPath(p, "lag-hist", table).rateAt(4) !== new ResolvedIndexPath(env.paths[0]!, "lag-hist", table).rateAt(4))).toBe(true);
  });

  it(
    "(5) a sharded run with history equals the inline run byte for byte (the months cross the worker clone on the table entry)",
    () => {
      const positions = manyFloaters(SHARD_CHUNK + 900);
      expect(positions.length).toBeGreaterThan(SHARD_CHUNK);
      const book = handBook("PF-IH-SHARD", positions);
      const inline = runBook(book, full, [E_FULL], { shards: 1 }, "IH-SHARD");
      const sharded = runBook(book, full, [E_FULL], { shards: 2 }, "IH-SHARD");
      expect(JSON.stringify(sharded)).toBe(JSON.stringify(inline));
    },
    300_000,
  );

  it("(6) a short Hull-White run with history is deterministic, and refused without it", () => {
    const book = handBook("PF-IH-STO", [floaterPosition("F", "lag-hist"), floaterPosition("G", "admin-hist")]);
    const request = (histories?: IndexHistoryEntry[]) =>
      makeRunRequest(full, {
        runId: "IH-STO",
        portfolioId: "PF-IH-STO",
        scenarios: [{ id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } }],
        assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
        grid: { horizonMonths: 360, asOf: AS_OF },
        ...(histories !== undefined ? { indexHistories: histories } : {}),
      });
    const first = runStochastic(request([E_FULL]), book, { nPaths: 20 });
    const second = runStochastic(request([E_FULL]), book, { nPaths: 20 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    let caught: unknown;
    try {
      runStochastic(request(), book, { nPaths: 20 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateIndexRefusedError);
    expect((caught as Error).message).toContain("and the run was not given that history");
  });
});

describe("the drill", () => {
  const S0: Scenario = { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "none", newBusiness: { mode: "static", rules: [] } };
  const floater = (rateIndexId: string): PositionTerms =>
    ({
      id: "drill-idx-1",
      type: "floating-loan",
      notional: 1_000_000,
      maturityMonths: 12,
      originationOffsetMonths: 0,
      amortType: "bullet",
      indexTenorMonths: 1,
      margin: 0.0125,
      resetFrequencyMonths: 1,
      rateIndexId,
    }) as unknown as PositionTerms;
  const input = (terms: PositionTerms, market: MarketSnapshot) => ({
    terms,
    familyId: "floaters",
    side: "asset" as const,
    marketSnapshot: market,
    scenarios: [S0],
    horizonMonths: 24,
  });

  it("(8) a lag-3 floater's first coupon is the 2025-12 fixing plus the margin; without the history the drill is refused", () => {
    const r = projectInstrument({ ...input(floater("lag-hist"), full), indexHistories: [E_FULL] });
    expect(r.byScenario[0]!.rows[0]!.couponRate).toBeCloseTo(0.042 + MARGIN, 12);
    expect(() => projectInstrument(input(floater("lag-hist"), full))).toThrow(RateIndexRefusedError);
  });
});

describe("the compiled request", () => {
  const open: Array<{ dispose(): void }> = [];
  afterEach(() => {
    while (open.length > 0) open.pop()!.dispose();
  });
  const STAMPS = { runId: "RUN-1", seed: "42", timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" } };
  function compileOn(market: MarketSnapshot, histories?: IndexHistoryEntry[]) {
    const b = twoSidedBook();
    const terms = { ...floaterPosition("F", "lag-hist").terms } as PositionTerms;
    const portfolio = { ...b, positions: [...b.positions, { id: "F", familyId: "FIXED", coaNodeId: "fixed-loans", terms }] };
    const c = compilePlan(
      fixturePlan(),
      { portfolio, marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES, ...(histories !== undefined ? { indexHistories: histories } : {}) },
      STAMPS,
    );
    open.push(c.harness);
    return c;
  }

  it("(9) carries the histories it was given, leaves the field out when given none, and refuses a lag whose history it was not given", () => {
    expect(compileOn(full, [E_FULL]).request.indexHistories).toEqual([E_FULL]);
    expect("indexHistories" in compileOn(plain, []).request).toBe(false);
    expect("indexHistories" in compileOn(plain).request).toBe(false);
    expect(() => compileOn(full)).toThrow(RateIndexRefusedError);
  });
});
