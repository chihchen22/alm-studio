/**
 * The deposit forms and the floater's funding tenor.
 *
 *  1. Both core profiles plan the deposit desk's five sets and the seven deposit-form setups, after the documents and
 *     before the hierarchy; each setup is canonical, carries the corrected model convention, runs the static run-off on
 *     the SOFR history and names a seeded set, and differs from the shared base in exactly the settings it is about.
 *  2. GET /api/guided/examples/:id/demos lists the desk's six for the desk and the seven then the funding tenor for
 *     Quillfield Bank, every one stored on a fresh starter store.
 *  3. On a fresh starter store each demo opens on its book's workspace the way the Studio card does and runs to done,
 *     carrying exactly the notes its form writes; the accept checks' in-process runner equals every launched block.
 *  4. The CSV path reads an nmd row's linearDecayMonths as the JSON path's linearDecay, checked the same way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChartOfAccounts, PortfolioSpec } from "@alm/engine";
import { loadMarketSnapshot } from "@alm/kernel";
import { planDepositFormDocuments, planFeatureDemoDocuments, planSeedDocuments, seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { DESK_BOOK_ID, DESK_SET_IDS, depositFormDemos, type DepositFormDemoId } from "../examples/depositForms";
import { DEMO_BOOK_ID, featureDemos, type FeatureDemoRow } from "../examples/featureDemos";
import { survivalPathDemos } from "../examples/survivalPathDemo";
import { parsePositionsCsv } from "../intake/positionsCsv";
import { FileStore } from "../store/store";
import type { RunStatus } from "../jobs/types";
import type { ReadinessReport } from "../workspaces/readiness";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { runSetupIdOf } from "../workspaces/standardAlco";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { runDepositFormDemo } from "../../../../data/src/examples/accept/depositFormRuns";

const ROOT = repoRoot();
const desk = JSON.parse(readFileSync(join(ROOT, "examples", `${DESK_BOOK_ID}.json`), "utf8")) as PortfolioSpec;
const bank = JSON.parse(readFileSync(join(ROOT, "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec;

/** The notes each demo's run carries, written out from ADR-050 to ADR-053. */
const NOTES: Record<DepositFormDemoId, string[]> = {
  "desk-linear-decay": [],
  "desk-component-decay": ["nii.component-decay", "eve.component-decay", "cashflows.wal.full-runoff", "ftp.component-decay"],
  "desk-full-beta-frozen": ["ftp.full-beta-form"],
  "desk-full-beta-shocked": ["ftp.full-beta-form"],
  "desk-credit": ["nii.component-decay", "eve.component-decay", "cashflows.wal.full-runoff"],
  "desk-scenario-credit": ["nii.component-decay", "eve.component-decay", "cashflows.wal.full-runoff"],
  "funding-tenor": [],
};

describe("the S3c-1 documents", () => {
  const demos = depositFormDemos(ROOT);

  it("are seven setups, the desk's six then the funding tenor, each in its own slot, and five sets, planned after S3b-1's in both core profiles", async () => {
    expect(demos.map((d) => d.id)).toEqual(["desk-linear-decay", "desk-component-decay", "desk-full-beta-frozen", "desk-full-beta-shocked", "desk-credit", "desk-scenario-credit", "funding-tenor"]);
    expect(demos.map((d) => d.lineageId)).toEqual(demos.map((d) => `demo-${d.id}`));
    expect(demos.map((d) => d.bookId)).toEqual([...Array<string>(6).fill(DESK_BOOK_ID), DEMO_BOOK_ID]);
    const own = planDepositFormDocuments(ROOT);
    expect(own.map((d) => d.collection)).toEqual([...Array<string>(5).fill("assumption-sets"), ...Array<string>(7).fill("run-setups")]);
    const s3b = planFeatureDemoDocuments(ROOT).map((d) => `${d.collection}/${d.id}`);
    for (const profile of ["demo", "starter"] as const) {
      const keys = (await planSeedDocuments(ROOT, profile)).map((d) => `${d.collection}/${d.id}`);
      const at = keys.indexOf(s3b[s3b.length - 1]!);
      expect(keys.slice(at + 1, at + 1 + own.length), profile).toEqual(own.map((d) => `${d.collection}/${d.id}`));
      expect(keys[keys.length - 1], profile).toBe("hierarchies/liquidity-funding-demo-v1");
    }
  }, 60_000);

  it("are canonical, carry the corrected convention and differ from the shared base only in their own settings", () => {
    const base = (s: RunSetup) => {
      const { id: _i, name: _n, plan, note: _note, nmdConvention: _c, ...rest } = s;
      return { ...rest, plan: { ...plan, label: "" }, scenarios: null, inputs: { ...rest.inputs, assumptionSetIds: null } };
    };
    const first = base(demos[0]!.setup);
    for (const d of demos) {
      const { id, ...body } = d.setup;
      expect(parseRunSetup(JSON.parse(JSON.stringify(body))), d.id).toEqual(body);
      expect(runSetupIdOf(body), d.id).toBe(id);
      expect(d.setup.modelConvention, d.id).toBe("corrected-v1");
      expect(d.setup.nmdWarmup?.kind, d.id).toBe("history");
      expect(d.setup.nii.basis, d.id).toEqual({ kind: "runoff" });
      expect(d.setup.inputs.assumptionSetIds, d.id).toEqual(d.setIds);
      expect(d.setup.ftp.enabled, d.id).toBe(true);
      expect(base(d.setup), d.id).toEqual(first);
    }
    const by = new Map(demos.map((d) => [d.id, d.setup]));
    expect(by.get("desk-full-beta-frozen")!.nmdConvention).toBe("regulatory");
    expect(by.get("desk-full-beta-shocked")!.nmdConvention).toBe("shocked-level");
    for (const d of demos) if (!d.id.startsWith("desk-full-beta")) expect(d.setup.nmdConvention, d.id).toBeUndefined();
    const refs = (s: RunSetup) => (s.scenarios.kind === "library" ? s.scenarios.refs : null);
    expect(refs(by.get("desk-credit")!)).toEqual(["regulatory-grid-v1#S0"]);
    for (const d of demos) if (d.id !== "desk-credit") expect(refs(d.setup), d.id).toEqual(["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100", "regulatory-grid-v1#S200", "regulatory-grid-v1#S-200"]);
    expect(by.get("desk-full-beta-frozen")!.inputs.assumptionSetIds).toEqual(by.get("desk-full-beta-shocked")!.inputs.assumptionSetIds);
    expect(by.get("desk-linear-decay")!.inputs.assumptionSetIds).toEqual([DESK_SET_IDS.plain]);
  });

  it("the desk is deposits only, one deposit a family, $1.2 billion, and Quillfield Bank (version 1.3 since S3d-1) carries five funding tenors", () => {
    expect(desk.asOf).toBe(bank.asOf);
    expect(desk.positions.map((p) => [p.id, p.terms.type, p.terms.notional])).toEqual([["dd-operating-1", "nmd", 300_000_000], ["dd-savings-1", "nmd", 400_000_000], ["dd-mma-1", "nmd-b", 500_000_000]]);
    expect(new Set(desk.positions.map((p) => p.familyId)).size).toBe(3);
    expect((desk.positions[0]!.terms as { linearDecay?: unknown }).linearDecay).toEqual({ horizonMonths: 48 });
    expect(desk.label).toContain("version 1.0");
    expect(bank.label).toContain("version 1.3");
    const tenors = bank.positions.flatMap((p) => ((p.terms as { fundingTenorMonths?: number }).fundingTenorMonths === undefined ? [] : [[p.id, (p.terms as { fundingTenorMonths: number }).fundingTenorMonths]]));
    expect(tenors).toEqual([["mb-ci-float-1", 36], ["mb-ci-float-2", 24], ["mb-constr-1", 24], ["mb-heloc-1", 60], ["mb-fhlb-2", 24]]);
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

  it("lists the desk's six demos for the desk, and S3b-1's seven then the funding tenor for the bank, all stored", async () => {
    const all = depositFormDemos(ROOT);
    const row = (d: { id: string; title: string; lineageId: string; setup: RunSetup; setIds: string[] }) => ({ id: d.id, title: d.title, lineageId: d.lineageId, setupId: d.setup.id, setIds: d.setIds, stored: true });
    const r = await api<{ demos: FeatureDemoRow[] }>(tp.base, "GET", `/api/guided/examples/${DESK_BOOK_ID}/demos`);
    expect(r.status).toBe(200);
    expect(r.body.demos).toEqual(all.filter((d) => d.bookId === DESK_BOOK_ID).map(row));
    const q = await api<{ demos: FeatureDemoRow[] }>(tp.base, "GET", `/api/guided/examples/${DEMO_BOOK_ID}/demos`);
    // The survival path follows them.
    expect(q.body.demos).toEqual([...featureDemos(ROOT).map(row), ...all.filter((d) => d.bookId === DEMO_BOOK_ID).map(row), ...survivalPathDemos(ROOT).map(row)]);
    // The guided examples list names the desk, which ships no finished analysis.
    const ex = await api<Array<{ id: string; analysis: boolean }>>(tp.base, "GET", "/api/guided/examples");
    expect(ex.body.find((b) => b.id === DESK_BOOK_ID)?.analysis).toBe(false);
    expect(ex.body.filter((b) => b.analysis).map((b) => b.id)).toEqual([DEMO_BOOK_ID]);
  });

  it("each demo opens on its book's workspace the way the card does and runs to done, its notes exactly its form's; the in-process runner is the launch", async () => {
    const store = new FileStore(tp.storeRoot);
    const workspace = async (id: string, name: string, book: PortfolioSpec) => {
      expect((await api(tp.base, "POST", "/api/portfolios/import", book)).status).toBe(201);
      let w = (await api<WorkspaceManifest>(tp.base, "POST", "/api/workspaces", { id, name, type: "test", cutoffDate: book.asOf, owner: "Learner", by: "Learner" })).body;
      for (const body of [{ block: "market", op: "set", ref: { collection: "market", id: "market-public-2026-03-31" } }, { block: "positions", op: "set", ref: { collection: "portfolios", id: book.id } }]) {
        const r = await api<WorkspaceManifest>(tp.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: w.revision, by: "Learner", ...body });
        expect(r.status, r.text.slice(0, 400)).toBe(201);
        w = r.body;
      }
      return w;
    };
    const heads = new Map<string, WorkspaceManifest>([
      [DESK_BOOK_ID, await workspace("ws-deposit-desk", "Deposit desk", desk)],
      [DEMO_BOOK_ID, await workspace("ws-example-bank", "Example bank", bank)],
    ]);
    const setupsBefore = store.listMeta("run-setups").length;
    const results = new Map<string, Record<string, unknown>>();
    for (const d of depositFormDemos(ROOT)) {
      const ws = d.bookId === DESK_BOOK_ID ? "ws-deposit-desk" : "ws-example-bank";
      let w = heads.get(d.bookId)!;
      for (const s of d.setIds) {
        if (w.blocks.assumptions.sets.some((x) => x.id === s)) continue;
        const r = await api<WorkspaceManifest>(tp.base, "POST", `/api/workspaces/${ws}/blocks`, { expectedRevision: w.revision, by: "Learner", block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: s } });
        expect(r.status, r.text.slice(0, 400)).toBe(201);
        w = r.body;
      }
      const seeded = (await api<RunSetup>(tp.base, "GET", `/api/run-setups/${d.setup.id}`)).body;
      const { id: _id, ...body } = seeded;
      const sr = await api<{ setup: RunSetup; manifest: WorkspaceManifest }>(tp.base, "POST", "/api/run-setups", { workspaceId: ws, setupLineageId: d.lineageId, expectedRevision: w.revision, by: "Learner", setup: body });
      expect(sr.status, sr.text.slice(0, 400)).toBe(201);
      expect(sr.body.setup.id, d.id).toBe(d.setup.id);
      heads.set(d.bookId, sr.body.manifest);
      const readiness = (await api<ReadinessReport>(tp.base, "GET", `/api/workspaces/${ws}/readiness`)).body;
      const gate = readiness.launchable[d.lineageId]!;
      expect(gate.blocking, d.id).toEqual([]);
      expect(gate.acknowledgeable, d.id).toEqual([]);
      const l = await api<{ runIds: string[] }>(tp.base, "POST", `/api/workspaces/${ws}/setups/${d.lineageId}/launch`, { by: "Learner", acknowledge: [] });
      expect(l.status, l.text.slice(0, 400)).toBe(200);
      const runId = l.body.runIds[0]!;
      const st = await waitFor(() => api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 540_000, 500);
      expect(st.body.state, JSON.stringify(st.body).slice(0, 600)).toBe("done");
      const result = JSON.parse(readFileSync(join(tp.storeRoot, "runs", runId, "result.json"), "utf8")) as Record<string, unknown> & { schemaVersion: string; notImplemented: Array<{ layer: string }> };
      expect(result.schemaVersion, d.id).toBe("1.13.0");
      expect(result.notImplemented.map((n) => n.layer), d.id).toEqual(NOTES[d.id]);
      results.set(d.id, { ...result, runId });
    }
    // Opening every demo wrote no new setup document: each saved body is the seeded document, reused by id.
    expect(store.listMeta("run-setups").length).toBe(setupsBefore);
    const market = await loadMarketSnapshot(join(ROOT, "packages", "kernel", "public", "market_public.json"));
    for (const [id, launched] of results) {
      const own = runDepositFormDemo(ROOT, market, id as DepositFormDemoId);
      const keys = Object.keys(launched).filter((k) => k !== "provenance" && k !== "runId").sort();
      expect(Object.keys(own.result).filter((k) => k !== "provenance").sort(), id).toEqual(keys);
      for (const k of keys) expect(JSON.stringify((own.result as unknown as Record<string, unknown>)[k]), `${id} ${k}`).toBe(JSON.stringify(launched[k]));
    }
    console.log(`deposit-form demo runs: ${JSON.stringify([...results].map(([k, r]) => [k, r.runId]))}`);
  }, 900_000);
});

describe("every direction a desk card states, against its run (S3c fix round, H1)", () => {
  // The claims are restated from the cards (apps/studio/src/guided/featureDemos.ts DEPOSIT_FORM_CARDS); the values are
  // the seeded runs'. A card that says "falls" or "grows" must match the run's sign.
  it("shocked-level: at +100 bp the beta falls from about 0.51 to 0.46 and the core grows from 49 to 54 percent; at -100 bp the core grows too", async () => {
    const market = await loadMarketSnapshot(join(ROOT, "packages", "kernel", "public", "market_public.json"));
    const r = runDepositFormDemo(ROOT, market, "desk-full-beta-shocked").result;
    const nonCore = (s: string) => r.cashflows.byScenario.find((x) => x.scenarioId === s)!.byFamily.find((f) => f.familyId === "dd-mma")!.series.principal[0]! / 500_000_000;
    expect(nonCore("S100")).toBeLessThan(nonCore("S0"));
    expect(nonCore("S-100")).toBeLessThan(nonCore("S0"));
    expect(Math.round(nonCore("S0") * 100)).toBe(51);
    expect(Math.round(nonCore("S100") * 100)).toBe(46);
    expect(Math.round((1 - nonCore("S0")) * 100)).toBe(49);
    expect(Math.round((1 - nonCore("S100")) * 100)).toBe(54);
    expect(Math.round((1 - nonCore("S-100")) * 100)).toBe(58);
  });

  it("the other cards' directions: regulatory raises the desk's base value, +100 bp shortens the savings life and raises its credit", async () => {
    const market = await loadMarketSnapshot(join(ROOT, "packages", "kernel", "public", "market_public.json"));
    const eve = (r: { eve: { byScenario: Array<{ scenarioId: string; eve: number }> } }, s: string) => r.eve.byScenario.find((x) => x.scenarioId === s)!.eve;
    const plain = runDepositFormDemo(ROOT, market, "desk-linear-decay").result;
    const reg = runDepositFormDemo(ROOT, market, "desk-linear-decay", { edit: (s) => ({ ...s, nmdConvention: "regulatory" }) }).result;
    expect(eve(reg, "S0")).toBeGreaterThan(eve(plain, "S0"));
    const cd = runDepositFormDemo(ROOT, market, "desk-component-decay").result;
    const wal = (s: string) => cd.cashflows.byScenario.find((x) => x.scenarioId === s)!.byFamily.find((f) => f.familyId === "dd-savings")!.walYears!;
    expect(wal("S100")).toBeLessThan(wal("S0"));
    const sc = runDepositFormDemo(ROOT, market, "desk-scenario-credit").result;
    const sav = sc.ftp!.byFamily.find((f) => f.familyId === "dd-savings")!.scenarioCredit!;
    const at = (s: string) => sav.byScenario.find((x) => x.scenarioId === s)!;
    expect(at("S100").totalCredit).toBeGreaterThan(at("S0").totalCredit);
    expect(at("S100").lifeMonths).toBeLessThan(at("S0").lifeMonths);
  });
});

describe("the straight-line runoff on the CSV path", () => {
  const COA: ChartOfAccounts = {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "l", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 0 },
      { id: "l-ops", label: "Operating deposits", parentId: "l", side: "liability", isLeaf: true, familyId: "ops", order: 0 },
      { id: "l-adv", label: "Floating advances", parentId: "l", side: "liability", isLeaf: true, familyId: "adv", order: 1 },
    ],
    families: [
      { id: "ops", label: "Operating deposits", side: "liability", instrumentType: "nmd", coaNodeId: "l-ops" },
      { id: "adv", label: "Floating advances", side: "liability", instrumentType: "floating-loan", coaNodeId: "l-adv" },
    ],
  };
  const header = "position_id,family_id,coa_node_id,terms_type,notional,maturityMonths,originationOffsetMonths,amortType,depositRate,beta,indexTenorMonths,margin,resetFrequencyMonths,fundingTenorMonths,linearDecayMonths";
  const csv = (...rows: string[]) => parsePositionsCsv([header, ...rows].join("\n"), COA, { portfolioId: "s3c1-csv", label: "S3c-1 CSV", asOf: "2026-03-31" });

  it("an nmd row's linearDecayMonths is the terms' linearDecay, and a floater's fundingTenorMonths reads as before", () => {
    const out = csv("op1,ops,l-ops,nmd,300000000,48,0,level-pay,0,0,,,,,48", "fa1,adv,l-adv,floating-loan,10000000,24,0,bullet,,,1,0.002,1,24,");
    expect("portfolio" in out, JSON.stringify(out).slice(0, 600)).toBe(true);
    if (!("portfolio" in out)) return;
    const [op, fa] = out.portfolio.positions;
    expect((op!.terms as unknown as Record<string, unknown>).linearDecay).toEqual({ horizonMonths: 48 });
    expect("linearDecayMonths" in (op!.terms as object)).toBe(false);
    expect((fa!.terms as unknown as Record<string, unknown>).fundingTenorMonths).toBe(24);
  });

  it("a runoff that is not the deposit's maturity is a row error on linearDecay.horizonMonths, and the column on a floater does not apply", () => {
    const bad = csv("op1,ops,l-ops,nmd,300000000,48,0,level-pay,0,0,,,,,36");
    expect("errors" in bad).toBe(true);
    if ("errors" in bad) expect(bad.errors.map((e) => [e.row, e.column, e.message])).toEqual([[2, "linearDecay.horizonMonths", 'field "linearDecay.horizonMonths" must equal the deposit\'s maturityMonths, 48']]);
    const off = csv("fa1,adv,l-adv,floating-loan,10000000,24,0,bullet,,,1,0.002,1,,24");
    expect("errors" in off).toBe(true);
    if ("errors" in off) expect(off.errors.map((e) => e.column)).toEqual(["linearDecayMonths"]);
  });
});
