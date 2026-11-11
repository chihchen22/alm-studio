/**
 * Run-orchestrator acceptance.
 *
 *  - A base-plus-regulatory-grid run produces a RunResult with every layer
 *    populated (cashflows, NII, EVE, gap, attribution, provenance) and an EMPTY
 *    notImplemented array.
 *  - Re-running the same request yields a byte-identical serialized RunResult
 *    (the determinism gate).
 *  - queryResults returns a slice equal to the cached result and throws on an
 *    unknown runId; it never recomputes.
 *  - explain narrates a supported headline from attribution, and returns
 *    supported=false with an honest answer where attribution cannot support it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { clearPortfolios } from "../../portfolio/registry";
import { createEngine, type EngineTools } from "../index";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function freshEngine(): EngineTools {
  clearPortfolios();
  const engine = createEngine();
  engine.loadPortfolio(twoSidedBook());
  return engine;
}

describe("run — all layers populated, nothing not-implemented", () => {
  it("populates every RunResult layer over the regulatory grid", () => {
    const engine = freshEngine();
    const req = makeRunRequest(market);
    const result = engine.run(req);

    expect(result.notImplemented).toEqual([]);

    // Cashflows: one ScenarioCashflows per scenario, every family present.
    expect(result.cashflows.byScenario).toHaveLength(req.scenarios.length);
    for (const sc of result.cashflows.byScenario) {
      expect(sc.byFamily.map((f) => f.familyId).sort()).toEqual(["DDA", "FIXED", "MMA", "MORTGAGE"]);
      for (const fam of sc.byFamily) {
        expect(fam.series.balance).toHaveLength(req.grid.horizonMonths);
      }
    }

    // NII: horizons and per-scenario totals.
    expect(result.nii.horizonsMonths).toEqual([12, 24]);
    expect(result.nii.byScenario).toHaveLength(req.scenarios.length);
    for (const scn of result.nii.byScenario) expect(Number.isFinite(scn.totalNet12)).toBe(true);

    // EVE: base delta zero, a defined sane equity duration, positive equity.
    expect(result.eve.discountBasis).toBe("all-in");
    const baseEve = result.eve.byScenario.find((r) => r.scenarioId === "S0")!;
    expect(baseEve.deltaEveVsBase).toBe(0);
    expect(baseEve.durationSanityPassed).toBe(true);
    expect(baseEve.effectiveDurationEquity).toBeDefined();
    expect(baseEve.pvAssets).toBeGreaterThan(baseEve.pvLiabilities);

    // Gap: a repricing and a liquidity ladder per scenario.
    expect(result.gap.repricing).toHaveLength(req.scenarios.length);
    expect(result.gap.liquidity).toHaveLength(req.scenarios.length);
    for (const ladder of result.gap.repricing) expect(ladder.rows.length).toBeGreaterThan(0);

    // Attribution: a headline for each non-base scenario x each metric.
    const shocked = req.scenarios.filter((s) => s.rateSpec.kind !== "base").length;
    expect(result.attribution.headlines).toHaveLength(shocked * 3);
    for (const h of result.attribution.headlines) {
      expect(h.contributions.length).toBe(4 * 7); // 4 families x 7 drivers
      expect(Number.isFinite(h.residual)).toBe(true);
    }

    // Provenance: hashes, seed, sorted model versions, injected timestamps.
    expect(result.provenance.runId).toBe(req.runId);
    expect(result.provenance.seed).toBe(req.seed);
    expect(result.provenance.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(result.provenance.modelVersions)).toEqual([
      "DDA::nmd-decay",
      "MMA::deposit-beta",
      "MORTGAGE::prepay",
    ]);
    expect(result.provenance.timestamps).toEqual(req.timestamps);
  });

  it("attributes a rate-only shock entirely to the rate driver, residual ~0", () => {
    const engine = freshEngine();
    const result = engine.run(makeRunRequest(market));

    const h = result.attribution.headlines.find(
      (x) => x.metric === "eve" && x.scenarioId === "S200",
    )!;
    expect(Math.abs(h.residual)).toBeLessThan(1e-3);
    const rate = h.contributions.filter((c) => c.driver === "rate");
    const nonRate = h.contributions.filter((c) => c.driver !== "rate");
    const sumRate = rate.reduce((a, c) => a + c.amount, 0);
    expect(sumRate).toBeCloseTo(h.totalDelta, 6);
    for (const c of nonRate) expect(c.amount).toBe(0);
  });
});

describe("run — determinism (byte identity)", () => {
  it("re-running the same request serializes byte-for-byte identically", () => {
    const engine = freshEngine();
    const req = makeRunRequest(market);
    const a = engine.run(req);
    const b = engine.run(req);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("is identical across two independent engine instances", () => {
    clearPortfolios();
    const e1 = createEngine();
    e1.loadPortfolio(twoSidedBook());
    const r1 = e1.run(makeRunRequest(market));
    clearPortfolios();
    const e2 = createEngine();
    e2.loadPortfolio(twoSidedBook());
    const r2 = e2.run(makeRunRequest(market));
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
  });
});

describe("queryResults — cache read, never recompute", () => {
  it("returns a slice equal to the cached result", () => {
    const engine = freshEngine();
    const result = engine.run(makeRunRequest(market));

    const nii = engine.queryResults({ runId: "RUN-1", metric: "nii" });
    expect(nii.runId).toBe("RUN-1");
    expect(nii.data).toEqual(result.nii);

    const eve = engine.queryResults({ runId: "RUN-1", metric: "eve", scenarioId: "S200" });
    expect(eve.data).toEqual(result.eve.byScenario.find((s) => s.scenarioId === "S200"));

    const repr = engine.queryResults({ runId: "RUN-1", metric: "repricing-gap", scenarioId: "S0" });
    expect(repr.data).toEqual(result.gap.repricing.find((l) => l.scenarioId === "S0"));

    const cf = engine.queryResults({
      runId: "RUN-1",
      metric: "cashflows",
      scenarioId: "S0",
      familyId: "FIXED",
    });
    expect(cf.data).toEqual(
      result.cashflows.byScenario
        .find((s) => s.scenarioId === "S0")!
        .byFamily.find((f) => f.familyId === "FIXED"),
    );
  });

  it("throws on an unknown runId", () => {
    const engine = freshEngine();
    engine.run(makeRunRequest(market));
    expect(() => engine.queryResults({ runId: "NOPE", metric: "nii" })).toThrow(/NOPE/);
  });

  it("throws on an unknown scenario within a known run", () => {
    const engine = freshEngine();
    engine.run(makeRunRequest(market));
    expect(() =>
      engine.queryResults({ runId: "RUN-1", metric: "nii", scenarioId: "S999" }),
    ).toThrow(/S999/);
  });
});

describe("explain — narrates only from attribution", () => {
  it("supports a shocked headline and cites the rate driver", () => {
    const engine = freshEngine();
    engine.run(makeRunRequest(market));

    const ex = engine.explain({ runId: "RUN-1", metric: "eve", scenarioId: "S200" });
    expect(ex.supported).toBe(true);
    expect(ex.attribution).not.toBeNull();
    expect(ex.attribution!.scenarioId).toBe("S200");
    expect(ex.citations.length).toBeGreaterThan(0);
    expect(ex.citations.every((c) => c.driver === "rate")).toBe(true);
    expect(ex.answer.length).toBeGreaterThan(0);
  });

  it("returns supported=false with an honest answer for the base scenario", () => {
    const engine = freshEngine();
    engine.run(makeRunRequest(market));

    const ex = engine.explain({ runId: "RUN-1", metric: "eve", scenarioId: "S0" });
    expect(ex.supported).toBe(false);
    expect(ex.attribution).toBeNull();
    expect(ex.citations).toEqual([]);
    expect(ex.answer).toMatch(/base/i);
  });

  it("throws on an unknown runId", () => {
    const engine = freshEngine();
    engine.run(makeRunRequest(market));
    expect(() =>
      engine.explain({ runId: "NOPE", metric: "eve", scenarioId: "S200" }),
    ).toThrow(/NOPE/);
  });
});
