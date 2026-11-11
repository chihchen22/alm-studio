/**
 * W3-A4b — the stochastic platform arm, end to end against the real spawned
 * child, plus the FTP result-section fix (wave-2 gate finding 1).
 *
 * Anchors exercised THROUGH the platform path (submission -> child ->
 * store -> routes), not merely the engine:
 *
 *   - a stochastic submission produces the SEPARATE distribution envelope
 *     with path count N and the SE of the mean, served verbatim at
 *     /api/runs/:id/stochastic and refused on every deterministic read route;
 *   - zero-vol degeneracy: a sigma=0 stochastic run's mean EVE reproduces the
 *     deterministic base EVE (1e-6 relative) with both numbers fetched over
 *     HTTP — the wiring proof for the whole platform arm;
 *   - every W2-A4 refusal surfaces as a typed 422 at submission time (path
 *     count, RUN_PERF cost gate, seed, cap vols, missing base scenario,
 *     dynamic new business), never a 500 and never a queued run that dies;
 *   - the stored envelope flows through the persistence seam: the file
 *     store stays the byte store of record and the DB mirror links the run by
 *     content hash with an honestly-NULL engine inputsHash (the envelope
 *     carries no deterministic provenance block);
 *   - GET /api/runs/:id/result/ftp serves the ftp block (the section
 *     whitelist gap the wave-2 gate reported).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, StochasticRunResult, FtpResult } from "@alm/engine";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import { sha256Hex } from "../store/store";
import { openPlatformDb } from "../db/database";
import { syncStoreToDb } from "../db/ingest";
import type { RunStatus } from "../jobs/types";
import { deriveMarketSnapshot } from "@alm/engine/src/market";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

let tp: TestPlatform;
let savedRunPerf: string | undefined;

beforeAll(async () => {
  savedRunPerf = process.env.RUN_PERF;
  delete process.env.RUN_PERF; // the cost gate must be closed for the refusal test
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
  // A snapshot with the ATM cap surface stripped: the calibration refusal case.
  store.putDocument("market", "market-no-vols", { ...market, capQuotes: [] }, {
    label: "test market without cap vols",
  });
  // Piece 6d lineage fixtures. vol-market: a short-rate volatility scale from market-test.
  // chained-market: a TLP add on top of vol-market (the vol shock is two links up).
  // tlp-market: a TLP-only derive. orphan-market: a derivedFrom whose base is not stored.
  const volDerived = deriveMarketSnapshot(market, [{ op: "scale-short-rate-vol", value: 1.5 }], {
    baseId: "market-test",
    id: "vol-market",
  });
  store.putDocument("market", "vol-market", volDerived.snapshot, { label: "vol shock", derivedFromMarketId: "market-test" });
  const chained = deriveMarketSnapshot(volDerived.snapshot, [{ op: "add", value: 10 }], {
    baseId: "vol-market",
    id: "chained-market",
  });
  store.putDocument("market", "chained-market", chained.snapshot, { label: "chained", derivedFromMarketId: "vol-market" });
  const tlpDerived = deriveMarketSnapshot(market, [{ op: "add", value: 10 }], { baseId: "market-test", id: "tlp-market" });
  store.putDocument("market", "tlp-market", tlpDerived.snapshot, { label: "tlp shock", derivedFromMarketId: "market-test" });
  store.putDocument(
    "market",
    "orphan-market",
    { ...market, derivedFrom: { baseId: "missing-base", baseContentHash: "x", ops: [{ op: "add", value: 1 }] } },
    { label: "orphan" },
  );
  store.putDocument("assumption-sets", set.id, { ...set }, { label: set.label });
  store.putDocument(
    "scenario-slates",
    "grid",
    { id: "grid", label: "grid", scenarios },
    { label: "grid", scenarioCount: scenarios.length },
  );
  // A slate with no base scenario (shocked only): the refusal case.
  const shocked = scenarios.filter((s) => s.rateSpec.kind !== "base");
  store.putDocument(
    "scenario-slates",
    "shocks-only",
    { id: "shocks-only", label: "shocks only", scenarios: shocked },
    { label: "shocks only", scenarioCount: shocked.length },
  );
  // A slate whose base scenario requests dynamic new business: refusal case.
  const base = scenarios.find((s) => s.rateSpec.kind === "base")!;
  const dynBase = [{ ...base, newBusiness: { mode: "dynamic", rules: [] } }];
  store.putDocument(
    "scenario-slates",
    "dynamic-base",
    { id: "dynamic-base", label: "dynamic base", scenarios: dynBase },
    { label: "dynamic base", scenarioCount: 1 },
  );
}, 120_000);

afterAll(async () => {
  if (savedRunPerf !== undefined) process.env.RUN_PERF = savedRunPerf;
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

// Shared across tests in declaration order (vitest runs a file sequentially).
let stochasticRunId: string;
let deterministicRunId: string;

describe("stochastic submission arm", () => {
  it(
    "a stochastic run submits, computes in the child, and serves the separate envelope with N and SE",
    async () => {
      const sub = await api<{
        runId: string;
        mode: string;
        stochastic?: { nPaths: number; costNote: string };
      }>(tp.base, "POST", "/api/runs", body({ mode: "stochastic", stochastic: { nPaths: 256 }, seed: "42" }));
      expect(sub.status).toBe(202);
      expect(sub.body.mode).toBe("stochastic");
      // The request field echoed exactly, with an honest cost label.
      expect(sub.body.stochastic?.nPaths).toBe(256);
      expect(sub.body.stochastic?.costNote).toContain("256");
      stochasticRunId = sub.body.runId;
      await waitDone(stochasticRunId);

      const detail = await api<{ mode: string; stochastic?: { nPaths: number } }>(
        tp.base,
        "GET",
        `/api/runs/${stochasticRunId}`,
      );
      expect(detail.body.mode).toBe("stochastic");
      expect(detail.body.stochastic?.nPaths).toBe(256);

      const env = await api<StochasticRunResult>(tp.base, "GET", `/api/runs/${stochasticRunId}/stochastic`);
      expect(env.status).toBe(200);
      expect(env.body.kind).toBe("stochastic-distribution");
      expect(env.body.model).toBe("hull-white-1f");
      expect(env.body.nPaths).toBe(256);
      expect(env.body.seed).toBe("42");
      // Anti-fabrication: N and SE on every distribution.
      expect(env.body.eveDistribution.nPaths).toBe(256);
      expect(env.body.eveDistribution.standardError).toBeGreaterThan(0);
      expect(env.body.nii12mDistribution.nPaths).toBe(256);
      expect(env.body.nii12mDistribution.standardError).toBeGreaterThan(0);
      // Calibration RMSE surfaced with the gate flag truthful.
      expect(env.body.calibration.source).toBe("cap-atm-calibration");
      if (env.body.calibration.source === "cap-atm-calibration") {
        expect(env.body.calibration.rmseGateBreached).toBe(
          env.body.calibration.rmseBp > env.body.calibration.rmseGateBp,
        );
      }
      // The corrected martingale identity the discounting relies on.
      expect(env.body.martingale.correctedMaxAbsErrBp).toBeLessThan(1e-8);
      // Served verbatim: the HTTP bytes ARE the stored bytes.
      const onDisk = readFileSync(
        tp.platform.context.store.paths.runFile(stochasticRunId, "result.json"),
        "utf8",
      );
      expect(env.text).toBe(onDisk);
      console.log(
        `[measured] platform stochastic envelope: N=${env.body.eveDistribution.nPaths}, ` +
          `EVE mean=${env.body.eveDistribution.mean}, SE=${env.body.eveDistribution.standardError}, ` +
          `martingale corrected=${env.body.martingale.correctedMaxAbsErrBp} bp, ` +
          `rmseBp=${env.body.calibration.source === "cap-atm-calibration" ? env.body.calibration.rmseBp : "n/a"}`,
      );
    },
    240_000,
  );

  it("deterministic reads refuse a stochastic run typed — a distribution can never read as an EVE", async () => {
    for (const path of [
      `/api/runs/${stochasticRunId}/result`,
      `/api/runs/${stochasticRunId}/result/eve`,
      `/api/runs/${stochasticRunId}/query?metric=eve&scenarioId=S0`,
    ]) {
      const r = await api<{ error: { message: string } }>(tp.base, "GET", path);
      expect(r.status, path).toBe(400);
      expect(r.body.error.message, path).toContain("stochastic");
      expect(r.body.error.message, path).toContain(`/api/runs/${stochasticRunId}/stochastic`);
    }
    const ex = await api<{ error: { message: string } }>(
      tp.base,
      "POST",
      `/api/runs/${stochasticRunId}/explain`,
      { metric: "eve", scenarioId: "S0" },
    );
    expect(ex.status).toBe(400);
    expect(ex.body.error.message).toContain("stochastic");
  });

  it("the stochastic run flows through the W3-D1 DB mirror: linked by result hash, inputsHash honestly NULL", async () => {
    const store = tp.platform.context.store;
    const db = openPlatformDb(join(tp.storeRoot, "test-mirror.db"));
    try {
      syncStoreToDb(store, db);
      const row = db.db
        .prepare("SELECT state, result_content_hash, engine_inputs_hash FROM runs WHERE run_id = ?")
        .get(stochasticRunId) as
        | { state: string; result_content_hash: string | null; engine_inputs_hash: string | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.state).toBe("done");
      const bytes = store.readRunBytes(stochasticRunId, "result.json");
      expect(row!.result_content_hash).toBe(sha256Hex(bytes));
      // The envelope has no deterministic provenance block; NULL is the honest value.
      expect(row!.engine_inputs_hash).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("zero-vol degeneracy through the platform path", () => {
  it(
    "a sigma=0 stochastic run's mean EVE reproduces the deterministic base EVE over HTTP (1e-6 relative)",
    async () => {
      // Deterministic side, fetched through the platform.
      const det = await api<{ runId: string }>(tp.base, "POST", "/api/runs", body());
      expect(det.status).toBe(202);
      deterministicRunId = det.body.runId;
      await waitDone(deterministicRunId);
      const eve = await api<RunResult["eve"]>(tp.base, "GET", `/api/runs/${deterministicRunId}/result/eve`);
      expect(eve.status).toBe(200);
      const baseEve = eve.body.byScenario.find((s) => s.scenarioId === "S0")?.eve;
      expect(baseEve).toBeDefined();

      // Stochastic side at sigma = 0 (explicit override, recorded as such).
      const sub = await api<{ runId: string }>(
        tp.base,
        "POST",
        "/api/runs",
        body({
          mode: "stochastic",
          seed: "42",
          stochastic: {
            nPaths: 256,
            modelParams: { a: 0.05, sigma: 0, reason: "zero-vol degeneracy anchor (platform test)" },
          },
        }),
      );
      expect(sub.status).toBe(202);
      await waitDone(sub.body.runId);
      const env = await api<StochasticRunResult>(tp.base, "GET", `/api/runs/${sub.body.runId}/stochastic`);
      expect(env.status).toBe(200);
      expect(env.body.calibration.source).toBe("override");

      const relErr = Math.abs(env.body.eveDistribution.mean - baseEve!) / Math.abs(baseEve!);
      console.log(
        `[measured] zero-vol degeneracy through the platform: stochastic mean ` +
          `${env.body.eveDistribution.mean} vs deterministic base EVE ${baseEve}, ` +
          `relative error ${relErr.toExponential(3)}`,
      );
      expect(relErr).toBeLessThanOrEqual(1e-6);
      // Degenerate distribution: a point mass, SE collapses.
      expect(env.body.eveDistribution.standardError).toBeLessThan(
        1e-9 * Math.abs(env.body.eveDistribution.mean),
      );
    },
    300_000,
  );

  it("GET /result/ftp serves the FTP block on a deterministic run (wave-2 gate finding 1)", async () => {
    const ftp = await api<FtpResult>(tp.base, "GET", `/api/runs/${deterministicRunId}/result/ftp`);
    expect(ftp.status).toBe(200);
    expect(Array.isArray(ftp.body.byFamily)).toBe(true);
    expect(ftp.body.byFamily.length).toBeGreaterThan(0);
    // Verbatim slice of the stored envelope, not a recompute.
    const stored = JSON.parse(
      readFileSync(tp.platform.context.store.paths.runFile(deterministicRunId, "result.json"), "utf8"),
    ) as RunResult;
    expect(ftp.body).toEqual(stored.ftp);
    // And a stochastic run refuses the same section, typed.
    const wrong = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${stochasticRunId}/result/ftp`,
    );
    expect(wrong.status).toBe(400);
  });

  it("GET /stochastic on a deterministic run refuses typed, pointing at /result", async () => {
    const r = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${deterministicRunId}/stochastic`,
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("deterministic");
    expect(r.body.error.message).toContain(`/api/runs/${deterministicRunId}/result`);
  });
});

describe("submission refusals: typed 422, never 500, never a queued run that dies", () => {
  const expect422 = async (payload: Record<string, unknown>, ...fragments: string[]): Promise<void> => {
    const r = await api<{ error: { code: string; message: string } }>(tp.base, "POST", "/api/runs", payload);
    expect(r.status, JSON.stringify(payload)).toBe(422);
    expect(r.body.error.code).toBe("validation");
    for (const f of fragments) {
      expect(r.body.error.message, JSON.stringify(payload)).toContain(f);
    }
  };

  it("path count below the quantile support bound", async () => {
    await expect422(body({ mode: "stochastic", stochastic: { nPaths: 15 } }), "even integer", "20");
  });

  it("odd path count (antithetic pairing)", async () => {
    await expect422(body({ mode: "stochastic", stochastic: { nPaths: 21 } }), "never silently adjusts");
  });

  it("non-integer path count", async () => {
    await expect422(body({ mode: "stochastic", stochastic: { nPaths: 25.5 } }), "integer");
  });

  it("heavier-than-default counts sit behind RUN_PERF with an honest cost label", async () => {
    await expect422(
      body({ mode: "stochastic", stochastic: { nPaths: 512 } }),
      "RUN_PERF",
      "never silently reduced",
      "positions x paths",
    );
  });

  it("a seed that does not parse as an integer for the PCG32", async () => {
    await expect422(body({ mode: "stochastic", seed: "platform-0" }), "integer seed");
  });

  it("a market snapshot without ATM cap vols and no override", async () => {
    // The refusal reworded to the words of record.
    await expect422(body({ mode: "stochastic", marketId: "market-no-vols" }), "at-the-money column", "short-rate volatility surface");
  });

  it("a slate with no base scenario (base only)", async () => {
    await expect422(body({ mode: "stochastic", scenarioSlateId: "shocks-only" }), "base scenario", "shocked-NII convention migration");
  });

  it("a base scenario requesting dynamic new business", async () => {
    await expect422(body({ mode: "stochastic", scenarioSlateId: "dynamic-base" }), "dynamic new");
  });

  it("a malformed modelParams override", async () => {
    await expect422(
      body({ mode: "stochastic", stochastic: { modelParams: { a: "x" } } }),
      "modelParams",
    );
  });

  it("an unknown mode", async () => {
    await expect422(body({ mode: "banana" }), "mode", "banana");
  });

  it("stochastic options on a deterministic submission are refused, not silently ignored", async () => {
    await expect422(body({ stochastic: { nPaths: 64 } }), "deterministic");
  });
});

describe("Piece 6d: a modelParams override on a volatility-shocked market is refused at the route", () => {
  const OVERRIDE = { a: 0.03, sigma: 0.01, reason: "probe" };
  const runCount = async (): Promise<number> =>
    (await api<unknown[]>(tp.base, "GET", "/api/runs")).body.length;
  const submit = (marketId: string, extra: Record<string, unknown> = {}) =>
    api<{ runId?: string; error?: { code: string; message: string } }>(
      tp.base,
      "POST",
      "/api/runs",
      body({ mode: "stochastic", marketId, stochastic: { nPaths: 20, ...extra }, seed: "42" }),
    );

  it("the market itself carries the shock: 422 naming the market, the link and the base", async () => {
    const before = await runCount();
    const r = await submit("vol-market", { modelParams: OVERRIDE });
    expect(r.status).toBe(422);
    expect(r.body.error!.message).toContain(
      'market "vol-market" carries a short-rate volatility shock (applied in market "vol-market" on base "market-test")',
    );
    expect(await runCount()).toBe(before);
  });

  it("a TLP shock chained on top of the vol shock is still refused, naming the vol link", async () => {
    const before = await runCount();
    const r = await submit("chained-market", { modelParams: OVERRIDE });
    expect(r.status).toBe(422);
    expect(r.body.error!.message).toContain('(applied in market "vol-market" on base "market-test")');
    expect(await runCount()).toBe(before);
  });

  it("a lineage that cannot be followed is refused, not guessed", async () => {
    const before = await runCount();
    const r = await submit("orphan-market", { modelParams: OVERRIDE });
    expect(r.status).toBe(422);
    expect(r.body.error!.message).toContain(
      'cannot be followed past "orphan-market" (base "missing-base" is not in the store)',
    );
    expect(await runCount()).toBe(before);
  });

  it("a TLP-only derived market with an override is accepted", async () => {
    const r = await submit("tlp-market", { modelParams: OVERRIDE });
    expect(r.status).toBe(202);
    await waitDone(r.body.runId!);
  }, 240_000);

  it("the vol-shocked market without an override is accepted and reaches done", async () => {
    const r = await submit("vol-market");
    expect(r.status).toBe(202);
    await waitDone(r.body.runId!);
  }, 240_000);
});
