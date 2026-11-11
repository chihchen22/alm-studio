/**
 * Studio slice S2b-3 test (c), the server half. A Hull-White fit is fitted and saved through the routes; a run with it
 * and a run with the same parameters through the override seam give byte-equal envelopes, run id, calibration arm and
 * schema stamp aside; a run on another snapshot is refused in one plain sentence; a BGM fit outside its gate is refused
 * without a reason and saved with one; a workspace launch pins the saved fit as a consumed role. Sentences and the
 * figures of record are restated by hand.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SavedCalibration } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import type { RunStatus } from "../jobs/types";

let t: TestPlatform;
let store: FileStore;
const PUBLIC = "market-public-2026-03-31";
const COPY = "market-public-copy";
const SET = () => SEED_IDS.vanillaAssumptions;
let hw: SavedCalibration;

const done = (runId: string) => waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
const envelope = (runId: string) => JSON.parse(readFileSync(join(t.storeRoot, "runs", runId, "result.json"), "utf8")) as Record<string, unknown>;
const post = (stochastic: Record<string, unknown>, marketId = PUBLIC) =>
  api<{ runId: string; error?: { message: string } }>(t.base, "POST", "/api/runs", { portfolioId: SEED_IDS.vanillaPortfolio, marketId, scenarioSlateId: "base-s2b3", assumptionSetIds: [SET()], seed: "5", mode: "stochastic", stochastic: { nPaths: 20, ...stochastic } });

beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  store.putDocument("market", COPY, store.getDocument("market", PUBLIC).doc, { label: "copy" });
  store.putDocument("scenario-slates", "base-s2b3", { id: "base-s2b3", label: "Base", scenarios: [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: SET(), newBusiness: { mode: "static", rules: [] } }] }, { label: "Base", scenarioCount: 1 });
}, 120_000);

afterAll(() => t.close());

describe("saved calibration through the routes", () => {
  it("fits Hull-White within its gate and saves it, content-addressed", async () => {
    const fit = await api<{ fit: { rmseBp: number; breached: boolean; gateBp: number }; verdict: string; pins: { marketId: string } }>(t.base, "POST", "/api/calibrations/fit", { marketId: PUBLIC, model: "hull-white-1f" });
    expect(fit.status, fit.text).toBe(200);
    expect(fit.body.fit.breached).toBe(false);
    expect(fit.body.verdict).toMatch(/^0\.\d\d bp against a 5 bp gate: within its gate$/);
    const saved = await api<SavedCalibration>(t.base, "POST", "/api/calibrations", { marketId: PUBLIC, model: "hull-white-1f", label: "HW on the public pack", by: "tester" });
    expect(saved.status, saved.text).toBe(201);
    hw = saved.body;
    expect(hw.id).toMatch(/^cal-[0-9a-f]{16}$/);
    expect(hw.acceptance).toEqual({ kind: "within-gate" });
    expect(hw.pins.marketHash).toBe(store.getMeta("market", PUBLIC).contentHash);
    const again = await api<SavedCalibration>(t.base, "POST", "/api/calibrations", { marketId: PUBLIC, model: "hull-white-1f", label: "HW on the public pack", by: "someone else" });
    expect([again.status, again.body.id, again.body.createdBy]).toEqual([200, hw.id, "tester"]);
    const list = await api<{ calibrations: SavedCalibration[] }>(t.base, "GET", `/api/calibrations?marketId=${PUBLIC}`);
    expect(list.body.calibrations.map((c) => c.id)).toEqual([hw.id]);
  });

  it("a run with the saved fit equals a run with its parameters through the override seam", async () => {
    const p = hw.fit.parameters as { a: number; sigma: number };
    const a = await post({ calibrationId: hw.id });
    const b = await post({ modelParams: { a: p.a, sigma: p.sigma, reason: "same values typed in" } });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect((await done(a.body.runId)).body.state).toBe("done");
    expect((await done(b.body.runId)).body.state).toBe("done");
    const ea = envelope(a.body.runId);
    const eb = envelope(b.body.runId);
    expect(ea.schemaVersion).toBe("0.5.0");
    expect((ea.calibration as { source: string; calibrationId: string }).source).toBe("saved-calibration");
    expect((ea.calibration as { calibrationId: string }).calibrationId).toBe(hw.id);
    const strip = (e: Record<string, unknown>) => JSON.stringify({ ...e, runId: "", calibration: null, schemaVersion: null });
    expect(strip(ea)).toBe(strip(eb));
  });

  it("refuses the saved fit on another snapshot, beside modelParams, and for another model, each in one sentence", async () => {
    const other = await post({ calibrationId: hw.id }, COPY);
    expect(other.status).toBe(422);
    expect(other.body.error!.message).toBe(`The saved calibration ${hw.id} was fitted on market snapshot "${PUBLIC}", and this run reads "${COPY}": fit the model again on this market, or run on that one.`);
    const both = await post({ calibrationId: hw.id, modelParams: { a: 0.1, sigma: 0.01, reason: "x" } });
    expect(both.status).toBe(422);
    expect(both.body.error!.message).toBe("A run uses a saved calibration or explicit parameters, not both: drop stochastic.modelParams or stochastic.calibrationId.");
    const bgm = await post({ calibrationId: hw.id, model: "bgm-lmm-2f" });
    expect(bgm.status).toBe(422);
    expect(bgm.body.error!.message).toMatch(/is a fit of the Hull-White one-factor model \(hull-white-1f\), and this run names bgm-lmm-2f/);
  });

  it("refuses a BGM fit outside its gate without a reason, and saves it with one", async () => {
    const no = await api<{ error: { message: string } }>(t.base, "POST", "/api/calibrations", { marketId: PUBLIC, model: "bgm-lmm-2f", label: "BGM", by: "tester" });
    expect(no.status).toBe(422);
    expect(no.body.error.message).toMatch(/^This fit is outside its gate \(12\.\d\d bp against a 10 bp gate: outside its gate\)\. Write the reason you accept it to save it\.$/);
    const yes = await api<SavedCalibration>(t.base, "POST", "/api/calibrations", { marketId: PUBLIC, model: "bgm-lmm-2f", label: "BGM", by: "tester", reason: "Teaching run: the one-factor shape misses the long end." });
    expect(yes.status, yes.text).toBe(201);
    expect(yes.body.acceptance).toEqual({ kind: "outside-gate", reason: "Teaching run: the one-factor shape misses the long end." });
    expect(yes.body.fit.iterations).toBe(150);
  }, 60_000);

  it("a workspace launch on the saved fit pins it as a consumed role", async () => {
    const WS = "ws-s2b3-cal";
    let w = (await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id: WS, name: "Cal", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" })).body;
    for (const body of [
      { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } },
      { block: "market", op: "set", ref: { collection: "market", id: PUBLIC } },
      { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SET() } },
      { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } },
    ]) w = (await api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${WS}/blocks`, { expectedRevision: w.revision, by: "tester", ...body })).body;
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const { id: _d, ...rest } = store.getDocument<RunSetup>("run-setups", w.blocks.run.setups[0]!.current.id).doc;
    void _d;
    const s = await api(t.base, "POST", "/api/run-setups", { workspaceId: WS, setupLineageId: slot, expectedRevision: w.revision, by: "tester", setup: { ...rest, eve: { ...rest.eve, stochastic: { nPaths: 20, seed: "5", calibrationId: hw.id } } } });
    expect(s.status, s.text).toBe(201);
    const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/${WS}/setups/${slot}/launch`, { by: "tester", mode: "stochastic" });
    expect(l.status, l.text).toBe(200);
    const req = JSON.parse(readFileSync(join(t.storeRoot, "runs", l.body.runIds[0]!, "request.json"), "utf8")) as { stochastic: { calibrationId: string }; workspace: { consumed: Record<string, { collection: string; id: string }> } };
    expect(req.stochastic.calibrationId).toBe(hw.id);
    expect(req.workspace.consumed.calibration).toMatchObject({ collection: "calibrations", id: hw.id });
    expect((await done(l.body.runIds[0]!)).body.state).toBe("done");
  });
});
