// apps/server/src/__tests__/curveDefaultSurfaces.test.ts
// The server surfaces of the curve default.
//  - Readiness: the Curves item says the base curve "builds" (not "bootstraps"), names the default
//    version, names the sub-month quotes the version 2 default leaves out, and names the reason of a
//    fallback to version 1. Under an active curve setup a curveDefault marker the engine refuses reads
//    Error in readiness, as the launch refuses it, so the two agree.
//  - GET /api/runs/:id carries `curve`, the one helper's line for the stored run, for both modes.
//  - The deterministic CSV header carries `# curve` beside inputsHash; the stochastic summary CSV and
//    the summary JSON carry it too.
// Every sentence and header line is restated by hand.
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import type { CurveSetupBlock, RunResult, StochasticRunResult } from "@alm/engine";
import { monthExactSnapshot, setupFromSnapshot } from "@alm/engine/src/curveBuilder/__tests__/helpers";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "@alm/data";
import type { MarketSnapshot } from "@alm/kernel";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore, writeFileAtomic } from "../store/store";
import type { RunStatus } from "../jobs/types";
import type { ReadinessReport } from "../workspaces/readiness";
import type { WorkspaceManifest } from "../workspaces/types";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

let t: TestPlatform;
let store: FileStore;
let base: MarketSnapshot;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  base = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
}, 120_000);
afterAll(() => t.close());

const V2 = "platform default v2, log-linear on discount factor";
const V1 = "platform default v1, linear in zero";

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const blocks = (id: string, rev: number, body: object) =>
  api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });

async function ready(id: string, marketId: string): Promise<WorkspaceManifest> {
  const created = await api(t.base, "POST", "/api/workspaces", { id, name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
  expect(created.status).toBe(201);
  await blocks(id, 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
  await blocks(id, 2, { block: "market", op: "set", ref: { collection: "market", id: marketId } });
  await blocks(id, 3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  const w = await blocks(id, 4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
  expect(w.status).toBe(201);
  return w.body;
}

const readiness = async (wsId: string) => (await api<ReadinessReport>(t.base, "GET", `/api/workspaces/${wsId}/readiness`)).body;
const curvesItem = (r: ReadinessReport) => r.items.find((i) => i.section === "market" && i.item === "Curves")!;

/** A copy of the seeded market's first quote at another term. */
const quoteAt = (term: string, tYears: number) => ({ ...base.curveQuotes[0]!, term, tYears });

describe("readiness names the default the base curve builds on", () => {
  it("an unmarked market builds on version 2", async () => {
    await ready("ws-cd-v2", SEED_IDS.market);
    const item = curvesItem(await readiness("ws-cd-v2"));
    expect(item.state).toBe("valid");
    expect(item.detail).toBe("The base curve builds from the snapshot: platform default v2, log-linear on discount factor.");
  });

  it("a market marked curveDefault: 1 builds on version 1", async () => {
    store.putDocument("market", "mk-cd-marked", { ...base, curveDefault: 1 }, { label: "marked v1" });
    await ready("ws-cd-marked", "mk-cd-marked");
    const item = curvesItem(await readiness("ws-cd-marked"));
    expect(item.state).toBe("valid");
    expect(item.detail).toBe("The base curve builds from the snapshot: platform default v1, linear in zero (the market is marked curveDefault: 1).");
  });

  it("names the sub-month quotes the version 2 default leaves out", async () => {
    store.putDocument("market", "mk-cd-dropped", { ...base, curveQuotes: [quoteAt("ON", 1 / 365), quoteAt("1D", 1 / 360), ...base.curveQuotes] }, { label: "sub-month quotes" });
    await ready("ws-cd-dropped", "mk-cd-dropped");
    const item = curvesItem(await readiness("ws-cd-dropped"));
    expect(item.state).toBe("valid");
    expect(item.detail).toBe(
      "The base curve builds from the snapshot: platform default v2, log-linear on discount factor. " +
        "The default leaves out the sub-month quotes ON, 1D: it takes whole months only, so the short end reads flat at the first month.",
    );
  });

  it("names the reason of a fallback to version 1", async () => {
    store.putDocument("market", "mk-cd-fallback", { ...base, curveQuotes: [quoteAt("3W", 0.0575), ...base.curveQuotes] }, { label: "a 3W quote" });
    await ready("ws-cd-fallback", "mk-cd-fallback");
    const item = curvesItem(await readiness("ws-cd-fallback"));
    expect(item.state).toBe("valid");
    expect(item.detail).toBe(
      "The base curve builds from the snapshot: platform default v1, linear in zero. " +
        "Platform default v2 cannot take this snapshot, so the build falls back to v1: " +
        "quote 3W at 0.0575 years is not within 0.0001 years of a whole month.",
    );
  });
});

describe("under an active curve setup, readiness and the launch agree on a bad marker", () => {
  const MARKER =
    "The curveDefault marker on this market: The market's curveDefault is 2; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.";

  it("reads Error in readiness and the launch is blocked by it", async () => {
    store.putDocument("market", "mk-cd-marker-two", { ...base, curveDefault: 2 }, { label: "marker 2" });
    await ready("ws-cd-marker-setup", "mk-cd-marker-two");
    const setup: CurveSetupBlock = { ...setupFromSnapshot(monthExactSnapshot(base).snapshot, "log-linear-df"), id: "seed-log-linear-df", label: "Seed log-linear-df" };
    const h = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-cd-marker-setup")).body;
    const saved = await api<{ id: string; revision: number }>(t.base, "POST", "/api/workspaces/ws-cd-marker-setup/curve-setups", { setup, expectedRevision: h.revision, by: "tester" });
    expect(saved.status).toBe(201);
    const act = await api(t.base, "POST", `/api/workspaces/ws-cd-marker-setup/curve-setups/${saved.body.id}/activate`, { expectedRevision: saved.body.revision, by: "tester" });
    expect(act.status).toBe(200);

    const item = curvesItem(await readiness("ws-cd-marker-setup"));
    expect(item.state).toBe("error");
    expect(item.detail).toBe(MARKER);

    const head = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-cd-marker-setup")).body;
    const slot = head.blocks.run.setups[0]!.setupLineageId;
    const launched = await api<{ error: { code: string; message: string }; blocking?: string[] }>(
      t.base, "POST", `/api/workspaces/ws-cd-marker-setup/setups/${slot}/launch`, { by: "tester", acknowledge: ["run/setup-warnings"] },
    );
    expect(launched.status).toBe(409);
    expect(launched.body.error.code).toBe("launch-blocked");
    expect(launched.body.blocking).toContain("market/Curves");
    expect(launched.body.error.message).toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------
// Stored runs: GET /api/runs/:id, the CSV headers, the stochastic summary
// ---------------------------------------------------------------------------

type Curve = { line: string; value: string; from: string };
type Detail = { curve?: Curve };

const SETUP_IN_REQUEST = { id: "seed-log-linear-df", label: "Seed log-linear-df", interpolation: "log-linear-df", inputs: [] };

/** Write a done run into the store: result.json as given, and a request.json carrying the market given. */
function storeRun(runId: string, result: unknown, requestMarket: unknown, mode: "deterministic" | "stochastic"): void {
  const at = "2026-10-16T00:00:00.000Z";
  store.writeRunJson(runId, "request.json", {
    mode,
    engineContext: {},
    request: { marketSnapshot: requestMarket, grid: { horizonMonths: 360, asOf: "2026-03-31" }, seed: "1" },
    portfolioRef: { id: "book-1", contentHash: "h" },
    submission: { portfolioId: "book-1", marketId: "mkt-1", scenarioSlateId: "s", assumptionSetIds: [], scenarios: [] },
  });
  writeFileAtomic(join(store.paths.runDir(runId), "result.json"), `${JSON.stringify(result)}\n`);
  const status: RunStatus = {
    runId,
    state: "done",
    phase: "done",
    submittedAt: at,
    startedAt: at,
    endedAt: at,
    platformRequestHash: "test",
    summary: { portfolioId: "book-1", marketId: "mkt-1", scenarioSlateId: "s", scenarioCount: 1 },
  };
  store.writeRunJson(runId, "status.json", status);
}

describe("a deterministic stored run", () => {
  let result: RunResult;
  beforeAll(async () => {
    const portfolio = buildVanillaPortfolio();
    const set = vanillaAssumptionSet();
    const market = await loadTestMarket();
    const at = "2026-10-16T00:00:00.000Z";
    result = buildRunResult(
      {
        runId: "run-cd-v2",
        portfolioId: portfolio.id,
        marketSnapshot: market,
        scenarios: vanillaScenarios(set.id),
        assumptionSets: [set],
        grid: { horizonMonths: 360, asOf: portfolio.asOf },
        seed: "platform-0",
        timestamps: { startedAt: at, finishedAt: at },
      },
      portfolio,
      { ...resolveDefaultContext(), durationMode: "base-only" },
    );
    const unstamped = { ...result, provenance: { ...result.provenance } } as RunResult;
    delete (unstamped.provenance as { curveDefault?: unknown }).curveDefault;
    storeRun("run-cd-v2", result, market, "deterministic");
    storeRun("run-cd-old-setup", unstamped, { ...market, curveSetup: SETUP_IN_REQUEST }, "deterministic");
    storeRun("run-cd-old", unstamped, market, "deterministic");
    storeRun("run-cd-odd", { ...result, provenance: { ...result.provenance, curveDefault: { kind: "mystery" } } }, market, "deterministic");
  }, 120_000);

  it("the stamp the run carries is version 2 on the public market", () => {
    expect(result.provenance.curveDefault).toEqual({ kind: "default", version: 2 });
  });

  it("GET /api/runs/:id carries the curve line, read from the stamp, the request's setup, or neither", async () => {
    const cases: Array<[string, Curve]> = [
      ["run-cd-v2", { line: `Curve: ${V2}`, value: V2, from: "stamp" }],
      ["run-cd-old-setup", { line: "Curve: setup Seed log-linear-df (seed-log-linear-df)", value: "setup Seed log-linear-df (seed-log-linear-df)", from: "request-setup" }],
      ["run-cd-old", { line: `Curve: ${V1}`, value: V1, from: "unstamped" }],
      ["run-cd-odd", { line: "Curve: unknown", value: "unknown", from: "stamp" }],
    ];
    for (const [id, curve] of cases) {
      const r = await api<Detail>(t.base, "GET", `/api/runs/${id}`);
      expect(r.status, id).toBe(200);
      expect(r.body.curve, id).toEqual(curve);
    }
  });

  it("the CSV header carries the curve line beside inputsHash", async () => {
    const r = await api(t.base, "GET", "/api/runs/run-cd-v2/export/eve.csv");
    expect(r.status).toBe(200);
    const lines = r.text.split("\r\n");
    expect(lines.slice(0, 5)).toEqual([
      "# runId,run-cd-v2",
      `# inputsHash,${result.provenance.inputsHash}`,
      '# curve,"platform default v2, log-linear on discount factor"',
      `# schemaVersion,${result.schemaVersion}`,
      `# engineVersion,${result.provenance.engineVersion}`,
    ]);
    const old = (await api(t.base, "GET", "/api/runs/run-cd-old-setup/export/nii.csv")).text.split("\r\n");
    expect(old[2]).toBe("# curve,setup Seed log-linear-df (seed-log-linear-df)");
  });

  it("the compare CSV and JSON carry each side's curve line", async () => {
    const csv = (await api(t.base, "GET", "/api/compare.csv?runs=run-cd-v2,run-cd-old&table=eve")).text.split("\r\n");
    expect(csv[2]).toBe('# curve [A],"platform default v2, log-linear on discount factor"');
    expect(csv[7]).toBe('# curve [B],"platform default v1, linear in zero"');
    const json = await api<{ provenance: { a: { curve: string }; b: { curve: string } } }>(t.base, "GET", "/api/compare?runs=run-cd-v2,run-cd-old&table=eve");
    expect(json.body.provenance.a.curve).toBe(V2);
    expect(json.body.provenance.b.curve).toBe(V1);
  });
});

// Task 8 fix round 1: the detail route never depends on result.json being readable, the kept line follows a
// rewritten result.json, and a run that is not done carries no curve.
describe("the curve line on the run detail, edge cases", () => {
  const stamped = (curveDefault: unknown) => ({ kind: "stochastic-distribution", runId: "x", curveDefault });
  const resultPath = (runId: string) => join(store.paths.runDir(runId), "result.json");

  it("a done run whose result.json is not JSON answers 200 with the unknown line", async () => {
    storeRun("run-cd-corrupt", stamped({ kind: "default", version: 2 }), base, "stochastic");
    writeFileSync(resultPath("run-cd-corrupt"), '{"kind": "stochastic-distrib');
    const r = await api<Detail>(t.base, "GET", "/api/runs/run-cd-corrupt");
    expect(r.status).toBe(200);
    expect(r.body.curve).toEqual({ line: "Curve: unknown", value: "unknown", from: "stamp" });
  });

  it("the kept line follows a result.json rewritten at the same size and at another size", async () => {
    storeRun("run-cd-rewrite", stamped({ kind: "default", version: 2 }), base, "stochastic");
    expect((await api<Detail>(t.base, "GET", "/api/runs/run-cd-rewrite")).body.curve!.line).toBe(`Curve: ${V2}`);
    // Same byte length ("version":2 and "version":1), a different modified time.
    const before = statSync(resultPath("run-cd-rewrite"));
    writeFileSync(resultPath("run-cd-rewrite"), `${JSON.stringify(stamped({ kind: "default", version: 1 }))}\n`);
    utimesSync(resultPath("run-cd-rewrite"), before.atime, new Date(before.mtimeMs + 5_000));
    expect(statSync(resultPath("run-cd-rewrite")).size).toBe(before.size);
    expect((await api<Detail>(t.base, "GET", "/api/runs/run-cd-rewrite")).body.curve!.line).toBe(`Curve: ${V1}`);
    // Another size, at the same modified time as the line kept now.
    const kept = statSync(resultPath("run-cd-rewrite"));
    writeFileSync(resultPath("run-cd-rewrite"), `${JSON.stringify(stamped({ kind: "setup", id: "seed-log-linear-df" }))}\n`);
    utimesSync(resultPath("run-cd-rewrite"), kept.atime, kept.mtime);
    expect(statSync(resultPath("run-cd-rewrite")).mtimeMs).toBe(kept.mtimeMs);
    expect((await api<Detail>(t.base, "GET", "/api/runs/run-cd-rewrite")).body.curve!.line).toBe("Curve: setup seed-log-linear-df");
  });

  it("a run that is not done carries no curve", async () => {
    storeRun("run-cd-queued", stamped({ kind: "default", version: 2 }), base, "stochastic");
    const status = store.readRunJson<RunStatus>("run-cd-queued", "status.json");
    store.writeRunJson("run-cd-queued", "status.json", { ...status, state: "queued", phase: undefined, startedAt: undefined, endedAt: undefined });
    const r = await api<Detail & Record<string, unknown>>(t.base, "GET", "/api/runs/run-cd-queued");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("queued");
    expect("curve" in r.body).toBe(false);
  });
});

describe("a stochastic stored run", () => {
  const P = [0.05, 0.25, 0.5, 0.75, 0.95];
  const dist = (mean: number) => ({
    nPaths: 20, mean, standardError: 1, stdev: 2, min: mean - 5, max: mean + 5,
    quantiles: P.map((p, i) => ({ p, value: mean - 2 + i })),
  });
  const envelope = (over: Record<string, unknown>): StochasticRunResult =>
    ({
      schemaVersion: "0.2.0",
      kind: "stochastic-distribution",
      model: "hull-white-1f",
      runId: "run-cd-sto",
      scenarioId: "base",
      assumptionSetId: "as-1",
      seed: "1",
      nPaths: 20,
      horizonMonths: 360,
      discountBasis: "all-in",
      calibration: { source: "cap-atm-calibration", a: 0.01, sigma: 0.006, rmseBp: 2, rmseGateBp: 5, rmseGateBreached: false, nQuotes: 12, underlyingTau: 0.25, iterations: 9 },
      martingale: { correctedMaxAbsErrBp: 0.001, rawTerminalErrBp: 2.5, terminalDfStandardError: 0.0004, terminalYears: 30 },
      eveDistribution: dist(100),
      nii12mDistribution: dist(10),
      notImplemented: [],
      ...over,
    }) as unknown as StochasticRunResult;

  beforeAll(() => {
    storeRun("run-cd-sto", envelope({ curveDefault: { kind: "default", version: 2 } }), base, "stochastic");
    storeRun("run-cd-sto-old", envelope({ runId: "run-cd-sto-old", schemaVersion: "0.1.0" }), base, "stochastic");
  });

  it("GET /api/runs/:id carries the curve line from the envelope's stamp, or reads version 1 without one", async () => {
    expect((await api<Detail>(t.base, "GET", "/api/runs/run-cd-sto")).body.curve).toEqual({ line: `Curve: ${V2}`, value: V2, from: "stamp" });
    expect((await api<Detail>(t.base, "GET", "/api/runs/run-cd-sto-old")).body.curve).toEqual({ line: `Curve: ${V1}`, value: V1, from: "unstamped" });
  });

  it("the summary JSON and the summary CSV carry the curve line", async () => {
    const json = await api<{ curve: Curve }>(t.base, "GET", "/api/runs/run-cd-sto/stochastic/summary");
    expect(json.status).toBe(200);
    expect(json.body.curve).toEqual({ line: `Curve: ${V2}`, value: V2, from: "stamp" });
    const csv = await api(t.base, "GET", "/api/runs/run-cd-sto/stochastic/summary.csv");
    expect(csv.status).toBe(200);
    expect(csv.text.split("\r\n").slice(0, 6)).toEqual([
      "# kind,stochastic-distribution",
      "# runId,run-cd-sto",
      "# schemaVersion,0.2.0",
      "# inputsHash,not recorded: the stochastic envelope carries no inputsHash",
      '# curve,"platform default v2, log-linear on discount factor"',
      "# engineVersion,not recorded: the stochastic envelope carries no engineVersion",
    ]);
  });

  it("the stochastic compare CSV carries each side's curve line", async () => {
    const csv = await api(t.base, "GET", "/api/compare/stochastic.csv?runs=run-cd-sto,run-cd-sto-old");
    expect(csv.status).toBe(200);
    const lines = csv.text.split("\r\n");
    expect(lines[4]).toBe('# curve [A],"platform default v2, log-linear on discount factor"');
    expect(lines[10]).toBe('# curve [B],"platform default v1, linear in zero"');
  });
});
