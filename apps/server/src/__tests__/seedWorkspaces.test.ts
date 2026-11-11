/**
 * The seed's workspace generator (Studio A+E spec v3.1 Section 2.7; plan Task D1).
 *
 * The migration table is restated by hand below and also asserted against the generation rule:
 * ten workspaces; 20 of 20 sets; 8 of 8 authored slates; 5 of 5 balance plans; 15 of 15 run plans;
 * 12 of 12 runs; no legacy workspace; one seeded document deliberately unattached.
 *
 * A fresh seed holds only seeded documents and no runs, so the author's store of 2026-10-09 is
 * planted from committed fixtures (seedWorkspaceFixtures.ts) before the generator runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { PortfolioSpec } from "@alm/engine";
import { seasoningRefusals } from "@alm/engine/src/portfolio/seasoning";
import { buildVanillaPortfolio } from "@alm/data";
import { buildDemoPortfolio } from "@alm/data/src/demo/request";
import { SEED_IDS, seedStore } from "../../scripts/seed-store";
import {
  KNOWN_ENGINE_REFUSALS,
  UNATTACHED_SEED_DOCUMENTS,
  UNNAMED_SEED_ATTACHMENTS,
  formatWorkspaceSeedReport,
} from "../../scripts/seed-workspaces";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { writeBlockOp } from "../workspaces/rules";
import { putBook } from "../http/routes/portfolios";
import { copyStoreWithoutDb, seededTemplate } from "./seedFixtures";
import { fixtureRuns, plantOwnerStore, withoutWorkspaces } from "./seedWorkspaceFixtures";

let template: string;
const made: string[] = [];
beforeAll(async () => {
  template = await seededTemplate();
  made.push(template);
}, 120_000);
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** Spec v3.1 Section 2.7 table, restated by hand. Counts are (sets, slates, balance plans, setups excluding Standard ALCO, runs). */
const EXPECTED: Record<
  string,
  { type: string; book: string; derived: string[]; sets: number; defaultSet: string; slates: number; plans: number; setups: number; runs: number }
> = {
  "ws-synthetic-2500-v1": { type: "test", book: "synthetic-2500-v1", derived: ["macro-demo-v1", "tlp-shock-demo-v1", "vol-shock-demo-v1"], sets: 16, defaultSet: "demo-behavioral-v1", slates: 5, plans: 2, setups: 8, runs: 6 },
  "ws-synthetic-2500-hedged-v1": { type: "test", book: "synthetic-2500-hedged-v1", derived: [], sets: 11, defaultSet: "demo-behavioral-v1", slates: 3, plans: 0, setups: 1, runs: 1 },
  "ws-synthetic-2500-indexed-v1": { type: "test", book: "synthetic-2500-indexed-v1", derived: ["rate-indices-demo-v1"], sets: 11, defaultSet: "demo-behavioral-v1", slates: 3, plans: 0, setups: 1, runs: 0 },
  "ws-vanilla-book-v1": { type: "test", book: "vanilla-book-v1", derived: ["vol-shock-demo-v1"], sets: 1, defaultSet: "vanilla-empty-v1", slates: 1, plans: 3, setups: 4, runs: 5 },
  "ws-synthetic-lcr-liabilities-v1": { type: "test", book: "synthetic-lcr-liabilities-v1", derived: [], sets: 1, defaultSet: "vanilla-empty-v1", slates: 1, plans: 0, setups: 1, runs: 0 },
  "ws-synthetic-2500-hqla-v1": { type: "stress", book: "synthetic-2500-hqla-v1", derived: [], sets: 1, defaultSet: "liquidity-stress-demo-v1", slates: 1, plans: 0, setups: 0, runs: 0 },
  "ws-synthetic-2500-lcr-v1": { type: "stress", book: "synthetic-2500-lcr-v1", derived: [], sets: 1, defaultSet: "liquidity-stress-demo-v1", slates: 1, plans: 0, setups: 0, runs: 0 },
  "ws-synthetic-2500-commit-v1": { type: "stress", book: "synthetic-2500-commit-v1", derived: [], sets: 3, defaultSet: "liquidity-stress-demo-v1", slates: 2, plans: 0, setups: 0, runs: 0 },
  "ws-import-synthetic-25k-sitdown": { type: "test", book: "synthetic-25k-sitdown", derived: [], sets: 1, defaultSet: "vanilla-empty-v1", slates: 1, plans: 0, setups: 0, runs: 0 },
  "ws-import-vanilla-sitdown-v1": { type: "test", book: "vanilla-sitdown-v1", derived: [], sets: 1, defaultSet: "vanilla-empty-v1", slates: 1, plans: 0, setups: 0, runs: 0 },
};

function plantedCopy(prefix: string): string {
  const root = copyStoreWithoutDb(template, prefix);
  made.push(root);
  withoutWorkspaces(root);
  plantOwnerStore(root);
  return root;
}

describe("seed-workspaces", () => {
  it("reproduces the Section 2.7 table on the author's planted store, with no legacy workspace", async () => {
    const root = plantedCopy("ae1-seedws-");
    const store = new FileStore(root);
    const report = await seedStore(store, repoRoot());
    const ws = new WorkspaceStore(root);
    const heads = ws.list();

    // The rule's own totals, restated: 10 workspaces, 12 runs, none legacy.
    expect(heads.map((h) => h.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(heads).toHaveLength(10);
    expect(report.workspaces!.created.sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(report.workspaces!.legacyWorkspace).toBeNull();
    expect(report.workspaces!.runsAttached).toHaveLength(12);
    expect(report.workspaces!.unimportedPlans).toEqual([]);

    for (const [id, e] of Object.entries(EXPECTED)) {
      const h = heads.find((x) => x.id === id)!;
      expect(h.type).toBe(e.type);
      expect(h.cutoffDate).toBe("2026-03-31");
      expect(h.lineage.mode).toBe("seed");
      expect(h.status).toBe("active");
      expect(h.revision).toBe(1);
      expect(h.blocks.positions.book!.id).toBe(e.book);
      expect(h.blocks.market.snapshot!.id).toBe("market-public-2026-03-31");
      expect(h.blocks.market.derived.map((d) => d.id).sort()).toEqual([...e.derived].sort());
      for (const d of h.blocks.market.derived) {
        expect(d.definitionKey).toBe(d.id);
        expect(d.parentKey).toBeNull();
      }
      expect(h.blocks.assumptions.sets, id).toHaveLength(e.sets);
      expect(h.blocks.assumptions.defaultSetId).toBe(e.defaultSet);
      expect(h.blocks.assumptions.sets[0]!.id).toBe(e.defaultSet);
      expect(h.blocks.scenarios.slates, id).toHaveLength(e.slates);
      expect(h.blocks.targets.balancePlans, id).toHaveLength(e.plans);
      expect(h.blocks.run.setups.filter((s) => s.setupLineageId.startsWith("setup-plan-")), id).toHaveLength(e.setups);
      expect(h.blocks.run.setups.filter((s) => !s.setupLineageId.startsWith("setup-plan-"))).toHaveLength(1);
      expect(h.blocks.run.lenses).toHaveLength(6);
      expect(h.blocks.assumptions.routingPolicy).not.toBeNull();
      expect(h.blocks.positions.coa).not.toBeNull();
      expect(ws.readRunAttachments(id), id).toHaveLength(e.runs);
      for (const a of ws.readRunAttachments(id)) expect(a).toEqual(expect.objectContaining({ attachedBy: "migration", pins: "reconstructed" }));
      for (const line of ws.history(id)) expect(line.by).toBe("seed");
      // Every pin resolves live at its meta hash.
      for (const [block, refs] of Object.entries({
        book: [h.blocks.positions.book],
        sets: h.blocks.assumptions.sets,
        slates: h.blocks.scenarios.slates,
        plans: h.blocks.targets.balancePlans,
        derived: h.blocks.market.derived,
        setups: h.blocks.run.setups.map((s) => s.current),
      })) {
        for (const r of refs) if (r) expect(store.getMeta(r.collection, r.id).contentHash, `${id} ${block} ${r.id}`).toBe(r.contentHash);
      }
    }
    expect(heads.find((h) => h.id === "ws-synthetic-2500-lcr-v1")!.blocks.positions.hierarchies.map((x) => x.id)).toEqual(["liquidity-funding-demo-v1"]);
    expect(heads.find((h) => h.id === "ws-synthetic-2500-lcr-v1")!.blocks.positions.taxonomy!.id).toBe("liquidity-tags-v1");
    expect(heads.find((h) => h.id === "ws-synthetic-2500-commit-v1")!.blocks.positions.taxonomy!.id).toBe("liquidity-tags-v2");
    expect(heads.find((h) => h.id === "ws-synthetic-2500-v1")!.blocks.assumptions.sets.map((s) => s.id)).toContain("stack-ab60dc782a83");
    expect(heads.find((h) => h.id === "ws-synthetic-2500-v1")!.blocks.scenarios.slates.map((s) => s.id)).toContain("regulatory-grid-edit-1");
    expect(heads.find((h) => h.id === "ws-synthetic-2500-v1")!.blocks.scenarios.slates.map((s) => s.id)).not.toContain("plan-plan-synthetic-2500-v1");
    const inline = heads
      .flatMap((h) => h.blocks.run.setups)
      .filter((s) => ["setup-plan-synthetic-2500-v1-edit-2", "setup-plan-synthetic-2500-v1-edit-3", "setup-plan-vanilla-book-v1-edit-2", "setup-plan-vanilla-book-v1-edit-3"].includes(s.setupLineageId));
    expect(inline).toHaveLength(4);
    // The example bank's chart joins the list, for the same reason as the demo taxonomy.
    // The two feature demo sets join it; the example bank's workspace takes them when a demo opens.
    // The deposit desk's five sets join it; the desk's workspace takes them when a desk demo opens.
    expect(report.workspaces!.unattached).toEqual([
      "assumption-sets/quillfield-constant-prepay-v1",
      "assumption-sets/quillfield-desk-component-decay-v1",
      "assumption-sets/quillfield-desk-credit-v1",
      "assumption-sets/quillfield-desk-full-beta-v1",
      "assumption-sets/quillfield-desk-plain-v1",
      "assumption-sets/quillfield-desk-scenario-credit-v1",
      "assumption-sets/quillfield-illustrative-v1",
      "coa/mid-size-bank-coa-v1",
      "taxonomy/demo-dimensions-v1",
    ]);
    expect(UNATTACHED_SEED_DOCUMENTS.map((u) => `${u.collection}/${u.id}`)).toEqual([
      "taxonomy/demo-dimensions-v1",
      "coa/mid-size-bank-coa-v1",
      "assumption-sets/quillfield-illustrative-v1",
      "assumption-sets/quillfield-constant-prepay-v1",
    ]);
    expect(UNNAMED_SEED_ATTACHMENTS.map((u) => u.id).sort()).toEqual([
      "balance-targets-demo-v1",
      "liquidity-squeeze-demo-v1",
      "liquidity-stress-demo-v1",
      "stress-illustrative-v1",
      "tlp-shock-demo-v1",
      "vol-shock-demo-v1",
    ]);
    // The one stored plan the engine refuses is imported and named, never attached silently.
    expect(report.workspaces!.expectedToFail).toHaveLength(1);
    expect(report.workspaces!.expectedToFail[0]).toContain("plan-synthetic-2500-v1-edit-2");
    expect(KNOWN_ENGINE_REFUSALS.map((k) => k.planId)).toEqual(["plan-synthetic-2500-v1-edit-2"]);
  }, 180_000);

  it("attaches every stored document of the author's store: coverage by counts", async () => {
    const root = plantedCopy("ae1-seedws-cov-");
    const store = new FileStore(root);
    await seedStore(store, repoRoot());
    const heads = new WorkspaceStore(root).list();
    const sets = new Set(heads.flatMap((h) => h.blocks.assumptions.sets.map((s) => s.id)));
    const slates = new Set(heads.flatMap((h) => h.blocks.scenarios.slates.map((s) => s.id)));
    const plans = new Set(heads.flatMap((h) => h.blocks.targets.balancePlans.map((s) => s.id)));
    const markets = new Set(heads.flatMap((h) => [h.blocks.market.snapshot!.id, ...h.blocks.market.derived.map((d) => d.id)]));
    const books = new Set(heads.map((h) => h.blocks.positions.book!.id));
    // Restated by hand from spec Section 2.7: 20 sets, 8 authored slates, 5 balance plans, 5 markets, 10 books.
    // The store holds 22, the two feature demo sets in no workspace until a demo opens.
    // Studio slice S3c-1: 27, the deposit desk's five sets likewise.
    expect(store.listMeta("assumption-sets")).toHaveLength(27);
    expect(sets.size).toBe(20);
    expect(store.listMeta("scenario-slates").filter((m) => m.fromPlan === undefined)).toHaveLength(8);
    expect(slates.size).toBe(8);
    expect(store.listMeta("plans")).toHaveLength(5);
    expect(plans.size).toBe(5);
    expect(store.listMeta("market")).toHaveLength(5);
    expect(markets.size).toBe(5);
    expect(store.listMeta("portfolios")).toHaveLength(10);
    expect(books.size).toBe(10);
    // 15 of 15 run plans imported, each once.
    const imported: string[] = [];
    for (const h of heads) for (const s of h.blocks.run.setups) {
      const from = store.getDocument<{ importedFrom: string | null }>("run-setups", s.current.id).doc.importedFrom;
      if (from !== null) imported.push(from);
    }
    expect(store.listMeta("run-plans")).toHaveLength(15);
    expect(imported.sort()).toEqual(store.listMeta("run-plans").map((m) => m.id).sort());
    // The 12 planted runs are the 12 of the author's store.
    expect(fixtureRuns()).toHaveLength(12);
  }, 180_000);

  it("holds no stored or demo book with a position the engine cannot season, so the D4 refusal blocks no seeded workspace (boot guard)", async () => {
    const root = plantedCopy("t7-seedws-season-");
    const store = new FileStore(root);
    await seedStore(store, repoRoot());
    const stored = store.listMeta("portfolios").map((m) => store.getDocument<PortfolioSpec>("portfolios", m.id).doc);
    // Every workspace book of the Section 2.7 table is among the stored books checked.
    expect(stored.map((b) => b.id)).toEqual(expect.arrayContaining(Object.values(EXPECTED).map((e) => e.book)));
    const books = [...stored, buildVanillaPortfolio(), buildDemoPortfolio()];
    expect(books.reduce((n, b) => n + b.positions.length, 0)).toBeGreaterThan(10_000);
    const refused = books.flatMap((b) => seasoningRefusals(b).map((r) => `${b.id}/${r.positionId}: ${r.message}`));
    expect(refused).toEqual([]);
  }, 180_000);

  it("is idempotent and leaves a hand-edited head alone", async () => {
    const root = plantedCopy("ae1-seedws2-");
    const store = new FileStore(root);
    await seedStore(store, repoRoot());
    const ws = new WorkspaceStore(root);
    const h = ws.head("ws-vanilla-book-v1");
    ws.commit(h.id, h.revision, "analyst", { kind: "meta", note: "mine" }, { ...h, note: "mine" });
    const second = await seedStore(store, repoRoot());
    expect(second.workspaces!.created).toEqual([]);
    expect(second.workspaces!.runsAttached).toEqual([]);
    expect(new WorkspaceStore(root).head("ws-vanilla-book-v1").note).toBe("mine");
    expect(new WorkspaceStore(root).history("ws-vanilla-book-v1")).toHaveLength(2);
    expect(new WorkspaceStore(root).readRunAttachments("ws-vanilla-book-v1")).toHaveLength(5);
  }, 180_000);

  it("gives a book an analyst imported into a workspace after the migration no ws-import workspace on the next boot (review M3)", async () => {
    const root = plantedCopy("ae1-seedws-import-");
    const store = new FileStore(root);
    await seedStore(store, repoRoot());
    const ws = new WorkspaceStore(root);
    // Import-into-workspace: the book is stored, then the positions block is set (routes/portfolios.ts).
    const sit = store.getDocument<{ id: string; label: string; asOf: string; positions: unknown[] }>("portfolios", "vanilla-sitdown-v1").doc;
    const meta = putBook(store, { ...sit, id: "analyst-book-v1", label: "Analyst book" } as never, undefined);
    writeBlockOp(ws, "ws-synthetic-lcr-liabilities-v1", null, "analyst", "positions", "set", "portfolios", "analyst-book-v1", {
      collection: "portfolios",
      id: "analyst-book-v1",
      contentHash: meta.contentHash,
      asOf: sit.asOf,
    });
    const before = new WorkspaceStore(root).list().map((h) => [h.id, h.revision] as const).sort();
    const second = await seedStore(store, repoRoot());
    expect(second.workspaces!.created).toEqual([]);
    expect(second.workspaces!.runsAttached).toEqual([]);
    const heads = new WorkspaceStore(root).list();
    expect(heads.map((h) => h.id).filter((id) => id.startsWith("ws-import-analyst"))).toEqual([]);
    expect(heads.map((h) => [h.id, h.revision] as const).sort()).toEqual(before);
    expect(heads).toHaveLength(10);
  }, 180_000);

  it("on the freshly seeded store (no authored documents, no runs) creates the eight seeded workspaces", async () => {
    // The template itself: seeded by the new code, so the generator already ran once.
    const ws = new WorkspaceStore(template);
    const ids = ws.list().map((h) => h.id).sort();
    expect(ids).toEqual(
      [
        "ws-synthetic-2500-v1",
        "ws-synthetic-2500-hedged-v1",
        "ws-synthetic-2500-indexed-v1",
        "ws-vanilla-book-v1",
        "ws-synthetic-lcr-liabilities-v1",
        "ws-synthetic-2500-hqla-v1",
        "ws-synthetic-2500-lcr-v1",
        "ws-synthetic-2500-commit-v1",
      ].sort(),
    );
    // Nine seeded run plans: 5 on the synthetic book, hedged, indexed, liabilities, vanilla; each its own setup.
    const synth = ws.head("ws-synthetic-2500-v1");
    expect(synth.blocks.run.setups.filter((s) => s.setupLineageId.startsWith("setup-plan-"))).toHaveLength(5);
    expect(synth.blocks.assumptions.sets.map((s) => s.id).sort()).toEqual(
      ["decay-shock-demo-v1", "demo-behavioral-v1", "housing-demo-v1", "housing-flat-demo-v1", "loan-repricing-demo-v1", "stress-illustrative-v1"].sort(),
    );
    for (const h of ws.list()) expect(ws.readRunAttachments(h.id)).toEqual([]);
  });

  it("keeps its seeded literals equal to SEED_IDS and prints both lists", () => {
    expect(UNNAMED_SEED_ATTACHMENTS.find((u) => u.id === SEED_IDS.fundingSpreadShockMarket)).toBeDefined();
    expect(UNNAMED_SEED_ATTACHMENTS.find((u) => u.id === SEED_IDS.volShockMarket)).toBeDefined();
    expect(UNNAMED_SEED_ATTACHMENTS.find((u) => u.id === SEED_IDS.stressAssumptions)).toBeDefined();
    expect(UNNAMED_SEED_ATTACHMENTS.find((u) => u.id === SEED_IDS.demoBalancePlan)).toBeDefined();
    expect(UNNAMED_SEED_ATTACHMENTS.find((u) => u.id === SEED_IDS.liquidityAssumptions)!.workspaceIds).toEqual([
      `ws-${SEED_IDS.hqlaPortfolio}`,
      `ws-${SEED_IDS.lcrPortfolio}`,
      `ws-${SEED_IDS.commitmentPortfolio}`,
    ]);
    expect(UNNAMED_SEED_ATTACHMENTS.find((u) => u.id === SEED_IDS.squeezeAssumptions)!.workspaceIds).toEqual([`ws-${SEED_IDS.commitmentPortfolio}`]);
    expect(UNATTACHED_SEED_DOCUMENTS[0]).toEqual(expect.objectContaining({ collection: "taxonomy", id: SEED_IDS.demoTaxonomy }));
    const lines = formatWorkspaceSeedReport(
      { created: ["ws-x"], unnamedAttachments: ["market/m -> ws-x (why)"], unattached: ["taxonomy/demo-dimensions-v1"], runsAttached: ["run-1 -> ws-x"], legacyWorkspace: null, unimportedPlans: [], expectedToFail: [] },
      "platform:",
    );
    expect(lines).toEqual([
      "platform: seeded workspace ws-x",
      "platform: attached run run-1 -> ws-x",
      "platform: attached by the seed map: market/m -> ws-x (why)",
      expect.stringContaining("platform: in no workspace: taxonomy/demo-dimensions-v1 ("),
    ]);
  });
});
