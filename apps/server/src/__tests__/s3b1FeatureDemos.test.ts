/**
 * The seven feature demos on the example bank.
 *
 *  1. Both core profiles plan the two sets and seven setups; each setup is canonical (it re-parses to its own bytes and
 *     its id is the run-setups route's id of its body), runs the static run-off on the SOFR history and names a seeded
 *     set, and the demos differ from the shared base in exactly the settings each one is about.
 *  2. GET /api/guided/examples/:id/demos lists them for the example bank (stored), an empty list for the small example
 *     and 404 for a book that is not an example.
 *  3. On a fresh starter store, the Example bank workspace the start choice makes (book and market) opens each demo the
 *     way the Studio card does (its sets added, its seeded setup saved into its own slot, the stored document reused
 *     by id), and each launches with nothing to confirm and runs to done, carrying the block its feature writes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { planFeatureDemoDocuments, planSeedDocuments, seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { DEMO_BOOK_ID, DEMO_SET_IDS, featureDemos, type FeatureDemoId, type FeatureDemoRow } from "../examples/featureDemos";
import { FileStore } from "../store/store";
import type { RunStatus } from "../jobs/types";
import type { ReadinessReport } from "../workspaces/readiness";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { runSetupIdOf } from "../workspaces/standardAlco";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { loadMarketSnapshot } from "@alm/kernel";
import { runFeatureDemo } from "../../../../data/src/examples/accept/featureDemoRuns";
import { depositFormDemos } from "../examples/depositForms";
import { survivalPathDemos } from "../examples/survivalPathDemo";

const ROOT = repoRoot();
const bank = JSON.parse(readFileSync(join(ROOT, "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec;

describe("the feature demo documents", () => {
  const demos = featureDemos(ROOT);

  it("are seven, in card order, each in its own demo slot, in both core profiles", async () => {
    expect(demos.map((d) => d.id)).toEqual(["seg", "regulatory", "spread-consistent", "six-shocks", "instruments", "constant-prepay", "fixed-ladder"]);
    expect(demos.map((d) => d.lineageId)).toEqual(demos.map((d) => `demo-${d.id}`));
    const keys = planFeatureDemoDocuments(ROOT).map((d) => `${d.collection}/${d.id}`);
    for (const profile of ["demo", "starter"] as const) {
      const planned = (await planSeedDocuments(ROOT, profile)).map((d) => `${d.collection}/${d.id}`);
      for (const k of keys) expect(planned, `${profile} ${k}`).toContain(k);
    }
  }, 60_000);

  it("are canonical: each re-parses to its own bytes and carries the route's id of its body", () => {
    for (const d of demos) {
      const { id, ...body } = d.setup;
      expect(parseRunSetup(JSON.parse(JSON.stringify(body))), d.id).toEqual(body);
      expect(runSetupIdOf(body), d.id).toBe(id);
    }
  });

  it("each runs the bank's static run-off on the SOFR history and changes only its own settings from the shared base", () => {
    const base = (s: RunSetup) => {
      const { id: _i, name: _n, plan, note: _note, seg: _s, nmdConvention: _c, liquidityStress: _l, ...rest } = s;
      return { ...rest, plan: { ...plan, label: "" }, eve: { ...rest.eve, discountBasis: "risk-free" }, gap: { ...rest.gap, fixedRateLadder: false }, instrumentResults: { save: false, coaNodeIds: [] }, scenarios: null, inputs: { ...rest.inputs, assumptionSetIds: null } };
    };
    const first = base(demos[0]!.setup);
    for (const d of demos) {
      expect(base(d.setup), d.id).toEqual(first);
      expect(d.setup.nii.basis, d.id).toEqual({ kind: "runoff" });
      expect(d.setup.nmdWarmup?.kind, d.id).toBe("history");
      expect(d.setup.inputs.assumptionSetIds, d.id).toEqual(d.setIds);
    }
    const by = new Map(demos.map((d) => [d.id, d.setup]));
    expect(by.get("seg")!.seg).toEqual({ enabled: true, shockBp: 25, horizonMonths: 120, niiShockBp: 100, cprOverlay: [{ familyId: "mb-resi-mortgages", upAnnualCpr: 0.06, downAnnualCpr: 0.2 }] });
    expect(by.get("regulatory")!.nmdConvention).toBe("regulatory");
    expect(by.get("spread-consistent")!.eve.discountBasis).toBe("spread-consistent");
    const six = by.get("six-shocks")!.scenarios;
    expect(six.kind === "plan-scenarios" ? six.items.map((i) => ("ref" in i ? i.ref : i.id)) : null).toEqual(["regulatory-grid-v1#S0", "SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT"]);
    expect(by.get("instruments")!.instrumentResults).toEqual({ save: true, coaNodeIds: ["mb-assets", "mb-liab-equity", "mb-off-balance", "mb-derivatives"] });
    expect(by.get("constant-prepay")!.inputs.assumptionSetIds).toEqual([DEMO_SET_IDS.constantPrepay]);
    expect(by.get("constant-prepay")!.liquidityStress?.buffer).toBe(1_250_000_000);
    expect(by.get("constant-prepay")!.liquidityStress?.undrawnFace).toBe(1_000_000_000);
    expect(by.get("fixed-ladder")!.gap.fixedRateLadder).toBe(true);
    // Every other demo leaves those settings at the base.
    for (const d of demos) {
      if (d.id !== "seg") expect(d.setup.seg, d.id).toBeUndefined();
      if (d.id !== "regulatory") expect(d.setup.nmdConvention, d.id).toBeUndefined();
      if (d.id !== "spread-consistent") expect(d.setup.eve.discountBasis, d.id).toBe("risk-free");
      if (d.id !== "instruments") expect(d.setup.instrumentResults.save, d.id).toBe(false);
      if (d.id !== "constant-prepay") expect(d.setup.liquidityStress, d.id).toBeUndefined();
      if (d.id !== "fixed-ladder") expect(d.setup.gap.fixedRateLadder, d.id).toBe(false);
    }
  });

  it("the constant-prepay set is the illustrative set plus two constant CPR bindings on level-pay loan families", () => {
    const docs = planFeatureDemoDocuments(ROOT);
    const il = docs.find((d) => d.id === DEMO_SET_IDS.illustrative)!.doc as { bindings: Array<{ familyId: string; overlay: { kind: string } }> };
    const cp = docs.find((d) => d.id === DEMO_SET_IDS.constantPrepay)!.doc as { bindings: Array<{ familyId: string; overlay: Record<string, unknown> }> };
    const analysis = JSON.parse(readFileSync(join(ROOT, "examples", "mid-size-bank-v1.analysis.json"), "utf8")) as { behavior: { bindings: unknown[] } };
    expect(il.bindings).toHaveLength(analysis.behavior.bindings.length);
    expect(cp.bindings).toHaveLength(analysis.behavior.bindings.length + 2);
    expect(cp.bindings.slice(-2).map((b) => [b.familyId, b.overlay])).toEqual([
      ["mb-consumer", { kind: "prepay", model: "constant-cpr", annualCpr: 0.1, stressAnnualCpr: 0.05 }],
      ["mb-cre-multifamily", { kind: "prepay", model: "constant-cpr", annualCpr: 0.06, stressAnnualCpr: 0.03 }],
    ]);
    for (const f of ["mb-consumer", "mb-cre-multifamily"]) {
      for (const p of bank.positions.filter((x) => x.familyId === f)) expect(p.terms.type === "fixed-loan" && p.terms.amortType, p.id).toBe("level-pay");
    }
  });
});

describe("on a fresh starter store", () => {
  let tp: TestPlatform;
  beforeAll(async () => {
    tp = await bootTestPlatform();
    await seedStore(new FileStore(tp.storeRoot), ROOT, { mode: "seed" }, "starter");
  }, 120_000);
  afterAll(async () => {
    await tp.close();
  });

  it("lists the demos for the example bank, none for the small example, 404 for a book that is not an example", async () => {
    const r = await api<{ demos: FeatureDemoRow[] }>(tp.base, "GET", `/api/guided/examples/${DEMO_BOOK_ID}/demos`);
    expect(r.status).toBe(200);
    // The bank's list goes on with the deposit-form demos on this book (the funding tenor), after the seven.
    // Then the survival path.
    const want = [...featureDemos(ROOT), ...depositFormDemos(ROOT).filter((d) => d.bookId === DEMO_BOOK_ID), ...survivalPathDemos(ROOT)];
    expect(r.body.demos).toEqual(want.map((d) => ({ id: d.id, title: d.title, lineageId: d.lineageId, setupId: d.setup.id, setIds: d.setIds, stored: true })));
    expect((await api<{ demos: unknown[] }>(tp.base, "GET", "/api/guided/examples/example-book-v1/demos")).body).toEqual({ demos: [] });
    expect((await api(tp.base, "GET", "/api/guided/examples/no-such-book/demos")).status).toBe(404);
  });

  it("each demo opens on the Example bank workspace the way the card does and runs to done with its feature's block", async () => {
    expect((await api(tp.base, "POST", "/api/portfolios/import", bank)).status).toBe(201);
    const WS = "ws-example-bank";
    let w = (await api<WorkspaceManifest>(tp.base, "POST", "/api/workspaces", { id: WS, name: "Example bank", type: "test", cutoffDate: "2026-03-31", owner: "Learner", by: "Learner" })).body;
    const block = async (body: object) => {
      const r = await api<WorkspaceManifest>(tp.base, "POST", `/api/workspaces/${WS}/blocks`, { expectedRevision: w.revision, by: "Learner", ...body });
      expect(r.status, r.text.slice(0, 400)).toBe(201);
      w = r.body;
    };
    await block({ block: "market", op: "set", ref: { collection: "market", id: "market-public-2026-03-31" } });
    await block({ block: "positions", op: "set", ref: { collection: "portfolios", id: bank.id } });
    const store = new FileStore(tp.storeRoot);
    const setupsBefore = store.listMeta("run-setups").length;
    const results = new Map<string, Record<string, unknown>>();
    // The seven S3b-1 demos; the funding tenor on this bank is launched in s3c1DepositForms.test.ts.
    const s3b = new Set<string>(featureDemos(ROOT).map((d) => d.id));
    for (const row of (await api<{ demos: FeatureDemoRow[] }>(tp.base, "GET", `/api/guided/examples/${DEMO_BOOK_ID}/demos`)).body.demos.filter((d) => s3b.has(d.id))) {
      for (const s of row.setIds) if (!w.blocks.assumptions.sets.some((x) => x.id === s)) await block({ block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: s } });
      const seeded = (await api<RunSetup>(tp.base, "GET", `/api/run-setups/${row.setupId}`)).body;
      const { id: _id, ...body } = seeded;
      const sr = await api<{ setup: RunSetup; manifest: WorkspaceManifest }>(tp.base, "POST", "/api/run-setups", { workspaceId: WS, setupLineageId: row.lineageId, expectedRevision: w.revision, by: "Learner", setup: body });
      expect(sr.status, sr.text.slice(0, 400)).toBe(201);
      expect(sr.body.setup.id, row.id).toBe(row.setupId);
      w = sr.body.manifest;
      const readiness = (await api<ReadinessReport>(tp.base, "GET", `/api/workspaces/${WS}/readiness`)).body;
      const gate = readiness.launchable[row.lineageId]!;
      expect(gate.blocking, row.id).toEqual([]);
      expect(gate.acknowledgeable, row.id).toEqual([]);
      const l = await api<{ runIds: string[] }>(tp.base, "POST", `/api/workspaces/${WS}/setups/${row.lineageId}/launch`, { by: "Learner", acknowledge: [] });
      expect(l.status, l.text.slice(0, 400)).toBe(200);
      const runId = l.body.runIds[0]!;
      const st = await waitFor(() => api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 540_000, 500);
      expect(st.body.state, JSON.stringify(st.body).slice(0, 600)).toBe("done");
      const result = JSON.parse(readFileSync(join(tp.storeRoot, "runs", runId, "result.json"), "utf8")) as Record<string, unknown> & { schemaVersion: string; notImplemented: unknown[] };
      expect(result.schemaVersion, row.id).toBe("1.13.0");
      expect(result.notImplemented, row.id).toEqual([]);
      results.set(row.id, { ...result, runId });
    }
    // Opening every demo wrote no new setup document: each saved body is the seeded document, reused by id.
    expect(store.listMeta("run-setups").length).toBe(setupsBefore);
    const eveOf = (id: string, sc: string) => ((results.get(id)!.eve as { byScenario: Array<{ scenarioId: string; eve: number }> }).byScenario.find((s) => s.scenarioId === sc)!.eve);
    expect(results.get("seg")!.seg).toMatchObject({ shockBp: 25, horizonMonths: 120, niiShockBp: 100 });
    expect(results.get("regulatory")!.nmdConvention).toBeDefined();
    expect(results.get("regulatory")!.parentOf).toBeDefined();
    expect((results.get("spread-consistent")!.eve as { discountBasis: string }).discountBasis).toBe("spread-consistent");
    // The loans' spreads lower value against the risk-free demos.
    expect(eveOf("spread-consistent", "S0")).toBeLessThan(eveOf("fixed-ladder", "S0"));
    // The standard's parallel shocks are the +-200 bp moves, so they equal the parallel grid's rows, to float noise
    // (a tenor-knot vector against a parallel spec: 1e-15 relative).
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
    expect(rel(eveOf("six-shocks", "SRP-PUP"), eveOf("fixed-ladder", "S200"))).toBeLessThan(1e-12);
    expect(rel(eveOf("six-shocks", "SRP-PDN"), eveOf("fixed-ladder", "S-200"))).toBeLessThan(1e-12);
    // The instrument rows are the third run file, beside result.json, which the pass never touches.
    const rows = JSON.parse(readFileSync(join(tp.storeRoot, "runs", String(results.get("instruments")!.runId), "instruments.json"), "utf8")) as { positions: unknown[] };
    expect(rows.positions).toHaveLength(bank.positions.length);
    expect(results.get("constant-prepay")!.liquidityStress).toBeDefined();
    expect((results.get("fixed-ladder")!.gap as { fixedRate?: unknown }).fixedRate).toBeDefined();
    // The accept checks' in-process runner (data/src/examples/accept/featureDemoRuns.ts) is the launch: every block but
    // provenance, and every instrument row, equals the launched run's files.
    const market = await loadMarketSnapshot(join(ROOT, "packages", "kernel", "public", "market_public.json"));
    for (const [id, launched] of results) {
      const own = runFeatureDemo(ROOT, market, id as FeatureDemoId);
      const keys = Object.keys(launched).filter((k) => k !== "provenance" && k !== "runId").sort();
      expect(Object.keys(own.result).filter((k) => k !== "provenance").sort(), id).toEqual(keys);
      for (const k of keys) expect(JSON.stringify((own.result as unknown as Record<string, unknown>)[k]), `${id} ${k}`).toBe(JSON.stringify(launched[k]));
      if (own.instruments !== undefined) {
        const file = JSON.parse(readFileSync(join(tp.storeRoot, "runs", String(launched.runId), "instruments.json"), "utf8")) as { positions: unknown[] };
        expect(JSON.stringify(own.instruments.positions), id).toBe(JSON.stringify(file.positions));
      }
    }
    console.log(`S3b-1 demo runs: ${JSON.stringify([...results].map(([k, r]) => [k, r.runId]))}`);
  }, 900_000);
});
