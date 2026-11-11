/**
 * GET /api/compare/stochastic: two stored stochastic envelopes aligned
 * by the engine's compareStochastic, served as one JSON reply. The server adds
 * no number; it reads two result.json files and two request.json submissions.
 *
 * Seeded end-to-end proof on the public market pack and its volatility-shocked
 * derivation (vol-shock-demo-v1), vanilla book, 64 paths, default seed 20260331.
 * Every literal below was measured on the unmodified code in a probe
 * and is never re-pinned. Expected strings are restated here, never imported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const BASE_ID = "market-public-2026-03-31";
const SHOCK_ID = "vol-shock-demo-v1";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Row { stat: string; p: number | null; a: number; b: number; delta: number }
interface CtxRow { field: string; a: unknown; b: unknown; same: boolean }
interface Block { rows: Row[]; meanDeltaStandardError: { value: number | null; basis: string; text: string } }

let t: TestPlatform;
let runA: string; // base market, seed 20260331, 64 paths
let runB: string; // shocked market, seed 20260331, 64 paths
let runC: string; // shocked market, seed 20260401
let runD: string; // base market, 32 paths
let runE: string; // base market, horizon 120
let runF: string; // deterministic, base market
let runG: string; // stochastic request, status running

const submit = async (marketId: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await api<{ runId: string }>(t.base, "POST", "/api/runs", {
    portfolioId: "vanilla-book-v1",
    marketId,
    scenarioSlateId: "regulatory-grid-vanilla",
    assumptionSetIds: ["vanilla-empty-v1"],
    mode: "stochastic",
    stochastic: { nPaths: 64 },
    ...extra,
  });
  expect(r.status).toBe(202);
  return r.body.runId;
};
const waitDone = async (runId: string): Promise<void> => {
  const done = await waitFor(
    async () => (await api<RunStatus>(t.base, "GET", `/api/runs/${runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    240_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
};
const cmp = (a: string, b: string) => api<Json>(t.base, "GET", `/api/compare/stochastic?runs=${a},${b}`);
const rel = (x: number, y: number): number => Math.abs(x - y) / Math.abs(y);
const row = (blk: Block, stat: string, p: number | null = null): Row => {
  const r = blk.rows.find((x) => x.stat === stat && x.p === p);
  if (r === undefined) throw new Error(`no row ${stat} ${String(p)}`);
  return r;
};
const ctx = (rows: CtxRow[], field: string): CtxRow => {
  const r = rows.find((x) => x.field === field);
  if (r === undefined) throw new Error(`no context row ${field}`);
  return r;
};

const NOTE_1 =
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every B - A is derived by the server from the two stored envelopes, displayed beside both originals.";
const NOTE_2 =
  "The B - A of a quantile is the difference of the two runs' quantiles. It is not a quantile of the path-by-path difference: per-path values are not stored, so no distribution of B - A exists and none is shown.";
const NOTE_3 =
  "The B - A of the standard deviation, the standard error, the minimum and the maximum is a difference of two estimates, each from its own path set; it carries sampling error of its own that the envelopes do not report.";
const NOTE_NPATHS =
  "The two runs use different path counts, so each statistic is estimated at its own precision; the B - A of a quantile, and most of all of the minimum and the maximum, which widen with the path count, mixes the change between the runs with the change in sample size.";
const TEXT_UNALIGNED =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors. Both runs use the same seed but different path counts. The simulation draws its random numbers step by step across all paths, so with different path counts the two path sets do not line up path by path. The figure is therefore neither the exact standard error of the difference nor a proven bound on it; it holds only under an independence assumption that the stored statistics cannot confirm, because per-path values are not stored. It is a precision figure, not a test.";

beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  runA = await submit(BASE_ID);
  runB = await submit(SHOCK_ID);
  runC = await submit(SHOCK_ID, { seed: "20260401" });
  runD = await submit(BASE_ID, { stochastic: { nPaths: 32 } });
  runE = await submit(BASE_ID, { gridHorizonMonths: 120 });
  const det = await api<{ runId: string }>(t.base, "POST", "/api/runs", {
    portfolioId: "vanilla-book-v1",
    marketId: BASE_ID,
    scenarioSlateId: "regulatory-grid-vanilla",
    assumptionSetIds: ["vanilla-empty-v1"],
  });
  expect(det.status).toBe(202);
  runF = det.body.runId;
  for (const id of [runA, runB, runC, runD, runE, runF]) await waitDone(id);

  // G: a stochastic request that never finished (status running).
  runG = "run-stochcmp-notdone";
  const store = t.platform.context.store;
  store.writeRunJson(runG, "request.json", store.readRunJson<unknown>(runA, "request.json"));
  store.writeRunJson(runG, "status.json", {
    runId: runG,
    state: "running",
    submittedAt: "2026-10-07T00:00:00.000Z",
    platformRequestHash: "0".repeat(64),
    summary: {
      portfolioId: "vanilla-book-v1",
      marketId: BASE_ID,
      scenarioSlateId: "regulatory-grid-vanilla",
      scenarioCount: 1,
    },
  });
}, 480_000);
afterAll(() => t.close());

describe("P1: seeded proof, base market against the volatility-shocked market", () => {
  it("answers 200 with the aligned distributions, the context and the notes", async () => {
    const r = await cmp(runA, runB);
    expect(r.status).toBe(200);
    const body = r.body;
    expect(body.kind).toBe("stochastic-compare");
    expect(body.runA).toBe(runA);
    expect(body.runB).toBe(runB);
    expect(body.sameRun).toBe(false);
    expect(body.notes).toEqual([NOTE_1, NOTE_2, NOTE_3]);

    const eve = body.eveDistribution as Block;
    const sd = row(eve, "stdev");
    // On curve default 2 (was 6855510.898898505); deltas Step 1
    expect(rel(sd.a, 6843610.473478725)).toBeLessThan(1e-9);
    // On curve default 2 (was 10289688.848804412); deltas Step 1
    expect(rel(sd.b, 10271827.171520496)).toBeLessThan(1e-9);
    // On curve default 2 (was 3434177.9499059077); deltas Step 1
    expect(rel(sd.delta, 3428216.6980417706)).toBeLessThan(1e-9);
    expect(sd.delta).toBe(sd.b - sd.a);

    const mean = row(eve, "mean");
    // On curve default 2 (was 121065587.85061447); deltas Step 1
    expect(rel(mean.a, 120866072.26933384)).toBeLessThan(1e-9);
    expect(Math.abs(mean.delta)).toBeLessThan(1e-6);

    // value = sqrt(61115.42003776055^2 + 137265.36229757924^2) (curve default 2 SEs)
    const fig = eve.meanDeltaStandardError;
    expect(fig.basis).toBe("shared-seed-bound");
    expect(fig.value).not.toBeNull();
    // On curve default 2 (was 150508.09101324185); deltas Step 1
    expect(rel(fig.value as number, 150256.0290074165)).toBeLessThan(1e-9);
    expect(Math.abs(mean.delta)).toBeLessThanOrEqual(fig.value as number);

    // On curve default 2 (was 76277.67047625595); deltas Step 1
    expect(rel(row(eve, "standardError").delta, 76149.9422598187)).toBeLessThan(1e-9);
    // On curve default 2 (was 5799869.741523936); deltas Step 1
    expect(rel(row(eve, "quantile", 0.95).delta, 5789546.009586453)).toBeLessThan(1e-9);
    // On curve default 2 (was -4733782.790537342); deltas Step 1
    expect(rel(row(eve, "quantile", 0.05).delta, -4725286.489804804)).toBeLessThan(1e-9);

    const nii = body.nii12mDistribution as Block;
    for (const x of nii.rows) expect(x.delta, `${x.stat} ${String(x.p)}`).toBe(0);
    expect(Math.abs(row(nii, "stdev").a - 5.632109537858176e-9)).toBeLessThan(1e-15);
    expect(Math.abs(row(nii, "stdev").b - 5.632109537858176e-9)).toBeLessThan(1e-15);

    const c = body.context as CtxRow[];
    expect(c).toHaveLength(23);
    expect(ctx(c, "seed")).toMatchObject({ a: "20260331", b: "20260331", same: true });
    expect(ctx(c, "nPaths")).toMatchObject({ a: 64, b: 64, same: true });
    expect(ctx(c, "horizonMonths")).toMatchObject({ a: 360, b: 360, same: true });
    expect(ctx(c, "discountBasis")).toMatchObject({ a: "all-in", b: "all-in", same: true });
    expect(ctx(c, "marketId")).toMatchObject({ a: BASE_ID, b: SHOCK_ID, same: false });
    expect(ctx(c, "portfolioId")).toMatchObject({ a: "vanilla-book-v1", b: "vanilla-book-v1", same: true });
    const sg = ctx(c, "calibration.sigma");
    // On curve default 2 (was 0.0061184513287782325); deltas Step 1
    expect(rel(sg.a as number, 0.006116484379837266)).toBeLessThan(1e-9);
    // On curve default 2 (was 0.009177675604594539); deltas Step 1
    expect(rel(sg.b as number, 0.009174725148401753)).toBeLessThan(1e-9);
    expect(sg.same).toBe(false);
    const ca = ctx(c, "calibration.a");
    expect(Math.abs((ca.b as number) - (ca.a as number))).toBeLessThan(1e-7);
    expect(ctx(c, "calibration.rmseGateBreached")).toMatchObject({ a: false, b: false });
  }, 60_000);
});

describe("P2: independent seeds", () => {
  it("A against C names the independent-seeds basis", async () => {
    const r = await cmp(runA, runC);
    expect(r.status).toBe(200);
    const eve = r.body.eveDistribution as Block;
    expect(eve.meanDeltaStandardError.basis).toBe("independent-seeds");
    // On curve default 2 (was 177463.0775551312); deltas Step 1
    expect(rel(eve.meanDeltaStandardError.value as number, 177171.2209494642)).toBeLessThan(1e-9);
    expect(Math.abs(row(eve, "mean").delta)).toBeLessThan(1e-6);
    expect(ctx(r.body.context as CtxRow[], "seed").same).toBe(false);
  }, 60_000);
});

describe("P3: path counts differ on a shared seed", () => {
  it("is shown and flagged, not refused", async () => {
    const r = await cmp(runA, runD);
    expect(r.status).toBe(200);
    expect(ctx(r.body.context as CtxRow[], "nPaths")).toMatchObject({ a: 64, b: 32, same: false });
    expect(r.body.notes).toHaveLength(4);
    expect(r.body.notes[3]).toBe(NOTE_NPATHS);
    const eve = r.body.eveDistribution as Block;
    expect(eve.meanDeltaStandardError.basis).toBe("shared-seed-unaligned-paths");
    expect(eve.meanDeltaStandardError.text).toBe(TEXT_UNALIGNED);
    expect(eve.meanDeltaStandardError.text).not.toContain("share random numbers");
    // value = sqrt(61115.42003776055^2 + 68312.06297130857^2); D (32 paths) has EVE SE 68312.06297130857 (curve default 2)
    // On curve default 2 (was 91809.73001100312); deltas Step 1
    expect(rel(eve.meanDeltaStandardError.value as number, 91660.41955930559)).toBeLessThan(1e-9);
    // On curve default 2 (was 68420.67217314604); deltas Step 1
    expect(rel(row(eve, "standardError").b, 68312.06297130857)).toBeLessThan(1e-9);
    expect((r.body.nii12mDistribution as Block).meanDeltaStandardError.basis).toBe("shared-seed-unaligned-paths");
  }, 60_000);
});

describe("P4: horizon mismatch", () => {
  it("is refused 422, naming the field", async () => {
    const r = await cmp(runA, runE);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.message).toContain("differ in horizonMonths (360 and 120)");
    expect(r.body.error.detail.field).toBe("horizonMonths");
  }, 60_000);
});

describe("P5 and P6: pair-mode refusals", () => {
  it("a mixed pair is 400 in both orders", async () => {
    for (const [x, y] of [[runA, runF], [runF, runA]] as const) {
      const r = await cmp(x, y);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("bad-request");
      expect(r.body.error.message).toContain(`run "${runF}" is a deterministic run and run "${runA}" is a stochastic run`);
      expect(r.body.error.message).toContain("/api/compare");
    }
  });

  it("two deterministic runs are 400 and point at /api/compare", async () => {
    const r = await cmp(runF, runF);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("/api/compare?runs=");
    expect(r.body.error.message).toContain("/api/compare/stochastic compares two stochastic distribution envelopes only.");
  });
});

describe("P7: same run", () => {
  it("A against A is 200, every delta 0, no figure", async () => {
    const r = await cmp(runA, runA);
    expect(r.status).toBe(200);
    expect(r.body.sameRun).toBe(true);
    for (const blk of [r.body.eveDistribution as Block, r.body.nii12mDistribution as Block]) {
      for (const x of blk.rows) expect(x.delta).toBe(0);
      expect(blk.meanDeltaStandardError.value).toBeNull();
      expect(blk.meanDeltaStandardError.basis).toBe("same-run");
    }
  });
});

describe("P8: parameters and ids", () => {
  it("unknown id is 404, one id is 400, no parameter is 400", async () => {
    const ghost = await cmp(runA, "ghost");
    expect(ghost.status).toBe(404);
    expect(ghost.body.error.code).toBe("not-found");
    const one = await api<Json>(t.base, "GET", `/api/compare/stochastic?runs=${runA}`);
    expect(one.status).toBe(400);
    expect(one.body.error.message).toContain("runs must name exactly two run ids");
    const none = await api<Json>(t.base, "GET", "/api/compare/stochastic");
    expect(none.status).toBe(400);
    expect(none.body.error.message).toBe("compare/stochastic requires ?runs=a,b");
  });
});

describe("P9: a run that is not done", () => {
  it("is 409", async () => {
    const r = await cmp(runA, runG);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
    expect(r.body.error.message).toContain('stochastic compare requires state "done"');
    expect(r.body.error.message).toContain(`run "${runG}" is running`);
  });
});

describe("P10 and P11: wording and the deterministic routes", () => {
  it("the reply carries no significance language", async () => {
    const r = await cmp(runA, runB);
    for (const w of ["significan", "p-value", "t-stat"]) expect(r.text).not.toContain(w);
  });

  it("/api/compare and /api/compare.csv still refuse a stochastic pair and now point at the stochastic route", async () => {
    for (const path of [
      `/api/compare?runs=${runA},${runB}&table=eve`,
      `/api/compare.csv?runs=${runA},${runB}&table=eve`,
    ]) {
      const r = await api<Json>(t.base, "GET", path);
      expect(r.status, path).toBe(400);
      expect(r.body.error.message, path).toContain(`run "${runA}" is a stochastic run`);
      expect(r.body.error.message, path).toContain("/api/compare/stochastic?runs=a,b");
    }
  });
});
