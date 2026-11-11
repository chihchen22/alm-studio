// apps/server/src/__tests__/workspaceStore.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, AlreadyExistsError, NotFoundError } from "../store/store";
import { InvalidIdError } from "../store/paths";
import { RevisionConflict, WorkspaceStore } from "../workspaces/workspaceStore";
import { blockHashes, manifestHashOf, signedHashOf } from "../workspaces/hashes";
import type { WorkspaceManifest } from "../workspaces/types";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) {
    try { chmodSync(join(r, "workspaces", "ws-a"), 0o755); } catch { /* absent */ }
    rmSync(r, { recursive: true, force: true });
  }
  roots.length = 0;
});
const root = () => { const r = mkdtempSync(join(tmpdir(), "ae1-ws-")); roots.push(r); return r; };
function blank(id: string): WorkspaceManifest {
  const blocks = { market: { snapshot: null, derived: [], carried: [], carriedFrom: null }, positions: { book: null, retagged: [], coa: null, taxonomy: null, hierarchies: [] }, targets: { balancePlans: [], templates: [] }, assumptions: { sets: [], defaultSetId: null, routingPolicy: null }, scenarios: { slates: [] }, run: { setups: [], lenses: [] } };
  const m = { schemaVersion: "1.0.0", id, name: id, type: "test", status: "active", cutoffDate: "2026-03-31", owner: "o", createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z", revision: 0, blocks, blockHashes: blockHashes(blocks), signedHash: "", manifestHash: "", lineage: { mode: "blank", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false }, clashes: [], lock: null, note: "" } as unknown as WorkspaceManifest;
  m.signedHash = signedHashOf(m); m.manifestHash = manifestHashOf(m); return m;
}

describe("WorkspaceStore", () => {
  it("create writes revision 1 to head and history; head and history round-trip", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    const head = ws.create(blank("ws-a"), "tester");
    expect(head.revision).toBe(1);
    expect(ws.head("ws-a")).toEqual(head);
    const lines = ws.history("ws-a");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.change).toEqual({ kind: "create" });
    expect(lines[0]!.by).toBe("tester");
    expect(lines[0]!.manifest).toEqual(head);
  });
  it("commit increments the revision, appends the line, and a stale expectedRevision is a RevisionConflict", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    const h1 = ws.create(blank("ws-a"), "t");
    const h2 = ws.commit("ws-a", 1, "t", { kind: "meta", note: "n" }, { ...h1, note: "n" });
    expect(h2.revision).toBe(2);
    expect(h2.signedHash).toBe(h1.signedHash);
    expect(() => ws.commit("ws-a", 1, "t", { kind: "meta", note: "x" }, { ...h2, note: "x" })).toThrow(RevisionConflict);
    expect(ws.history("ws-a").map((l) => l.revision)).toEqual([1, 2]);
  });
  it("a history line ahead of the head is reconciled on read; the line is the truth", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    const h1 = ws.create(blank("ws-a"), "t");
    const ahead = { ...h1, revision: 2, note: "from the line", updatedAt: "2026-10-09T00:00:01.000Z" };
    appendFileSync(join(r, "workspaces", "ws-a", "history.ndjson"), JSON.stringify({ revision: 2, at: ahead.updatedAt, by: "t", change: { kind: "meta", note: "from the line" }, manifest: ahead }) + "\n");
    const fresh = new WorkspaceStore(r);
    expect(fresh.head("ws-a").revision).toBe(2);
    expect(fresh.head("ws-a").note).toBe("from the line");
    expect(JSON.parse(readFileSync(join(r, "workspaces", "ws-a", "manifest.json"), "utf8")).revision).toBe(2);
  });
  it("a torn final line is ignored and the next append starts on a clean line", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    const h1 = ws.create(blank("ws-a"), "t");
    appendFileSync(join(r, "workspaces", "ws-a", "history.ndjson"), '{"revision":2,"at":"x","by":"t","change":{"kind":"me');
    const fresh = new WorkspaceStore(r);
    expect(fresh.head("ws-a").revision).toBe(1);
    fresh.commit("ws-a", 1, "t", { kind: "meta", note: "n" }, { ...h1, note: "n" });
    expect(fresh.history("ws-a").map((l) => l.revision)).toEqual([1, 2]);
  });
  it("withLock serializes two writers on one id and takes two ids in sorted order", async () => {
    const r = root(); const ws = new WorkspaceStore(r);
    ws.create(blank("ws-a"), "t"); ws.create(blank("ws-b"), "t");
    const order: string[] = [];
    await Promise.all([
      ws.withLock(["ws-b", "ws-a"], async () => { order.push("first-in"); await new Promise((res) => setTimeout(res, 20)); order.push("first-out"); }),
      ws.withLock(["ws-a"], async () => { order.push("second"); }),
    ]);
    expect(order).toEqual(["first-in", "first-out", "second"]);
  });
  it("setup events and run attachments append and read back; a run request with no attachment is attached at reconcile", () => {
    const r = root(); const ws = new WorkspaceStore(r); const fs = new FileStore(r); fs.init();
    ws.create(blank("ws-a"), "t");
    ws.appendRunAttachment("ws-a", { runId: "run-1", attachedBy: "launch", at: "t", pins: "consumed" });
    fs.writeRunJson("run-2", "request.json", { engineContext: { durationMode: "base-only", shards: "auto" }, request: {}, portfolioRef: { id: "b", contentHash: "h" }, submission: {}, workspace: { workspaceId: "ws-a", setupLineageId: "setup-x", setupDocId: "rs-1", launchNo: 1, consumed: {} } });
    const report = ws.reconcileAll(fs);
    expect(report.attached).toEqual(["run-2"]);
    expect(ws.readRunAttachments("ws-a").map((a) => [a.runId, a.attachedBy])).toEqual([["run-1", "launch"], ["run-2", "reconcile"]]);
  });
  it("the server marker names a live pid and reads null when the pid is dead", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    ws.writeServerMarker(process.pid);
    expect(ws.liveServer()?.pid).toBe(process.pid);
    writeFileSync(join(r, "workspaces", ".server.json"), JSON.stringify({ pid: 2147483000, startedAt: "t" }));
    expect(ws.liveServer()).toBeNull();
  });
  it("a history line on the largest seeded workspace shape stays under 16 KB", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    const m = blank("ws-big");
    const ref = (c: string, id: string) => ({ collection: c, id, contentHash: "a".repeat(64), pinnedAt: "2026-10-09T00:00:00.000Z" }) as any;
    m.blocks.assumptions.sets = Array.from({ length: 16 }, (_, i) => ref("assumption-sets", `demo-behavioral-v1-edit-${i}`));
    m.blocks.run.setups = Array.from({ length: 9 }, (_, i) => ({ setupLineageId: `setup-plan-synthetic-2500-v1-edit-${i}`, current: ref("run-setups", `rs-${i}`) }));
    m.blocks.run.lenses = Array.from({ length: 6 }, (_, i) => ref("lens", `lens-${i}`));
    m.blocks.market.derived = Array.from({ length: 3 }, (_, i) => ({ ...ref("market", `derived-${i}`), definitionKey: `derived-${i}`, parentKey: null }));
    m.blocks.scenarios.slates = Array.from({ length: 5 }, (_, i) => ref("scenario-slates", `slate-${i}`));
    ws.create(m, "seed");
    const bytes = readFileSync(join(r, "workspaces", "ws-big", "history.ndjson"));
    expect(bytes.length).toBeLessThan(16 * 1024);
  });

  // --- additions: crash order, hashes, guards -------------------------------

  it("crash order: the history line is written before the head, so a head write that fails leaves the line ahead and reconcile completes forward", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores directory modes
    const r = root(); const ws = new WorkspaceStore(r);
    const h1 = ws.create(blank("ws-a"), "t");
    const dir = join(r, "workspaces", "ws-a");
    chmodSync(dir, 0o555); // the existing history file stays appendable; the atomic temp file for the head cannot be created
    expect(() => ws.commit("ws-a", 1, "t", { kind: "meta", note: "half-written" }, { ...h1, note: "half-written" })).toThrow();
    chmodSync(dir, 0o755);
    const onDisk = readFileSync(join(dir, "history.ndjson"), "utf8").trim().split("\n");
    expect(onDisk).toHaveLength(2);
    expect(JSON.parse(onDisk[1]!).revision).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).revision).toBe(1);
    const fresh = new WorkspaceStore(r);
    const report = fresh.reconcileAll(new FileStore(r));
    expect(report.reconciledHeads).toEqual(["ws-a"]);
    expect(fresh.head("ws-a").revision).toBe(2);
    expect(fresh.head("ws-a").note).toBe("half-written");
  });
  it("a head missing after create (crash between line and head) is rebuilt from the line", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    ws.create(blank("ws-a"), "t");
    rmSync(join(r, "workspaces", "ws-a", "manifest.json"));
    const fresh = new WorkspaceStore(r);
    expect(fresh.head("ws-a").revision).toBe(1);
    expect(existsSync(join(r, "workspaces", "ws-a", "manifest.json"))).toBe(true);
  });
  it("commit recomputes the three hashes from the blocks; a block move changes the block hash and signedHash, a note change moves neither", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    const h1 = ws.create(blank("ws-a"), "t");
    expect(h1.signedHash).toBe(signedHashOf(h1));
    expect(h1.manifestHash).toBe(manifestHashOf(h1));
    expect(h1.blockHashes).toEqual(blockHashes(h1.blocks));
    const noted = ws.commit("ws-a", 1, "t", { kind: "meta", note: "n" }, { ...h1, note: "n", signedHash: "stale", blockHashes: { ...h1.blockHashes, market: "stale" } });
    expect(noted.blockHashes).toEqual(h1.blockHashes);
    expect(noted.signedHash).toBe(h1.signedHash);
    expect(noted.manifestHash).not.toBe(h1.manifestHash);
    expect(noted.manifestHash).toBe(manifestHashOf(noted));
    const withLens = { ...noted, blocks: { ...noted.blocks, run: { ...noted.blocks.run, lenses: [{ collection: "lens", id: "l1", contentHash: "b".repeat(64), pinnedAt: "t" }] } } } as unknown as WorkspaceManifest;
    const moved = ws.commit("ws-a", 2, "t", { kind: "set-block", block: "run", op: "add", ref: { collection: "lens", id: "l1" } }, withLens);
    expect(moved.blockHashes.run).not.toBe(h1.blockHashes.run);
    expect(moved.blockHashes.market).toBe(h1.blockHashes.market);
    expect(moved.signedHash).toBe(signedHashOf(moved));
    expect(moved.signedHash).not.toBe(h1.signedHash);
  });
  it("create refuses an existing id and an invalid id; head of an unknown id is NotFound; has and list agree", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    ws.create(blank("ws-b"), "t"); ws.create(blank("ws-a"), "t");
    expect(() => ws.create(blank("ws-a"), "t")).toThrow(AlreadyExistsError);
    expect(() => ws.create(blank("../escape"), "t")).toThrow(InvalidIdError);
    expect(() => ws.head("ws-none")).toThrow(NotFoundError);
    expect(ws.has("ws-a")).toBe(true);
    expect(ws.has("ws-none")).toBe(false);
    expect(ws.has("../x")).toBe(false);
    expect(ws.list().map((m) => m.id)).toEqual(["ws-a", "ws-b"]);
  });
  it("reconcileAll reports torn final lines per file, and is idempotent on attachments", () => {
    const r = root(); const ws = new WorkspaceStore(r); const fs = new FileStore(r); fs.init();
    ws.create(blank("ws-a"), "t");
    appendFileSync(join(r, "workspaces", "ws-a", "runs.ndjson"), '{"runId":"run-9","att');
    fs.writeRunJson("run-3", "request.json", { workspace: { workspaceId: "ws-a", setupLineageId: "s", setupDocId: "rs-1", launchNo: 2 } });
    fs.writeRunJson("run-4", "request.json", { request: {} });
    const fresh = new WorkspaceStore(r);
    const first = fresh.reconcileAll(fs);
    expect(first.torn).toEqual(["workspace ws-a: torn final line in runs.ndjson ignored"]);
    expect(first.attached).toEqual(["run-3"]);
    const second = fresh.reconcileAll(fs);
    expect(second.attached).toEqual([]);
    const lines = fresh.readRunAttachments("ws-a");
    expect(lines.map((l) => l.runId)).toEqual(["run-3"]);
    expect(lines[0]).toMatchObject({ attachedBy: "reconcile", setupLineageId: "s", launchNo: 2, pins: "reconstructed" });
  });
  it("a pending supersede that cannot complete is named in the report, not silent (review B m5)", () => {
    const r = root(); const ws = new WorkspaceStore(r); const fs = new FileStore(r); fs.init();
    const pending = (id: string, from: string | null): WorkspaceManifest => ({ ...blank(id), lineage: { mode: "supersede", fromWorkspaceId: from, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: true } });
    // Source missing.
    ws.create(pending("ws-orphan", "ws-gone"), "t");
    // Source already superseded by a different workspace.
    const src = ws.create(blank("ws-src"), "t");
    ws.commit("ws-src", src.revision, "t", { kind: "supersede", by: "ws-winner" }, { ...src, status: "superseded", lineage: { ...src.lineage, supersededBy: "ws-winner" } });
    ws.create(pending("ws-loser", "ws-src"), "t");
    const report = new WorkspaceStore(r).reconcileAll(fs);
    expect(report.completedSupersedes).toEqual([]);
    expect(report.stuckSupersedes).toEqual([
      `workspace ws-loser: pending supersede of "ws-src" cannot complete: "ws-src" was superseded by "ws-winner"`,
      `workspace ws-orphan: pending supersede of "ws-gone" cannot complete: "ws-gone" does not exist`,
    ]);
    // Nothing was written: both clones stay pending, the source keeps its successor.
    const fresh = new WorkspaceStore(r);
    expect(fresh.head("ws-loser").lineage.pendingSupersede).toBe(true);
    expect(fresh.head("ws-orphan").lineage.pendingSupersede).toBe(true);
    expect(fresh.head("ws-src").lineage.supersededBy).toBe("ws-winner");
  });
  it("a request naming a workspace that does not exist is left unattached", () => {
    const r = root(); const ws = new WorkspaceStore(r); const fs = new FileStore(r); fs.init();
    mkdirSync(join(r, "workspaces"), { recursive: true });
    fs.writeRunJson("run-5", "request.json", { workspace: { workspaceId: "ws-gone", setupLineageId: "s", setupDocId: "rs-1", launchNo: 1, consumed: {} } });
    expect(ws.reconcileAll(fs).attached).toEqual([]);
  });
  it("setup events append and read back in order across a torn fragment", () => {
    const r = root(); const ws = new WorkspaceStore(r);
    ws.create(blank("ws-a"), "t");
    const ev = (n: number) => ({ t: "launch-complete", setupLineageId: "s", launchNo: n, at: "t", runIds: [], failed: [] }) as never;
    ws.appendSetupEvent("ws-a", ev(1));
    appendFileSync(join(r, "workspaces", "ws-a", "setups.ndjson"), '{"t":"launch-com');
    ws.appendSetupEvent("ws-a", ev(2));
    expect(new WorkspaceStore(r).readSetupEvents("ws-a").map((e) => (e as { launchNo: number }).launchNo)).toEqual([1, 2]);
  });
});
