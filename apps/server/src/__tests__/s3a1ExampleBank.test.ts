/**
 * The example bank (examples/mid-size-bank-v1.json), its finished analysis and the CSV
 * template v2.
 *
 *  1. The file imports on the JSON path with no error and no warning, and round-trips: import, read back, compare.
 *  2. Its totals tie (assets equal liabilities plus equity) and each family's total is the one the data note's table
 *     states (docs/oss/mid-size-bank.md), read from the note, not from the file.
 *  3. Its behavior blocks are its own: none equals a kernel default.
 *  4. The CSV template v2 imports against the chart the seed stores.
 *  5. On a fresh starter store, the analysis "Explore the example bank" sets up, written here by hand from the routes
 *     the guided steps call, launches and runs to done, the deposits reading the SOFR history to March 2026.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, IB_BUCKETS, MBS_DEFAULTS, NMD_B_TERMS_DEFAULTS, NMD_DEFAULTS } from "@alm/kernel";
import type { PortfolioSpec } from "@alm/engine";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { parsePositionsJson } from "../intake/positionsJson";
import { FileStore } from "../store/store";
import type { RunStatus } from "../jobs/types";
import type { ReadinessReport } from "../workspaces/readiness";
import type { WorkspaceManifest } from "../workspaces/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const ROOT = repoRoot();
const BANK_TEXT = readFileSync(join(ROOT, "examples", "mid-size-bank-v1.json"), "utf8");
const bank = JSON.parse(BANK_TEXT) as PortfolioSpec;
const M = 1_000_000;

/** The data note's balance sheet table: family id to $ millions, read from the markdown. */
function noteTable(): Map<string, number> {
  const md = readFileSync(join(ROOT, "docs", "oss", "mid-size-bank.md"), "utf8");
  const out = new Map<string, number>();
  for (const line of md.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length > 5 && /^mb-[a-z-]+$/.test(cells[1]!)) out.set(cells[1]!, Number(cells[4]));
  }
  return out;
}

describe("the example bank file", () => {
  it("imports on the JSON path with no error and no warning", () => {
    const out = parsePositionsJson(JSON.parse(BANK_TEXT));
    expect("portfolio" in out, JSON.stringify(out).slice(0, 800)).toBe(true);
    if ("portfolio" in out) expect(out.warnings).toEqual([]);
  });

  it("ties: assets equal liabilities plus equity, $5,000M = $4,450M + $550M; off-balance lines are in neither", () => {
    // The on-balance families, listed by hand from the data note's table (not by the side rule the code applies).
    const ASSET_FAMILIES = ["mb-non-earning", "mb-cash", "mb-treasuries", "mb-agencies", "mb-agency-mbs", "mb-ci-floating", "mb-ci-fixed", "mb-cre-fixed", "mb-cre-multifamily", "mb-cre-construction", "mb-resi-mortgages", "mb-heloc", "mb-consumer", "mb-other-loans"];
    const LIABILITY_FAMILIES = ["mb-nib-checking", "mb-int-checking", "mb-savings", "mb-mma", "mb-cds", "mb-fhlb-fixed", "mb-fhlb-floating"];
    const sum = (ids: string[]) => bank.positions.filter((p) => ids.includes(p.familyId)).reduce((s, p) => s + p.terms.notional, 0);
    expect(sum(ASSET_FAMILIES)).toBe(5_000 * M);
    expect(sum(LIABILITY_FAMILIES)).toBe(4_450 * M);
    // Every other position is the swap or the undrawn lines.
    expect(bank.positions.filter((p) => !ASSET_FAMILIES.includes(p.familyId) && !LIABILITY_FAMILIES.includes(p.familyId)).map((p) => p.id).sort()).toEqual(["mb-lines-1", "mb-swap-1"]);
    // The non-earning assets are held at book: three non-rate-sensitive balances, $250M (the author's "about 5 percent").
    const ne = bank.positions.filter((p) => p.familyId === "mb-non-earning");
    expect(ne.map((p) => p.terms.type)).toEqual(["non-rate-sensitive", "non-rate-sensitive", "non-rate-sensitive"]);
    expect(ne.reduce((s, p) => s + p.terms.notional, 0)).toBe(250 * M);
  });

  it("each family's total is the data note's", () => {
    const table = noteTable();
    expect([...table.keys()].sort()).toEqual(bank.coa.families.map((f) => f.id).sort());
    for (const f of bank.coa.families) {
      const total = bank.positions.filter((p) => p.familyId === f.id).reduce((s, p) => s + p.terms.notional, 0);
      expect(total, f.id).toBe(table.get(f.id)! * M);
    }
  });

  it("carries a cd cohort book whose balances are its dollars over the walk scale, a swap, a commitment and a floating liability", () => {
    const types = new Map(bank.positions.map((p) => [p.id, p.terms.type]));
    expect([...types.values()].filter((t) => t === "swap" || t === "cd" || t === "commitment").sort()).toEqual(["cd", "commitment", "swap"]);
    const cd = bank.positions.find((p) => p.terms.type === "cd")!.terms as unknown as { notional: number; cohorts: Array<{ balance: number }> };
    expect(cd.cohorts.reduce((s, c) => s + c.balance * 500_000, 0)).toBe(cd.notional);
    const floatingLiability = bank.positions.find((p) => p.terms.type === "floating-loan" && p.terms.side === "liability");
    expect(floatingLiability?.id).toBe("mb-fhlb-2");
  });

  it("its behavior blocks are its own: none equals a kernel default", () => {
    const defaults = [MBS_DEFAULTS, NMD_DEFAULTS, NMD_B_TERMS_DEFAULTS.nmdParams, { ...NMD_DEFAULTS, buckets: IB_BUCKETS }, BETA_S_CURVE_DEFAULTS].map((d) => JSON.stringify(d));
    for (const p of bank.positions) {
      const t = p.terms as unknown as Record<string, unknown>;
      for (const k of ["cprParams", "nmdParams", "sCurve"]) if (t[k] !== undefined) expect(defaults, `${p.id}.${k}`).not.toContain(JSON.stringify(t[k]));
    }
    const analysis = JSON.parse(readFileSync(join(ROOT, "examples", "mid-size-bank-v1.analysis.json"), "utf8")) as { behavior: { bindings: Array<{ overlay: { params: unknown }; modelVersion: string }> } };
    for (const b of analysis.behavior.bindings) {
      expect(defaults).not.toContain(JSON.stringify(b.overlay.params));
      expect(b.modelVersion).toBe("illustrative-v1");
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

  it("the bank round-trips: import, read back, compare", async () => {
    const r = await api<{ id: string; warnings: string[] }>(tp.base, "POST", "/api/portfolios/import", JSON.parse(BANK_TEXT));
    expect(r.status, r.text.slice(0, 600)).toBe(201);
    expect(r.body.warnings).toEqual([]);
    const back = await api<PortfolioSpec>(tp.base, "GET", `/api/portfolios/${bank.id}`);
    expect(back.body).toEqual(bank);
    const list = await api<Array<{ id: string; intakeStats?: { assets: number; liabilities: number; equity: number } }>>(tp.base, "GET", "/api/portfolios");
    expect(list.body.find((p) => p.id === bank.id)?.intakeStats).toMatchObject({ assets: 5_000 * M, liabilities: 4_450 * M, equity: 550 * M });
  });

  it("the CSV template v2 imports against the bank's chart, which the seed stores", async () => {
    const csv = readFileSync(join(ROOT, "examples", "positions-template-v2.csv"), "utf8");
    const r = await api<{ id: string; positionCount: number }>(tp.base, "POST", "/api/portfolios/import?format=csv&coaId=mid-size-bank-coa-v1&label=Template&portfolioId=template-v2&asOf=2026-03-31", csv);
    expect(r.status, r.text.slice(0, 600)).toBe(201);
    // 14 data rows, the three cd rows one book: 12 positions.
    expect(r.body.positionCount).toBe(12);
    const served = await fetch(`${tp.base}/api/guided/templates/positions.csv`);
    expect(await served.text()).toBe(csv);
  });

  it("the finished analysis sets up through the guided routes and runs to done on the SOFR history", async () => {
    const rows = await api<Array<{ id: string; analysis?: boolean }>>(tp.base, "GET", "/api/guided/examples");
    expect(rows.body.filter((x) => x.analysis === true).map((x) => x.id)).toEqual(["mid-size-bank-v1"]);
    const a = (await api<{
      behavior: { label: string; bindings: unknown[] }; targets: { label: string; targets: unknown[] }; templates: unknown[]; goingConcern: boolean;
      nmdWarmup: { kind: string; series: { firstMonth: string; valuesPct: number[] } }; warmupSource: { sourceUrl: string };
    }>(tp.base, "GET", "/api/guided/examples/mid-size-bank-v1/analysis")).body;
    expect(a.nmdWarmup.series.firstMonth).toBe("2018-04");
    expect(a.nmdWarmup.series.valuesPct).toHaveLength(96);
    expect(a.warmupSource.sourceUrl).toBe("https://fred.stlouisfed.org/series/SOFR");

    const WS = "ws-example-bank";
    let w = (await api<WorkspaceManifest>(tp.base, "POST", "/api/workspaces", { id: WS, name: "Example bank", type: "test", cutoffDate: "2026-03-31", owner: "Analyst", by: "Analyst" })).body;
    const block = async (body: object) => {
      const r = await api<WorkspaceManifest>(tp.base, "POST", `/api/workspaces/${WS}/blocks`, { expectedRevision: w.revision, by: "Analyst", ...body });
      expect(r.status, r.text.slice(0, 400)).toBe(201);
      w = r.body;
    };
    await block({ block: "market", op: "set", ref: { collection: "market", id: "market-public-2026-03-31" } });
    await block({ block: "positions", op: "set", ref: { collection: "portfolios", id: bank.id } });
    const set = { schemaVersion: "1.0.0", id: "guided-example-bank-1", label: a.behavior.label, bindings: a.behavior.bindings };
    expect((await api(tp.base, "POST", "/api/assumption-sets", set)).status).toBe(201);
    await block({ block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: set.id } });
    if (w.blocks.assumptions.defaultSetId !== set.id) await block({ block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: set.id } });
    const plan = { schemaVersion: "1.0.0", id: "bp-guided-example-bank-1", label: a.targets.label, asOf: "2026-03-31", targets: a.targets.targets, unlistedFamilies: "runoff" };
    const pr = await api(tp.base, "POST", "/api/balance-plans", { balancePlan: plan });
    expect(pr.status, pr.text.slice(0, 400)).toBe(201);
    await block({ block: "targets", op: "add", ref: { collection: "plans", id: plan.id } });
    // The guided setup as the guided path writes it (apps/studio/src/guided/setup.ts guidedSetupBody), restated here.
    const setup = {
      schemaVersion: "1.0.0", name: "Guided analysis", gridHorizonMonths: 360,
      inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } },
      scenarios: { kind: "library", refs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S100", "regulatory-grid-v1#S-100", "regulatory-grid-v1#S200", "regulatory-grid-v1#S-200"] },
      plan: { planId: null, label: "Guided analysis", authoredBy: "person", stages: "derived-default", reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }], validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] } },
      nii: { enabled: true, horizonMonths: 60, reportHorizons: [12, 24, 60], basis: { kind: "custom", balancePlanId: plan.id }, path: "single", templates: a.templates },
      eve: { enabled: true, discountBasis: "risk-free", durationMode: "base-only", valuationDates: "as-of", keyRate: false, channels: false, path: "single", goingConcern: true },
      gap: { enabled: true, repricingBuckets: { kind: "monthly" }, fixedRateLadder: false, liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } } },
      ftp: { enabled: true }, instrumentResults: { save: false, coaNodeIds: [] }, batch: [], importedFrom: null, supersedes: null, note: "",
      nmdWarmup: a.nmdWarmup,
    };
    const sr = await api<{ manifest: WorkspaceManifest }>(tp.base, "POST", "/api/run-setups", { workspaceId: WS, setupLineageId: "setup-guided", expectedRevision: w.revision, by: "Analyst", setup });
    expect(sr.status, sr.text.slice(0, 600)).toBe(201);
    const readiness = (await api<ReadinessReport>(tp.base, "GET", `/api/workspaces/${WS}/readiness`)).body;
    const gate = readiness.launchable["setup-guided"]!;
    expect(gate.blocking, JSON.stringify(readiness.items.filter((i) => i.state !== "valid").map((i) => `${i.section}/${i.item}: ${i.detail}`))).toEqual([]);
    const l = await api<{ runIds: string[] }>(tp.base, "POST", `/api/workspaces/${WS}/setups/setup-guided/launch`, { by: "Analyst", acknowledge: gate.acknowledgeable });
    expect(l.status, l.text.slice(0, 600)).toBe(200);
    const runId = l.body.runIds[0]!;
    const st = await waitFor(() => api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 540_000, 500);
    expect(st.body.state, JSON.stringify(st.body).slice(0, 800)).toBe("done");
    const result = JSON.parse(readFileSync(join(tp.storeRoot, "runs", runId, "result.json"), "utf8")) as {
      schemaVersion: string;
      nmdWarmup?: { kind: string; months: number; firstMonth: string; lastMonth: string };
      eve: { byScenario: Array<{ scenarioId: string; eve: number; byFamily: Array<{ familyId: string; pv: number }> }> };
      nii: { byScenario: Array<{ scenarioId: string; totalNet12: number; byFamily: Array<{ familyId: string; interestIncome12: number; interestExpense12: number }> }> };
      gap: Record<"repricing" | "liquidity", Array<{ scenarioId: string; rows: Array<{ assets: number }>; byCoaNode: Array<{ coaNodeId: string; rows: Array<{ assets: number; liabilities: number }> }> }>>;
    };
    // S3a-1 follow-up: the $250M held at book sits in neither ladder, so month 1 of the liquidity ladder carries the
    // $400M of fed funds maturing then plus the month's amortization and prepayment, and no longer the $250M.
    for (const kind of ["repricing", "liquidity"] as const) {
      for (const ladder of result.gap[kind]) {
        const node = ladder.byCoaNode.find((n) => n.coaNodeId === "mb-non-earning")!;
        expect(node.rows.every((r) => r.assets === 0 && r.liabilities === 0), `${kind} ${ladder.scenarioId}`).toBe(true);
      }
    }
    const m1 = result.gap.liquidity.find((l) => l.scenarioId === "S0")!.rows[0]!.assets;
    expect(m1).toBeGreaterThan(400 * M);
    expect(m1).toBeLessThan(500 * M);
    // And value counts it at par, its book value, at base and at +200 bp.
    for (const id of ["S0", "S200"]) expect(result.eve.byScenario.find((x) => x.scenarioId === id)!.byFamily.find((f) => f.familyId === "mb-non-earning")!.pv, id).toBe(250 * M);
    expect(result.schemaVersion).toBe("1.13.0");
    expect(result.nmdWarmup).toEqual({ kind: "history", label: expect.stringContaining("SOFR"), months: 96, firstMonth: "2018-04", lastMonth: "2026-03" });
    expect(result.eve.byScenario.map((s) => s.scenarioId)).toHaveLength(5);
    for (const s of result.eve.byScenario) expect(Number.isFinite(s.eve), s.scenarioId).toBe(true);
    // The author's realism targets (fix round): base 12-month NII 3.5 percent of the $5,000M of assets, within 0.15 points,
    // and a +200 bp run-off EVE loss of 10 to 15 percent of base EVE.
    const eve = new Map(result.eve.byScenario.map((s) => [s.scenarioId, s.eve]));
    const nii12 = result.nii.byScenario.find((s) => s.scenarioId === "S0")!.totalNet12;
    expect(nii12 / (5_000 * M)).toBeGreaterThan(0.035 - 0.0015);
    expect(nii12 / (5_000 * M)).toBeLessThan(0.035 + 0.0015);
    const drop = eve.get("S200")! / eve.get("S0")! - 1;
    expect(drop).toBeLessThan(-0.10);
    expect(drop).toBeGreaterThan(-0.15);
    // The headline numbers go to the build report; this line prints them for the record.
    console.log(`S3a-1 example bank headline: NII12 ${Math.round(nii12)}; EVE ${JSON.stringify(result.eve.byScenario.map((s) => [s.scenarioId, Math.round(s.eve)]))}`);
    // S3a-2 fix round: the first-year income and expense the data note quotes, deposits apart.
    const fams = result.nii.byScenario.find((s) => s.scenarioId === "S0")!.byFamily;
    const DEPOSITS = ["mb-nib-checking", "mb-int-checking", "mb-savings", "mb-mma", "mb-cds"];
    const sum = (f: (r: (typeof fams)[number]) => number, only?: string[]) => fams.filter((r) => only === undefined || only.includes(r.familyId)).reduce((a, r) => a + f(r), 0);
    console.log(`S3a-2 first year: income ${Math.round(sum((r) => r.interestIncome12))}; expense ${Math.round(sum((r) => r.interestExpense12))}; deposit expense ${Math.round(sum((r) => r.interestExpense12, DEPOSITS))}`);

    // Fix round L7: the history reaches an orchestrated run. The same analysis without it values the deposits on the
    // kernel's own series, so the +200 bp value moves (the regime amplifier reads the history).
    const head2 = (await api<WorkspaceManifest>(tp.base, "GET", `/api/workspaces/${WS}`)).body;
    const current = head2.blocks.run.setups.find((x) => x.setupLineageId === "setup-guided")!.current.id;
    const { nmdWarmup: _w, ...without } = setup;
    void _w;
    const sr2 = await api(tp.base, "POST", "/api/run-setups", { workspaceId: WS, setupLineageId: "setup-guided", expectedRevision: head2.revision, by: "Analyst", setup: { ...without, supersedes: current } });
    expect(sr2.status, sr2.text.slice(0, 400)).toBe(201);
    const gate2 = (await api<ReadinessReport>(tp.base, "GET", `/api/workspaces/${WS}/readiness`)).body.launchable["setup-guided"]!;
    const l2 = await api<{ runIds: string[] }>(tp.base, "POST", `/api/workspaces/${WS}/setups/setup-guided/launch`, { by: "Analyst", acknowledge: gate2.acknowledgeable });
    expect(l2.status, l2.text.slice(0, 400)).toBe(200);
    const st2 = await waitFor(() => api<RunStatus>(tp.base, "GET", `/api/runs/${l2.body.runIds[0]!}`), (x) => x.body.state === "done" || x.body.state === "error", 540_000, 500);
    expect(st2.body.state).toBe("done");
    const r2 = JSON.parse(readFileSync(join(tp.storeRoot, "runs", l2.body.runIds[0]!, "result.json"), "utf8")) as { nmdWarmup?: unknown; eve: { byScenario: Array<{ scenarioId: string; eve: number }> } };
    expect(r2.nmdWarmup).toBeUndefined();
    const d200 = r2.eve.byScenario.find((x) => x.scenarioId === "S200")!.eve - eve.get("S200")!;
    console.log(`S3a-1 history vs kernel series, +200 bp EVE difference: ${Math.round(d200)}`);
    expect(Math.abs(d200)).toBeGreaterThan(1_000_000);
  }, 900_000);
});
