// apps/server/src/__tests__/workspaceCompare.test.ts
// Studio A+E Slice 1, Task B7: GET /api/workspaces/compare. Per block the verdict is
// same | changed | only-a | only-b by the stored block hashes, and a changed block carries both
// entry-tuple lists. Expected values restated by hand from spec v3.1 Sections 2.2 and 2.8.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import type { WorkspaceManifest } from "../workspaces/types";

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); await seedStore(new FileStore(t.storeRoot), repoRoot()); });
afterAll(() => t.close());
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", ...body });
const blocks = (id: string, rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });

type CompareReply = {
  a: { id: string; revision: number; signedHash: string };
  b: { id: string; revision: number; signedHash: string };
  blocks: Record<string, { verdict: string; a?: unknown[]; b?: unknown[] }>;
};
const compare = (a: string, b: string) => api<CompareReply>(t.base, "GET", `/api/workspaces/compare?a=${a}&b=${b}`);

describe("compare", () => {
  it("reports same, changed, only-a and only-b per block with both entry lists on a change", async () => {
    const a = (await create({ id: "ws-cmp-a" })).body;
    const b = (await create({ id: "ws-cmp-b" })).body;
    await blocks("ws-cmp-a", a.revision, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    await blocks("ws-cmp-b", b.revision, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: "demo-behavioral-v1" } });
    const r = await api<{ blocks: Record<string, { verdict: string; a?: unknown[]; b?: unknown[] }> }>(t.base, "GET", "/api/workspaces/compare?a=ws-cmp-a&b=ws-cmp-b");
    expect(r.status).toBe(200);
    expect(r.body.blocks.market!.verdict).toBe("same");
    expect(r.body.blocks.assumptions!.verdict).toBe("changed");
    // The set, the default tuple and the routing policy a blank workspace pins at create.
    expect(r.body.blocks.assumptions!.a).toHaveLength(3);
    expect(r.body.blocks.run!.verdict).toBe("changed");     // two distinct Standard ALCO slot ids
    expect((await api(t.base, "GET", "/api/workspaces/compare?a=ws-cmp-a")).status).toBe(400);
    expect((await api(t.base, "GET", "/api/workspaces/compare?a=ws-cmp-a&b=nope")).status).toBe(404);
  });

  it("names both workspaces and lists all six blocks, with entry lists only on a changed block", async () => {
    const a = (await create({ id: "ws-cmp-h-a" })).body;
    const b = (await create({ id: "ws-cmp-h-b" })).body;
    await blocks("ws-cmp-h-a", a.revision, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    const r = (await compare("ws-cmp-h-a", "ws-cmp-h-b")).body;
    expect(r.a.id).toBe("ws-cmp-h-a");
    expect(r.a.revision).toBe(2);
    expect(r.b.id).toBe("ws-cmp-h-b");
    expect(r.b.signedHash).toBe(b.signedHash);
    expect(Object.keys(r.blocks).sort()).toEqual(["assumptions", "market", "positions", "run", "scenarios", "targets"]);
    // The one change is the assumptions block (a set added on top of the routing policy both sides pin at
    // create); the other five are untouched blanks except run (two slot ids).
    for (const same of ["market", "positions", "targets", "scenarios"]) {
      expect(r.blocks[same]!.verdict).toBe("same");
      expect(r.blocks[same]!.a).toBeUndefined();
      expect(r.blocks[same]!.b).toBeUndefined();
    }
    expect(r.blocks.assumptions!.verdict).toBe("changed");
    expect(r.blocks.assumptions!.a).toHaveLength(3);
    expect(r.blocks.assumptions!.b).toHaveLength(1);
    expect(r.blocks.run!.verdict).toBe("changed");
    // Standard ALCO is one tuple per side: the tuple carries the slot lineage id, so the two lists differ.
    expect(r.blocks.run!.a).toHaveLength(1);
    expect(r.blocks.run!.b).toHaveLength(1);
    expect(r.blocks.run!.a).not.toEqual(r.blocks.run!.b);
  });

  it("only-b is the mirror of only-a, and comparing a workspace with itself is same everywhere", async () => {
    const a = (await create({ id: "ws-cmp-m-a" })).body;
    await create({ id: "ws-cmp-m-b" });
    await blocks("ws-cmp-m-a", a.revision, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    const ab = (await compare("ws-cmp-m-a", "ws-cmp-m-b")).body;
    const ba = (await compare("ws-cmp-m-b", "ws-cmp-m-a")).body;
    expect(ab.blocks.scenarios!.verdict).toBe("only-a");
    expect(ba.blocks.scenarios!.verdict).toBe("only-b");
    const self = (await compare("ws-cmp-m-a", "ws-cmp-m-a")).body;
    expect(Object.values(self.blocks).map((x) => x.verdict)).toEqual(["same", "same", "same", "same", "same", "same"]);
  });

  it("compare answers on a locked workspace", async () => {
    const h = (await create({ id: "ws-cmp-lock", type: "production", cutoffDate: "2026-02-27" })).body;
    t.platform.context.workspaces.commit("ws-cmp-lock", 1, "tester", { kind: "lock", approvalId: "appr-cmp-1" }, {
      ...h, status: "locked", lock: { lockedAt: "2026-10-09T00:00:00.000Z", by: "tester", approvalId: "appr-cmp-1", signedHash: h.signedHash },
    });
    await create({ id: "ws-cmp-open" });
    const r = await compare("ws-cmp-lock", "ws-cmp-open");
    expect(r.status).toBe(200);
    expect(r.body.a.revision).toBe(2);
  });

  it("a missing b, an empty value and an unknown a each fail with the right status", async () => {
    await create({ id: "ws-cmp-e" });
    expect((await api(t.base, "GET", "/api/workspaces/compare?b=ws-cmp-e")).status).toBe(400);
    expect((await api(t.base, "GET", "/api/workspaces/compare?a=&b=ws-cmp-e")).status).toBe(400);
    expect((await api(t.base, "GET", "/api/workspaces/compare?a=nope&b=ws-cmp-e")).status).toBe(404);
  });
});
