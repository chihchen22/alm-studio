// apps/server/src/__tests__/runSetupStore.test.ts
// Studio A+E Slice 1, Task C1: the run-setups collection, its three routes and the shape gate.
// Expected values are restated by hand from spec v3.1 Sections 2.8, 2.10 and 5.2; none is read
// back from the code under test.
import { renameSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import { parseRunSetup } from "../workspaces/runSetupParse";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); await seedStore(new FileStore(t.storeRoot), repoRoot()); });
afterAll(() => t.close());

interface Listed { slot: { setupLineageId: string }; setup: RunSetup }
interface Missing { setupLineageId: string; docId: string; problem: string }
const list = (workspaceId: string) => api<{ setups: Listed[]; missing: Missing[] }>(t.base, "GET", `/api/run-setups?workspaceId=${workspaceId}`);
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", ...body });
const post = (body: object) => api<{ setup: RunSetup; manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", { by: "tester", ...body });

describe("run-setups", () => {
  it("lists a workspace's slots with their documents, edits a slot by writing a new immutable document, and dedupes identical content", async () => {
    const w = (await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id: "ws-rs", name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" })).body;
    const listed = await list("ws-rs");
    expect(listed.status).toBe(200); expect(listed.body.setups).toHaveLength(1); expect(listed.body.missing).toEqual([]);
    const { slot, setup } = listed.body.setups[0]!;
    expect(setup.id).toMatch(/^rs-[0-9a-f]{16}$/);
    const edited = { ...setup, id: undefined, nii: { ...setup.nii, basis: { kind: "runoff" } }, supersedes: setup.id };
    const r = await api<{ setup: RunSetup; manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", { workspaceId: "ws-rs", setupLineageId: slot.setupLineageId, expectedRevision: w.revision, by: "tester", setup: edited });
    expect(r.status).toBe(201);
    expect(r.body.setup.id).not.toBe(setup.id); expect(r.body.setup.supersedes).toBe(setup.id);
    expect(r.body.manifest.blocks.run.setups[0]!.current.id).toBe(r.body.setup.id);
    expect(r.body.manifest.revision).toBe(w.revision + 1);
    expect((await api(t.base, "GET", `/api/run-setups/${setup.id}`)).status).toBe(200);   // the old document stays
    const again = await api<{ setup: RunSetup }>(t.base, "POST", "/api/run-setups", { workspaceId: "ws-rs", setupLineageId: "setup-new", expectedRevision: r.body.manifest.revision, by: "tester", setup: edited });
    expect(again.status).toBe(201); expect(again.body.setup.id).toBe(r.body.setup.id);   // identical content, same document, new slot
    const bad = await api(t.base, "POST", "/api/run-setups", { workspaceId: "ws-rs", setupLineageId: "setup-x", expectedRevision: 99, by: "tester", setup: { ...edited, nii: { ...edited.nii, horizonMonths: 400 } } });
    expect(bad.status).toBe(422); expect(bad.text).toMatch(/horizonMonths/);
  });

  it("moves a slot and records one set-block line on the run block; adding a slot is op add, moving one is op set", async () => {
    const w = (await create({ id: "ws-rs-hist" })).body;
    const [{ slot, setup }] = (await list("ws-rs-hist")).body.setups as [Listed];
    const moved = await post({ workspaceId: "ws-rs-hist", setupLineageId: slot.setupLineageId, expectedRevision: w.revision, setup: { ...setup, name: "Quarter end", supersedes: setup.id } });
    expect(moved.status).toBe(201);
    const added = await post({ workspaceId: "ws-rs-hist", setupLineageId: "setup-extra", expectedRevision: moved.body.manifest.revision, setup: { ...setup, name: "Extra", supersedes: null } });
    expect(added.status).toBe(201);
    expect(added.body.manifest.blocks.run.setups.map((s) => s.setupLineageId).sort()).toEqual([slot.setupLineageId, "setup-extra"].sort());
    const hist = (await api<Array<{ revision: number; change: { kind: string; block?: string; op?: string; ref?: { collection: string; id: string } } }>>(t.base, "GET", "/api/workspaces/ws-rs-hist/history")).body;
    expect(hist.map((h) => h.revision)).toEqual([1, 2, 3]);
    expect(hist[1]!.change).toEqual({ kind: "set-block", block: "run", op: "set", ref: { collection: "run-setups", id: moved.body.setup.id } });
    expect(hist[2]!.change).toEqual({ kind: "set-block", block: "run", op: "add", ref: { collection: "run-setups", id: added.body.setup.id } });
    // The pinned hash is the store's meta hash, and the list joins slot to document.
    const listed = (await list("ws-rs-hist")).body.setups;
    expect(listed.map((l) => l.setup.name).sort()).toEqual(["Extra", "Quarter end"]);
  });

  it("re-saving a stored document is idempotent: the same id, and a slot that already holds it keeps its revision", async () => {
    const w = (await create({ id: "ws-rs-same" })).body;
    const [{ slot, setup }] = (await list("ws-rs-same")).body.setups as [Listed];
    const same = await post({ workspaceId: "ws-rs-same", setupLineageId: slot.setupLineageId, expectedRevision: w.revision, setup });
    expect(same.status).toBe(200);
    expect(same.body.setup.id).toBe(setup.id);
    expect(same.body.manifest.revision).toBe(w.revision);
    const other = await post({ workspaceId: "ws-rs-same", setupLineageId: "setup-copy", expectedRevision: w.revision, setup });
    expect(other.status).toBe(201);
    expect(other.body.setup.id).toBe(setup.id);   // the parse gate leaves a stored document byte-identical
  });

  it("refuses a stale revision with 409, a locked or archived workspace with 409, an unknown workspace with 404, and writes no orphan document when it refuses", async () => {
    const w = (await create({ id: "ws-rs-refuse" })).body;
    const [{ slot, setup }] = (await list("ws-rs-refuse")).body.setups as [Listed];
    const fresh = { ...setup, name: "Never stored", supersedes: setup.id };
    const stale = await post({ workspaceId: "ws-rs-refuse", setupLineageId: slot.setupLineageId, expectedRevision: w.revision + 5, setup: fresh });
    expect(stale.status).toBe(409);
    const store = new FileStore(t.storeRoot);
    expect(store.listMeta("run-setups").some((m) => (m as { label?: string }).label === "Never stored")).toBe(false);
    const missing = await post({ workspaceId: "ws-nope", setupLineageId: "setup-1", expectedRevision: 1, setup: fresh });
    expect(missing.status).toBe(404);
    const arch = await api(t.base, "POST", "/api/workspaces/ws-rs-refuse/archive", { expectedRevision: w.revision, by: "tester" });
    expect(arch.status).toBe(200);
    const closed = await post({ workspaceId: "ws-rs-refuse", setupLineageId: slot.setupLineageId, expectedRevision: w.revision + 1, setup: fresh });
    expect(closed.status).toBe(409); expect(closed.text).toMatch(/archived/);
  });

  it("reading an unknown document is 404 and a workspaceId is required on the list", async () => {
    expect((await api(t.base, "GET", "/api/run-setups/rs-0000000000000000")).status).toBe(404);
    expect((await api(t.base, "GET", "/api/run-setups")).status).toBe(422);
    expect((await api(t.base, "GET", "/api/run-setups?workspaceId=ws-nope")).status).toBe(404);
  });

  it("a slot whose document is gone is skipped and reported in missing; the other slots still list (review C m6)", async () => {
    const w = (await create({ id: "ws-rs-gone" })).body;
    const [{ slot, setup }] = (await list("ws-rs-gone")).body.setups as [Listed];
    const added = await post({ workspaceId: "ws-rs-gone", setupLineageId: "setup-gone", expectedRevision: w.revision, setup: { ...setup, name: "Gone", supersedes: null } });
    expect(added.status).toBe(201);
    const goneId = added.body.setup.id;
    expect(goneId).not.toBe(setup.id);
    // The document leaves the store (moved aside in this test's own scratch store); the slot still pins it.
    const store = new FileStore(t.storeRoot);
    const path = store.paths.documentPath("run-setups", goneId);
    renameSync(path, `${path}.aside`);
    const r = await list("ws-rs-gone");
    expect(r.status).toBe(200);
    expect(r.body.setups.map((l) => l.slot.setupLineageId)).toEqual([slot.setupLineageId]);
    expect(r.body.missing).toEqual([
      { setupLineageId: "setup-gone", docId: goneId, problem: `the slot's setup document "${goneId}" is not in the store` },
    ]);
  });

  it("a slot id is 1 to 70 characters: an import's setup-<planId> at most (spec Section 2.10, review C m7)", async () => {
    const w = (await create({ id: "ws-rs-len" })).body;
    const [{ setup }] = (await list("ws-rs-len")).body.setups as [Listed];
    const at70 = `setup-${"a".repeat(64)}`;
    expect(at70).toHaveLength(70);
    const ok = await post({ workspaceId: "ws-rs-len", setupLineageId: at70, expectedRevision: w.revision, setup: { ...setup, supersedes: null } });
    expect(ok.status).toBe(201);
    const over = await post({ workspaceId: "ws-rs-len", setupLineageId: `${at70}b`, expectedRevision: ok.body.manifest.revision, setup: { ...setup, supersedes: null } });
    expect(over.status).toBe(422);
    expect(over.text).toContain("1 to 70 characters");
  });
});

describe("parseRunSetup", () => {
  const base = (): Omit<RunSetup, "id"> => ({
    schemaVersion: "1.0.0", name: "S", gridHorizonMonths: 360,
    inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } },
    scenarios: { kind: "library", refs: ["regulatory-grid-v1#S0"] },
    plan: { planId: null, label: "S", authoredBy: "person", stages: "derived-default", reports: [{ id: "r1", view: "managementView", metrics: ["nii"] }], validationRules: { typeGate: ["T1"], routingGate: ["R1"] } },
    nii: { enabled: true, horizonMonths: 60, reportHorizons: [12, 24, 60], basis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 }, path: "single" },
    eve: { enabled: true, discountBasis: "all-in", durationMode: "base-only", valuationDates: "as-of", keyRate: false, channels: false, path: "single" },
    gap: { enabled: true, repricingBuckets: { kind: "monthly" }, fixedRateLadder: false, liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } } },
    ftp: { enabled: true },
    instrumentResults: { save: false, coaNodeIds: [] },
    batch: [], importedFrom: null, supersedes: null, note: "",
  });
  const refused = (mutate: (s: Record<string, any>) => void): string => {
    const s = JSON.parse(JSON.stringify(base())) as Record<string, any>;
    mutate(s);
    try { parseRunSetup(s); } catch (e) { return (e as Error).message; }
    return "ACCEPTED";
  };

  it("accepts the base document unchanged and drops keys it does not know", () => {
    const out = parseRunSetup({ ...base(), id: "rs-ignored", stray: 1 });
    expect(out).toEqual(base());
    expect("id" in out).toBe(false);
  });

  it("applies the plan's rule checks, each naming its field", () => {
    expect(refused((s) => { s.nii.horizonMonths = 11; })).toMatch(/nii\.horizonMonths/);
    expect(refused((s) => { s.nii.horizonMonths = 361; })).toMatch(/nii\.horizonMonths.*360/);
    expect(refused((s) => { s.nii.basis = { kind: "dynamic" }; })).toMatch(/nii\.basis\.kind/);
    expect(refused((s) => { s.instrumentResults = { save: true, coaNodeIds: [] }; })).toMatch(/instrumentResults\.coaNodeIds/);
    expect(refused((s) => { s.inputs.assumptionSetIds = []; })).toMatch(/inputs\.assumptionSetIds/);
    expect(refused((s) => { s.inputs.assumptionSetIds = { kind: "other" }; })).toMatch(/inputs\.assumptionSetIds/);
    expect(refused((s) => { s.scenarios = { kind: "everything" }; })).toMatch(/scenarios\.kind/);
  });

  it("accepts the other arms of every union", () => {
    expect(refused((s) => { s.inputs.assumptionSetIds = ["a", "b"]; s.inputs.book = { role: "retagged", id: "bk" }; s.inputs.market = { role: "derived", definitionKey: "rate-indices-demo-v1" }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.scenarios = { kind: "slate", slateId: "sl", include: ["S0"] }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.scenarios = { kind: "plan-scenarios", items: [{ ref: "regulatory-grid-v1#S0" }] }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.nii.basis = { kind: "runoff" }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.nii.basis = { kind: "custom", balancePlanId: "bp-1" }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.instrumentResults = { save: true, coaNodeIds: ["n1"] }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.gap.repricingBuckets = { kind: "custom", edgesMonths: [3, 12, 60] }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.eve.discountBasis = "spread-consistent"; })).toBe("ACCEPTED");
    expect(refused((s) => { s.eve.discountBasis = "risk-free"; })).toBe("ACCEPTED");
    expect(refused((s) => { s.eve.discountBasis = "par"; })).toMatch(/eve\.discountBasis/);
  });

  it("holds Flat to the plan's range (S2b-1 lifted Slice 1's 60 and 0) and refuses malformed library references, edges and batch rows", () => {
    expect(refused((s) => { s.nii.basis = { kind: "flat", termMonths: 36, spreadOverIndexBp: 25 }; })).toBe("ACCEPTED");
    expect(refused((s) => { s.nii.basis = { kind: "flat", termMonths: 0, spreadOverIndexBp: 0 }; })).toMatch(/nii\.basis\.termMonths/);
    expect(refused((s) => { s.nii.basis = { kind: "flat", termMonths: 361, spreadOverIndexBp: 0 }; })).toMatch(/nii\.basis\.termMonths/);
    expect(refused((s) => { s.nii.basis = { kind: "flat", termMonths: 60, spreadOverIndexBp: "25" as unknown as number }; })).toMatch(/nii\.basis\.spreadOverIndexBp/);
    expect(refused((s) => { s.scenarios = { kind: "library", refs: ["S0"] }; })).toMatch(/scenarios\.refs\[0\]/);
    expect(refused((s) => { s.gap.repricingBuckets = { kind: "custom", edgesMonths: [12, 6] }; })).toMatch(/gap\.repricingBuckets\.edgesMonths\[1\]/);
    expect(refused((s) => { s.batch = [{ label: "a", scenarios: s.scenarios, assumptionSetIds: { kind: "block-default" }, basis: { kind: "runoff" } }, { label: "a", scenarios: s.scenarios, assumptionSetIds: { kind: "block-default" }, basis: { kind: "runoff" } }]; })).toMatch(/batch\[1\]\.label/);
    expect(refused((s) => { s.supersedes = "not-an-id"; })).toMatch(/supersedes/);
  });

  it("gates the plan template and inline scenarios through the engine's own shape check, with the field renamed to the setup", () => {
    expect(refused((s) => { s.plan.reports = [{ id: "r1", view: "v", metrics: ["not-a-metric"] }]; })).toMatch(/plan\.reports\[0\]\.metrics/);
    expect(refused((s) => { s.plan.stages = [{ id: "s1" }]; })).toMatch(/plan\.stages\[0\]/);
    expect(refused((s) => { s.plan.stages = "everything"; })).toMatch(/plan\.stages/);
    expect(refused((s) => { s.scenarios = { kind: "plan-scenarios", items: [{ id: "X" }] }; })).toMatch(/scenarios\.items\[0\]\.rateSpec/);
    expect(refused((s) => { s.plan.scenarioBalancePlans = { S0: "" }; })).toMatch(/plan\.scenarioBalancePlans\.S0/);
  });
});
