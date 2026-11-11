// apps/server/src/__tests__/curveSetupStore.test.ts
// The curve-setups collection, its routes and the market block slot.
// Shape follows runSetupStore.test.ts (same harness). Expected values are restated by hand from
// the plan's Task 8 routes and the engine validator's sentences; the preview's numbers are compared
// with the engine's own buildCurveFromSetup, the one authority on a built curve.
import { renameSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCurveFromSetup, validateCurveSetup, type CurveSetupBlock } from "@alm/engine";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import type { WorkspaceManifest } from "../workspaces/types";
import { WorkspaceStore } from "../workspaces/workspaceStore";

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); await seedStore(new FileStore(t.storeRoot), repoRoot()); }, 120_000);
afterAll(() => t.close());

/** A valid setup: two cash rows and two whole-year annual swaps, ACT/360 annual, log-linear on discount factor. */
const SETUP = {
  id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual",
  inputs: [
    { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0385 },
    { instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.043 },
    { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.0435 },
    { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
  ],
};
/** The rows as the validator stores them: sorted by node tenor. */
const SORTED_ROWS = [SETUP.inputs[1], SETUP.inputs[2], SETUP.inputs[3], SETUP.inputs[0]];

interface Listed { id: string; setupId: string; label: string; interpolation: string; dayCount: string; compounding: string; rows: unknown[]; active: boolean }
interface ErrBody { error: { code: string; message: string; detail?: unknown }; refusals: string[] }

const create = (id: string) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id, name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
const head = async (id: string) => (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`)).body;
const save = (id: string, setup: unknown, expectedRevision: number) => api<{ id: string; revision: number }>(t.base, "POST", `/api/workspaces/${id}/curve-setups`, { setup, expectedRevision, by: "tester" });
const list = (id: string) => api<{ setups: Listed[] }>(t.base, "GET", `/api/workspaces/${id}/curve-setups`);
const activate = (id: string, setupId: string, expectedRevision: number) => api<{ revision: number }>(t.base, "POST", `/api/workspaces/${id}/curve-setups/${setupId}/activate`, { expectedRevision, by: "tester" });
const preview = (setup: unknown) => api<{ ok: boolean; quoteNodes?: Array<{ tenorMonths: number; zeroRate: number; discountFactor: number }>; denseCount?: number; warnings?: string[]; refusals?: string[] }>(t.base, "POST", "/api/curve-setups/preview", { setup });

describe("curve-setups routes", () => {
  it("saves a valid setup, lists it, and activates it", async () => {
    const w = (await create("ws-cs")).body;
    expect("curveSetups" in w.blocks.market).toBe(false);
    const saved = await save("ws-cs", SETUP, w.revision);
    expect(saved.status).toBe(201);
    expect(saved.body.id).toMatch(/^cs-[0-9a-f]{16}$/);
    expect(saved.body.revision).toBe(w.revision + 1);
    // The document is the validator's block (rows sorted by node tenor), readable by id.
    const doc = await api<CurveSetupBlock>(t.base, "GET", `/api/curve-setups/${saved.body.id}`);
    expect(doc.status).toBe(200);
    expect(doc.body).toEqual({ ...SETUP, inputs: SORTED_ROWS });

    const before = await list("ws-cs");
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      setups: [{ id: saved.body.id, setupId: "sofr-main", label: "SOFR main", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual", rows: SORTED_ROWS, active: false }],
    });

    const act = await activate("ws-cs", saved.body.id, saved.body.revision);
    expect(act.status).toBe(200);
    expect(act.body).toEqual({ revision: saved.body.revision + 1 });
    const after = await list("ws-cs");
    expect(after.body.setups.map((s) => [s.id, s.active])).toEqual([[saved.body.id, true]]);
    const h = await head("ws-cs");
    expect(h.revision).toBe(act.body.revision);
    expect(h.blocks.market.curveSetups).toEqual({
      setups: [{ lineageKey: "sofr-main", current: { collection: "curve-setups", id: saved.body.id, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), pinnedAt: expect.any(String) } }],
      active: saved.body.id,
    });

    // Each write is one history line on the market block.
    const hist = (await api<Array<{ revision: number; change: unknown }>>(t.base, "GET", "/api/workspaces/ws-cs/history")).body;
    expect(hist.slice(-2).map((x) => x.change)).toEqual([
      { kind: "set-block", block: "market", op: "add", ref: { collection: "curve-setups", id: saved.body.id } },
      { kind: "set-block", block: "market", op: "set", ref: { collection: "curve-setups", id: saved.body.id } },
    ]);
  });

  it("re-saving identical content changes nothing; an edit under the same setup id moves its slot and the active pointer; a new setup id adds a slot", async () => {
    const w = (await create("ws-cs-edit")).body;
    const first = await save("ws-cs-edit", SETUP, w.revision);
    const act = await activate("ws-cs-edit", first.body.id, first.body.revision);
    // Identical content (rows in another order): the same document, no revision, a 200.
    const same = await save("ws-cs-edit", { ...SETUP, inputs: SORTED_ROWS }, act.body.revision);
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ id: first.body.id, revision: act.body.revision });
    // Activating the active setup again changes nothing.
    const again = await activate("ws-cs-edit", first.body.id, act.body.revision);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ revision: act.body.revision });

    const edited = await save("ws-cs-edit", { ...SETUP, interpolation: "monotone-convex" }, act.body.revision);
    expect(edited.status).toBe(201);
    expect(edited.body.id).not.toBe(first.body.id);
    const listed = (await list("ws-cs-edit")).body.setups;
    expect(listed).toEqual([expect.objectContaining({ id: edited.body.id, interpolation: "monotone-convex", active: true })]);
    // The old document stays in the store (append-only).
    expect((await api(t.base, "GET", `/api/curve-setups/${first.body.id}`)).status).toBe(200);

    const other = await save("ws-cs-edit", { ...SETUP, id: "ust-main", label: "UST main" }, edited.body.revision);
    expect(other.status).toBe(201);
    const two = (await list("ws-cs-edit")).body.setups;
    expect(two.map((s) => [s.label, s.active])).toEqual([["SOFR main", true], ["UST main", false]]);
    const moved = await activate("ws-cs-edit", other.body.id, other.body.revision);
    expect(moved.status).toBe(200);
    expect((await list("ws-cs-edit")).body.setups.map((s) => [s.label, s.active])).toEqual([["SOFR main", false], ["UST main", true]]);
  });

  it("names each listed setup by its own id (setupId, the slot's lineageKey) beside the document id (B2 ruling R9)", async () => {
    const w = (await create("ws-cs-setupid")).body;
    const a = await save("ws-cs-setupid", SETUP, w.revision);
    const b = await save("ws-cs-setupid", { ...SETUP, id: "ust-main", label: "UST main" }, a.body.revision);
    const listed = (await list("ws-cs-setupid")).body.setups;
    expect(listed.map((s) => [s.id, s.setupId])).toEqual([[a.body.id, "sofr-main"], [b.body.id, "ust-main"]]);
    const slots = (await head("ws-cs-setupid")).blocks.market.curveSetups?.setups ?? [];
    expect(listed.map((s) => s.setupId)).toEqual(slots.map((s) => s.lineageKey));
  });

  it("refuses an invalid setup with 422 and the validator sentence", async () => {
    const w = (await create("ws-cs-bad")).body;
    const store = new FileStore(t.storeRoot);
    const stored = store.listMeta("curve-setups").length;
    const bad = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-bad/curve-setups", { setup: { ...SETUP, compounding: "continuous" }, expectedRevision: w.revision, by: "tester" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("validation");
    // The sentences are the validator's own, verbatim, one per refused row.
    const expected = validateCurveSetup({ ...SETUP, compounding: "continuous" });
    expect(expected.ok).toBe(false);
    expect(bad.body.refusals).toEqual((expected as { refusals: string[] }).refusals);
    expect(bad.body.refusals.some((r) => /continuous compounding has no coupon schedule/.test(r))).toBe(true);
    expect(bad.body.error.message).toContain("continuous compounding has no coupon schedule");
    // Nothing stored, no revision spent.
    expect(store.listMeta("curve-setups").length).toBe(stored);
    expect((await head("ws-cs-bad")).revision).toBe(w.revision);
    // A setup that validates but cannot bootstrap is refused the same way, with the builder's sentences.
    const unsolvable = { ...SETUP, inputs: [SETUP.inputs[2], { instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 149.9 }] };
    expect(validateCurveSetup(unsolvable).ok).toBe(true);
    const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-bad/curve-setups", { setup: unsolvable, expectedRevision: w.revision, by: "tester" });
    expect(r.status).toBe(422);
    expect(r.body.refusals.length).toBeGreaterThan(0);
    expect(store.listMeta("curve-setups").length).toBe(stored);
    // A body that is not an object, and a missing expectedRevision, are 422 too.
    expect((await api(t.base, "POST", "/api/workspaces/ws-cs-bad/curve-setups", { setup: SETUP, by: "tester" })).status).toBe(422);
  });

  it("refuses a stale expectedRevision with 409, an unknown setup with 404 and an unknown workspace with 404", async () => {
    const w = (await create("ws-cs-stale")).body;
    const stale = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-stale/curve-setups", { setup: SETUP, expectedRevision: w.revision + 5, by: "tester" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("revision-conflict");
    const ok = await save("ws-cs-stale", SETUP, w.revision);
    expect(ok.status).toBe(201);
    const staleAct = await activate("ws-cs-stale", ok.body.id, w.revision);
    expect(staleAct.status).toBe(409);
    expect((await head("ws-cs-stale")).blocks.market.curveSetups!.active).toBeUndefined();
    expect((await activate("ws-cs-stale", "cs-0000000000000000", ok.body.revision)).status).toBe(404);
    expect((await save("ws-nope", SETUP, 1)).status).toBe(404);
    expect((await list("ws-nope")).status).toBe(404);
    expect((await activate("ws-nope", ok.body.id, 1)).status).toBe(404);
    expect((await api(t.base, "GET", "/api/curve-setups/cs-0000000000000000")).status).toBe(404);
  });

  it("refuses writes on an archived or locked workspace with the slots' own sentence, and writes nothing", async () => {
    const w = (await create("ws-cs-arch")).body;
    const ok = await save("ws-cs-arch", SETUP, w.revision);
    const arch = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-cs-arch/archive", { expectedRevision: ok.body.revision, by: "tester" });
    expect(arch.status).toBe(200);
    const closed = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-arch/curve-setups", { setup: { ...SETUP, id: "other" }, expectedRevision: arch.body.revision, by: "tester" });
    expect(closed.status).toBe(409);
    expect(closed.body.error.message).toBe(`workspace "ws-cs-arch" is archived and read-only; clone it to keep working`);
    const closedAct = await api<ErrBody>(t.base, "POST", `/api/workspaces/ws-cs-arch/curve-setups/${ok.body.id}/activate`, { expectedRevision: arch.body.revision, by: "tester" });
    expect(closedAct.status).toBe(409);
    expect(closedAct.body.error.message).toBe(`workspace "ws-cs-arch" is archived and read-only; clone it to keep working`);
    expect((await head("ws-cs-arch")).revision).toBe(arch.body.revision);

    // A locked workspace: the lock sentence names the approval, as for every other slot.
    const locked = (await create("ws-cs-lock")).body;
    const wsDir = new WorkspaceStore(t.storeRoot);
    wsDir.commit("ws-cs-lock", locked.revision, "tester", { kind: "lock", approvalId: "ap-test" }, { ...locked, status: "locked", lock: { lockedAt: "t", by: "tester", approvalId: "ap-test", signedHash: locked.signedHash } });
    const l = await head("ws-cs-lock");
    const refused = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-lock/curve-setups", { setup: SETUP, expectedRevision: l.revision, by: "tester" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/^workspace "ws-cs-lock" is locked by approval ap-test; /);
  });

  it("a slot whose document left the store is skipped in the list and named under missing", async () => {
    const w = (await create("ws-cs-gone")).body;
    const ok = await save("ws-cs-gone", SETUP, w.revision);
    const store = new FileStore(t.storeRoot);
    const path = store.paths.documentPath("curve-setups", ok.body.id);
    renameSync(path, `${path}.aside`);
    try {
      const r = await api<{ setups: Listed[]; missing: Array<{ id: string; problem: string }> }>(t.base, "GET", "/api/workspaces/ws-cs-gone/curve-setups");
      expect(r.status).toBe(200);
      expect(r.body.setups).toEqual([]);
      expect(r.body.missing).toEqual([{ id: ok.body.id, problem: `the curve setup document "${ok.body.id}" is not in the store` }]);
    } finally {
      renameSync(`${path}.aside`, path);
    }
    // With the document back, the list carries no missing key at all.
    expect("missing" in (await list("ws-cs-gone")).body).toBe(false);
  });

  it("preview returns quote nodes and a negative-forward warning in words", async () => {
    const r = await preview(SETUP);
    expect(r.status).toBe(200);
    const built = buildCurveFromSetup((validateCurveSetup(SETUP) as { block: CurveSetupBlock }).block);
    expect(r.body.ok).toBe(true);
    expect(r.body.quoteNodes!.map((n) => n.tenorMonths)).toEqual([1, 3, 24, 60]);
    r.body.quoteNodes!.forEach((n, i) => {
      const tYears = built.quoteTenors[i]!;
      expect(n.zeroRate).toBe(built.curve.zeroRate(tYears));
      expect(n.discountFactor).toBe(built.curve.discountFactor(tYears));
    });
    // log-linear-df writes one dense node per month to the last quote tenor.
    expect(r.body.denseCount).toBe(60);
    expect(r.body.warnings).toEqual([]);

    // Zero rates of 5 percent at 1 year and 1 percent at 2 years imply a negative forward between them.
    const inverted = {
      ...SETUP, compounding: "continuous", interpolation: "linear-zero",
      inputs: [
        { instrument: "cash", tenorMonths: 12, quoteType: "zero-rate", value: 0.05 },
        { instrument: "ois-swap", tenorMonths: 24, quoteType: "zero-rate", value: 0.01 },
      ],
    };
    const w = await preview(inverted);
    expect(w.status).toBe(200);
    expect(w.body.ok).toBe(true);
    expect(w.body.warnings).toHaveLength(1);
    expect(w.body.warnings![0]).toMatch(/^negative forward of -\d+\.\d bp between month \d+ and month \d+ \(\d+ intervals?\)$/);

    const bad = await preview({ ...SETUP, compounding: "continuous" });
    expect(bad.status).toBe(422);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.refusals!.some((x) => /continuous compounding has no coupon schedule/.test(x))).toBe(true);
    const noBody = await api<{ ok: boolean; refusals: string[] }>(t.base, "POST", "/api/curve-setups/preview", { setup: "not a setup" });
    expect(noBody.status).toBe(422);
    expect(noBody.body.ok).toBe(false);
    expect(noBody.body.refusals.length).toBeGreaterThan(0);
  });
});

// Task 8b (follow-on): `by` required, the lineage key bounded, deactivate, distinct history lines.
describe("curve-setups routes, Task 8b", () => {
  /** The sibling routes' sentence for a missing `by` (rules.ts requireBy), restated. */
  const BY_SENTENCE = `"by" is required: a string of 1 to 80 characters naming who makes this change`;
  /** The lineage key sentence, restated: the setup id names its slot, as runSetups.ts bounds a slot id. */
  const KEY_SENTENCE = `the setup's "id" names its slot: 1 to 70 characters from A-Z a-z 0-9 . _ -`;
  const deactivate = (id: string, body: object) => api<{ revision: number }>(t.base, "POST", `/api/workspaces/${id}/curve-setups/deactivate`, body);
  type Hist = Array<{ revision: number; change: Record<string, unknown> }>;
  const history = async (id: string) => (await api<Hist>(t.base, "GET", `/api/workspaces/${id}/history`)).body;

  it("refuses save, activate and deactivate without by, with the sibling routes' sentence, and writes nothing", async () => {
    const w = (await create("ws-cs-by")).body;
    const noBy = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-by/curve-setups", { setup: SETUP, expectedRevision: w.revision });
    expect(noBy.status).toBe(422);
    expect(noBy.body.error.message).toBe(BY_SENTENCE);
    const ok = await save("ws-cs-by", SETUP, w.revision);
    expect(ok.status).toBe(201);
    const actNoBy = await api<ErrBody>(t.base, "POST", `/api/workspaces/ws-cs-by/curve-setups/${ok.body.id}/activate`, { expectedRevision: ok.body.revision });
    expect(actNoBy.status).toBe(422);
    expect(actNoBy.body.error.message).toBe(BY_SENTENCE);
    const act = await activate("ws-cs-by", ok.body.id, ok.body.revision);
    const deNoBy = await deactivate("ws-cs-by", { expectedRevision: act.body.revision });
    expect(deNoBy.status).toBe(422);
    expect((deNoBy.body as unknown as ErrBody).error.message).toBe(BY_SENTENCE);
    const blank = await deactivate("ws-cs-by", { expectedRevision: act.body.revision, by: " " });
    expect(blank.status).toBe(422);
    expect((await head("ws-cs-by")).revision).toBe(act.body.revision);
  });

  it("bounds the lineage key: 70 characters save, 71 or a space are refused in words", async () => {
    const w = (await create("ws-cs-key")).body;
    const at70 = "k".repeat(70);
    const ok = await save("ws-cs-key", { ...SETUP, id: at70 }, w.revision);
    expect(ok.status).toBe(201);
    for (const id of [`${at70}k`, "sofr main"]) {
      const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-key/curve-setups", { setup: { ...SETUP, id }, expectedRevision: ok.body.revision, by: "tester" });
      expect(r.status).toBe(422);
      expect(r.body.refusals).toEqual([KEY_SENTENCE]);
      expect(r.body.error.message).toBe(KEY_SENTENCE);
    }
    expect((await head("ws-cs-key")).revision).toBe(ok.body.revision);
  });

  it("refuses the reserved id platform-default in words, and writes nothing (B2 final I1)", async () => {
    const w = (await create("ws-cs-reserved")).body;
    const store = new FileStore(t.storeRoot);
    const before = store.listMeta("curve-setups").length;
    const sentence = `the curve setup id "platform-default" is reserved for the platform's own curve; pick another id`;
    const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-reserved/curve-setups", { setup: { ...SETUP, id: "platform-default" }, expectedRevision: w.revision, by: "tester" });
    expect(r.status).toBe(422);
    expect(r.body.refusals).toEqual([sentence]);
    expect(r.body.error.message).toBe(sentence);
    expect(store.listMeta("curve-setups").length).toBe(before);
    expect((await head("ws-cs-reserved")).revision).toBe(w.revision);
  });

  it("bounds label and baseCurve at NAME_MAX (80): 80 characters save, 81 are refused in words", async () => {
    const w = (await create("ws-cs-names")).body;
    let revision = w.revision;
    for (const field of ["label", "baseCurve"] as const) {
      const at80 = "n".repeat(80);
      const ok = await save("ws-cs-names", { ...SETUP, id: `names-${field}`, [field]: at80 }, revision);
      expect(ok.status).toBe(201);
      revision = ok.body.revision;
      const sentence = `the setup's "${field}" must be 1 to 80 characters`;
      const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-cs-names/curve-setups", { setup: { ...SETUP, id: `names-${field}-long`, [field]: `${at80}n` }, expectedRevision: revision, by: "tester" });
      expect(r.status).toBe(422);
      expect(r.body.refusals).toEqual([sentence]);
      expect(r.body.error.message).toBe(sentence);
    }
    expect((await head("ws-cs-names")).revision).toBe(revision);
  });

  it("deactivate clears the active pointer, leaving the key out; a second deactivate is 409; stale is 409", async () => {
    const w = (await create("ws-cs-de")).body;
    const ok = await save("ws-cs-de", SETUP, w.revision);
    const act = await activate("ws-cs-de", ok.body.id, ok.body.revision);
    const stale = await deactivate("ws-cs-de", { expectedRevision: ok.body.revision, by: "tester" });
    expect(stale.status).toBe(409);
    const de = await deactivate("ws-cs-de", { expectedRevision: act.body.revision, by: "tester" });
    expect(de.status).toBe(200);
    expect(de.body).toEqual({ revision: act.body.revision + 1 });
    const h = await head("ws-cs-de");
    expect(h.blocks.market.curveSetups).toEqual({ setups: [expect.objectContaining({ lineageKey: "sofr-main" })] });
    expect("active" in h.blocks.market.curveSetups!).toBe(false);
    expect((await list("ws-cs-de")).body.setups.map((s) => s.active)).toEqual([false]);
    const again = await deactivate("ws-cs-de", { expectedRevision: de.body.revision, by: "tester" });
    expect(again.status).toBe(409);
    expect((again.body as unknown as ErrBody).error.message).toBe(`no curve setup is active in workspace "ws-cs-de"; there is nothing to deactivate`);
    // A workspace that never saved a setup has nothing active either.
    const fresh = (await create("ws-cs-de-none")).body;
    expect((await deactivate("ws-cs-de-none", { expectedRevision: fresh.revision, by: "tester" })).status).toBe(409);
    expect((await deactivate("ws-nope", { expectedRevision: 1, by: "tester" })).status).toBe(404);
  });

  it("deactivate on an archived or locked workspace is refused with the slots' own sentences", async () => {
    const w = (await create("ws-cs-de-arch")).body;
    const ok = await save("ws-cs-de-arch", SETUP, w.revision);
    const act = await activate("ws-cs-de-arch", ok.body.id, ok.body.revision);
    const arch = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-cs-de-arch/archive", { expectedRevision: act.body.revision, by: "tester" });
    expect(arch.status).toBe(200);
    const closed = await deactivate("ws-cs-de-arch", { expectedRevision: arch.body.revision, by: "tester" });
    expect(closed.status).toBe(409);
    expect((closed.body as unknown as ErrBody).error.message).toBe(`workspace "ws-cs-de-arch" is archived and read-only; clone it to keep working`);

    const l0 = (await create("ws-cs-de-lock")).body;
    const s = await save("ws-cs-de-lock", SETUP, l0.revision);
    const a = await activate("ws-cs-de-lock", s.body.id, s.body.revision);
    const before = await head("ws-cs-de-lock");
    expect(before.revision).toBe(a.body.revision);
    new WorkspaceStore(t.storeRoot).commit("ws-cs-de-lock", before.revision, "tester", { kind: "lock", approvalId: "ap-test-8b" }, { ...before, status: "locked", lock: { lockedAt: "t", by: "tester", approvalId: "ap-test-8b", signedHash: before.signedHash } });
    const locked = await head("ws-cs-de-lock");
    const refused = await deactivate("ws-cs-de-lock", { expectedRevision: locked.revision, by: "tester" });
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrBody).error.message).toMatch(/^workspace "ws-cs-de-lock" is locked by approval ap-test-8b; /);
    expect((await head("ws-cs-de-lock")).blocks.market.curveSetups!.active).toBe(s.body.id);
  });

  it("activate, an edit-save and deactivate each write a distinct history line; activate keeps its Task 8 line", async () => {
    const w = (await create("ws-cs-hist")).body;
    const first = await save("ws-cs-hist", SETUP, w.revision);
    const act = await activate("ws-cs-hist", first.body.id, first.body.revision);
    const edited = await save("ws-cs-hist", { ...SETUP, interpolation: "cubic-zero" }, act.body.revision);
    expect(edited.status).toBe(201);
    const de = await deactivate("ws-cs-hist", { expectedRevision: edited.body.revision, by: "tester" });
    expect(de.status).toBe(200);
    const lines = (await history("ws-cs-hist")).slice(-4).map((h) => h.change);
    expect(lines).toEqual([
      { kind: "set-block", block: "market", op: "add", ref: { collection: "curve-setups", id: first.body.id } },
      { kind: "set-block", block: "market", op: "set", ref: { collection: "curve-setups", id: first.body.id } },
      { kind: "set-block", block: "market", op: "set", ref: { collection: "curve-setups", id: edited.body.id }, curveSetup: "edit" },
      { kind: "set-block", block: "market", op: "remove", ref: { collection: "curve-setups", id: edited.body.id }, curveSetup: "deactivate" },
    ]);
    // Shape alone tells the activate, edit-save and deactivate lines apart, ids aside.
    const shapes = lines.slice(1).map(({ ref: _ref, ...rest }) => JSON.stringify(rest));
    expect(new Set(shapes).size).toBe(3);
  });

  it("preview writes nothing: the store's curve setup and market counts do not move", async () => {
    const store = new FileStore(t.storeRoot);
    const before = [store.listMeta("curve-setups").length, store.listMeta("market").length];
    expect((await preview({ ...SETUP, id: "never-stored" })).status).toBe(200);
    expect((await preview({ ...SETUP, compounding: "continuous" })).status).toBe(422);
    expect([store.listMeta("curve-setups").length, store.listMeta("market").length]).toEqual(before);
  });
});
