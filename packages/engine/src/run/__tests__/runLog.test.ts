// packages/engine/src/run/__tests__/runLog.test.ts
/**
 * Spec Section 8.5, first half: every metric cell in the result maps to a
 * run-log entry whose scope covers that cell's scenario and metric. The check
 * is structural. It does not recompute a number and it does not assert an
 * order beyond append order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { composeProfile, mountProfile, type Plugin } from "@alm/harness";
import { buildDemoPortfolio, buildDemoRequest } from "../../../../../data/src/demo/request";
import type { RunLogEntry } from "../../contracts/runLog";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { defaultHarness } from "../../plugins/defaultHarness";
import { RUN_RESULT_SCHEMA_VERSION, buildRunResult } from "../orchestrate";
import { resolveDefaultContext } from "../engine";
import { buildScenarioRatePath } from "../../projection/static";
import {
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  segmentedAssumptions,
  segmentedNmdBook,
  twoSidedBook,
} from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

function demoResult() {
  const portfolio = buildDemoPortfolio();
  const request = buildDemoRequest(portfolio, market, {
    startedAt: "2026-07-16T00:00:00.000Z",
    finishedAt: "2026-07-16T00:00:01.000Z",
  });
  return buildRunResult(request, portfolio, { ...resolveDefaultContext(), harness: defaultHarness() });
}

/** The unseasoned four-position fixture, which DOES produce an ftp block. */
function fixtureResult() {
  const request = makeRunRequest(market);
  const result = buildRunResult(request, twoSidedBook(), {
    ...resolveDefaultContext(),
    harness: defaultHarness(),
  });
  return { result, baseScenarioId: request.scenarios.find((s) => s.rateSpec.kind === "base")!.id };
}

function resolves(log: RunLogEntry[]) {
  return log.filter((e): e is Extract<RunLogEntry, { t: "resolve" }> => e.t === "resolve");
}

describe("the envelope carries its log", () => {
  it("bumps the schema to 1.13.0", () => {
    expect(RUN_RESULT_SCHEMA_VERSION).toBe("1.13.0");
    expect(demoResult().schemaVersion).toBe("1.13.0");
  });

  it("stamps the profile hash of the context the run used", () => {
    const result = demoResult();
    expect(result.provenance.profileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names a plugin for every one of the seven seams", () => {
    const log = demoResult().provenance.runLog ?? [];
    // The seam-level entries are the ones with an empty scope. The per-scenario
    // and per-metric entries reuse the same keys, so a last-wins Map over the
    // whole log would report whichever model answered the last cell rather than
    // the plugin that owns the seam.
    const seamLevel = resolves(log).filter((e) => Object.keys(e.scope).length === 0);
    const byKey = new Map(seamLevel.map((e) => [e.key, e.pluginId]));
    expect(byKey.get("curves")).toBe("engine.curve.bootstrap");
    expect(byKey.get("ratePaths")).toBe("engine.rate-path.registry");
    expect(byKey.get("behavioral")).toBe("engine.behavioral.registry");
    expect(byKey.get("positions")).toBe("engine.positions.registry");
    expect(byKey.get("scenarios")).toBe("engine.scenarios.registry");
    expect(byKey.get("metrics")).toBe("engine.metric.registry");
    expect(byKey.get("runLog")).toBe("engine.run-log");
  });

  it("credits a third-party rate-path model to its own plugin id", () => {
    // The defect this pins: an id built as `engine.rate-path.<modelId>` would
    // credit this run to a plugin that does not exist. The log must name the
    // plugin that actually registered the model.
    const toyRates: Plugin = {
      id: "test.rates",
      inject: ["ratePaths"],
      declares: { kind: "term-structure", produces: ["RatePath"], consumes: ["ZeroCurve"] },
      apply(ctx) {
        const registry = ctx.get("ratePaths");
        // The shipped function, so no number moves: only the naming is under test.
        ctx.effect(() => registry.register("test-model", buildScenarioRatePath, "test.rates"));
      },
    };
    const catalog = new Map(BUILTIN_CATALOG).set(toyRates.id, toyRates);
    const profile = composeProfile(DEFAULT_PROFILE, [
      { label: "toy-rates", patches: [{ insert: { id: "toy-rates", plugin: toyRates.id } }] },
    ]);
    const harness = mountProfile(profile, catalog);
    const request = makeRunRequest(market);
    const scenarios = request.scenarios.map((s) => ({ ...s, ratePathModel: "test-model" }));
    const result = buildRunResult(
      { ...request, scenarios },
      twoSidedBook(),
      { ...resolveDefaultContext(), harness },
    );
    for (const scenarioId of result.provenance.scenarioIds) {
      const hit = resolves(result.provenance.runLog ?? []).find(
        (e) => e.key === "ratePaths" && e.scope.scenarioId === scenarioId,
      );
      expect(hit, `no rate-path resolve entry for scenario ${scenarioId}`).toBeDefined();
      expect(hit!.pluginId).toBe("test.rates");
    }
    harness.dispose();
  });

  it("records the rate-path model that built each scenario's path", () => {
    const result = demoResult();
    const log = result.provenance.runLog ?? [];
    for (const scenario of result.provenance.scenarioIds) {
      const hit = resolves(log).find((e) => e.key === "ratePaths" && e.scope.scenarioId === scenario);
      expect(hit, `no rate-path resolve entry for scenario ${scenario}`).toBeDefined();
      expect(hit!.pluginId).toBe("engine.rate-path.deterministic");
    }
  });
});

describe("every metric cell maps to a resolve entry", () => {
  it("covers NII, EVE and both gap ladders for every scenario", () => {
    const result = demoResult();
    const log = resolves(result.provenance.runLog ?? []);
    const covered = (scenarioId: string, metricId: string) =>
      log.some((e) => e.key === "metrics" && e.scope.metricId === metricId && e.scope.scenarioId === scenarioId);

    for (const row of result.nii.byScenario) expect(covered(row.scenarioId, "nii"), `nii ${row.scenarioId}`).toBe(true);
    for (const row of result.eve.byScenario) expect(covered(row.scenarioId, "eve"), `eve ${row.scenarioId}`).toBe(true);
    for (const ladder of result.gap.repricing) {
      expect(covered(ladder.scenarioId, "gap"), `repricing ${ladder.scenarioId}`).toBe(true);
    }
    for (const ladder of result.gap.liquidity) {
      expect(covered(ladder.scenarioId, "gap"), `liquidity ${ladder.scenarioId}`).toBe(true);
    }
  });

  it("covers the ftp block, scoped to the base scenario, on a book that produces one", () => {
    const { result, baseScenarioId } = fixtureResult();
    // No early return: this fixture is unseasoned, so the block IS produced and
    // a missing log entry is a real failure rather than a skipped case.
    expect(result.ftp).toBeDefined();
    const hit = resolves(result.provenance.runLog ?? []).find(
      (e) => e.key === "metrics" && e.scope.metricId === "ftp",
    );
    expect(hit, "no ftp resolve entry").toBeDefined();
    expect(hit!.scope.scenarioId).toBe(baseScenarioId);
    expect(hit!.pluginId).toBe("engine.metric.ftp");
  });

  it("does not accumulate across runs on a memoized context", () => {
    const first = demoResult().provenance.runLog ?? [];
    const second = demoResult().provenance.runLog ?? [];
    expect(second.length).toBe(first.length);
  });
});

describe("piece 2a: license entries and positionsMatched", () => {
  it("logs one license entry per licensed binding with the count of positions it matched", () => {
    const book = segmentedNmdBook();
    const set = segmentedAssumptions();
    const request = makeRunRequest(market, {
      portfolioId: book.id,
      assumptionSets: [set],
      scenarios: regulatoryScenarios(set.id),
    });
    const result = buildRunResult(request, book, {
      ...resolveDefaultContext(),
      harness: defaultHarness(),
    });
    const licenses = (result.provenance.runLog ?? []).filter(
      (e): e is Extract<RunLogEntry, { t: "license" }> => e.t === "license",
    );
    expect(licenses.map((l) => [l.bindingIndex, l.positionsMatched, l.selector ?? ""])).toEqual([
      [0, 1, ""],
      [1, 2, '{"segment":["rate-shopper"]}'],
      [2, 1, ""],
      [3, 1, '{"segment":["relationship"]}'],
    ]);
    const decayStage = (result.provenance.runLog ?? []).find(
      (e) => e.t === "stage" && e.stageId === "st-behavioral-nmd-decay",
    ) as Extract<RunLogEntry, { t: "stage" }>;
    expect(decayStage.bindings).toEqual([
      { assumptionSetId: set.id, bindingIndex: 1, positionsMatched: 2 },
      { assumptionSetId: set.id, bindingIndex: 3, positionsMatched: 1 },
    ]);
    expect(result.schemaVersion).toBe("1.13.0");
  });
});
