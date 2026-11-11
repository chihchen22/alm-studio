/**
 * Both read routes answer off result.json and
 * request.json on disk, re-deriving nothing. The base scenario is DERIVED from
 * the run's own request (the one scenario whose rateSpec.kind is "base"), never
 * inferred from a zero delta; a refusal or an invalid stored definition is a
 * 422 carrying the engine's message verbatim; and the all-lenses call fails
 * WHOLE on one bad lens, because a four-lens reading with one lens silently
 * dropped is the partial view the plane exists to prevent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Scenario } from "@alm/engine";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import {
  baseAssumptions,
  regulatoryScenarios,
  viewSegmentedBook,
} from "@alm/engine/src/run/__tests__/fixtures";
import { repoRoot } from "../config";
import type { RunStatus } from "../jobs/types";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

let tp: TestPlatform;
const RUN = "run-lens-ok";
const NO_BASE_RUN = "run-lens-no-base";

/**
 * Seed one finished run: result.json off the real engine, status.json done, and
 * request.json carrying the scenario list the base derivation reads. The stored
 * request is written as a partial of StoredRunRequest on purpose: only
 * `request.scenarios` is load-bearing for these routes, and writing a whole
 * RunRequest would drag the market snapshot into the fixture for nothing.
 *
 * `storedScenarios` defaults to the scenarios the envelope was built from and
 * is passed separately only by the no-base case: the engine refuses to build a
 * result at all without a base scenario, so a run whose STORED request names no
 * base still has a perfectly ordinary envelope. That is the point of the case.
 */
async function seedRun(
  runId: string,
  scenarios: Scenario[],
  storedScenarios: Scenario[] = scenarios,
): Promise<void> {
  const store = tp.platform.context.store;
  const book = viewSegmentedBook();
  const market = await loadTestMarket();
  const startedAt = new Date().toISOString();
  const result = buildRunResult(
    {
      runId,
      portfolioId: book.id,
      marketSnapshot: market,
      scenarios,
      assumptionSets: [baseAssumptions("AS-LENS-HTTP")],
      grid: { horizonMonths: 360, asOf: book.asOf },
      seed: "platform-0",
      timestamps: { startedAt, finishedAt: startedAt },
    },
    book,
    { ...resolveDefaultContext(), durationMode: "base-only" },
  );
  const { writeFileAtomic } = await import("../store/store");
  const { join } = await import("node:path");
  writeFileAtomic(join(store.paths.runDir(runId), "result.json"), `${JSON.stringify(result)}\n`);
  const status: RunStatus = {
    runId,
    state: "done",
    phase: "done",
    submittedAt: startedAt,
    startedAt,
    endedAt: new Date().toISOString(),
    platformRequestHash: "test",
    summary: {
      portfolioId: book.id,
      marketId: "m",
      scenarioSlateId: "s",
      scenarioCount: scenarios.length,
    },
  };
  store.writeRunJson(runId, "status.json", status);
  store.writeRunJson(runId, "request.json", { request: { scenarios: storedScenarios } });
  store.appendRunLog(runId, { t: "status", state: "done", at: startedAt });
}

beforeAll(async () => {
  tp = await bootTestPlatform();
  // The full seed, not a hand-written lens loop: the fifth lens
  // reads a custom metric, and the case that runs one needs the seeded book,
  // market, assumption set and routing policy a plan submission resolves
  // against. The seed writes all six lens documents on its way through.
  await seedStore(new FileStore(tp.storeRoot), repoRoot());
  const set = baseAssumptions("AS-LENS-HTTP");
  await seedRun(RUN, regulatoryScenarios(set.id));
  // A STORED request with no base scenario at all: every rateSpec is a parallel
  // shock. The envelope is the ordinary one, because the base id is derived
  // from the stored request and never read off the envelope.
  await seedRun(
    NO_BASE_RUN,
    regulatoryScenarios(set.id),
    regulatoryScenarios(set.id)
      .filter((s) => s.rateSpec.kind !== "base")
      .map((s) => ({ ...s })),
  );
}, 300_000);

afterAll(async () => {
  await tp.close();
});

// One describe for both routes: the cases share a store and their ORDER matters
// (the append-only store cannot un-write the broken definition the last case adds).
describe("GET /api/runs/:id/lens and GET /api/runs/:id/lenses", () => {
  it("answers 200 with the reading, the derived base and the envelope scenario order", async () => {
    const r = await api<{
      lensId: string;
      objective: string;
      baseScenarioId: string;
      byScenario: Array<{ scenarioId: string; constraints: Array<{ constraintId: string }> }>;
      status: string;
    }>(tp.base, "GET", `/api/runs/${RUN}/lens?lens=rate-demo-v1`);
    expect(r.status).toBe(200);
    expect(r.body.lensId).toBe("rate-demo-v1");
    expect(r.body.objective).toBe("rate");
    expect(r.body.baseScenarioId).toBe("S0");
    expect(r.body.byScenario.map((s) => s.scenarioId)).toEqual([
      "S0",
      "S100",
      "S-100",
      "S200",
      "S-200",
    ]);
    expect(r.body.byScenario[0].constraints.map((c) => c.constraintId)).toEqual([
      "eve-15",
      "nii-12",
    ]);
    expect(["pass", "breach", "unobservable"]).toContain(r.body.status);
  });

  it("the capital lens reads unobservable with the reason, never a zero", async () => {
    const r = await api<{
      status: string;
      headline?: number;
      byScenario: Array<{ constraints: Array<{ status: string; reason: string; value?: number }> }>;
    }>(tp.base, "GET", `/api/runs/${RUN}/lens?lens=capital-demo-v1`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("unobservable");
    expect(r.body.headline).toBeUndefined();
    const c = r.body.byScenario[0].constraints[0];
    expect(c.status).toBe("unobservable");
    expect(c.value).toBeUndefined();
    expect(c.reason).toContain("no capital metric on the envelope");
  });

  /**
   * This case runs BEFORE the broken-definition case below, deliberately. The
   * store is append-only, so the broken document that case writes cannot be
   * removed, and after it every all-lenses call refuses. Do not reorder.
   */
  it("GET /lenses answers 200 with every stored lens in ascending id order", async () => {
    const r = await api<{
      baseScenarioId: string;
      lenses: Array<{
        lensId: string;
        status: string;
        headline?: number;
        byScenario: Array<{ constraints: Array<{ status: string; reason?: string; value?: number }> }>;
      }>;
    }>(tp.base, "GET", `/api/runs/${RUN}/lenses`);
    expect(r.status).toBe(200);
    expect(r.body.baseScenarioId).toBe("S0");
    expect(r.body.lenses).toHaveLength(6);
    expect(r.body.lenses.map((l) => l.lensId)).toEqual([...SEED_IDS.demoLenses].sort());

    // This run named no custom metric stage, so the fifth lens reads
    // UNOBSERVABLE with a reason, never a zero, and every other lens still
    // answers. That is why adding it breaks no existing run.
    const balance = r.body.lenses.find((l) => l.lensId === "balance-demo-v1")!;
    expect(balance.status).toBe("unobservable");
    expect(balance.headline).toBeUndefined();
    const constraint = balance.byScenario[0]!.constraints[0]!;
    expect(constraint.status).toBe("unobservable");
    expect(constraint.value).toBeUndefined();
    expect(constraint.reason).toContain("the run named no stage producing it");
  });

  /**
   * Piece 3c, mirroring the case above for the second built-in custom metric.
   * This run named no custom metric stage at all, so BOTH constraints of the
   * WAL gap lens read unobservable with the reason, never a zero.
   */
  it("the WAL gap lens reads both constraints unobservable on a run that named no wal-gap stage", async () => {
    const r = await api<{
      status: string;
      headline?: number;
      byScenario: Array<{
        constraints: Array<{ constraintId: string; status: string; reason?: string; value?: number }>;
      }>;
    }>(tp.base, "GET", `/api/runs/${RUN}/lens?lens=wal-gap-demo-v1`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("unobservable");
    expect(r.body.headline).toBeUndefined();
    const constraints = r.body.byScenario[0]!.constraints;
    expect(constraints.map((c) => c.constraintId)).toEqual(["gap-24", "ratio-50"]);
    for (const c of constraints) {
      expect(c.status).toBe("unobservable");
      expect(c.value).toBeUndefined();
      expect(c.reason).toContain("the run named no stage producing it");
    }
  });

  /**
   * Piece 3b end to end: a plan with a custom metric stage goes in through the
   * ordinary submission route, the run finishes, and the fifth lens reads a
   * real number off the `custom` arm of the stored envelope.
   *
   * It sits AFTER the all-lenses case and BEFORE the broken-definition case,
   * deliberately: the store is append-only, and once a broken lens is written
   * every all-lenses call refuses. Do not reorder.
   */
  it("reads a real value once a run names the demonstration custom metric stage", async () => {
    const submitted = await api<{ runId: string }>(tp.base, "POST", "/api/plans/run", {
      plan: customMetricPlan(),
      label: "custom metric via plan",
    });
    expect(submitted.status).toBe(202);
    const done = await waitFor(
      () =>
        api<{ state: string }>(tp.base, "GET", `/api/runs/${submitted.body.runId}`).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      180_000,
    );
    expect(done.state).toBe("done");

    const r = await api<{
      status: string;
      byScenario: Array<{
        scenarioId: string;
        constraints: Array<{ constraintId: string; status: string; value?: number; limit: number }>;
      }>;
    }>(tp.base, "GET", `/api/runs/${submitted.body.runId}/lens?lens=balance-demo-v1`);
    expect(r.status).toBe(200);
    const constraint = r.body.byScenario[0]!.constraints[0]!;
    expect(constraint.constraintId).toBe("runoff-50");
    expect(constraint.limit).toBe(0.5);
    expect(typeof constraint.value).toBe("number");
    expect(Number.isFinite(constraint.value!)).toBe(true);
    // A share of the opening balance: between 0 and 1 on a book that runs off
    // and does not grow. The pass-or-breach verdict is whichever the limit of
    // 0.5 makes it; what is pinned is that it is a VERDICT and not unobservable.
    expect(constraint.value!).toBeGreaterThanOrEqual(0);
    expect(constraint.value!).toBeLessThanOrEqual(1);
    expect(["pass", "breach"]).toContain(constraint.status);
    expect(["pass", "breach"]).toContain(r.body.status);
  }, 240_000);

  /**
   * Piece 3c end to end, the twin of the case above on the second built-in
   * custom metric. Same submission route, same book, one different component
   * named by one plan stage: nothing in the compiler or the plan schema moves.
   */
  it("reads real WAL numbers once a run names the wal-gap stage", async () => {
    const submitted = await api<{ runId: string }>(tp.base, "POST", "/api/plans/run", {
      plan: customMetricPlan("engine.metric.wal-gap", "PLAN-CUSTOM-WAL"),
      label: "wal gap via plan",
    });
    expect(submitted.status).toBe(202);
    const done = await waitFor(
      () =>
        api<{ state: string }>(tp.base, "GET", `/api/runs/${submitted.body.runId}`).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      180_000,
    );
    expect(done.state).toBe("done");

    const r = await api<{
      status: string;
      headline?: number;
      byScenario: Array<{
        scenarioId: string;
        constraints: Array<{ constraintId: string; status: string; value?: number; limit: number }>;
      }>;
    }>(tp.base, "GET", `/api/runs/${submitted.body.runId}/lens?lens=wal-gap-demo-v1`);
    expect(r.status).toBe(200);
    const constraints = r.body.byScenario[0]!.constraints;
    expect(constraints.map((c) => c.constraintId)).toEqual(["gap-24", "ratio-50"]);
    for (const c of constraints) {
      expect(c.status).not.toBe("unobservable");
      expect(typeof c.value).toBe("number");
      expect(Number.isFinite(c.value!)).toBe(true);
    }
    // A ratio of two positive WALs: strictly positive and finite, never a zero
    // standing in for an absent number.
    const ratio = constraints[1]!.value!;
    expect(ratio).toBeGreaterThan(0);
    expect(Number.isFinite(ratio)).toBe(true);
    // Both limits are nonzero, so both constraints are fraction basis and the
    // reading has a headline at both levels.
    expect(Number.isFinite(r.body.headline!)).toBe(true);

    // The gap the lens read is the SUBTRACTION, restated here off the stored
    // envelope's own custom row rather than recomputed by the metric.
    const stored = await api<{ custom: Record<string, { byScenario: Array<{ scenarioId: string; values: Record<string, number> }> }> }>(
      tp.base,
      "GET",
      `/api/runs/${submitted.body.runId}/result`,
    );
    expect(stored.status).toBe(200);
    const row = stored.body.custom["wal-gap"]!.byScenario.find(
      (x) => x.scenarioId === r.body.byScenario[0]!.scenarioId,
    )!;
    expect(row.values["wal-gap"]).toBeCloseTo(
      row.values["asset-wal"]! - row.values["liability-wal"]!,
      9,
    );
    expect(constraints[0]!.value).toBeCloseTo(row.values["wal-gap"]!, 9);
    expect(constraints[1]!.value).toBeCloseTo(
      row.values["liability-wal"]! / row.values["asset-wal"]!,
      9,
    );
    // OBSERVED on the shipped vanilla book, read before it was pinned: asset WAL
    // 38.2 months, liability WAL 31.0, gap 7.2 months, ratio 0.812. Against the
    // demonstration limits (gap at most 24, ratio at least 0.5) both constraints
    // PASS, on every scenario, and the headline is the ratio's headroom.
    //
    // The five scenarios carry the SAME WAL, and that is a fact about this plan
    // rather than a weak assertion: it names no behavioral and no balance stage,
    // so principal is contractual and a rate shock does not move it. A plan with
    // a prepayment overlay would spread these rows.
    expect(row.values["liability-wal"]).toBeCloseTo(31, 6);
    expect(row.values["asset-wal"]).toBeGreaterThan(row.values["liability-wal"]!);
    expect(r.body.status).toBe("pass");
    for (const scenario of r.body.byScenario) {
      expect(scenario.constraints.map((c) => c.status)).toEqual(["pass", "pass"]);
    }
  }, 240_000);

  it("400s a missing lens parameter", async () => {
    const r = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${RUN}/lens`,
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("lens requires a lens parameter");
  });

  it("404s a lens id the store does not hold", async () => {
    const r = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${RUN}/lens?lens=no-such-lens`,
    );
    expect(r.status).toBe(404);
    expect(r.body.error.message).toContain("no-such-lens");
  });

  it("422s a LensUnavailableError with the engine message verbatim", async () => {
    const r = await api<{ error: { message: string; detail: { error: string } } }>(
      tp.base,
      "GET",
      `/api/runs/${RUN}/lens?lens=rate-demo-v1&scenarioId=SGHOST`,
    );
    expect(r.status).toBe(422);
    expect(r.body.error.detail.error).toBe("LensUnavailableError");
    expect(r.body.error.message).toContain("SGHOST");
  });

  it("422s a run whose request names no single base scenario", async () => {
    const r = await api<{ error: { message: string; detail: { error: string } } }>(
      tp.base,
      "GET",
      `/api/runs/${NO_BASE_RUN}/lens?lens=rate-demo-v1`,
    );
    expect(r.status).toBe(422);
    expect(r.body.error.detail.error).toBe("BaseScenarioUndetermined");
    expect(r.body.error.message).toContain("0 scenario");
  });

  /**
   * LAST in the file, deliberately. It writes a broken definition into the
   * store, the store is append-only, and from that point every all-lenses call
   * refuses. Do not move it above the GET /lenses case.
   */
  it("422s a stored definition that fails validateLens, and fails /lenses whole", async () => {
    tp.platform.context.store.putDocument(
      "lens",
      "broken-v1",
      { id: "broken-v1", label: "Broken", objective: "rate", constraints: [] },
      { label: "Broken", seeded: false },
    );
    const one = await api<{ error: { message: string; detail: { error: string; lensId: string } } }>(
      tp.base,
      "GET",
      `/api/runs/${RUN}/lens?lens=broken-v1`,
    );
    expect(one.status).toBe(422);
    expect(one.body.error.detail.error).toBe("LensDefinitionInvalid");
    expect(one.body.error.detail.lensId).toBe("broken-v1");
    expect(one.body.error.message).toContain("V2");

    // One bad definition fails the WHOLE all-lenses call, rather than being
    // dropped from a four-lens answer that would then read as complete.
    const all = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${RUN}/lenses`,
    );
    expect(all.status).toBe(422);
    expect(all.body.error.message).toContain("broken-v1");
  });
});

/**
 * The seeded vanilla book over the regulatory grid, plus ONE custom metric
 * stage. Built in code, as the plan-run tests build theirs. The stage declares
 * exactly the ruling-6 pair, which is what T6 holds a metric stage to; Position
 * is context-supplied, so no stage produces it. There is no FTP stage: the
 * required-slot rule names NiiResult, EveResult and GapResult alone, and the
 * shorter plan is a shorter run.
 */
function customMetricPlan(component = "engine.metric.balance-summary", planId = "PLAN-CUSTOM-1") {
  return {
    schemaVersion: "1.4.0",
    planId,
    // Byte-identical to the 3b fixture on the default component: the label is
    // the literal 3b string, and only a non-default component templates it.
    label:
      component === "engine.metric.balance-summary"
        ? "Vanilla book, regulatory grid, with the demonstration custom metric"
        : `Vanilla book, regulatory grid, with the custom metric ${component}`,
    authoredBy: "person",
    asOf: "2026-03-31",
    grid: { horizonMonths: 360 },
    inputs: {
      marketSnapshot: SEED_IDS.market,
      positionBook: SEED_IDS.vanillaPortfolio,
      routingPolicy: SEED_IDS.routingPolicy,
      assumptionSets: [SEED_IDS.vanillaAssumptions],
    },
    stages: [
      { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
      { id: "st-tlp", component: "alm-tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], params: { dayCount: "ACT/360" }, dependsOn: ["st-curve"] },
      { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
      { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
      { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
      { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-curve", "st-tlp", "st-cashflow"] },
      { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow"] },
      { id: "st-custom", component, kind: "metric", consumes: ["Cashflow", "Position"], produces: ["CustomMetricResult"], dependsOn: ["st-cashflow"] },
    ],
    scenarios: [
      { ref: "regulatory-grid-v1#S0" },
      { ref: "regulatory-grid-v1#S100" },
      { ref: "regulatory-grid-v1#S-100" },
      { ref: "regulatory-grid-v1#S200" },
      { ref: "regulatory-grid-v1#S-200" },
    ],
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
    validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
  };
}
