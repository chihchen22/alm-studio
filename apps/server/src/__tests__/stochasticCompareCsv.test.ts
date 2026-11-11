/**
 * GET /api/compare/stochastic.csv: the CSV twin of the stochastic
 * Compare reply, written under the stochastic provenance header with the
 * derived B - A columns labelled beside both originals. It refuses
 * exactly as GET /api/compare/stochastic does, except that its parameter
 * message names its own route. Also proves the per-table export refusal for a
 * stochastic run now points at the stochastic CSVs.
 *
 * Seeded proof on the public market pack and its volatility-shocked derivation
 * (vol-shock-demo-v1), vanilla book, 64 paths, default seed 20260331 (the
 * ADR-031 setup). Every literal below was measured on the unmodified code in a probe and is never re-pinned. Expected strings are restated
 * here, never imported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import type { RunStatus } from "../jobs/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const BASE_ID = "market-public-2026-03-31";
const SHOCK_ID = "vol-shock-demo-v1";
const NOTDONE = "run-stocsv-notdone";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestPlatform;
let base: string; // stochastic, base market, 64 paths
let shock: string; // stochastic, shocked market, 64 paths
let det: string; // deterministic, base market

const book = {
  portfolioId: "vanilla-book-v1",
  scenarioSlateId: "regulatory-grid-vanilla",
  assumptionSetIds: ["vanilla-empty-v1"],
};
const submit = async (body: Record<string, unknown>): Promise<string> => {
  const r = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...book, ...body });
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
const csv = (query: string) => api<Json>(t.base, "GET", `/api/compare/stochastic.csv${query}`);

beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  const sto = { mode: "stochastic", stochastic: { nPaths: 64 } };
  base = await submit({ marketId: BASE_ID, ...sto });
  shock = await submit({ marketId: SHOCK_ID, ...sto });
  det = await submit({ marketId: BASE_ID });
  for (const id of [base, shock, det]) await waitDone(id);

  // A stochastic request that never finished (status running).
  const store = t.platform.context.store;
  store.writeRunJson(NOTDONE, "request.json", store.readRunJson<unknown>(base, "request.json"));
  store.writeRunJson(NOTDONE, "status.json", {
    runId: NOTDONE,
    state: "running",
    submittedAt: "2026-10-08T00:00:00.000Z",
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

describe("C1: the compare CSV twin of the seeded pair", () => {
  it("answers 200 with both provenance headers, the SE basis and the aligned rows", async () => {
    const r = await csv(`?runs=${base},${shock}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="compare-stochastic-${base}-${shock}.csv"`,
    );
    const lines = r.text.split("\r\n");
    // Two "# curve" provenance rows, one per run (was 65 lines, lines[64]); deltas, header rows.
    expect(lines).toHaveLength(67);
    expect(lines[66]).toBe("");
    for (const line of [
      `# runId [A],${base}`,
      `# runId [B],${shock}`,
      "# inputsHash [B],not recorded: the stochastic envelope carries no inputsHash",
      // The curve line of each run, restated: no curveSetup and no marker on either seeded market.
      '# curve [A],"platform default v2, log-linear on discount factor"',
      '# curve [B],"platform default v2, log-linear on discount factor"',
      "# eveDistribution.meanDeltaStandardError.basis,shared-seed-bound",
      "context,marketId,,market-public-2026-03-31,vol-shock-demo-v1,,false",
      "context,seed,,20260331,20260331,,true",
      // On curve default 2 (was 0.0061184513287782325 and 0.009177675604594539); deltas Step 1
      "context,calibration.sigma,,0.006116484379837266,0.009174725148401753,,false",
      // On curve default 2 (was 121065587.85061447 and 121065587.85061435; the B - A roundoff is unchanged); deltas Step 1
      "eveDistribution,mean,,120866072.26933384,120866072.26933372,-1.1920928955078125e-7,",
      // On curve default 2 (was 6855510.898898505, 10289688.848804412 and 3434177.9499059077); deltas Step 1
      "eveDistribution,stdev,,6843610.473478725,10271827.171520496,3428216.6980417706,",
      // On curve default 2 (was 132050902.35729401, 137850772.09881794 and 5799869.741523936); deltas Step 1
      "eveDistribution,quantile,0.95,131831793.78860644,137621339.7981929,5789546.009586453,",
      // On curve default 2 (was 150508.09101324185); deltas Step 1
      "eveDistribution,meanDeltaStandardError,,,,150256.0290074165,",
      "nii12mDistribution,mean,,11772965.6583846,11772965.6583846,0,",
      "nii12mDistribution,meanDeltaStandardError,,,,1.4193370230517217e-9,",
    ]) {
      expect(lines, line).toContain(line);
    }
  }, 60_000);
});

describe("C2: the CSV twin refuses as the JSON route does", () => {
  const refuse = async (query: string, status: number, code: string) => {
    const r = await csv(query);
    expect(r.status, query).toBe(status);
    expect(r.body.error.code, query).toBe(code);
    return r.body.error.message as string;
  };

  it("names its own route when ?runs is missing; the JSON route keeps its message", async () => {
    expect(await refuse("", 400, "bad-request")).toBe("compare/stochastic.csv requires ?runs=a,b");
    const j = await api<Json>(t.base, "GET", "/api/compare/stochastic");
    expect(j.status).toBe(400);
    expect(j.body.error.message).toBe("compare/stochastic requires ?runs=a,b");
  });

  it("refuses one id, an unknown run, deterministic runs, a mixed pair and a run not done", async () => {
    expect(await refuse("?runs=a", 400, "bad-request")).toBe('runs must name exactly two run ids, got "a"');
    expect(await refuse(`?runs=ghost,${base}`, 404, "not-found")).toBe('run "ghost" not found');
    const both = await refuse(`?runs=${det},${det}`, 400, "bad-request");
    expect(both.startsWith(`runs "${det}" and "${det}" are deterministic runs`), both).toBe(true);
    const mixed = await refuse(`?runs=${base},${det}`, 400, "bad-request");
    expect(
      mixed.startsWith(`run "${det}" is a deterministic run and run "${base}" is a stochastic run`),
      mixed,
    ).toBe(true);
    expect(await refuse(`?runs=${base},${NOTDONE}`, 409, "conflict")).toBe(
      `run "${NOTDONE}" is running; stochastic compare requires state "done"`,
    );
  });
});

describe("C3: the per-table export refusal points at the stochastic CSVs", () => {
  it("a stochastic run's table export names the envelope and its summary CSV", async () => {
    const r = await api<Json>(t.base, "GET", `/api/runs/${base}/export/eve.csv`);
    expect(r.status).toBe(400);
    const m = r.body.error.message as string;
    expect(m).toContain("no CSV table shape");
    expect(m).toContain(`/api/runs/${base}/stochastic`);
    expect(m).toContain(`/api/runs/${base}/stochastic/summary.csv`);
    expect(m).not.toContain("/api/compare/stochastic");
  });

  it("compare.csv with a stochastic side names the stochastic compare CSV twin", async () => {
    const r = await api<Json>(t.base, "GET", `/api/compare.csv?runs=${det},${base}&table=eve`);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("/api/compare/stochastic.csv?runs=a,b");
  });

  it("no body or message carries an em-dash or a section sign", async () => {
    for (const r of [
      await csv(`?runs=${base},${shock}`),
      await csv(""),
      await csv(`?runs=${base},${det}`),
      await csv(`?runs=${base},${NOTDONE}`),
      await api<Json>(t.base, "GET", `/api/runs/${base}/export/eve.csv`),
      await api<Json>(t.base, "GET", `/api/compare.csv?runs=${det},${base}&table=eve`),
    ]) {
      expect(r.text).not.toContain("\u2014");
      expect(r.text).not.toContain("\u00a7");
    }
  });
});
