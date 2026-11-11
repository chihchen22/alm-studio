// apps/server/src/__tests__/indexKindsServer.test.ts
// The server routes on the new rate index kinds, end to end. The derive route stores a
// formula index in the one record shape; the preview refuses a parent loop by name; a roll-forward clone re-applies
// a formula market on its re-applied parent; a Studio-style launch on a formula market completes with the
// Informational note and the same numbers as the compounded window it restates; and a constant-maturity-swap index
// that names a derived curve pins that curve at launch. Helpers are copied from workspaceClone.test.ts and
// derivedCurveLaunch.test.ts. Every expected value and sentence is restated by hand; none is read back from the code
// under test.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DerivedCurveBlock } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import type { RunStatus, StoredRunRequest } from "../jobs/types";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

/** Seeded ids, restated as literals (seed-store.ts SEED_IDS). */
const PUBLIC = "market-public-2026-03-31";
const INDICES = "rate-indices-demo-v1";
const INDEXED_BOOK = "synthetic-2500-indexed-v1";
const PLAIN_BOOK = "synthetic-2500-v1";
/** The market Item 1 saves and Items 3 and 4 read. */
const FORMULA_ID = "b3a-prime-formula-v1";
/** The readiness id a compile's standing warnings are acknowledged under (restated from setupEvents.test.ts). */
const WARNINGS = "run/setup-warnings";

const ws = (id: string) => api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`);
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", ...body });
const blocks = (id: string, rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });
const clone = (id: string, rev: number, body: object) => api<{ manifest: WorkspaceManifest; readiness: unknown }>(t.base, "POST", `/api/workspaces/${id}/clone`, { expectedRevision: rev, by: "tester", ...body });
const reapply = (id: string, rev: number) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/market/reapply`, { expectedRevision: rev, by: "tester" });

const PRIME_AS_FORMULA = { op: "set-index", id: "prime-demo", label: "Prime-style rate as a formula on the one-month rate (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, basisBp: 300 };
const derive = (body: object) => api<{ id: string; snapshot: { rateIndices: unknown[]; derivedFrom: { ops: unknown[] } } }>(t.base, "POST", "/api/market/derive", body);

interface Problem { at: string; message: string }
interface ErrBody { error: { code: string; message: string; detail?: { problems?: Problem[] } } }
type IndexRecord = Record<string, unknown> & { id: string };
type StoredMarket = { rateIndices?: IndexRecord[]; derivedCurves?: DerivedCurveBlock[]; derivedFrom?: { baseId: string } };
type Note = { layer: string; reason: string };
type Result = Record<string, unknown> & { provenance: unknown; notImplemented: Note[] };

const indicesOf = (marketId: string): IndexRecord[] => store.getDocument<StoredMarket>("market", marketId).doc.rateIndices ?? [];
const indexOf = (marketId: string, indexId: string): IndexRecord => indicesOf(marketId).find((r) => r.id === indexId)!;

/** Items 3 and 4 need the formula market; a re-save of the same bytes answers 200 unchanged. */
async function formulaMarket(): Promise<string> {
  const r = await derive({ baseId: INDICES, ops: [PRIME_AS_FORMULA], id: FORMULA_ID });
  expect([200, 201]).toContain(r.status);
  return FORMULA_ID;
}

/**
 * A workspace on the public snapshot (derivedCurveLaunch.test.ts `ready`). `derived` markets are added in order
 * (each derives from the snapshot or an earlier entry); `use` re-saves the run setup so its market input names that
 * derived market by its definitionKey.
 */
async function ready(id: string, opts: { derived?: string[]; use?: string; book?: string } = {}): Promise<WorkspaceManifest> {
  const created = await create({ id });
  expect(created.status).toBe(201);
  let w = created.body;
  const step = async (body: object) => {
    const r = await blocks(id, w.revision, body);
    expect(r.status).toBe(201);
    w = r.body;
  };
  await step({ block: "positions", op: "set", ref: { collection: "portfolios", id: opts.book ?? SEED_IDS.vanillaPortfolio } });
  await step({ block: "market", op: "set", ref: { collection: "market", id: PUBLIC } });
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

const slotOf = async (wsId: string) => (await ws(wsId)).body.blocks.run.setups[0]!.setupLineageId;

/** Launch the workspace's first setup, wait for the run, and answer its id once it is done. */
async function launchDone(wsId: string): Promise<string> {
  const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/${wsId}/setups/${await slotOf(wsId)}/launch`, { by: "tester", acknowledge: [WARNINGS] });
  expect(l.status).toBe(200);
  const runId = l.body.runIds[0]!;
  const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 480_000);
  expect(done.body).toEqual(expect.objectContaining({ state: "done" }));
  return runId;
}

/** Everything a run computed: the result with the run's own stamps and its notes taken out. */
function numbers(r: Result): Record<string, unknown> {
  const { provenance: _p, notImplemented: _n, ...rest } = r;
  void _p;
  void _n;
  return rest;
}

describe("derive routes on the new kinds", () => {
  it("saves prime-demo as a formula on rfr-1m in the record's key order and leaves the windows byte-identical", async () => {
    const r = await derive({ baseId: INDICES, ops: [PRIME_AS_FORMULA], id: FORMULA_ID });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(FORMULA_ID);

    const doc = new FileStore(t.storeRoot).getDocument<StoredMarket>("market", FORMULA_ID).doc;
    const prime = doc.rateIndices!.find((x) => x.id === "prime-demo")!;
    expect(prime).toEqual({
      id: "prime-demo",
      label: "Prime-style rate as a formula on the one-month rate (demonstration values)",
      kind: "formula",
      parent: "rfr-1m",
      coefficient: 1,
      basis: 0.03,
    });
    expect(Object.keys(prime)).toEqual(["id", "label", "kind", "parent", "coefficient", "basis"]);

    // The two windows are carried as the seeded market holds them, byte for byte, and never carry kind.
    for (const id of ["rfr-1m", "rfr-3m"]) {
      expect(JSON.stringify(indexOf(FORMULA_ID, id))).toBe(JSON.stringify(indexOf(INDICES, id)));
    }
    expect(JSON.stringify(indexOf(FORMULA_ID, "rfr-1m"))).toBe('{"id":"rfr-1m","label":"One-month benchmark rate (demonstration index)","tenorMonths":1,"basis":0}');
    expect(JSON.stringify(indexOf(FORMULA_ID, "rfr-3m"))).toBe('{"id":"rfr-3m","label":"Three-month benchmark term rate (demonstration index)","tenorMonths":3,"basis":0}');
  });

  it("a parent loop is a 422 on preview, named in the engine's sentence", async () => {
    const loopOp = { op: "set-index", id: "rfr-1m", label: "x", kind: "formula", parent: "prime-demo", coefficient: 1, basisBp: 0 };
    const r = await api<ErrBody>(t.base, "POST", "/api/market/derive/preview", { baseId: INDICES, ops: [PRIME_AS_FORMULA, loopOp] });
    expect(r.status).toBe(422);
    expect(r.body.error.detail!.problems!.map((p) => p.message)).toContain(
      "rateIndices: rate indices form a loop: prime-demo -> rfr-1m -> prime-demo; a formula's parent chain must end at a compounded-window or constant-maturity-swap index",
    );
  });
});

describe("roll-forward re-apply on a formula market", () => {
  it("re-applies the parent then the formula child on the new snapshot; the child's indices equal the source's", async () => {
    await formulaMarket();
    expect((await create({ id: "ws-ik-roll" })).status).toBe(201);
    await blocks("ws-ik-roll", 1, { block: "market", op: "set", ref: { collection: "market", id: PUBLIC } });
    await blocks("ws-ik-roll", 2, { block: "market", op: "add", ref: { collection: "market", id: INDICES } });
    await blocks("ws-ik-roll", 3, { block: "market", op: "add", ref: { collection: "market", id: FORMULA_ID } });
    const src = (await ws("ws-ik-roll")).body;
    expect(src.blocks.market.derived.map((d) => [d.definitionKey, d.parentKey])).toEqual([[INDICES, null], [FORMULA_ID, INDICES]]);

    const r = await clone("ws-ik-roll", src.revision, { mode: "roll-forward", name: "April", cutoffDate: "2026-04-30", blocks: ["market"] });
    expect(r.status).toBe(201);
    const c = r.body.manifest;
    expect(c.blocks.market.carried.map((e) => [e.definitionKey, e.parentKey, e.status])).toEqual([
      [INDICES, null, "awaiting"],
      [FORMULA_ID, INDICES, "awaiting"],
    ]);

    const set = await blocks(c.id, c.revision, { block: "market", op: "set", ref: { collection: "market", id: PUBLIC } });
    expect(set.status).toBe(201);
    const re = await reapply(c.id, set.body.revision);
    expect(re.status).toBe(200);
    const carried = re.body.blocks.market.carried;
    expect(carried.map((e) => [e.definitionKey, e.status])).toEqual([[INDICES, "applied"], [FORMULA_ID, "applied"]]);

    const parent = re.body.blocks.market.derived.find((d) => d.definitionKey === INDICES)!;
    const child = re.body.blocks.market.derived.find((d) => d.definitionKey === FORMULA_ID)!;
    expect(child.id).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    expect(child.parentKey).toBe(INDICES);
    expect(carried.find((e) => e.definitionKey === FORMULA_ID)!.appliedId).toBe(child.id);
    // The child derives on its parent's re-applied market, not on the seeded one.
    expect(store.getDocument<StoredMarket>("market", child.id).doc.derivedFrom!.baseId).toBe(parent.id);
    expect(JSON.stringify(indicesOf(child.id))).toBe(JSON.stringify(indicesOf(FORMULA_ID)));
  });
});

describe("Studio-style launch on the new kinds", () => {
  it("a formula market launches, carries the formula note, and every number equals the compounded window it restates", async () => {
    await formulaMarket();
    await ready("ws-ik-formula", { derived: [INDICES, FORMULA_ID], use: FORMULA_ID, book: INDEXED_BOOK });
    await ready("ws-ik-window", { derived: [INDICES, FORMULA_ID], use: INDICES, book: INDEXED_BOOK });

    const v = await api<{ outcome: string }>(t.base, "POST", `/api/workspaces/ws-ik-formula/setups/${await slotOf("ws-ik-formula")}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.body.outcome).not.toBe("fail");

    const formulaRun = await launchDone("ws-ik-formula");
    const windowRun = await launchDone("ws-ik-window");
    const formula = store.readRunJson<Result>(formulaRun, "result.json");
    const window = store.readRunJson<Result>(windowRun, "result.json");

    const notes = formula.notImplemented.filter((n) => n.layer === "plan.rate-index.formula");
    expect(notes).toHaveLength(1);
    // P2: each position's index is listed first, then its parents, so prime-demo's clause is not the first one. The
    // three seeded floaters name rfr-1m, rfr-3m and prime-demo in that order; prime-demo's parent rfr-1m is already
    // listed. The list ends with a period; no caveat applies (no swap index, no lag).
    expect(notes[0]!.reason).toBe(
      "the run reads these rate indices: rfr-1m: compounded window, 1 month, basis 0 bp; " +
        "rfr-3m: compounded window, 3 months, basis 0 bp; " +
        "prime-demo: formula on rfr-1m, coefficient (level) 1, lag none, floor none, cap none, basis 300 bp.",
    );
    expect(window.notImplemented.some((n) => n.layer === "plan.rate-index.formula")).toBe(false);

    // 1 * P + 0.03 is a one-month window with basis 0.03, bit for bit.
    expect(Object.keys(numbers(formula))).toContain("nii");
    expect(numbers(formula)).toEqual(numbers(window));
  }, 1_200_000);

  it("a constant-maturity-swap index naming a derived curve pins the curve at launch", async () => {
    const FLAT_25 = { id: "flat-25", label: "Flat 25 bp over the run's curve (test curve)", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 25 }] };
    const CMS_ID = "b3a-cms-flat25-v1";
    const d = await derive({
      baseId: PUBLIC,
      ops: [{ op: "set-index", id: "cms-10y", label: "Ten-year swap (demonstration index)", kind: "constant-maturity-swap", tenorYears: 10, basisBp: 0, spreadCurve: "flat-25" }],
      id: CMS_ID,
    });
    expect(d.status).toBe(201);
    // P12: the indexed book refuses compile on a swap-only market, so the plain book runs here.
    await ready("ws-ik-cms", { derived: [CMS_ID], use: CMS_ID, book: PLAIN_BOOK });
    const h = (await ws("ws-ik-cms")).body;
    const saved = await api<{ id: string; revision: number }>(t.base, "POST", "/api/workspaces/ws-ik-cms/derived-curves", { curve: FLAT_25, expectedRevision: h.revision, by: "tester" });
    expect(saved.status).toBe(201);

    const runId = await launchDone("ws-ik-cms");
    const req = store.readRunJson<StoredRunRequest>(runId, "request.json");
    expect(req.workspace!.consumed["derivedCurve:flat-25"]).toEqual(expect.objectContaining({ collection: "derived-curves", id: saved.body.id }));
    const pinnedId = req.submission.marketId!;
    expect(pinnedId).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    const pinned = store.getDocument<StoredMarket>("market", pinnedId).doc;
    expect(pinned.derivedFrom!.baseId).toBe(CMS_ID);
    expect(pinned.derivedCurves).toEqual([FLAT_25]);
  }, 600_000);
});
