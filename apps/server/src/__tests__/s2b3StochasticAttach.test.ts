/**
 * A stochastic run attached to its workspace through the workspace launch. The setup's
 * stochastic choice launches with `mode: "stochastic"`; the run is pinned like any launch (its request carries the
 * workspace stamp and consumed pins), attached in runs.ndjson with `mode: "stochastic"` and the setup document it ran,
 * listed by the workspace's runs route, and "Newest result" still reads deterministic runs only. Its envelope equals,
 * run id aside, the envelope of the same choice posted the S2a way (POST /api/runs plus a guided-runs link), and that
 * S2a link stays readable. Every expected value is restated by hand.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import type { RunStatus } from "../jobs/types";

let t: TestPlatform;
let store: FileStore;
const WS = "ws-s2b3-attach";
const PUBLIC = "market-public-2026-03-31";
const CHOICE = { nPaths: 20, seed: "11", model: "hull-white-1f" as const };

const blocks = (rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${WS}/blocks`, { expectedRevision: rev, by: "tester", ...body });
const head = async () => (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${WS}`)).body;
const done = (runId: string) => waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
const envelope = (runId: string) => JSON.parse(readFileSync(join(t.storeRoot, "runs", runId, "result.json"), "utf8")) as Record<string, unknown>;

let slot: string;
let setupDocId: string;
let attached: string;

beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  let w = (await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id: WS, name: "Attach", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" })).body;
  for (const body of [
    { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } },
    { block: "market", op: "set", ref: { collection: "market", id: PUBLIC } },
    { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } },
    { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } },
  ]) {
    const r = await blocks(w.revision, body);
    expect(r.status, r.text).toBe(201);
    w = r.body;
  }
  slot = w.blocks.run.setups[0]!.setupLineageId;
  const { id: _drop, ...rest } = store.getDocument<RunSetup>("run-setups", w.blocks.run.setups[0]!.current.id).doc;
  void _drop;
  const r = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", { workspaceId: WS, setupLineageId: slot, expectedRevision: w.revision, by: "tester", setup: { ...rest, eve: { ...rest.eve, stochastic: CHOICE } } });
  expect(r.status, r.text).toBe(201);
  setupDocId = r.body.manifest.blocks.run.setups[0]!.current.id;
}, 120_000);

afterAll(() => t.close());

describe("a stochastic run attached through the workspace launch", () => {
  it("refuses a batch and a setup with no stochastic choice, in words", async () => {
    const batch = await api<{ error: { message: string } }>(t.base, "POST", `/api/workspaces/${WS}/setups/${slot}/launch`, { by: "tester", mode: "stochastic", batch: true });
    expect(batch.status).toBe(422);
    expect(batch.body.error.message).toBe("a stochastic launch runs the setup's one stochastic choice; launch it without \"batch\"");
    const bad = await api(t.base, "POST", `/api/workspaces/${WS}/setups/${slot}/launch`, { by: "tester", mode: "monte-carlo" });
    expect(bad.status).toBe(422);
  });

  it("launches, pins, attaches with mode stochastic, and lists the run", async () => {
    const l = await api<{ runIds: string[]; mode: string; notes: string[]; launchNo: number }>(t.base, "POST", `/api/workspaces/${WS}/setups/${slot}/launch`, { by: "tester", mode: "stochastic" });
    expect(l.status, l.text).toBe(200);
    expect(l.body.mode).toBe("stochastic");
    expect(l.body.notes[0]).toMatch(/base scenario only/);
    // The workspace's setup is Standard ALCO, which carries corrected-v1; the stochastic run
    // keeps the original convention and the launch says so.
    expect(l.body.notes).toContain("A stochastic run keeps the original convention for the certificates of deposit and the SEG block; the corrections apply to the deterministic run.");
    attached = l.body.runIds[0]!;
    expect((await done(attached)).body.state).toBe("done");

    const lines = readFileSync(join(t.storeRoot, "workspaces", WS, "runs.ndjson"), "utf8").trim().split("\n").map((x) => JSON.parse(x) as Record<string, unknown>);
    const line = lines.find((x) => x.runId === attached)!;
    expect(line).toMatchObject({ attachedBy: "launch", setupLineageId: slot, launchNo: l.body.launchNo, pins: "consumed", mode: "stochastic", setupDocId });

    const req = JSON.parse(readFileSync(join(t.storeRoot, "runs", attached, "request.json"), "utf8")) as { mode: string; stochastic: unknown; workspace: { workspaceId: string; consumed: Record<string, { id: string }> } };
    expect(req.mode).toBe("stochastic");
    expect(req.stochastic).toEqual({ nPaths: 20, model: "hull-white-1f" });
    expect(req.workspace.workspaceId).toBe(WS);
    expect(Object.keys(req.workspace.consumed).sort()).toEqual(["book", "market", `set:${SEED_IDS.vanillaAssumptions}`, "setup", "slate"].sort());

    const rows = await api<Array<{ runId: string; mode?: string; status: { state: string } | null }>>(t.base, "GET", `/api/workspaces/${WS}/runs`);
    expect(rows.body.map((r) => [r.runId, r.mode, r.status?.state])).toEqual([[attached, "stochastic", "done"]]);
    const env = envelope(attached);
    expect(env.kind).toBe("stochastic-distribution");
    expect(env.nPaths).toBe(20);
  });

  it("keeps readiness Newest result on deterministic runs", async () => {
    const rd = await api<{ items: Array<{ section: string; item: string; state: string; detail: string }> }>(t.base, "GET", `/api/workspaces/${WS}/readiness`);
    const item = rd.body.items.find((i) => i.detail.includes("stochastic run is listed"));
    expect(item?.state).toBe("not-set");
    expect(item?.detail).toBe("No deterministic run is attached to this workspace yet; 1 stochastic run is listed in the run history.");
  });

  it("gives the envelope the S2a direct post gives, and the S2a guided-runs link stays readable", async () => {
    const setId = SEED_IDS.vanillaAssumptions;
    await api(t.base, "POST", "/api/scenario-slates", { id: `gb-${setId}`.slice(0, 64), label: "Base", scenarios: [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: setId, newBusiness: { mode: "static", rules: [] } }] });
    const direct = await api<{ runId: string }>(t.base, "POST", "/api/runs", { portfolioId: SEED_IDS.vanillaPortfolio, marketId: PUBLIC, scenarioSlateId: `gb-${setId}`.slice(0, 64), assumptionSetIds: [setId], seed: "11", mode: "stochastic", stochastic: { nPaths: 20, model: "hull-white-1f" }, label: "Guided stochastic run" });
    expect(direct.status, direct.text).toBe(202);
    expect((await done(direct.body.runId)).body.state).toBe("done");
    const strip = (e: Record<string, unknown>) => ({ ...e, runId: "" });
    expect(JSON.stringify(strip(envelope(direct.body.runId)))).toBe(JSON.stringify(strip(envelope(attached))));

    const link = await api(t.base, "POST", `/api/workspaces/${WS}/guided-runs`, { runId: direct.body.runId, setupLineageId: slot, setupDocId, by: "tester" });
    expect(link.status, link.text).toBe(201);
    const links = await api<Array<{ runId: string }>>(t.base, "GET", `/api/workspaces/${WS}/guided-runs`);
    expect(links.body.map((r) => r.runId)).toEqual([direct.body.runId]);
    void (await head());
  });
});
