/**
 * Setup validate and launch (Studio A+E spec v3.1 Sections 2.3, 3.5 and 5.2; contracts
 * 1, 2 and 15; plan Task C3): the setups.ndjson lines, the launch counter, the batch
 * order, the pin check inside submitRun on the bytes the run computes on, the
 * request.json and status.json workspace stamps, and the boot completion of a launch
 * that crashed before its launch-complete line.
 *
 * Expected values are restated by hand: the Flat basis literal, the consumed role
 * names, the readiness item ids "run/setups" (the setup itself: Error, Stale) and
 * "run/setup-warnings" (its warnings, review C m2), the 409, 422 and 207 statuses.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { seasoningOffsetOf } from "@alm/engine/src/portfolio/seasoning";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore, sha256Hex } from "../store/store";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { SetupEvent, WorkspaceManifest } from "../workspaces/types";
import type { StoredRunRequest, RunStatus } from "../jobs/types";
import type { ReadinessReport } from "../workspaces/readiness";

// The launch route's pin-move seam is honoured only under this flag (read per request).
process.env.ALM_TEST_SEAMS = "1";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
}, 120_000);
afterAll(() => t.close());

const blocks = (id: string, rev: number, body: object) =>
  api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });

async function ready(id: string, type = "test") {
  const created = await api(t.base, "POST", "/api/workspaces", { id, name: "A", type, cutoffDate: "2026-03-31", owner: "o", by: "tester" });
  expect(created.status).toBe(201);
  await blocks(id, 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
  await blocks(id, 2, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
  await blocks(id, 3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  const w = await blocks(id, 4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
  expect(w.status).toBe(201);
  return w.body;
}

/**
 * Slice three (decision 112): the Standard ALCO setup no longer warns (its monthly buckets and its report horizons are
 * honoured), so a test about the warnings item saves the slot onto a setting that still warns. Slice 4a honours liquidity
 * flows of principal plus interest, so that setting was the fixed-rate ladder; slice B2 honours the fixed-rate
 * ladder, so it is now EVE valuation at later dates, reserved for piece D, which writes no engine option.
 */
async function readyWarned(id: string, type = "test"): Promise<WorkspaceManifest> {
  const w = await ready(id, type);
  const slot = w.blocks.run.setups[0]!.setupLineageId;
  const setup = (await api<{ setups: Array<{ setup: { id: string; gap: { liquidity: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown> }> }>(
    t.base, "GET", `/api/run-setups?workspaceId=${id}`)).body.setups[0]!.setup;
  const saved = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", {
    workspaceId: id, setupLineageId: slot, expectedRevision: w.revision, by: "tester",
    setup: { ...setup, id: undefined, supersedes: setup.id, eve: { ...(setup.eve as Record<string, unknown>), valuationDates: "every-12-months" } },
  });
  expect(saved.status).toBe(201);
  return saved.body.manifest;
}

/** The readiness item ids, restated: the setup's own item, and its warnings under their own id (review C m2). */
const SETUPS = "run/setups";
const WARNINGS = "run/setup-warnings";

/** The decided refusal of a stochastic EVE path (review C M1), restated word for word. */
const STOCHASTIC_REFUSAL =
  "Stochastic runs launch from the Analysis path in this release: choose one on the Simulation step and launch it on the Run step. This setup asks for the stochastic EVE path. Choose single path to launch it on the deterministic path.";

/** The Flat basis on the plan, restated from spec Section 5.2 step 4. */
const FLAT = { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 };

describe("validate and launch", () => {
  it("validate appends a line, moves no hash, and reports the Flat label", async () => {
    const w = await ready("ws-ev");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const v = await api<{ outcome: string; basisLabel: string; compiledChain: Array<{ id: string }>; consumed: Record<string, unknown> }>(
      t.base, "POST", `/api/workspaces/ws-ev/setups/${slot}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    // Slice three (decision 112): nothing in the Standard ALCO setup warns any more.
    expect(v.body.outcome).toBe("pass");
    expect(v.body.basisLabel).toBe("Flat (simple top-up)");
    // Section 5.5: on a Flat setup the chain shows the balance stage.
    expect(v.body.compiledChain.map((s) => s.id)).toContain("st-balance");
    expect(Object.keys(v.body.consumed).sort()).toEqual(["book", "market", "routingPolicy", `set:${SEED_IDS.vanillaAssumptions}`, "setup"].sort());
    const after = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-ev")).body;
    expect(after.revision).toBe(w.revision);
    expect(after.signedHash).toBe(w.signedHash);
    const lines = new WorkspaceStore(t.storeRoot).readSetupEvents("ws-ev");
    expect(lines.map((l) => l.t)).toEqual(["validate"]);
    expect(lines[0]).toEqual(expect.objectContaining({ setupLineageId: slot, by: "tester", outcome: "pass", basisLabel: "Flat (simple top-up)" }));
  });

  it("validate without by is a 422 naming the field; an unknown slot is a 404", async () => {
    const w = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-ev")).body;
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const noBy = await api(t.base, "POST", `/api/workspaces/ws-ev/setups/${slot}/validate`, {});
    expect(noBy.status).toBe(422);
    expect(noBy.text).toMatch(/by/);
    const unknown = await api(t.base, "POST", "/api/workspaces/ws-ev/setups/setup-nope/validate", { by: "tester" });
    expect(unknown.status).toBe(404);
  });

  it("GET validations serves the slot's stored validate lines newest first, marks them stale after an edit, filters by lineage and writes nothing", async () => {
    const w = await ready("ws-hist");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const url = `/api/workspaces/ws-hist/setups/${slot}/validations`;
    type Row = { at: string; by: string; setupDocId: string; outcome: string; basisLabel: string; skippedFamilies: string[]; current: boolean };
    const empty = await api<{ validations: Row[] }>(t.base, "GET", url);
    expect(empty.status).toBe(200);
    expect(empty.body.validations).toEqual([]);

    const first = await api(t.base, "POST", `/api/workspaces/ws-hist/setups/${slot}/validate`, { by: "first" });
    expect(first.status).toBe(200);
    const second = await api(t.base, "POST", `/api/workspaces/ws-hist/setups/${slot}/validate`, { by: "second" });
    expect(second.status).toBe(200);
    const docId = w.blocks.run.setups[0]!.current.id;

    const fresh = await api<{ validations: Row[] }>(t.base, "GET", url);
    expect(fresh.status).toBe(200);
    expect(fresh.body.validations.map((v) => v.by)).toEqual(["second", "first"]);
    expect(fresh.body.validations[0]).toEqual({
      at: expect.any(String), by: "second", setupDocId: docId, outcome: "pass", basisLabel: "Flat (simple top-up)", skippedFamilies: expect.any(Array), current: true,
    });
    // The large per-run fields stay in the validate reply: the history carries none of them.
    expect(Object.keys(fresh.body.validations[0]!).sort()).toEqual(["at", "basisLabel", "by", "current", "outcome", "setupDocId", "skippedFamilies"]);

    // A second slot validated once: its line is not in the first slot's history.
    const setup = (await api<{ setups: Array<{ setup: { id: string; name: string } & Record<string, unknown> }> }>(t.base, "GET", "/api/run-setups?workspaceId=ws-hist")).body.setups[0]!.setup;
    const other = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", {
      workspaceId: "ws-hist", setupLineageId: "second-lineage", expectedRevision: w.revision, by: "tester",
      setup: { ...setup, id: undefined, supersedes: null, name: "Second lineage" },
    });
    expect(other.status).toBe(201);
    expect((await api(t.base, "POST", "/api/workspaces/ws-hist/setups/second-lineage/validate", { by: "other" })).status).toBe(200);

    // Edit the first slot: a new document, so both stored validations are of the old one.
    const edited = await api<{ setup: { id: string } }>(t.base, "POST", "/api/run-setups", {
      workspaceId: "ws-hist", setupLineageId: slot, expectedRevision: other.body.manifest.revision, by: "tester",
      setup: { ...setup, id: undefined, supersedes: setup.id, name: "Edited" },
    });
    expect(edited.status).toBe(201);
    expect(edited.body.setup.id).not.toBe(docId);

    const eventsBefore = new WorkspaceStore(t.storeRoot).readSetupEvents("ws-hist").length;
    const stale = await api<{ validations: Row[] }>(t.base, "GET", url);
    expect(stale.status).toBe(200);
    expect(stale.body.validations.map((v) => [v.by, v.current])).toEqual([["second", false], ["first", false]]);
    expect(stale.body.validations.every((v) => v.setupDocId === docId)).toBe(true);
    const otherHist = await api<{ validations: Row[] }>(t.base, "GET", "/api/workspaces/ws-hist/setups/second-lineage/validations");
    expect(otherHist.body.validations.map((v) => v.by)).toEqual(["other"]);
    expect(otherHist.body.validations[0]!.current).toBe(true);
    expect(new WorkspaceStore(t.storeRoot).readSetupEvents("ws-hist").length).toBe(eventsBefore);

    const unknown = await api(t.base, "GET", "/api/workspaces/ws-hist/setups/setup-nope/validations");
    expect(unknown.status).toBe(404);
    const noWs = await api(t.base, "GET", "/api/workspaces/ws-nope/setups/x/validations");
    expect(noWs.status).toBe(404);
  });

  it("GET validations returns at most the newest twenty", async () => {
    const w = await ready("ws-hist20");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const ws = new WorkspaceStore(t.storeRoot);
    const docId = w.blocks.run.setups[0]!.current.id;
    for (let i = 0; i < 25; i++) {
      ws.appendSetupEvent("ws-hist20", {
        t: "validate", setupLineageId: slot, setupDocId: docId, at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, by: `b${i}`,
        consumed: {}, outcome: "pass", basisLabel: "x", basisByScenario: {}, skippedFamilies: [], reports: {},
      } as SetupEvent);
    }
    const r = await api<{ validations: Array<{ by: string }> }>(t.base, "GET", `/api/workspaces/ws-hist20/setups/${slot}/validations`);
    expect(r.body.validations).toHaveLength(20);
    expect(r.body.validations[0]!.by).toBe("b24");
    expect(r.body.validations[19]!.by).toBe("b5");
  });

  it("GET validations derives a failed validation's reason from its stored reports: the refusal and each gate sentence; an older line gives its message; a pass has none; the read writes nothing (Studio Part 2 D11)", async () => {
    // The synthetic book under the demo behavioral set, so the compiled chain holds behavioral stages.
    expect((await api(t.base, "POST", "/api/workspaces", { id: "ws-reason", name: "R", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" })).status).toBe(201);
    await blocks("ws-reason", 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.syntheticPortfolio } });
    await blocks("ws-reason", 2, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await blocks("ws-reason", 3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.demoAssumptions } });
    const w = (await blocks("ws-reason", 4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } })).body;
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const url = `/api/workspaces/ws-reason/setups/${slot}/validations`;
    type Stage = { id: string; kind: string; selector?: Record<string, unknown> };
    type Row = { outcome: string; by: string; reason?: string };

    // A passing validation first: its entry carries no reason key.
    const ok = await api<{ outcome: string; compiledChain: Stage[] }>(t.base, "POST", `/api/workspaces/ws-reason/setups/${slot}/validate`, { by: "passer" });
    expect(ok.body.outcome).toBe("pass");

    // The chain again plus one more behavioral stage, st-x, selecting a product family no position holds: the routing
    // gate's R3 refuses it, while the chain's own stages still license every binding.
    const target = ok.body.compiledChain.find((s) => s.kind === "behavioral")!;
    expect(target).toBeDefined();
    const stages = [...ok.body.compiledChain, { ...target, id: "st-x", selector: { ...(target.selector ?? {}), dimensions: { productFamily: "no-such-family" } } }];
    const setup = (await api<{ setups: Array<{ setup: { id: string; plan: Record<string, unknown> } & Record<string, unknown> }> }>(
      t.base, "GET", "/api/run-setups?workspaceId=ws-reason")).body.setups[0]!.setup;
    const saved = await api(t.base, "POST", "/api/run-setups", {
      workspaceId: "ws-reason", setupLineageId: slot, expectedRevision: w.revision, by: "tester",
      setup: { ...setup, id: undefined, supersedes: setup.id, plan: { ...setup.plan, stages } },
    });
    expect(saved.status).toBe(201);
    const refused = await api<{ outcome: string; reports: { error: { code: string; message: string } } }>(
      t.base, "POST", `/api/workspaces/ws-reason/setups/${slot}/validate`, { by: "refused" });
    expect(refused.body.outcome).toBe("fail");
    expect(refused.body.reports.error.code).toBe("plan_rejected");
    expect(refused.body.reports.error.message).toBe("plan rejected: 2 gate failure(s): T5@st-x, R3@st-x");

    // An older-shaped line: the refusal's message only, no gate reports.
    const store = new WorkspaceStore(t.storeRoot);
    store.appendSetupEvent("ws-reason", {
      t: "validate", setupLineageId: slot, setupDocId: setup.id, at: "2026-10-11T00:00:00.000Z", by: "older",
      consumed: {}, outcome: "fail", basisLabel: "", basisByScenario: {}, skippedFamilies: [], reports: { error: { code: "validation", message: "an older refusal" } },
    } as SetupEvent);

    const before = store.readSetupEvents("ws-reason").length;
    const r = await api<{ validations: Row[] }>(t.base, "GET", url);
    expect(r.status).toBe(200);
    expect(r.body.validations.map((v) => v.by)).toEqual(["older", "refused", "passer"]);
    const [older, gate, pass] = r.body.validations;
    expect(older!.reason).toBe("an older refusal");
    // The headline first, then each gate sentence in gate order (type, then routing), restated by hand.
    expect(gate!.reason!.startsWith("plan rejected: 2 gate failure(s): T5@st-x, R3@st-x; reaches no metric stage; selector ")).toBe(true);
    expect(gate!.reason).toContain("productFamily");
    expect(gate!.reason).toContain("matches no position in portfolio");
    expect("reason" in pass!).toBe(false);
    expect(store.readSetupEvents("ws-reason").length).toBe(before);
  }, 120_000);

  it("GET validations restates a stored failed validation that carries no refusal: each gate sentence, then what readiness blocked it; a null or a string reports value gives no reason and a 200 (Studio Part 2 D11 follow-up)", async () => {
    const w = await ready("ws-reason2");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const docId = w.blocks.run.setups[0]!.current.id;
    const store = new WorkspaceStore(t.storeRoot);
    const line = (by: string, reports: unknown): SetupEvent => ({
      t: "validate", setupLineageId: slot, setupDocId: docId, at: `2026-10-11T00:00:0${by === "gates" ? 1 : by === "null" ? 2 : 3}.000Z`, by,
      consumed: {}, outcome: "fail", basisLabel: "", basisByScenario: {}, skippedFamilies: [], reports,
    } as SetupEvent);
    store.appendSetupEvent("ws-reason2", line("gates", {
      type: { passed: false, failures: [{ code: "T5", detail: "reaches no metric stage" }] },
      routing: { passed: false, failures: [{ code: "R3", detail: "selector matches no position" }] },
      warnings: [],
      notImplemented: [],
      readiness: { blocking: ["assumptions/Routing policy"], acknowledgeable: [] },
    }));
    store.appendSetupEvent("ws-reason2", line("null", null));
    store.appendSetupEvent("ws-reason2", line("string", "x"));
    const before = store.readSetupEvents("ws-reason2").length;
    const r = await api<{ validations: Array<{ by: string; reason?: string }> }>(t.base, "GET", `/api/workspaces/ws-reason2/setups/${slot}/validations`);
    expect(r.status).toBe(200);
    expect(r.body.validations.map((v) => v.by)).toEqual(["string", "null", "gates"]);
    const [str, nul, gates] = r.body.validations;
    expect(gates!.reason).toBe("reaches no metric stage; selector matches no position; blocked by assumptions/Routing policy");
    expect("reason" in nul!).toBe(false);
    expect("reason" in str!).toBe(false);
    expect(store.readSetupEvents("ws-reason2").length).toBe(before);
  });

  it("launch refuses without acknowledging the warning, then launches, attaches the run, stamps request.json.workspace and status.summary.workspaceId, and increments launchNo", async () => {
    const w = await readyWarned("ws-launch");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const refused = await api<{ blocking: string[]; acknowledgeable: string[] }>(t.base, "POST", `/api/workspaces/ws-launch/setups/${slot}/launch`, { by: "tester" });
    expect(refused.status).toBe(409);
    expect(refused.body.blocking).toEqual([]);
    expect(refused.body.acknowledgeable).toEqual([WARNINGS]);
    expect(new WorkspaceStore(t.storeRoot).readSetupEvents("ws-launch")).toEqual([]);
    const ack = refused.body.acknowledgeable;
    const r = await api<{ launchNo: number; runIds: string[]; failed: unknown[] }>(t.base, "POST", `/api/workspaces/ws-launch/setups/${slot}/launch`, { by: "tester", acknowledge: ack });
    expect(r.status).toBe(200);
    expect(r.body.launchNo).toBe(1);
    expect(r.body.runIds).toHaveLength(1);
    expect(r.body.failed).toEqual([]);
    const runId = r.body.runIds[0]!;
    const store = new FileStore(t.storeRoot);
    const req = store.readRunJson<StoredRunRequest>(runId, "request.json");
    const setupId = w.blocks.run.setups[0]!.current.id;
    expect(req.workspace).toEqual(expect.objectContaining({ workspaceId: "ws-launch", setupLineageId: slot, setupDocId: setupId, launchNo: 1 }));
    expect(Object.keys(req.workspace!.consumed).sort()).toEqual(["book", "market", "routingPolicy", `set:${SEED_IDS.vanillaAssumptions}`, "setup", "slate"].sort());
    // The slate role pins the launch slate the run inlined, by the hash of its stored bytes.
    const slateRef = req.workspace!.consumed.slate!;
    expect(slateRef.id).toBe(req.submission.scenarioSlateId);
    expect(slateRef.id.startsWith("plan-ws-")).toBe(true);
    expect(slateRef.contentHash).toBe(sha256Hex(store.getDocumentBytes("scenario-slates", slateRef.id)));
    expect(req.workspace!.consumed.setup!.id).toBe(setupId);
    expect(req.request.plan!.balanceBasis).toEqual(FLAT);
    expect(req.request.seed).toBe("platform-0");
    expect(store.readRunJson<RunStatus>(runId, "status.json").summary.workspaceId).toBe("ws-launch");
    expect(store.readRunJson<RunStatus>(runId, "status.json").label).toBe("Standard ALCO #1");
    const ws = new WorkspaceStore(t.storeRoot);
    expect(ws.readRunAttachments("ws-launch")).toEqual([
      expect.objectContaining({ runId, attachedBy: "launch", setupLineageId: slot, launchNo: 1, pins: "consumed" }),
    ]);
    const events = ws.readSetupEvents("ws-launch");
    expect(events.map((l) => l.t)).toEqual(["launch", "launch-complete"]);
    expect(events[0]).toEqual(expect.objectContaining({ launchNo: 1, acknowledged: [WARNINGS], batch: false, state: "submitting", setupDocId: setupId }));
    expect(events[1]).toEqual(expect.objectContaining({ launchNo: 1, runIds: [runId], failed: [] }));
    const r2 = await api<{ launchNo: number }>(t.base, "POST", `/api/workspaces/ws-launch/setups/${slot}/launch`, { by: "tester", acknowledge: ack });
    expect(r2.status).toBe(200);
    expect(r2.body.launchNo).toBe(2);
    // A launch appends no validate line, so Run setups still reads Draft beside the launched runs (review C m5).
    const rd = (await api<ReadinessReport>(t.base, "GET", "/api/workspaces/ws-launch/readiness")).body;
    expect(rd.items.find((i) => i.section === "run" && i.item === "Run setups")!.state).toBe("draft");
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 120_000);
    expect(done.body.state).toBe("done");
    const list = await api<Array<{ runId: string; basisLabel: string }>>(t.base, "GET", "/api/workspaces/ws-launch/runs");
    expect(list.body.find((x) => x.runId === runId)!.basisLabel).toBe("Flat (simple top-up)");
  }, 180_000);

  it("a pin moved between compile and submitRun is a 409 naming the role, with no request.json written and the bytes restored", async () => {
    const w = await ready("ws-pinmove");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const store = new FileStore(t.storeRoot);
    const setPath = store.paths.documentPath("assumption-sets", SEED_IDS.vanillaAssumptions);
    const bytesBefore = readFileSync(setPath);
    const before = store.listRunIds().length;
    // The seam rewrites the set's bytes (one added space) after the compile and before submitRun, then restores them.
    const r = await api(t.base, "POST", `/api/workspaces/ws-pinmove/setups/${slot}/launch`, {
      by: "tester",
      acknowledge: [WARNINGS],
      testSeam: { moveAfterCompile: `assumption-sets/${SEED_IDS.vanillaAssumptions}` },
    });
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/pin/);
    expect(r.text).toContain(`set:${SEED_IDS.vanillaAssumptions}`);
    // The refusal is submitRun's own check on the bytes it read, not the compile's.
    expect(r.text).toMatch(/moved between the setup compile and submission/);
    expect(store.listRunIds().length).toBe(before);
    expect(readFileSync(setPath).equals(bytesBefore)).toBe(true);
    // The launch line and its completion record the refusal; nothing was attached.
    const ws = new WorkspaceStore(t.storeRoot);
    const events = ws.readSetupEvents("ws-pinmove");
    expect(events.map((l) => l.t)).toEqual(["launch", "launch-complete"]);
    expect(events[1]).toEqual(expect.objectContaining({ runIds: [], failed: [expect.objectContaining({ status: 409 })] }));
    expect(ws.readRunAttachments("ws-pinmove")).toEqual([]);
  });

  it("the setup document's own pin is checked: a slot whose bytes moved refuses 409 naming the setup role", async () => {
    const w = await ready("ws-setuppin");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const r = await api(t.base, "POST", `/api/workspaces/ws-setuppin/setups/${slot}/launch`, {
      by: "tester",
      acknowledge: [WARNINGS],
      testSeam: { moveAfterCompile: `run-setups/${w.blocks.run.setups[0]!.current.id}` },
    });
    expect(r.status).toBe(409);
    expect((r.body as { error: { message: string } }).error.message).toMatch(/^pin setup "rs-[0-9a-f]{16}" moved between the setup compile and submission/);
  });

  it("a batch with one failing row submits nothing (422 with every row's report); a launch with no launch-complete is completed at boot with the runs it finds", async () => {
    const w = await ready("ws-batch");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const setup = (await api<{ setups: Array<{ setup: { id: string } & Record<string, unknown> }> }>(t.base, "GET", "/api/run-setups?workspaceId=ws-batch")).body.setups[0]!.setup;
    const withBatch = { ...setup, id: undefined, supersedes: setup.id, batch: [
      { label: "ok", scenarios: setup.scenarios, assumptionSetIds: { kind: "block-default" }, basis: { kind: "runoff" } },
      { label: "bad", scenarios: { kind: "slate", slateId: "not-in-block", include: "all" }, assumptionSetIds: { kind: "block-default" }, basis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 } },
    ] };
    const saved = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", { workspaceId: "ws-batch", setupLineageId: slot, expectedRevision: w.revision, by: "tester", setup: withBatch });
    expect(saved.status).toBe(201);
    const before = new FileStore(t.storeRoot).listRunIds().length;
    const r = await api<{ rows: Array<{ label: string; outcome: string }> }>(t.base, "POST", `/api/workspaces/ws-batch/setups/${slot}/launch`, { by: "tester", batch: true, acknowledge: [WARNINGS] });
    expect(r.status).toBe(422);
    expect(r.body.rows.map((x) => x.label)).toEqual(["ok", "bad"]);
    expect(r.body.rows.map((x) => x.outcome)).toEqual(["pass", "fail"]);
    expect(new FileStore(t.storeRoot).listRunIds().length).toBe(before);
    const ws = new WorkspaceStore(t.storeRoot);
    expect(ws.readSetupEvents("ws-batch").filter((l) => l.t === "launch")).toHaveLength(0);

    // A crash after a run's request.json landed and before its attachment and the launch-complete line.
    const store = new FileStore(t.storeRoot);
    const crashedRun = "run-20261009-000000-000c3c3";
    store.writeRunJson(crashedRun, "request.json", { workspace: { workspaceId: "ws-batch", setupLineageId: slot, setupDocId: "rs-x", launchNo: 1, consumed: {} } });
    ws.appendSetupEvent("ws-batch", { t: "launch", setupLineageId: slot, setupDocId: "rs-x", at: "t", by: "tester", consumed: {}, launchNo: 1, acknowledged: [], batch: false, state: "submitting" } as SetupEvent);
    const report = new WorkspaceStore(t.storeRoot).reconcileAll(new FileStore(t.storeRoot));
    expect(report.completedLaunches).toEqual([{ workspaceId: "ws-batch", launchNo: 1 }]);
    expect(report.attached).toContain(crashedRun);
    const last = new WorkspaceStore(t.storeRoot).readSetupEvents("ws-batch").at(-1)!;
    expect(last.t).toBe("launch-complete");
    expect(last).toEqual(expect.objectContaining({ setupLineageId: slot, launchNo: 1, runIds: [crashedRun], failed: [], reconciled: true }));
    // Forward only and once: a second reconcile completes nothing.
    expect(new WorkspaceStore(t.storeRoot).reconcileAll(new FileStore(t.storeRoot)).completedLaunches).toEqual([]);
  });

  it("a batch refused at row two leaves row one queued, records both in launch-complete, answers 207 and offers cancel", async () => {
    const w = await ready("ws-partial");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const setup = (await api<{ setups: Array<{ setup: { id: string } & Record<string, unknown> }> }>(t.base, "GET", "/api/run-setups?workspaceId=ws-partial")).body.setups[0]!.setup;
    const withBatch = { ...setup, id: undefined, supersedes: setup.id, batch: [
      { label: "flat", scenarios: setup.scenarios, assumptionSetIds: { kind: "block-default" }, basis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 } },
      { label: "runoff", scenarios: setup.scenarios, assumptionSetIds: { kind: "block-default" }, basis: { kind: "runoff" } },
    ] };
    const saved = await api(t.base, "POST", "/api/run-setups", { workspaceId: "ws-partial", setupLineageId: slot, expectedRevision: w.revision, by: "tester", setup: withBatch });
    expect(saved.status).toBe(201);
    const r = await api<{ launchNo: number; runIds: string[]; failed: Array<{ row: string; status: number; message: string }>; cancel: Array<{ runId: string; method: string; path: string }> }>(
      t.base, "POST", `/api/workspaces/ws-partial/setups/${slot}/launch`, {
        by: "tester",
        batch: true,
        acknowledge: [WARNINGS],
        testSeam: { moveAfterCompile: `assumption-sets/${SEED_IDS.vanillaAssumptions}`, row: 1 },
      });
    expect(r.status).toBe(207);
    expect(r.body.launchNo).toBe(1);
    expect(r.body.runIds).toHaveLength(1);
    expect(r.body.failed).toEqual([expect.objectContaining({ row: "runoff", status: 409 })]);
    expect(r.body.failed[0]!.message).toContain(`set:${SEED_IDS.vanillaAssumptions}`);
    const queued = r.body.runIds[0]!;
    expect(r.body.cancel).toEqual([{ runId: queued, method: "POST", path: `/api/runs/${queued}/cancel` }]);
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<RunStatus>(queued, "status.json").label).toBe("Standard ALCO #1 / flat");
    expect(["queued", "running"]).toContain(store.readRunJson<RunStatus>(queued, "status.json").state);
    const ws = new WorkspaceStore(t.storeRoot);
    expect(ws.readRunAttachments("ws-partial").map((a) => a.runId)).toEqual([queued]);
    const events = ws.readSetupEvents("ws-partial");
    expect(events.map((l) => l.t)).toEqual(["launch", "launch-complete"]);
    expect(events[0]).toEqual(expect.objectContaining({ batch: true }));
    expect(events[1]).toEqual(expect.objectContaining({ runIds: [queued], failed: [expect.objectContaining({ row: "runoff", status: 409 })] }));
    // The offered cancel works; the queue is left clean for the next test.
    const c = await api<RunStatus>(t.base, r.body.cancel[0]!.method, r.body.cancel[0]!.path);
    expect(c.status).toBe(200);
  });

  it("a Stale setup is acknowledgeable on a Test workspace and blocks a Production workspace outright", async () => {
    const pins = { contentHash: "0".repeat(64), pinnedAt: "t" };
    for (const [id, type] of [["ws-stale-test", "test"], ["ws-stale-prod", "production"]] as const) {
      const w = await readyWarned(id, type);
      const slot = w.blocks.run.setups[0]!;
      // A validation line whose book pin differs from what the workspace now pins in that role.
      new WorkspaceStore(t.storeRoot).appendSetupEvent(id, {
        t: "validate", setupLineageId: slot.setupLineageId, setupDocId: slot.current.id, at: "t", by: "tester",
        consumed: { book: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio, ...pins } },
        outcome: "warn", basisLabel: "Flat (simple top-up)", basisByScenario: {}, skippedFamilies: [], reports: {},
      });
      // Production: refused even with both acknowledgements. Test: refused only without them, as acknowledgeable.
      const body = type === "production" ? { by: "tester", acknowledge: [SETUPS, WARNINGS] } : { by: "tester" };
      const r = await api<{ blocking: string[]; acknowledgeable: string[]; staleRoles: Array<{ role: string; pinned: string; current: string | null }> }>(
        t.base, "POST", `/api/workspaces/${id}/setups/${slot.setupLineageId}/launch`, body);
      expect(r.status).toBe(409);
      expect(r.body.staleRoles).toEqual([
        { role: "book", pinned: "0".repeat(64), current: w.blocks.positions.book!.contentHash },
      ]);
      if (type === "production") {
        expect(r.body.blocking).toEqual([SETUPS]);
        // The setup's standing warning (EVE valuation at later dates) is its own acknowledgeable item, apart from the blocking staleness.
        expect(r.body.acknowledgeable).toEqual([WARNINGS]);
        expect(r.text).toMatch(/Production/);
      } else {
        expect(r.body.blocking).toEqual([]);
        expect(r.body.acknowledgeable).toEqual([SETUPS, WARNINGS]);
      }
      expect(new WorkspaceStore(t.storeRoot).readSetupEvents(id).filter((l) => l.t === "launch")).toHaveLength(0);
    }
  });

  it("acknowledging the setup's warning does not acknowledge staleness, nor the reverse (review C m2)", async () => {
    const h = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-stale-test")).body;
    const slot = h.blocks.run.setups[0]!.setupLineageId;
    const launch = (acknowledge: string[]) =>
      api<{ error: { code: string; message: string }; acknowledgeable: string[] }>(t.base, "POST", `/api/workspaces/ws-stale-test/setups/${slot}/launch`, { by: "tester", acknowledge });
    const onlyWarnings = await launch([WARNINGS]);
    expect(onlyWarnings.status).toBe(409);
    expect(onlyWarnings.body.error.code).toBe("acknowledge-required");
    expect(onlyWarnings.body.error.message).toMatch(/^launch needs acknowledge: \["run\/setups"\]: /);
    const onlyStale = await launch([SETUPS]);
    expect(onlyStale.status).toBe(409);
    expect(onlyStale.body.error.code).toBe("acknowledge-required");
    expect(onlyStale.body.error.message).toMatch(/^launch needs acknowledge: \["run\/setup-warnings"\]: /);
    expect(new WorkspaceStore(t.storeRoot).readSetupEvents("ws-stale-test").filter((l) => l.t === "launch")).toHaveLength(0);
    // Both named: the Test workspace launches on the stale pins, and the launch line keeps both ids.
    const both = await launch([SETUPS, WARNINGS]);
    expect(both.status).toBe(200);
    const line = new WorkspaceStore(t.storeRoot).readSetupEvents("ws-stale-test").find((l) => l.t === "launch")!;
    expect(line).toEqual(expect.objectContaining({ acknowledged: [SETUPS, WARNINGS] }));
  });

  it("a launch on a locked Production workspace is refused with the lock refusal and writes nothing (review C m5)", async () => {
    // ws-stale-prod (the test above) is the one Production workspace this cut-off allows; sign it off to lock it.
    const h = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-stale-prod")).body;
    const signed = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-stale-prod/sign-off", { expectedRevision: h.revision, by: "signer", signedHash: h.signedHash });
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe("locked");
    const slot = h.blocks.run.setups[0]!.setupLineageId;
    const readinessBefore = (await api<ReadinessReport>(t.base, "GET", "/api/workspaces/ws-stale-prod/readiness")).body;
    const eventsBefore = new WorkspaceStore(t.storeRoot).readSetupEvents("ws-stale-prod");
    const runsBefore = new FileStore(t.storeRoot).listRunIds().length;
    const r = await api<{ error: { code: string; message: string } }>(t.base, "POST", `/api/workspaces/ws-stale-prod/setups/${slot}/launch`, {
      by: "tester",
      acknowledge: [SETUPS, WARNINGS],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
    expect(r.body.error.message).toMatch(/^workspace "ws-stale-prod" is locked by approval \S+; a signed Production workspace changes only by clone/);
    // What the code does: no setups.ndjson line, no run, and the Run setups item reads as it did (Stale, from the injected validation).
    expect(new WorkspaceStore(t.storeRoot).readSetupEvents("ws-stale-prod")).toEqual(eventsBefore);
    expect(new FileStore(t.storeRoot).listRunIds().length).toBe(runsBefore);
    const readinessAfter = (await api<ReadinessReport>(t.base, "GET", "/api/workspaces/ws-stale-prod/readiness")).body;
    expect(readinessAfter.items.find((i) => i.section === "run" && i.item === "Run setups")!.state).toBe("stale");
    expect(readinessAfter.items).toEqual(readinessBefore.items);
  });

  it("a setup asking for the stochastic EVE path is refused by validate and launch with the named refusal, and readiness reads Error with its text (review C M1)", async () => {
    const w = await ready("ws-stoch");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const setup = (await api<{ setups: Array<{ setup: { id: string; eve: Record<string, unknown> } & Record<string, unknown> }> }>(t.base, "GET", "/api/run-setups?workspaceId=ws-stoch")).body.setups[0]!.setup;
    const save = (rev: number, eve: Record<string, unknown>, supersedes: string) =>
      api<{ setup: { id: string }; manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", {
        workspaceId: "ws-stoch", setupLineageId: slot, expectedRevision: rev, by: "tester", setup: { ...setup, id: undefined, supersedes, eve },
      });
    const saved = await save(w.revision, { ...setup.eve, path: "stochastic", stochastic: { nPaths: 64 } }, setup.id);
    expect(saved.status).toBe(201);
    const runSetupsItem = async () =>
      (await api<ReadinessReport>(t.base, "GET", "/api/workspaces/ws-stoch/readiness")).body;

    // Readiness, before any validation: Error with the refusal's text, blocking the launch.
    let r = await runSetupsItem();
    let item = r.items.find((i) => i.section === "run" && i.item === "Run setups")!;
    expect(item.state).toBe("error");
    expect(item.detail).toBe(STOCHASTIC_REFUSAL);
    expect(r.launchable[slot]!.blocking).toContain(SETUPS);

    // Validate: a failed validation whose report carries the named refusal.
    const v = await api<{ outcome: string; planId: string | null; reports: { error: { code: string; message: string } } }>(
      t.base, "POST", `/api/workspaces/ws-stoch/setups/${slot}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.body.outcome).toBe("fail");
    expect(v.body.planId).toBeNull();
    expect(v.body.reports.error.code).toBe("stochastic-path-reserved");
    expect(v.body.reports.error.message).toBe(STOCHASTIC_REFUSAL);
    r = await runSetupsItem();
    item = r.items.find((i) => i.section === "run" && i.item === "Run setups")!;
    expect(item.state).toBe("error");
    expect(item.detail).toBe(STOCHASTIC_REFUSAL);

    // Launch: the same refusal, before the gate; nothing is written and no run is submitted.
    const runsBefore = new FileStore(t.storeRoot).listRunIds().length;
    const l = await api<{ error: { code: string; message: string } }>(t.base, "POST", `/api/workspaces/ws-stoch/setups/${slot}/launch`, {
      by: "tester",
      acknowledge: [SETUPS, WARNINGS],
    });
    expect(l.status).toBe(422);
    expect(l.body.error.code).toBe("stochastic-path-reserved");
    expect(l.body.error.message).toBe(STOCHASTIC_REFUSAL);
    expect(new WorkspaceStore(t.storeRoot).readSetupEvents("ws-stoch").filter((e) => e.t !== "validate")).toEqual([]);
    expect(new FileStore(t.storeRoot).listRunIds().length).toBe(runsBefore);

    // Choosing single path: the same setup validates and launches the deterministic path.
    const single = await save(saved.body.manifest.revision, { ...setup.eve, path: "single" }, saved.body.setup.id);
    expect(single.status).toBe(201);
    const v2 = await api<{ outcome: string }>(t.base, "POST", `/api/workspaces/ws-stoch/setups/${slot}/validate`, { by: "tester" });
    expect(v2.body.outcome).toBe("pass");
    const l2 = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/ws-stoch/setups/${slot}/launch`, { by: "tester", acknowledge: [WARNINGS] });
    expect(l2.status).toBe(200);
    expect(l2.body.runIds).toHaveLength(1);
  });

  it("a setup with key-rate durations and channel attribution on launches a run whose result carries both blocks (review M4)", async () => {
    const w = await ready("ws-keyrate");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const setup = (await api<{ setups: Array<{ setup: { id: string; eve: Record<string, unknown> } & Record<string, unknown> }> }>(t.base, "GET", "/api/run-setups?workspaceId=ws-keyrate")).body.setups[0]!.setup;
    const saved = await api<{ setup: { id: string } }>(t.base, "POST", "/api/run-setups", {
      workspaceId: "ws-keyrate", setupLineageId: slot, expectedRevision: w.revision, by: "tester",
      setup: { ...setup, id: undefined, supersedes: setup.id, eve: { ...setup.eve, keyRate: true, channels: true } },
    });
    expect(saved.status).toBe(201);
    const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/ws-keyrate/setups/${slot}/launch`, { by: "tester", acknowledge: [WARNINGS] });
    expect(l.status).toBe(200);
    const runId = l.body.runIds[0]!;
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<StoredRunRequest>(runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto", keyRate: true, eveChannels: true,
      // Standard ALCO carries the corrections.
      modelConvention: "corrected-v1",
      // The Standard ALCO setup asks for monthly buckets on both ladders and [12, 24, 60].
      gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" }, reportHorizons: [12, 24, 60],
    });
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    const result = store.readRunJson<{ eve: { keyRate?: { nodes: unknown[] }; channels?: { byScenario: unknown[] } } }>(runId, "result.json");
    expect(result.eve.keyRate).toBeDefined();
    expect(result.eve.keyRate!.nodes.length).toBeGreaterThan(0);
    expect(result.eve.channels).toBeDefined();
    expect(result.eve.channels!.byScenario.length).toBeGreaterThan(0);
  }, 300_000);

  it("a setup on the spread-consistent basis launches a run whose stored request and EVE block carry it (spec E3)", async () => {
    const w = await ready("ws-spread");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const setup = (await api<{ setups: Array<{ setup: { id: string; eve: Record<string, unknown> } & Record<string, unknown> }> }>(t.base, "GET", "/api/run-setups?workspaceId=ws-spread")).body.setups[0]!.setup;
    const saved = await api<{ setup: { id: string } }>(t.base, "POST", "/api/run-setups", {
      workspaceId: "ws-spread", setupLineageId: slot, expectedRevision: w.revision, by: "tester",
      setup: { ...setup, id: undefined, supersedes: setup.id, eve: { ...setup.eve, discountBasis: "spread-consistent" } },
    });
    expect(saved.status).toBe(201);
    const v = await api<{ outcome: string; warnings?: string[] }>(t.base, "POST", `/api/workspaces/ws-spread/setups/${slot}/validate`, { by: "tester" });
    expect(JSON.stringify(v.body)).not.toMatch(/discount basis is reserved/);
    const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/ws-spread/setups/${slot}/launch`, { by: "tester", acknowledge: [WARNINGS] });
    expect(l.status).toBe(200);
    const runId = l.body.runIds[0]!;
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<StoredRunRequest>(runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto", discountBasis: "spread-consistent",
      // Standard ALCO carries the corrections.
      modelConvention: "corrected-v1",
      // The Standard ALCO setup asks for monthly buckets on both ladders and [12, 24, 60].
      gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" }, reportHorizons: [12, 24, 60],
    });
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    expect(store.readRunJson<{ eve: { discountBasis: string } }>(runId, "result.json").eve.discountBasis).toBe("spread-consistent");
  }, 300_000);

  it("a raw submission names a bad discount basis, and refuses one on a stochastic run (spec E3)", async () => {
    const body = {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    };
    type Refusal = { error: { message: string } };
    const bad = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, engineOptions: { discountBasis: "par" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe('engineOptions.discountBasis must be "all-in", "risk-free" or "spread-consistent", got "par"');
    const sto = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { discountBasis: "spread-consistent" } });
    expect(sto.status).toBe(422);
    expect(sto.body.error.message).toMatch(/discountBasis "spread-consistent" applies to a deterministic run only/);
  });

  it("a raw submission carries the regulatory deposit convention into the stored context and the result (spec E2)", async () => {
    const body = {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    };
    type Refusal = { error: { message: string } };
    const bad = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nmdConvention: "basel" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe('engineOptions.nmdConvention must be "behavioral", "regulatory" or "shocked-level", got "basel"');
    const sto = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { nmdConvention: "regulatory" } });
    expect(sto.status).toBe(422);
    expect(sto.body.error.message).toMatch(/nmdConvention "regulatory" applies to a deterministic run only/);

    const ok = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nmdConvention: "regulatory" } });
    expect(ok.status).toBe(202);
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<StoredRunRequest>(ok.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto", nmdConvention: "regulatory",
    });
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${ok.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    // The vanilla book holds no deposits, so nothing splits: the convention is recorded and no parentOf is written.
    const result = store.readRunJson<Record<string, unknown>>(ok.body.runId, "result.json");
    expect(result.nmdConvention).toBe("regulatory");
    expect("parentOf" in result).toBe(false);

    // "behavioral" is the default and stores the context a run without the option stores.
    const beh = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nmdConvention: "behavioral" } });
    expect(beh.status).toBe(202);
    expect(store.readRunJson<StoredRunRequest>(beh.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto",
    });
  }, 300_000);

  it("a raw submission carries the seg opt-in into the stored context and the result, and the section route serves it (spec E1, E7)", async () => {
    const body = {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    };
    type Refusal = { error: { message: string } };
    const bad = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, engineOptions: { seg: "yes" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe('engineOptions.seg must be a boolean, got "yes"');
    const sto = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { seg: true } });
    expect(sto.status).toBe(422);
    expect(sto.body.error.message).toMatch(/engineOptions.seg applies to a deterministic run only/);

    const ok = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { seg: true } });
    expect(ok.status).toBe(202);
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<StoredRunRequest>(ok.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto", seg: true,
    });
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${ok.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    const result = store.readRunJson<{ seg?: { convention: string; segBank: number[] }; nii: { nimPct?: number } }>(ok.body.runId, "result.json");
    expect(result.seg!.convention).toBe("constant-balance-sheet");
    expect(result.seg!.segBank).toHaveLength(60);
    expect(typeof result.nii.nimPct).toBe("number");
    const section = await api<{ convention: string }>(t.base, "GET", `/api/runs/${ok.body.runId}/result/seg`);
    expect(section.status).toBe(200);
    expect(section.body.convention).toBe("constant-balance-sheet");

    // seg false is the default and stores the context a run without the option stores.
    const off = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { seg: false } });
    expect(off.status).toBe(202);
    expect(store.readRunJson<StoredRunRequest>(off.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto",
    });
    const offDone = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${off.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(offDone.body.state).toBe("done");
    const missing = await api<Refusal>(t.base, "GET", `/api/runs/${off.body.runId}/result/seg`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toMatch(/did not opt in to engineOptions.seg/);
  }, 300_000);

  it("a raw submission carries the nextResetGap opt-in into the stored context and the result (Task 15)", async () => {
    const body = {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    };
    type Refusal = { error: { message: string } };
    const bad = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nextResetGap: "yes" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe('engineOptions.nextResetGap must be a boolean, got "yes"');
    const sto = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { nextResetGap: true } });
    expect(sto.status).toBe(422);
    expect(sto.body.error.message).toMatch(/engineOptions.nextResetGap applies to a deterministic run only/);

    const ok = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nextResetGap: true } });
    expect(ok.status).toBe(202);
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<StoredRunRequest>(ok.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto", nextResetGap: true,
    });
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${ok.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    const result = store.readRunJson<{ gap: { nextReset?: { bands: string[]; rows: unknown[] } } }>(ok.body.runId, "result.json");
    expect(result.gap.nextReset!.bands).toHaveLength(9);
    expect(result.gap.nextReset!.rows).toHaveLength(9);

    // nextResetGap false is the default and stores the context a run without the option stores.
    const off = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nextResetGap: false } });
    expect(off.status).toBe(202);
    expect(store.readRunJson<StoredRunRequest>(off.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto",
    });
    const offDone = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${off.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(offDone.body.state).toBe("done");
    expect("nextReset" in store.readRunJson<{ gap: object }>(off.body.runId, "result.json").gap).toBe(false);
  }, 300_000);

  it("a raw submission carries the nmdWarmup option into the stored context and the result (Task 16)", async () => {
    const body = {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    };
    type Refusal = { error: { message: string } };
    const bad = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nmdWarmup: { kind: "flat-at-r0", months: 0 } } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe("engineOptions.nmdWarmup.months must be a positive integer number of months, got 0");
    const warmup = { kind: "flat-at-r0", months: 36 };
    const sto = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { nmdWarmup: warmup } });
    expect(sto.status).toBe(422);
    expect(sto.body.error.message).toMatch(/engineOptions.nmdWarmup applies to a deterministic run only/);

    const ok = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { nmdWarmup: { ...warmup, extra: 1 } } });
    expect(ok.status).toBe(202);
    const store = new FileStore(t.storeRoot);
    // Known keys only: the stored context drops what the option does not define.
    expect(store.readRunJson<StoredRunRequest>(ok.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto", nmdWarmup: warmup,
    });
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${ok.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    const result = store.readRunJson<{ nmdWarmup?: { kind: string; months: number; shiftPctByScenario: Record<string, number> } }>(ok.body.runId, "result.json");
    expect(result.nmdWarmup!.kind).toBe("flat-at-r0");
    // The seeded vanilla slate: a base and parallel shocks of -200, -100, +100 and +200bp, so shockBp / 100 each.
    expect(Object.values(result.nmdWarmup!.shiftPctByScenario).sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
  }, 300_000);

  it("a raw submission carries the liquidityStress opt-in into the stored context and the result, and the section route serves it (spec E5)", async () => {
    const body = {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    };
    const table = {
      bau: { hysOutflowMonthly: 0.005, wholesaleRenewal: 1, nibOutflowMonthly: 0.002, drawRate: 0 },
      moderate: { hysOutflowMonthly: 0.05, wholesaleRenewal: 0.5, nibOutflowMonthly: 0.01, drawRate: 0.15 },
      severe: { hysOutflowMonthly: 0.1, wholesaleRenewal: 0, nibOutflowMonthly: 0.02, drawRate: 0.3 },
    };
    const optIn = { table, buffer: 2_170_000_000, undrawnFace: 500_000_000 };
    type Refusal = { error: { message: string } };
    const bad = await api<Refusal>(t.base, "POST", "/api/runs", {
      ...body, engineOptions: { liquidityStress: { ...optIn, table: { ...table, severe: { ...table.severe, drawRate: 2 } } } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toBe("engineOptions.liquidityStress.table.severe.drawRate must be a decimal in [0, 1], got 2");
    const sto = await api<Refusal>(t.base, "POST", "/api/runs", { ...body, mode: "stochastic", engineOptions: { liquidityStress: optIn } });
    expect(sto.status).toBe(422);
    expect(sto.body.error.message).toMatch(/engineOptions.liquidityStress applies to a deterministic run only/);

    // An extra key in the body never reaches request.json.
    const ok = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...body, engineOptions: { liquidityStress: { ...optIn, note: "x" } } });
    expect(ok.status).toBe(202);
    const store = new FileStore(t.storeRoot);
    expect(store.readRunJson<StoredRunRequest>(ok.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto", liquidityStress: optIn,
    });
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${ok.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(done.body.state).toBe("done");
    const result = store.readRunJson<{ liquidityStress?: { buffer: number; scenarios: { id: string }[] } }>(ok.body.runId, "result.json");
    expect(result.liquidityStress!.buffer).toBe(2_170_000_000);
    expect(result.liquidityStress!.scenarios.map((s) => s.id)).toEqual(["bau", "moderate", "severe"]);
    const section = await api<{ undrawnFace: number }>(t.base, "GET", `/api/runs/${ok.body.runId}/result/liquidityStress`);
    expect(section.status).toBe(200);
    expect(section.body.undrawnFace).toBe(500_000_000);

    // A run without the option stores the context it always did and serves no block.
    const off = await api<{ runId: string }>(t.base, "POST", "/api/runs", body);
    expect(off.status).toBe(202);
    expect(store.readRunJson<StoredRunRequest>(off.body.runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto",
    });
    const offDone = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${off.body.runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
    expect(offDone.body.state).toBe("done");
    const missing = await api<Refusal>(t.base, "GET", `/api/runs/${off.body.runId}/result/liquidityStress`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toMatch(/did not opt in to engineOptions.liquidityStress/);
  }, 300_000);

  it("a setup with both off stores the engine context it always did: no keyRate or eveChannels key (review M4)", async () => {
    const w = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-launch")).body;
    const runId = new WorkspaceStore(t.storeRoot).readRunAttachments(w.id)[0]!.runId;
    // The Standard ALCO setup asks for monthly buckets on both ladders and [12, 24, 60]; still no
    // keyRate or eveChannels key. Ws-launch was saved by readyWarned onto a warned setting (since slice B2, EVE
    // valuation at later dates), which writes no engine option, so no liquidityFlows or fixedRateGap key either.
    expect(new FileStore(t.storeRoot).readRunJson<StoredRunRequest>(runId, "request.json").engineContext).toEqual({
      durationMode: "base-only", shards: "auto",
      // Standard ALCO carries the corrections.
      modelConvention: "corrected-v1",
      gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" },
      reportHorizons: [12, 24, 60],
    });
    // A non-boolean flag on a raw submission is refused by name, never coerced.
    const bad = await api(t.base, "POST", "/api/runs", {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions], engineOptions: { keyRate: "yes" },
    });
    expect(bad.status).toBe(422);
    expect(bad.text).toMatch(/engineOptions\.keyRate must be a boolean/);
  });

  it("a raw POST /api/runs may not carry a workspace stamp", async () => {
    const r = await api(t.base, "POST", "/api/runs", {
      portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
      workspace: { workspaceId: "ws-launch", setupLineageId: "x", setupDocId: "x", launchNo: 9, consumed: {} },
    });
    expect(r.status).toBe(422);
    expect(r.text).toMatch(/workspace/);
  });
});

describe("a stored book the engine cannot season (Studio blank path D4)", () => {
  it("validate records a failed validation naming the first five positions, the count of the rest and the first engine reason; launch refuses with the same sentence", async () => {
    // Straight into the store, bypassing import (which now refuses it): the synthetic book with
    // seven of its floaters stamped originationOffsetMonths -6.
    const store = new FileStore(t.storeRoot);
    const base = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
    const floaters = base.positions.filter((p) => p.terms.type === "floating-loan").slice(0, 7).map((p) => p.id);
    expect(floaters).toHaveLength(7);
    const book: PortfolioSpec = {
      ...base,
      id: "synthetic-seasoned-floaters",
      positions: base.positions.map((p) => (floaters.includes(p.id) ? { ...p, terms: { ...p.terms, originationOffsetMonths: -6 } } : p)),
    };
    store.putDocument("portfolios", book.id, book, { label: book.label, asOf: book.asOf, positionCount: book.positions.length });

    const id = "ws-seasoned";
    expect((await api(t.base, "POST", "/api/workspaces", { id, name: "S", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" })).status).toBe(201);
    await blocks(id, 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: book.id } });
    await blocks(id, 2, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await blocks(id, 3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    const w = await blocks(id, 4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
    expect(w.status).toBe(201);
    const slot = w.body.blocks.run.setups[0]!.setupLineageId;

    // The sentence, restated by hand from the spec: at most the first five positions, the count of the rest,
    // then the first refused position's engine message, read off seasoningOffsetOf for that position's terms.
    const first = book.positions.find((p) => p.id === floaters[0])!;
    let engineMessage = "";
    try {
      seasoningOffsetOf(first.terms);
    } catch (e) {
      engineMessage = (e as Error).message;
    }
    expect(engineMessage).toContain(`instrument "${floaters[0]}" (floating-loan)`);
    const named = floaters.slice(0, 5).map((p) => `"${p}"`).join(", ");
    const sentence =
      `book "synthetic-seasoned-floaters" holds 7 positions whose originationOffsetMonths the engine cannot season: ` +
      `${named} and 2 more; the first reads: ${engineMessage}.`;

    const v = await api<{ outcome: string; planId: string | null; reports: { error: { code: string; message: string } } }>(
      t.base, "POST", `/api/workspaces/${id}/setups/${slot}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.body.outcome).toBe("fail");
    expect(v.body.planId).toBeNull();
    expect(v.body.reports.error.code).toBe("validation");
    expect(v.body.reports.error.message).toBe(sentence);
    const lines = new WorkspaceStore(t.storeRoot).readSetupEvents(id);
    expect(lines.map((l) => [l.t, (l as { outcome?: string }).outcome])).toEqual([["validate", "fail"]]);

    const runsBefore = store.listRunIds().length;
    const l = await api<{ error: { code: string; message: string } }>(t.base, "POST", `/api/workspaces/${id}/setups/${slot}/launch`, {
      by: "tester",
      acknowledge: [SETUPS, WARNINGS],
    });
    expect(l.status).toBe(422);
    expect(l.body.error.message).toBe(sentence);
    expect(new WorkspaceStore(t.storeRoot).readSetupEvents(id).filter((e) => e.t !== "validate")).toEqual([]);
    expect(store.listRunIds().length).toBe(runsBefore);
  }, 120_000);
});
