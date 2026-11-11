/**
 * Contract tests for the frozen Section 3.3 endpoint table: setup-plane routes
 * (portfolios, market, assumption sets, scenario slates), typed 400/404/409/422
 * errors, and the result-plane read endpoints exercised against a REAL engine
 * result written into the store (computed in-process on the vanilla book — real
 * engine output, never hand-authored numbers).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import type { AssumptionSet, RunResult } from "@alm/engine";
import {
  buildVanillaPortfolio,
  vanillaAssumptionSet,
  vanillaScenarios,
} from "@alm/data";
import { BETA_S_CURVE_DEFAULTS } from "@alm/kernel";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

let tp: TestPlatform;
const DONE_RUN = "run-contract-done";

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;

  // A completed run in the store, computed by the real engine in-process:
  // the result-plane endpoints serve it verbatim.
  const portfolio = buildVanillaPortfolio();
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);
  const market = await loadTestMarket();
  const startedAt = new Date().toISOString();
  const result = buildRunResult(
    {
      runId: DONE_RUN,
      portfolioId: portfolio.id,
      marketSnapshot: market,
      scenarios,
      assumptionSets: [set],
      grid: { horizonMonths: 360, asOf: portfolio.asOf },
      seed: "platform-0",
      timestamps: { startedAt, finishedAt: startedAt },
    },
    portfolio,
    { ...resolveDefaultContext(), durationMode: "base-only" },
  );
  const { writeFileAtomic } = await import("../store/store");
  const { join } = await import("node:path");
  const runDir = store.paths.runDir(DONE_RUN);
  writeFileAtomic(join(runDir, "result.json"), `${JSON.stringify(result)}\n`);
  const status: RunStatus = {
    runId: DONE_RUN,
    state: "done",
    phase: "done",
    submittedAt: startedAt,
    startedAt,
    endedAt: new Date().toISOString(),
    platformRequestHash: "test",
    summary: { portfolioId: portfolio.id, marketId: "m", scenarioSlateId: "s", scenarioCount: 5 },
  };
  store.writeRunJson(DONE_RUN, "status.json", status);
  store.appendRunLog(DONE_RUN, { t: "status", state: "done", at: startedAt });
}, 120_000);

afterAll(async () => {
  await tp.close();
});

describe("health", () => {
  it("reports engine version, kernel ref, schema version, store path, queue depth", async () => {
    const r = await api<Record<string, unknown>>(tp.base, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(typeof r.body.engineVersion).toBe("string");
    expect(typeof (r.body.kernel as { sourceCommit: string }).sourceCommit).toBe("string");
    expect(typeof r.body.schemaVersion).toBe("string");
    expect(r.body.storePath).toBe(tp.storeRoot);
    expect(typeof r.body.queueDepth).toBe("number");
  });
});

describe("portfolios", () => {
  it("imports the vanilla book as JSON and lists it with intake stats", async () => {
    const spec = buildVanillaPortfolio();
    const imp = await api<Record<string, unknown>>(tp.base, "POST", "/api/portfolios/import", spec);
    expect(imp.status).toBe(201);
    expect(imp.body.id).toBe(spec.id);
    expect(imp.body.positionCount).toBe(9);
    expect(typeof imp.body.contentHash).toBe("string");

    // Listing is a BARE ARRAY per the frozen client interface, each
    // item carrying the flattened meta plus labeled intake statistics.
    const list = await api<Array<Record<string, unknown>>>(tp.base, "GET", "/api/portfolios");
    expect(Array.isArray(list.body)).toBe(true);
    const item = list.body.find((p) => p.id === spec.id)!;
    expect(item).toBeDefined();
    expect(item.positionCount).toBe(9);
    expect(typeof item.asOf).toBe("string");
    expect(typeof item.contentHash).toBe("string");
    const stats = item.intakeStats as { basis: string; assets: number; liabilities: number; equity: number };
    expect(stats.basis).toContain("intake statistics");
    // Intake-plane identity: the derived plug balances by construction.
    expect(stats.equity).toBe(stats.assets - stats.liabilities);

    const got = await api<{ id: string; positions: unknown[] }>(tp.base, "GET", `/api/portfolios/${spec.id}`);
    expect(got.status).toBe(200);
    expect(got.body.positions).toHaveLength(9);
  });

  it("409s a duplicate import (append-only store) and 404s an unknown id", async () => {
    const spec = buildVanillaPortfolio();
    const dup = await api<{ error: { code: string } }>(tp.base, "POST", "/api/portfolios/import", spec);
    expect(dup.status).toBe(409);
    const missing = await api<{ error: { code: string } }>(tp.base, "GET", "/api/portfolios/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not-found");
  });

  it("422s a malformed book with every row error listed, not just the first", async () => {
    const spec = buildVanillaPortfolio() as unknown as { positions: Array<Record<string, unknown>>; id: string };
    spec.id = "vanilla-broken";
    spec.positions = spec.positions.map((p, i) =>
      i < 2 ? { ...p, familyId: `unknown-family-${i}` } : p,
    );
    const r = await api<{ error: { code: string; detail?: Array<{ message: string }> } }>(
      tp.base,
      "POST",
      "/api/portfolios/import",
      spec,
    );
    expect(r.status).toBe(422);
    // detail is the bare RowError array (the shape the client renders verbatim).
    expect(Array.isArray(r.body.error.detail)).toBe(true);
    expect((r.body.error.detail ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("assumption sets", () => {
  it("binds, stores, lists, and diffs sets through the engine", async () => {
    const base: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "set-base",
      label: "base",
      bindings: [
        {
          familyId: "mma",
          overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS },
          modelVersion: "kernel-deposit-beta-1",
        },
      ],
    };
    const created = await api<AssumptionSet>(tp.base, "POST", "/api/assumption-sets", base);
    expect(created.status).toBe(201);
    expect(typeof created.body.contentHash).toBe("string"); // engine-filled

    const bumped = {
      ...base,
      id: "set-bumped",
      bindings: [
        {
          ...base.bindings[0],
          overlay: {
            kind: "deposit-beta",
            params: { ...BETA_S_CURVE_DEFAULTS, betaMax: BETA_S_CURVE_DEFAULTS.betaMax + 0.05 },
          },
        },
      ],
    };
    const diff = await api<{ baseId: string; deltas: Array<{ path: string }> }>(
      tp.base,
      "POST",
      "/api/assumption-sets/diff",
      { baseId: "set-base", candidate: bumped },
    );
    expect(diff.status).toBe(200);
    expect(diff.body.baseId).toBe("set-base");
    expect(diff.body.deltas.some((d) => d.path.includes("betaMax"))).toBe(true);

    // Bare array; contentHash is the ENGINE's bindings hash (the gate keys on it).
    const listing = await api<Array<{ id: string; contentHash: string }>>(
      tp.base,
      "GET",
      "/api/assumption-sets",
    );
    expect(Array.isArray(listing.body)).toBe(true);
    const listed = listing.body.find((s) => s.id === "set-base")!;
    expect(listed).toBeDefined();
    expect(listed.contentHash).toBe(created.body.contentHash);
  });

  it("422s an invalid set with the engine's message verbatim", async () => {
    // NOTE: a NaN param cannot even cross the wire (JSON.stringify(NaN) is
    // null), so the refusal exercised here is an unrecognized overlay kind —
    // a genuine engine AssumptionValidationError surfaced verbatim.
    const bad = {
      schemaVersion: "1.0.0",
      id: "set-bad",
      label: "bad",
      bindings: [
        { familyId: "mma", overlay: { kind: "made-up-overlay" }, modelVersion: "v" },
      ],
    };
    const r = await api<{ error: { code: string; message: string } }>(
      tp.base,
      "POST",
      "/api/assumption-sets",
      bad,
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.message).toContain("made-up-overlay");
  });
});

describe("scenario slates", () => {
  it("creates a slate and enforces the one-base invariant and unique ids", async () => {
    const set = vanillaAssumptionSet();
    await api(tp.base, "POST", "/api/assumption-sets", set);
    const scenarios = vanillaScenarios(set.id);

    const ok = await api<{ id: string }>(tp.base, "POST", "/api/scenario-slates", {
      id: "slate-1",
      label: "Regulatory grid",
      scenarios,
    });
    expect(ok.status).toBe(201);

    // The listing returns FULL slate objects (frozen client interface: no
    // detail endpoint exists in the endpoint table; slates are small).
    const listing = await api<Array<{ id: string; scenarios: unknown[] }>>(
      tp.base,
      "GET",
      "/api/scenario-slates",
    );
    expect(Array.isArray(listing.body)).toBe(true);
    const listed = listing.body.find((s) => s.id === "slate-1")!;
    expect(listed).toBeDefined();
    expect(listed.scenarios).toHaveLength(scenarios.length);

    const noBase = await api<{ error: { message: string } }>(tp.base, "POST", "/api/scenario-slates", {
      id: "slate-nobase",
      label: "no base",
      scenarios: scenarios.filter((s) => s.rateSpec.kind !== "base"),
    });
    expect(noBase.status).toBe(422);
    expect(noBase.body.error.message).toContain("base");

    const dupIds = await api<{ error: { message: string } }>(tp.base, "POST", "/api/scenario-slates", {
      id: "slate-dup",
      label: "dup ids",
      scenarios: [...scenarios, scenarios[0]],
    });
    expect(dupIds.status).toBe(422);
    expect(dupIds.body.error.message).toContain("duplicate");
  });

  it("400s malformed slate bodies", async () => {
    const r = await api<{ error: { code: string } }>(tp.base, "POST", "/api/scenario-slates", {
      id: "slate-empty",
      label: "empty",
      scenarios: [],
    });
    expect(r.status).toBe(400);
  });
});

describe("result-plane reads (stored done run)", () => {
  it("lists runs as a bare array; a run without request.json lists without refs", async () => {
    const r = await api<Array<{ runId: string; state: string; refs?: unknown }>>(tp.base, "GET", "/api/runs");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const done = r.body.find((x) => x.runId === DONE_RUN)!;
    expect(done).toBeDefined();
    expect(done.state).toBe("done");
    // This fixture run was written straight into the store with no
    // request.json; the listing degrades to no refs, never invents them.
    expect(done.refs).toBeUndefined();
  });

  it("serves the verbatim result and its sections", async () => {
    const whole = await api<RunResult>(tp.base, "GET", `/api/runs/${DONE_RUN}/result`);
    expect(whole.status).toBe(200);
    expect(whole.body.schemaVersion).toBeDefined();

    const eve = await api<RunResult["eve"]>(tp.base, "GET", `/api/runs/${DONE_RUN}/result/eve`);
    expect(eve.status).toBe(200);
    // Verbatim: the section equals the envelope's top-level key exactly.
    expect(eve.body).toEqual(whole.body.eve);

    const badSection = await api<{ error: { code: string } }>(
      tp.base,
      "GET",
      `/api/runs/${DONE_RUN}/result/bogus`,
    );
    expect(badSection.status).toBe(400);
  });

  it("slices via the engine's own reader and 422s an unknown metric verbatim", async () => {
    const slice = await api<{ metric: string; data: unknown }>(
      tp.base,
      "GET",
      `/api/runs/${DONE_RUN}/query?metric=eve&scenarioId=S200`,
    );
    expect(slice.status).toBe(200);
    expect(slice.body.metric).toBe("eve");

    const bad = await api<{ error: { message: string } }>(
      tp.base,
      "GET",
      `/api/runs/${DONE_RUN}/query?metric=nonsense`,
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain("nonsense");
  });

  it("explains a shocked-scenario movement from stored attribution", async () => {
    const r = await api<{ explanation: { supported: boolean }; prose: string }>(
      tp.base,
      "POST",
      `/api/runs/${DONE_RUN}/explain`,
      { metric: "eve", scenarioId: "S200" },
    );
    expect(r.status).toBe(200);
    expect(r.body.explanation.supported).toBe(true);
    expect(r.body.prose.length).toBeGreaterThan(0);
  });

  it("labels a run without touching the result envelope", async () => {
    const before = await api<RunResult>(tp.base, "GET", `/api/runs/${DONE_RUN}/result`);
    const lab = await api<RunStatus>(tp.base, "POST", `/api/runs/${DONE_RUN}/label`, {
      label: "contract-fixture",
    });
    expect(lab.status).toBe(200);
    expect(lab.body.label).toBe("contract-fixture");
    const after = await api<RunResult>(tp.base, "GET", `/api/runs/${DONE_RUN}/result`);
    expect(after.text).toBe(before.text);
  });

  it("409s cancel on a terminal run and 404s unknown run ids everywhere", async () => {
    const cancel = await api<{ error: { code: string } }>(tp.base, "POST", `/api/runs/${DONE_RUN}/cancel`);
    expect(cancel.status).toBe(409);
    for (const path of ["/api/runs/ghost", "/api/runs/ghost/result", "/api/runs/ghost/export/nii.csv"]) {
      const r = await api<{ error: { code: string } }>(tp.base, "GET", path);
      expect(r.status, path).toBe(404);
    }
  });
});

describe("CSV export", () => {
  it("exports a table with traceability header rows and verbatim floats", async () => {
    const whole = await api<RunResult>(tp.base, "GET", `/api/runs/${DONE_RUN}/result`);
    const csv = await api(tp.base, "GET", `/api/runs/${DONE_RUN}/export/eve.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const lines = csv.text.split("\r\n");
    expect(lines[0]).toBe(`# runId,${DONE_RUN}`);
    expect(lines[1]).toBe(`# inputsHash,${whole.body.provenance.inputsHash}`);
    expect(lines[2]).toBe('# curve,"platform default v2, log-linear on discount factor"');
    expect(lines[3]).toContain("# schemaVersion,");
    expect(lines[4]).toContain("# engineVersion,");
    expect(lines[5]).toContain("# generatedAt,");
    // Spot value: base-scenario EVE appears at full float precision, no rounding.
    const baseEve = whole.body.eve.byScenario[0];
    const dataRow = lines.find((l) => l.startsWith(`${baseEve.scenarioId},,`))!;
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain(String(baseEve.eve));
    // 409 for a non-done run is covered in the lifecycle test; unknown table 400s.
    const badTable = await api<{ error: { code: string } }>(
      tp.base,
      "GET",
      `/api/runs/${DONE_RUN}/export/bogus.csv`,
    );
    expect(badTable.status).toBe(400);
  });

  it("compares two runs with derived B - A columns beside both originals", async () => {
    const r = await api(
      tp.base,
      "GET",
      `/api/compare.csv?runs=${DONE_RUN},${DONE_RUN}&table=nii`,
    );
    expect(r.status).toBe(200);
    const lines = r.text.split("\r\n");
    const header = lines.find((l) => l.startsWith("scenarioId"))!;
    expect(header).toContain("net12 [A]");
    expect(header).toContain("net12 [B]");
    expect(header).toContain("net12 [derived: B - A]");
    // Same run on both sides: every derived delta is exactly 0.
    const firstData = lines[lines.indexOf(header) + 1].split(",");
    const deltaIdx = header.split(",").indexOf("net12 [derived: B - A]");
    expect(firstData[deltaIdx]).toBe("0");
  });
});
