/**
 * The B3a index kinds through the run.
 *
 * Markets, both on the public pack:
 *   indexed:  the seeded rfr-1m, rfr-3m (basis 0) and prime-demo.
 *   formulas: indexed plus a ten-year constant-maturity swap (cms-10y) and three formulas:
 *             admin-rate (beta 0.4 on rfr-1m from 4.33 percent), cms-lag (beta 0.5 on cms-10y from 4 percent,
 *             three months late) and level-1 (coefficient 1 on rfr-3m, basis 0).
 *
 * The months before the cut-off read the parent's month-0 value on the run's UNSHOCKED base curve (spec v5
 * decision 45, ruling 2026-10-13, which amends decision 40), so a parallel scenario, a duration bump or a
 * key-rate leg reaches a beta index at month 0 and a lagged one at month lag. Expected values are restated as
 * arithmetic on fixture inputs, never read back from the code under test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, type MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { computeKeyRateDurations } from "../../eve/keyRate";
import { projectInstrument } from "../../instrument/projectInstrument";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { ResolvedIndexPath } from "../../rateIndex/indexSeries";
import { checkRateIndexRefs } from "../../rateIndex/resolve";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { buildStochasticEnvironment } from "../../scenario/stochasticEnvironment";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { resolveDefaultContext } from "../index";
import { runStochastic } from "../stochastic";
import { SHARD_CHUNK } from "../shard/chunk";
import { AS_OF, baseAssumptions, loadMarket, makeRunRequest } from "./fixtures";

const BASE_ID = "market-public-2026-03-31";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];
const FORMULA_OPS = [
  { op: "set-index", id: "cms-10y", label: "Ten-year swap rate (demonstration index)", kind: "constant-maturity-swap", tenorYears: 10, basisBp: 0 },
  { op: "set-index", id: "admin-rate", label: "Administered rate, 40 percent of the one-month change (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.4, startBp: 433, basisBp: 0 },
  { op: "set-index", id: "cms-lag", label: "Half the ten-year swap change, three months late (demonstration values)", kind: "formula", parent: "cms-10y", beta: 0.5, startBp: 400, lagMonths: 3, basisBp: 0 },
  { op: "set-index", id: "level-1", label: "The three-month rate through a formula (demonstration values)", kind: "formula", parent: "rfr-3m", coefficient: 1, basisBp: 0 },
];

let indexed: MarketSnapshot;
let formulas: MarketSnapshot;
beforeAll(async () => {
  indexed = deriveMarketSnapshot(structuredClone(await loadMarket()), SEED_OPS, { baseId: BASE_ID }).snapshot;
  formulas = deriveMarketSnapshot(structuredClone(indexed), FORMULA_OPS, { baseId: BASE_ID }).snapshot;
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

function runBook(book: PortfolioSpec, market: MarketSnapshot, extra?: Partial<RunPipelineContext>, runId = "IK-E2E") {
  return buildRunResult(
    makeRunRequest(market, {
      runId,
      portfolioId: book.id,
      assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
    }),
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

/** A mixed book spanning two chunks: a quarter each on the beta, the lagged beta, the level formula and its parent. */
function manyFloaters(n: number): Position[] {
  const ids = ["admin-rate", "cms-lag", "level-1", "rfr-3m"];
  const out: Position[] = [];
  for (let i = 0; i < n; i++) out.push(floaterPosition(`F${i}`, ids[i % 4], 100_000 + (i % 7) * 1_000));
  return out;
}

const N = 1_000_000;
const MARGIN = 0.0125;

describe("byte identity and the formula's arithmetic through the run", () => {
  it("(1) a book reading rfr-3m only runs byte-identically on a market that also carries unread formula indices", () => {
    const book = handBook("PF-IK-PLAIN", [floaterPosition("F", "rfr-3m")]);
    expect(numbers(runBook(book, formulas))).toBe(numbers(runBook(book, indexed)));
  });

  it("(2) a coefficient-1, basis-0 formula on rfr-3m gives every number of a floater on rfr-3m (1 x P + 0 is P)", () => {
    const viaFormula = runBook(handBook("PF-IK-LEVEL", [floaterPosition("F", "level-1")]), formulas);
    const viaParent = runBook(handBook("PF-IK-LEVEL", [floaterPosition("F", "rfr-3m")]), formulas);
    expect(numbers(viaFormula)).toBe(numbers(viaParent));
  });

  it("(3) a beta floater's month-1 interest on the base scenario is the start plus the margin", () => {
    const r = runBook(handBook("PF-IK-BETA", [floaterPosition("F", "admin-rate")]), formulas);
    expect(interestIn(r, "S0")[0]!).toBeCloseTo((N * (0.0433 + MARGIN)) / 12, 6);
  });
});

describe("Review Focus 1: a scenario shock reaches a beta index through the unshocked anchor (decision 45)", () => {
  const paths = () => {
    const base = buildBaseCurve(formulas);
    return {
      p0: buildRatePath(shockedCurve(base, { kind: "base" }), 360),
      p100: buildRatePath(shockedCurve(base, { kind: "parallel", shockBp: 100 }), 360),
    };
  };

  it("(4) +100 bp moves the beta floater's month-1 interest by beta x the month-0 move of its parent", () => {
    const { p0, p100 } = paths();
    const move = p100.rateAt(0) - p0.rateAt(0);
    expect(move).not.toBe(0);
    const r = runBook(handBook("PF-IK-S100", [floaterPosition("F", "admin-rate")]), formulas);
    const diff = interestIn(r, "S100")[0]! - interestIn(r, "S0")[0]!;
    expect(diff).not.toBe(0);
    expect(diff).toBeCloseTo((N * 0.4 * move) / 12, 6);
  });

  it("(5) a three-month lag holds the pre-shock value for months 1 to 3 and passes beta x the swap move at month 4", () => {
    const { p0, p100 } = paths();
    const c0 = p0.forwardRateAt(0, 10);
    const c100 = p100.forwardRateAt(0, 10);
    const r = runBook(handBook("PF-IK-LAG", [floaterPosition("F", "cms-lag")]), formulas);
    const s0 = interestIn(r, "S0");
    const s100 = interestIn(r, "S100");
    for (const k of [0, 1, 2]) expect(s100[k]!).toBe(s0[k]!);
    expect(s100[3]! - s0[3]!).not.toBe(0);
    expect(s100[3]! - s0[3]!).toBeCloseTo((N * 0.5 * (c100 - c0)) / 12, 6);
  });
});

describe("Review Focus 2: shards and stochastic paths", () => {
  it(
    "(6) the formula book sharded equals the inline run byte for byte",
    () => {
      const positions = manyFloaters(SHARD_CHUNK + 900);
      expect(positions.length).toBeGreaterThan(SHARD_CHUNK);
      const book = handBook("PF-IK-SHARD", positions);
      const inline = runBook(book, formulas, { shards: 1 }, "IK-SHARD");
      const sharded = runBook(book, formulas, { shards: 2 }, "IK-SHARD");
      expect(JSON.stringify(sharded)).toBe(JSON.stringify(inline));
    },
    300_000,
  );

  it("(7) a short Hull-White run is deterministic, and a level-1 floater's distributions equal an rfr-3m floater's", () => {
    const request = (market: MarketSnapshot, book: PortfolioSpec) =>
      makeRunRequest(market, {
        runId: "IK-STO",
        portfolioId: book.id,
        scenarios: [
          { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } },
        ],
        assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
        grid: { horizonMonths: 360, asOf: AS_OF },
      });
    const mixed = handBook("PF-IK-STO", [floaterPosition("F", "admin-rate"), floaterPosition("G", "cms-lag"), floaterPosition("H", "level-1")]);
    const first = runStochastic(request(formulas, mixed), mixed, { nPaths: 20 });
    const second = runStochastic(request(formulas, mixed), mixed, { nPaths: 20 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const level = handBook("PF-IK-STO-L", [floaterPosition("F", "level-1")]);
    const parent = handBook("PF-IK-STO-L", [floaterPosition("F", "rfr-3m")]);
    const viaFormula = runStochastic(request(formulas, level), level, { nPaths: 20 });
    const viaParent = runStochastic(request(formulas, parent), parent, { nPaths: 20 });
    expect(viaFormula.eveDistribution).toEqual(viaParent.eveDistribution);
    expect(viaFormula.nii12mDistribution).toEqual(viaParent.nii12mDistribution);
  });
});

describe("Review Focus 4: Hull-White paths", () => {
  it("(8) a lag-3 beta index on the swap holds its 4 percent start for steps 0 to 3 on every path and first moves at step 4", () => {
    const curve = buildBaseCurve(formulas);
    const env = buildStochasticEnvironment(formulas, curve, { horizonMonths: 360, nPaths: 8, seed: 42n });
    const table = checkRateIndexRefs(handBook("PF-HW", [floaterPosition("F", "cms-lag")]), formulas).table!;
    for (const p of env.paths) {
      const idx = new ResolvedIndexPath(p, "cms-lag", table);
      for (const t of [0, 1, 2, 3]) expect(idx.rateAt(t)).toBe(0.04);
    }
    expect(env.paths.some((p) => new ResolvedIndexPath(p, "cms-lag", table).rateAt(4) !== 0.04)).toBe(true);
  });
});

describe("Review Focus 5: key rates and the drill", () => {
  it("(9) key rates: a level-1 floater measures as an rfr-3m floater, and a beta floater's parallel reference differs from its parent's", () => {
    // The run's own curve, so the anchors match it; the zero TLP is the pattern of eve/__tests__/keyRate.test.ts.
    const curve = buildBaseCurve(formulas);
    const tlp = buildTLPCurve([{ tYears: 1, spread: 0 }]);
    const kr = (id: string) =>
      computeKeyRateDurations({
        portfolio: handBook("PF-KR", [floaterPosition("F", id)]),
        scenarioId: "S0",
        curve,
        tlp,
        horizonMonths: 360,
        rateIndices: checkRateIndexRefs(handBook("PF-KR", [floaterPosition("F", id)]), formulas).table,
      });
    expect(JSON.stringify(kr("level-1"))).toBe(JSON.stringify(kr("rfr-3m")));
    const beta = kr("admin-rate").parallelReference;
    expect(Number.isFinite(beta)).toBe(true);
    expect(beta).not.toBe(kr("rfr-1m").parallelReference);
  });

  it("(10) the drill: a level-1 floater's rows equal an rfr-3m floater's, and a beta floater's first coupon is start plus margin", () => {
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
    expect(projectInstrument(input(floater("level-1"), formulas)).byScenario[0]!.rows).toEqual(
      projectInstrument(input(floater("rfr-3m"), formulas)).byScenario[0]!.rows,
    );
    expect(projectInstrument(input(floater("admin-rate"), formulas)).byScenario[0]!.rows[0]!.couponRate).toBeCloseTo(0.0433 + 0.0125, 12);
  });
});
