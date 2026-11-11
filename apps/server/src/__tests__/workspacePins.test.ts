/**
 * Studio A+E slice 1, B3: FileStore.findPinned resolves a pinned document by id
 * and content hash, live first, then under superseded/<stamp>/, else null.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, sha256Hex, serializeDocument } from "../store/store";
import { repoRoot } from "../config";
import { runSeedCli, SEED_IDS, SeedRetireRefusedError, seedStore } from "../../scripts/seed-store";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { blockHashes, manifestHashOf, signedHashOf } from "../workspaces/hashes";
import type { DocRef, WorkspaceManifest, WorkspaceStatus } from "../workspaces/types";
import type { Collection } from "../store/paths";
import { copyStoreWithoutDb, plantStaleVanillaSlate, seededTemplate, snapshotTree } from "./seedFixtures";

const roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots.length = 0; });

describe("FileStore.findPinned", () => {
  it("resolves live, then superseded, then null", () => {
    const r = mkdtempSync(join(tmpdir(), "ae1-pin-")); roots.push(r);
    const s = new FileStore(r); s.init();
    const v1 = { id: "d", v: 1 }; const v2 = { id: "d", v: 2 };
    const h1 = sha256Hex(serializeDocument(v1)); const h2 = sha256Hex(serializeDocument(v2));
    s.putDocument("lens", "d", v1, {});
    expect(s.findPinned("lens", "d", h1)?.where).toBe("live");
    s.supersedeDocument("lens", "d", "2026-10-09T00-00-00-000Z", h2);
    s.putDocument("lens", "d", v2, {});
    expect(s.findPinned("lens", "d", h2)?.where).toBe("live");
    const old = s.findPinned("lens", "d", h1);
    expect(old?.where).toBe("superseded");
    expect(old?.stamp).toBe("2026-10-09T00-00-00-000Z");
    expect(sha256Hex(old!.bytes)).toBe(h1);
    expect(s.findPinned("lens", "d", "f".repeat(64))).toBeNull();
    expect(s.findPinned("lens", "nope", h1)).toBeNull();
  });

  it("returns null for a live document whose hash differs when nothing was ever superseded", () => {
    const r = mkdtempSync(join(tmpdir(), "ae1-pin-")); roots.push(r);
    const s = new FileStore(r); s.init();
    s.putDocument("lens", "d", { id: "d", v: 1 }, {});
    expect(s.findPinned("lens", "d", "0".repeat(64))).toBeNull();
  });

  it("scans stamps in sorted order and is read-only", () => {
    const r = mkdtempSync(join(tmpdir(), "ae1-pin-")); roots.push(r);
    const s = new FileStore(r); s.init();
    const v1 = { id: "d", v: 1 }; const v2 = { id: "d", v: 2 }; const v3 = { id: "d", v: 3 };
    const h1 = sha256Hex(serializeDocument(v1)); const h2 = sha256Hex(serializeDocument(v2));
    const h3 = sha256Hex(serializeDocument(v3));
    s.putDocument("lens", "d", v1, {});
    s.supersedeDocument("lens", "d", "2026-10-01T00-00-00-000Z", h2);
    s.putDocument("lens", "d", v2, {});
    s.supersedeDocument("lens", "d", "2026-10-02T00-00-00-000Z", h3);
    s.putDocument("lens", "d", v3, {});
    expect(s.findPinned("lens", "d", h1)?.stamp).toBe("2026-10-01T00-00-00-000Z");
    expect(s.findPinned("lens", "d", h2)?.stamp).toBe("2026-10-02T00-00-00-000Z");
    expect(s.findPinned("lens", "d", h3)?.where).toBe("live");
    expect(s.getMeta("lens", "d").contentHash).toBe(h3);
  });
});

// ---------------------------------------------------------------------------
// Studio A+E slice 1, D2 (contract 9): refresh re-pins seed-only workspaces,
// retire refuses named-by-workspaces, and refresh and retire refuse a live server.
// Workspaces are built by hand here: the seed-workspaces generator is a sibling task.
// ---------------------------------------------------------------------------

const PINNED_AT = "2026-10-09T00:00:00.000Z";
const STAMP = "2026-10-09T00-00-00-000Z";
const SLATE_TARGET = `scenario-slates/${SEED_IDS.vanillaSlate}`;
const RETIRED_ID = "market-2026-03-31";

const ref = (collection: Collection, id: string, contentHash: string): DocRef => ({ collection, id, contentHash, pinnedAt: PINNED_AT });

function manifest(id: string, over: { status?: WorkspaceStatus; slates?: DocRef[]; book?: DocRef | null; snapshot?: DocRef | null; lenses?: DocRef[] } = {}): WorkspaceManifest {
  const blocks = {
    market: { snapshot: over.snapshot ?? null, derived: [], carried: [], carriedFrom: null },
    positions: { book: over.book ?? null, retagged: [], coa: null, taxonomy: null, hierarchies: [] },
    targets: { balancePlans: [], templates: [] },
    assumptions: { sets: [], defaultSetId: null, routingPolicy: null },
    scenarios: { slates: over.slates ?? [] },
    run: { setups: [], lenses: over.lenses ?? [] },
  };
  const status = over.status ?? "active";
  const m = {
    schemaVersion: "1.0.0", id, name: id, type: "test", status, cutoffDate: "2026-03-31", owner: "seed",
    createdAt: PINNED_AT, updatedAt: PINNED_AT, revision: 0, blocks, blockHashes: blockHashes(blocks), signedHash: "", manifestHash: "",
    lineage: { mode: "seed", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false },
    clashes: [],
    lock: status === "locked" ? { lockedAt: PINNED_AT, by: "signer", approvalId: "ap-1", signedHash: "x" } : null,
    note: "",
  } as unknown as WorkspaceManifest;
  m.signedHash = signedHashOf(m);
  m.manifestHash = manifestHashOf(m);
  return m;
}

describe("seed refresh and retire against workspaces", () => {
  const made: string[] = [];
  let template: string;
  beforeAll(async () => { template = await seededTemplate(); made.push(template); }, 120_000);
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
  const copy = (prefix: string): string => { const d = copyStoreWithoutDb(template, prefix); made.push(d); return d; };

  it("refresh re-pins a seed-only workspace with a seed-refresh line and leaves every other workspace on its old pin", async () => {
    const root = copy("ae1-refresh-");
    const todayHash = new FileStore(template).getMeta("scenario-slates", SEED_IDS.vanillaSlate).contentHash;
    const oldHash = plantStaleVanillaSlate(root);
    expect(oldHash).not.toBe(todayHash);
    const book = ref("portfolios", SEED_IDS.vanillaPortfolio, "b".repeat(64));
    const stale = (): DocRef[] => [ref("scenario-slates", SEED_IDS.vanillaSlate, oldHash)];
    const ws = new WorkspaceStore(root);
    // Seed-only by the three writer literals: created by the seed, then touched by a migration.
    ws.create(manifest("ws-seed-only", { slates: stale(), book }), "seed");
    const mig = ws.head("ws-seed-only");
    ws.commit("ws-seed-only", mig.revision, "migration", { kind: "meta", note: "attached legacy runs" }, { ...mig, note: "attached legacy runs" });
    // Not seed-only: one analyst line.
    ws.create(manifest("ws-touched", { slates: stale() }), "seed");
    const t = ws.head("ws-touched");
    ws.commit("ws-touched", t.revision, "analyst", { kind: "meta", note: "mine" }, { ...t, note: "mine" });
    // Seed-only history but not active.
    ws.create(manifest("ws-archived", { slates: stale(), status: "archived" }), "seed");
    ws.create(manifest("ws-locked", { slates: stale(), status: "locked" }), "seed");
    // Seed-only and active, but pinned at a hash other than the one that moves.
    ws.create(manifest("ws-other-pin", { slates: [ref("scenario-slates", SEED_IDS.vanillaSlate, "e".repeat(64))] }), "seed");
    const before = (id: string) => ({ revision: ws.head(id).revision, lines: ws.history(id).length });
    const untouched = ["ws-touched", "ws-archived", "ws-locked", "ws-other-pin"].map((id) => [id, before(id)] as const);
    const seedOnlyBefore = ws.head("ws-seed-only");

    const report = await seedStore(new FileStore(root), repoRoot(), { mode: "refresh", targets: [SLATE_TARGET], stamp: STAMP });
    expect(report.written).toEqual([SLATE_TARGET]);

    const after = new WorkspaceStore(root);
    const head = after.head("ws-seed-only");
    expect(head.blocks.scenarios.slates.map((r) => r.contentHash)).toEqual([todayHash]);
    expect(head.blocks.positions.book?.contentHash).toBe("b".repeat(64));
    expect(head.revision).toBe(seedOnlyBefore.revision + 1);
    expect(head.blockHashes.scenarios).not.toBe(seedOnlyBefore.blockHashes.scenarios);
    expect(head.blockHashes.positions).toBe(seedOnlyBefore.blockHashes.positions);
    expect(head.signedHash).not.toBe(seedOnlyBefore.signedHash);
    expect(head.note).toBe("attached legacy runs");
    const lines = after.history("ws-seed-only");
    expect(lines.map((l) => l.by)).toEqual(["seed", "migration", "seed-refresh"]);
    expect(lines.at(-1)!.change).toEqual({ kind: "re-pin", block: "scenarios", id: SEED_IDS.vanillaSlate, from: oldHash, to: todayHash });
    expect(lines.at(-1)!.manifest.blocks.scenarios.slates[0]!.contentHash).toBe(todayHash);

    for (const [id, was] of untouched) {
      expect([id, after.head(id).revision, after.history(id).length]).toEqual([id, was.revision, was.lines]);
      const pinned = after.head(id).blocks.scenarios.slates.map((r) => r.contentHash);
      expect(pinned).toEqual([id === "ws-other-pin" ? "e".repeat(64) : oldHash]);
    }
    const store = new FileStore(root);
    expect(store.findPinned("scenario-slates", SEED_IDS.vanillaSlate, oldHash)?.where).toBe("superseded");
    expect(store.findPinned("scenario-slates", SEED_IDS.vanillaSlate, oldHash)?.stamp).toBe(STAMP);
    expect(store.findPinned("scenario-slates", SEED_IDS.vanillaSlate, todayHash)?.where).toBe("live");
  }, 90_000);

  it("retire refuses named-by-workspaces for a head of any status, naming it, before any file moves", async () => {
    const root = copy("ae1-retire-head-");
    const store = new FileStore(root);
    const doc = store.getDocument<unknown>("market", SEED_IDS.market).doc;
    store.putDocument("market", RETIRED_ID, doc, { label: "retired market", seeded: true });
    const hash = store.getMeta("market", RETIRED_ID).contentHash;
    new WorkspaceStore(root).create(manifest("ws-old-month", { status: "archived", snapshot: ref("market", RETIRED_ID, hash) }), "seed");
    new WorkspaceStore(root).create(manifest("ws-unrelated", {}), "seed");
    const before = snapshotTree(root);
    let err: unknown;
    try { await seedStore(store, repoRoot(), { mode: "retire", targets: [`market/${RETIRED_ID}`], stamp: STAMP }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SeedRetireRefusedError);
    expect((err as SeedRetireRefusedError).reason).toBe("named-by-workspaces");
    expect((err as SeedRetireRefusedError).workspaces).toEqual(["ws-old-month"]);
    expect(String(err)).toContain("ws-old-month");
    expect(String(err)).not.toContain("ws-unrelated");
    expect(store.has("market", RETIRED_ID)).toBe(true);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 90_000);

  it("retire refuses when only a consumed-pins line of a setups.ndjson names the document", async () => {
    const root = copy("ae1-retire-setups-");
    const store = new FileStore(root);
    const doc = store.getDocument<unknown>("market", SEED_IDS.market).doc;
    store.putDocument("market", RETIRED_ID, doc, { label: "retired market", seeded: true });
    const hash = store.getMeta("market", RETIRED_ID).contentHash;
    const ws = new WorkspaceStore(root);
    ws.create(manifest("ws-moved-on"), "seed");
    ws.appendSetupEvent("ws-moved-on", {
      t: "launch", setupLineageId: "sl-1", setupDocId: "rs-0000000000000001", at: PINNED_AT, by: "analyst",
      consumed: { market: ref("market", RETIRED_ID, hash) }, launchNo: 1, acknowledged: [], batch: false, state: "submitting",
    });
    const before = snapshotTree(root);
    let err: unknown;
    try { await seedStore(store, repoRoot(), { mode: "retire", targets: [`market/${RETIRED_ID}`], stamp: STAMP }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SeedRetireRefusedError);
    expect((err as SeedRetireRefusedError).reason).toBe("named-by-workspaces");
    expect((err as SeedRetireRefusedError).workspaces).toEqual(["ws-moved-on"]);
    expect([...snapshotTree(root)]).toEqual([...before]);
  }, 90_000);

  it("decides named-by-workspaces first for any target a workspace pins, a live lens included", async () => {
    const root = copy("ae1-retire-lens-");
    const store = new FileStore(root);
    const lensId = store.listMeta("lens")[0]!.id;
    const lensHash = store.getMeta("lens", lensId).contentHash;
    new WorkspaceStore(root).create(manifest("ws-pins-test-lens", { lenses: [ref("lens", lensId, lensHash)] }), "seed");
    let err: unknown;
    try { await seedStore(store, repoRoot(), { mode: "retire", targets: [`lens/${lensId}`], stamp: STAMP }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SeedRetireRefusedError);
    expect((err as SeedRetireRefusedError).reason).toBe("named-by-workspaces");
    expect(String(err)).toMatch(/ws-pins-test-lens/);
    expect(store.has("lens", lensId)).toBe(true);
  }, 90_000);

  it("refresh and retire refuse when the server marker names a live pid, before any file moves; check does not", async () => {
    const root = copy("ae1-live-");
    const store = new FileStore(root);
    plantStaleVanillaSlate(root);
    new WorkspaceStore(root).writeServerMarker(process.pid);
    const since = (JSON.parse(readFileSync(join(root, "workspaces", ".server.json"), "utf8")) as { startedAt: string }).startedAt;
    const live = `seed: a platform server (pid ${process.pid}, since ${since}) is live on this store; stop it first`;
    const before = snapshotTree(root);
    await expect(seedStore(store, repoRoot(), { mode: "refresh", targets: [SLATE_TARGET], stamp: STAMP })).rejects.toThrow(live);
    await expect(seedStore(store, repoRoot(), { mode: "retire", targets: [`market/${RETIRED_ID}`], stamp: STAMP })).rejects.toThrow(live);
    await expect(runSeedCli(["--refresh", SLATE_TARGET], store, repoRoot(), () => undefined)).rejects.toThrow(/live on this store/);
    expect([...snapshotTree(root)]).toEqual([...before]);
    const checked = await seedStore(store, repoRoot(), { mode: "check" });
    expect(checked.stale.map((s) => `${s.collection}/${s.id}`)).toEqual([SLATE_TARGET]);
  }, 120_000);

  it("a marker naming a dead pid does not block a refresh", async () => {
    const root = copy("ae1-dead-");
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    mkdirSync(join(root, "workspaces"), { recursive: true });
    writeFileSync(join(root, "workspaces", ".server.json"), JSON.stringify({ pid: dead, startedAt: PINNED_AT }));
    plantStaleVanillaSlate(root);
    const report = await seedStore(new FileStore(root), repoRoot(), { mode: "refresh", targets: [SLATE_TARGET], stamp: STAMP });
    expect(report.written).toEqual([SLATE_TARGET]);
  }, 90_000);
});
