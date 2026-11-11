/**
 * The learn profile and the learn kit's seed, on a test platform over a scratch store.
 *
 *  1. The learn profile plans the starter's documents exactly (bytes and meta) and seeds no workspace, and config
 *     accepts it beside "demo" and "starter".
 *  2. The seed (apps/studio/src/guided/learnSeed.ts, through the Studio's own calls) makes the Example bank workspace
 *     with the finished analysis and the Deposit desk workspace, opens every demo the server lists into its own slot,
 *     and runs each slot once, the finished analysis included: 16 done runs, one per slot, each attached by launch.
 *  3. Each demo slot holds the stored demo setup (the document id the server lists); the guided slot holds the finished
 *     analysis on the Example bank only.
 *  4. A second seed launches nothing, makes nothing, and leaves a slot the learner changed as it is.
 *
 * Expected counts and ids are restated here from the server's demo modules and the example files, never read from the
 * seed's own report.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest, WorkspaceRunRow } from "@alm/reader";
import { planSeedDocuments, seedStore } from "../../scripts/seed-store";
import { repoRoot, resolveConfig } from "../config";
import { FileStore, serializeDocument } from "../store/store";
import { LEARN_SEED_PROFILE, STARTER_SEED_PROFILE } from "../registry";
import { featureDemos } from "../examples/featureDemos";
import { depositFormDemos } from "../examples/depositForms";
import { survivalPathDemos } from "../examples/survivalPathDemo";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import { seedLearnStore, type LearnSeedReport } from "../../../studio/src/guided/learnSeed";
import { fetchOn, parseLearnSeedArgs } from "../../scripts/seed-learn";

const ROOT = repoRoot();
let t: TestPlatform;
const realFetch = globalThis.fetch;
let first: LearnSeedReport;

beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), ROOT, { mode: "seed" }, LEARN_SEED_PROFILE);
  vi.stubGlobal("fetch", fetchOn(t.base, realFetch));
  first = await seedLearnStore(() => undefined);
}, 600_000);
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const workspaces = async () => (await api<WorkspaceManifest[]>(t.base, "GET", "/api/workspaces")).body;
const runsOf = async (ws: string) => (await api<WorkspaceRunRow[]>(t.base, "GET", `/api/workspaces/${ws}/runs`)).body;

describe("the learn profile", () => {
  it("plans the starter's documents byte for byte and seeds no workspace; config accepts it", async () => {
    const starter = await planSeedDocuments(ROOT, STARTER_SEED_PROFILE);
    const learn = await planSeedDocuments(ROOT, LEARN_SEED_PROFILE);
    expect(learn.map((d) => `${d.collection}/${d.id} ${serializeDocument(d.doc)} ${JSON.stringify(d.meta)}`)).toEqual(
      starter.map((d) => `${d.collection}/${d.id} ${serializeDocument(d.doc)} ${JSON.stringify(d.meta)}`),
    );
    expect(resolveConfig({ ALM_SEED_PROFILE: "learn" }).seedProfile).toBe("learn");
    expect(LEARN_SEED_PROFILE).toBe("learn");
  });
});

describe("the learn seed", () => {
  it("makes the Example bank and the Deposit desk, on their books, and nothing else", async () => {
    const ws = await workspaces();
    expect(ws.map((w) => [w.name, w.blocks.positions.book?.id]).sort()).toEqual([
      ["Deposit desk", "quillfield-deposit-desk-v1"],
      ["Example bank", "mid-size-bank-v1"],
    ]);
    expect(first.made.sort()).toEqual(["Deposit desk", "Example bank"]);
    expect(first.left).toEqual([]);
  });

  it("runs every slot once to done: the finished analysis and the fifteen demos, each on its book's workspace", async () => {
    const ws = await workspaces();
    const bank = ws.find((w) => w.name === "Example bank")!;
    const desk = ws.find((w) => w.name === "Deposit desk")!;
    // Restated from the server's demo modules: the bank's slots, then the desk's.
    const bankSlots = ["setup-guided", ...featureDemos(ROOT).map((d) => `demo-${d.id}`), "demo-funding-tenor", ...survivalPathDemos(ROOT).map((d) => `demo-${d.id}`)];
    const deskSlots = depositFormDemos(ROOT).filter((d) => d.bookId === "quillfield-deposit-desk-v1").map((d) => `demo-${d.id}`);
    expect(bankSlots).toHaveLength(10);
    expect(deskSlots).toHaveLength(6);
    for (const [w, slots] of [[bank, bankSlots], [desk, deskSlots]] as const) {
      const rows = await runsOf(w.id);
      expect(rows.map((r) => r.setupLineageId).sort(), w.name).toEqual([...slots].sort());
      for (const r of rows) {
        expect(r.status?.state, `${w.name} ${r.setupLineageId}`).toBe("done");
        expect(r.attachedBy).toBe("launch");
      }
    }
  });

  it("puts each demo's stored setup in its slot, and the finished analysis in the guided slot", async () => {
    const ws = await workspaces();
    const all = [...featureDemos(ROOT), ...depositFormDemos(ROOT), ...survivalPathDemos(ROOT)];
    for (const w of ws) {
      const demoSlots = w.blocks.run.setups.filter((s) => s.setupLineageId.startsWith("demo-"));
      expect(demoSlots.length, w.name).toBe(w.name === "Example bank" ? 9 : 6);
      for (const slot of demoSlots) {
        const demo = all.find((d) => `demo-${d.id}` === slot.setupLineageId);
        expect(demo, slot.setupLineageId).toBeDefined();
        expect(slot.current.id, slot.setupLineageId).toBe(demo!.setup.id);
      }
      // The finished analysis sits in the guided slot of the Example bank only; the workspace's own default slot stays.
      expect(w.blocks.run.setups.some((s) => s.setupLineageId === "setup-guided")).toBe(w.name === "Example bank");
    }
  });

  it("a second seed launches nothing, makes nothing, and keeps a slot the learner changed", async () => {
    const before = await workspaces();
    const bank = before.find((w) => w.name === "Example bank")!;
    // The learner saves a changed SEG setup into its slot.
    const seg = featureDemos(ROOT).find((d) => d.id === "seg")!;
    const { id: _id, ...body } = seg.setup;
    const changed = { ...body, seg: { ...body.seg!, niiShockBp: 200 } };
    const saved = await api<{ setup: { id: string } }>(t.base, "POST", "/api/run-setups", { workspaceId: bank.id, setupLineageId: "demo-seg", expectedRevision: bank.revision, by: "Learner", setup: changed });
    expect(saved.status).toBe(201);
    const runsBefore = (await runsOf(bank.id)).length;

    const second = await seedLearnStore(() => undefined);
    expect(second.made).toEqual([]);
    expect(second.launched).toEqual([]);
    expect(second.kept).toHaveLength(16);
    expect((await runsOf(bank.id)).length).toBe(runsBefore);
    const after = (await workspaces()).find((w) => w.id === bank.id)!;
    expect(after.blocks.run.setups.find((s) => s.setupLineageId === "demo-seg")!.current.id).toBe(saved.body.setup.id);
    expect(saved.body.setup.id).not.toBe(seg.setup.id);
  });
});

describe("the seed step's command line", () => {
  it("takes a loopback base only, and sends the reader's relative calls there", async () => {
    expect(parseLearnSeedArgs(["--base", "http://127.0.0.1:8870"])).toEqual({ base: "http://127.0.0.1:8870" });
    for (const argv of [[], ["--base"], ["--base", "http://example.com:8870"], ["--base", "http://127.0.0.1"]]) expect(() => parseLearnSeedArgs(argv)).toThrow();
    const seen: string[] = [];
    const f = fetchOn("http://127.0.0.1:8870", (async (input: string | URL | Request) => { seen.push(String(input)); return new Response("{}"); }) as typeof fetch);
    await f("/api/health");
    await f("http://127.0.0.1:9/x");
    expect(seen).toEqual(["http://127.0.0.1:8870/api/health", "http://127.0.0.1:9/x"]);
  });
});
