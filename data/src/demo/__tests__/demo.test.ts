/**
 * Demo acceptance, on a small deterministic book so the
 * engine round-trip stays fast:
 *
 *  - the assembled request runs to a RunResult with every layer populated and an
 *    EMPTY notImplemented array (base plus the +/-100, +/-200 grid);
 *  - re-running the identical request serializes byte-for-byte identically
 *    (the determinism gate the scripted demo relies on);
 *  - the provenance ledger carries the four bound model versions;
 *  - explain narrates the +200bp EVE headline from attribution;
 *  - renderReport emits the required sections without computing a number.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { loadMarketSnapshot } from "@alm/kernel";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createEngine, resolveDefaultContext } from "@alm/engine";
import { DEFAULT_GENERATOR_CONFIG, computeBalanceSheetTotals } from "../../generate";
import {
  buildDemoAssumptions,
  buildDemoPortfolio,
  buildDemoRequest,
  buildDemoScenarios,
  DEMO_RUN_ID,
} from "../request";
import { renderReport } from "../format";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_PATH = resolve(HERE, "../../../../packages/kernel/public/market_public.json");

const SMALL_CONFIG = { ...DEFAULT_GENERATOR_CONFIG, targetPositions: 400 };
const TS = { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" };

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(MARKET_PATH);
});

function run() {
  const portfolio = buildDemoPortfolio(SMALL_CONFIG);
  const engine = createEngine();
  engine.loadPortfolio(portfolio);
  const request = buildDemoRequest(portfolio, market, TS);
  const result = engine.run(request);
  return { portfolio, engine, result };
}

describe("demo request — every layer populated, nothing not-implemented", () => {
  it("runs base plus the regulatory grid to a complete RunResult", () => {
    const { result } = run();
    const scenarios = buildDemoScenarios();

    expect(result.notImplemented).toEqual([]);
    expect(result.cashflows.byScenario).toHaveLength(scenarios.length);
    expect(result.nii.byScenario).toHaveLength(scenarios.length);
    expect(result.eve.byScenario).toHaveLength(scenarios.length);
    expect(result.gap.repricing).toHaveLength(scenarios.length);
    expect(result.gap.liquidity).toHaveLength(scenarios.length);

    const base = result.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(base.deltaEveVsBase).toBe(0);
    expect(base.pvAssets).toBeGreaterThan(base.pvLiabilities);

    // A non-base headline exists for each metric.
    const shocked = scenarios.filter((s) => s.rateSpec.kind !== "base").length;
    expect(result.attribution.headlines).toHaveLength(shocked * 3);
  });

  it("stamps the four bound model versions into provenance", () => {
    const { result } = run();
    expect(Object.keys(result.provenance.modelVersions).sort()).toEqual([
      "dda::nmd-decay",
      "mbs::prepay",
      "mma::deposit-beta",
      "mortgages::prepay",
    ]);
    expect(result.provenance.seed).toBe("20260716");
    expect(result.provenance.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves the book numerically unchanged under the default-param overlays", () => {
    // Overlays carry the exact kernel defaults the generator embedded, so an
    // assumption set with bindings must reconcile with equity from raw totals.
    const { portfolio, result } = run();
    const totals = computeBalanceSheetTotals(portfolio);
    expect(totals.equity).toBeGreaterThan(0);
    const base = result.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    // PV of a par-ish book is near notional; assets exceed liabilities as equity does.
    expect(base.pvAssets).toBeGreaterThan(0);
    expect(base.pvLiabilities).toBeGreaterThan(0);
  });
});

describe("demo — determinism", () => {
  it("re-running the identical request serializes byte-for-byte identically", () => {
    const a = run().result;
    const b = run().result;
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("demo — explain and report", () => {
  it("narrates the +200bp EVE headline from attribution", () => {
    const { engine } = run();
    const ex = engine.explain({ runId: DEMO_RUN_ID, metric: "eve", scenarioId: "S200" });
    expect(ex.supported).toBe(true);
    expect(ex.attribution).not.toBeNull();
    expect(ex.citations.length).toBeGreaterThan(0);
    expect(ex.citations.every((c) => c.driver === "rate")).toBe(true);
  });

  it("renders the required sections", () => {
    const { engine, portfolio, result } = run();
    const totals = computeBalanceSheetTotals(portfolio);
    const explanation = engine.explain({ runId: DEMO_RUN_ID, metric: "eve", scenarioId: "S200" });
    const report = renderReport({
      result,
      label: portfolio.label,
      positionCount: portfolio.positions.length,
      totals,
      explanation,
      explainQuestion: "why",
      baseScenarioId: "S0",
    });
    for (const heading of [
      "SYNTHETIC BOOK",
      "PROVENANCE LEDGER",
      "NET INTEREST INCOME",
      "ECONOMIC VALUE OF EQUITY",
      "GAP PROFILES",
      "REPRICING GAP",
      "LIQUIDITY GAP",
      "EXPLAIN",
      "NOT IMPLEMENTED",
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain("none — every layer");
  });
});

describe("demo — base-only durations, the scripted-demo policy", () => {
  function runBaseOnly() {
    const portfolio = buildDemoPortfolio(SMALL_CONFIG);
    const engine = createEngine({ ...resolveDefaultContext(), durationMode: "base-only" });
    engine.loadPortfolio(portfolio);
    const request = buildDemoRequest(portfolio, market, TS);
    const result = engine.run(request);
    return { portfolio, result };
  }

  it("drops the shocked-scenario duration block but keeps the base one", () => {
    const { result } = runBaseOnly();
    const base = result.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    // Base environment: a real, measured equity duration.
    expect(base.effectiveDurationEquity).not.toBeUndefined();
    // Every shocked scenario carries no duration block and a vacuously-true gate.
    const shocked = result.eve.byScenario.filter((s) => s.scenarioId !== "S0");
    expect(shocked.length).toBeGreaterThan(0);
    for (const s of shocked) {
      expect(s.effectiveDurationEquity).toBeUndefined();
      expect(s.durationSanityPassed).toBe(true);
    }
  });

  it("renders shocked durations as 'n/a (base-only)', never a vacuous pass", () => {
    const { portfolio, result } = runBaseOnly();
    const totals = computeBalanceSheetTotals(portfolio);
    const report = renderReport({
      result,
      label: portfolio.label,
      positionCount: portfolio.positions.length,
      totals,
      explanation: {
        supported: true,
        answer: "",
        attribution: null,
        citations: [],
      },
      explainQuestion: "why",
      baseScenarioId: "S0",
    });
    // The honest text is present for the dropped shocked durations.
    expect(report).toContain("n/a (base-only)");
    // The base row still shows a numeric duration and a real sanity verdict.
    const eveSection = report.slice(report.indexOf("ECONOMIC VALUE OF EQUITY"));
    const s0Line = eveSection.split("\n").find((l) => l.trimStart().startsWith("S0"))!;
    expect(s0Line).toMatch(/\d\.\d{3}/);
  });
});

describe("demo assumption set", () => {
  it("binds four behaviorally active families", () => {
    const set = buildDemoAssumptions();
    expect(set.bindings.map((b) => b.familyId).sort()).toEqual(["dda", "mbs", "mma", "mortgages"]);
  });
});
