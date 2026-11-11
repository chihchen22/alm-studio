/**
 * Rate indices through the run entry and the static pass (sub-part S2a). Hand book H: family "floaters", one bullet floater F (N 1e6, 12
 * months, margin 0.0125, monthly). Book A names no index, B names "prime-demo"
 * (a 300 bp one-month basis), C names "rfr-1m" (tenor 1, basis 0). The market is
 * the public pack with the three seeded indices derived onto it.
 *
 * Sub-part S2c turns on the end-to-end cases: the basis delta (a), the identity
 * (b) and the key-rate, channel and effective-duration legs (g). Sub-part S2d
 * adds the stochastic zero-vol and calibrated legs (f) and the dynamic
 * new-business leg (j), which proves the balance stage hands the table to the
 * dynamic projection.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapZeroCurve, buildTLPCurve, type MarketSnapshot } from "@alm/kernel";
import type { MarketWithIndices } from "../../contracts/rateIndex";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { RateIndexRefusedError, RateIndexUnresolvedError } from "../../rateIndex/resolve";
import { computeKeyRateDurations } from "../../eve/keyRate";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { rateIndexTable } from "../../rateIndex/rateIndices";
import { buildCellPlan } from "../../portfolio/cells";
import { clearPortfolios } from "../../portfolio/registry";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { createEngine, resolveDefaultContext } from "../index";
import { runStochastic } from "../stochastic";
import { projectDynamicScenario } from "../../projection/dynamic";
import type { Scenario } from "../../contracts/scenario";
import { SHARD_CHUNK } from "../shard/chunk";
import { runStaticPass, type StaticPassGroup } from "../shard/staticPass";
import { AS_OF, baseAssumptions, loadMarket, makeRunRequest } from "./fixtures";

const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];

let plain: MarketSnapshot;
let indexed: MarketSnapshot;
beforeAll(async () => {
  plain = await loadMarket();
  indexed = deriveMarketSnapshot(structuredClone(plain), SEED_OPS, { baseId: "market-public-2026-03-31" }).snapshot;
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

describe("run entry refusal (c)", () => {
  it("refuses B on the plain public market with the exact text, before any number", () => {
    clearPortfolios();
    const book = handBook("PF-B", [floaterPosition("F", "prime-demo")]);
    const engine = createEngine(resolveDefaultContext());
    engine.loadPortfolio(book);
    const request = makeRunRequest(plain, { runId: "RI-B-PLAIN", portfolioId: book.id });
    let caught: unknown;
    try {
      engine.run(request);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateIndexRefusedError);
    expect((caught as Error).message).toBe(
      'run refused: 1 position(s) name a rate index the run cannot resolve, and a floater never falls back to the one-month benchmark: position "F" names rate index "prime-demo", which the run\'s market does not carry (it carries none)',
    );
  });

  it("does not read the block, or refuse, for book A on the plain market", () => {
    clearPortfolios();
    const book = handBook("PF-A", [floaterPosition("F")]);
    const engine = createEngine(resolveDefaultContext());
    engine.loadPortfolio(book);
    const request = makeRunRequest(plain, { runId: "RI-A-PLAIN", portfolioId: book.id });
    // The later stages are not reached by this assertion; only the refusal is.
    try {
      engine.run(request);
    } catch (e) {
      expect(e).not.toBeInstanceOf(RateIndexRefusedError);
    }
  });
});

function runBook(book: PortfolioSpec, market: MarketSnapshot, extra?: Partial<RunPipelineContext>, runId = "RI-E2E") {
  return buildRunResult(
    makeRunRequest(market, {
      runId,
      portfolioId: book.id,
      // The hand book has one family, so the fixture set (mortgage, deposit bindings) carries no binding here.
      assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
    }),
    book,
    { ...resolveDefaultContext(), ...extra },
  );
}

type E2eResult = ReturnType<typeof runBook>;

function floatersSeries(r: E2eResult, scenarioId: string) {
  const sc = r.cashflows.byScenario.find((s) => s.scenarioId === scenarioId)!;
  return sc.byFamily.find((f) => f.familyId === "floaters")!.series;
}

describe("end to end through gap, FTP and EVE (S2c)", () => {
  it("(a) basis is static in every scenario: B minus A is 30000 in S0 and S100, 2500 per bucket 0..11", () => {
    const a = runBook(handBook("PF-A-E2E", [floaterPosition("F")]), indexed);
    const b = runBook(handBook("PF-B-E2E", [floaterPosition("F", "prime-demo")]), indexed);
    for (const sid of ["S0", "S100"]) {
      const na = a.nii.byScenario.find((s) => s.scenarioId === sid)!;
      const nb = b.nii.byScenario.find((s) => s.scenarioId === sid)!;
      // 300 bp on 1,000,000 for 12 months of interest, restated: 0.03 * 1e6 = 30000.
      expect(nb.totalNet12 - na.totalNet12).toBeCloseTo(30000, 6);
      const sa = floatersSeries(a, sid);
      const sb = floatersSeries(b, sid);
      for (let k = 0; k < 12; k++) {
        // 1e6 * 0.03 / 12 = 2500 per month.
        expect(sb.interest[k]! - sa.interest[k]!).toBeCloseTo(2500, 9);
      }
      expect(sb.principal).toEqual(sa.principal);
    }
  });

  it("(b) identity: book C (tenor 1, basis 0) equals book A with provenance removed, schema 1.13.0", () => {
    const a = runBook(handBook("PF-ID", [floaterPosition("F")]), indexed, undefined, "RI-ID");
    const c = runBook(handBook("PF-ID", [floaterPosition("F", "rfr-1m")]), indexed, undefined, "RI-ID");
    expect(a.schemaVersion).toBe("1.13.0");
    expect(c.schemaVersion).toBe("1.13.0");
    const strip = (r: E2eResult) => {
      const { provenance: _p, ...rest } = r;
      return rest;
    };
    expect(strip(c)).toEqual(strip(a));
  });

  it("(g) key-rate, channels and effective duration complete on an indexed book and move with the index", () => {
    const opts: Partial<RunPipelineContext> = { keyRate: true, eveChannels: true };
    const a = runBook(handBook("PF-KR-A", [floaterPosition("F")]), indexed, opts, "RI-KR");
    const b = runBook(handBook("PF-KR-B", [floaterPosition("F", "prime-demo")]), indexed, opts, "RI-KR");
    expect(b.eve.keyRate).toBeDefined();
    expect(a.eve.keyRate).toBeDefined();
    expect(b.eve.keyRate!.nodes.length).toBe(a.eve.keyRate!.nodes.length);
    // The 300 bp basis adds a fixed stream on top of the reset leg: the key-rate nodes must differ.
    const nodeDur = (r: E2eResult) => r.eve.keyRate!.nodes.map((n) => n.duration);
    expect(nodeDur(b)).not.toEqual(nodeDur(a));
    expect(b.eve.keyRate!.sum).not.toBe(a.eve.keyRate!.sum);
    expect(b.eve.channels).toBeDefined();
    const s0 = (r: E2eResult) => r.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(s0(b).eve).toBeGreaterThan(s0(a).eve);
    expect(s0(b).effectiveDurationEquity).toBeDefined();
    expect(s0(b).effectiveDurationEquity).not.toBe(s0(a).effectiveDurationEquity);
    expect(b.eve.channels!.byScenario.length).toBe(a.eve.channels!.byScenario.length);
  });

  it("(g) without the table the factory refuses key-rate legs rather than computing a base-rate number", () => {
    const book = handBook("PF-KR-NOTBL", [floaterPosition("F", "prime-demo")]);
    expect(() =>
      computeKeyRateDurations({
        portfolio: book,
        scenarioId: "S0" as never,
        curve: bootstrapZeroCurve(indexed),
        tlp: buildTLPCurve([{ tYears: 1, spread: 0 }]),
        horizonMonths: 360,
      }),
    ).toThrow(RateIndexUnresolvedError);
  });
});

/** A mixed book spanning several chunks: three of every four floaters indexed. */
function manyFloaters(n: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < n; i++) {
    const id = `F${i}`;
    const idx = i % 4 === 0 ? undefined : i % 4 === 1 ? "prime-demo" : i % 4 === 2 ? "rfr-3m" : "rfr-1m";
    out.push(floaterPosition(id, idx, 100_000 + (i % 7) * 1_000));
  }
  return out;
}

describe("static pass shard parity with an index table (e)", () => {
  const HORIZON = 24;
  const pathFor = (market: MarketSnapshot) => buildRatePath(shockedCurve(buildBaseCurve(market), { kind: "base" }), HORIZON);

  it("inline equals forced shards byte for byte, and the index reaches the workers", () => {
    const positions = manyFloaters(SHARD_CHUNK + 900);
    expect(positions.length).toBeGreaterThan(SHARD_CHUNK);
    const book = handBook("PF-SHARD-RI", positions);
    const cellPlan = buildCellPlan(book, undefined);
    const table = rateIndexTable((indexed as MarketWithIndices).rateIndices);
    const groups = (): StaticPassGroup[] => [
      { positions, scenarios: [{ scenarioId: "S0", rateSpec: { kind: "base" }, path: pathFor(indexed) }] },
    ];
    const run = (shards: number, tbl: typeof table | undefined) =>
      runStaticPass(groups(), cellPlan, HORIZON, shards, indexed, undefined, tbl).get("S0")!;
    const inline = run(1, table);
    const sharded = run(2, table);
    for (const key of ["balance", "principal", "interest", "repricing", "gapPrincipal"] as const) {
      expect(Array.from(sharded[key][0]!)).toEqual(Array.from(inline[key][0]!));
    }
    // Nonzero and indexed: the 300 bp prime-demo positions pay more than the same book with no index named.
    const unindexed = positions.map((p) => floaterPosition(p.id, undefined, (p.terms as { notional: number }).notional));
    const base = runStaticPass(
      [{ positions: unindexed, scenarios: [{ scenarioId: "S0", rateSpec: { kind: "base" }, path: pathFor(indexed) }] }],
      cellPlan,
      HORIZON,
      1,
      indexed,
    ).get("S0")!;
    const sumInterest = (s: typeof inline) => s.interest[0]!.reduce((a, b) => a + b, 0);
    expect(sumInterest(inline)).toBeGreaterThan(sumInterest(base));
    // Lower bound on the lift: 1/4 of the positions carry prime-demo, +300 bp over 12 months on >= 100000 each.
    const primeCount = positions.filter((_, i) => i % 4 === 1).length;
    expect(sumInterest(inline) - sumInterest(base)).toBeGreaterThan(primeCount * 100_000 * 0.03 * 0.99);
  });

  it("refuses to build an indexed floater when no table is passed", () => {
    const positions = [floaterPosition("F", "prime-demo")];
    const book = handBook("PF-NOTABLE", positions);
    expect(() =>
      runStaticPass(
        [{ positions, scenarios: [{ scenarioId: "S0", rateSpec: { kind: "base" }, path: pathFor(indexed) }] }],
        buildCellPlan(book, undefined),
        HORIZON,
        1,
        indexed,
      ),
    ).toThrow(/names rate index "prime-demo", which this call was not given/);
  });
});

describe("stochastic runs on an indexed book (f)", () => {
  const horizon = 360;
  function stochRequest(book: PortfolioSpec, market: MarketSnapshot) {
    return makeRunRequest(market, {
      runId: "RI-STO",
      portfolioId: book.id,
      scenarios: [
        { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } },
      ],
      assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
      grid: { horizonMonths: horizon, asOf: AS_OF },
    });
  }

  it("zero-vol per-path EVE of B equals B's deterministic EVE within 1e-6 relative, and differs from A's", () => {
    const bookA = handBook("PF-STO-A", [floaterPosition("F")]);
    const bookB = handBook("PF-STO-B", [floaterPosition("F", "prime-demo")]);
    const detB = runBook(bookB, indexed, undefined, "RI-STO-DET").eve.byScenario.find((s) => s.scenarioId === "S0")!.eve;
    const detA = runBook(bookA, indexed, undefined, "RI-STO-DET").eve.byScenario.find((s) => s.scenarioId === "S0")!.eve;
    const opts = { nPaths: 32, modelParams: { a: 0.05, sigma: 0, reason: "zero-vol indexed anchor" } };
    const stoB = runStochastic(stochRequest(bookB, indexed), bookB, opts);
    const stoA = runStochastic(stochRequest(bookA, indexed), bookA, opts);
    // Zero vol: every path is the deterministic path, so the in-arrears compounding of the
    // path's own one-month resets equals the curve's simple forward and the distribution is a point mass.
    expect(Math.abs(stoB.eveDistribution.mean - detB) / Math.abs(detB)).toBeLessThan(1e-6);
    expect(Math.abs(stoA.eveDistribution.mean - detA) / Math.abs(detA)).toBeLessThan(1e-6);
    expect(stoB.eveDistribution.mean).not.toBeCloseTo(stoA.eveDistribution.mean, 0);
    expect(stoB.eveDistribution.mean).toBeGreaterThan(stoA.eveDistribution.mean);
  });

  it("a short calibrated run on B completes with finite distributions", () => {
    const bookB = handBook("PF-STO-CAL", [floaterPosition("F", "prime-demo"), floaterPosition("G", "rfr-3m")]);
    const sto = runStochastic(stochRequest(bookB, indexed), bookB, { nPaths: 20 });
    expect(Number.isFinite(sto.eveDistribution.mean)).toBe(true);
    expect(Number.isFinite(sto.nii12mDistribution.mean)).toBe(true);
    expect(sto.eveDistribution.nPaths).toBe(20);
  });

  it("refuses at the stochastic entry when the market lacks the index, before any path is simulated", () => {
    const bookB = handBook("PF-STO-REF", [floaterPosition("F", "prime-demo")]);
    expect(() => runStochastic(stochRequest(bookB, plain), bookB, { nPaths: 20 })).toThrow(RateIndexRefusedError);
  });
});

describe("dynamic new business on an indexed book (j)", () => {
  /** Two families: floaters (F, indexed or not) and fixed (G, a 6 month 4% bullet). */
  function twoFamilyBook(id: string, rateIndexId?: string): PortfolioSpec {
    const book = handBook(id, [floaterPosition("F", rateIndexId)]);
    book.coa = {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "floaters", label: "Floaters", parentId: "assets", side: "asset", isLeaf: true, familyId: "floaters", order: 0 },
        { id: "fixed", label: "Fixed", parentId: "assets", side: "asset", isLeaf: true, familyId: "fixed", order: 1 },
      ],
      families: [
        { id: "floaters", label: "Floaters", side: "asset", instrumentType: "floating-loan", coaNodeId: "floaters" },
        { id: "fixed", label: "Fixed", side: "asset", instrumentType: "fixed-loan", coaNodeId: "fixed" },
      ],
    };
    const g = {
      id: "G",
      type: "fixed-loan",
      notional: 1_000_000,
      maturityMonths: 6,
      originationOffsetMonths: 0,
      amortType: "bullet",
      coupon: 0.04,
    } as unknown as PositionTerms;
    book.positions.push({ id: "G", familyId: "fixed", coaNodeId: "fixed", terms: g });
    return book;
  }

  const dynamicScenario: Scenario = {
    id: "S0",
    label: "S0 dynamic",
    rateSpec: { kind: "base" },
    assumptionSetId: "AS-BASE",
    newBusiness: { mode: "dynamic", rules: [{ familyId: "fixed", reinvest: "runoff", termMonths: 12 }] },
  };

  function runDynamic(book: PortfolioSpec) {
    return buildRunResult(
      makeRunRequest(indexed, {
        runId: "RI-DYN",
        portfolioId: book.id,
        scenarios: [dynamicScenario],
        assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
      }),
      book,
      resolveDefaultContext(),
    );
  }

  const seriesOf = (r: ReturnType<typeof runDynamic>, family: string) =>
    r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((f) => f.familyId === family)!.series;

  it("completes on B2; floaters delta is 2500 per bucket 0..11, principal identical, fixed family toEqual", () => {
    const a2 = runDynamic(twoFamilyBook("PF-DYN-A", undefined));
    const b2 = runDynamic(twoFamilyBook("PF-DYN-B", "prime-demo"));
    const fa = seriesOf(a2, "floaters");
    const fb = seriesOf(b2, "floaters");
    for (let k = 0; k < 12; k++) {
      // 1e6 * 0.03 / 12 = 2500 per month, restated.
      expect(fb.interest[k]! - fa.interest[k]!).toBeCloseTo(2500, 9);
    }
    expect(fb.principal).toEqual(fa.principal);
    // Reinvested tranches are fixed bullets and read no index: the rule family's series is identical.
    expect(seriesOf(b2, "fixed")).toEqual(seriesOf(a2, "fixed"));
    // The reinvestment really happened: the fixed family carries interest past its own 6 month maturity.
    expect(seriesOf(b2, "fixed").interest[8]!).toBeGreaterThan(0);
  });

  it("projectDynamicScenario without the table throws on B2: the parameter is the path the index reaches", async () => {
    const book = twoFamilyBook("PF-DYN-DIRECT", "prime-demo");
    const path = buildRatePath(shockedCurve(buildBaseCurve(indexed), { kind: "base" }), 360);
    const leg = { scenario: dynamicScenario, ratePath: path };
    const grid = { horizonMonths: 36, asOf: AS_OF };
    expect(() => projectDynamicScenario(book, leg, grid)).toThrow(RateIndexUnresolvedError);
    const ok = projectDynamicScenario(book, leg, grid, undefined, rateIndexTable((indexed as MarketWithIndices).rateIndices));
    expect(ok.cashflows.byFamily.length).toBe(2);
  });
});
