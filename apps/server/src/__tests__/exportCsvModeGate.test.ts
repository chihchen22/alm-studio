/**
 * W5-D2 — the CSV export routes are mode-gated: a stochastic run refuses
 * typed instead of 500ing.
 *
 * The defect (W4-U1 Section 5): the
 * export path read a stochastic run's result.json as a deterministic
 * RunResult and dereferenced deterministic provenance, so a practitioner
 * driving the API directly got a raw 500 — the one failure mode this build
 * refuses everywhere else. The cure is the same posture as every other
 * deterministic read route: a typed 400 that says WHY (a distribution
 * envelope has no CSV table shape; rendering one as scenario rows would
 * misread a Monte Carlo mean as an EVE) and points at the honest read
 * (/api/runs/:id/stochastic).
 *
 * Anchors, all through the real platform path (submission -> spawned child ->
 * store -> routes):
 *   - all six per-table exports refuse a stochastic run with a typed 400,
 *     never a 500, each naming the run, the reason, and the JSON envelope;
 *   - compare.csv refuses when EITHER side is stochastic;
 *   - deterministic exports and same-run compare still 200 (regression guard);
 *   - unknown runs still 404 through the same path (the gate does not widen).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

const EXPORT_TABLES = [
  "nii",
  "eve",
  "repricing-gap",
  "liquidity-gap",
  "attribution",
  "cashflows",
] as const;

let tp: TestPlatform;
let deterministicRunId: string;
let stochasticRunId: string;

const submitBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  portfolioId: "vanilla-book-v1",
  marketId: "market-test",
  scenarioSlateId: "grid",
  assumptionSetIds: ["vanilla-empty-v1"],
  ...extra,
});

const waitDone = async (runId: string): Promise<void> => {
  const done = await waitFor(
    async () => (await api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    120_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
};

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const market = await loadTestMarket();
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);

  const vanilla = buildVanillaPortfolio();
  store.putDocument("portfolios", vanilla.id, vanilla, {
    label: vanilla.label,
    asOf: vanilla.asOf,
    positionCount: vanilla.positions.length,
  });
  store.putDocument("market", "market-test", market, { label: "test market" });
  store.putDocument("assumption-sets", set.id, { ...set }, { label: set.label });
  store.putDocument(
    "scenario-slates",
    "grid",
    { id: "grid", label: "grid", scenarios },
    { label: "grid", scenarioCount: scenarios.length },
  );

  const det = await api<{ runId: string }>(tp.base, "POST", "/api/runs", submitBody());
  expect(det.status).toBe(202);
  deterministicRunId = det.body.runId;
  await waitDone(deterministicRunId);

  // Smallest admissible path count: this test is about the export gate, not
  // the distribution; the stochastic arm's own anchors live in
  // stochasticRun.test.ts.
  const sto = await api<{ runId: string }>(
    tp.base,
    "POST",
    "/api/runs",
    submitBody({ mode: "stochastic", seed: "42", stochastic: { nPaths: 20 } }),
  );
  expect(sto.status).toBe(202);
  stochasticRunId = sto.body.runId;
  await waitDone(stochasticRunId);
}, 300_000);

afterAll(async () => {
  await tp.close();
});

describe("stochastic CSV export refuses typed (the disclosed 500 is cured)", () => {
  it("all six per-table exports return a typed 400 naming the run, the reason, and the JSON envelope", async () => {
    for (const table of EXPORT_TABLES) {
      const r = await api<{ error: { code: string; message: string } }>(
        tp.base,
        "GET",
        `/api/runs/${stochasticRunId}/export/${table}.csv`,
      );
      expect(r.status, table).toBe(400);
      expect(r.body.error.code, table).toBe("bad-request");
      expect(r.body.error.message, table).toContain(`run "${stochasticRunId}" is a stochastic run`);
      expect(r.body.error.message, table).toContain("distribution envelope");
      expect(r.body.error.message, table).toContain("no CSV table shape");
      expect(r.body.error.message, table).toContain(`/api/runs/${stochasticRunId}/stochastic`);
      expect(r.body.error.message, table).not.toContain("/api/compare/stochastic");
    }
  });

  it("compare.csv refuses when either side is stochastic", async () => {
    for (const runs of [
      `${deterministicRunId},${stochasticRunId}`,
      `${stochasticRunId},${deterministicRunId}`,
    ]) {
      const r = await api<{ error: { code: string; message: string } }>(
        tp.base,
        "GET",
        `/api/compare.csv?runs=${runs}&table=eve`,
      );
      expect(r.status, runs).toBe(400);
      expect(r.body.error.message, runs).toContain(`run "${stochasticRunId}" is a stochastic run`);
      expect(r.body.error.message, runs).toContain("/api/compare/stochastic");
    }
  });

  it("deterministic exports and same-run compare still work through the gated path", async () => {
    const csv = await api(tp.base, "GET", `/api/runs/${deterministicRunId}/export/eve.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.startsWith(`# runId,${deterministicRunId}`)).toBe(true);

    const cmp = await api(
      tp.base,
      "GET",
      `/api/compare.csv?runs=${deterministicRunId},${deterministicRunId}&table=eve`,
    );
    expect(cmp.status).toBe(200);
  });

  it("unknown run ids still 404 (the gate does not widen the not-found path)", async () => {
    const r = await api<{ error: { code: string } }>(
      tp.base,
      "GET",
      "/api/runs/ghost/export/eve.csv",
    );
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not-found");
  });
});
