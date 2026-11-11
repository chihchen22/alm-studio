/**
 * The walker's custom metric arm, over the real
 * pipeline on the fixtures report/__tests__/pivot.test.ts uses.
 *
 * The byte-identity case builds BOTH runs in this test. Nothing here is
 * compared against a stored golden, and nothing is compared against a number
 * copied out of a first run: the two envelopes are built side by side from one
 * request and differ by exactly one plan stage, so what the comparison proves
 * is that the stage adds the custom arm and its log entries and nothing else.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { mountProfile, type Context, type Plugin } from "@alm/harness";
import type { PlanStage } from "../../contracts/plan";
import type { RunResult } from "../../contracts/run";
import type { RunLogEntry } from "../../contracts/runLog";
import type { CustomMetricFn } from "../../plugins/services";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy } from "../../plan/__tests__/fixtures";
import { ArtifactConflictError, CustomMetricShapeError, PlanGraphError } from "../executorErrors";
import { defaultPlanFor } from "../defaultPlan";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import {
  baseAssumptions,
  HORIZON,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  twoSidedBook,
  viewSegmentedBook,
} from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
}, 180_000);

/** The custom stage: the ruling-6 pair, the demonstration component, one Cashflow edge. */
const CUSTOM_STAGE: PlanStage = {
  id: "st-custom",
  component: "engine.metric.balance-summary",
  kind: "metric",
  consumes: ["Cashflow", "Position"],
  produces: ["CustomMetricResult"],
  dependsOn: ["st-cashflow"],
};

/** The same stage shape on the second built-in custom metric. */
const WAL_GAP_STAGE: PlanStage = {
  id: "st-custom",
  component: "engine.metric.wal-gap",
  kind: "metric",
  consumes: ["Cashflow", "Position"],
  produces: ["CustomMetricResult"],
  dependsOn: ["st-cashflow"],
};

function request() {
  const book = viewSegmentedBook();
  const set = baseAssumptions("AS-CUSTOM");
  return {
    book,
    request: makeRunRequest(market, {
      portfolioId: book.id,
      assumptionSets: [set],
      scenarios: regulatoryScenarios(set.id),
    }),
  };
}

/** Run the request on the default plan, optionally with extra stages appended. */
function run(extra: PlanStage[]): RunResult {
  const { book, request: req } = request();
  const { plan } = defaultPlanFor(req, book);
  plan.stages.push(...extra.map((s) => ({ ...s })));
  return buildRunResult(req, book, { ...resolveDefaultContext(), plan });
}

/** Everything except provenance, which legitimately carries the extra stage's log entries. */
function withoutProvenance(result: RunResult): string {
  return JSON.stringify({ ...result, provenance: null });
}

/** Compile the fixture plan with extra stages appended; throws what compilePlan throws. */
function compileWith(extra: PlanStage[]): void {
  const plan = fixturePlan();
  plan.stages.push(...extra.map((s) => ({ ...s })));
  compilePlan(
    plan,
    {
      portfolio: twoSidedBook(),
      marketSnapshot: market,
      assumptionSets: [baseAssumptions()],
      policy: loadPolicy(),
      libraries: SHIPPED_LIBRARIES,
    },
    {
      runId: "RUN-CUSTOM-5A",
      seed: "42",
      timestamps: { startedAt: "2026-09-17T00:00:00.000Z", finishedAt: "2026-09-17T00:00:01.000Z" },
    },
  );
}

describe("the custom metric stage", () => {
  it("puts a valid result under custom[metricId] and logs one resolve per scenario", () => {
    const result = run([CUSTOM_STAGE]);
    const arm = result.custom;
    expect(arm).toBeDefined();
    expect(Object.keys(arm!)).toEqual(["balance-summary"]);

    const scenarioIds = result.eve.byScenario.map((s) => s.scenarioId);
    const metric = arm!["balance-summary"]!;

    // The arm's CONTENT, cross-checked against the envelope's own cashflow
    // block. Every scenario of this fixture is static, so no balance stage
    // exists and the primary series the envelope publishes IS the object the
    // custom stage's `Cashflow` edge resolved to (st-cashflow). The sums are
    // restated here from the envelope arrays rather than recomputed by the
    // metric's own helper, so this check cannot pass by agreeing with itself.
    expect(metric.byScenario.map((row) => row.scenarioId)).toEqual(scenarioIds);
    for (const row of metric.byScenario) {
      const series = result.cashflows.byScenario.find((s) => s.scenarioId === row.scenarioId);
      expect(series).toBeDefined();
      let opening = 0;
      let final = 0;
      for (const family of series!.byFamily) {
        opening += family.series.balance[0]!;
        final += family.series.balance[HORIZON - 1]!;
      }
      expect(row.values["opening-balance"]).toBe(opening);
      expect(row.values["final-bucket-balance"]).toBe(final);
      expect(opening).not.toBe(0);
      expect(row.values["runoff-share"]).toBeCloseTo(1 - final / opening, 12);
    }

    const resolves = (result.provenance.runLog ?? []).filter(
      (e): e is Extract<RunLogEntry, { t: "resolve" }> =>
        e.t === "resolve" && e.scope.stageId === "st-custom",
    );
    expect(resolves.map((e) => e.scope.scenarioId)).toEqual(scenarioIds);
    for (const entry of resolves) {
      expect(entry.key).toBe("metrics");
      expect(entry.pluginId).toBe("engine.metric.balance-summary");
      expect(entry.scope.metricId).toBe("balance-summary");
    }
  }, 120_000);

  /**
   * The second built-in custom metric down the SAME walk. The plan
   * names a different component and nothing else moves, which is what makes the
   * slot a slot. The asset pool is RESTATED here from the envelope's own
   * principal arrays and the book's own COA sides, so this check cannot pass by
   * agreeing with the metric's helper.
   */
  it("walks a wal-gap stage and puts its five keys under custom[\"wal-gap\"]", () => {
    const book = viewSegmentedBook();
    const result = run([WAL_GAP_STAGE]);
    const arm = result.custom;
    expect(arm).toBeDefined();
    expect(Object.keys(arm!)).toEqual(["wal-gap"]);

    const metric = arm!["wal-gap"]!;
    expect(metric.metricId).toBe("wal-gap");
    expect(metric.keys.map((k) => k.id)).toEqual([
      "asset-wal",
      "liability-wal",
      "wal-gap",
      "wal-ratio",
      "wal",
    ]);

    const scenarioIds = result.eve.byScenario.map((s) => s.scenarioId);
    expect(metric.byScenario.map((row) => row.scenarioId)).toEqual(scenarioIds);

    const sideOf = new Map(book.coa.families.map((f) => [f.id, f.side]));
    for (const row of metric.byScenario) {
      const series = result.cashflows.byScenario.find((s) => s.scenarioId === row.scenarioId)!;
      // The WAL formula, restated: bucket k is calendar month k+1, so the
      // principal-weighted average life in months is the sum of
      // principal[k] * (k+1) over the pooled buckets, over the pooled total.
      const pooledWal = (side: "asset" | "liability"): number => {
        let weighted = 0;
        let total = 0;
        for (const family of series.byFamily) {
          if (sideOf.get(family.familyId) !== side) continue;
          const principal = family.series.principal;
          for (let k = 0; k < principal.length; k++) {
            weighted += principal[k]! * (k + 1);
            total += principal[k]!;
          }
        }
        expect(total, side).toBeGreaterThan(0);
        return weighted / total;
      };
      expect(row.values["asset-wal"]).toBeCloseTo(pooledWal("asset"), 9);
      expect(row.values["liability-wal"]).toBeCloseTo(pooledWal("liability"), 9);
      expect(row.values["wal-gap"]).toBeCloseTo(pooledWal("asset") - pooledWal("liability"), 9);
      // Absence is a value's business, not the row's: the per-family key is
      // never on a scenario row, and every family row carries at most `wal`.
      expect("wal" in row.values).toBe(false);
      for (const fam of row.byFamily!) {
        expect(Object.keys(fam.values).every((k) => k === "wal")).toBe(true);
      }
    }
  }, 120_000);

  it("a run with no custom stage carries no custom key, and the stage adds nothing else", () => {
    const plain = run([]);
    expect(plain.custom).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain('"custom"');

    // Both envelopes are built HERE, from one request, differing by one stage.
    const withCustom = run([CUSTOM_STAGE]);
    expect(withoutProvenance(plain)).toBe(
      withoutProvenance({ ...withCustom, custom: undefined } as RunResult),
    );
  }, 120_000);

  it("refuses two stages of ONE custom metric at compile with the existing ArtifactConflictError", () => {
    try {
      compileWith([CUSTOM_STAGE, { ...CUSTOM_STAGE, id: "st-custom-2" }]);
      expect.unreachable("two custom metric stages must refuse at compile");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactConflictError);
      const refusal = err as ArtifactConflictError;
      expect(refusal.type).toBe("CustomMetricResult");
      expect([refusal.firstStageId, refusal.secondStageId].sort()).toEqual([
        "st-custom",
        "st-custom-2",
      ]);
    }
  });

  it("piece 5a: compiles a plan naming two DIFFERENT custom metrics", () => {
    expect(() =>
      compileWith([CUSTOM_STAGE, { ...WAL_GAP_STAGE, id: "st-wal-gap" }]),
    ).not.toThrow();
  });

  it("piece 5a: still refuses the SAME custom metric twice, naming both stages", () => {
    try {
      compileWith([
        CUSTOM_STAGE,
        { ...WAL_GAP_STAGE, id: "st-wal-gap" },
        { ...WAL_GAP_STAGE, id: "st-wal-gap-2" },
      ]);
      expect.unreachable("two wal-gap stages must refuse at compile");
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactConflictError);
      const refusal = err as ArtifactConflictError;
      expect(refusal.type).toBe("CustomMetricResult");
      expect([refusal.firstStageId, refusal.secondStageId]).toEqual(["st-wal-gap", "st-wal-gap-2"]);
    }
  });

  it("piece 5a: a two-metric run publishes both, in plan order, each equal to its one-metric run", () => {
    const WAL = { ...WAL_GAP_STAGE, id: "st-wal-gap" };
    const both = run([CUSTOM_STAGE, WAL]);
    expect(Object.keys(both.custom ?? {})).toEqual(["balance-summary", "wal-gap"]);

    // Expected values come from two SEPARATE one-metric runs, not from `both`.
    const onlyBalance = run([CUSTOM_STAGE]);
    const onlyWal = run([WAL]);
    expect(JSON.stringify(both.custom!["balance-summary"])).toBe(
      JSON.stringify(onlyBalance.custom!["balance-summary"]),
    );
    expect(JSON.stringify(both.custom!["wal-gap"])).toBe(JSON.stringify(onlyWal.custom!["wal-gap"]));

    // Plan order, not alphabetical: reversed stages, reversed keys.
    const reversed = run([WAL, CUSTOM_STAGE]);
    expect(Object.keys(reversed.custom ?? {})).toEqual(["wal-gap", "balance-summary"]);

    // Nothing else on the envelope moved.
    expect(withoutProvenance({ ...both, custom: undefined } as RunResult)).toBe(
      withoutProvenance({ ...onlyBalance, custom: undefined } as RunResult),
    );
  }, 240_000);

  it("refuses a custom stage whose component registers no custom metric", () => {
    // ONE run, not two: the refusal fires at the custom stage, which is last, so
    // a second call would repeat the whole projection to learn nothing.
    try {
      run([{ ...CUSTOM_STAGE, component: "engine.metric.nii" }]);
      expect.unreachable("a custom stage on a plugin with no custom metric must refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanGraphError);
      const refusal = err as PlanGraphError;
      expect(refusal.stageId).toBe("st-custom");
      expect(refusal.message).toContain("registers no custom metric");
      expect(refusal.message).toContain("engine.metric.nii");
    }
  }, 120_000);

  it("fails the run with CustomMetricShapeError when the metric returns a row the run has no scenario for", () => {
    const { book, request: req } = request();
    const { plan } = defaultPlanFor(req, book);
    plan.stages.push({ ...CUSTOM_STAGE });
    // A metric that invents a scenario. What is under test is the SHAPE CHECK,
    // not the registration path Task 2 already pins, so the demonstration
    // plugin's own catalog entry is swapped for one registering this function.
    const liar: CustomMetricFn = (input) => ({
      metricId: "balance-summary",
      label: "Liar",
      keys: [{ id: "opening-balance", label: "Opening", unit: "currency" }],
      byScenario: [
        ...input.scenarios.map((s) => ({ scenarioId: s.scenarioId, values: {} })),
        { scenarioId: "SGHOST", values: {} },
      ],
    });
    try {
      buildRunResult(req, book, {
        ...resolveDefaultContext(),
        plan,
        // The harness the run mounts, with the demonstration function swapped.
        harness: harnessWithCustomFn(liar),
      });
      expect.unreachable("a result carrying a scenario the run does not have must fail the run");
    } catch (err) {
      expect(err).toBeInstanceOf(CustomMetricShapeError);
      const refusal = err as CustomMetricShapeError;
      expect(refusal.rule).toBe("C3");
      expect(refusal.metricId).toBe("balance-summary");
      expect(refusal.stageId).toBe("st-custom");
      expect(refusal.message).toContain("SGHOST");
    }
  }, 120_000);
});

/**
 * A mounted context whose balance-summary registration is the given function.
 * The CATALOG ENTRY is replaced under the same plugin id, so the default
 * profile's `metric.balance-summary` row mounts the replacement and every other
 * row is untouched. That is a smaller swap than the disable-and-insert patch
 * run/__tests__/toyMetric.test.ts uses, and it needs no profile composition.
 */
function harnessWithCustomFn(fn: CustomMetricFn): Context {
  const swapped: Plugin = {
    id: "engine.metric.balance-summary",
    inject: ["metrics"],
    declares: { kind: "metric", produces: ["CustomMetricResult"], consumes: ["Cashflow", "Position"] },
    apply(ctx) {
      const registry = ctx.get("metrics");
      ctx.effect(() =>
        registry.registerCustom("balance-summary", fn, "engine.metric.balance-summary"),
      );
    },
  };
  return mountProfile(DEFAULT_PROFILE, new Map(BUILTIN_CATALOG).set(swapped.id, swapped));
}
