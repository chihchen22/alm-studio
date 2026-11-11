// apps/server/src/__tests__/swapCrossCheck.test.ts
/**
 * The cross-check on the SEEDED books.
 * Invariant 3 (containment), invariant 4's dEVE half, invariant 6 (intake),
 * and T7a (the derivative keys gated by family) on the seeded pair.
 * Two 2,351-position runs; the heaviest file of the piece.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildTLPCurve, DEFAULT_TLP_CURVE, loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { computeFtpResult, createEngine, resolveDefaultContext, type PortfolioSpec, type RunResult, type Scenario } from "@alm/engine";
import type { FtpResult } from "@alm/engine/src/contracts/results";
import { buildScenarioRatePath } from "@alm/engine/src/projection/static";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import { regimeAmplifiedPositionIds } from "@alm/engine/src/eve/keyRate";
import type { CustomMetricInput } from "@alm/engine/src/plugins/services";
import { clearPortfolios } from "@alm/engine/src/portfolio/registry";
import { computeBalanceSummary } from "@alm/engine/src/report/balanceSummary";
import { computeLcrRegulatory, computeLcrScenario } from "@alm/engine/src/report/lcr";
import { computeSurvivalHorizon } from "@alm/engine/src/report/survivalHorizon";
import { computeWalGap } from "@alm/engine/src/report/walGap";
import {
  buildHedgedPortfolio,
  buildLcrPortfolio,
  buildSyntheticPortfolio,
  HEDGE_SWAPS,
  SEED_IDS,
  withHedgeSwaps,
} from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

const GRID = [0, 100, -100, 200, -200];
let market: MarketSnapshot;
let unhedged: RunResult;
let hedged: RunResult;
let synthetic: PortfolioSpec;
let hedgedBook: PortfolioSpec;
let ftpUnhedged: FtpResult;
let ftpHedged: FtpResult;

function run(book: PortfolioSpec): RunResult {
  const scenarios: Scenario[] = GRID.map((bp) => ({
    id: `S${bp}`,
    label: `S${bp}`,
    rateSpec: bp === 0 ? { kind: "base" } : { kind: "parallel", shockBp: bp },
    assumptionSetId: "vanilla-empty-v1",
    newBusiness: { mode: "static", rules: [] },
  }));
  clearPortfolios();
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(book);
  return engine.run({
    runId: "XCHECK",
    portfolioId: book.id,
    marketSnapshot: market,
    scenarios,
    assumptionSets: [{ schemaVersion: "1.0.0", id: "vanilla-empty-v1", label: "empty", bindings: [] }],
    grid: { horizonMonths: 360, asOf: book.asOf },
    seed: "42",
    timestamps: { startedAt: "2026-09-22T00:00:00.000Z", finishedAt: "2026-09-22T00:00:01.000Z" },
  });
}

function input(book: PortfolioSpec, r: RunResult): CustomMetricInput {
  return {
    horizonMonths: 360,
    baseScenarioId: "S0",
    scenarios: r.cashflows.byScenario.map((sc) => ({ scenarioId: sc.scenarioId, assumptionSetId: "vanilla-empty-v1", cashflows: sc })),
    book,
  };
}

/**
 * FTP is not on the default run; it is computed directly for both books, on
 * the base scenario, with each book's own NII row as the bridge input.
 */
function ftp(book: PortfolioSpec, r: RunResult): FtpResult {
  const curve = buildBaseCurve(market);
  const tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
  const s0: Scenario = {
    id: "S0",
    label: "S0",
    rateSpec: { kind: "base" },
    assumptionSetId: "vanilla-empty-v1",
    newBusiness: { mode: "static", rules: [] },
  };
  return computeFtpResult({
    portfolio: book,
    scenarios: [s0],
    baseScenarioId: "S0",
    curve,
    tlp,
    path: buildScenarioRatePath(curve, s0, 360),
    horizonMonths: 360,
    niiBase: r.nii.byScenario.find((s) => s.scenarioId === "S0")!,
  });
}

beforeAll(async () => {
  market = await loadMarketSnapshot(fileURLToPath(new URL("../../../../packages/kernel/public/market_public.json", import.meta.url)));
  synthetic = buildSyntheticPortfolio();
  hedgedBook = buildHedgedPortfolio();
  unhedged = run(synthetic);
  hedged = run(hedgedBook);
  ftpUnhedged = ftp(synthetic, unhedged);
  ftpHedged = ftp(hedgedBook, hedged);
}, 600_000);

const eveOf = (r: RunResult, id: string) => r.eve.byScenario.find((s) => s.scenarioId === id)!;
const isSwapFamily = (book: PortfolioSpec, familyId: string) =>
  book.coa.families.find((f) => f.id === familyId)?.side === "derivative";

describe("invariant 3: containment on the seeded books", () => {
  it("pvAssets and pvLiabilities bit-identical; EVE differs by exactly pvDerivatives", () => {
    for (const a of unhedged.eve.byScenario) {
      const b = eveOf(hedged, a.scenarioId);
      expect([b.pvAssets, b.pvLiabilities], a.scenarioId).toEqual([a.pvAssets, a.pvLiabilities]);
      expect(b.eve, a.scenarioId).toBe(a.eve + b.pvDerivatives!);
    }
  });

  it("balance-summary and wal-gap bit-identical, with no swap row", () => {
    for (const metric of [computeBalanceSummary, computeWalGap]) {
      const a = metric(input(synthetic, unhedged));
      const b = metric(input(hedgedBook, hedged));
      for (let i = 0; i < a.byScenario.length; i++) {
        expect(b.byScenario[i]!.values, metric.name).toEqual(a.byScenario[i]!.values);
        expect(b.byScenario[i]!.byFamily, metric.name).toEqual(a.byScenario[i]!.byFamily);
      }
    }
  });

  it("FTP book totals and EVERY non-swap family row bit-identical; the swap row is zero (spec Section 12 item 5)", () => {
    expect(ftpHedged.book).toEqual(ftpUnhedged.book);
    const nonSwapHedged = ftpHedged.byFamily.filter((f) => !isSwapFamily(hedgedBook, f.familyId));
    expect(nonSwapHedged.map((f) => f.familyId)).toEqual(ftpUnhedged.byFamily.map((f) => f.familyId));
    for (const row of ftpUnhedged.byFamily) {
      expect(ftpHedged.byFamily.find((f) => f.familyId === row.familyId), row.familyId).toEqual(row);
    }
    const swapRow = ftpHedged.byFamily.find((f) => f.side === "derivative")!;
    expect([swapRow.positionCount, swapRow.notional, swapRow.margin12]).toEqual([0, 0, 0]);
  });
});

describe("invariant 3: the liquidity metrics, on the tagged twin of the same positions", () => {
  // synthetic-2500-v1 carries no hqla-level or lcr-category tag, so both LCR
  // arms and survival-horizon return {} on it and an equality would be
  // vacuous. synthetic-2500-lcr-v1 is the same generator call with tags added;
  // a tag moves no cash flow, so it reads the synthetic runs' flows.
  it("the tagged twin carries the same terms and family ids, position for position", () => {
    const tagged = buildLcrPortfolio();
    expect(tagged.positions.map((p) => p.terms)).toEqual(synthetic.positions.map((p) => p.terms));
    expect(tagged.positions.map((p) => p.familyId)).toEqual(synthetic.positions.map((p) => p.familyId));
  });

  it("both LCR arms and survival-horizon are live and bit-identical", () => {
    const tagged = buildLcrPortfolio();
    const taggedHedged = withHedgeSwaps(tagged, "lcr-hedged", "lcr hedged", HEDGE_SWAPS);
    for (const metric of [computeLcrScenario, computeLcrRegulatory, computeSurvivalHorizon]) {
      const a = metric(input(tagged, unhedged));
      const b = metric(input(taggedHedged, hedged));
      expect(Object.keys(a.byScenario[0]!.values).length, `${metric.name} returned no keys`).toBeGreaterThan(0);
      for (let i = 0; i < a.byScenario.length; i++) expect(b.byScenario[i]!.values, metric.name).toEqual(a.byScenario[i]!.values);
    }
  });
});

describe("invariant 4 (dEVE half): the seeded hedge halves the +200 bp loss", () => {
  it("hedged |dEVE(+200)| is smaller, within the probe's accepted band", () => {
    const d0 = eveOf(unhedged, "S200").deltaEveVsBase;
    const d1 = eveOf(hedged, "S200").deltaEveVsBase;
    const ratio = Math.abs(d1) / Math.abs(d0);
    expect(ratio, `unhedged ${d0} hedged ${d1} ratio ${ratio}`).toBeGreaterThanOrEqual(0.35);
    expect(ratio, `unhedged ${d0} hedged ${d1} ratio ${ratio}`).toBeLessThanOrEqual(0.65);
  });

  it("the key-rate half cannot run on this book: it carries a regime-amplified deposit family", () => {
    expect(regimeAmplifiedPositionIds(hedgedBook).length).toBeGreaterThan(0);
  });
});

describe("T7a: the derivative keys are gated by family on the seeded pair", () => {
  const DERIV_NII_KEYS = ["derivativesNet12", "derivativesNet24", "derivativesNetByHorizon"];
  it("the unhedged book has no pvDerivatives, no derivativesNet*, no FtpNimBridge.derivativesNet12", () => {
    for (const s of unhedged.eve.byScenario) expect("pvDerivatives" in s, s.scenarioId).toBe(false);
    for (const s of unhedged.nii.byScenario) expect(DERIV_NII_KEYS.filter((k) => k in s), s.scenarioId).toEqual([]);
    expect("derivativesNet12" in ftpUnhedged.nimBridge).toBe(false);
  });
  it("the hedged book has every one of them", () => {
    for (const s of hedged.eve.byScenario) expect("pvDerivatives" in s, s.scenarioId).toBe(true);
    for (const s of hedged.nii.byScenario) expect(DERIV_NII_KEYS.filter((k) => k in s), s.scenarioId).toEqual(DERIV_NII_KEYS);
    expect("derivativesNet12" in ftpHedged.nimBridge).toBe(true);
  });
});

describe("invariant 6, as Studio slice S3a-1 restates it: the seeded hedged book imports as itself", () => {
  let tp: TestPlatform;
  beforeAll(async () => {
    tp = await bootTestPlatform();
  }, 60_000);
  afterAll(async () => {
    await tp.close();
  });
  it("answers 201, stores the book byte for byte, and its sums leave the swaps out", async () => {
    const spec = { ...hedgedBook, id: `${SEED_IDS.hedgedPortfolio}-import` };
    const r = await api<{ id: string; warnings: string[] }>(tp.base, "POST", "/api/portfolios/import", spec);
    expect(r.status, r.text.slice(0, 600)).toBe(201);
    const back = await api<PortfolioSpec>(tp.base, "GET", `/api/portfolios/${spec.id}`);
    expect(JSON.stringify(back.body)).toBe(JSON.stringify(spec));
    const list = await api<Array<{ id: string; intakeStats?: { assets: number; liabilities: number } }>>(tp.base, "GET", "/api/portfolios");
    const stats = list.body.find((p) => p.id === spec.id)?.intakeStats;
    const famSide = new Map(spec.coa.families.map((f) => [f.id, f.side]));
    let assets = 0;
    let liabilities = 0;
    for (const p of spec.positions) {
      const side = famSide.get(p.familyId);
      if (side === "asset") assets += p.terms.notional;
      else if (side === "liability") liabilities += p.terms.notional;
    }
    expect(stats).toMatchObject({ assets, liabilities });
  });
});
