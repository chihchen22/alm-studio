/**
 * Every finished run lands rates.json beside result.json and
 * GET /api/runs/:id/rates serves it verbatim. Deterministic and stochastic
 * runs through the real spawned child; the 404 for a missing document; the
 * conflict for a run that is not done.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  buildVanillaPortfolio,
  vanillaAssumptionSet,
  vanillaScenarios,
  generatePortfolio,
  DEFAULT_GENERATOR_CONFIG,
} from "@alm/data";
import type { RateDocument, StochasticRateFan } from "@alm/engine";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

let tp: TestPlatform;
let scenarioCount = 0;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const market = await loadTestMarket();
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);
  scenarioCount = scenarios.length;

  const vanilla = buildVanillaPortfolio();
  store.putDocument("portfolios", vanilla.id, vanilla, {
    label: vanilla.label,
    asOf: vanilla.asOf,
    positionCount: vanilla.positions.length,
  });
  const slow = generatePortfolio({
    ...DEFAULT_GENERATOR_CONFIG,
    portfolioId: "synthetic-slow-3000",
    portfolioLabel: "synthetic not-done fixture book",
    targetPositions: 3000,
  });
  store.putDocument("portfolios", slow.id, slow, {
    label: slow.label,
    asOf: slow.asOf,
    positionCount: slow.positions.length,
  });
  store.putDocument("market", "market-test", market, { label: "test market" });
  store.putDocument("assumption-sets", set.id, { ...set }, { label: set.label });
  store.putDocument(
    "scenario-slates",
    "grid",
    { id: "grid", label: "grid", scenarios },
    { label: "grid", scenarioCount: scenarios.length },
  );
}, 120_000);

afterAll(async () => {
  await tp.close();
});

const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  portfolioId: "vanilla-book-v1",
  marketId: "market-test",
  scenarioSlateId: "grid",
  assumptionSetIds: ["vanilla-empty-v1"],
  ...extra,
});

const getStatus = async (runId: string): Promise<RunStatus> =>
  (await api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`)).body;

const waitDone = async (runId: string): Promise<RunStatus> => {
  const done = await waitFor(
    () => getStatus(runId),
    (s) => s.state === "done" || s.state === "error",
    120_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
  return done;
};

let deterministicRunId: string;

describe("rate document, deterministic run", () => {
  it(
    "lands rates.json beside result.json and serves it verbatim",
    async () => {
      const sub = await api<{ runId: string }>(tp.base, "POST", "/api/runs", body());
      expect(sub.status).toBe(202);
      deterministicRunId = sub.body.runId;
      await waitDone(deterministicRunId);

      const store = tp.platform.context.store;
      expect(store.runFileExists(deterministicRunId, "rates.json")).toBe(true);
      expect(store.runFileExists(deterministicRunId, "result.json")).toBe(true);

      const res = await api<RateDocument>(tp.base, "GET", `/api/runs/${deterministicRunId}/rates`);
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("rate-document");
      expect(res.body.schemaVersion).toBe("1.2.0");
      expect(res.body.mode).toBe("deterministic");
      expect(res.body.runId).toBe(deterministicRunId);
      expect(res.body.scenarios.length).toBe(scenarioCount);
      expect(res.body.grid.horizonMonths).toBe(res.body.scenarios[0].path?.rate.length);
      expect(res.body.base.t.length).toBe(res.body.base.df.length);
      expect("stochastic" in res.body).toBe(false);

      const onDisk = readFileSync(store.paths.runFile(deterministicRunId, "rates.json"), "utf8");
      expect(res.text).toBe(onDisk);

      // Atomic landing: no temp files left behind by the second write either.
      const { readdirSync } = await import("node:fs");
      const leftovers = readdirSync(store.paths.runDir(deterministicRunId)).filter((f) =>
        f.startsWith(".tmp-"),
      );
      expect(leftovers).toEqual([]);
    },
    150_000,
  );

  it("answers 404 with a plain message once the document is gone", async () => {
    const store = tp.platform.context.store;
    const path = store.paths.runFile(deterministicRunId, "rates.json");
    expect(existsSync(path)).toBe(true);
    rmSync(path);
    const res = await api<{ error: { code: string; message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${deterministicRunId}/rates`,
    );
    expect(res.status).toBe(404);
    // The error envelope is the platform's own { error: { code, message } };
    // the raw text carries the message JSON-escaped, so read it off the body.
    expect(res.body.error.message).toBe(
      `run "${deterministicRunId}" has no rate document: it finished before runs wrote rate documents; ` +
        `re-run to produce one`,
    );
    // The result itself is untouched by the document's absence.
    const result = await api(tp.base, "GET", `/api/runs/${deterministicRunId}/result`);
    expect(result.status).toBe(200);
  });

  it("answers 404 for an unknown run", async () => {
    const res = await api(tp.base, "GET", "/api/runs/run-does-not-exist/rates");
    expect(res.status).toBe(404);
  });
});

describe("rate document, stochastic run", () => {
  it(
    "lands the fan of the base scenario beside the deterministic entries",
    async () => {
      const sub = await api<{ runId: string }>(
        tp.base,
        "POST",
        "/api/runs",
        body({
          mode: "stochastic",
          seed: "42",
          stochastic: {
            nPaths: 20,
            modelParams: { a: 0.05, sigma: 0.01, reason: "rate document fan anchor (platform test)" },
          },
        }),
      );
      expect(sub.status, sub.text).toBe(202);
      const runId = sub.body.runId;
      await waitDone(runId);

      const res = await api<RateDocument>(tp.base, "GET", `/api/runs/${runId}/rates`);
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("stochastic");
      expect(res.body.scenarios.length).toBe(scenarioCount);
      // An HW run: its fan is the Hull-White arm, which carries no `model` (rate document 1.2.0).
      const fan = res.body.stochastic as StochasticRateFan | undefined;
      expect(fan).toBeDefined();
      expect("model" in fan!).toBe(false);
      expect(fan!.nPaths).toBe(20);
      expect(fan!.a).toBe(0.05);
      expect(fan!.sigma).toBe(0.01);
      expect(fan!.quantiles.map((q) => q.p)).toEqual([0.05, 0.25, 0.5, 0.75, 0.95]);
      expect(fan!.times.length).toBe(res.body.grid.horizonMonths);
      expect(fan!.mean.length).toBe(fan!.times.length);
      for (const q of fan!.quantiles) expect(q.values.length).toBe(fan!.times.length);
      // Quantile rows are ordered at every step: p5 <= p25 <= p50 <= p75 <= p95.
      for (let k = 0; k < fan!.times.length; k++) {
        for (let i = 1; i < fan!.quantiles.length; i++) {
          expect(fan!.quantiles[i].values[k]).toBeGreaterThanOrEqual(fan!.quantiles[i - 1].values[k]);
        }
      }
      // The scenario the fan names is the base scenario of the request.
      const base = res.body.scenarios.find((s) => s.rateSpecKind === "base");
      expect(fan!.scenarioId).toBe(base?.scenarioId);
    },
    150_000,
  );
});

describe("rate document, run not done", () => {
  it("answers the same conflict the result route answers", async () => {
    const sub = await api<{ runId: string }>(
      tp.base,
      "POST",
      "/api/runs",
      body({ portfolioId: "synthetic-slow-3000" }),
    );
    expect(sub.status).toBe(202);
    const runId = sub.body.runId;
    const rates = await api(tp.base, "GET", `/api/runs/${runId}/rates`);
    const result = await api(tp.base, "GET", `/api/runs/${runId}/result`);
    expect(rates.status).toBe(409);
    expect(result.status).toBe(409);
    const cancel = await api(tp.base, "POST", `/api/runs/${runId}/cancel`);
    expect([200, 202]).toContain(cancel.status);
    await waitFor(
      () => getStatus(runId),
      (s) => s.state === "cancelled" || s.state === "done" || s.state === "error",
      60_000,
    );
  });
});
