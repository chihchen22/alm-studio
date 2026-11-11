// apps/server/src/__tests__/curveSetupLaunch.test.ts
// A launch with an active curve setup. The compile pins the active setup
// into ONE derived market carrying the curveSetup block (the reapply.ts id pattern, so a re-launch
// reuses it); no active setup leaves the market role byte-identical; a missing active setup is a
// named readiness error and never a silent legacy run; and the run a pinned market launches really
// builds its base curve from the setup (the key survives every step from the store to buildBaseCurve).
// Expected curve values come from the engine's own buildCurveFromSetup; sentences are restated by hand.
import { renameSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCurveFromSetup, type CurveSetupBlock } from "@alm/engine";
import { monthExactSnapshot, setupFromSnapshot } from "@alm/engine/src/curveBuilder/__tests__/helpers";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import type { MarketSnapshot } from "@alm/kernel";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { compileSetupRow } from "../workspaces/setupCompile";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import type { ReadinessReport } from "../workspaces/readiness";
import type { RunStatus, StoredRunRequest } from "../jobs/types";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

/** The readiness id a compile's standing warnings are acknowledged under (restated from setupEvents.test.ts). */
const WARNINGS = "run/setup-warnings";
/** The surface prefix every engine refusal of a market's curve setup carries (Task 8 ruling 6), restated. */
const PREFIX = "The curve setup on this market: ";

const blocks = (id: string, rev: number, body: object) =>
  api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });

async function ready(id: string, marketId: string = SEED_IDS.market): Promise<WorkspaceManifest> {
  const created = await api(t.base, "POST", "/api/workspaces", { id, name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
  expect(created.status).toBe(201);
  await blocks(id, 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
  await blocks(id, 2, { block: "market", op: "set", ref: { collection: "market", id: marketId } });
  await blocks(id, 3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  const w = await blocks(id, 4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
  expect(w.status).toBe(201);
  return w.body;
}

/** The seeded market's own quotes restated as a setup (the engine's test helper), on the month-exact copy. */
function setupOf(interpolation: "log-linear-df" | "monotone-convex" | "linear-zero"): CurveSetupBlock {
  const market = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
  return { ...setupFromSnapshot(monthExactSnapshot(market).snapshot, interpolation), id: `seed-${interpolation}`, label: `Seed ${interpolation}` };
}

async function saveAndActivate(wsId: string, setup: unknown): Promise<{ id: string; revision: number }> {
  const h = (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${wsId}`)).body;
  const saved = await api<{ id: string; revision: number }>(t.base, "POST", `/api/workspaces/${wsId}/curve-setups`, { setup, expectedRevision: h.revision, by: "tester" });
  expect(saved.status).toBe(201);
  const act = await api<{ revision: number }>(t.base, "POST", `/api/workspaces/${wsId}/curve-setups/${saved.body.id}/activate`, { expectedRevision: saved.body.revision, by: "tester" });
  expect(act.status).toBe(200);
  return { id: saved.body.id, revision: act.body.revision };
}

function compile(wsId: string) {
  const wsStore = new WorkspaceStore(t.storeRoot);
  const head = wsStore.head(wsId);
  const slot = head.blocks.run.setups[0]!;
  const setup = store.getDocument<RunSetup>("run-setups", slot.current.id).doc;
  return compileSetupRow(t.platform.context, wsStore, head, slot, setup, null);
}

const curvesItem = (r: ReadinessReport) => r.items.find((i) => i.section === "market" && i.item === "Curves")!;
const readiness = async (wsId: string) => (await api<ReadinessReport>(t.base, "GET", `/api/workspaces/${wsId}/readiness`)).body;

describe("launch with an active curve setup", () => {
  it("pins the setup into a derived market whose snapshot carries curveSetup", async () => {
    await ready("ws-cl-pin");
    const { id: setupId } = await saveAndActivate("ws-cl-pin", setupOf("log-linear-df"));
    const storedSetup = store.getDocument<CurveSetupBlock>("curve-setups", setupId).doc;

    const row = compile("ws-cl-pin");
    const marketId = row.planDocument.inputs.marketSnapshot;
    expect(marketId).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    // One derived market in the store, on the block's base, carrying the setup document as its block.
    const pinned = store.getDocument<MarketSnapshot & { curveSetup?: unknown; derivedFrom?: { baseId: string; ops: unknown[] } }>("market", marketId).doc;
    expect(pinned.curveSetup).toEqual(storedSetup);
    expect(pinned.derivedFrom!.baseId).toBe(SEED_IDS.market);
    expect(pinned.derivedFrom!.ops).toEqual([{ op: "set-curve-setup", setup: storedSetup }]);
    // The consumed pins name the pinned market in the market role and the setup in its own role.
    expect(row.consumed.market).toEqual(expect.objectContaining({ collection: "market", id: marketId, contentHash: store.getMeta("market", marketId).contentHash }));
    expect(row.consumed.curveSetup).toEqual(expect.objectContaining({ collection: "curve-setups", id: setupId }));
    expect((row.request.marketSnapshot as { curveSetup?: unknown }).curveSetup).toEqual(storedSetup);
    // The pinned market is never listed in the market block.
    const head = new WorkspaceStore(t.storeRoot).head("ws-cl-pin");
    expect(head.blocks.market.derived).toEqual([]);

    // Idempotent: the same setup on the same market is the same id and the same bytes, never a 409.
    const metaBefore = store.getMeta("market", marketId);
    const again = compile("ws-cl-pin");
    expect(again.planDocument.inputs.marketSnapshot).toBe(marketId);
    expect(store.getMeta("market", marketId).contentHash).toBe(metaBefore.contentHash);
    expect(contentHash(again.request)).toBe(contentHash(row.request));

    // Validate records the same pins, and readiness reads the validation as current, not Stale.
    const v = await api<{ consumed: Record<string, { id: string }> }>(t.base, "POST", `/api/workspaces/ws-cl-pin/setups/${head.blocks.run.setups[0]!.setupLineageId}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.body.consumed.market!.id).toBe(marketId);
    expect(v.body.consumed.curveSetup!.id).toBe(setupId);
    const rd = await readiness("ws-cl-pin");
    const runSetups = rd.items.find((i) => i.section === "run" && i.item === "Run setups")!;
    // Slice three (decision 112): the Standard ALCO setup no longer warns, so a current validation reads Valid.
    expect(runSetups.state).toBe("valid");
    expect(curvesItem(rd).state).toBe("valid");
    expect(curvesItem(rd).detail).toBe(`The active curve setup "Seed log-linear-df" (${setupId}) builds the base curve: log-linear-df, ${storedSetup.inputs.length} rows.`);

    // A different active setup moves both pins: the validation now reads Stale in those two roles.
    await saveAndActivate("ws-cl-pin", setupOf("monotone-convex"));
    const stale = (await readiness("ws-cl-pin")).items.find((i) => i.section === "run" && i.item === "Run setups")!;
    expect(stale.state).toBe("stale");
    expect((stale.staleRoles ?? []).map((s) => s.role).sort()).toEqual(["curveSetup", "market"]);
  });

  it("pins on top of a derived market role too, keeping the derived market's own blocks", async () => {
    await ready("ws-cl-derived");
    const h = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-cl-derived")).body;
    const added = await blocks("ws-cl-derived", h.revision, { block: "market", op: "add", ref: { collection: "market", id: "rate-indices-demo-v1" } });
    expect(added.status).toBe(201);
    const wsStore = new WorkspaceStore(t.storeRoot);
    const head0 = wsStore.head("ws-cl-derived");
    const slot = head0.blocks.run.setups[0]!;
    const setup = store.getDocument<RunSetup>("run-setups", slot.current.id).doc;
    const onDerived: RunSetup = { ...setup, inputs: { ...setup.inputs, market: { role: "derived", definitionKey: "rate-indices-demo-v1" } } };
    const { id: setupId } = await saveAndActivate("ws-cl-derived", setupOf("log-linear-df"));
    const row = compileSetupRow(t.platform.context, wsStore, wsStore.head("ws-cl-derived"), slot, onDerived, null);
    const pinned = store.getDocument<{ curveSetup?: unknown; rateIndices?: unknown; derivedFrom: { baseId: string } }>("market", row.planDocument.inputs.marketSnapshot).doc;
    expect(pinned.derivedFrom.baseId).toBe("rate-indices-demo-v1");
    expect(pinned.rateIndices).toEqual(store.getDocument<{ rateIndices: unknown }>("market", "rate-indices-demo-v1").doc.rateIndices);
    expect(pinned.curveSetup).toEqual(store.getDocument("curve-setups", setupId).doc);
  });

  it("without an active setup the market id is unchanged and the request hash equals today's", async () => {
    const w = await ready("ws-cl-none");
    expect("curveSetups" in w.blocks.market).toBe(false);
    const today = compile("ws-cl-none");
    expect(today.planDocument.inputs.marketSnapshot).toBe(SEED_IDS.market);
    expect(Object.keys(today.consumed)).not.toContain("curveSetup");
    expect("curveSetup" in (today.request.marketSnapshot as object)).toBe(false);

    // A saved setup that is not active changes nothing a run reads.
    const saved = await api<{ id: string; revision: number }>(t.base, "POST", "/api/workspaces/ws-cl-none/curve-setups", { setup: setupOf("log-linear-df"), expectedRevision: w.revision, by: "tester" });
    expect(saved.status).toBe(201);
    const after = compile("ws-cl-none");
    expect(after.planDocument.inputs.marketSnapshot).toBe(SEED_IDS.market);
    expect(after.consumed.market).toEqual(today.consumed.market);
    expect(Object.keys(after.consumed).sort()).toEqual(Object.keys(today.consumed).sort());
    expect(contentHash(after.request)).toBe(contentHash(today.request));
    expect(after.planId).toBe(today.planId);
    expect(curvesItem(await readiness("ws-cl-none")).detail).toBe("The base curve builds from the snapshot: platform default v2, log-linear on discount factor.");
  });

  it("an active setup with no base market snapshot reads Not set and says a base market is needed first", async () => {
    const created = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id: "ws-cl-nobase", name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
    expect(created.status).toBe(201);
    expect(created.body.blocks.market.snapshot).toBeNull();
    const { id: setupId } = await saveAndActivate("ws-cl-nobase", setupOf("log-linear-df"));
    const item = curvesItem(await readiness("ws-cl-nobase"));
    expect(item.state).toBe("not-set");
    expect(item.detail).toBe(
      `The active curve setup "Seed log-linear-df" (${setupId}) needs a base market snapshot before it can be used. Attach a stored snapshot on Market > Yield curves.`,
    );
  });

  it("an active setup on a pinned base snapshot whose document is gone reads Not set, as the legacy branch does", async () => {
    // Review fix round 1 (M-1).
    const base = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    store.putDocument("market", "mk-cl-gonebase", base, { label: "base that goes away" });
    await ready("ws-cl-gonebase", "mk-cl-gonebase");
    const { id: setupId } = await saveAndActivate("ws-cl-gonebase", setupOf("log-linear-df"));
    const path = store.paths.documentPath("market", "mk-cl-gonebase");
    renameSync(path, `${path}.aside`);
    try {
      const item = curvesItem(await readiness("ws-cl-gonebase"));
      expect(item.state).toBe("not-set");
      expect(item.detail).toBe(`The active curve setup "Seed log-linear-df" (${setupId}) needs a readable base market snapshot before it can be used.`);
    } finally {
      renameSync(`${path}.aside`, path);
    }
    expect(curvesItem(await readiness("ws-cl-gonebase")).state).toBe("valid");
  });

  it("a missing active setup is a readiness error and never a silent legacy run", async () => {
    await ready("ws-cl-gone");
    const { id: setupId } = await saveAndActivate("ws-cl-gone", setupOf("log-linear-df"));
    const sentence = `The active curve setup ${setupId} is not in the store.`;
    const path = store.paths.documentPath("curve-setups", setupId);
    renameSync(path, `${path}.aside`);
    try {
      const rd = await readiness("ws-cl-gone");
      expect(curvesItem(rd).state).toBe("error");
      expect(curvesItem(rd).detail).toBe(sentence);
      const slot = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-cl-gone")).body.blocks.run.setups[0]!.setupLineageId;
      expect(rd.launchable[slot]!.blocking).toContain("market/Curves");

      expect(() => compile("ws-cl-gone")).toThrow(sentence);
      const l = await api<{ error: { message: string } }>(t.base, "POST", `/api/workspaces/ws-cl-gone/setups/${slot}/launch`, { by: "tester", acknowledge: [WARNINGS] });
      expect(l.status).toBe(422);
      expect(l.body.error.message).toBe(sentence);
      // Nothing ran: no attachment, no launch line.
      const wsStore = new WorkspaceStore(t.storeRoot);
      expect(wsStore.readRunAttachments("ws-cl-gone")).toEqual([]);
      expect(wsStore.readSetupEvents("ws-cl-gone").filter((e) => e.t === "launch")).toEqual([]);
    } finally {
      renameSync(`${path}.aside`, path);
    }
    expect(curvesItem(await readiness("ws-cl-gone")).state).toBe("valid");
  });

  it("a run launched on the pinned market builds its base curve from the setup, and the derived market and the run ingest into the database", async () => {
    await ready("ws-cl-run");
    const slot = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-cl-run")).body.blocks.run.setups[0]!.setupLineageId;
    const launch = async () => {
      const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/ws-cl-run/setups/${slot}/launch`, { by: "tester", acknowledge: [WARNINGS] });
      expect(l.status).toBe(200);
      const runId = l.body.runIds[0]!;
      const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
      expect(done.body.state).toBe("done");
      return runId;
    };
    type Rates = { base: { t: number[]; z: number[]; df: number[] } };

    // Legacy launch first: no setup, so the platform default (curve default 2 since B4, log-linear on DF).
    const legacyRun = await launch();
    const legacy = store.readRunJson<Rates>(legacyRun, "rates.json");

    // The setup is monotone-convex. A log-linear-df setup on the month-exact quotes is now the default itself and
    // equals the legacy launch at 10 years (was setupOf("log-linear-df") against the kernel bootstrap); deltas Step 1.
    const { id: setupId } = await saveAndActivate("ws-cl-run", setupOf("monotone-convex"));
    const setupRun = await launch();
    const req = store.readRunJson<StoredRunRequest>(setupRun, "request.json");
    const pinnedId = req.submission.marketId!;
    expect(pinnedId).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    const storedSetup = store.getDocument<CurveSetupBlock>("curve-setups", setupId).doc;
    // The stored request inlines the pinned market with its curveSetup key intact.
    expect((req.request.marketSnapshot as { curveSetup?: unknown }).curveSetup).toEqual(storedSetup);
    expect(req.workspace!.consumed.curveSetup!.id).toBe(setupId);

    // The run's own base curve is the engine builder's curve over the setup, node for node, bit for bit.
    const built = buildCurveFromSetup(storedSetup);
    const ran = store.readRunJson<Rates>(setupRun, "rates.json");
    expect(ran.base.t).toEqual(built.quoteTenors);
    ran.base.t.forEach((tYears, i) => expect(ran.base.z[i]).toBe(built.curve.zeroRate(tYears)));
    // And it is not the legacy (default) curve: at 10 years the two zero rates differ.
    const at = (r: Rates, tYears: number): number => r.base.z[r.base.t.findIndex((x) => Math.abs(x - tYears) < 1e-9)]!;
    expect(Number.isFinite(at(legacy, 10))).toBe(true);
    expect(Math.abs(at(ran, 10) - at(legacy, 10))).toBeGreaterThan(1e-9);

    // The database mirror holds the pinned market (it is a market document, so it mirrors) and the run's inputs name it.
    const mk = await waitFor(() => api<{ id: string }>(t.base, "GET", `/api/catalog/markets/${pinnedId}`), (r) => r.status === 200, 30_000);
    expect(mk.body.id).toBe(pinnedId);
    const inputs = await waitFor(
      () => api<{ inputs: Array<{ role: string; collection: string; id: string }> }>(t.base, "GET", `/api/catalog/runs/${setupRun}/inputs`),
      (r) => r.status === 200,
      30_000,
    );
    expect(inputs.body.inputs).toContainEqual(expect.objectContaining({ role: "market", collection: "market", id: pinnedId }));
  }, 600_000);
});

describe("engine refusals of a stored market's curve setup surface by name", () => {
  /** A setup that validates but cannot bootstrap: a futures price of 149.9 implies a rate below the solver's bracket. */
  const UNSOLVABLE = {
    id: "unsolvable", label: "Unsolvable", baseCurve: "SOFR", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual",
    inputs: [
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.0435 },
      { instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 149.9 },
    ],
  };

  it("the scenario preview answers 422 with the named prefix, not a 500", async () => {
    const base = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    store.putDocument("market", "mk-cl-unsolvable", { ...base, curveSetup: UNSOLVABLE }, { label: "unsolvable setup" });
    const r = await api<{ error: { code: string; message: string } }>(t.base, "POST", "/api/scenarios/preview", { marketSnapshot: "mk-cl-unsolvable", rateSpec: { kind: "parallel", shockBp: 100 } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.message.startsWith(PREFIX)).toBe(true);
    expect(r.body.error.message.length).toBeGreaterThan(PREFIX.length);
  });

  it("readiness names a base snapshot whose curve setup the engine refuses", async () => {
    const base = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    store.putDocument("market", "mk-cl-invalid", { ...base, curveSetup: { ...UNSOLVABLE, compounding: "continuous", inputs: [UNSOLVABLE.inputs[0]] } }, { label: "invalid setup" });
    await ready("ws-cl-badbase", "mk-cl-invalid");
    const item = curvesItem(await readiness("ws-cl-badbase"));
    expect(item.state).toBe("error");
    expect(item.detail.startsWith(PREFIX)).toBe(true);
    expect(item.detail).toContain("continuous compounding has no coupon schedule");
  });

  it("readiness names a base snapshot with no curve setup whose marker the engine refuses (B4 Tasks 3a and 5)", async () => {
    const base = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    store.putDocument("market", "mk-cl-marker-two", { ...base, curveDefault: 2 }, { label: "marker 2" });
    await ready("ws-cl-marker-two", "mk-cl-marker-two");
    const item = curvesItem(await readiness("ws-cl-marker-two"));
    expect(item.state).toBe("error");
    // The marker prefix (the prefix names the route that refused) and the engine's sentence, restated by hand.
    expect(item.detail).toBe(
      "The curveDefault marker on this market: The market's curveDefault is 2; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.",
    );
  });

  it("readiness reads a base snapshot marked curveDefault 1 as building on version 1 (B4 Tasks 3a and 8)", async () => {
    const base = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    store.putDocument("market", "mk-cl-marker-one", { ...base, curveDefault: 1 }, { label: "marked v1" });
    await ready("ws-cl-marker-one", "mk-cl-marker-one");
    const item = curvesItem(await readiness("ws-cl-marker-one"));
    expect(item.state).toBe("valid");
    expect(item.detail).toBe("The base curve builds from the snapshot: platform default v1, linear in zero (the market is marked curveDefault: 1).");
  });
});

// Task 8b (follow-on): deactivate returns a workspace to the legacy curve; a foreign-collection pointer refuses.
describe("deactivate and a foreign active pointer, Task 8b", () => {
  it("after deactivate a compile is byte-identical to the compile before any setup existed", async () => {
    await ready("ws-cl-deact");
    const before = compile("ws-cl-deact");
    expect(before.planDocument.inputs.marketSnapshot).toBe(SEED_IDS.market);
    const { revision } = await saveAndActivate("ws-cl-deact", setupOf("log-linear-df"));
    expect(compile("ws-cl-deact").planDocument.inputs.marketSnapshot).toMatch(/^derived-mk-/);
    const de = await api<{ revision: number }>(t.base, "POST", "/api/workspaces/ws-cl-deact/curve-setups/deactivate", { expectedRevision: revision, by: "tester" });
    expect(de.status).toBe(200);
    const after = compile("ws-cl-deact");
    expect(after.planDocument.inputs.marketSnapshot).toBe(SEED_IDS.market);
    expect(after.consumed.market).toEqual(before.consumed.market);
    expect(Object.keys(after.consumed).sort()).toEqual(Object.keys(before.consumed).sort());
    expect("curveSetup" in (after.request.marketSnapshot as object)).toBe(false);
    expect(contentHash(after.request)).toBe(contentHash(before.request));
    expect(after.planId).toBe(before.planId);
    expect(curvesItem(await readiness("ws-cl-deact")).detail).toBe("The base curve builds from the snapshot: platform default v2, log-linear on discount factor.");
  });

  it("an active pointer to a document in a foreign collection is the readiness error and refuses the compile", async () => {
    const w = await ready("ws-cl-foreign");
    const wsStore = new WorkspaceStore(t.storeRoot);
    const marketRef = { collection: "market" as const, id: SEED_IDS.market, contentHash: store.getMeta("market", SEED_IDS.market).contentHash, pinnedAt: "2026-10-12T00:00:00.000Z" };
    wsStore.commit("ws-cl-foreign", w.revision, "tester", { kind: "set-block", block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } }, {
      ...w,
      blocks: { ...w.blocks, market: { ...w.blocks.market, curveSetups: { setups: [{ lineageKey: "foreign", current: marketRef }], active: SEED_IDS.market } } },
    });
    const sentence = `The active curve setup ${SEED_IDS.market} is not in the store.`;
    const item = curvesItem(await readiness("ws-cl-foreign"));
    expect(item.state).toBe("error");
    expect(item.detail).toBe(sentence);
    expect(() => compile("ws-cl-foreign")).toThrow(sentence);
  });
});
