// apps/server/src/__tests__/workspaceClone.test.ts
// Studio A+E Slice 1, Task B5: clone (copy and roll-forward), supersede clone, re-apply of carried
// definitions. Expected values are restated by hand from spec v3.1 Sections 2.3, 2.4 and 2.10;
// none is read back from the code under test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { unprocessable } from "../http/errors";
import { FileStore } from "../store/store";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { blockHashes } from "../workspaces/hashes";
import { orderParentsFirst, reapplyMarket } from "../workspaces/reapply";
import { defaultCloneId, stemOf, supersedeClone } from "../workspaces/clone";
import { api, bootTestPlatform, warmCatalog, type TestPlatform } from "./harness";
import type { CarriedDefinition, WorkspaceManifest } from "../workspaces/types";

// The derive step is the engine's; one test forces a 422 from it, every other test runs it for real.
const hooks = vi.hoisted(() => ({ fail: null as string | null }));
vi.mock("../derivedSets/derivedMarkets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../derivedSets/derivedMarkets")>();
  return {
    ...actual,
    deriveMarketFromStore: (...args: Parameters<typeof actual.deriveMarketFromStore>) => {
      if (hooks.fail !== null) throw unprocessable(hooks.fail);
      return actual.deriveMarketFromStore(...args);
    },
  };
});

interface ErrBody { error: { code: string; message: string; detail?: { expected?: number; actual?: number } } }

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); await seedStore(new FileStore(t.storeRoot), repoRoot()); });
afterAll(() => t.close());
afterEach(() => { hooks.fail = null; vi.restoreAllMocks(); });
const ws = (id: string) => api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`);
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", ...body });
const blocks = (id: string, rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });
const clone = (id: string, rev: number, body: object) => api<{ manifest: WorkspaceManifest; readiness: unknown }>(t.base, "POST", `/api/workspaces/${id}/clone`, { expectedRevision: rev, by: "tester", ...body });
const reapply = (id: string, rev: number) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/market/reapply`, { expectedRevision: rev, by: "tester" });

async function seededSource(id: string) {
  await create({ id });
  await blocks(id, 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.syntheticPortfolio } });
  await blocks(id, 2, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
  await blocks(id, 3, { block: "market", op: "add", ref: { collection: "market", id: "rate-indices-demo-v1" } });
  await blocks(id, 4, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: "demo-behavioral-v1" } });
  return (await ws(id)).body;
}

describe("clone", () => {
  it("copy keeps the date, defaults to Test, carries the checklist and shares setup slots", async () => {
    const src = await seededSource("ws-src-copy");
    const r = await clone("ws-src-copy", src.revision, { mode: "copy", name: "Copy", blocks: ["positions", "market", "assumptions", "run"] });
    expect(r.status).toBe(201);
    const c = r.body.manifest;
    expect(c.id).toMatch(/^ws-src-copy-copy-[0-9a-f]{4}$/);
    expect(c.type).toBe("test"); expect(c.cutoffDate).toBe("2026-03-31");
    expect(c.blocks.positions.book?.id).toBe(SEED_IDS.syntheticPortfolio);
    expect(c.blocks.assumptions.defaultSetId).toBe("demo-behavioral-v1");
    expect(c.blocks.run.setups[0]!.setupLineageId).toBe(src.blocks.run.setups[0]!.setupLineageId);
    expect(c.blocks.run.setups[0]!.current.id).toBe(src.blocks.run.setups[0]!.current.id);
    expect(c.lineage).toEqual(expect.objectContaining({ mode: "copy", fromWorkspaceId: "ws-src-copy", fromSignedHash: src.signedHash }));
    expect((await clone("ws-src-copy", c.revision, { mode: "copy", name: "x", blocks: [], cutoffDate: "2026-04-30" })).status).toBe(422);
  });

  it("roll-forward needs a later date, clears positions and market, carries definitions awaiting, and re-apply derives them on the new base", async () => {
    const src = await seededSource("ws-src-roll");
    expect((await clone("ws-src-roll", src.revision, { mode: "roll-forward", name: "r", cutoffDate: "2026-03-31", blocks: ["market"] })).status).toBe(422);
    const r = await clone("ws-src-roll", src.revision, { mode: "roll-forward", name: "April", cutoffDate: "2026-04-30", blocks: ["positions", "market", "assumptions", "run"] });
    expect(r.status).toBe(201);
    const c = r.body.manifest;
    expect(c.id).toBe("ws-src-roll--2026-04-30"); expect(c.type).toBe("monthly");
    expect(c.blocks.positions.book).toBeNull(); expect(c.blocks.market.snapshot).toBeNull(); expect(c.blocks.market.derived).toEqual([]);
    expect(c.blocks.market.carried).toEqual([expect.objectContaining({ definitionKey: "rate-indices-demo-v1", parentKey: null, status: "awaiting" })]);
    // Re-apply on the same public base (a same-date base is what the scratch store has); the derive is content-addressed.
    const set = await blocks(c.id, c.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    expect(set.status).toBe(201);   // Monthly type: clash warned, not refused
    await warmCatalog(t.base);
    const re = await reapply(c.id, set.body.revision);
    expect(re.status).toBe(200);
    expect(re.body.blocks.market.carried[0]!.status).toBe("applied");
    const applied = re.body.blocks.market.derived[0]!;
    expect(applied.definitionKey).toBe("rate-indices-demo-v1");
    expect(applied.id).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    // The derived market is mirrored at once: the catalog answers for it with no re-sync.
    expect((await api(t.base, "GET", `/api/catalog/markets/${applied.id}`)).status).toBe(200);
    const again = await reapply(c.id, re.body.revision);
    expect(again.status).toBe(200); expect(again.body.blocks.market.derived).toHaveLength(1);
  });

  it("a macro definition re-applies against the pinned ops: the route shape is applied or refused, never lost", async () => {
    await create({ id: "ws-macro-src" });
    await blocks("ws-macro-src", 1, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await blocks("ws-macro-src", 2, { block: "market", op: "add", ref: { collection: "market", id: "macro-demo-v1" } });
    const src = (await ws("ws-macro-src")).body;
    const c = (await clone("ws-macro-src", src.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-04-30", blocks: ["market"] })).body.manifest;
    const set = await blocks(c.id, c.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const re = await reapply(c.id, set.body.revision);
    expect(re.status).toBe(200);
    expect(["applied", "refused"]).toContain(re.body.blocks.market.carried[0]!.status);
  });

  it("supersede clone needs the flag, writes in three steps, marks the source and satisfies uniqueness; a crash after step 1 is completed forward at boot", async () => {
    await create({ id: "ws-p-src", type: "production", cutoffDate: "2026-06-30" });
    const src = (await ws("ws-p-src")).body;
    const noFlag = await clone("ws-p-src", src.revision, { mode: "copy", name: "fix", type: "production", blocks: [] });
    expect(noFlag.status).toBe(409); expect(noFlag.text).toMatch(/supersedeSource/);
    const r = await clone("ws-p-src", src.revision, { mode: "copy", name: "fix", type: "production", blocks: [], supersedeSource: true, id: "ws-p-fix" });
    expect(r.status).toBe(201);
    expect(r.body.manifest.lineage.pendingSupersede).toBe(false);
    const after = (await ws("ws-p-src")).body;
    expect(after.status).toBe("superseded"); expect(after.lineage.supersededBy).toBe("ws-p-fix");
    expect((await blocks("ws-p-src", after.revision, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } })).status).toBe(409);
    // Crash after step 1: a clone head left pending with its source untouched. Reconcile completes forward.
    await create({ id: "ws-p2-src", type: "production", cutoffDate: "2026-07-31" });
    const store = new WorkspaceStore(t.storeRoot);
    const pending = { ...store.head("ws-p2-src"), id: "ws-p2-fix", name: "fix", lineage: { mode: "supersede", fromWorkspaceId: "ws-p2-src", fromSignedHash: store.head("ws-p2-src").signedHash, carried: [], supersededBy: null, pendingSupersede: true } } as WorkspaceManifest;
    store.create(pending, "tester");
    const report = new WorkspaceStore(t.storeRoot).reconcileAll(new FileStore(t.storeRoot));
    expect(report.completedSupersedes).toEqual(["ws-p2-fix"]);
    const fixed = new WorkspaceStore(t.storeRoot);
    expect(fixed.head("ws-p2-src").status).toBe("superseded");
    expect(fixed.head("ws-p2-fix").lineage.pendingSupersede).toBe(false);
    expect(fixed.history("ws-p2-src").at(-1)!.reconciled).toBe(true);
  });

  it("twelve roll-forwards keep every id under 64 characters and the definitionKey fixed", async () => {
    let cur = await seededSource("ws-synthetic-2500-indexed-v1");
    for (let m = 4; m <= 15; m++) {
      const y = m <= 12 ? 2026 : 2027; const mm = String(((m - 1) % 12) + 1).padStart(2, "0");
      const last = new Date(Date.UTC(y, Number(mm), 0)).toISOString().slice(0, 10);
      const r = await clone(cur.id, cur.revision, { mode: "roll-forward", name: "n", cutoffDate: last, blocks: ["market", "assumptions", "run"] });
      expect(r.status).toBe(201);
      cur = r.body.manifest;
      expect(cur.id.length).toBeLessThanOrEqual(64);
      expect(cur.blocks.market.carried[0]!.definitionKey).toBe("rate-indices-demo-v1");
    }
    expect(cur.id).toBe("ws-synthetic-2500-indexed-v1--2027-03-31");
    expect(cur.id.length).toBe(40);
  });
});

describe("clone refusals and defaults", () => {
  it("answers 404 for an unknown source, and 422 for a bad mode, an unknown block or a missing by", async () => {
    expect((await clone("ws-no-such", 1, { mode: "copy", name: "x", blocks: [] })).status).toBe(404);
    const src = await seededSource("ws-ref-src");
    expect((await clone("ws-ref-src", src.revision, { mode: "rename", name: "x", blocks: [] })).status).toBe(422);
    expect((await clone("ws-ref-src", src.revision, { mode: "copy", name: "x", blocks: ["nonsense"] })).status).toBe(422);
    expect((await clone("ws-ref-src", src.revision, { mode: "copy", name: "x" })).status).toBe(422);
    const noBy = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-ref-src/clone", { expectedRevision: src.revision, mode: "copy", name: "x", blocks: [] });
    expect(noBy.status).toBe(422);
    expect(noBy.text).toMatch(/\bby\b/);
  });

  it("a stale expectedRevision is a 409 carrying both numbers, and nothing is written", async () => {
    const src = await seededSource("ws-stale-src");
    const r = await api<ErrBody>(t.base, "POST", "/api/workspaces/ws-stale-src/clone", { expectedRevision: src.revision - 1, by: "tester", mode: "copy", name: "x", blocks: [], id: "ws-stale-copy" });
    expect(r.status).toBe(409);
    expect(r.body.error.detail).toEqual({ expected: src.revision - 1, actual: src.revision });
    expect((await ws("ws-stale-copy")).status).toBe(404);
  });

  it("a taken explicit id is a 409, and a taken roll-forward default appends four hex", async () => {
    const src = await seededSource("ws-taken-src");
    const first = await clone("ws-taken-src", src.revision, { mode: "roll-forward", name: "a", cutoffDate: "2026-04-30", blocks: [] });
    expect(first.body.manifest.id).toBe("ws-taken-src--2026-04-30");
    const second = await clone("ws-taken-src", src.revision, { mode: "roll-forward", name: "b", cutoffDate: "2026-04-30", blocks: [] });
    expect(second.status).toBe(201);
    expect(second.body.manifest.id).toMatch(/^ws-taken-src--2026-04-30-[0-9a-f]{4}$/);
    expect((await clone("ws-taken-src", src.revision, { mode: "copy", name: "c", blocks: [], id: "ws-taken-src--2026-04-30" })).status).toBe(409);
  });

  it("an unticked run block gets a fresh Standard ALCO slot, an unticked market block starts empty, and copy carries the clash line of a ticked block only", async () => {
    // Re-cut-off: a Test workspace at 2026-02-28 holds the 2026-03-31 documents with a warned clash each.
    await create({ id: "ws-clash-feb", cutoffDate: "2026-02-28" });
    const b2 = await blocks("ws-clash-feb", 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.syntheticPortfolio } });
    const m2 = await blocks("ws-clash-feb", b2.body.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    expect(m2.body.clashes.map((c) => c.block).sort()).toEqual(["market", "positions"]);
    const c = await clone("ws-clash-feb", m2.body.revision, { mode: "copy", name: "pos only", blocks: ["positions"] });
    expect(c.status).toBe(201);
    expect(c.body.manifest.clashes.map((x) => x.block)).toEqual(["positions"]);
    expect(c.body.manifest.blocks.market.snapshot).toBeNull();
    expect(c.body.manifest.blocks.run.setups).toHaveLength(1);
    expect(c.body.manifest.blocks.run.setups[0]!.setupLineageId).toMatch(/^setup-[0-9a-f]{8}$/);
    expect(c.body.manifest.blocks.run.setups[0]!.setupLineageId).not.toBe(m2.body.blocks.run.setups[0]!.setupLineageId);
    // The clash rule holds on clone: a Production clone of a clashed book is refused.
    const prod = await clone("ws-clash-feb", m2.body.revision, { mode: "copy", name: "prod", type: "production", blocks: ["positions"] });
    expect(prod.status).toBe(422);
    expect(prod.text).toMatch(/2026-03-31/);
  });

  it("a Production copy refuses only a clash whose document is still pinned; a stale clash record does not block (review B m4)", async () => {
    await create({ id: "ws-stale-clash", cutoffDate: "2027-05-31" });
    const off = await blocks("ws-stale-clash", 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.syntheticPortfolio } });
    expect(off.body.clashes).toEqual([expect.objectContaining({ block: "positions", id: SEED_IDS.syntheticPortfolio, documentAsOf: "2026-03-31" })]);
    // Still pinned: refused.
    const pinned = await clone("ws-stale-clash", off.body.revision, { mode: "copy", name: "prod", type: "production", blocks: ["positions"] });
    expect(pinned.status).toBe(422); expect(pinned.text).toMatch(SEED_IDS.syntheticPortfolio);
    // Replace the book with one dated at the cut-off: the clash record stays (append-only) but no longer blocks.
    const book = (await api<Record<string, unknown>>(t.base, "GET", `/api/portfolios/${SEED_IDS.vanillaPortfolio}`)).body;
    const imp = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-stale-clash&by=tester", { ...book, id: "imp-stale-clash", label: "imp", asOf: "2027-05-31" });
    expect(imp.status).toBe(201);
    const src = (await ws("ws-stale-clash")).body;
    expect(src.blocks.positions.book?.id).toBe("imp-stale-clash");
    expect(src.clashes).toHaveLength(1);
    const ok = await clone("ws-stale-clash", src.revision, { mode: "copy", name: "prod", type: "production", blocks: ["positions"], id: "ws-stale-clash-prod" });
    expect(ok.status).toBe(201);
    expect(ok.body.manifest.type).toBe("production");
    expect(ok.body.manifest.blocks.positions.book?.id).toBe("imp-stale-clash");
  });

  it("supersedeSource is refused off the Production copy path, and on an archived or already superseded source", async () => {
    await create({ id: "ws-ss-prod", type: "production", cutoffDate: "2026-08-31" });
    const p = (await ws("ws-ss-prod")).body;
    const toTest = await clone("ws-ss-prod", p.revision, { mode: "copy", name: "x", type: "test", blocks: [], supersedeSource: true });
    expect(toTest.status).toBe(422);
    const roll = await clone("ws-ss-prod", p.revision, { mode: "roll-forward", name: "x", cutoffDate: "2026-09-30", type: "production", blocks: [], supersedeSource: true });
    expect(roll.status).toBe(422);
    // A roll-forward into Production at a new date is an ordinary new Production month, no supersede.
    const nextMonth = await clone("ws-ss-prod", p.revision, { mode: "roll-forward", name: "Sep", cutoffDate: "2026-09-30", type: "production", blocks: [] });
    expect(nextMonth.status).toBe(201);
    expect((await ws("ws-ss-prod")).body.status).toBe("active");
    // Archived source: refused 409.
    await create({ id: "ws-ss-arch", type: "production", cutoffDate: "2026-10-31" });
    const arch = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-ss-arch/archive", { expectedRevision: 1, by: "tester" });
    const refused = await clone("ws-ss-arch", arch.body.revision, { mode: "copy", name: "x", type: "production", blocks: [], supersedeSource: true });
    expect(refused.status).toBe(409);
  });

  it("a locked Production source supersedes by clone: the source keeps its lock and approval, the clone is active", async () => {
    await create({ id: "ws-lock-src", type: "production", cutoffDate: "2026-11-30" });
    const w = t.platform.context.workspaces;
    const h = w.head("ws-lock-src");
    const locked = w.commit("ws-lock-src", h.revision, "tester", { kind: "lock", approvalId: "ap-1" }, {
      ...h, status: "locked", lock: { lockedAt: "2026-11-30T00:00:00.000Z", by: "tester", approvalId: "ap-1", signedHash: h.signedHash },
    });
    expect(locked.signedHash).toBe(h.signedHash);
    const noFlag = await clone("ws-lock-src", locked.revision, { mode: "copy", name: "fix", type: "production", blocks: [] });
    expect(noFlag.status).toBe(409);
    const ok = await clone("ws-lock-src", locked.revision, { mode: "copy", name: "fix", type: "production", blocks: [], supersedeSource: true, id: "ws-lock-fix" });
    expect(ok.status).toBe(201);
    expect(ok.body.manifest.status).toBe("active");
    expect(ok.body.manifest.lock).toBeNull();
    expect(ok.body.manifest.lineage).toEqual(expect.objectContaining({ mode: "supersede", fromWorkspaceId: "ws-lock-src", fromSignedHash: h.signedHash, pendingSupersede: false }));
    const src = (await ws("ws-lock-src")).body;
    expect(src.status).toBe("superseded");
    expect(src.lock?.approvalId).toBe("ap-1");
    expect(src.lineage.supersededBy).toBe("ws-lock-fix");
    expect(src.signedHash).toBe(h.signedHash);
    const lines = t.platform.context.workspaces.history("ws-lock-src");
    expect(lines.at(-1)!.change).toEqual({ kind: "supersede", by: "ws-lock-fix" });
    // Uniqueness now holds for the clone and the superseded source is out of the count.
    expect((await create({ id: "ws-lock-dup", type: "production", cutoffDate: "2026-11-30" })).status).toBe(409);
  });
});

describe("identifier helpers", () => {
  it("stemOf strips trailing -copy-<hex> and --date (with an optional four-hex suffix) until none remains, then truncates to 40", () => {
    expect(stemOf("ws-a-copy-1a2b")).toBe("ws-a");
    expect(stemOf("ws-a--2026-04-30")).toBe("ws-a");
    expect(stemOf("ws-a--2026-04-30-ab12")).toBe("ws-a");
    expect(stemOf("ws-a-copy-1a2b--2026-04-30")).toBe("ws-a");
    expect(stemOf("ws-a-copy")).toBe("ws-a-copy");
    expect(stemOf("x".repeat(50))).toBe("x".repeat(40));
  });
  it("defaultCloneId builds the two default shapes of spec Section 2.10", () => {
    expect(defaultCloneId("ws-a--2026-04-30", "roll-forward", "2026-05-31", "t")).toBe("ws-a--2026-05-31");
    expect(defaultCloneId("ws-a--2026-04-30", "copy", "2026-04-30", "t")).toMatch(/^ws-a-copy-[0-9a-f]{4}$/);
    expect(defaultCloneId("x".repeat(60), "roll-forward", "2026-05-31", "t")).toBe(`${"x".repeat(40)}--2026-05-31`);
  });
});

/** A derived market off the seeded funding spread shock: the child of a two-link chain. Idempotent (200 on a re-save). */
async function ensureChild(): Promise<void> {
  const child = await api(t.base, "POST", "/api/market/derive", { baseId: "tlp-shock-demo-v1", ops: [{ op: "add", value: 10 }], id: "ae1-b5-child-shock-v1" });
  expect([200, 201]).toContain(child.status);
}

describe("re-apply", () => {
  it("applies a parent before its child, the child deriving on the parent's applied market, and keeps both definitionKeys", async () => {
    await ensureChild();
    await create({ id: "ws-roll-src" });
    await blocks("ws-roll-src", 1, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await blocks("ws-roll-src", 2, { block: "market", op: "add", ref: { collection: "market", id: "tlp-shock-demo-v1" } });
    const withChild = await blocks("ws-roll-src", 3, { block: "market", op: "add", ref: { collection: "market", id: "ae1-b5-child-shock-v1" } });
    expect(withChild.body.blocks.market.derived.map((d) => [d.definitionKey, d.parentKey])).toEqual([
      ["tlp-shock-demo-v1", null], ["ae1-b5-child-shock-v1", "tlp-shock-demo-v1"],
    ]);
    const rolled = (await clone("ws-roll-src", withChild.body.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-04-30", blocks: ["market"] })).body.manifest;
    expect(rolled.blocks.market.carried.map((c) => [c.definitionKey, c.parentKey, c.status])).toEqual([
      ["tlp-shock-demo-v1", null, "awaiting"], ["ae1-b5-child-shock-v1", "tlp-shock-demo-v1", "awaiting"],
    ]);
    const set = await blocks(rolled.id, rolled.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const re = await reapply(rolled.id, set.body.revision);
    expect(re.status).toBe(200);
    const m = re.body.blocks.market;
    expect(m.carried.map((c) => c.status)).toEqual(["applied", "applied"]);
    expect(m.derived.map((d) => [d.definitionKey, d.parentKey])).toEqual([["tlp-shock-demo-v1", null], ["ae1-b5-child-shock-v1", "tlp-shock-demo-v1"]]);
    // The child's market was derived on the parent's applied id, not on the base.
    const store = new FileStore(t.storeRoot);
    const childDoc = store.getDocument<{ derivedFrom: { baseId: string; ops: unknown[] } }>("market", m.derived[1]!.id).doc;
    expect(childDoc.derivedFrom.baseId).toBe(m.derived[0]!.id);
    expect(childDoc.derivedFrom.ops).toEqual([{ op: "add", value: 10 }]);
    expect(m.carried[1]!.appliedId).toBe(m.derived[1]!.id);
    // One history line for the call.
    const lines = t.platform.context.workspaces.history(rolled.id);
    expect(lines.at(-1)!.revision).toBe(re.body.revision);
    expect(lines.at(-1)!.change.kind).toBe("reapply");
    expect(re.body.revision).toBe(set.body.revision + 1);
  });

  it("carried definitions keep resolving over successive roll-forwards: the key and the content-addressed id do not move", async () => {
    const src = await seededSource("ws-keep-src");
    const r1 = (await clone("ws-keep-src", src.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-04-30", blocks: ["market", "run"] })).body.manifest;
    const s1 = await blocks(r1.id, r1.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const a1 = (await reapply(r1.id, s1.body.revision)).body;
    const d1 = a1.blocks.market.derived[0]!;
    expect(d1.definitionKey).toBe("rate-indices-demo-v1");
    const r2 = (await clone(r1.id, a1.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-05-31", blocks: ["market", "run"] })).body.manifest;
    expect(r2.id).toBe("ws-keep-src--2026-05-31");
    expect(r2.blocks.market.carried).toEqual([
      { definitionKey: "rate-indices-demo-v1", parentKey: null, source: expect.objectContaining({ collection: "market", id: d1.id, contentHash: d1.contentHash }), status: "awaiting", appliedId: null, refusal: null },
    ]);
    expect(r2.blocks.run.setups[0]!.setupLineageId).toBe(src.blocks.run.setups[0]!.setupLineageId);
    const s2 = await blocks(r2.id, r2.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const a2 = (await reapply(r2.id, s2.body.revision)).body;
    expect(a2.blocks.market.derived[0]!.id).toBe(d1.id);
    expect(a2.blocks.market.derived[0]!.definitionKey).toBe("rate-indices-demo-v1");
  });

  it("an awaiting definition rolls forward again untouched when the new month never re-applied it", async () => {
    const src = await seededSource("ws-await-src");
    const r1 = (await clone("ws-await-src", src.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-04-30", blocks: ["market"] })).body.manifest;
    const r2 = (await clone(r1.id, r1.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-05-31", blocks: ["market"] })).body.manifest;
    expect(r2.blocks.market.carried).toHaveLength(1);
    expect(r2.blocks.market.carried[0]).toEqual(r1.blocks.market.carried[0]);
    expect(r2.blocks.market.carriedFrom).toEqual(expect.objectContaining({ workspaceId: r1.id }));
  });

  it("is refused with no snapshot (422), with nothing carried (422) and on a locked workspace (409), and an answer with nothing awaiting writes no line", async () => {
    const src = await seededSource("ws-ra-src");
    const r1 = (await clone("ws-ra-src", src.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-04-30", blocks: ["market"] })).body.manifest;
    expect((await reapply(r1.id, r1.revision)).status).toBe(422);
    const plain = (await create({ id: "ws-ra-plain" })).body;
    expect((await reapply(plain.id, plain.revision)).status).toBe(422);
    const s = await blocks(r1.id, r1.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    const done = (await reapply(r1.id, s.body.revision)).body;
    const again = await reapply(r1.id, done.revision);
    expect(again.status).toBe(200);
    expect(again.body.revision).toBe(done.revision);
    expect((await reapply(r1.id, done.revision - 1)).status).toBe(409);
  });

  it("a failing commit after the derived document is stored leaves the entry awaiting; the retry reuses the stored document", async () => {
    const src = await seededSource("ws-orphan-src");
    const r1 = (await clone("ws-orphan-src", src.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-04-30", blocks: ["market"] })).body.manifest;
    const s = (await blocks(r1.id, r1.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } })).body;
    const store = new FileStore(t.storeRoot);
    const w = t.platform.context.workspaces;
    const spy = vi.spyOn(w, "commit").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect((await reapply(r1.id, s.revision)).status).toBe(500);
    spy.mockRestore();
    const mid = (await ws(r1.id)).body;
    expect(mid.revision).toBe(s.revision);
    expect(mid.blocks.market.carried[0]!.status).toBe("awaiting");
    expect(mid.blocks.market.derived).toEqual([]);
    const orphans = store.listMeta("market").filter((m) => /^derived-mk-[0-9a-f]{12}$/.test(m.id));
    expect(orphans.length).toBeGreaterThan(0);
    const before = orphans.length;
    const ok = await reapply(r1.id, s.revision);
    expect(ok.status).toBe(200);
    expect(ok.body.blocks.market.carried[0]!.status).toBe("applied");
    expect(store.listMeta("market").filter((m) => /^derived-mk-[0-9a-f]{12}$/.test(m.id))).toHaveLength(before);
  });

  it("an engine refusal is recorded as refused with the engine's text, the child stays awaiting, and a later call retries the refused entry", async () => {
    await ensureChild();
    await create({ id: "ws-refuse-src" });
    await blocks("ws-refuse-src", 1, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await blocks("ws-refuse-src", 2, { block: "market", op: "add", ref: { collection: "market", id: "tlp-shock-demo-v1" } });
    const withChild = await blocks("ws-refuse-src", 3, { block: "market", op: "add", ref: { collection: "market", id: "ae1-b5-child-shock-v1" } });
    const rolled = (await clone("ws-refuse-src", withChild.body.revision, { mode: "roll-forward", name: "n", cutoffDate: "2026-04-30", blocks: ["market"] })).body.manifest;
    const set = await blocks(rolled.id, rolled.revision, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    hooks.fail = "macro history ends at 2026-03-31; the new as-of month has no history";
    const re = await reapply(rolled.id, set.body.revision);
    expect(re.status).toBe(200);
    const c = re.body.blocks.market.carried;
    expect(c[0]).toEqual(expect.objectContaining({ definitionKey: "tlp-shock-demo-v1", status: "refused", appliedId: null, refusal: "macro history ends at 2026-03-31; the new as-of month has no history" }));
    expect(c[1]).toEqual(expect.objectContaining({ definitionKey: "ae1-b5-child-shock-v1", parentKey: "tlp-shock-demo-v1", status: "awaiting", refusal: null }));
    expect(re.body.blocks.market.derived).toEqual([]);
    const line = t.platform.context.workspaces.history(rolled.id).at(-1)!;
    expect(line.change).toEqual({ kind: "reapply", definitionKey: "tlp-shock-demo-v1", appliedId: null, refusal: "macro history ends at 2026-03-31; the new as-of month has no history" });
    // The same refusal again changes nothing: no new line.
    const same = await reapply(rolled.id, re.body.revision);
    expect(same.body.revision).toBe(re.body.revision);
    // The engine accepts on a later call: the refused entry applies, then its child.
    hooks.fail = null;
    const later = await reapply(rolled.id, re.body.revision);
    expect(later.body.blocks.market.carried.map((x) => x.status)).toEqual(["applied", "applied"]);
    expect(later.body.blocks.market.derived).toHaveLength(2);
  });
});

describe("orderParentsFirst", () => {
  const entry = (definitionKey: string, parentKey: string | null): CarriedDefinition => ({
    definitionKey, parentKey, source: { collection: "market", id: definitionKey, contentHash: "h", pinnedAt: "t" }, status: "awaiting", appliedId: null, refusal: null,
  });
  it("places every parent before its children, keeps the list order otherwise, and does not drop a cycle", () => {
    expect(orderParentsFirst([entry("c", "b"), entry("b", "a"), entry("a", null), entry("z", null)]).map((e) => e.definitionKey)).toEqual(["a", "z", "b", "c"]);
    expect(orderParentsFirst([entry("x", "missing"), entry("y", null)]).map((e) => e.definitionKey)).toEqual(["x", "y"]);
    expect(orderParentsFirst([entry("p", "q"), entry("q", "p")]).map((e) => e.definitionKey).sort()).toEqual(["p", "q"]);
  });
});

describe("reapplyMarket without the HTTP layer", () => {
  it("returns a null change and the same block when no snapshot-ready entry is awaiting", () => {
    const store = { findPinned: () => null } as unknown as FileStore;
    const head = { blocks: { market: { snapshot: { collection: "market", id: "b", contentHash: "h", pinnedAt: "t" }, derived: [], carried: [], carriedFrom: null } } } as unknown as WorkspaceManifest;
    const r = reapplyMarket(store, head, "now");
    expect(r.change).toBeNull();
    expect(r.market).toEqual(head.blocks.market);
  });
  it("records a pin that resolves nowhere as refused, with the id in the text", () => {
    const store = { findPinned: () => null } as unknown as FileStore;
    const head = { blocks: { market: {
      snapshot: { collection: "market", id: "b", contentHash: "h", pinnedAt: "t" }, derived: [], carriedFrom: null,
      carried: [{ definitionKey: "k", parentKey: null, source: { collection: "market", id: "gone-v1", contentHash: "h0", pinnedAt: "t" }, status: "awaiting", appliedId: null, refusal: null }],
    } } } as unknown as WorkspaceManifest;
    const r = reapplyMarket(store, head, "now");
    expect(r.market.carried[0]!.status).toBe("refused");
    expect(r.market.carried[0]!.refusal).toMatch(/gone-v1/);
    expect(r.change).toEqual({ kind: "reapply", definitionKey: "k", appliedId: null, refusal: r.market.carried[0]!.refusal });
  });
});

// ---------------------------------------------------------------------------
// Crash order, at the store level (no HTTP): each failing step leaves a state reconcile completes forward.
// ---------------------------------------------------------------------------

describe("crash order", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots.length = 0; });
  const root = () => { const r = mkdtempSync(join(tmpdir(), "ae1-b5-")); roots.push(r); return r; };
  function blank(id: string, type: WorkspaceManifest["type"] = "production"): WorkspaceManifest {
    const b = { market: { snapshot: null, derived: [], carried: [], carriedFrom: null }, positions: { book: null, retagged: [], coa: null, taxonomy: null, hierarchies: [] }, targets: { balancePlans: [], templates: [] }, assumptions: { sets: [], defaultSetId: null, routingPolicy: null }, scenarios: { slates: [] }, run: { setups: [], lenses: [] } };
    return { schemaVersion: "1.0.0", id, name: id, type, status: "active", cutoffDate: "2026-06-30", owner: "o", createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z", revision: 0, blocks: b, blockHashes: blockHashes(b as never), signedHash: "", manifestHash: "", lineage: { mode: "blank", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false }, clashes: [], lock: null, note: "" } as unknown as WorkspaceManifest;
  }
  function pair(r: string) {
    const w = new WorkspaceStore(r); const fs = new FileStore(r); fs.init();
    const src = w.create(blank("ws-src"), "tester");
    const clone: WorkspaceManifest = { ...src, id: "ws-fix", name: "fix", lineage: { mode: "supersede", fromWorkspaceId: "ws-src", fromSignedHash: src.signedHash, carried: [], supersededBy: null, pendingSupersede: true } };
    return { w, fs, src, clone };
  }

  it("a failure at step 1 leaves the source untouched and no clone behind", () => {
    const { w, src, clone } = pair(root());
    vi.spyOn(w, "create").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => supersedeClone(w, src, clone, "tester")).toThrow("disk full");
    expect(w.has("ws-fix")).toBe(false);
    expect(w.head("ws-src").status).toBe("active");
    expect(w.head("ws-src").revision).toBe(src.revision);
  });

  it("a failure at step 2 leaves a complete pending clone and an untouched source; reconcile marks the source and clears the flag, both lines reconciled", () => {
    const r = root();
    const { w, src, clone } = pair(r);
    vi.spyOn(w, "commit").mockImplementationOnce(() => { throw new Error("crash"); });
    expect(() => supersedeClone(w, src, clone, "tester")).toThrow("crash");
    const fresh = new WorkspaceStore(r);
    expect(fresh.head("ws-fix").lineage.pendingSupersede).toBe(true);
    expect(fresh.head("ws-src").status).toBe("active");
    const rep = fresh.reconcileAll(new FileStore(r));
    expect(rep.completedSupersedes).toEqual(["ws-fix"]);
    expect(fresh.head("ws-src").status).toBe("superseded");
    expect(fresh.head("ws-src").lineage.supersededBy).toBe("ws-fix");
    expect(fresh.history("ws-src").at(-1)).toEqual(expect.objectContaining({ by: "tester", reconciled: true, change: { kind: "supersede", by: "ws-fix" } }));
    expect(fresh.head("ws-fix").lineage.pendingSupersede).toBe(false);
    expect(fresh.history("ws-fix").at(-1)!.reconciled).toBe(true);
    // Nothing is left to complete on the next boot.
    expect(new WorkspaceStore(r).reconcileAll(new FileStore(r)).completedSupersedes).toEqual([]);
  });

  it("a failure at step 3 leaves the source marked and the clone pending; reconcile clears only the flag", () => {
    const r = root();
    const { w, src, clone } = pair(r);
    const real = w.commit.bind(w);
    let n = 0;
    vi.spyOn(w, "commit").mockImplementation((...a: Parameters<typeof real>) => { n++; if (n === 2) throw new Error("crash"); return real(...a); });
    expect(() => supersedeClone(w, src, clone, "tester")).toThrow("crash");
    const fresh = new WorkspaceStore(r);
    expect(fresh.head("ws-src").status).toBe("superseded");
    expect(fresh.head("ws-fix").lineage.pendingSupersede).toBe(true);
    const lastSource = fresh.history("ws-src").at(-1)!;
    expect(lastSource.reconciled).toBeUndefined();
    const rep = fresh.reconcileAll(new FileStore(r));
    expect(rep.completedSupersedes).toEqual(["ws-fix"]);
    expect(fresh.head("ws-fix").lineage.pendingSupersede).toBe(false);
    expect(fresh.history("ws-fix").at(-1)!.reconciled).toBe(true);
    expect(fresh.history("ws-src").at(-1)!.revision).toBe(lastSource.revision);
  });

  it("a clone whose head write was lost is complete from its history line: the head is rebuilt, the source is never written", () => {
    const r = root();
    const w = new WorkspaceStore(r); const fs = new FileStore(r); fs.init();
    const src = w.create(blank("ws-src", "test"), "tester");
    const rolled: WorkspaceManifest = { ...src, id: "ws-src--2026-07-31", cutoffDate: "2026-07-31", lineage: { mode: "roll-forward", fromWorkspaceId: "ws-src", fromSignedHash: src.signedHash, carried: ["market"], supersededBy: null, pendingSupersede: false } };
    w.create(rolled, "tester");
    // The head write is the last step of create; lose it.
    rmSync(join(r, "workspaces", "ws-src--2026-07-31", "manifest.json"));
    const fresh = new WorkspaceStore(r);
    expect(fresh.head("ws-src--2026-07-31").cutoffDate).toBe("2026-07-31");
    expect(fresh.head("ws-src--2026-07-31").lineage.mode).toBe("roll-forward");
    expect(fresh.head("ws-src").revision).toBe(src.revision);
  });
});

// Saved curve setups live on the market block and travel with it whole.
describe("clone carries saved curve setups (Piece B, step B1)", () => {
  /** A valid setup restated by hand: two cash rows and two whole-year annual swaps, ACT/360 annual. */
  const SETUP = {
    id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual",
    inputs: [
      { instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.043 },
      { instrument: "cash", tenorMonths: 3, quoteType: "par-rate", value: 0.0435 },
      { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
      { instrument: "ois-swap", tenorMonths: 60, quoteType: "par-rate", value: 0.0385 },
    ],
  };

  async function withActiveSetup(id: string) {
    const src = await seededSource(id);
    const saved = await api<{ id: string; revision: number }>(t.base, "POST", `/api/workspaces/${id}/curve-setups`, { setup: SETUP, expectedRevision: src.revision, by: "tester" });
    expect(saved.status).toBe(201);
    const act = await api<{ revision: number }>(t.base, "POST", `/api/workspaces/${id}/curve-setups/${saved.body.id}/activate`, { expectedRevision: saved.body.revision, by: "tester" });
    expect(act.status).toBe(200);
    const head = (await ws(id)).body;
    expect(head.blocks.market.curveSetups).toEqual({ setups: [expect.objectContaining({ lineageKey: "sofr-main" })], active: saved.body.id });
    return { head, setupId: saved.body.id };
  }

  it("copy carries the setups and the active pointer whole, so the clone's market hash equals the source's", async () => {
    const { head, setupId } = await withActiveSetup("ws-cs-copy");
    const r = await clone("ws-cs-copy", head.revision, { mode: "copy", name: "Copy", blocks: ["positions", "market", "assumptions", "run"] });
    expect(r.status).toBe(201);
    const c = r.body.manifest;
    expect(c.blocks.market.curveSetups).toEqual(head.blocks.market.curveSetups);
    expect(c.blocks.market.curveSetups!.active).toBe(setupId);
    expect(c.blockHashes.market).toBe(head.blockHashes.market);
  });

  it("roll-forward carries the setups and the active pointer forward while it clears the snapshot and derived markets", async () => {
    const { head, setupId } = await withActiveSetup("ws-cs-roll");
    const r = await clone("ws-cs-roll", head.revision, { mode: "roll-forward", name: "April", cutoffDate: "2026-04-30", blocks: ["positions", "market", "assumptions", "run"] });
    expect(r.status).toBe(201);
    const c = r.body.manifest;
    expect(c.blocks.market.snapshot).toBeNull();
    expect(c.blocks.market.derived).toEqual([]);
    expect(c.blocks.market.curveSetups).toEqual(head.blocks.market.curveSetups);
    expect(c.blocks.market.curveSetups!.active).toBe(setupId);
    // The carried setup lists from the clone as it did from the source.
    const listed = await api<{ setups: Array<{ id: string; active: boolean }> }>(t.base, "GET", `/api/workspaces/${c.id}/curve-setups`);
    expect(listed.status).toBe(200);
    expect(listed.body.setups).toEqual([expect.objectContaining({ id: setupId, active: true })]);
  });

  it("an unticked market block starts with no curve setups key at all", async () => {
    const { head } = await withActiveSetup("ws-cs-none");
    const r = await clone("ws-cs-none", head.revision, { mode: "copy", name: "No market", blocks: ["positions", "assumptions", "run"] });
    expect(r.status).toBe(201);
    expect("curveSetups" in r.body.manifest.blocks.market).toBe(false);
    expect(r.body.manifest.blockHashes.market).toBe(blockHashes(r.body.manifest.blocks).market);
  });
});

// Saved derived curves live on the market block and travel with it whole.
describe("clone carries saved derived curves (Piece B, step B2)", () => {
  const CURVE = { id: "sofr-ust", label: "SOFR over UST", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: 7.5 }] };

  async function withCurve(id: string) {
    const src = await seededSource(id);
    const saved = await api<{ id: string; revision: number }>(t.base, "POST", `/api/workspaces/${id}/derived-curves`, { curve: CURVE, expectedRevision: src.revision, by: "tester" });
    expect(saved.status).toBe(201);
    const head = (await ws(id)).body;
    expect(head.blocks.market.derivedCurves).toEqual({ curves: [expect.objectContaining({ lineageKey: "sofr-ust" })] });
    return { head, docId: saved.body.id };
  }

  it("copy carries the curves whole, so the clone's market hash equals the source's", async () => {
    const { head } = await withCurve("ws-dc-copy");
    const r = await clone("ws-dc-copy", head.revision, { mode: "copy", name: "Copy", blocks: ["positions", "market", "assumptions", "run"] });
    expect(r.status).toBe(201);
    expect(r.body.manifest.blocks.market.derivedCurves).toEqual(head.blocks.market.derivedCurves);
    expect(r.body.manifest.blockHashes.market).toBe(head.blockHashes.market);
  });

  it("roll-forward carries the curves forward while it clears the snapshot and derived markets", async () => {
    const { head, docId } = await withCurve("ws-dc-roll");
    const r = await clone("ws-dc-roll", head.revision, { mode: "roll-forward", name: "April", cutoffDate: "2026-04-30", blocks: ["positions", "market", "assumptions", "run"] });
    expect(r.status).toBe(201);
    const c = r.body.manifest;
    expect(c.blocks.market.snapshot).toBeNull();
    expect(c.blocks.market.derivedCurves).toEqual(head.blocks.market.derivedCurves);
    const listed = await api<{ curves: Array<{ id: string }> }>(t.base, "GET", `/api/workspaces/${c.id}/derived-curves`);
    expect(listed.status).toBe(200);
    expect(listed.body.curves.map((x) => x.id)).toEqual([docId]);
  });

  it("an unticked market block starts with no derivedCurves key at all", async () => {
    const { head } = await withCurve("ws-dc-none");
    const r = await clone("ws-dc-none", head.revision, { mode: "copy", name: "No market", blocks: ["positions", "assumptions", "run"] });
    expect(r.status).toBe(201);
    expect("derivedCurves" in r.body.manifest.blocks.market).toBe(false);
  });
});
