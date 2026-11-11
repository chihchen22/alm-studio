// apps/server/src/__tests__/workspaceRules.test.ts
// Studio A+E Slice 1, Task B4: the workspace lifecycle routes, the default-set rule, the
// cut-off clash rule and the two import hooks. Expected values are restated by hand from
// spec v3.1 Sections 2.4, 2.5 and 2.10; none is read back from the code under test.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { TEST_COA } from "../intake/__tests__/fixtures";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import { blockHashes } from "../workspaces/hashes";
import type { HistoryLine, RunAttachment, WorkspaceManifest } from "../workspaces/types";
import type { ReadinessReport } from "../workspaces/readiness";

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); await seedStore(new FileStore(t.storeRoot), repoRoot()); });
afterAll(() => t.close());
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", ...body });
const blocks = (id: string, rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });
const head = async (id: string) => (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`)).body;
const wsStore = () => t.platform.context.workspaces;

/** A synthetic 4-sheet market workbook, invented numbers (the intake test's shape). */
function workbook(): Uint8Array {
  const sheets: Record<string, (string | number)[][]> = {
    SOFR_OIS_Curve: [["Term", "InstType", "Mid"], ["1 D", "CASH", 0.04], ["1 MO", "CASH", 0.041], ["1 YR", "SWAP", 0.042], ["5 YR", "SWAP", 0.043]],
    FHLB_Curve: [["Term", "Mid"], ["1 D", 0.04], ["1 MO", 0.044], ["1 YR", 0.0455], ["5 YR", 0.047]],
    Cap_Volatility: [["Synthetic cap vol surface"], ["Expiry", "1.00%", "ATM"], ["1 YR", 0.008, 0.0085], ["5 YR", 0.0082, 0.0087]],
    ATM_Swaption_Volatility: [["Synthetic ATM swaption vols"], ["Expiry", "1 YR", "5 YR"], ["1 YR", 0.007, 0.0075], ["5 YR", 0.0072, 0.0077]],
  };
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
const importWorkbook = (query: string, filename: string) => api(t.base, "POST", `/api/market/import-workbook?${query}`, workbook(), { "x-filename": filename });

describe("workspace lifecycle routes", () => {
  it("creates a blank workspace with one Standard ALCO slot, a slug id and a null default set", async () => {
    const r = await create({ name: "Q2 Stress (draft)" });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe("ws-q2-stress-draft");
    expect(r.body.revision).toBe(1);
    expect(r.body.blocks.run.setups).toHaveLength(1);
    expect(r.body.blocks.run.setups[0]!.setupLineageId).toMatch(/^setup-[0-9a-f]{8}$/);
    expect(r.body.blocks.assumptions.defaultSetId).toBeNull();
    // The run-setups routes arrive with C1; the document is read from the file store here.
    const slot = r.body.blocks.run.setups[0]!.current;
    const stored = new FileStore(t.storeRoot).getDocument<{ name: string; inputs: { assumptionSetIds: unknown }; scenarios: unknown; nii: { basis: unknown; horizonMonths: number }; plan: { planId: unknown; stages: unknown } }>("run-setups", slot.id);
    expect(stored.doc.name).toBe("Standard ALCO");
    expect(stored.doc.inputs.assumptionSetIds).toEqual({ kind: "block-default" });
    expect(stored.doc.scenarios).toEqual({ kind: "library", refs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100", "regulatory-grid-v1#S200", "regulatory-grid-v1#S-200"] });
    expect(stored.doc.nii.basis).toEqual({ kind: "flat", termMonths: 60, spreadOverIndexBp: 0 });
    expect(stored.doc.nii.horizonMonths).toBe(60);
    expect(stored.doc.plan).toEqual(expect.objectContaining({ planId: null, stages: "derived-default" }));
    expect(stored.meta.contentHash).toBe(slot.contentHash);
  });
  it("refuses a body without by, and refuses a cut-off change", async () => {
    const r = await api(t.base, "POST", "/api/workspaces", { name: "NoBy", type: "test", cutoffDate: "2026-03-31", owner: "o" });
    expect(r.status).toBe(422); expect(r.text).toMatch(/by/);
    const w = (await create({ id: "ws-immut" })).body;
    const m = await api(t.base, "POST", "/api/workspaces/ws-immut/meta", { expectedRevision: 1, by: "tester", cutoffDate: "2026-04-30" });
    expect(m.status).toBe(422); expect(m.text).toMatch(/cutoffDate/);
    expect((await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${w.id}`)).body.cutoffDate).toBe("2026-03-31");
  });
  it("one Production workspace per cut-off date among the non-superseded", async () => {
    expect((await create({ id: "ws-prod-1", type: "production" })).status).toBe(201);
    const r = await create({ id: "ws-prod-2", type: "production" });
    expect(r.status).toBe(409); expect(r.text).toMatch(/ws-prod-1/); expect(r.text).toMatch(/supersede/);
  });
  it("set, add, remove and set-default follow the default-set rule, and expectedRevision guards every write", async () => {
    const w = (await create({ id: "ws-sets" })).body;
    const a = await blocks("ws-sets", 1, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    expect(a.status).toBe(201); expect(a.body.blocks.assumptions.defaultSetId).toBe(SEED_IDS.vanillaAssumptions);
    const b = await blocks("ws-sets", 2, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: "demo-behavioral-v1" } });
    expect(b.body.blocks.assumptions.defaultSetId).toBe(SEED_IDS.vanillaAssumptions);
    const rm = await blocks("ws-sets", 3, { block: "assumptions", op: "remove", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    expect(rm.status).toBe(422); expect(rm.text).toMatch(/default/);
    const sd = await blocks("ws-sets", 3, { block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: "demo-behavioral-v1" } });
    expect(sd.status).toBe(201); expect(sd.body.blocks.assumptions.defaultSetId).toBe("demo-behavioral-v1");
    expect(sd.body.blockHashes.assumptions).not.toBe(b.body.blockHashes.assumptions);
    const stale = await blocks("ws-sets", 3, { block: "assumptions", op: "remove", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    expect(stale.status).toBe(409); expect(stale.text).toMatch(/revision/);
    const wrong = await blocks("ws-sets", 4, { block: "positions", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    expect(wrong.status).toBe(422);
    expect(w.id).toBe("ws-sets");
  });
  it("clash rule: a Test workspace warns and records; a Production workspace refuses before storing", async () => {
    await create({ id: "ws-clash-test", cutoffDate: "2026-04-30" });
    const warn = await blocks("ws-clash-test", 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    expect(warn.status).toBe(201);
    expect(warn.body.clashes).toEqual([expect.objectContaining({ block: "positions", id: SEED_IDS.vanillaPortfolio, documentAsOf: "2026-03-31", outcome: "warned" })]);
    await create({ id: "ws-clash-prod", type: "production", cutoffDate: "2026-04-30" });
    const refuse = await blocks("ws-clash-prod", 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    expect(refuse.status).toBe(422); expect(refuse.text).toMatch(/2026-04-30/); expect(refuse.text).toMatch(/roll-forward/);
  });
  it("import into a Production workspace with a wrong-dated file stores nothing and the same id imports afterwards", async () => {
    await create({ id: "ws-imp-prod", type: "production", cutoffDate: "2026-05-29" });
    const book = (await api<{ positions: unknown[]; coa: unknown; asOf: string }>(t.base, "GET", `/api/portfolios/${SEED_IDS.vanillaPortfolio}`)).body;
    const bad = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-imp-prod&by=tester", { ...book, id: "imp-1", label: "imp" });
    expect(bad.status).toBe(422);
    expect((await api(t.base, "GET", "/api/portfolios/imp-1")).status).toBe(404);
    const good = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-imp-prod&by=tester", { ...book, id: "imp-1", label: "imp", asOf: "2026-05-29" });
    expect(good.status).toBe(201);
    expect((await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-imp-prod")).body.blocks.positions.book?.id).toBe("imp-1");
  });
  it("archive refuses later block writes with 409 and leaves reads open; meta is refused on archived", async () => {
    await create({ id: "ws-arch" });
    expect((await api(t.base, "POST", "/api/workspaces/ws-arch/archive", { expectedRevision: 1, by: "tester" })).status).toBe(200);
    expect((await blocks("ws-arch", 2, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } })).status).toBe(409);
    expect((await api(t.base, "POST", "/api/workspaces/ws-arch/meta", { expectedRevision: 2, by: "tester", note: "n" })).status).toBe(409);
    expect((await api(t.base, "GET", "/api/workspaces/ws-arch/history")).status).toBe(200);
  });
  it("rename and note leave signedHash unchanged", async () => {
    const w = (await create({ id: "ws-meta" })).body;
    const m = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-meta/meta", { expectedRevision: 1, by: "tester", name: "Renamed", note: "a note" });
    expect(m.status).toBe(200); expect(m.body.name).toBe("Renamed"); expect(m.body.signedHash).toBe(w.signedHash); expect(m.body.revision).toBe(2);
  });
});

describe("create, list and history", () => {
  it("a name that yields no id is a 422 and a taken id is a 409", async () => {
    const empty = await create({ name: "!!!" });
    expect(empty.status).toBe(422); expect(empty.text).toMatch(/no id/);
    await create({ id: "ws-taken" });
    const again = await create({ id: "ws-taken" });
    expect(again.status).toBe(409); expect(again.text).toMatch(/ws-taken/);
  });
  it("two workspaces share the one identical Standard ALCO document and slot ids differ", async () => {
    const a = (await create({ id: "ws-share-a" })).body;
    const b = (await create({ id: "ws-share-b" })).body;
    expect(a.blocks.run.setups[0]!.current.id).toBe(b.blocks.run.setups[0]!.current.id);
    expect(a.blocks.run.setups[0]!.current.id).toMatch(/^rs-[0-9a-f]{16}$/);
    expect(a.blocks.run.setups[0]!.setupLineageId).not.toBe(b.blocks.run.setups[0]!.setupLineageId);
  });
  it("lists heads newest cut-off first, then by id", async () => {
    await create({ id: "ws-list-b", cutoffDate: "2025-12-31" });
    await create({ id: "ws-list-a", cutoffDate: "2025-12-31" });
    await create({ id: "ws-list-c", cutoffDate: "2027-01-31" });
    const list = (await api<WorkspaceManifest[]>(t.base, "GET", "/api/workspaces")).body;
    const mine = list.filter((w) => w.id.startsWith("ws-list-")).map((w) => w.id);
    expect(mine).toEqual(["ws-list-c", "ws-list-a", "ws-list-b"]);
    const dates = list.map((w) => w.cutoffDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
  it("unknown workspace ids are 404 on every read", async () => {
    for (const p of ["", "/history", "/runs"]) expect((await api(t.base, "GET", `/api/workspaces/ws-nope${p}`)).status).toBe(404);
  });
  it("a stale expectedRevision is a 409 whose detail carries both numbers", async () => {
    await create({ id: "ws-rev" });
    const r = await api<{ error: { detail: { expected: number; actual: number } } }>(t.base, "POST", "/api/workspaces/ws-rev/meta", { expectedRevision: 7, by: "tester", note: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error.detail).toEqual({ expected: 7, actual: 1 });
  });
  it("history holds the full manifest per revision, with a set-block line then a clash line for a warned set", async () => {
    await create({ id: "ws-hist", cutoffDate: "2026-04-30" });
    await blocks("ws-hist", 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    const lines = (await api<HistoryLine[]>(t.base, "GET", "/api/workspaces/ws-hist/history")).body;
    expect(lines.map((l) => l.revision)).toEqual([1, 2, 3]);
    expect(lines.map((l) => l.change.kind)).toEqual(["create", "set-block", "clash"]);
    expect(lines[1]!.change).toEqual({ kind: "set-block", block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    expect(lines[1]!.manifest.clashes).toEqual([]);
    expect(lines[2]!.manifest.clashes).toHaveLength(1);
    expect(lines[2]!.by).toBe("tester");
    expect((await head("ws-hist")).revision).toBe(3);
  });
  it("a refused Production block set writes nothing: the head stays at revision 1 with no clash", async () => {
    await create({ id: "ws-nowrite", type: "production", cutoffDate: "2026-07-31" });
    const r = await blocks("ws-nowrite", 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    expect(r.status).toBe(422);
    const h = await head("ws-nowrite");
    expect(h.revision).toBe(1); expect(h.clashes).toEqual([]); expect(h.blocks.positions.book).toBeNull();
  });
  it("the runs route joins attachments to status rows, newest first, and keeps a missing status as null", async () => {
    await create({ id: "ws-runs" });
    expect((await api<unknown[]>(t.base, "GET", "/api/workspaces/ws-runs/runs")).body).toEqual([]);
    const store = new FileStore(t.storeRoot);
    store.writeRunJson("run-b4-old", "status.json", { runId: "run-b4-old", state: "done", submittedAt: "2026-10-01T00:00:00.000Z", platformRequestHash: "h", summary: { portfolioId: "p", marketId: "m", scenarioSlateId: "s", scenarioCount: 1 } });
    store.writeRunJson("run-b4-new", "status.json", { runId: "run-b4-new", state: "done", submittedAt: "2026-10-02T00:00:00.000Z", platformRequestHash: "h", summary: { portfolioId: "p", marketId: "m", scenarioSlateId: "s", scenarioCount: 1 } });
    // A run with no status.json sorts by its attachment time, here the oldest.
    const line = (runId: string): RunAttachment => ({ runId, attachedBy: "migration", at: runId === "run-b4-gone" ? "2026-09-01T00:00:00.000Z" : "2026-10-09T00:00:00.000Z", pins: "reconstructed" });
    for (const id of ["run-b4-old", "run-b4-gone", "run-b4-new", "run-b4-old"]) wsStore().appendRunAttachment("ws-runs", line(id));
    const rows = (await api<Array<{ runId: string; status: { state: string } | null }>>(t.base, "GET", "/api/workspaces/ws-runs/runs")).body;
    expect(rows.map((r) => r.runId)).toEqual(["run-b4-new", "run-b4-old", "run-b4-gone"]);
    expect(rows.map((r) => r.status?.state ?? null)).toEqual(["done", "done", null]);
  });
});

describe("status refusals", () => {
  it("a locked workspace refuses blocks with the approval id, keeps meta open, and archives keeping its lock (ruling, review B m1)", async () => {
    const h = (await create({ id: "ws-locked", type: "production", cutoffDate: "2026-02-27" })).body;
    wsStore().commit("ws-locked", 1, "tester", { kind: "lock", approvalId: "appr-test-1" }, {
      ...h, status: "locked", lock: { lockedAt: "2026-10-09T00:00:00.000Z", by: "tester", approvalId: "appr-test-1", signedHash: h.signedHash },
    });
    const blk = await blocks("ws-locked", 2, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(blk.status).toBe(409); expect(blk.text).toMatch(/appr-test-1/); expect(blk.text).toMatch(/clone/);
    const meta = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-locked/meta", { expectedRevision: 2, by: "tester", note: "corrected by ws-x" });
    expect(meta.status).toBe(200); expect(meta.body.note).toBe("corrected by ws-x"); expect(meta.body.status).toBe("locked");
    expect(meta.body.signedHash).toBe(h.signedHash);
    const book = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-locked&by=tester", { id: "never-stored" });
    expect(book.status).toBe(409);
    // Archive of a locked month is allowed: the status moves, the lock and signedHash do not.
    const arch = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-locked/archive", { expectedRevision: 3, by: "tester" });
    expect(arch.status).toBe(200);
    expect(arch.body.status).toBe("archived");
    expect(arch.body.lock).toEqual({ lockedAt: "2026-10-09T00:00:00.000Z", by: "tester", approvalId: "appr-test-1", signedHash: h.signedHash });
    expect(arch.body.signedHash).toBe(h.signedHash); expect(arch.body.blockHashes).toEqual(h.blockHashes);
    expect((await api<HistoryLine[]>(t.base, "GET", "/api/workspaces/ws-locked/history")).body.at(-1)!.change).toEqual({ kind: "status", from: "locked", to: "archived" });
    // An archived locked workspace still refuses every write.
    expect((await blocks("ws-locked", 4, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } })).status).toBe(409);
    expect((await api(t.base, "POST", "/api/workspaces/ws-locked/meta", { expectedRevision: 4, by: "tester", note: "n" })).status).toBe(409);
    expect((await api(t.base, "POST", "/api/workspaces/ws-locked/archive", { expectedRevision: 4, by: "tester" })).status).toBe(409);
    expect((await api(t.base, "POST", "/api/workspaces/ws-locked/sign-off", { expectedRevision: 4, by: "tester", signedHash: h.signedHash })).status).toBe(409);
    expect((await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-locked&by=tester", { id: "never-stored" })).status).toBe(409);
    expect((await head("ws-locked")).revision).toBe(4);
  });
  it("a superseded workspace names its successor, refuses meta, and frees the Production date", async () => {
    const h = (await create({ id: "ws-sup-a", type: "production", cutoffDate: "2026-06-30" })).body;
    const taken = await create({ id: "ws-sup-b", type: "production", cutoffDate: "2026-06-30" });
    expect(taken.status).toBe(409);
    wsStore().commit("ws-sup-a", 1, "tester", { kind: "supersede", by: "ws-sup-b" }, {
      ...h, status: "superseded", lineage: { ...h.lineage, supersededBy: "ws-sup-b" },
    });
    const blk = await blocks("ws-sup-a", 2, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(blk.status).toBe(409); expect(blk.text).toMatch(/ws-sup-b/);
    expect((await api(t.base, "POST", "/api/workspaces/ws-sup-a/meta", { expectedRevision: 2, by: "tester", note: "n" })).status).toBe(409);
    expect((await create({ id: "ws-sup-b", type: "production", cutoffDate: "2026-06-30" })).status).toBe(201);
  });
  it("archive of an archived workspace is a 409", async () => {
    await create({ id: "ws-arch-2" });
    await api(t.base, "POST", "/api/workspaces/ws-arch-2/archive", { expectedRevision: 1, by: "tester", note: "done with it" });
    const h = await head("ws-arch-2");
    expect(h.status).toBe("archived"); expect(h.note).toBe("done with it");
    expect((await api(t.base, "POST", "/api/workspaces/ws-arch-2/archive", { expectedRevision: 2, by: "tester" })).status).toBe(409);
    const hist = (await api<HistoryLine[]>(t.base, "GET", "/api/workspaces/ws-arch-2/history")).body;
    expect(hist[1]!.change).toEqual({ kind: "status", from: "active", to: "archived" });
  });
});

describe("block rules", () => {
  it("every mutating body needs by and expectedRevision, naming the field", async () => {
    await create({ id: "ws-body" });
    const noBy = await api(t.base, "POST", "/api/workspaces/ws-body/blocks", { expectedRevision: 1, block: "run", op: "add", ref: { collection: "lens", id: "x" } });
    expect(noBy.status).toBe(422); expect(noBy.text).toMatch(/"by"/);
    const noRev = await api(t.base, "POST", "/api/workspaces/ws-body/archive", { by: "tester" });
    expect(noRev.status).toBe(422); expect(noRev.text).toMatch(/expectedRevision/);
  });
  it("an unknown document is a 422, a duplicate add is a 422, and a remove of an absent entry is a 422", async () => {
    await create({ id: "ws-docs" });
    const unknown = await blocks("ws-docs", 1, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: "no-such-set" } });
    expect(unknown.status).toBe(422); expect(unknown.text).toMatch(/no-such-set/);
    await blocks("ws-docs", 1, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    const dup = await blocks("ws-docs", 2, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(dup.status).toBe(422); expect(dup.text).toMatch(/already/);
    const absent = await blocks("ws-docs", 2, { block: "scenarios", op: "remove", ref: { collection: "scenario-slates", id: SEED_IDS.demoSlate } });
    expect(absent.status).toBe(422); expect(absent.text).toMatch(/not in the scenarios block/);
    const removed = await blocks("ws-docs", 2, { block: "scenarios", op: "remove", ref: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate } });
    expect(removed.status).toBe(201); expect(removed.body.blocks.scenarios.slates).toEqual([]);
  });
  it("removing the last set clears the default, and a set-default of a set outside the block is a 422", async () => {
    await create({ id: "ws-last" });
    await blocks("ws-last", 1, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    const outside = await blocks("ws-last", 2, { block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: "demo-behavioral-v1" } });
    expect(outside.status).toBe(422);
    const last = await blocks("ws-last", 2, { block: "assumptions", op: "remove", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    expect(last.status).toBe(201);
    expect(last.body.blocks.assumptions.sets).toEqual([]);
    expect(last.body.blocks.assumptions.defaultSetId).toBeNull();
  });
  it("a derived market needs the base snapshot first, then pins definitionKey and parentKey from derivedFrom.baseId", async () => {
    const store = new FileStore(t.storeRoot);
    store.putDocument("market", "mk-b4-child", { calibrationDate: "2026-03-31", derivedFrom: { baseId: SEED_IDS.fundingSpreadShockMarket, ops: [] } }, { label: "child", derivedFromMarketId: SEED_IDS.fundingSpreadShockMarket });
    await create({ id: "ws-derived" });
    const derived = (rev: number, id: string) => blocks("ws-derived", rev, { block: "market", op: "add", ref: { collection: "market", id } });
    const early = await derived(1, SEED_IDS.fundingSpreadShockMarket);
    expect(early.status).toBe(422); expect(early.text).toMatch(/base snapshot first/);
    const asBase = await blocks("ws-derived", 1, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.fundingSpreadShockMarket } });
    expect(asBase.status).toBe(422); expect(asBase.text).toMatch(/derived/);
    expect((await blocks("ws-derived", 1, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } })).status).toBe(201);
    const addBase = await derived(2, SEED_IDS.market);
    expect(addBase.status).toBe(422); expect(addBase.text).toMatch(/base snapshot/);
    const orphan = await derived(2, "mk-b4-child");
    expect(orphan.status).toBe(422); expect(orphan.text).toMatch(/neither the block's snapshot nor a listed derived market/);
    const parent = await derived(2, SEED_IDS.fundingSpreadShockMarket);
    expect(parent.status).toBe(201);
    expect(parent.body.blocks.market.derived).toEqual([expect.objectContaining({ id: SEED_IDS.fundingSpreadShockMarket, definitionKey: SEED_IDS.fundingSpreadShockMarket, parentKey: null })]);
    const child = await derived(3, "mk-b4-child");
    expect(child.status).toBe(201);
    expect(child.body.blocks.market.derived[1]).toEqual(expect.objectContaining({ id: "mk-b4-child", definitionKey: "mk-b4-child", parentKey: SEED_IDS.fundingSpreadShockMarket }));
    expect(child.body.blocks.market.snapshot?.id).toBe(SEED_IDS.market);
  });
  it("a launch slate the server wrote is never listed in the scenarios block", async () => {
    const store = new FileStore(t.storeRoot);
    store.putDocument("scenario-slates", "plan-b4-launch", { id: "plan-b4-launch", label: "launch", scenarios: [] }, { label: "launch", fromPlan: "b4" });
    await create({ id: "ws-launch-slate" });
    const r = await blocks("ws-launch-slate", 1, { block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: "plan-b4-launch" } });
    expect(r.status).toBe(422); expect(r.text).toMatch(/launch slate/);
  });
  it("single-slot blocks take set and remove, list blocks take add and remove", async () => {
    await create({ id: "ws-slots" });
    const coa = await blocks("ws-slots", 1, { block: "positions", op: "add", ref: { collection: "coa", id: "demo-coa" } });
    expect(coa.status).toBe(422);
    const lens = await blocks("ws-slots", 1, { block: "run", op: "set", ref: { collection: "lens", id: "nope" } });
    expect(lens.status).toBe(422);
  });
});

describe("the base snapshot never moves under live derived markets (review B, M1)", () => {
  it("set and remove of the snapshot are refused 422 naming the derived ids; a parent is refused while a child names it", async () => {
    const store = new FileStore(t.storeRoot);
    store.putDocument("market", "mk-m1-child", { calibrationDate: "2026-03-31", derivedFrom: { baseId: SEED_IDS.fundingSpreadShockMarket, ops: [] } }, { label: "child", derivedFromMarketId: SEED_IDS.fundingSpreadShockMarket });
    store.putDocument("market", "mk-m1-base2", { calibrationDate: "2026-03-31" }, { label: "second base" });
    await create({ id: "ws-m1" });
    await blocks("ws-m1", 1, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await blocks("ws-m1", 2, { block: "market", op: "add", ref: { collection: "market", id: SEED_IDS.fundingSpreadShockMarket } });
    const withChild = await blocks("ws-m1", 3, { block: "market", op: "add", ref: { collection: "market", id: "mk-m1-child" } });
    expect(withChild.status).toBe(201);
    const before = await head("ws-m1");
    expect(before.revision).toBe(4);

    const reset = await blocks("ws-m1", 4, { block: "market", op: "set", ref: { collection: "market", id: "mk-m1-base2" } });
    expect(reset.status).toBe(422);
    expect(reset.text).toMatch(SEED_IDS.fundingSpreadShockMarket); expect(reset.text).toMatch(/mk-m1-child/);
    expect(reset.text).toMatch(/remove them before/);
    const drop = await blocks("ws-m1", 4, { block: "market", op: "remove", ref: { collection: "market", id: SEED_IDS.market } });
    expect(drop.status).toBe(422); expect(drop.text).toMatch(/mk-m1-child/);
    const parent = await blocks("ws-m1", 4, { block: "market", op: "remove", ref: { collection: "market", id: SEED_IDS.fundingSpreadShockMarket } });
    expect(parent.status).toBe(422); expect(parent.text).toMatch(/mk-m1-child/); expect(parent.text).toMatch(/parent/);
    // A workbook import aimed at the snapshot is refused before the workbook is stored: no id is burned.
    const imp = await importWorkbook("id=mk-m1-imp&workspaceId=ws-m1&by=tester", "synthetic_market_20260331.xlsx");
    expect(imp.status).toBe(422); expect(imp.text).toMatch(/mk-m1-child/);
    expect((await api(t.base, "GET", "/api/market/mk-m1-imp")).status).toBe(404);
    const unchanged = await head("ws-m1");
    expect(unchanged.revision).toBe(4); expect(unchanged.blocks.market).toEqual(before.blocks.market);

    // Children first, then the parent, then the base moves.
    expect((await blocks("ws-m1", 4, { block: "market", op: "remove", ref: { collection: "market", id: "mk-m1-child" } })).status).toBe(201);
    expect((await blocks("ws-m1", 5, { block: "market", op: "remove", ref: { collection: "market", id: SEED_IDS.fundingSpreadShockMarket } })).status).toBe(201);
    const moved = await blocks("ws-m1", 6, { block: "market", op: "set", ref: { collection: "market", id: "mk-m1-base2" } });
    expect(moved.status).toBe(201); expect(moved.body.blocks.market.snapshot?.id).toBe("mk-m1-base2");
    expect((await blocks("ws-m1", 7, { block: "market", op: "remove", ref: { collection: "market", id: "mk-m1-base2" } })).status).toBe(201);
  });
});

describe("concurrent commits (review B, m7)", () => {
  it("two writes at the same expectedRevision give exactly one 200 and one 409 revision-conflict", async () => {
    await create({ id: "ws-race" });
    const write = (note: string) => api<{ error?: { code: string } }>(t.base, "POST", "/api/workspaces/ws-race/meta", { expectedRevision: 1, by: "tester", note });
    const replies = await Promise.all([write("first"), write("second")]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(replies.find((r) => r.status === 409)!.body.error?.code).toBe("revision-conflict");
    expect((await head("ws-race")).revision).toBe(2);
  });
});

describe("the clash rule at import: a blocked clash stores nothing and burns no id", () => {
  it("a Production workbook import takes the date the kernel stamps: the filename suffix first, never ?asOf=", async () => {
    await create({ id: "ws-mkt-prod", type: "production", cutoffDate: "2026-08-31" });
    // The route's own fallback (?asOf=) equals the cut-off, but the kernel stamps the filename date.
    const wrong = await importWorkbook("id=mk-b4-1&workspaceId=ws-mkt-prod&by=tester&asOf=2026-08-31", "synthetic_market_20260331.xlsx");
    expect(wrong.status).toBe(422); expect(wrong.text).toMatch(/2026-03-31/); expect(wrong.text).toMatch(/2026-08-31/);
    expect((await api(t.base, "GET", "/api/market/mk-b4-1")).status).toBe(404);
    expect((await head("ws-mkt-prod")).blocks.market.snapshot).toBeNull();
    // The same id imports afterwards, with a filename dated at the cut-off.
    const ok = await importWorkbook("id=mk-b4-1&workspaceId=ws-mkt-prod&by=tester", "synthetic_market_20260831.xlsx");
    expect(ok.status).toBe(201);
    const h = await head("ws-mkt-prod");
    expect(h.blocks.market.snapshot?.id).toBe("mk-b4-1");
    expect(h.blocks.market.snapshot?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.clashes).toEqual([]);
  });
  it("a workbook with no filename date takes ?asOf= as the kernel does, so a matching ?asOf= is accepted", async () => {
    await create({ id: "ws-mkt-asof", type: "production", cutoffDate: "2026-09-30" });
    const bad = await importWorkbook("id=mk-b4-2&workspaceId=ws-mkt-asof&by=tester&asOf=2026-04-30", "synthetic_market.xlsx");
    expect(bad.status).toBe(422);
    expect((await api(t.base, "GET", "/api/market/mk-b4-2")).status).toBe(404);
    const ok = await importWorkbook("id=mk-b4-2&workspaceId=ws-mkt-asof&by=tester&asOf=2026-09-30", "synthetic_market.xlsx");
    expect(ok.status).toBe(201);
  });
  it("a workbook with no filename date and no as-of date is a 422 in plain words, with no query-string syntax in them", async () => {
    await create({ id: "ws-mkt-nodate", cutoffDate: "2026-03-31" });
    const r = await importWorkbook("id=mk-b4-nodate&workspaceId=ws-mkt-nodate&by=tester", "synthetic_market.xlsx");
    expect(r.status).toBe(422);
    expect(r.text).toContain('cannot determine the calibration date: filename \\"synthetic_market.xlsx\\" has no date in it and no as-of date was given; the platform never invents an as-of date');
    expect(r.text).not.toContain("?asOf=");
    expect(r.text).not.toContain("was supplied");
    expect((await api(t.base, "GET", "/api/market/mk-b4-nodate")).status).toBe(404);
  });
  it("a Test workspace stores the workbook, sets the snapshot and records a warned clash", async () => {
    await create({ id: "ws-mkt-test", cutoffDate: "2026-04-30" });
    const r = await importWorkbook("id=mk-b4-3&workspaceId=ws-mkt-test&by=tester", "synthetic_market_20260331.xlsx");
    expect(r.status).toBe(201);
    const h = await head("ws-mkt-test");
    expect(h.blocks.market.snapshot?.id).toBe("mk-b4-3");
    expect(h.clashes).toEqual([expect.objectContaining({ block: "market", id: "mk-b4-3", documentAsOf: "2026-03-31", outcome: "warned" })]);
    expect((await api(t.base, "GET", "/api/market/mk-b4-3")).status).toBe(200);
  });
  it("an import with workspaceId but no by is a 422 before anything is stored", async () => {
    await create({ id: "ws-mkt-noby" });
    const r = await importWorkbook("id=mk-b4-4&workspaceId=ws-mkt-noby", "synthetic_market_20260331.xlsx");
    expect(r.status).toBe(422); expect(r.text).toMatch(/"by"/);
    expect((await api(t.base, "GET", "/api/market/mk-b4-4")).status).toBe(404);
  });
  it("a CSV import dated off the cut-off of a Production workspace stores nothing; the same portfolioId imports afterwards", async () => {
    const store = new FileStore(t.storeRoot);
    store.putDocument("coa", "b4-coa", TEST_COA, { label: "b4 COA" });
    await create({ id: "ws-csv-prod", type: "production", cutoffDate: "2026-11-30" });
    const csv = [
      "position_id,family_id,coa_node_id,terms_type,label,notional,maturityMonths,originationOffsetMonths,amortType,side,coupon,indexTenorMonths,margin,resetFrequencyMonths,depositRate,beta",
      "p1,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,",
    ].join("\r\n");
    const q = (asOf: string) => `/api/portfolios/import?format=csv&coaId=b4-coa&label=csv%20b4&portfolioId=csv-b4&asOf=${asOf}&workspaceId=ws-csv-prod&by=tester`;
    const bad = await api(t.base, "POST", q("2026-03-31"), csv);
    expect(bad.status).toBe(422); expect(bad.text).toMatch(/2026-11-30/);
    expect((await api(t.base, "GET", "/api/portfolios/csv-b4")).status).toBe(404);
    const ok = await api(t.base, "POST", q("2026-11-30"), csv);
    expect(ok.status).toBe(201);
    expect((await head("ws-csv-prod")).blocks.positions.book?.id).toBe("csv-b4");
  });
  it("a Test workspace import dated off the cut-off stores the book, sets it and records the clash", async () => {
    await create({ id: "ws-imp-test", cutoffDate: "2026-04-30" });
    const book = (await api<Record<string, unknown>>(t.base, "GET", `/api/portfolios/${SEED_IDS.vanillaPortfolio}`)).body;
    const r = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-imp-test&by=tester", { ...book, id: "imp-b4-test", label: "imp" });
    expect(r.status).toBe(201);
    const h = await head("ws-imp-test");
    expect(h.blocks.positions.book?.id).toBe("imp-b4-test");
    expect(h.clashes).toEqual([expect.objectContaining({ block: "positions", id: "imp-b4-test", documentAsOf: "2026-03-31" })]);
  });
  it("a book already stored is a 409 on import and the workspace is not touched", async () => {
    await create({ id: "ws-imp-dup", cutoffDate: "2026-03-31" });
    const book = (await api<Record<string, unknown>>(t.base, "GET", `/api/portfolios/${SEED_IDS.vanillaPortfolio}`)).body;
    const r = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-imp-dup&by=tester", { ...book });
    expect(r.status).toBe(409);
    const h = await head("ws-imp-dup");
    expect(h.revision).toBe(1); expect(h.blocks.positions.book).toBeNull();
  });
});

describe("a blank workspace carries the seeded routing policy", () => {
  /** Expected value restated by hand: the store's own list is the source of the content hash. */
  const policyListing = async () => (await api<Array<{ id: string; contentHash: string }>>(t.base, "GET", "/api/routing-policies")).body;
  const pin = { collection: "routing-policies" as const, id: SEED_IDS.routingPolicy };

  it("create pins the seeded policy with the stored content hash and the create clock", async () => {
    const listed = (await policyListing()).find((p) => p.id === SEED_IDS.routingPolicy)!;
    const r = await create({ id: "ws-rp-blank" });
    expect(r.status).toBe(201);
    const ref = r.body.blocks.assumptions.routingPolicy;
    expect(ref).toEqual({ ...pin, contentHash: listed.contentHash, pinnedAt: r.body.createdAt });
    expect((await head("ws-rp-blank")).blocks.assumptions.routingPolicy).toEqual(ref);
    // The block hash covers the pinned policy, so it differs from a block with the field null.
    expect(r.body.blockHashes.assumptions).toBe(blockHashes(r.body.blocks).assumptions);
  });

  it("prefers the seeded policy over a user policy that sorts first by id", async () => {
    const seeded = new FileStore(t.storeRoot).getDocument<{ id: string; label: string }>("routing-policies", SEED_IDS.routingPolicy).doc;
    const mine = await api(t.base, "POST", "/api/routing-policies", { policy: { ...seeded, id: "a-user-policy-v1", label: "A user policy" } });
    expect(mine.status).toBe(201);
    const r = await create({ id: "ws-rp-prefer" });
    expect(r.body.blocks.assumptions.routingPolicy?.id).toBe(SEED_IDS.routingPolicy);
  });

  it("a store with no routing policy still creates, with the field null", async () => {
    const bare = await bootTestPlatform();
    try {
      const r = await api<WorkspaceManifest>(bare.base, "POST", "/api/workspaces", { name: "Bare", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", id: "ws-rp-none" });
      expect(r.status).toBe(201);
      expect(r.body.blocks.assumptions.routingPolicy).toBeNull();
      // Readiness names the gap on Overview: the Routing policy item is a required Not set that blocks the launch.
      const rd = (await api<ReadinessReport>(bare.base, "GET", "/api/workspaces/ws-rp-none/readiness")).body;
      const policy = rd.items.find((i) => i.section === "assumptions" && i.item === "Routing policy")!;
      expect(policy).toMatchObject({ state: "not-set", required: true, detail: "Attach a routing policy; Validate refuses a setup without one." });
      expect(rd.launchable[r.body.blocks.run.setups[0]!.setupLineageId]!.blocking).toContain("assumptions/Routing policy");
    } finally {
      await bare.close();
    }
  });

  it("a clone keeps the pin its source carries, the created one and an explicitly swapped one", async () => {
    const src = (await create({ id: "ws-rp-src" })).body;
    expect(src.blocks.assumptions.routingPolicy?.id).toBe(SEED_IDS.routingPolicy);
    const copy = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/workspaces/ws-rp-src/clone", { expectedRevision: src.revision, by: "tester", mode: "copy", name: "Copy", id: "ws-rp-copy", blocks: ["assumptions"] });
    expect(copy.status).toBe(201);
    expect(copy.body.manifest.blocks.assumptions.routingPolicy).toEqual(src.blocks.assumptions.routingPolicy);

    const swapped = await blocks("ws-rp-src", src.revision, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: "a-user-policy-v1" } });
    expect(swapped.status).toBe(201);
    expect(swapped.body.blocks.assumptions.routingPolicy?.id).toBe("a-user-policy-v1");
    const again = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/workspaces/ws-rp-src/clone", { expectedRevision: swapped.body.revision, by: "tester", mode: "copy", name: "Copy 2", id: "ws-rp-copy-2", blocks: ["assumptions"] });
    expect(again.status).toBe(201);
    expect(again.body.manifest.blocks.assumptions.routingPolicy).toEqual(swapped.body.blocks.assumptions.routingPolicy);
  });

  it("a blank workspace validates a minimal setup with no attach call", async () => {
    const w = (await create({ id: "ws-rp-validate" })).body;
    const put = async (body: object) => {
      const h = await head("ws-rp-validate");
      const r = await blocks("ws-rp-validate", h.revision, body);
      expect(r.status).toBe(201);
    };
    await put({ block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    await put({ block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await put({ block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    const v = await api<{ outcome: string }>(t.base, "POST", `/api/workspaces/ws-rp-validate/setups/${slot}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.text).not.toMatch(/no routing policy/);
    expect(["pass", "warn"]).toContain(v.body.outcome);
  });
});
