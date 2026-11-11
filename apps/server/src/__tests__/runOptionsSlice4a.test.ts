/**
 * Studio piece D slice 4a, Task 3 (spec rulings 1, 9 and 12): liquidity flows of principal plus interest, from the
 * stored setup to the stage env.
 *
 *  - The compile no longer warns about principal plus interest (the setting is honoured); the compiled row's
 *    engine options carry `liquidityFlows`, written only for "principal-plus-interest" on a ladder switched on.
 *  - The run route stores "principal-plus-interest" under the same name, drops "principal" (the default), refuses
 *    any other value by name, and refuses "principal-plus-interest" on a stochastic submission with a typed 422.
 *  - Round trip: a workspace setup saved onto principal plus interest validates with no warning, launches with no
 *    acknowledgement, stores `liquidityFlows` in request.json, and its result carries `withInterest` on every
 *    liquidity ladder and on no repricing ladder. The metric stage builds `withInterest` only when its StageRunEnv
 *    carries the option, so the result is the env read from outside the child process.
 *
 * Expected values and sentences are restated by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunResult } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { buildTable, renderCsv } from "../export/csv";
import { resolveEngineOptions } from "../http/routes/runs";
import { pipelineOptionsOf } from "../jobs/pipelineOptions";
import type { RunStatus, StoredRunRequest } from "../jobs/types";
import { FileStore } from "../store/store";
import { engineOptionsOfSetup } from "../workspaces/setupCompile";
import { standardAlcoSetup } from "../workspaces/standardAlco";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

function base(): Omit<RunSetup, "id"> {
  const { id: _id, ...alco } = standardAlcoSetup("ws-slice4a");
  return alco;
}

const withFlows = (s: Omit<RunSetup, "id">, flows: "principal" | "principal-plus-interest", enabled = true): Omit<RunSetup, "id"> => ({
  ...s,
  gap: { ...s.gap, liquidity: { ...s.gap.liquidity, enabled, flows } },
});

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

describe("engine options of a setup: liquidityFlows", () => {
  it("writes liquidityFlows only for principal plus interest on a ladder that is switched on", () => {
    expect(engineOptionsOfSetup(withFlows(base(), "principal-plus-interest")).liquidityFlows).toBe("principal-plus-interest");
    expect(has(engineOptionsOfSetup(withFlows(base(), "principal")), "liquidityFlows")).toBe(false);
    expect(has(engineOptionsOfSetup(withFlows(base(), "principal-plus-interest", false)), "liquidityFlows")).toBe(false);
  });
});

describe("the run route's engine options: liquidityFlows", () => {
  it("stores principal plus interest under its own name and drops principal, the flows a run gets without asking", () => {
    expect(resolveEngineOptions({ liquidityFlows: "principal-plus-interest" }, 360)).toEqual({
      durationMode: "base-only", shards: "auto", liquidityFlows: "principal-plus-interest",
    });
    expect(resolveEngineOptions({ liquidityFlows: "principal" }, 360)).toEqual({ durationMode: "base-only", shards: "auto" });
  });

  it("refuses any other value, naming the field", () => {
    expect(() => resolveEngineOptions({ liquidityFlows: "interest-only" }, 360)).toThrow(
      'engineOptions.liquidityFlows must be "principal" or "principal-plus-interest", got "interest-only"',
    );
  });

  it("hands the stored option to the pipeline under the same name, and nothing for a context that has none", () => {
    const stored = resolveEngineOptions({ liquidityFlows: "principal-plus-interest" }, 360);
    expect(pipelineOptionsOf(JSON.parse(JSON.stringify(stored))).liquidityFlows).toBe("principal-plus-interest");
    expect(has(pipelineOptionsOf(resolveEngineOptions(undefined, 360)), "liquidityFlows")).toBe(false);
  });
});

describe("POST /api/runs and the workspace launch: liquidityFlows", () => {
  let t: TestPlatform;
  beforeAll(async () => {
    t = await bootTestPlatform();
    await seedStore(new FileStore(t.storeRoot), repoRoot());
  }, 120_000);
  afterAll(() => t.close());

  const body = { portfolioId: "p", marketId: "m", scenarioSlateId: "s", assumptionSetIds: ["a"] };
  type Refusal = { error: { code: string; message: string } };

  it("refuses principal plus interest on a stochastic submission with a typed 422, before any document is read", async () => {
    const r = await api<Refusal>(t.base, "POST", "/api/runs", {
      ...body, mode: "stochastic", engineOptions: { liquidityFlows: "principal-plus-interest" },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.message).toBe(
      'engineOptions.liquidityFlows "principal-plus-interest" applies to a deterministic run only; the stochastic ' +
        "envelope carries no gap ladder, so drop the option or run deterministic",
    );
  });

  it("refuses a malformed value on a stochastic submission by name; principal, the default, is not the refusal", async () => {
    const bad = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { liquidityFlows: 1 } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("validation");
    expect(bad.body.error.message).toBe('engineOptions.liquidityFlows must be "principal" or "principal-plus-interest", got 1');
    // "principal" stores nothing, so the stochastic route goes on to read the (missing) documents instead.
    const plain = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { liquidityFlows: "principal" } });
    expect(plain.body.error.message).not.toMatch(/liquidityFlows/);
  });

  it("setup, compile, launch, run: principal plus interest validates clean, launches unacknowledged and writes withInterest", async () => {
    const id = "ws-flows";
    const blocks = (rev: number, b: object) =>
      api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...b });
    expect((await api(t.base, "POST", "/api/workspaces", { id, name: "F", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" })).status).toBe(201);
    await blocks(1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    await blocks(2, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await blocks(3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    const w = (await blocks(4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } })).body;
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const setup = (await api<{ setups: Array<{ setup: RunSetup }> }>(t.base, "GET", `/api/run-setups?workspaceId=${id}`)).body.setups[0]!.setup;
    const saved = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", {
      workspaceId: id, setupLineageId: slot, expectedRevision: w.revision, by: "tester",
      setup: { ...withFlows(setup, "principal-plus-interest"), id: undefined, supersedes: setup.id },
    });
    expect(saved.status).toBe(201);

    // Compile: no warning (the old "reserved for piece D" sentence is gone), so the outcome is a pass.
    const v = await api<{ outcome: string; reports: { warnings: string[] } }>(t.base, "POST", `/api/workspaces/${id}/setups/${slot}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.body.outcome).toBe("pass");
    expect(v.body.reports.warnings).toEqual([]);

    // Launch: nothing to acknowledge.
    const launched = await api<{ runIds: string[]; failed: unknown[] }>(t.base, "POST", `/api/workspaces/${id}/setups/${slot}/launch`, { by: "tester" });
    expect(launched.status).toBe(200);
    expect(launched.body.failed).toEqual([]);
    const runId = launched.body.runIds[0]!;
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<StoredRunRequest>(runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto",
      // Standard ALCO carries the corrections.
      modelConvention: "corrected-v1",
      gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" }, liquidityFlows: "principal-plus-interest",
      reportHorizons: [12, 24, 60],
    });

    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    const result = store.readRunJson<RunResult>(runId, "result.json");
    expect(result.gap.liquidity.length).toBeGreaterThan(0);
    for (const ladder of result.gap.liquidity) {
      expect(ladder.withInterest!.rows.map((r) => r.band.label)).toEqual(ladder.rows.map((r) => r.band.label));
      // The setup asks for a monthly liquidity interval, so the interest-inclusive ladder carries it too.
      expect(ladder.withInterest!.userBuckets!.kind).toBe("monthly");
      // Amendment A2: the interest on its own rides beside the combined rows, on the same bands and buckets.
      expect(ladder.withInterest!.interest.rows.map((r) => r.band.label)).toEqual(ladder.rows.map((r) => r.band.label));
      expect(ladder.withInterest!.interest.userBuckets!.kind).toBe("monthly");
    }
    for (const ladder of result.gap.repricing) expect(has(ladder, "withInterest")).toBe(false);

    // The principal liquidity CSV reads rows and byCoaNode only, so it is byte-identical with withInterest
    // stripped; the interest-inclusive ladder has its own file (Studio's Download CSV on the second card).
    const stripped = JSON.parse(JSON.stringify(result)) as RunResult;
    for (const ladder of stripped.gap.liquidity) delete ladder.withInterest;
    const prov = { runId: runId, inputsHash: "h", curve: "c", schemaVersion: "s", engineVersion: "e" };
    for (const table of ["liquidity-gap", "repricing-gap"] as const) {
      expect(renderCsv(buildTable(result, table), prov, "t")).toBe(renderCsv(buildTable(stripped, table), prov, "t"));
    }
  }, 300_000);
});
