// apps/server/src/__tests__/derivedCurveStore.test.ts
// The derived-curves collection, its routes and the market block slot.
// Shape follows curveSetupStore.test.ts (same harness). Sentences are restated by hand from the spec,
// rules.ts requireBy and the engine validator; the estimate's numbers come from the engine's own
// estimateSpreads over the curves the run would build, the one authority on the measure.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCurveFromSetup, defaultSetupFromSnapshot, estimateSpreads, validateCurveSetup, type CurveSetupBlock, type DerivedCurveBlock } from "@alm/engine";
import { derivedCurveIdOf } from "../workspaces/derivedCurveSlot";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import { bootstrapZeroCurve, DeterministicRatePath, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { estimateRowRefusal } from "../http/routes/derivedCurves";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import type { WorkspaceManifest } from "../workspaces/types";
import { WorkspaceStore } from "../workspaces/workspaceStore";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

/** A valid derived curve on the platform default curve: three rows, typed by hand. */
const CURVE = {
  id: "sofr-ust",
  label: "SOFR over UST",
  base: "platform-default",
  spreads: [
    { tenorMonths: 1, spreadBp: 5 },
    { tenorMonths: 3, spreadBp: 7.5 },
    { tenorMonths: 12, spreadBp: 10 },
  ],
};

/** A valid curve setup (the curveSetupStore.test.ts literal): two cash rows and two annual swaps. */
const SETUP = {
  id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual",
  inputs: [
    { instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.043 },
    { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.0435 },
    { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
    { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0385 },
  ],
};

/** The sibling routes' sentence for a missing `by` (rules.ts requireBy), restated. */
const BY_SENTENCE = `"by" is required: a string of 1 to 80 characters naming who makes this change`;

interface Listed { id: string; curveId: string; label: string; base: string; spreads: unknown[]; source?: unknown; estimatedOnDefault?: number }
interface ErrBody { error: { code: string; message: string }; refusals: string[] }
interface Estimate { ok: boolean; spreads?: Array<{ tenorMonths: number; spreadBp: number }>; refusals?: string[] }

const create = (id: string) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id, name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
const head = async (id: string) => (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`)).body;
const save = (id: string, curve: unknown, expectedRevision: number, by: string | null = "tester") =>
  api<{ id: string; revision: number }>(t.base, "POST", `/api/workspaces/${id}/derived-curves`, { curve, expectedRevision, ...(by !== null ? { by } : {}) });
const list = (id: string) => api<{ curves: Listed[]; missing?: unknown }>(t.base, "GET", `/api/workspaces/${id}/derived-curves`);
const estimate = (id: string, body: object) => api<Estimate>(t.base, "POST", `/api/workspaces/${id}/derived-curves/estimate`, body);
const docCount = () => store.listMeta("derived-curves").length + store.listMeta("market").length + store.listMeta("curve-setups").length;

describe("derived-curves routes", () => {
  it("saves a valid curve (201, dc- id), lists it with its label, and writes one history line marked derivedCurve edit", async () => {
    const w = (await create("ws-dc")).body;
    expect("derivedCurves" in w.blocks.market).toBe(false);
    const saved = await save("ws-dc", CURVE, w.revision);
    expect(saved.status).toBe(201);
    expect(saved.body.id).toMatch(/^dc-[0-9a-f]{16}$/);
    expect(saved.body.revision).toBe(w.revision + 1);

    const doc = await api<DerivedCurveBlock>(t.base, "GET", `/api/derived-curves/${saved.body.id}`);
    expect(doc.status).toBe(200);
    expect(doc.body).toEqual(CURVE);

    const listed = await list("ws-dc");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ curves: [{ id: saved.body.id, curveId: "sofr-ust", label: "SOFR over UST", base: "platform-default", spreads: CURVE.spreads }] });

    const h = await head("ws-dc");
    expect(h.blocks.market.derivedCurves).toEqual({
      curves: [{ lineageKey: "sofr-ust", current: { collection: "derived-curves", id: saved.body.id, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), pinnedAt: expect.any(String) } }],
    });
    const hist = (await api<Array<{ revision: number; change: unknown }>>(t.base, "GET", "/api/workspaces/ws-dc/history")).body;
    expect(hist.filter((x) => x.revision > w.revision).map((x) => x.change)).toEqual([
      { kind: "set-block", block: "market", op: "add", ref: { collection: "derived-curves", id: saved.body.id }, derivedCurve: "edit" },
    ]);

    // Identical content again: the same document, no revision, a 200. An edit under the same id moves the slot.
    const same = await save("ws-dc", CURVE, saved.body.revision);
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ id: saved.body.id, revision: saved.body.revision });
    const edited = await save("ws-dc", { ...CURVE, spreads: [{ tenorMonths: 3, spreadBp: 8 }] }, saved.body.revision);
    expect(edited.status).toBe(201);
    expect(edited.body.id).not.toBe(saved.body.id);
    expect((await list("ws-dc")).body.curves.map((c) => c.id)).toEqual([edited.body.id]);
    const last = (await api<Array<{ change: unknown }>>(t.base, "GET", "/api/workspaces/ws-dc/history")).body.at(-1)!;
    expect(last.change).toEqual({ kind: "set-block", block: "market", op: "set", ref: { collection: "derived-curves", id: edited.body.id }, derivedCurve: "edit" });
  });

  it("refuses a save without by with the shared requireBy sentence, and writes nothing", async () => {
    const w = (await create("ws-dc-by")).body;
    const before = store.listMeta("derived-curves").length;
    const r = await save("ws-dc-by", { ...CURVE, id: "no-by" }, w.revision, null);
    expect(r.status).toBe(422);
    expect((r.body as unknown as ErrBody).error.message).toBe(BY_SENTENCE);
    expect(store.listMeta("derived-curves").length).toBe(before);
    expect((await head("ws-dc-by")).revision).toBe(w.revision);
  });

  it("refuses an invalid curve (empty spreads) with 422 and the validator's row-count sentence", async () => {
    const w = (await create("ws-dc-bad")).body;
    const before = store.listMeta("derived-curves").length;
    const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-dc-bad/derived-curves", { curve: { ...CURVE, spreads: [] }, expectedRevision: w.revision, by: "tester" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.refusals).toContain("a derived curve needs 1 to 60 spread rows");
    expect(store.listMeta("derived-curves").length).toBe(before);
    expect((await head("ws-dc-bad")).revision).toBe(w.revision);
  });

  it("refuses a stale expectedRevision with 409", async () => {
    const w = (await create("ws-dc-stale")).body;
    const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-dc-stale/derived-curves", { curve: CURVE, expectedRevision: w.revision + 5, by: "tester" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("revision-conflict");
    expect("derivedCurves" in (await head("ws-dc-stale")).blocks.market).toBe(false);
    expect((await save("ws-nope", CURVE, 1)).status).toBe(404);
    expect((await list("ws-nope")).status).toBe(404);
    expect((await api(t.base, "GET", "/api/derived-curves/dc-0000000000000000")).status).toBe(404);
  });

  it("refuses a save on an archived or locked workspace with the slots' own sentence, and writes nothing (M6)", async () => {
    const before = store.listMeta("derived-curves").length;
    // Content no other test saves, so a write would add a document.
    const fresh = { ...CURVE, id: "never-written", label: "Never written" };

    const w = (await create("ws-dc-arch")).body;
    const arch = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-dc-arch/archive", { expectedRevision: w.revision, by: "tester" });
    expect(arch.status).toBe(200);
    const closed = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-dc-arch/derived-curves", { curve: fresh, expectedRevision: arch.body.revision, by: "tester" });
    expect(closed.status).toBe(409);
    expect(closed.body.error.message).toBe(`workspace "ws-dc-arch" is archived and read-only; clone it to keep working`);
    expect((await head("ws-dc-arch")).revision).toBe(arch.body.revision);

    // A locked workspace: the lock sentence names the approval, as for every other slot.
    const locked = (await create("ws-dc-lock")).body;
    new WorkspaceStore(t.storeRoot).commit("ws-dc-lock", locked.revision, "tester", { kind: "lock", approvalId: "ap-test-dc" }, { ...locked, status: "locked", lock: { lockedAt: "t", by: "tester", approvalId: "ap-test-dc", signedHash: locked.signedHash } });
    const l = await head("ws-dc-lock");
    const refused = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-dc-lock/derived-curves", { curve: fresh, expectedRevision: l.revision, by: "tester" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/^workspace "ws-dc-lock" is locked by approval ap-test-dc; /);
    expect((await head("ws-dc-lock")).revision).toBe(l.revision);
    expect("derivedCurves" in (await head("ws-dc-lock")).blocks.market).toBe(false);

    expect(store.listMeta("derived-curves").length).toBe(before);
  });

  it("refuses a label of 81 characters and saves one of 80", async () => {
    const w = (await create("ws-dc-label")).body;
    const long = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-dc-label/derived-curves", { curve: { ...CURVE, label: "x".repeat(81) }, expectedRevision: w.revision, by: "tester" });
    expect(long.status).toBe(422);
    expect(long.body.refusals).toContain(`the derived curve's "label" must be 1 to 80 characters`);
    const ok = await save("ws-dc-label", { ...CURVE, label: "x".repeat(80) }, w.revision);
    expect(ok.status).toBe(201);
  });

  it("estimates from a saved setup minus platform-default in tenor order, names an unknown setup, and writes nothing", async () => {
    const w = (await create("ws-dc-est")).body;
    await api(t.base, "POST", "/api/workspaces/ws-dc-est/blocks", { expectedRevision: w.revision, by: "tester", block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const h = await head("ws-dc-est");
    const savedSetup = await api<{ id: string; revision: number }>(t.base, "POST", "/api/workspaces/ws-dc-est/curve-setups", { setup: SETUP, expectedRevision: h.revision, by: "tester" });
    expect(savedSetup.status).toBe(201);

    const before = docCount();
    const revBefore = (await head("ws-dc-est")).revision;
    const r = await estimate("ws-dc-est", { from: "sofr-main", minus: "platform-default", tenors: [1, 3, 12] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // The engine's own measure over the two curves the run would build.
    const from = buildCurveFromSetup((validateCurveSetup(SETUP) as { block: CurveSetupBlock }).block).curve;
    const minus = buildBaseCurve(store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc);
    expect(r.body.spreads).toEqual(estimateSpreads(from, minus, [1, 3, 12]));
    expect(r.body.spreads!.map((s) => s.tenorMonths)).toEqual([1, 3, 12]);

    const unknown = await estimate("ws-dc-est", { from: "nope-setup", minus: "platform-default", tenors: [1, 3, 12] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.ok).toBe(false);
    expect(unknown.body.refusals!.some((s) => s.includes(`"nope-setup"`))).toBe(true);

    expect(docCount()).toBe(before);
    expect((await head("ws-dc-est")).revision).toBe(revBefore);
  });

  it("estimate validates its tenors before the engine sees them, and refuses an estimated row beyond 1000 bp by row (R8)", async () => {
    const w = (await create("ws-dc-tenor")).body;
    await api(t.base, "POST", "/api/workspaces/ws-dc-tenor/blocks", { expectedRevision: w.revision, by: "tester", block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const bad = async (tenors: unknown) => {
      const r = await estimate("ws-dc-tenor", { from: "platform-default", minus: "platform-default", tenors });
      expect(r.status).toBe(422);
      expect(r.body.ok).toBe(false);
      return r.body.refusals!;
    };
    expect(await bad([0, 3])).toContain("row 1: tenorMonths must be a whole number of months from 1 to 360");
    expect(await bad([1, 2.5])).toContain("row 2: tenorMonths must be a whole number of months from 1 to 360");
    expect(await bad([3, 3])).toContain("row 2: tenorMonths must be greater than row 1's (3)");
    expect(await bad([])).toContain(`"tenors" must list 1 to 60 tenors in months`);
    expect(await bad(Array.from({ length: 61 }, (_, i) => i + 1))).toContain(`"tenors" must list 1 to 60 tenors in months`);
    // Platform default minus itself is zero everywhere.
    const zero = await estimate("ws-dc-tenor", { from: "platform-default", minus: "platform-default", tenors: [1, 360] });
    expect(zero.status).toBe(200);
    expect(zero.body.spreads).toEqual([{ tenorMonths: 1, spreadBp: 0 }, { tenorMonths: 360, spreadBp: 0 }]);

    // A setup 20 percentage points above the seeded curve: every row exceeds the cap and is named.
    const h = await head("ws-dc-tenor");
    const high = { ...SETUP, id: "high", label: "High", inputs: SETUP.inputs.map((r) => ({ ...r, value: r.value + 0.2 })) };
    const s = await api<{ id: string }>(t.base, "POST", "/api/workspaces/ws-dc-tenor/curve-setups", { setup: high, expectedRevision: h.revision, by: "tester" });
    expect(s.status).toBe(201);
    const over = await estimate("ws-dc-tenor", { from: "high", minus: "platform-default", tenors: [1, 3] });
    expect(over.status).toBe(422);
    expect(over.body.refusals).toHaveLength(2);
    expect(over.body.refusals![0]).toMatch(/^row 1 \(1 months\): the estimated spread of \d+(\.\d+)? bp is beyond the 1000 bp a derived curve carries$/);
    expect(over.body.refusals![1]).toMatch(/^row 2 \(3 months\): /);
    // M7: the value prints rounded to two decimals, as the engine's own measure gives it.
    const fromHigh = buildCurveFromSetup((validateCurveSetup(high) as { block: CurveSetupBlock }).block).curve;
    const seeded = buildBaseCurve(store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc);
    const raw = estimateSpreads(fromHigh, seeded, [1, 3]);
    expect(over.body.refusals).toEqual(
      raw.map((r, i) => `row ${i + 1} (${r.tenorMonths} months): the estimated spread of ${Math.round(r.spreadBp * 100) / 100} bp is beyond the 1000 bp a derived curve carries`),
    );
    for (const text of over.body.refusals!) expect(text).toMatch(/of -?\d+(\.\d{1,2})? bp/);
  });

  it("estimate refuses a fill row above 12 months off whole years, naming the row, before any curve is built; a typed grid still saves it (decision 46)", async () => {
    // No base snapshot: had a curve been built first, platform-default would refuse with its own sentence.
    const w = (await create("ws-dc-fill18")).body;
    const r = await estimate("ws-dc-fill18", { from: "platform-default", minus: "platform-default", tenors: [12, 18] });
    expect(r.status).toBe(422);
    expect(r.body.ok).toBe(false);
    expect(r.body.refusals).toEqual(["row 2: a fill above 12 months reads the par swap rate, which needs whole years (24, 36 and so on up to 360 months); got 18 months"]);
    // A tenor list the R8 check refuses is answered with that check's sentences alone.
    const unordered = await estimate("ws-dc-fill18", { from: "platform-default", minus: "platform-default", tenors: [18, 18] });
    expect(unordered.body.refusals).toEqual(["row 2: tenorMonths must be greater than row 1's (18)"]);
    // A typed grid is unchanged: the save still takes any whole month from 1 to 360.
    const typed = await save("ws-dc-fill18", { ...CURVE, spreads: [{ tenorMonths: 12, spreadBp: 10 }, { tenorMonths: 18, spreadBp: 11 }] }, w.revision);
    expect(typed.status).toBe(201);
  });

  it("estimate fills a whole-year row above 12 months with the par swap rate gap, read as a swap index reads it at step 0 (decision 46)", async () => {
    const w = (await create("ws-dc-swapfill")).body;
    await api(t.base, "POST", "/api/workspaces/ws-dc-swapfill/blocks", { expectedRevision: w.revision, by: "tester", block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const h = await head("ws-dc-swapfill");
    const savedSetup = await api<{ id: string; revision: number }>(t.base, "POST", "/api/workspaces/ws-dc-swapfill/curve-setups", { setup: SETUP, expectedRevision: h.revision, by: "tester" });
    expect(savedSetup.status).toBe(201);

    const r = await estimate("ws-dc-swapfill", { from: "sofr-main", minus: "platform-default", tenors: [12, 120] });
    expect(r.status).toBe(200);
    const from = buildCurveFromSetup((validateCurveSetup(SETUP) as { block: CurveSetupBlock }).block).curve;
    const minus = buildBaseCurve(store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc);
    // The engine's own measure, row by row.
    expect(r.body.spreads).toEqual(estimateSpreads(from, minus, [12, 120]));
    expect(r.body.spreads![1]).toEqual(estimateSpreads(from, minus, [120])[0]);
    // Restated, not imported: the 10-year swap index's step-0 read on each curve.
    const swap10 = (c: ZeroCurve) => new DeterministicRatePath(c, 1, 1 / 12).forwardRateAt(0, 10);
    expect(r.body.spreads![1]!.spreadBp).toBeCloseTo((swap10(from) - swap10(minus)) * 10000, 5);
  });

  it("states an over-cap estimate rounded to two decimals, and a non-finite one in its own sentence (M7)", () => {
    expect(estimateRowRefusal(0, 12, 1234.56789)).toBe("row 1 (12 months): the estimated spread of 1234.57 bp is beyond the 1000 bp a derived curve carries");
    expect(estimateRowRefusal(1, 24, -1500.001)).toBe("row 2 (24 months): the estimated spread of -1500 bp is beyond the 1000 bp a derived curve carries");
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateRowRefusal(2, 60, v)).toBe("row 3 (60 months): the estimated spread is not a finite number of basis points; the two curves give no readable gap at this tenor");
    }
  });

  it("estimate refuses a from or minus that is not a curve id, in words, before any lookup (M4)", async () => {
    await create("ws-dc-ids"); // no base snapshot: a platform-default lookup would refuse with its own sentence
    const sentence = (key: string) => `"${key}" must name a saved curve setup by its own id (1 to 70 characters from A-Z a-z 0-9 . _ -), or platform-default`;
    for (const from of ["a/b", "sofr main", "k".repeat(71), "", 7]) {
      const r = await estimate("ws-dc-ids", { from, minus: "platform-default", tenors: [1] });
      expect(r.status).toBe(422);
      expect(r.body.refusals).toEqual([sentence("from")]);
    }
    const both = await estimate("ws-dc-ids", { from: "../x", minus: " ", tenors: [1] });
    expect(both.body.refusals).toEqual([sentence("from"), sentence("minus")]);
  });

  it("estimate names the platform default curve, not a bootstrap, when the base snapshot does not build", async () => {
    // A stored base market whose curveDefault marker is a value the engine refuses (seeds only; decision 73).
    store.putDocument("market", "mk-dc-badmarker", { ...store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc, curveDefault: 2 }, { label: "bad marker" });
    const w = (await create("ws-dc-badmarker")).body;
    await api(t.base, "POST", "/api/workspaces/ws-dc-badmarker/blocks", { expectedRevision: w.revision, by: "tester", block: "market", op: "set", ref: { collection: "market", id: "mk-dc-badmarker" } });
    const r = await estimate("ws-dc-badmarker", { from: "platform-default", minus: "platform-default", tenors: [1] });
    expect(r.status).toBe(422);
    expect(r.body.refusals).toEqual([
      `platform-default, the platform default curve, does not build from the base market snapshot "mk-dc-badmarker": The market's curveDefault is 2; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.`,
    ]);
  });

  it("estimate with platform-default needs a base snapshot", async () => {
    await create("ws-dc-nobase");
    const r = await estimate("ws-dc-nobase", { from: "platform-default", minus: "platform-default", tenors: [1] });
    expect(r.status).toBe(422);
    expect(r.body.refusals).toEqual([`platform-default builds from the workspace's base market snapshot, and workspace "ws-dc-nobase" has none; attach one on Market > Yield curves`]);
    expect((await estimate("ws-nope", { from: "platform-default", minus: "platform-default", tenors: [1] })).status).toBe(404);
  });
});

// A curve whose source names platform-default records the platform default
// curve version it was estimated on. The seeded base market carries no marker, so it builds version 2; a
// copy of it carrying `curveDefault: 1` builds version 1, the kernel bootstrap.
describe("the estimatedOnDefault stamp at save", () => {
  const MARKED = "mk-dc-marked";
  const onBase = async (id: string, marketId: string | null) => {
    const w = (await create(id)).body;
    if (marketId === null) return w;
    const r = await api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: w.revision, by: "tester", block: "market", op: "set", ref: { collection: "market", id: marketId } });
    expect(r.status).toBe(201);
    return r.body;
  };
  const savedDoc = async (wsId: string, curve: object) => {
    const h = await head(wsId);
    const r = await save(wsId, curve, h.revision);
    expect(r.status).toBe(201);
    return (await api<DerivedCurveBlock & Record<string, unknown>>(t.base, "GET", `/api/derived-curves/${r.body.id}`)).body;
  };
  beforeAll(() => {
    store.putDocument("market", MARKED, { ...store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc, curveDefault: 1 }, { label: "marked" });
  });

  it("stamps 2 when source minus is platform-default on the unmarked base market, and the list carries it", async () => {
    await onBase("ws-dcs-v2", SEED_IDS.market);
    const curve = { ...CURVE, id: "stamp-v2", source: { from: "sofr-main", minus: "platform-default" } };
    const doc = await savedDoc("ws-dcs-v2", curve);
    expect(doc).toEqual({ ...curve, estimatedOnDefault: 2 });
    const row = (await list("ws-dcs-v2")).body.curves.find((c) => c.curveId === "stamp-v2")!;
    expect(row).toEqual(expect.objectContaining({ source: curve.source, estimatedOnDefault: 2 }));
  });

  it("stamps 1 when source from is platform-default on a base market marked curveDefault 1", async () => {
    await onBase("ws-dcs-v1", MARKED);
    const curve = { ...CURVE, id: "stamp-v1", source: { from: "platform-default", minus: "sofr-main" } };
    expect(await savedDoc("ws-dcs-v1", curve)).toEqual({ ...curve, estimatedOnDefault: 1 });
  });

  it("does not stamp a typed grid, nor a source of two curve setups, and refuses a stamp sent with either (the validator)", async () => {
    const w = await onBase("ws-dcs-typed", SEED_IDS.market);
    const typed = { ...CURVE, id: "typed" };
    const typedDoc = await savedDoc("ws-dcs-typed", typed);
    expect(typedDoc).toEqual(typed);
    expect("estimatedOnDefault" in typedDoc).toBe(false);
    const setups = { ...CURVE, id: "two-setups", source: { from: "sofr-main", minus: "ust-main" } };
    expect(await savedDoc("ws-dcs-typed", setups)).toEqual(setups);
    const sentence = `the derived curve's "estimatedOnDefault" belongs only to a curve whose source names platform-default; a typed grid or a source of two curve setups carries none`;
    const before = store.listMeta("derived-curves").length;
    for (const sent of [{ ...typed, id: "typed-sent", estimatedOnDefault: 2 }, { ...setups, id: "two-setups-sent", estimatedOnDefault: 1 }]) {
      const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-dcs-typed/derived-curves", { curve: sent, expectedRevision: w.revision + 2, by: "tester" });
      expect(r.status).toBe(422);
      expect(r.body.refusals).toEqual([sentence]);
    }
    expect(store.listMeta("derived-curves").length).toBe(before);
  });

  it("ignores a stamp the client sends: a new curve is stamped with the base market's default", async () => {
    await onBase("ws-dcs-ignore", SEED_IDS.market);
    const curve = { ...CURVE, id: "sent-one", source: { from: "sofr-main", minus: "platform-default" } };
    expect(await savedDoc("ws-dcs-ignore", { ...curve, estimatedOnDefault: 1 })).toEqual({ ...curve, estimatedOnDefault: 2 });
  });

  it("a saved curve whose spreads and source are unchanged keeps the version it was estimated on; a pre-B4 curve round-trips with no write", async () => {
    await onBase("ws-dcs-inherit", SEED_IDS.market);
    // A curve stored before the stamp existed: written to the store and the slot directly, no stamp.
    const old = { ...CURVE, id: "pre-b4", source: { from: "sofr-main", minus: "platform-default" } };
    const oldId = derivedCurveIdOf(old as DerivedCurveBlock);
    const meta = store.putDocument("derived-curves", oldId, old, { label: old.label, workspaceId: "ws-dcs-inherit" });
    const wsStore = new WorkspaceStore(t.storeRoot);
    const h0 = wsStore.head("ws-dcs-inherit");
    wsStore.commit("ws-dcs-inherit", h0.revision, "tester", { kind: "set-block", block: "market", op: "add", ref: { collection: "derived-curves", id: oldId }, derivedCurve: "edit" }, {
      ...h0,
      blocks: { ...h0.blocks, market: { ...h0.blocks.market, derivedCurves: { curves: [{ lineageKey: "pre-b4", current: { collection: "derived-curves", id: oldId, contentHash: meta.contentHash, pinnedAt: "t" } }] } } },
    });

    // Read back, the curve says where it was estimated: version 1, though its bytes carry no stamp.
    const got = (await api<Record<string, unknown>>(t.base, "GET", `/api/derived-curves/${oldId}`)).body;
    expect(got).toEqual({ ...old, estimatedOnDefault: 1 });
    expect(store.getDocument("derived-curves", oldId).doc).toEqual(old);
    const row = (await list("ws-dcs-inherit")).body.curves[0]!;
    expect(row.estimatedOnDefault).toBe(1);

    // GET to POST, with the stamp the read carries or with none: the slot already holds it; 200, nothing written.
    const rev = (await head("ws-dcs-inherit")).revision;
    const count = store.listMeta("derived-curves").length;
    for (const curve of [got, old, { ...old, estimatedOnDefault: 2 }]) {
      const again = await save("ws-dcs-inherit", curve, rev);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ id: oldId, revision: rev });
    }
    expect(store.listMeta("derived-curves").length).toBe(count);
    expect((await head("ws-dcs-inherit")).blocks.market.derivedCurves!.curves[0]!.current.id).toBe(oldId);

    // A new label on the same spreads and source: a new document, still on version 1, not the base's 2.
    const renamed = await save("ws-dcs-inherit", { ...old, label: "Renamed" }, rev);
    expect(renamed.status).toBe(201);
    expect(store.getDocument("derived-curves", renamed.body.id).doc).toEqual({ ...old, label: "Renamed", estimatedOnDefault: 1 });
    // A stamped curve inherits its stamp the same way.
    const again = await save("ws-dcs-inherit", { ...old, label: "Renamed twice" }, renamed.body.revision);
    expect(store.getDocument("derived-curves", again.body.id).doc).toEqual({ ...old, label: "Renamed twice", estimatedOnDefault: 1 });
    // New spreads were estimated anew: the base market's default, version 2.
    const moved = await save("ws-dcs-inherit", { ...old, label: "Renamed twice", spreads: [{ tenorMonths: 3, spreadBp: 9 }] }, again.body.revision);
    expect(moved.status).toBe(201);
    expect(store.getDocument<DerivedCurveBlock>("derived-curves", moved.body.id).doc.estimatedOnDefault).toBe(2);
    // So does a new source.
    const resourced = await save("ws-dcs-inherit", { ...old, source: { from: "platform-default", minus: "sofr-main" } }, moved.body.revision);
    expect(store.getDocument<DerivedCurveBlock>("derived-curves", resourced.body.id).doc.estimatedOnDefault).toBe(2);
  });

  it("leaves a platform-default source unstamped when the workspace has no base snapshot (it then reads as version 1)", async () => {
    await onBase("ws-dcs-nobase", null);
    const curve = { ...CURVE, id: "no-base", source: { from: "sofr-main", minus: "platform-default" } };
    // The stored bytes carry no stamp; the read says what an unstamped platform-default curve means.
    const read = await savedDoc("ws-dcs-nobase", curve);
    expect(read).toEqual({ ...curve, estimatedOnDefault: 1 });
    const docId = (await list("ws-dcs-nobase")).body.curves[0]!.id;
    expect(store.getDocument("derived-curves", docId).doc).toEqual(curve);
  });

  it("the estimate runs on the default the base market builds: version 1 on the marked market, version 2 on the unmarked one", async () => {
    for (const [wsId, marketId] of [["ws-dcs-est1", MARKED], ["ws-dcs-est2", SEED_IDS.market]] as const) {
      const w = await onBase(wsId, marketId);
      const s = await api(t.base, "POST", `/api/workspaces/${wsId}/curve-setups`, { setup: SETUP, expectedRevision: w.revision, by: "tester" });
      expect(s.status).toBe(201);
    }
    const from = buildCurveFromSetup((validateCurveSetup(SETUP) as { block: CurveSetupBlock }).block).curve;
    const seeded = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    const tenors = [12, 180];
    const v1 = estimateSpreads(from, bootstrapZeroCurve(seeded), tenors);
    // Version 2 restated outside buildBaseCurve: the default setup the engine fills, built by the curve builder.
    const filled = defaultSetupFromSnapshot(seeded);
    if (!filled.ok) throw new Error(filled.reason);
    const v2 = estimateSpreads(from, buildCurveFromSetup(filled.block).curve, tenors);
    // The two defaults part at the 15-year swap rate (an off-node tenor), so the check can tell them apart.
    expect(v1[1]!.spreadBp).not.toBe(v2[1]!.spreadBp);
    const on1 = await estimate("ws-dcs-est1", { from: "sofr-main", minus: "platform-default", tenors });
    const on2 = await estimate("ws-dcs-est2", { from: "sofr-main", minus: "platform-default", tenors });
    expect(on1.body).toEqual({ ok: true, spreads: v1 });
    expect(on2.body).toEqual({ ok: true, spreads: v2 });
  });
});
