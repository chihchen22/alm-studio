/**
 * The setup compile (Studio A+E spec v3.1 Section 5.2 steps 1 to 8; contracts 5, 6
 * and 15; plan Task C2).
 *
 * Invariant 8, migration parity: each of the fifteen stored run plans, imported as a
 * setup inside a workspace that holds its inputs, compiles to the stored plan's own
 * bytes. The nine seeded plans come from the real seed; the six edited plans (and the
 * three balance plans and one stacked set they read) are verbatim copies of the
 * documents in var/store on 2026-10-09, under fixtures/edited-store, so the proof does
 * not depend on the live store. Every plan hash below is restated by hand: each was
 * computed outside the engine (Python, sorted-key compact JSON, SHA-256) over the
 * var/store file and agrees with the engine's contentHash. One stored plan,
 * plan-synthetic-2500-v1-edit-2, is refused by today's engine through the plans route
 * itself; for it, parity is the same plan bytes and the same refusal.
 *
 * The basis label is read from provenance, never from rule shapes (MAJOR 1, ruling 20).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planHash, type PortfolioSpec, type RunPlan } from "@alm/engine";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { compileStoredPlan } from "../http/routes/plans";
import { HttpError } from "../http/errors";
import { FileStore, sha256Hex } from "../store/store";
import type { Collection } from "../store/paths";
import { emptyBlocks } from "../workspaces/clone";
import { importPlanAsSetup } from "../workspaces/importPlan";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { assembleSetupPlan, compileSetupRow, routableDerivedStages } from "../workspaces/setupCompile";
import { standardAlcoSetup } from "../workspaces/standardAlco";
import type { DocRef, RunSetup, SetupSlot, WorkspaceManifest } from "../workspaces/types";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { bootTestPlatform, type TestPlatform } from "./harness";
import { runCompiledRow } from "./runCompiledRow";

let t: TestPlatform;
let store: FileStore;
let wsStore: WorkspaceStore;

const FIXTURES = join(__dirname, "fixtures", "edited-store");
const ROUTING_POLICY = "model-map-default-v1";
const PINNED_AT = "2026-10-09T00:00:00.000Z";
/** A fixed slot id, so the planId's lineage half is a literal. */
const LINEAGE = "setup-0a1b2c3d";

/**
 * contentHash of each stored plan, computed outside the engine over var/store/run-plans on 2026-10-09. Re-pinned once in
 * OSS slice S1 for the neutral routing policy id: with the old id read back each plan hashes to its 2026-10-09
 * literal.
 */
const STORED_PLAN_HASHES: Record<string, string> = {
  "plan-synthetic-2500-hedged-v1": "4836fc5d8d42a0919ec9a2b9bf4bc3119da2080e1d2a00c9b594c845b33be939",
  "plan-synthetic-2500-housing-flat-v1": "dcd171b0db2c01cc73bbe3c8285dfa88d825aa0dfaec1f48fc2c8226b2720f30",
  "plan-synthetic-2500-housing-v1": "52e891e82ecfd780b27b0c7487ca4761e4374844c6b06892b83c8685296947e9",
  "plan-synthetic-2500-indexed-v1": "2cd605a9628f0484b3f359956adb2d15ad6fc5e2598a576793a7ccbe43d9f429",
  "plan-synthetic-2500-loan-repricing-v1": "44d703bb404a50429eab58aa0dbe0f66e14b2f1a0655a1869fe033438b738c08",
  "plan-synthetic-2500-macro-unmapped-v1": "13774f87fdf7e4e1141b1e0b635d4e877f2a71e7313361dc4a06f9c8333635f3",
  "plan-synthetic-2500-v1-edit-1": "e60614293fc634e61e47c5d833925aa936397f07291ffb6369a93055f85006bb",
  "plan-synthetic-2500-v1-edit-2": "a4743ef582c93619c7af7679650eaf51e8b93f8d1cb97920e5144e131c7d09f6",
  "plan-synthetic-2500-v1-edit-3": "e0dcbbd4530d72de3f304ee582979e13271a42ed5a5cc66523be0e5aefffa640",
  "plan-synthetic-2500-v1": "e38960010d0dcbd8dd7f8da98c3a4dcc08807025ce5c6854e629573a8e5e6555",
  "plan-synthetic-lcr-liabilities-v1": "5a0473cef023e33ac00fb5adc720f80fca700b58f306e07664131b05aa86ee86",
  "plan-vanilla-book-v1-edit-1": "31f3fcc7a1aa37b77d7d72a3c86a4066863c7f62688b3cbe54edd9f97da66b22",
  "plan-vanilla-book-v1-edit-2": "0dcf2cc7dd1275e6a44df9e7c5f596667ad77a516f86b4a7ef360873eac5c6df",
  "plan-vanilla-book-v1-edit-3": "232f0c203d1910d50dcf377b77549a40e8c6f3e9cf2ee9a88895eb2a01cfbd82",
  "plan-vanilla-book-v1": "c28c10c17d8a11a5d1cfa784cd9f44f913571ab6bac4ad92290a2f1c73756cf0",
};

/** The four plans with inline scenario definitions (Section 2.7 rule 10). */
const INLINE_PLANS = [
  "plan-synthetic-2500-v1-edit-2",
  "plan-synthetic-2500-v1-edit-3",
  "plan-vanilla-book-v1-edit-2",
  "plan-vanilla-book-v1-edit-3",
];

/** The stored file's SHA-256, restated: the stacked set's meta in var/store carries this hash. */
const STACK_SET_FILE_HASH = "306158b0976cbbb7c9c00a22e9ee3b933984e6e977c1909dd92820d25ddba549";

beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  for (const collection of ["run-plans", "plans", "assumption-sets"] as const) {
    for (const file of readdirSync(join(FIXTURES, collection)).filter((f) => f.endsWith(".json")).sort()) {
      const doc = JSON.parse(readFileSync(join(FIXTURES, collection, file), "utf8")) as { id?: string; planId?: string; label?: string };
      const id = doc.id ?? doc.planId!;
      store.putDocument(collection, id, doc, { label: doc.label ?? id });
    }
  }
  wsStore = new WorkspaceStore(t.storeRoot);
});
afterAll(() => t.close());
const ctx = () => t.platform.context;

function ref(collection: Collection, id: string): DocRef {
  return { collection, id, contentHash: store.getMeta(collection, id).contentHash, pinnedAt: PINNED_AT };
}

/** A workspace holding one book, the public market (plus named derived markets), the sets named, the routing policy, the demo COA and the Standard ALCO slot. */
function workspaceFor(
  id: string,
  bookId: string,
  setIds: string[],
  extraMarkets: string[] = [],
  balancePlanIds: string[] = [],
  cutoffDate = "2026-03-31",
): WorkspaceManifest {
  const alco = standardAlcoSetup(id);
  if (!store.has("run-setups", alco.id)) store.putDocument("run-setups", alco.id, alco, { label: alco.name });
  const blocks = emptyBlocks();
  blocks.positions.book = ref("portfolios", bookId);
  blocks.positions.coa = ref("coa", "demo-coa-v1");
  blocks.market.snapshot = ref("market", SEED_IDS.market);
  blocks.market.derived = [...new Set(extraMarkets)]
    .filter((m) => m !== SEED_IDS.market)
    .map((m) => ({ ...ref("market", m), definitionKey: m, parentKey: null }));
  blocks.assumptions.sets = setIds.map((s) => ref("assumption-sets", s));
  blocks.assumptions.defaultSetId = setIds[0] ?? null;
  blocks.assumptions.routingPolicy = ref("routing-policies", ROUTING_POLICY);
  blocks.targets.balancePlans = [...new Set(balancePlanIds)].map((p) => ref("plans", p));
  blocks.run.setups = [{ setupLineageId: LINEAGE, current: ref("run-setups", alco.id) }];
  const manifest: WorkspaceManifest = {
    schemaVersion: "1.0.0",
    id,
    name: id,
    type: "test",
    status: "active",
    cutoffDate,
    owner: "tester",
    createdAt: PINNED_AT,
    updatedAt: PINNED_AT,
    revision: 0,
    blocks,
    blockHashes: { market: "", positions: "", targets: "", assumptions: "", scenarios: "", run: "" },
    signedHash: "",
    manifestHash: "",
    lineage: { mode: "blank", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false },
    clashes: [],
    lock: null,
    note: "",
  };
  return wsStore.create(manifest, "tester");
}

const importSlot = (planId: string): SetupSlot => ({
  setupLineageId: `setup-${planId}`,
  current: { collection: "run-setups", id: "rs-x", contentHash: "0".repeat(64), pinnedAt: "t" },
});

const withoutId = (s: RunSetup): Omit<RunSetup, "id"> => {
  const { id: _id, ...rest } = s;
  return rest;
};

describe("setup compile", () => {
  it("the test store holds the fifteen stored plans and the edited inputs byte for byte", () => {
    expect(store.listMeta("run-plans").map((m) => m.id)).toEqual(Object.keys(STORED_PLAN_HASHES).sort());
    expect(store.getMeta("assumption-sets", "stack-ab60dc782a83").contentHash).toBe(STACK_SET_FILE_HASH);
    for (const meta of store.listMeta("run-plans")) {
      expect(contentHash(store.getDocument<RunPlan>("run-plans", meta.id).doc)).toBe(STORED_PLAN_HASHES[meta.id]);
    }
  });

  it("each of the fifteen stored plans imports and compiles to the plan's own request bytes (invariant 8), four through plan-scenarios", () => {
    const inline: string[] = [];
    const compiledIds: string[] = [];
    const refusedIds: string[] = [];
    for (const meta of store.listMeta("run-plans")) {
      const plan = store.getDocument<RunPlan>("run-plans", meta.id).doc;
      const bps = [...(plan.balancePlan !== undefined ? [plan.balancePlan] : []), ...Object.values(plan.scenarioBalancePlans ?? {})];
      const ws = workspaceFor(`ws-imp-${meta.id}`, plan.inputs.positionBook, plan.inputs.assumptionSets ?? [], [plan.inputs.marketSnapshot], bps);
      const setup = importPlanAsSetup(plan, ws);
      // The imported document passes the run-setups shape gate unchanged, so D1 can store it as it stands.
      expect(parseRunSetup(withoutId(setup))).toEqual(withoutId(setup));
      expect(setup.plan.stages).not.toBe("derived-default");
      expect(setup.importedFrom).toBe(plan.planId);
      if (setup.scenarios.kind === "plan-scenarios") inline.push(plan.planId);
      // The rebuilt plan is the stored plan: same canonical bytes, so the same plan hash, restated by hand.
      const assembled = assembleSetupPlan(ctx(), ws, importSlot(plan.planId), setup, null, plan.planId);
      expect(contentHash(assembled.plan)).toBe(STORED_PLAN_HASHES[plan.planId]);
      // The reference: the stored plan compiled through the plans route's own compile (resolveInputs, then compilePlan).
      let reference: ReturnType<typeof compileStoredPlan> | undefined;
      let referenceRefusal: unknown;
      try {
        reference = compileStoredPlan(ctx(), plan);
      } catch (err) {
        referenceRefusal = err;
      }
      if (reference === undefined) {
        // A stored plan today's engine refuses: the setup is refused with the same status, code and message.
        let refusal: unknown;
        try {
          compileSetupRow(ctx(), wsStore, ws, importSlot(plan.planId), setup, null);
        } catch (err) {
          refusal = err;
        }
        const pick = (e: unknown) => ({ status: (e as HttpError).status, code: (e as HttpError).code, message: (e as Error).message });
        expect(refusal).toBeInstanceOf(HttpError);
        expect(pick(refusal)).toEqual(pick(referenceRefusal));
        refusedIds.push(plan.planId);
        continue;
      }
      const row = compileSetupRow(ctx(), wsStore, ws, importSlot(plan.planId), setup, null);
      expect(row.planId).toBe(plan.planId);
      expect(contentHash(row.planDocument)).toBe(STORED_PLAN_HASHES[plan.planId]);
      expect(row.request.plan!.planHash).toBe(STORED_PLAN_HASHES[plan.planId]);
      expect(JSON.stringify(row.request.scenarios)).toBe(JSON.stringify(reference.request.scenarios));
      expect(row.request.plan!.planHash).toBe(reference.request.plan!.planHash);
      expect(JSON.stringify(row.request.plan)).toBe(JSON.stringify(reference.request.plan));
      expect(row.profileHash).toBe(reference.profileHash);
      compiledIds.push(plan.planId);
    }
    expect(compiledIds.length + refusedIds.length).toBe(15);
    // plan-synthetic-2500-v1-edit-2 is refused by today's engine as stored (its stacked set binds mma to
    // nmd-decay and the plan's st-decay selector does not reach it); the setup reproduces the refusal.
    expect(refusedIds).toEqual(["plan-synthetic-2500-v1-edit-2"]);
    expect(compiledIds.length).toBe(14);
    expect(inline.sort()).toEqual([...INLINE_PLANS].sort());
  });

  it("every stored plan imports on Runoff and reads Runoff, except plan-vanilla-book-v1-edit-1 on its scenario plan", () => {
    const labels: Record<string, string> = {};
    for (const meta of store.listMeta("run-plans")) {
      const plan = store.getDocument<RunPlan>("run-plans", meta.id).doc;
      const bps = Object.values(plan.scenarioBalancePlans ?? {});
      const ws = workspaceFor(`ws-lbl-${meta.id}`, plan.inputs.positionBook, plan.inputs.assumptionSets ?? [], [plan.inputs.marketSnapshot], bps);
      const setup = importPlanAsSetup(plan, ws);
      expect(setup.nii.basis).toEqual({ kind: "runoff" });
      if (plan.planId === "plan-synthetic-2500-v1-edit-2") continue; // refused as stored, above
      labels[plan.planId] = compileSetupRow(ctx(), wsStore, ws, importSlot(plan.planId), setup, null).basisLabel;
    }
    for (const id of Object.keys(STORED_PLAN_HASHES).filter((p) => p !== "plan-synthetic-2500-v1-edit-2")) {
      expect(labels[id]).toBe(
        id === "plan-vanilla-book-v1-edit-1"
          ? "Custom dynamic on S0 (bp-vanilla-book-v1-edit-1), Runoff on S100, S-100, S200, S-200"
          : "Runoff",
      );
    }
  });

  it("Standard ALCO on the synthetic workspace: block-default resolves, every scenario's source is flat, the label is Flat, st-balance sits on the NII edge, and skipped families are informational", () => {
    const ws = workspaceFor("ws-alco", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const row = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, standardAlcoSetup("ws-alco"), null);
    expect(row.consumed["set:demo-behavioral-v1"]).toEqual(ws.blocks.assumptions.sets[0]);
    expect(row.consumed.book).toEqual(ws.blocks.positions.book);
    expect(row.consumed.market).toEqual(ws.blocks.market.snapshot);
    expect(row.consumed.routingPolicy).toEqual(ws.blocks.assumptions.routingPolicy);
    expect(row.consumed.setup).toEqual(ws.blocks.run.setups[0]!.current);
    expect(row.planDocument.inputs).toEqual({
      marketSnapshot: "market-public-2026-03-31",
      positionBook: "synthetic-2500-v1",
      routingPolicy: "model-map-default-v1",
      assumptionSets: ["demo-behavioral-v1"],
    });
    expect(Object.keys(row.basisByScenario)).toEqual(["S0", "S100", "S-100", "S200", "S-200"]);
    expect(Object.values(row.basisByScenario).every((s) => s.kind === "flat")).toBe(true);
    expect(row.basisLabel).toBe("Flat (simple top-up)");
    expect(row.request.plan!.balanceBasis).toEqual({ kind: "flat", termMonths: 60, spreadOverIndexBp: 0 });
    expect("balancePlanHash" in row.request.plan!).toBe(false);
    for (const s of row.request.scenarios) {
      expect(s.newBusiness.mode).toBe("dynamic");
      expect(s.newBusiness.rules.every((r) => r.reinvest === "flat" && r.termMonths === 60 && r.spreadOverIndexBp === 0)).toBe(true);
    }
    const nii = row.planDocument.stages.find((s) => s.id === "st-nii")!;
    expect(nii.dependsOn).toContain("st-balance");
    expect(row.planDocument.stages.find((s) => s.id === "st-eve")!.dependsOn).not.toContain("st-balance");
    expect(row.planDocument.stages.find((s) => s.id === "st-gap")!.dependsOn).not.toContain("st-balance");
    // Deviation D1: each derived behavioral stage declares the engine's class for its kind and feeds what the policy routes it to.
    const behavioral = row.planDocument.stages.filter((s) => s.kind === "behavioral").map((s) => ({ id: s.id, selector: s.selector, feeds: s.feeds, disposition: s.disposition }));
    expect(behavioral).toEqual([
      { id: "st-behavioral-prepay", selector: { behavioralClasses: "prepayment" }, feeds: ["nii", "eve", "ir-gap", "liq-gap"], disposition: undefined },
      { id: "st-behavioral-nmd-decay", selector: { behavioralClasses: "decay" }, feeds: ["eve", "ir-gap", "liq-gap"], disposition: undefined },
      { id: "st-behavioral-deposit-beta", selector: { behavioralClasses: "deposit-beta" }, feeds: ["nii", "eve"], disposition: undefined },
    ]);
    expect(row.gates.routing.passed).toBe(true);
    expect(row.gates.type.passed).toBe(true);
    expect(row.planDocument.stages.map((s) => s.id)).toEqual([
      "st-curve", "st-tlp", "st-term", "st-behavioral-prepay", "st-behavioral-nmd-decay", "st-behavioral-deposit-beta",
      "st-cashflow", "st-balance", "st-nii", "st-eve", "st-gap", "st-ftp",
    ]);
    expect(row.skippedFamilies).toEqual([]);
    // Slice three (decision 112): the monthly buckets and the [12, 24, 60] horizons are honoured, so nothing warns.
    expect(row.warnings).toEqual([]);
    // The planId rule (Section 2.10), restated: 10 hex of sha256 over the lineage id's UTF-8 bytes,
    // then 12 hex of the canonical hash of the compiled scenarios.
    const lineageHalf = createHash("sha256").update(LINEAGE, "utf8").digest("hex").slice(0, 10);
    expect(lineageHalf).toBe("4cbdce25b3");
    expect(row.planId).toBe(`ws-${lineageHalf}-${contentHash(row.request.scenarios).slice(0, 12)}`);
    expect(row.planId).toMatch(/^ws-[0-9a-f]{10}-[0-9a-f]{12}$/);
    expect(row.request.plan!.planId).toBe(row.planId);
    expect(row.planDocument.planId).toBe(row.planId);
    // Two passes agree: a second compile with the final id reproduces the scenarios.
    const again = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, standardAlcoSetup("ws-alco"), null);
    expect(again.planId).toBe(row.planId);
    expect(JSON.stringify(again.request.scenarios)).toBe(JSON.stringify(row.request.scenarios));
  });

  it("the Standard ALCO planId on the synthetic book is pinned", () => {
    const ws = workspaceFor("ws-alco-pin", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const row = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, standardAlcoSetup("ws-alco-pin"), null);
    // Lineage half restated above; the scenario half recomputed outside the engine (Python, sorted-key compact JSON)
    // over this row's request.scenarios: five regulatory-grid scenarios, each with eleven flat 60-month 0 bp rules.
    expect(row.planId).toBe("ws-4cbdce25b3-ac88b1461281");
  });

  it("routableDerivedStages leaves a literal stage, a registered kind and a class the policy omits untouched", () => {
    const policy = { schemaVersion: "1.0.0", id: "p", label: "p", metrics: [{ id: "nii", label: "n", basis: "b" }, { id: "eve", label: "e", basis: "b" }], classes: [{ id: "decay", label: "d", side: "liability", routing: { nii: "none", eve: "M" } }] } as never;
    const st = (id: string) => ({ id, component: "c", kind: "behavioral" as const, consumes: ["Position" as const], produces: ["Position" as const] });
    const out = routableDerivedStages([st("st-decay"), st("st-behavioral-my-kind"), st("st-behavioral-prepay"), st("st-behavioral-nmd-decay")], policy);
    expect(out[0]).toEqual(st("st-decay"));
    expect(out[1]).toEqual(st("st-behavioral-my-kind"));
    expect(out[2]).toEqual(st("st-behavioral-prepay"));
    expect(out[3]).toEqual({ ...st("st-behavioral-nmd-decay"), selector: { behavioralClasses: "decay" }, feeds: ["eve"] });
  });

  it("plan.asOf is the book's as-of, not the cut-off date, under a warned clash", () => {
    const ws = workspaceFor("ws-clash", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"], [], [], "2026-04-30");
    const row = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, standardAlcoSetup("ws-clash"), null);
    expect(row.planDocument.asOf).toBe("2026-03-31");
    expect(row.request.grid.asOf).toBe("2026-03-31");
  });

  it("Standard ALCO on the hedged workspace skips the swap family as information, not a warning", () => {
    const ws = workspaceFor("ws-alco-hedged", "synthetic-2500-hedged-v1", ["demo-behavioral-v1"]);
    const row = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, standardAlcoSetup("ws-alco-hedged"), null);
    expect(row.skippedFamilies).toEqual(["swaps"]);
    expect(row.warnings.some((w) => /swaps/.test(w))).toBe(false);
    expect(row.basisLabel).toBe("Flat (simple top-up)");
  });

  it("a Custom setup over balance-targets-demo-v1 reads Custom, never Flat, though its two rules lower flat", () => {
    const ws = workspaceFor("ws-custom", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"], [], ["balance-targets-demo-v1"]);
    const base = standardAlcoSetup("ws-custom");
    const setup: RunSetup = { ...base, nii: { ...base.nii, basis: { kind: "custom", balancePlanId: "balance-targets-demo-v1" } } };
    const row = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, setup, null);
    expect(row.basisLabel).toBe("Custom dynamic (balance-targets-demo-v1)");
    expect(Object.values(row.basisByScenario).every((s) => s.kind === "plan" && s.balancePlanId === "balance-targets-demo-v1")).toBe(true);
    for (const s of row.request.scenarios) {
      expect(s.newBusiness.mode).toBe("dynamic");
      expect(s.newBusiness.rules.map((r) => r.familyId)).toEqual(["dda", "mma"]);
      expect(s.newBusiness.rules.every((r) => r.reinvest === "flat")).toBe(true);
    }
    expect(row.consumed.balancePlan).toEqual(ws.blocks.targets.balancePlans[0]);
    // Stamped on the run's plan record: a Custom run carries the plan hash and no balanceBasis.
    expect(row.request.plan!.balancePlanHash).toBe(contentHash(store.getDocument("plans", "balance-targets-demo-v1").doc));
    expect("balanceBasis" in row.request.plan!).toBe(false);
    expect(row.planDocument.balancePlan).toBe("balance-targets-demo-v1");
    expect("balanceBasis" in row.planDocument).toBe(false);
    expect(row.planDocument.stages.find((s) => s.id === "st-nii")!.dependsOn).toContain("st-balance");
  });

  it("plan-vanilla-book-v1-edit-1 reads Custom dynamic on S0 and Runoff on the other four", () => {
    const plan = store.getDocument<RunPlan>("run-plans", "plan-vanilla-book-v1-edit-1").doc;
    const ws = workspaceFor("ws-vbe1", SEED_IDS.vanillaPortfolio, ["vanilla-empty-v1"], [], ["bp-vanilla-book-v1-edit-1"]);
    const row = compileSetupRow(ctx(), wsStore, ws, importSlot("plan-vanilla-book-v1-edit-1"), importPlanAsSetup(plan, ws), null);
    expect(row.basisLabel).toBe("Custom dynamic on S0 (bp-vanilla-book-v1-edit-1), Runoff on S100, S-100, S200, S-200");
    expect(row.basisByScenario.S0).toEqual({ kind: "scenario-plan", balancePlanId: "bp-vanilla-book-v1-edit-1" });
    for (const id of ["S100", "S-100", "S200", "S-200"]) expect(row.basisByScenario[id]).toEqual({ kind: "runoff" });
    expect(row.consumed["balancePlan:S0"]?.id).toBe("bp-vanilla-book-v1-edit-1");
    expect(row.consumed.balancePlan).toBeUndefined();
    expect(row.request.plan!.scenarioBalancePlanHashes).toEqual({
      S0: contentHash(store.getDocument("plans", "bp-vanilla-book-v1-edit-1").doc),
    });
    expect("balanceBasis" in row.request.plan!).toBe(false);
  });

  it("a slate-based Flat setup inlines with newBusiness removed and runs dynamic; a Runoff setup compiles static; two batch rows with different bases hash differently", () => {
    const ws = workspaceFor("ws-slate", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    ws.blocks.scenarios.slates = [ref("scenario-slates", "regulatory-grid-demo")];
    const base: RunSetup = { ...standardAlcoSetup("ws-slate"), scenarios: { kind: "slate", slateId: "regulatory-grid-demo", include: "all" } };
    const flat = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, base, null);
    expect(flat.request.scenarios.map((s) => s.id)).toEqual(["S0", "S100", "S-100", "S200", "S-200"]);
    expect(flat.request.scenarios.every((s) => s.newBusiness.mode === "dynamic")).toBe(true);
    expect(flat.basisLabel).toBe("Flat (simple top-up)");
    expect(flat.consumed.slate?.id).toBe("regulatory-grid-demo");
    // The inlined definitions carry no newBusiness: the plan scenarios are the slate's minus that one field.
    const slate = store.getDocument<{ scenarios: Array<Record<string, unknown>> }>("scenario-slates", "regulatory-grid-demo").doc;
    expect(flat.planDocument.scenarios).toEqual(slate.scenarios.map(({ newBusiness: _nb, ...rest }) => rest));
    const runoff = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, base, {
      label: "r", scenarios: base.scenarios, assumptionSetIds: { kind: "block-default" }, basis: { kind: "runoff" },
    });
    expect(runoff.request.scenarios.every((s) => s.newBusiness.mode === "static")).toBe(true);
    expect(runoff.basisLabel).toBe("Runoff");
    expect(Object.values(runoff.basisByScenario).every((s) => s.kind === "runoff")).toBe(true);
    expect("balanceBasis" in runoff.request.plan!).toBe(false);
    expect(runoff.planId).not.toBe(flat.planId);
    expect(runoff.planId.slice(0, 13)).toBe(flat.planId.slice(0, 13));
    // A subset of the slate by include.
    const two = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, { ...base, scenarios: { kind: "slate", slateId: "regulatory-grid-demo", include: ["S0", "S200"] } }, null);
    expect(two.request.scenarios.map((s) => s.id)).toEqual(["S0", "S200"]);
  });

  it("under Flat, a scenario carrying its own runoff strategy is a 422 naming it", () => {
    const ws = workspaceFor("ws-own", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const setup: RunSetup = {
      ...standardAlcoSetup("ws-own"),
      scenarios: {
        kind: "plan-scenarios",
        items: [{ ref: "regulatory-grid-v1#S0" }, { id: "OWN", rateSpec: { kind: "parallel", shockBp: 100 }, newBusiness: { mode: "static", rules: [] } }],
      },
    };
    expect(() => compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, setup, null)).toThrow(/"OWN" carries its own runoff strategy/);
  });

  it("a null default with block-default is a 422 naming the attach step; a moved pin is a 409; an unknown derived market is a 422 naming the key", () => {
    const ws = workspaceFor("ws-nodefault", SEED_IDS.syntheticPortfolio, []);
    expect(() => compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, standardAlcoSetup("ws-nodefault"), null)).toThrow(/attach an assumption set/);
    try {
      compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, standardAlcoSetup("ws-nodefault"), null);
    } catch (err) {
      expect((err as { status?: number }).status).toBe(422);
    }
    const ws2 = workspaceFor("ws-moved", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    ws2.blocks.positions.book!.contentHash = sha256Hex("not the book");
    let moved: unknown;
    try {
      compileSetupRow(ctx(), wsStore, ws2, ws2.blocks.run.setups[0]!, standardAlcoSetup("ws-moved"), null);
    } catch (err) {
      moved = err;
    }
    expect((moved as { status?: number }).status).toBe(409);
    expect((moved as Error).message).toMatch(/pin/);
    expect((moved as Error).message).toContain(sha256Hex("not the book"));
    expect((moved as Error).message).toContain(store.getMeta("portfolios", SEED_IDS.syntheticPortfolio).contentHash);
    const ws3 = workspaceFor("ws-nokey", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const setup: RunSetup = { ...standardAlcoSetup("ws-nokey"), inputs: { ...standardAlcoSetup("ws-nokey").inputs, market: { role: "derived", definitionKey: "rate-indices-demo-v1" } } };
    expect(() => compileSetupRow(ctx(), wsStore, ws3, ws3.blocks.run.setups[0]!, setup, null)).toThrow(/rate-indices-demo-v1/);
  });

  it("a warned setting warns whether or not its measure is enabled, since every measure still runs (F4)", () => {
    const ws = workspaceFor("ws-disabled-warn", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const base = standardAlcoSetup("ws-disabled-warn");
    const warningsFor = (setup: RunSetup) => compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, setup, null).warnings;
    // Slice three (decision 112): the bucket and report-horizon settings are honoured and no longer warn, so the gap
    // case moved onto the fixed-rate ladder; slice B2 honours that too, so it moves onto the daily interval.
    const gapOff: RunSetup = { ...base, gap: { ...base.gap, enabled: false, liquidity: { ...base.gap.liquidity, interval: { kind: "daily" } } } };
    const eveOff: RunSetup = { ...base, eve: { ...base.eve, enabled: false, valuationDates: "every-12-months" } };
    expect(warningsFor(gapOff).some((w) => /daily interval is reserved/.test(w))).toBe(true);
    expect(warningsFor(eveOff).some((w) => /valuation at later dates/.test(w))).toBe(true);
  });

  it("S3a-1 fix round L4: a deposit history in decimals (every value below 0.5) warns; one in percent does not", () => {
    const ws = workspaceFor("ws-history-warn", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const base = standardAlcoSetup("ws-history-warn");
    const warningsFor = (setup: RunSetup) => compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, setup, null).warnings;
    const series = (valuesPct: number[]) => ({ kind: "history" as const, series: { label: "made-up", firstMonth: "2025-01", valuesPct } });
    expect(warningsFor({ ...base, nmdWarmup: series([0.0412, 0.0405, 0.0398]) })).toContain('Deposit history: every value of "made-up" is below 0.5. The history is read in percent (3.65 for 3.65 percent); check that it is not in decimals.');
    expect(warningsFor({ ...base, nmdWarmup: series([4.12, 4.05, 0.3]) }).some((w) => /Deposit history/.test(w))).toBe(false);
  });

  it("the honoured settings no longer warn: custom repricing buckets, custom and standard liquidity intervals, any report horizons (decision 112), principal plus interest", () => {
    const ws = workspaceFor("ws-no-warn", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const base = standardAlcoSetup("ws-no-warn");
    const warningsFor = (setup: RunSetup) => compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, setup, null).warnings;
    const honoured: RunSetup[] = [
      { ...base, gap: { ...base.gap, repricingBuckets: { kind: "custom", edgesMonths: [3, 6, 12, 24, 60] } } },
      { ...base, gap: { ...base.gap, liquidity: { ...base.gap.liquidity, interval: { kind: "custom-months", edgesMonths: [1, 3, 12] } } } },
      { ...base, gap: { ...base.gap, liquidity: { ...base.gap.liquidity, interval: { kind: "standard" } } } },
      { ...base, nii: { ...base.nii, reportHorizons: [12, 36] } },
      // Principal plus interest is honoured (the interest-inclusive liquidity ladder) and no longer warns.
      { ...base, gap: { ...base.gap, liquidity: { ...base.gap.liquidity, flows: "principal-plus-interest" } } },
      // The fixed-rate ladder is honoured (gap.fixedRate) and no longer warns.
      { ...base, gap: { ...base.gap, fixedRateLadder: true } },
    ];
    for (const setup of honoured) expect(warningsFor(setup)).toEqual([]);
    // Daily liquidity stays reserved and keeps its warning.
    const daily: RunSetup = { ...base, gap: { ...base.gap, liquidity: { ...base.gap.liquidity, interval: { kind: "daily" } } } };
    expect(warningsFor(daily).some((w) => /daily interval is reserved/.test(w))).toBe(true);
  });

  it("FTP off on an import (a literal list): st-ftp is dropped, no ftp block, NII, EVE and Gap bytes equal (slice three decision 121)", () => {
    const plan = store.getDocument<RunPlan>("run-plans", "plan-vanilla-book-v1-edit-1").doc;
    const ws = workspaceFor("ws-ftp-import", SEED_IDS.vanillaPortfolio, ["vanilla-empty-v1"], [], ["bp-vanilla-book-v1-edit-1"]);
    const setup = importPlanAsSetup(plan, ws);
    expect(setup.plan.stages).not.toBe("derived-default");
    expect(setup.ftp.enabled).toBe(true);
    const on = compileSetupRow(ctx(), wsStore, ws, importSlot(plan.planId), setup, null);
    const off = compileSetupRow(ctx(), wsStore, ws, importSlot(plan.planId), { ...setup, ftp: { enabled: false } }, null);
    expect(on.planDocument.stages.filter((s) => s.produces.includes("FtpResult")).map((s) => s.id)).toEqual(["st-ftp"]);
    expect(off.planDocument.stages).toEqual(on.planDocument.stages.filter((s) => s.id !== "st-ftp"));
    expect(off.planId).toBe(on.planId);
    expect(planHash(off.planDocument)).not.toBe(planHash(on.planDocument));
    const portfolio = store.getDocument<PortfolioSpec>("portfolios", on.request.portfolioId).doc;
    const onResult = runCompiledRow(on, portfolio);
    const offResult = runCompiledRow(off, portfolio);
    expect(onResult.ftp).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(offResult, "ftp")).toBe(false);
    expect(JSON.stringify(offResult.nii)).toBe(JSON.stringify(onResult.nii));
    expect(JSON.stringify(offResult.eve)).toBe(JSON.stringify(onResult.eve));
    expect(JSON.stringify(offResult.gap)).toBe(JSON.stringify(onResult.gap));
  }, 300_000);

  it("FTP off on a derived setup drops st-ftp from the derived list; the planId holds and the planHash moves (decisions 121, 123)", () => {
    const ws = workspaceFor("ws-ftp-derived", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const base = standardAlcoSetup("ws-ftp-derived");
    const on = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, base, null);
    const off = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, { ...base, ftp: { enabled: false } }, null);
    expect(on.planDocument.stages.map((s) => s.id)).toContain("st-ftp");
    expect(off.planDocument.stages).toEqual(on.planDocument.stages.filter((s) => s.id !== "st-ftp"));
    expect(off.gates.type.passed).toBe(true);
    expect(off.gates.routing.passed).toBe(true);
    expect(off.planId).toBe(on.planId);
    expect(planHash(off.planDocument)).not.toBe(planHash(on.planDocument));
  });

  it("eve.discountBasis is honoured: risk-free and spread-consistent compile with no a later release warning (spec E3)", () => {
    const ws = workspaceFor("ws-basis", SEED_IDS.syntheticPortfolio, ["demo-behavioral-v1"]);
    const base = standardAlcoSetup("ws-basis");
    for (const discountBasis of ["risk-free", "spread-consistent"] as const) {
      const setup: RunSetup = { ...base, eve: { ...base.eve, discountBasis } };
      const compiled = compileSetupRow(ctx(), wsStore, ws, ws.blocks.run.setups[0]!, setup, null);
      expect(compiled.warnings.some((w) => /discount basis/i.test(w))).toBe(false);
      expect(compiled.warnings.some((w) => /a later release/.test(w) && /EVE/.test(w))).toBe(false);
    }
  });
});
