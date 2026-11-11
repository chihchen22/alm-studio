/**
 * Studio slice S2b-1 on the platform: the run setup carries new-volume templates and a Flat basis with any
 * term and spread; the guided horizon is the NII window and the report horizons only; the New volume step's preview.
 *
 * Expected values are worked by hand or read off the engine's curve (the definition of the rate), never off the code
 * under test:
 *  - a stored setup at the Flat 60 and 0 parses to its own bytes, and one without templates writes none;
 *  - (d) a setup whose earnings horizon is 24 months gives the same EVE, byte for byte, as one at 360 months;
 *  - a run with templates writes the new-volume lines in NII and FTP, and its EVE equals the same run without them;
 *  - the preview's target path is the opening balance grown at (B / b0)^(1 / m) a month, worked by hand, and a fixed
 *    product's rate today is the curve's par swap rate over its term plus the spread.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NewVolumeTemplateSpec, RunResult } from "@alm/engine";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import type { MarketSnapshot } from "@alm/kernel";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { standardAlcoSetup } from "../workspaces/standardAlco";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import type { RunStatus } from "../jobs/types";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

const WARNINGS = "run/setup-warnings";
const blocks = (id: string, rev: number, body: object) =>
  api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });

async function ready(id: string): Promise<WorkspaceManifest> {
  const created = await api(t.base, "POST", "/api/workspaces", { id, name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
  expect(created.status).toBe(201);
  await blocks(id, 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
  await blocks(id, 2, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
  await blocks(id, 3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  const w = await blocks(id, 4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
  expect(w.status).toBe(201);
  return w.body;
}

function alco(): Omit<RunSetup, "id"> {
  const { id: _id, ...s } = standardAlcoSetup("ws-x");
  return s;
}

/** Save a setup into a slot of its own and launch it; the run's result. */
async function launchSetup(wsId: string, slot: string, setup: Omit<RunSetup, "id">): Promise<{ runId: string; result: RunResult }> {
  const head = (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${wsId}`)).body;
  const saved = await api<{ setup: RunSetup }>(t.base, "POST", "/api/run-setups", { workspaceId: wsId, setupLineageId: slot, expectedRevision: head.revision, by: "tester", setup });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/${wsId}/setups/${slot}/launch`, { by: "tester", acknowledge: [WARNINGS] });
  expect(l.status, JSON.stringify(l.body)).toBe(200);
  const runId = l.body.runIds[0]!;
  const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 240_000);
  expect(done.body.state, JSON.stringify(done.body)).toBe("done");
  return { runId, result: store.readRunJson<RunResult>(runId, "result.json") };
}

const TEMPLATES: NewVolumeTemplateSpec[] = [
  { familyId: "fixed-loans", rateType: "floating", amortization: "level-pay", indexTenorMonths: 3, termMonths: 60, spreadOverIndexBp: 200 },
  { familyId: "fhlb", rateType: "fixed", amortization: "bullet", indexTenorMonths: 24, termMonths: 24, spreadOverIndexBp: 30 },
];

describe("the run setup's new-volume fields", () => {
  it("a stored setup at the Flat 60 and 0 parses to its own bytes and carries no templates", () => {
    const s = alco();
    expect(JSON.stringify(parseRunSetup(s))).toBe(JSON.stringify(s));
    expect("templates" in parseRunSetup(s).nii).toBe(false);
  });

  it("the Flat term and spread now take the plan's range, and templates round-trip", () => {
    const s = alco();
    const lifted = { ...s, nii: { ...s.nii, basis: { kind: "flat" as const, termMonths: 36, spreadOverIndexBp: -25 }, templates: TEMPLATES } };
    const parsed = parseRunSetup(lifted);
    expect(parsed.nii.basis).toEqual({ kind: "flat", termMonths: 36, spreadOverIndexBp: -25 });
    expect(parsed.nii.templates).toEqual(TEMPLATES);
    expect(() => parseRunSetup({ ...s, nii: { ...s.nii, basis: { kind: "flat", termMonths: 0, spreadOverIndexBp: 0 } } })).toThrow(/nii\.basis\.termMonths/);
    expect(() => parseRunSetup({ ...s, nii: { ...s.nii, basis: { kind: "flat", termMonths: 400, spreadOverIndexBp: 0 } } })).toThrow(/from 1 to 360/);
  });

  it("refuses a template the engine does not run, naming the row", () => {
    const s = alco();
    const bad = { ...s, nii: { ...s.nii, templates: [{ ...TEMPLATES[0]!, indexTenorMonths: 2 }] } };
    expect(() => parseRunSetup(bad)).toThrow(/nii\.templates\[0\].*one of 1, 3, 6, 12/);
    const twice = { ...s, nii: { ...s.nii, templates: [TEMPLATES[0]!, TEMPLATES[0]!] } };
    expect(() => parseRunSetup(twice)).toThrow(/more than one template/);
  });
});

describe("(d) the earnings horizon never moves value", () => {
  it("a 24-month horizon and a 360-month horizon give the same EVE, byte for byte; only the NII window moves", async () => {
    await ready("ws-nv-horizon");
    const s = alco();
    const short = { ...s, nii: { ...s.nii, horizonMonths: 24, reportHorizons: [12, 24] }, eve: { ...s.eve, discountBasis: "risk-free" as const } };
    const long = { ...s, nii: { ...s.nii, horizonMonths: 360, reportHorizons: [12, 24, 360] }, eve: { ...s.eve, discountBasis: "risk-free" as const } };
    const a = await launchSetup("ws-nv-horizon", "setup-h24", short);
    const b = await launchSetup("ws-nv-horizon", "setup-h360", long);
    expect(JSON.stringify(a.result.eve)).toBe(JSON.stringify(b.result.eve));
    expect(a.result.eve.discountBasis).toBe("risk-free");
    // The setting took: the windows and the horizons differ, and the 12- and 24-month NII agree to the bit.
    expect(a.result.nii.windowMonths).toBe(24);
    expect(b.result.nii.windowMonths).toBe(360);
    expect(a.result.nii.horizonsMonths).toEqual([12, 24]);
    expect(b.result.nii.horizonsMonths).toEqual([12, 24, 360]);
    for (let i = 0; i < a.result.nii.byScenario.length; i++) {
      expect(a.result.nii.byScenario[i]!.totalNet12).toBe(b.result.nii.byScenario[i]!.totalNet12);
      expect(a.result.nii.byScenario[i]!.totalNet24).toBe(b.result.nii.byScenario[i]!.totalNet24);
    }
  }, 300_000);
});

describe("a launch with templates", () => {
  it("writes new volume into NII and FTP; EVE and the gap ladders stay those of the run without templates", async () => {
    await ready("ws-nv-run");
    const s = alco();
    const plain = await launchSetup("ws-nv-run", "setup-plain", s);
    const tpl = await launchSetup("ws-nv-run", "setup-tpl", { ...s, nii: { ...s.nii, templates: TEMPLATES } });
    expect(JSON.stringify(tpl.result.eve)).toBe(JSON.stringify(plain.result.eve));
    expect(JSON.stringify(tpl.result.gap)).toBe(JSON.stringify(plain.result.gap));
    const base = tpl.result.nii.byScenario.find((x) => x.scenarioId === tpl.result.ftp!.scenarioId)!;
    const loans = base.newBusiness!.find((n) => n.familyId === "fixed-loans")!;
    expect(loans.product).toEqual({ source: "template", rateType: "floating", amortization: "level-pay", indexTenorMonths: 3, termMonths: 60, spreadOverIndexBp: 200 });
    const cash = base.newBusiness!.find((n) => n.familyId === "cash")!;
    expect(cash.product!.source).toBe("fixed-bullet");
    expect(tpl.result.ftp!.byFamily.find((f) => f.familyId === "fixed-loans")!.newVolume!.trancheCount).toBeGreaterThan(0);
    const b = tpl.result.ftp!.nimBridge;
    expect(Math.abs(b.newVolume!.net12 - b.newBusinessNet12!)).toBeLessThan(1e-6 * Math.max(1, Math.abs(b.newBusinessNet12!)));
    // The run with no template writes none of it.
    const pb = plain.result.nii.byScenario[0]!.newBusiness!;
    expect(pb.every((n) => Object.keys(n).join(",") === "familyId,originations")).toBe(true);
    expect(plain.result.ftp!.nimBridge.newVolume).toBeUndefined();
  }, 300_000);
});

describe("the New volume step's preview", () => {
  it("suggests each family's own product, prices a fixed product at the swap rate over its term, and draws the target path", async () => {
    await ready("ws-nv-preview");
    const plan = {
      schemaVersion: "1.0.0", id: "bp-preview", label: "Preview", asOf: "2026-03-31", unlistedFamilies: "runoff",
      // Opening fixed loans by hand: 100 + 150 + 150 + 150 + 100 = 650 million; grow to 715 million by month 24.
      targets: [{ familyId: "fixed-loans", path: [{ month: 24, balance: 715_000_000 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 60 } }],
    };
    const tpl = { familyId: "fixed-loans", rateType: "fixed", amortization: "level-pay", indexTenorMonths: 60, fixedIndex: "swap", termMonths: 60, spreadOverIndexBp: 150 };
    const matched = { familyId: "fhlb", rateType: "fixed", amortization: "bullet", indexTenorMonths: 24, termMonths: 24, spreadOverIndexBp: 30 };
    const r = await api<{ families: Array<{ familyId: string; opening: number; suggested: { template: unknown; termMonths: number } | null; preview?: { couponRate: number; indexRate: number; months: Array<{ balance: number }> }; target?: { balance: number[]; annualGrowthPct: number | null } }>; todayRule: { couponRate: number }; problems: string[] }>(
      t.base, "POST", "/api/workspaces/ws-nv-preview/new-volume-preview", { templates: [tpl, matched], plan, months: 36 },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.problems).toEqual([]);
    const loans = r.body.families.find((f) => f.familyId === "fixed-loans")!;
    expect(loans.opening).toBe(650_000_000);
    // Suggested: level pay like the loans, over their notional-weighted term (100x36 + 150x60 + 150x84 + 150x120 + 100x120) / 650 = 84.9 -> 85.
    expect(loans.suggested).toEqual({ template: { rateType: "fixed", amortization: "level-pay", indexTenorMonths: 85, fixedIndex: "matched", behavior: "family" }, termMonths: 85, basis: expect.any(String) });
    // The rate today: the curve's par swap rate from 0 to 5 years, plus 150 bp.
    const curve = buildBaseCurve(store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc);
    expect(loans.preview!.indexRate).toBeCloseTo(curve.forwardSwapRate(0, 5), 12);
    expect(loans.preview!.couponRate).toBeCloseTo(curve.forwardSwapRate(0, 5) + 0.015, 12);
    expect(loans.preview!.months).toHaveLength(60);
    // The target: 650 x 1.1^(k / 24); 682.0 million at month 12 (650 x sqrt 1.1), 715 at 24.
    const tg = loans.target!;
    expect(tg.balance).toHaveLength(37);
    expect(tg.balance[0]).toBeCloseTo(650_000_000, 4);
    expect(tg.balance[12]).toBeCloseTo(650_000_000 * Math.sqrt(1.1), 2);
    expect(tg.balance[24]).toBeCloseTo(715_000_000, 2);
    expect(tg.annualGrowthPct).toBeCloseTo((Math.sqrt(1.1) - 1) * 100, 9);
    // Today's rule: a 60-month bullet at the par swap rate.
    expect(r.body.todayRule.couponRate).toBeCloseTo(curve.forwardSwapRate(0, 5), 12);
    // The funding family has no suggestion beyond its own bullets: fixed bullet over its average term.
    expect(r.body.families.find((f) => f.familyId === "fhlb")!.suggested!.template).toEqual({ rateType: "fixed", amortization: "bullet", indexTenorMonths: 31, fixedIndex: "matched", behavior: "family" });
    // A matched product (fix round M3): its margin over its own transfer rate is its spread, 30 bp.
    const fhlb = r.body.families.find((f) => f.familyId === "fhlb")! as unknown as { preview: { margin: number; transferRate: number; couponRate: number } };
    expect(fhlb.preview.margin).toBeCloseTo(0.003, 12);
    expect(fhlb.preview.couponRate).toBeCloseTo(fhlb.preview.transferRate + 0.003, 12);
  });

  it("names a template or plan the engine refuses, in a sentence, never a 500", async () => {
    const r = await api<{ problems: string[] }>(t.base, "POST", "/api/workspaces/ws-nv-preview/new-volume-preview", {
      templates: [
        { familyId: "fixed-loans", rateType: "floating", amortization: "bullet", indexTenorMonths: 12, termMonths: 6, spreadOverIndexBp: 0 },
      ],
      plan: { schemaVersion: "1.0.0", id: "bp-x", label: "x", asOf: "2026-03-31", unlistedFamilies: "runoff", targets: [{ familyId: "fixed-loans", path: [{ month: 12, balance: 0 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 60 } }] },
    });
    expect(r.status).toBe(200);
    expect(r.status).toBe(200);
    expect(r.body.problems).toHaveLength(2);
    expect(r.body.problems[0]).toMatch(/^The targets cannot run as they stand/);
    expect(r.body.problems[1]).toMatch(/longer than its term/);
    // Fix round L3: a spread JSON reads as Infinity (1e999) is a sentence from the template rule, never a null coupon.
    const inf = await api<{ problems: string[] }>(t.base, "POST", "/api/workspaces/ws-nv-preview/new-volume-preview",
      '{"templates":[{"familyId":"fhlb","rateType":"fixed","amortization":"bullet","indexTenorMonths":24,"termMonths":24,"spreadOverIndexBp":1e999}]}',
      { "content-type": "application/json" });
    expect(inf.status).toBe(200);
    expect(inf.body.problems).toEqual(["FHLB Advances: the spread must be a finite number of basis points, got Infinity."]);
  });
});
