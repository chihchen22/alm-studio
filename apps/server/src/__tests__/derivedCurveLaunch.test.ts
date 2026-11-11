// apps/server/src/__tests__/derivedCurveLaunch.test.ts
// The launch pin of derived curves. The compile pins every saved curve an
// index of the run's market names into ONE derived market (beside the active curve setup, in the same
// derive); a saved curve no index names changes nothing a run reads; a missing curve or a curve built on
// another base is a readiness error and a 422 at launch, in the engine's own sentences,
// restated here by hand. Mirrors curveSetupLaunch.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurveSetupBlock, DerivedCurveBlock } from "@alm/engine";
import { monthExactSnapshot, setupFromSnapshot } from "@alm/engine/src/curveBuilder/__tests__/helpers";
import { deriveMarketSnapshot } from "@alm/engine/src/market";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import type { MarketSnapshot } from "@alm/kernel";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { derivedMarketMeta } from "../derivedSets/derivedMarkets";
import { FileStore } from "../store/store";
import { compileSetupRow } from "../workspaces/setupCompile";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { derivedCurveIdOf } from "../workspaces/derivedCurveSlot";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import type { ReadinessReport } from "../workspaces/readiness";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

const WARNINGS = "run/setup-warnings";

const blocks = (id: string, rev: number, body: object) =>
  api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });

/**
 * A workspace on the seeded base snapshot. `derived` markets are added to the market block in order
 * (each must derive from the snapshot or an earlier entry); `use` re-saves the run setup so its market
 * input names that derived market by its definitionKey.
 */
async function ready(id: string, opts: { derived?: string[]; use?: string; book?: string; base?: string } = {}): Promise<WorkspaceManifest> {
  const created = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id, name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
  expect(created.status).toBe(201);
  let w = created.body;
  const step = async (body: object) => {
    const r = await blocks(id, w.revision, body);
    expect(r.status).toBe(201);
    w = r.body;
  };
  await step({ block: "positions", op: "set", ref: { collection: "portfolios", id: opts.book ?? SEED_IDS.vanillaPortfolio } });
  await step({ block: "market", op: "set", ref: { collection: "market", id: opts.base ?? SEED_IDS.market } });
  for (const d of opts.derived ?? []) await step({ block: "market", op: "add", ref: { collection: "market", id: d } });
  await step({ block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  await step({ block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
  if (opts.use !== undefined) {
    const slot = w.blocks.run.setups[0]!;
    const current = store.getDocument<RunSetup>("run-setups", slot.current.id).doc;
    const { id: _drop, ...rest } = current;
    void _drop;
    const setup = { ...rest, inputs: { ...rest.inputs, market: { role: "derived", definitionKey: opts.use } } };
    const r = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", { workspaceId: id, setupLineageId: slot.setupLineageId, expectedRevision: w.revision, by: "tester", setup });
    expect(r.status).toBe(201);
    w = r.body.manifest;
  }
  return w;
}

/**
 * A market whose index names a derived curve, stored under a test id: derived from `baseId` by the
 * engine's own derive. `index` is restated on the seeded three-month index (seed-store.ts RATE_INDEX_DEMO_OPS).
 */
function indexedMarket(id: string, baseId: string, index: { id: string; tenorMonths: number }, spreadCurve: string): string {
  const base = store.getDocument<MarketSnapshot>("market", baseId).doc;
  const r = deriveMarketSnapshot(base, [{ op: "set-index", id: index.id, label: `${index.id} (test index)`, tenorMonths: index.tenorMonths, basisBp: 0, spreadCurve }], { baseId, id });
  store.putDocument("market", id, r.snapshot, derivedMarketMeta(r));
  return id;
}

function setupOf(): CurveSetupBlock {
  const market = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
  return { ...setupFromSnapshot(monthExactSnapshot(market).snapshot, "log-linear-df"), id: "seed-log-linear-df", label: "Seed log-linear-df" };
}

const curveOn = (base: string, id = "sofr-ust"): DerivedCurveBlock => ({
  id,
  label: "SOFR over UST",
  base,
  spreads: [{ tenorMonths: 1, spreadBp: 5 }, { tenorMonths: 12, spreadBp: 10 }],
});

const headOf = async (wsId: string) => (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${wsId}`)).body;

async function saveCurve(wsId: string, curve: DerivedCurveBlock): Promise<string> {
  const h = await headOf(wsId);
  const r = await api<{ id: string }>(t.base, "POST", `/api/workspaces/${wsId}/derived-curves`, { curve, expectedRevision: h.revision, by: "tester" });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function saveAndActivateSetup(wsId: string): Promise<string> {
  const h = await headOf(wsId);
  const saved = await api<{ id: string; revision: number }>(t.base, "POST", `/api/workspaces/${wsId}/curve-setups`, { setup: setupOf(), expectedRevision: h.revision, by: "tester" });
  expect(saved.status).toBe(201);
  const act = await api(t.base, "POST", `/api/workspaces/${wsId}/curve-setups/${saved.body.id}/activate`, { expectedRevision: saved.body.revision, by: "tester" });
  expect(act.status).toBe(200);
  return saved.body.id;
}

function compile(wsId: string) {
  const wsStore = new WorkspaceStore(t.storeRoot);
  const head = wsStore.head(wsId);
  const slot = head.blocks.run.setups[0]!;
  const setup = store.getDocument<RunSetup>("run-setups", slot.current.id).doc;
  return compileSetupRow(t.platform.context, wsStore, head, slot, setup, null);
}

const readiness = async (wsId: string) => (await api<ReadinessReport>(t.base, "GET", `/api/workspaces/${wsId}/readiness`)).body;
const ratesItem = (r: ReadinessReport) => r.items.find((i) => i.section === "market" && i.item === "Rate indices and derived markets")!;
const slotOf = async (wsId: string) => (await headOf(wsId)).blocks.run.setups[0]!.setupLineageId;
const launch = async (wsId: string) =>
  api<{ error: { message: string } }>(t.base, "POST", `/api/workspaces/${wsId}/setups/${await slotOf(wsId)}/launch`, { by: "tester", acknowledge: [WARNINGS] });

type Pinned = MarketSnapshot & { derivedCurves?: unknown; curveSetup?: unknown; derivedFrom?: { baseId: string; ops: Array<{ op: string }> } };

describe("launch with saved derived curves", () => {
  it("a saved curve no index names changes nothing a run reads: market id, consumed, request hash and planId", async () => {
    await ready("ws-dl-none");
    const today = compile("ws-dl-none");
    await saveCurve("ws-dl-none", curveOn("platform-default"));
    const after = compile("ws-dl-none");
    expect(after.planDocument.inputs.marketSnapshot).toBe(SEED_IDS.market);
    expect(after.consumed.market).toEqual(today.consumed.market);
    expect(Object.keys(after.consumed).sort()).toEqual(Object.keys(today.consumed).sort());
    expect(contentHash(after.request)).toBe(contentHash(today.request));
    expect(after.planId).toBe(today.planId);
    expect("derivedCurves" in (after.request.marketSnapshot as object)).toBe(false);
  });

  it("pins the curve an index names into a derived market carrying derivedCurves, and lists the derivedCurve role", async () => {
    const marketId = indexedMarket("mk-dl-pin", SEED_IDS.market, { id: "sofr-3m", tenorMonths: 3 }, "sofr-ust");
    await ready("ws-dl-pin", { derived: [marketId], use: marketId });
    const docId = await saveCurve("ws-dl-pin", curveOn("platform-default"));
    const stored = store.getDocument<DerivedCurveBlock>("derived-curves", docId).doc;

    const row = compile("ws-dl-pin");
    const pinnedId = row.planDocument.inputs.marketSnapshot;
    expect(pinnedId).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    const pinned = store.getDocument<Pinned>("market", pinnedId).doc;
    expect(pinned.derivedCurves).toEqual([stored]);
    expect(pinned.derivedFrom!.baseId).toBe(marketId);
    expect(pinned.derivedFrom!.ops).toEqual([{ op: "set-derived-curve", curve: stored }]);
    expect((row.request.marketSnapshot as Pinned).derivedCurves).toEqual([stored]);
    expect(row.consumed.market).toEqual(expect.objectContaining({ collection: "market", id: pinnedId }));
    expect(row.consumed["derivedCurve:sofr-ust"]).toEqual(expect.objectContaining({ collection: "derived-curves", id: docId }));
    expect(Object.keys(row.consumed)).not.toContain("curveSetup");

    // Idempotent, and a validation at these pins reads as current, not Stale.
    expect(compile("ws-dl-pin").planDocument.inputs.marketSnapshot).toBe(pinnedId);
    const v = await api<{ consumed: Record<string, { id: string }> }>(t.base, "POST", `/api/workspaces/ws-dl-pin/setups/${await slotOf("ws-dl-pin")}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.body.consumed["derivedCurve:sofr-ust"]!.id).toBe(docId);
    const runSetups = (await readiness("ws-dl-pin")).items.find((i) => i.section === "run" && i.item === "Run setups")!;
    expect(runSetups.state).not.toBe("stale");

    // An edit of the curve moves the role: the validation now reads Stale in it and in the market role.
    await saveCurve("ws-dl-pin", { ...curveOn("platform-default"), spreads: [{ tenorMonths: 3, spreadBp: 9 }] });
    const stale = (await readiness("ws-dl-pin")).items.find((i) => i.section === "run" && i.item === "Run setups")!;
    expect(stale.state).toBe("stale");
    expect((stale.staleRoles ?? []).map((s) => s.role).sort()).toEqual(["derivedCurve:sofr-ust", "market"]);
  });

  it("with an active curve setup, one derive carries both the curveSetup and the derivedCurves blocks", async () => {
    const marketId = indexedMarket("mk-dl-both", SEED_IDS.market, { id: "sofr-3m", tenorMonths: 3 }, "sofr-ust");
    await ready("ws-dl-both", { derived: [marketId], use: marketId });
    const setupDocId = await saveAndActivateSetup("ws-dl-both");
    const docId = await saveCurve("ws-dl-both", curveOn("seed-log-linear-df"));
    const row = compile("ws-dl-both");
    const pinned = store.getDocument<Pinned>("market", row.planDocument.inputs.marketSnapshot).doc;
    expect(pinned.derivedFrom!.baseId).toBe(marketId);
    expect(pinned.derivedFrom!.ops.map((o) => o.op)).toEqual(["set-curve-setup", "set-derived-curve"]);
    expect(pinned.curveSetup).toEqual(store.getDocument("curve-setups", setupDocId).doc);
    const curves = pinned.derivedCurves as DerivedCurveBlock[];
    expect(curves).toEqual([store.getDocument("derived-curves", docId).doc]);
    expect(curves[0]!.base).toBe((pinned.curveSetup as CurveSetupBlock).id);
    expect(row.consumed.curveSetup!.id).toBe(setupDocId);
    expect(row.consumed["derivedCurve:sofr-ust"]!.id).toBe(docId);
  });
});

// A curve estimated on platform default version n, read by a run whose
// default is version m, is a Warning on the rates item when n and m differ. An unstamped curve whose source
// names platform-default was estimated before the stamp existed, on version 1. Nothing changes by itself:
// the warning is acknowledged at launch like the index history one, and the run reads the saved spreads.
describe("the platform default a derived curve was estimated on, in readiness and at launch", () => {
  const RFR_3M = { id: "rfr-3m", tenorMonths: 3 };
  const RATES = "market/Rate indices and derived markets";
  const CLOSE = " Nothing was changed: acknowledge the warning to launch on the saved spreads, or fill the curve again on Market > Derived curves and save it.";
  const filled = (extra: object = {}): DerivedCurveBlock => ({ ...curveOn("platform-default"), source: { from: "platform-default", minus: "seed-log-linear-df" }, ...extra });

  /** A curve written to the store and the slot directly, as a block stored before the stamp existed. */
  function plantCurve(wsId: string, block: DerivedCurveBlock): string {
    const id = derivedCurveIdOf(block);
    const meta = store.has("derived-curves", id) ? store.getMeta("derived-curves", id) : store.putDocument("derived-curves", id, block, { label: block.label, workspaceId: wsId });
    const wsStore = new WorkspaceStore(t.storeRoot);
    const h = wsStore.head(wsId);
    const slot = { lineageKey: block.id, current: { collection: "derived-curves" as const, id, contentHash: meta.contentHash, pinnedAt: new Date().toISOString() } };
    wsStore.commit(wsId, h.revision, "tester", { kind: "set-block", block: "market", op: "add", ref: { collection: "derived-curves", id }, derivedCurve: "edit" }, {
      ...h,
      blocks: { ...h.blocks, market: { ...h.blocks.market, derivedCurves: { curves: [slot] } } },
    });
    return id;
  }

  /** The seeded rate-index market's own ops derived anew on `baseId`, stored as `id`, with the curveDefault marker set to `marker` or removed. */
  function indicesOn(id: string, baseId: string, marker: 1 | null): string {
    const rim = store.getDocument<Pinned>("market", SEED_IDS.rateIndexMarket).doc;
    const r = deriveMarketSnapshot(store.getDocument<MarketSnapshot>("market", baseId).doc, rim.derivedFrom!.ops as never, { baseId, id });
    const { curveDefault: _m, ...rest } = r.snapshot as MarketSnapshot & { curveDefault?: unknown };
    void _m;
    store.putDocument("market", id, marker === null ? rest : { ...rest, curveDefault: marker }, derivedMarketMeta(r));
    return id;
  }
  /** Launch with `acknowledge`, wait for the run, and answer its id once it is done. */
  async function launchDone(wsId: string, acknowledge: string[]): Promise<string> {
    const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/${wsId}/setups/${await slotOf(wsId)}/launch`, { by: "tester", acknowledge });
    expect(l.status, l.text).toBe(200);
    const runId = l.body.runIds[0]!;
    const done = await waitFor(() => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 480_000);
    expect(done.body).toEqual(expect.objectContaining({ state: "done" }));
    return runId;
  }
  const MARKED_BASE = "mk-dl-marked-base";
  beforeAll(() => {
    store.putDocument("market", MARKED_BASE, { ...store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc, curveDefault: 1 }, { label: "marked base" });
  });

  it("a curve estimated on a base market of v1 warns when the run's market builds v2 (the run's default, not the base's), and a stamped curve launches", async () => {
    const indices = indicesOn("mk-dl-idx-unmarked", MARKED_BASE, null);
    const marketId = indexedMarket("mk-dl-stamp", indices, RFR_3M, "sofr-ust");
    await ready("ws-dl-stamp", { base: MARKED_BASE, derived: [indices, marketId], use: marketId, book: SEED_IDS.indexedPortfolio });
    const docId = await saveCurve("ws-dl-stamp", filled());
    const stamped = store.getDocument<DerivedCurveBlock>("derived-curves", docId).doc;
    expect(stamped).toEqual({ ...filled(), estimatedOnDefault: 1 });
    const item = ratesItem(await readiness("ws-dl-stamp"));
    expect(item.state).toBe("warning");
    expect(item.detail).toBe(`Derived curve "sofr-ust" was estimated on platform default v1; the run's default is v2.${CLOSE}`);
    expect((await readiness("ws-dl-stamp")).launchable[await slotOf("ws-dl-stamp")]!.acknowledgeable).toContain(RATES);

    // The stamped curve rides the pin as stored and the acknowledged run completes.
    const row = compile("ws-dl-stamp");
    expect(store.getDocument<Pinned>("market", row.planDocument.inputs.marketSnapshot).doc.derivedCurves).toEqual([stamped]);
    await launchDone("ws-dl-stamp", [WARNINGS, RATES]);
  }, 600_000);

  it("a curve estimated on v2 and read by a run on v2 reads Valid", async () => {
    const marketId = indexedMarket("mk-dl-same", SEED_IDS.rateIndexMarket, RFR_3M, "sofr-ust");
    await ready("ws-dl-same", { derived: [SEED_IDS.rateIndexMarket, marketId], use: marketId, book: SEED_IDS.indexedPortfolio });
    const docId = await saveCurve("ws-dl-same", filled());
    expect(store.getDocument<DerivedCurveBlock>("derived-curves", docId).doc.estimatedOnDefault).toBe(2);
    const quiet = ratesItem(await readiness("ws-dl-same"));
    expect(quiet.state).toBe("valid");
    expect(quiet.detail).toBe("Every rate index a position names resolves on the setup's market.");
  });

  it("a curve estimated on an unmarked base (v2) warns when the run's market carries curveDefault 1", async () => {
    const indices = indicesOn("mk-dl-idx-marked", SEED_IDS.market, 1);
    const marketId = indexedMarket("mk-dl-runv1", indices, RFR_3M, "sofr-ust");
    expect((store.getDocument<Pinned>("market", marketId).doc as { curveDefault?: unknown }).curveDefault).toBe(1);
    await ready("ws-dl-runv1", { derived: [indices, marketId], use: marketId, book: SEED_IDS.indexedPortfolio });
    const docId = await saveCurve("ws-dl-runv1", filled());
    expect(store.getDocument<DerivedCurveBlock>("derived-curves", docId).doc.estimatedOnDefault).toBe(2);
    const item = ratesItem(await readiness("ws-dl-runv1"));
    expect(item.state).toBe("warning");
    expect(item.detail).toBe(`Derived curve "sofr-ust" was estimated on platform default v2; the run's default is v1.${CLOSE}`);
  });

  it("a typed grid on platform-default is never warned about", async () => {
    const marketId = indexedMarket("mk-dl-typed", SEED_IDS.rateIndexMarket, RFR_3M, "sofr-ust");
    await ready("ws-dl-typed", { derived: [SEED_IDS.rateIndexMarket, marketId], use: marketId, book: SEED_IDS.indexedPortfolio });
    plantCurve("ws-dl-typed", curveOn("platform-default"));
    expect(ratesItem(await readiness("ws-dl-typed")).state).toBe("valid");
  });

  it("a stored curve without the stamp still derives and launches: it reads as estimated on v1, the warning is acknowledged like the history one", async () => {
    const marketId = indexedMarket("mk-dl-old", SEED_IDS.rateIndexMarket, RFR_3M, "sofr-ust");
    await ready("ws-dl-old", { derived: [SEED_IDS.rateIndexMarket, marketId], use: marketId, book: SEED_IDS.indexedPortfolio });
    const old = filled();
    expect("estimatedOnDefault" in old).toBe(false);
    const docId = plantCurve("ws-dl-old", old);

    const item = ratesItem(await readiness("ws-dl-old"));
    expect(item.state).toBe("warning");
    expect(item.detail).toBe(`Derived curve "sofr-ust" was estimated on platform default v1; the run's default is v2.${CLOSE}`);

    // The pin carries the stored block as it stands, no stamp added.
    const row = compile("ws-dl-old");
    const pinned = store.getDocument<Pinned>("market", row.planDocument.inputs.marketSnapshot).doc;
    expect(pinned.derivedCurves).toEqual([old]);
    expect(row.consumed["derivedCurve:sofr-ust"]!.id).toBe(docId);

    // Without the rates item acknowledged, the launch asks for it by id; acknowledged, the run completes.
    const blocked = await launch("ws-dl-old");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain(`"${RATES}"`);
    await launchDone("ws-dl-old", [WARNINGS, RATES]);
    expect(store.getDocument<DerivedCurveBlock>("derived-curves", docId).doc).toEqual(old);

    // The list reads it back as v1, and a GET-to-POST round trip neither writes a document nor clears the warning.
    const listed = (await api<{ curves: Array<Record<string, unknown>> }>(t.base, "GET", "/api/workspaces/ws-dl-old/derived-curves")).body.curves[0]!;
    expect(listed.estimatedOnDefault).toBe(1);
    const got = (await api<DerivedCurveBlock>(t.base, "GET", `/api/derived-curves/${docId}`)).body;
    const h = await headOf("ws-dl-old");
    const count = store.listMeta("derived-curves").length;
    const back = await api<{ id: string; revision: number }>(t.base, "POST", "/api/workspaces/ws-dl-old/derived-curves", { curve: got, expectedRevision: h.revision, by: "tester" });
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ id: docId, revision: h.revision });
    expect(store.listMeta("derived-curves").length).toBe(count);
    expect(ratesItem(await readiness("ws-dl-old")).detail).toBe(`Derived curve "sofr-ust" was estimated on platform default v1; the run's default is v2.${CLOSE}`);
  }, 600_000);
});

describe("derived curve refusals in readiness and at launch", () => {
  /** The three-month index the seeded indexed book reads (seed-store.ts INDEXED_FLOATERS: floating-loans-1). */
  const RFR_3M = { id: "rfr-3m", tenorMonths: 3 };

  it("a curve built on platform-default refuses once a setup is activated, naming both ids, with the re-save hint", async () => {
    const marketId = indexedMarket("mk-dl-base", SEED_IDS.rateIndexMarket, RFR_3M, "sofr-ust");
    await ready("ws-dl-base", { derived: [SEED_IDS.rateIndexMarket, marketId], use: marketId, book: SEED_IDS.indexedPortfolio });
    await saveCurve("ws-dl-base", curveOn("platform-default"));
    expect(ratesItem(await readiness("ws-dl-base")).state).toBe("valid");

    await saveAndActivateSetup("ws-dl-base");
    const sentence = `rate index "rfr-3m" reads derived curve "sofr-ust", built on "platform-default", but the run's curve is "seed-log-linear-df"`;
    const item = ratesItem(await readiness("ws-dl-base"));
    expect(item.state).toBe("error");
    expect(item.detail).toBe(
      `${sentence}. Save the derived curve again on the run's curve on Market > Derived curves, or change the active curve setup on Market > Curve setups.`,
    );
    const l = await launch("ws-dl-base");
    expect(l.status).toBe(422);
    expect(l.body.error.message).toContain(sentence);
    expect(new WorkspaceStore(t.storeRoot).readRunAttachments("ws-dl-base")).toEqual([]);
  });

  it("an index naming a curve the workspace does not hold names the curve and the index, with the save hint", async () => {
    const marketId = indexedMarket("mk-dl-nope", SEED_IDS.rateIndexMarket, RFR_3M, "nope");
    await ready("ws-dl-nope", { derived: [SEED_IDS.rateIndexMarket, marketId], use: marketId, book: SEED_IDS.indexedPortfolio });
    const sentence = `rate index "rfr-3m" reads derived curve "nope", which market "mk-dl-nope" does not carry`;
    const item = ratesItem(await readiness("ws-dl-nope"));
    expect(item.state).toBe("error");
    expect(item.detail).toBe(`${sentence}. Save a derived curve under that id on Market > Derived curves.`);
    const l = await launch("ws-dl-nope");
    expect(l.status).toBe(422);
    expect(l.body.error.message).toContain(sentence);
  });

  it("an index the market does not carry keeps today's hint, and a derived market that carries the index counts as a carrier even when it lacks the curve", async () => {
    // The vanilla market carries no index, so every indexed floater's index is missing.
    const carrier = indexedMarket("mk-dl-carrier", SEED_IDS.rateIndexMarket, RFR_3M, "not-saved");
    await ready("ws-dl-index", { book: SEED_IDS.indexedPortfolio });
    const none = ratesItem(await readiness("ws-dl-index"));
    expect(none.state).toBe("error");
    expect(none.detail).toMatch(/^position "floating-loans-0" names rate index "rfr-1m", which market "market-public-2026-03-31" does not carry \(it carries none\) \(3 problems\)\. No derived market in the block carries them\.$/);

    const h = await headOf("ws-dl-index");
    const parent = await blocks("ws-dl-index", h.revision, { block: "market", op: "add", ref: { collection: "market", id: SEED_IDS.rateIndexMarket } });
    expect(parent.status).toBe(201);
    expect((await blocks("ws-dl-index", parent.body.revision, { block: "market", op: "add", ref: { collection: "market", id: carrier } })).status).toBe(201);
    const hinted = ratesItem(await readiness("ws-dl-index"));
    expect(hinted.detail).toMatch(/\(3 problems\)\. The market block holds rate-indices-demo-v1, mk-dl-carrier, which carries the indices: point the setup's market at it on Run > Setups\.$/);
  });
});
