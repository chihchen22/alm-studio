// apps/server/src/__tests__/workspaceSignOff.test.ts
// Studio A+E Slice 1, Task B6: sign-off, lock and the approvals branch (spec v3.1 Section 2.4,
// Appendix A). Expected values are restated by hand:
// the signed hash is recomputed here from its formula (sha256 over the canonical JSON of
// { blockHashes, cutoffDate, id, type }, keys sorted), never read back from hashes.ts.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import type { HistoryLine, WorkspaceManifest } from "../workspaces/types";

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); await seedStore(new FileStore(t.storeRoot), repoRoot()); }, 300_000);
afterAll(() => t.close());
const ws = (id: string) => api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`);
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", owner: "o", by: "tester", ...body });
const blocks = (id: string, rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });
const signOff = (id: string, rev: number, hash: string) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/sign-off`, { expectedRevision: rev, by: "signer", signedHash: hash });
const status = (id: string) => api<{ state: string; currentContentHash: string; records: Array<{ id: string }> }>(t.base, "GET", `/api/approvals/status/workspaces/${id}`);

/** The signed-hash formula restated: keys sorted at every level, no whitespace. */
function handSignedHash(m: WorkspaceManifest): string {
  const b = m.blockHashes;
  const canonical =
    `{"blockHashes":{"assumptions":"${b.assumptions}","market":"${b.market}","positions":"${b.positions}",` +
    `"run":"${b.run}","scenarios":"${b.scenarios}","targets":"${b.targets}"},` +
    `"cutoffDate":"${m.cutoffDate}","id":"${m.id}","type":"${m.type}"}`;
  return createHash("sha256").update(canonical).digest("hex");
}

describe("sign-off", () => {
  it("a Production sign-off writes the record, locks, and the approval state reads approved on the next request", async () => {
    const w = (await create({ id: "ws-so-prod", type: "production", cutoffDate: "2026-03-31" })).body;
    expect(w.signedHash).toBe(handSignedHash(w));
    const wrong = await signOff("ws-so-prod", w.revision, "0".repeat(64));
    expect(wrong.status).toBe(409); expect(wrong.text).toMatch(w.signedHash); expect(wrong.text).toMatch("0".repeat(64));
    expect((await ws("ws-so-prod")).body.revision).toBe(w.revision);
    const r = await signOff("ws-so-prod", w.revision, w.signedHash);
    expect(r.status).toBe(200); expect(r.body.status).toBe("locked"); expect(r.body.lock?.signedHash).toBe(w.signedHash);
    expect(r.body.revision).toBe(w.revision + 1);
    expect(r.body.lock?.by).toBe("signer");
    // The lock and the status enter no block hash: the signed hash is where the approval found it.
    expect(r.body.blockHashes).toEqual(w.blockHashes);
    expect(r.body.signedHash).toBe(w.signedHash); expect(handSignedHash(r.body)).toBe(w.signedHash);
    const st = await status("ws-so-prod");
    expect(st.body.state).toBe("approved"); expect(st.body.currentContentHash).toBe(w.signedHash);
    expect(st.body.records.map((x) => x.id)).toEqual([r.body.lock!.approvalId]);
    const rec = await api<{ artifactCollection: string; artifactId: string; artifactContentHash: string; decision: string; by: string }>(t.base, "GET", `/api/approvals/${r.body.lock!.approvalId}`);
    expect(rec.body).toMatchObject({ artifactCollection: "workspaces", artifactId: "ws-so-prod", artifactContentHash: w.signedHash, decision: "approved", by: "signer" });
    const hist = (await api<HistoryLine[]>(t.base, "GET", "/api/workspaces/ws-so-prod/history")).body;
    expect(hist.map((l) => l.change.kind)).toEqual(["create", "lock"]);
    expect(hist[1]!.change).toEqual({ kind: "lock", approvalId: r.body.lock!.approvalId });
    // Every write is refused with the named refusal: the approval id and the clone path.
    const blk = await blocks("ws-so-prod", r.body.revision, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(blk.status).toBe(409); expect(blk.text).toMatch(r.body.lock!.approvalId); expect(blk.text).toMatch(/clone/);
    // Archive of a locked month is allowed (ruling, review B m1): see "archive keeps the lock" below.
    const imp = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-so-prod&by=tester", { id: "never-stored-b6" });
    expect(imp.status).toBe(409); expect(imp.text).toMatch(r.body.lock!.approvalId);
    // A second sign-off on a locked month is refused and writes no second record.
    const again = await signOff("ws-so-prod", r.body.revision, w.signedHash);
    expect(again.status).toBe(409); expect(again.text).toMatch(r.body.lock!.approvalId);
    expect((await status("ws-so-prod")).body.records).toHaveLength(1);
    // The meta route stays open, and the note moves no hash.
    const meta = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-so-prod/meta", { expectedRevision: r.body.revision, by: "tester", note: "corrected by ws-x" });
    expect(meta.status).toBe(200); expect(meta.body.status).toBe("locked");
    expect((await ws("ws-so-prod")).body.signedHash).toBe(w.signedHash);
    expect((await status("ws-so-prod")).body.state).toBe("approved");
  });

  it("there is no unlock route, and the single-instrument drill stays open on a locked workspace", async () => {
    expect((await ws("ws-so-prod")).body.status).toBe("locked");
    expect((await api(t.base, "POST", "/api/workspaces/ws-so-prod/unlock", { expectedRevision: 3, by: "tester" })).status).toBe(404);
    const drill = await api<{ byScenario: unknown[] }>(t.base, "POST", "/api/instrument/project", {
      instrument: {
        terms: { id: "typed-b6", type: "fixed-loan", label: "Hand-typed 3y bullet", notional: 1_000_000, maturityMonths: 36, originationOffsetMonths: 0, amortType: "bullet", coupon: 0.05 },
        familyId: "typed",
        side: "asset",
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 100 },
      horizonMonths: 36,
    });
    expect(drill.status).toBe(200); expect(drill.body.byScenario).toHaveLength(1);
    expect((await ws("ws-so-prod")).body.revision).toBe(3);
  });

  it("a Test sign-off records and stays editable; the state reads changed after a block move", async () => {
    const w = (await create({ id: "ws-so-test", type: "test", cutoffDate: "2026-03-31" })).body;
    const r = await signOff("ws-so-test", w.revision, w.signedHash);
    expect(r.status).toBe(200); expect(r.body.status).toBe("active"); expect(r.body.lock).toBeNull();
    expect(r.body.revision).toBe(w.revision);
    expect((await status("ws-so-test")).body.state).toBe("approved");
    const moved = await blocks("ws-so-test", r.body.revision, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(moved.status).toBe(201);
    expect(moved.body.signedHash).not.toBe(w.signedHash);
    const st = await status("ws-so-test");
    expect(st.body.state).toBe("changed"); expect(st.body.currentContentHash).toBe(moved.body.signedHash);
  });

  it("FTP, Stress and Monthly record the sign-off and stay active (ruling 13)", async () => {
    for (const type of ["ftp", "stress", "monthly"] as const) {
      const w = (await create({ id: `ws-so-${type}`, type, cutoffDate: "2026-03-31" })).body;
      const r = await signOff(`ws-so-${type}`, w.revision, w.signedHash);
      expect(r.status).toBe(200); expect(r.body.status).toBe("active"); expect(r.body.lock).toBeNull();
      expect((await status(`ws-so-${type}`)).body.state).toBe("approved");
    }
  });

  it("a stale expectedRevision, a malformed hash and a body without by are refused before any record", async () => {
    const w = (await create({ id: "ws-so-guard", type: "production", cutoffDate: "2026-04-30" })).body;
    const stale = await signOff("ws-so-guard", w.revision + 1, w.signedHash);
    expect(stale.status).toBe(409);
    const bad = await signOff("ws-so-guard", w.revision, "not-a-hash");
    expect(bad.status).toBe(422); expect(bad.text).toMatch(/signedHash/);
    const noBy = await api(t.base, "POST", "/api/workspaces/ws-so-guard/sign-off", { expectedRevision: w.revision, signedHash: w.signedHash });
    expect(noBy.status).toBe(422); expect(noBy.text).toMatch(/by/);
    expect((await status("ws-so-guard")).body.state).toBe("none");
    expect((await ws("ws-so-guard")).body.status).toBe("active");
    expect((await api(t.base, "POST", "/api/workspaces/ws-so-nope/sign-off", { expectedRevision: 1, by: "x", signedHash: "0".repeat(64) })).status).toBe(404);
  });

  it("direct POST /api/approvals for a workspace is 422 and revoke is 409", async () => {
    const w = (await create({ id: "ws-so-direct", type: "test", cutoffDate: "2026-03-31" })).body;
    const direct = await api(t.base, "POST", "/api/approvals", { artifactCollection: "workspaces", artifactId: "ws-so-direct", artifactContentHash: w.signedHash, decision: "approved", by: "x" });
    expect(direct.status).toBe(422); expect(direct.text).toMatch(/sign-off/);
    await signOff("ws-so-direct", w.revision, w.signedHash);
    const rev = await api(t.base, "POST", "/api/approvals", { artifactCollection: "workspaces", artifactId: "ws-so-direct", artifactContentHash: w.signedHash, decision: "revoked", by: "x" });
    expect(rev.status).toBe(409); expect(rev.text).toMatch(/supersede/);
    // Revoke on a locked Production month: refused, recorded nowhere, and the lock holds.
    const prod = (await ws("ws-so-prod")).body;
    const revProd = await api(t.base, "POST", "/api/approvals", { artifactCollection: "workspaces", artifactId: "ws-so-prod", artifactContentHash: prod.signedHash, decision: "revoked", by: "x" });
    expect(revProd.status).toBe(409); expect(revProd.text).toMatch(/supersede/);
    expect((await status("ws-so-prod")).body.state).toBe("approved");
    expect((await ws("ws-so-prod")).body.status).toBe("locked");
    expect((await status("ws-so-direct")).body.records).toHaveLength(1);
  });

  it("a crash between the approval record and the lock is reconciled at boot", async () => {
    const w = (await create({ id: "ws-so-crash", type: "production", cutoffDate: "2026-08-31" })).body;
    // An unlocked Production workspace whose only record is at an older hash is NOT locked at boot.
    const old = (await create({ id: "ws-so-old", type: "production", cutoffDate: "2026-07-31" })).body;
    // Write the records the way the route does (apr-<stamp>-<hex>, key order of approvals.ts), without the lock step.
    const store = new FileStore(t.storeRoot);
    const put = (wsId: string, hash: string, suffix: string, atMs: number): string => {
      const at = new Date(atMs).toISOString();
      const id = `apr-${at.replace(/[-:.]/g, "")}-${suffix}`;
      store.putDocument("approvals", id, { id, artifactCollection: "workspaces", artifactId: wsId, artifactContentHash: hash, decision: "approved", by: "x", at, note: "" }, { artifactCollection: "workspaces", artifactId: wsId, decision: "approved" });
      return id;
    };
    const now = Date.now() + 60_000;
    const crashId = put("ws-so-crash", w.signedHash, "c0ffee", now);
    put("ws-so-old", "1".repeat(64), "c0ffef", now + 1);
    const report = new WorkspaceStore(t.storeRoot).reconcileAll(store);
    expect(report.lockedAtBoot).toEqual(["ws-so-crash"]);
    const h = new WorkspaceStore(t.storeRoot).head("ws-so-crash");
    expect(h.status).toBe("locked");
    expect(h.lock).toMatchObject({ approvalId: crashId, signedHash: w.signedHash, by: "x" });
    expect(h.signedHash).toBe(w.signedHash);
    const hist = new WorkspaceStore(t.storeRoot).history("ws-so-crash");
    expect(hist[hist.length - 1]).toMatchObject({ revision: w.revision + 1, change: { kind: "lock", approvalId: crashId }, reconciled: true });
    expect(new WorkspaceStore(t.storeRoot).head("ws-so-old").status).toBe("active");
    expect(old.status).toBe("active");
    // A second boot finds nothing to do.
    expect(new WorkspaceStore(t.storeRoot).reconcileAll(store).lockedAtBoot).toEqual([]);
    // The running server reads the lock on the next request.
    const live = await blocks("ws-so-crash", w.revision + 1, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(live.status).toBe(409); expect(live.text).toMatch(crashId);
    expect((await status("ws-so-crash")).body.state).toBe("approved");
  });

  it("archive keeps the lock: status archived, lock and signedHash unchanged, the approval still reads approved (review B m1)", async () => {
    const w = (await create({ id: "ws-so-arch", type: "production", cutoffDate: "2026-10-30" })).body;
    const locked = (await signOff("ws-so-arch", w.revision, w.signedHash)).body;
    const arch = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-so-arch/archive", { expectedRevision: locked.revision, by: "tester" });
    expect(arch.status).toBe(200);
    expect(arch.body.status).toBe("archived"); expect(arch.body.lock).toEqual(locked.lock);
    expect(arch.body.signedHash).toBe(w.signedHash); expect(handSignedHash(arch.body)).toBe(w.signedHash);
    expect((await status("ws-so-arch")).body.state).toBe("approved");
    const hist = (await api<HistoryLine[]>(t.base, "GET", "/api/workspaces/ws-so-arch/history")).body;
    expect(hist.map((l) => l.change)).toEqual([{ kind: "create" }, { kind: "lock", approvalId: locked.lock!.approvalId }, { kind: "status", from: "locked", to: "archived" }]);
    expect((await blocks("ws-so-arch", arch.body.revision, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } })).status).toBe(409);
    expect((await signOff("ws-so-arch", arch.body.revision, w.signedHash)).status).toBe(409);
  });

  it("a lock commit that fails after the record is written leaves the workspace lock-pending: writes refused, a retry locks on the same record (review B m2)", async () => {
    const w = (await create({ id: "ws-so-pend", type: "production", cutoffDate: "2026-09-30" })).body;
    const spy = vi.spyOn(t.platform.context.workspaces, "commit").mockImplementationOnce(() => { throw new Error("ENOSPC: simulated disk full"); });
    const failed = await signOff("ws-so-pend", w.revision, w.signedHash);
    spy.mockRestore();
    expect(failed.status).toBe(500); expect(failed.text).toMatch(/ENOSPC/); expect(failed.text).toMatch(/restart/);
    const st = await status("ws-so-pend");
    expect(st.body.state).toBe("approved"); expect(st.body.records).toHaveLength(1);
    const approvalId = st.body.records[0]!.id;
    expect(failed.text).toMatch(approvalId);
    const h = (await ws("ws-so-pend")).body;
    expect(h.status).toBe("active"); expect(h.lock).toBeNull(); expect(h.revision).toBe(w.revision);
    // The window is closed: block writes, imports and archive are refused naming the approval.
    const blk = await blocks("ws-so-pend", h.revision, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(blk.status).toBe(409); expect(blk.text).toMatch(approvalId); expect(blk.text).toMatch(/lock/);
    expect((await api(t.base, "POST", "/api/workspaces/ws-so-pend/archive", { expectedRevision: h.revision, by: "tester" })).status).toBe(409);
    const book = (await api<Record<string, unknown>>(t.base, "GET", `/api/portfolios/${SEED_IDS.vanillaPortfolio}`)).body;
    const imp = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-so-pend&by=tester", { ...book, id: "imp-so-pend", label: "imp", asOf: "2026-09-30" });
    expect(imp.status).toBe(409); expect(imp.text).toMatch(approvalId);
    expect((await api(t.base, "GET", "/api/portfolios/imp-so-pend")).status).toBe(404);
    expect((await ws("ws-so-pend")).body.signedHash).toBe(w.signedHash);
    // Rename and note stay open, as on a locked month; they move no hash.
    const meta = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-so-pend/meta", { expectedRevision: h.revision, by: "tester", note: "pending lock" });
    expect(meta.status).toBe(200);
    // A retry completes the lock on the record already written; no second record.
    const retry = await signOff("ws-so-pend", meta.body.revision, w.signedHash);
    expect(retry.status).toBe(200); expect(retry.body.status).toBe("locked");
    expect(retry.body.lock?.approvalId).toBe(approvalId); expect(retry.body.lock?.signedHash).toBe(w.signedHash);
    expect((await status("ws-so-pend")).body.records).toHaveLength(1);
    expect((await blocks("ws-so-pend", retry.body.revision, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } })).text).toMatch(/clone/);
  });
});
