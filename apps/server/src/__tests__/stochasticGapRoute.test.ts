/**
 * Slice 4b T3: `stochastic.gap` on the platform route, end to end against the real spawned child.
 *
 *   - every engine refusal surfaces as a typed 422 at submission, before request.json is written and before any
 *     run is queued, in the engine's own words: an unknown key, enabled other than true, BGM, a grid under 121
 *     months, and more than 100,000 position-paths;
 *   - a deterministic submission naming `stochastic.gap` is refused as every stochastic-only field is;
 *   - a gap-on submission records `gap` verbatim in request.json, the child computes it, and
 *     GET /api/runs/:id/stochastic/summary carries the stored block verbatim (additive);
 *   - a submission without the option writes no gap key, its summary reply carries no `gap`, and the summary CSV
 *     is the same bytes for a gap-on and a gap-off run of the same seed, but for the run id, the schema stamp and
 *     the generation time: the CSV never carries the gap (Studio builds the gap CSV in the browser).
 *
 * Expected strings are restated here, never imported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { StochasticRunResult } from "@alm/engine";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, waitFor, type TestPlatform } from "./harness";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let tp: TestPlatform;
let savedRunPerf: string | undefined;
let vanillaPositions = 0;

beforeAll(async () => {
  savedRunPerf = process.env.RUN_PERF;
  delete process.env.RUN_PERF;
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  const market = await loadTestMarket();
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);
  const vanilla = buildVanillaPortfolio();
  vanillaPositions = vanilla.positions.length;
  store.putDocument("portfolios", vanilla.id, vanilla, {
    label: vanilla.label,
    asOf: vanilla.asOf,
    positionCount: vanilla.positions.length,
  });
  // A book of 400 positions (the vanilla positions repeated under fresh ids): 400 x 256 = 102,400 position-paths.
  const big = {
    ...vanilla,
    id: "gap-big-book",
    positions: Array.from({ length: 400 }, (_, i) => {
      const p = vanilla.positions[i % vanilla.positions.length]!;
      return { ...p, id: `${p.id}-x${i}` };
    }),
  };
  store.putDocument("portfolios", big.id, big, { label: "gap big", asOf: big.asOf, positionCount: big.positions.length });
  store.putDocument("market", "market-test", market, { label: "test market" });
  store.putDocument("assumption-sets", set.id, { ...set }, { label: set.label });
  store.putDocument("scenario-slates", "grid", { id: "grid", label: "grid", scenarios }, { label: "grid", scenarioCount: scenarios.length });
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

const runDirs = (): string[] => {
  try {
    return readdirSync(join(tp.storeRoot, "runs")).sort();
  } catch {
    return [];
  }
};

const waitDone = async (runId: string): Promise<void> => {
  const done = await waitFor(
    async () => (await api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    240_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
};

describe("T3 refusals: typed 422 at submission, nothing written, nothing queued", () => {
  const expect422 = async (payload: Record<string, unknown>, ...fragments: string[]): Promise<void> => {
    const before = runDirs();
    const r = await api<{ error: { code: string; message: string } }>(tp.base, "POST", "/api/runs", payload);
    expect(r.status, JSON.stringify(payload)).toBe(422);
    expect(r.body.error.code).toBe("validation");
    for (const f of fragments) expect(r.body.error.message, JSON.stringify(payload)).toContain(f);
    expect(runDirs()).toEqual(before);
  };

  it("an unknown key on the option", async () => {
    await expect422(
      body({ mode: "stochastic", stochastic: { nPaths: 64, gap: { enabled: true, horizonMonths: 60 } } }),
      "stochastic.gap: unknown key \"horizonMonths\"",
      "admits { enabled: true } only",
    );
  });

  it("enabled other than true, and an option that is not an object", async () => {
    await expect422(body({ mode: "stochastic", stochastic: { gap: { enabled: false } } }), "stochastic.gap: enabled must be true, got false");
    await expect422(body({ mode: "stochastic", stochastic: { gap: {} } }), "stochastic.gap: enabled must be true");
    await expect422(body({ mode: "stochastic", stochastic: { gap: true } }), "stochastic.gap: the option must be an object { enabled: true }, got true");
    await expect422(body({ mode: "stochastic", stochastic: { gap: null } }), "stochastic.gap: the option must be an object");
  });

  it("BGM, before any BGM surface or lineage check, naming the BgmTenorError cause", async () => {
    await expect422(
      body({ mode: "stochastic", stochastic: { model: "bgm-lmm-2f", gap: { enabled: true } } }),
      "stochastic.gap: the gap distributions are Hull-White only; model \"bgm-lmm-2f\" is refused",
      "BgmTenorError",
      "BGM gap needs a general tenor rule",
    );
  });

  it("a grid under 121 months (typed StochasticGapHorizonError)", async () => {
    await expect422(
      body({ mode: "stochastic", gridHorizonMonths: 120, stochastic: { gap: { enabled: true } } }),
      "stochastic.gap: the run grid's horizonMonths 120 is too short",
      "at least 121 months",
    );
  });

  it("more than 100,000 position-paths: positions, paths, the product, the cap and the planned fix", async () => {
    await expect422(
      body({ mode: "stochastic", portfolioId: "gap-big-book", stochastic: { nPaths: 256, gap: { enabled: true } } }),
      "400 positions x 256 paths = 102,400 position-paths exceeds the cap of 100,000 position-paths",
      "parallel workers are the planned fix",
    );
  });

  it("the option comes after the path count, the seed and the model value", async () => {
    await expect422(body({ mode: "stochastic", stochastic: { nPaths: 15, gap: { enabled: false } } }), "even integer");
    await expect422(body({ mode: "stochastic", seed: "x", stochastic: { gap: { enabled: false } } }), "integer seed");
    await expect422(body({ mode: "stochastic", stochastic: { model: "banana", gap: { enabled: false } } }), "stochastic.model must be one of");
  });

  it("a deterministic submission naming stochastic.gap is refused as the other stochastic-only fields are", async () => {
    await expect422(body({ stochastic: { gap: { enabled: true } } }), "deterministic submission", "does not silently");
  });
});

describe("T3 round trip: request.json, the child, the summary route", () => {
  let gapRun: string;
  let plainRun: string;

  beforeAll(async () => {
    const on = await api<Json>(tp.base, "POST", "/api/runs", body({ mode: "stochastic", stochastic: { nPaths: 64, gap: { enabled: true } } }));
    expect(on.status, JSON.stringify(on.body)).toBe(202);
    gapRun = on.body.runId;
    const off = await api<Json>(tp.base, "POST", "/api/runs", body({ mode: "stochastic", stochastic: { nPaths: 64 } }));
    expect(off.status).toBe(202);
    plainRun = off.body.runId;
    await waitDone(gapRun);
    await waitDone(plainRun);
  }, 480_000);

  it("request.json records gap verbatim, and a run without it writes no gap key", () => {
    const store = tp.platform.context.store;
    expect(store.readRunJson<Json>(gapRun, "request.json").stochastic).toEqual({ nPaths: 64, gap: { enabled: true } });
    expect(store.readRunJson<Json>(plainRun, "request.json").stochastic).toEqual({ nPaths: 64 });
  });

  it("the stored envelope carries gap at 0.4.0; without the option, no gap at 0.3.0", async () => {
    const on = await api<StochasticRunResult>(tp.base, "GET", `/api/runs/${gapRun}/stochastic`);
    expect(on.body.schemaVersion).toBe("0.4.0");
    expect(on.body.gap?.horizonMonths).toBe(120);
    expect(on.body.gap?.repricing.bands.map((b) => b.label)).toEqual(["0-1M", "1-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-5Y", "5-10Y"]);
    expect(on.body.gap?.repricing.beyondHorizon.net.nPaths).toBe(64);
    const off = await api<StochasticRunResult>(tp.base, "GET", `/api/runs/${plainRun}/stochastic`);
    expect(off.body.schemaVersion).toBe("0.3.0");
    expect("gap" in off.body).toBe(false);
  });

  it("the summary carries the stored gap block verbatim; without the option the reply has no gap key", async () => {
    const on = await api<Json>(tp.base, "GET", `/api/runs/${gapRun}/stochastic/summary`);
    expect(on.status).toBe(200);
    const env = await api<StochasticRunResult>(tp.base, "GET", `/api/runs/${gapRun}/stochastic`);
    expect(on.body.gap).toEqual(env.body.gap);
    expect(JSON.stringify(on.body.gap)).toBe(JSON.stringify(env.body.gap));
    const off = await api<Json>(tp.base, "GET", `/api/runs/${plainRun}/stochastic/summary`);
    expect(off.status).toBe(200);
    expect(Object.keys(off.body)).toEqual([
      "kind",
      "runId",
      "context",
      "calibrationGate",
      "eveDistribution",
      "nii12mDistribution",
      "notImplemented",
      "notes",
      "calibration",
      "curve",
    ]);
    // The gap arm draws no number of the EVE and NII arm: the same seed gives the same distributions.
    expect(on.body.eveDistribution).toEqual(off.body.eveDistribution);
    expect(on.body.nii12mDistribution).toEqual(off.body.nii12mDistribution);
  });

  it("the summary CSV never carries the gap: gap-on and gap-off differ only in run id, schema stamp and time", async () => {
    const norm = (csv: string, runId: string): string =>
      csv
        .split(runId)
        .join("<run>")
        .replace(/^# generatedAt,[^\r\n]*/m, "# generatedAt,<t>")
        .replace(/0\.[34]\.0/g, "<v>");
    const on = await api(tp.base, "GET", `/api/runs/${gapRun}/stochastic/summary.csv`);
    const off = await api(tp.base, "GET", `/api/runs/${plainRun}/stochastic/summary.csv`);
    expect(on.status).toBe(200);
    expect(on.text).toContain("0.4.0");
    expect(off.text).not.toContain("0.4.0");
    expect(on.text.toLowerCase()).not.toContain("beyondhorizon");
    expect(norm(on.text, gapRun)).toBe(norm(off.text, plainRun));
  });

  it("the run detail echoes the stored option", async () => {
    const d = await api<Json>(tp.base, "GET", `/api/runs/${gapRun}`);
    expect(d.body.stochastic).toEqual({ nPaths: 64, gap: { enabled: true } });
  });

  it("the vanilla book sits well under the cap", () => {
    expect(vanillaPositions * 64).toBeLessThanOrEqual(100_000);
  });
});
