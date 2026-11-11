// apps/server/src/__tests__/studioP1Acceptance.test.tsx
/**
 * ALM Studio Piece 1 acceptance (spec 2026-09-26-alm-studio-p1-frame-design.md
 * Section 8, items 1 to 5) on a freshly seeded test platform.
 *
 * Item 1: the Section 5 map, restated here, is the route table; every layer
 * address parses to itself with its query kept, and every Section 4.3 old
 * address forwards to the stated new one with its query kept. (That every
 * live route opens its page is held by apps/studio pageFor.test.tsx: pageFor
 * reads VIEWER_BASE through import.meta, which the server workspace does not
 * compile.) Item 2: every Soon page prints no digit but its piece. Item 3:
 * two runs of the seeded synthetic plan, one as seeded and one with the
 * library steepener added, and every Dashboard card value and sub and every
 * table cell, each restated literally and tied to the stored field its path
 * names. Item 4: the deposit decay page over every stored set shows
 * demo-behavioral-v1 and stress-illustrative-v1 with their stored values.
 * Item 5: the three Govern views render from the seeded platform's catalog
 * routes, after the database mirror has synced the two runs.
 *
 * Expected values, field paths and figure formats are restated here, never
 * imported from the code they check.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunPlan, RunResult } from "@alm/engine";
import {
  getAssumptionSet, getCatalogLineage, getCatalogRunInputs, getPlanLibrary, getPluginCatalog, getResultSection, listAssumptionSets, listCatalogRuns,
  type CatalogRunListItem,
} from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { defaultDbPath, openPlatformDb } from "../db/database";
import { syncStoreToDb } from "../db/ingest";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { LAYERS, MODULES, parseHash } from "../../../studio/src/router";
import { SoonPage } from "../../../studio/src/pages/SoonPage";
import { dashboardModel, type DashboardModel } from "../../../studio/src/dashboard/dashboardModel";
import { DashboardView } from "../../../studio/src/pages/dashboard/DashboardPage";
import { loadResults } from "../../../studio/src/pages/results/loadResults";
import { byKindModel } from "../../../studio/src/assumptions/byKindModel";
import { ByKindView } from "../../../studio/src/pages/assumptions/ByKindPage";
import { auditPlan, auditRows, inventoryRows } from "../../../studio/src/govern/governModels";
import { AuditView, InventoryView, LineageView } from "../../../studio/src/pages/govern/GovernPages";

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  // Studio's reader client calls relative /api paths; send them to the test platform.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const TERMINAL = ["done", "error", "cancelled", "interrupted"];
const finished = (runId: string) =>
  waitFor(() => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body), (s) => TERMINAL.includes(s.state), 600_000);

// A wbr is a break opportunity, not text: it is dropped before the other tags turn into spaces (Polish 6 Task 6 fix I1).
const text = (s: string) =>
  s.replace(/<wbr\/?>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const rowsOf = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
// A body cell is a td or a row header, th scope="row" (Row header scope); a column header is not one.
const tdsOf = (tr: string) => [...tr.matchAll(/<(?:td|th scope="row")[^>]*>[\s\S]*?<\/t[dh]>/g)].map((m) => m[0]);
const cellsOf = (tr: string) => tdsOf(tr).map(text);
/** The body rows of the table inside the section labelled `label`. */
const tableIn = (html: string, label: string) => {
  const m = html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`));
  if (m === null) throw new Error(`no section labelled ${label}`);
  return rowsOf(m[1]!).filter((r) => r.includes("<td"));
};

// --- Figure formats, restated (spec Section 7 item 4) ------------------------------

const MINUS = "−";
const ZERO = "$0.0M";
/** A magnitude in USD millions with one decimal and thousands commas. */
const mag = (v: number) => `$${(Math.abs(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
/** A level: a true minus when the printed magnitude is not zero. */
const level = (v: number) => (v < 0 && mag(v) !== ZERO ? `${MINUS}${mag(v)}` : mag(v));
/** A signed figure: plus or true minus, and no sign on a zero-rounded figure. */
const signed = (v: number) => (mag(v) === ZERO ? ZERO : `${v > 0 ? "+" : MINUS}${mag(v)}`);
const signedPct = (r: number) => {
  const p = `${(Math.abs(r) * 100).toFixed(1)}%`;
  return p === "0.0%" ? p : `${r > 0 ? "+" : MINUS}${p}`;
};

/** Read a stored figure by its restated path `<block>.byScenario[scenarioId=<id>].<field>`. */
function stored(result: RunResult, path: string): number {
  const m = path.match(/^(eve|nii)\.byScenario\[scenarioId=(.+)\]\.(\w+)$/);
  if (m === null) throw new Error(`not a byScenario path: ${path}`);
  const rows = (result[m[1] as "eve" | "nii"].byScenario as unknown as Array<Record<string, unknown>>);
  const row = rows.find((r) => r.scenarioId === m[2]);
  if (row === undefined || typeof row[m[3]!] !== "number") throw new Error(`no stored number at ${path}`);
  return row[m[3]!] as number;
}

// --- Section 5 map and Section 4.3 old addresses, restated -------------------------

/** [module, area, label, piece or "live"] per Section 5, in table order. */
const MAP: Array<[string, string, string, number | "live"]> = [
  ["Data", "Balance sheet", "Book and as-of", "live"],
  ["Data", "Balance sheet", "Chart of accounts", "live"],
  ["Data", "Balance sheet", "Targets and new business", "live"],
  ["Data", "Balance sheet", "Hierarchies and mapping", "live"],
  ["Data", "Market", "Yield curves", "live"],
  ["Data", "Market", "Volatilities", "live"],
  ["Data", "Market", "Spreads and TLP", "live"],
  // Re-expectation: Rate indices is live.
  ["Data", "Market", "Rate indices", "live"],
  // Re-expectation: Macro factors is live; no layer is Soon.
  ["Data", "Market", "Macro factors", "live"],
  ["Data", "Assumptions", "Prepayment", "live"],
  ["Data", "Assumptions", "Deposit decay", "live"],
  ["Data", "Assumptions", "Deposit repricing", "live"],
  ["Data", "Assumptions", "Renewal and draws", "live"],
  ["Data", "Assumptions", "Loan repricing", "live"],
  ["Data", "Assumptions", "Edit a set", "live"],
  ["Data", "Assumptions", "Assumption stacks", "live"],
  ["Data", "Scenarios", "Scenario sets", "live"],
  ["Data", "Scenarios", "Rate shock library", "live"],
  ["Data", "Scenarios", "Custom rate shocks", "live"],
  ["Data", "Scenarios", "Behavioral shocks", "live"],
  ["Data", "Scenarios", "Balance shocks", "live"],
  ["Data", "Scenarios", "Funding spread shocks", "live"],
  // Re-expectation: Volatility shocks is live.
  ["Data", "Scenarios", "Volatility shocks", "live"],
  ["Model", "Model", "Model chain", "live"],
  ["Model", "Model", "Runs", "live"],
  ["Analyze", "Overview", "Dashboard", "live"],
  ["Analyze", "Measures", "Earnings (NII)", "live"],
  ["Analyze", "Measures", "Value (EVE)", "live"],
  ["Analyze", "Measures", "Gap and liquidity", "live"],
  ["Analyze", "Measures", "FTP", "live"],
  ["Analyze", "Measures", "Rate paths", "live"],
  // Re-expectation: Stochastic distributions is live, straight after Rate paths.
  ["Analyze", "Measures", "Stochastic distributions", "live"],
  ["Analyze", "Explain", "Attribution", "live"],
  ["Analyze", "Explain", "Views", "live"],
  ["Analyze", "Explain", "Custom metrics", "live"],
  ["Analyze", "Explain", "Lenses", "live"],
  ["Analyze", "Explain", "Compare runs", "live"],
  ["Govern", "Records", "Versions and lineage", "live"],
  ["Govern", "Records", "Model inventory", "live"],
  ["Govern", "Records", "Run audit log", "live"],
  ["Govern", "Controls", "Limits", "live"],
  ["Govern", "Controls", "Approvals and sign-off", "live"],
];

/** Old address to its new layer address (Section 4.3; Results tabs per the Section 5 rows they became). */
const OLD: Array<[string, string]> = [
  ["#/", "#/analyze/overview/dashboard"],
  ["#/home", "#/analyze/overview/dashboard"],
  ["#/balance-sheet", "#/data/balance/book"],
  ["#/market", "#/data/market/curves"],
  ["#/assumptions", "#/data/assumptions/stacks"],
  ["#/scenarios", "#/data/scenarios/sets"],
  ["#/plan", "#/model/model/chain"],
  ["#/run", "#/model/model/runs"],
  ["#/compare", "#/analyze/explain/compare"],
  ["#/results", "#/analyze/overview/dashboard"],
  ["#/results?tab=overview", "#/analyze/overview/dashboard"],
  ["#/results?tab=eve", "#/analyze/measures/eve"],
  ["#/results?tab=nii", "#/analyze/measures/nii"],
  ["#/results?tab=gap", "#/analyze/measures/gap"],
  ["#/results?tab=ftp", "#/analyze/measures/ftp"],
  ["#/results?tab=rates", "#/analyze/measures/rates"],
  ["#/results?tab=attribution", "#/analyze/explain/attribution"],
  ["#/results?tab=views", "#/analyze/explain/views"],
  ["#/results?tab=metrics", "#/analyze/explain/metrics"],
  ["#/results?tab=lenses", "#/analyze/explain/lenses"],
];

// --- Dashboard expectations, restated literally from the seeded runs ----------------

interface CardExp { key: string; label: string; value: string; sub: string; field: string | null; tone: "neg" | "pos" | null; absent: boolean }
interface RowExp { scenarioId: string; label: string; eve: string; deltaEve: string; deltaTone: "neg" | "pos" | null; nii12: string; nii24: string; newBusiness: boolean }

const GRID = ["S0", "S100", "S-100", "S200", "S-200"];

/** The label the EVE layer prints for each seeded scenario (formatted from its stored rateSpec), restated. */
const LABEL: Record<string, string> = { S0: "Base", S100: "+100bp", "S-100": "-100bp", S200: "+200bp", "S-200": "-200bp", STEEP100: "Twist 0/+100bp" };

// Every figure below re-read on curve default 2 (log-linear on DF); the same plans on a curveDefault: 1 copy of
// the market print the old figures exactly (t10 probe). Old figures in the deltas file, Step 1.
const BASE_CARD: CardExp = { key: "eve-base", label: "EVE, base", value: "$571.5M", sub: "Base", field: "eve.byScenario[scenarioId=S0].eve", tone: null, absent: false };
const WORST_CARD: CardExp = { key: "eve-worst", label: "Worst EVE shock", value: `${MINUS}$187.1M`, sub: `${MINUS}32.7% · +200bp`, field: "eve.byScenario[scenarioId=S200].deltaEveVsBase", tone: "neg", absent: false };
const NII_CARD: CardExp = { key: "nii12", label: "NII, 12 months", value: "$20.0M", sub: `Lowest ${MINUS}$11.9M · -200bp`, field: "nii.byScenario[scenarioId=S0].totalNet12", tone: null, absent: false };

const GRID_ROWS: RowExp[] = [
  { scenarioId: "S0", label: "Base", eve: "$571.5M", deltaEve: "$0.0M", deltaTone: null, nii12: "$20.0M", nii24: "$37.2M", newBusiness: false },
  { scenarioId: "S100", label: "+100bp", eve: "$475.9M", deltaEve: `${MINUS}$95.6M`, deltaTone: "neg", nii12: "$27.9M", nii24: "$54.5M", newBusiness: false },
  { scenarioId: "S-100", label: "-100bp", eve: "$602.8M", deltaEve: "+$31.3M", deltaTone: "pos", nii12: "$5.7M", nii24: `${MINUS}$1.6M`, newBusiness: false },
  { scenarioId: "S200", label: "+200bp", eve: "$384.4M", deltaEve: `${MINUS}$187.1M`, deltaTone: "neg", nii12: "$34.3M", nii24: "$66.3M", newBusiness: false },
  { scenarioId: "S-200", label: "-200bp", eve: "$540.8M", deltaEve: `${MINUS}$30.7M`, deltaTone: "neg", nii12: `${MINUS}$11.9M`, nii24: `${MINUS}$50.7M`, newBusiness: false },
];

/** Run A: plan-synthetic-2500-v1 as seeded, the regulatory grid only. */
const RUN_A = {
  cards: [BASE_CARD, WORST_CARD, NII_CARD,
    { key: "stress", label: "Stress scenario", value: "Not in this run", sub: "Every scenario besides base is on the regulatory grid.", field: null, tone: null, absent: true }] as CardExp[],
  rows: GRID_ROWS,
};

/** Run B: the same plan with steepener-v1#STEEP100 appended, the one scenario off the grid. */
const RUN_B = {
  cards: [BASE_CARD, WORST_CARD, NII_CARD,
    // Re-read on curve default 2 (was $515.5M and −$58.8M); deltas Step 1
    { key: "stress", label: "Stress scenario", value: "$511.5M", sub: `Twist 0/+100bp · ${MINUS}$60.0M`, field: "eve.byScenario[scenarioId=STEEP100].eve", tone: null, absent: false }] as CardExp[],
  rows: [...GRID_ROWS,
    // Re-read on curve default 2 (was $515.5M, −$58.8M and $39.6M); deltas Step 1
    { scenarioId: "STEEP100", label: "Twist 0/+100bp", eve: "$511.5M", deltaEve: `${MINUS}$60.0M`, deltaTone: "neg", nii12: "$20.7M", nii24: "$39.9M", newBusiness: false }] as RowExp[],
};

/** Each literal is the restated format of the stored field it names; the subs read the stored fields they print. */
function tieToStored(result: RunResult, exp: { cards: CardExp[]; rows: RowExp[] }): void {
  const byKey = (k: string) => exp.cards.find((c) => c.key === k)!;
  const base = byKey("eve-base");
  expect(base.value).toBe(level(stored(result, base.field!)));
  const worst = byKey("eve-worst");
  expect(worst.value).toBe(signed(stored(result, worst.field!)));
  const worstId = worst.field!.match(/scenarioId=(.+)\]/)![1]!;
  expect(worst.sub.startsWith(`${signedPct(stored(result, `eve.byScenario[scenarioId=${worstId}].deltaEvePct`))} · `)).toBe(true);
  // Worst is the lowest stored deltaEveVsBase among the scenarios other than base (S0).
  const shocked = result.eve.byScenario.filter((e) => e.scenarioId !== "S0");
  expect(shocked.every((e) => e.deltaEveVsBase >= stored(result, worst.field!))).toBe(true);
  const nii = byKey("nii12");
  expect(nii.value).toBe(level(stored(result, nii.field!)));
  // The NII sub names the lowest stored totalNet12 across every scenario, base included.
  const low = [...result.nii.byScenario].sort((a, b) => a.totalNet12 - b.totalNet12)[0]!;
  expect(nii.sub).toBe(`Lowest ${level(low.totalNet12)} · ${LABEL[low.scenarioId]}`);
  const stress = byKey("stress");
  if (stress.field !== null) {
    expect(stress.value).toBe(level(stored(result, stress.field)));
    const id = stress.field.match(/scenarioId=(.+)\]/)![1]!;
    expect(stress.sub.endsWith(` · ${signed(stored(result, `eve.byScenario[scenarioId=${id}].deltaEveVsBase`))}`)).toBe(true);
  }
  expect(result.eve.byScenario.map((e) => e.scenarioId)).toEqual(exp.rows.map((r) => r.scenarioId));
  for (const r of exp.rows) {
    const p = (block: string, f: string) => stored(result, `${block}.byScenario[scenarioId=${r.scenarioId}].${f}`);
    expect([r.eve, r.deltaEve, r.nii12, r.nii24], r.scenarioId).toEqual([level(p("eve", "eve")), signed(p("eve", "deltaEveVsBase")), level(p("nii", "totalNet12")), level(p("nii", "totalNet24"))]);
    expect(r.deltaTone, r.scenarioId).toBe(r.deltaEve.startsWith(MINUS) ? "neg" : r.deltaEve.startsWith("+") ? "pos" : null);
  }
}

/** The rendered Dashboard prints every card and every table cell as expected. */
function checkRendered(runId: string, model: DashboardModel, exp: { cards: CardExp[]; rows: RowExp[] }): void {
  // The Limit use card has its own load and its own tests (dashboardPage.test.tsx); here it is still reading.
  const html = renderToStaticMarkup(<DashboardView runId={runId} model={model} limitUse={{ state: "loading" }} />);
  // A card prints its figure in .stat-value, or, with no stored figure, the Not in this run chip in its place.
  const cards = [...html.matchAll(/<div class="stat"><div class="stat-label">([\s\S]*?)<\/div>(?:<div class="(stat-value[^"]*)"(?: title="([^"]*)")?>([\s\S]*?)<\/div>|<span class="(status status-unobs)">([\s\S]*?)<\/span>)<div class="(stat-note[^"]*)">([\s\S]*?)<\/div><\/div>/g)];
  expect(cards.map((m) => [text(m[1]!), m[2] ?? m[5], m[3] ?? null, text(m[4] ?? m[6]!), m[7], text(m[8]!)])).toEqual(
    exp.cards.map((c) => [c.label, c.absent ? "status status-unobs" : c.tone === "neg" ? "stat-value is-neg" : "stat-value", c.field, c.value, c.tone === "neg" ? "stat-note neg" : "stat-note", c.sub]),
  );
  const rows = tableIn(html, "By scenario");
  expect(rows.map(cellsOf)).toEqual(exp.rows.map((r) => [r.label, r.eve, r.deltaEve, r.nii12, r.nii24]));
  // The scenario id rides in the label cell's title.
  expect(rows.map((tr) => tdsOf(tr)[0]!.match(/title="([^"]*)"/)?.[1])).toEqual(exp.rows.map((r) => r.scenarioId));
  expect(rows.map((tr) => tdsOf(tr)[2]!.match(/class="([^"]*)"/)![1])).toEqual(exp.rows.map((r) => (r.deltaTone === null ? "num" : `num ${r.deltaTone}`)));
  expect(html).toContain(`Source: /api/runs/${runId}/result, fields eve.byScenario[].eve, .deltaEveVsBase, .deltaEvePct, nii.byScenario[].totalNet12, .totalNet24`);
}

// The two runs items 3 and 5 read; made once before the items, so no item depends on another having run.
let runA = "";
let runB = "";

describe("ALM Studio P1 acceptance", () => {
  beforeAll(async () => {
    const plan = (await api<RunPlan>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
    const withSteep: RunPlan = { ...plan, planId: "plan-synthetic-2500-v1-p1-stress", scenarios: [...plan.scenarios, { ref: "steepener-v1#STEEP100" }] };
    const a = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan, label: "p1 dashboard grid" });
    expect(a.status).toBe(202);
    expect((await finished(a.body.runId)).state).toBe("done");
    const b = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: withSteep, label: "p1 dashboard stress" });
    expect(b.status).toBe(202);
    expect((await finished(b.body.runId)).state).toBe("done");
    runA = a.body.runId;
    runB = b.body.runId;
  }, 700_000);

  it("item 1: the Section 5 map is the route table; every layer parses to itself; every old address forwards with its query kept", () => {
    const moduleLabel = (id: string) => MODULES.find((m) => m.id === id)!.label;
    expect(LAYERS.map((l) => [moduleLabel(l.module), l.area, l.label, l.status === "soon" ? l.soon!.piece : "live"])).toEqual(MAP);
    for (const l of LAYERS) {
      expect(l.id.split("/")).toHaveLength(3);
      expect(l.id.startsWith(`${l.module}/`)).toBe(true);
      // Re-expectation (Piece E1): an old layer address parses to a legacy route that keeps the address as typed.
      expect(parseHash(`#/${l.id}?book=b1&run=r1`), l.id).toEqual({ kind: "legacy", layer: l.id, query: { book: "b1", run: "r1" }, from: `#/${l.id}?book=b1&run=r1` });
    }
    for (const [from, to] of OLD) {
      const sep = from.includes("?") ? "&" : "?";
      const route = parseHash(`${from}${sep}book=b1&run=r1`);
      if (from === "#/") {
        // Re-expectation (Piece E1): the bare root is Workspace Home now, not the Dashboard.
        expect(route, from).toEqual({ kind: "home", query: { book: "b1", run: "r1" } });
        continue;
      }
      expect(route.kind, from).toBe("legacy");
      if (route.kind !== "legacy") continue;
      expect(`#/${route.layer}`, from).toBe(to);
      expect(route.query, from).toEqual({ book: "b1", run: "r1" });
    }
    // Re-expectation (Piece E1): an unknown path opens Workspace Home and says what it was.
    expect(parseHash("#/no/such/layer")).toEqual({ kind: "home", query: {}, unknown: "#/no/such/layer" });
  });

  it("item 2: every Soon layer renders its page with no digit other than its piece number", () => {
    const soon = MAP.filter((m) => m[3] !== "live");
    // Re-expectation: one Soon layer is left, Macro factors.
    // Re-expectation: Macro factors is live; no layer is Soon.
    expect(soon).toHaveLength(0);
    for (const [, , label, piece] of soon) {
      const layer = LAYERS.find((l) => l.label === label)!;
      const t2 = text(renderToStaticMarkup(<SoonPage layer={layer} />));
      expect(t2, label).toContain(label);
      expect(t2, label).toContain(`Piece ${piece}`);
      expect(t2.replace(`Piece ${piece}`, ""), label).not.toMatch(/\d/);
    }
  });

  it("item 3: the Dashboard prints, for each card and table cell, the stored field it names", async () => {
    expect(runA).not.toBe("");
    // The page reads the grid off the plan library; restated here.
    const grid = (await getPlanLibrary()).find((l) => l.id === "regulatory-grid-v1")!.scenarios.map((s) => s.id);
    expect(grid).toEqual(GRID);

    for (const [runId, exp] of [[runA, RUN_A], [runB, RUN_B]] as const) {
      // The page's own read: the run detail, then the stored envelope.
      const data = await loadResults(runId);
      expect(data.note).toBeNull();
      const result = data.result!;
      // The loaded envelope is the stored one, byte for byte through JSON.
      expect(result).toEqual((await api<RunResult>(t.base, "GET", `/api/runs/${runId}/result`)).body);
      expect(data.detail.scenarios.filter((s) => s.rateSpec.kind === "base").map((s) => s.id)).toEqual(["S0"]);
      tieToStored(result, exp);
      const model = dashboardModel(result, data.detail, grid);
      expect(model.cards).toEqual(exp.cards);
      expect(model.rows).toEqual(exp.rows);
      checkRendered(runId, model, exp);
    }
  });

  it("item 4: deposit decay shows demo-behavioral-v1 and stress-illustrative-v1 side by side with their stored values", async () => {
    // The page's own load: every stored set from the list route, each read whole.
    const sets = await Promise.all((await listAssumptionSets()).map((s) => getAssumptionSet(s.id)));
    const model = byKindModel(sets, ["nmd-decay"]);
    // vanilla-empty-v1 binds nothing, so it has no column.
    // Re-expectation (Studio Piece 7b slice 4): the two housing sets carry the demo deposit bindings, so each is a column holding the demo values.
    // Re-expectation: the two example-bank demo sets bind deposit decay on the bank's own families, so each is a column, "Not bound" on the demo book's.
    // Re-expectation: the three deposit desk sets that bind deposit decay (component decay, the credit, the scenario credit) are columns too, "Not bound" on the demo book's.
    expect(model.columns.map((c) => c.id)).toEqual(["decay-shock-demo-v1", "demo-behavioral-v1", "housing-demo-v1", "housing-flat-demo-v1", "liquidity-squeeze-demo-v1", "liquidity-stress-demo-v1", "loan-repricing-demo-v1", "quillfield-constant-prepay-v1", "quillfield-desk-component-decay-v1", "quillfield-desk-credit-v1", "quillfield-desk-scenario-credit-v1", "quillfield-illustrative-v1", "stress-illustrative-v1"]);
    // A model cell is a figure, a text leaf or an absence word (Polish 5 T1); a figure is read by its stored text, the
    // title, so the check still compares stored values and not their grouping.
    const cells = (familyId: string, path: string) =>
      model.rows.find((r) => r.familyId === familyId && r.selector === "whole family" && r.path === path)!.cells.map((c) => (c.kind === "figure" ? c.exact : c.text));
    expect(cells("dda", "params.closureSteady")).toEqual(["0.9375", "0.75", "0.75", "0.75", "5", "5", "0.75", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "1.5"]);
    expect(cells("dda", "params.maxRateDecay")).toEqual(["3.75", "3", "3", "3", "0", "0", "3", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "6"]);
    expect(cells("mma", "params.closureSteady")).toEqual(["Not bound", "Not bound", "Not bound", "Not bound", "10", "10", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound"]);
    // The literals are the stored leaves of the two sets the spec names.
    const leaf = (id: string, key: string) => {
      const set = sets.find((s) => s.id === id)!;
      const b = set.bindings.find((x) => x.familyId === "dda" && x.overlay.kind === "nmd-decay")!;
      return String((b.overlay as unknown as { params: Record<string, number> }).params[key]);
    };
    expect([leaf("demo-behavioral-v1", "closureSteady"), leaf("stress-illustrative-v1", "closureSteady")]).toEqual(["0.75", "1.5"]);
    expect([leaf("demo-behavioral-v1", "maxRateDecay"), leaf("stress-illustrative-v1", "maxRateDecay")]).toEqual(["3", "6"]);

    const html = renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={model} query={{}} />);
    const head = html.match(/<thead>([\s\S]*?)<\/thead>/)![1]!;
    expect([...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!))).toEqual(
      ["Family", "Selector", "Parameter", "decay-shock-demo-v1 Edit", "demo-behavioral-v1 Edit", "housing-demo-v1 Edit", "housing-flat-demo-v1 Edit", "liquidity-squeeze-demo-v1 Edit", "liquidity-stress-demo-v1 Edit", "loan-repricing-demo-v1 Edit", "quillfield-constant-prepay-v1 Edit", "quillfield-desk-component-decay-v1 Edit", "quillfield-desk-credit-v1 Edit", "quillfield-desk-scenario-credit-v1 Edit", "quillfield-illustrative-v1 Edit", "stress-illustrative-v1 Edit"]);
    const body = tableIn(html, "Parameters by set").map(cellsOf);
    expect(body).toContainEqual(["dda", "whole family", "params.closureSteady", "0.9375", "0.75", "0.75", "0.75", "5", "5", "0.75", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "1.5"]);
    expect(body).toContainEqual(["dda", "whole family", "params.maxRateDecay", "3.75", "3", "3", "3", "0", "0", "3", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "6"]);
    expect(body).toContainEqual(["mma", "whole family", "params.closureSteady", "Not bound", "Not bound", "Not bound", "Not bound", "10", "10", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound", "Not bound"]);
    expect(html).toContain("Stored parameters, nmd-decay");
    // Each column links to Edit a set for its set; the Workbench link is gone.
    expect(html).toContain('<a href="#/ws/ws-a/assumptions/sets?set=demo-behavioral-v1" aria-label="Edit demo-behavioral-v1">Edit</a>');
    expect(html).not.toContain("Workbench");
    expect(html).toContain("Source: /api/assumption-sets and /api/assumption-sets/:id bindings[].overlay");
  });

  it("item 5: each Govern page renders from its route on the seeded store", async () => {
    expect(runA).not.toBe("");
    // The catalog is the database mirror. Each run synced itself when it reached done (the run queue's terminal
    // hook), so both are on the catalog before any sync here and a whole-store sync ingests no run.
    const seen = (await api<Array<{ runId: string }>>(t.base, "GET", "/api/catalog/runs")).body.map((r) => r.runId);
    expect(seen).toEqual(expect.arrayContaining([runA, runB]));
    const db = openPlatformDb(defaultDbPath(t.storeRoot));
    try {
      expect(syncStoreToDb(t.platform.context.store, db).runsIngested).toEqual([]);
    } finally {
      db.close();
    }

    // Model inventory, from /api/catalog/plugins.
    const catalog = await getPluginCatalog();
    const inv = inventoryRows(catalog);
    expect(inv.find((r) => r.id === "alm-yield-curve")!.runs).toBe(true);
    expect(inv.find((r) => r.id === "alm-ftp")!.runs).toBe(false);
    const invRows = tableIn(renderToStaticMarkup(<InventoryView reply={catalog} />), "Model inventory");
    expect(invRows).toHaveLength(catalog.components.length);
    const invRow = (id: string) => cellsOf(invRows.find((tr) => tr.includes(`>${id}</span>`))!);
    // Four cells; the kind and the role are the Component cell's meta line, then the purpose (Polish 7 T2, Polish 8 T1);
    // the cell text reads each after its visually hidden Kind: or Role: label (Polish 9).
    expect(invRow("alm-yield-curve")).toEqual([
      "SOFR OIS zero curve alm-yield-curve Kind: curve · Role: methodology Bootstraps a zero curve from par swap quotes. ACT/360, annual fixed schedule, Brent root-finding, linear in zero.",
      "Runs", "MarketSnapshot", "ZeroCurve",
    ]);
    expect(invRow("alm-ftp")).toEqual([
      "Funds transfer pricing alm-ftp Kind: metric · Role: methodology Par-matched static-strip FTP: the IR component against SOFR, the all-in against SOFR plus TLP, and the liquidity-premium residual. Linear par match, no root finding.",
      "Catalog only", "Cashflow, ZeroCurve", "FtpResult",
    ]);
    expect(invRow("alm-ftp-stochastic")).toEqual([
      "Option-adjusted FTP alm-ftp-stochastic Kind: metric · Role: methodology Transfer pricing over Hull-White paths: the path-averaged par-coupon triple and OAS against a static Z-spread. This is what breaks the static-strip equality between FTP and EVE.",
      "Catalog only", "Cashflow, DiscountFactorPath", "FtpResult",
    ]);

    // Run audit log, from /api/catalog/runs, each opened row from its inputs route and its result provenance.
    const runs = await listCatalogRuns();
    const listed = (await api<CatalogRunListItem[]>(t.base, "GET", "/api/catalog/runs")).body;
    expect(runs).toEqual(listed);
    expect(auditRows(runs).map((r) => r.runId)).toEqual([runB, runA]);
    for (const [runId, label, planId] of [[runA, "p1 dashboard grid", "plan-synthetic-2500-v1"], [runB, "p1 dashboard stress", "plan-synthetic-2500-v1-p1-stress"]] as const) {
      const provenance = await getResultSection(runId, "provenance");
      const inputs = await getCatalogRunInputs(runId);
      expect(auditPlan({ kind: "read", provenance })).toBe(planId);
      const html = renderToStaticMarkup(<AuditView ws="ws-a" runs={runs} query={{}} open={runId} opened={{ inputs, plan: { kind: "read", provenance } }} />);
      const row = listed.find((r) => r.runId === runId)!;
      const logRows = tableIn(html, "Run audit log");
      expect(logRows.map((tr) => cellsOf(tr)[0])).toEqual([runB, runA]);
      const cells = cellsOf(logRows.find((tr) => tr.includes(`>${runId}</a>`))!);
      expect(cells).toEqual([runId, label, "done", row.submittedAt, row.endedAt, row.platformRequestHash, row.engineInputsHash, row.resultContentHash]);
      // The inputs hash the list carries is the engine's own inputsHash on the stored provenance.
      expect(row.engineInputsHash).toBe(provenance.inputsHash);
      expect(html).toContain(`Inputs of ${runId}`);
      expect(text(html.match(/<dt>Plan<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/)![1]!)).toBe(planId);
      const pinned = tableIn(html, "Run inputs").map(cellsOf);
      expect(pinned.map((c) => c.slice(0, 3))).toEqual([
        ["assumption-set", "assumption-sets", "demo-behavioral-v1"],
        ["market", "market", "market-public-2026-03-31"],
        ["portfolio", "portfolios", "synthetic-2500-v1"],
        ["scenario-slate", "scenario-slates", `plan-${planId}`],
      ]);
      expect(pinned.every((c) => /^[0-9a-f]{64}$/.test(c[3]!))).toBe(true);
      expect(html).toContain(`Source: /api/catalog/runs/${runId}/inputs; the plan from /api/runs/${runId}/result/provenance planId.`);
    }

    // Versions and lineage, from /api/catalog/lineage/assumption-sets/:id.
    const ids = (await listAssumptionSets()).map((s) => s.id);
    // Re-expectation (Studio Piece 7b slice 4): was seven; +2 for the two housing sets.
    // Re-expectation: +2 for the example bank's two feature demo sets.
    // Re-expectation: +5 for the deposit desk's sets.
    expect([...ids].sort()).toEqual(["decay-shock-demo-v1", "demo-behavioral-v1", "housing-demo-v1", "housing-flat-demo-v1", "liquidity-squeeze-demo-v1", "liquidity-stress-demo-v1", "loan-repricing-demo-v1", "quillfield-constant-prepay-v1", "quillfield-desk-component-decay-v1", "quillfield-desk-credit-v1", "quillfield-desk-full-beta-v1", "quillfield-desk-plain-v1", "quillfield-desk-scenario-credit-v1", "quillfield-illustrative-v1", "stress-illustrative-v1", "vanilla-empty-v1"]);
    const demo = await getCatalogLineage("assumption-sets", "demo-behavioral-v1");
    const demoPinned = (await getCatalogRunInputs(runA)).inputs.find((i) => i.id === "demo-behavioral-v1")!.contentHash;
    expect(demo.contentHash).toBe(demoPinned);
    const noop = () => undefined;
    const lin = renderToStaticMarkup(<LineageView lc="assumption-sets" ids={ids} lid="demo-behavioral-v1" lineage={demo} onPick={noop} />);
    expect([...lin.matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].map((m) => [m[1], text(m[2]!)]).slice(0, 4)).toEqual([
      ["portfolios", "Books"], ["market", "Market snapshots"], ["scenario-slates", "Scenario slates"], ["assumption-sets", "Assumption sets"],
    ]);
    expect(lin).toContain("Run plans are not a run-consumable collection, so the lineage route does not serve them.");
    expect(text(lin.match(/<dt>Content hash<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/)![1]!)).toBe(demoPinned);
    const consumed = tableIn(lin, "Lineage").map(cellsOf);
    expect(consumed).toEqual([runA, runB].map((id) => {
      const row = listed.find((r) => r.runId === id)!;
      return [id, "assumption-set", "done", row.submittedAt, demoPinned];
    }));
    expect(lin).toContain("Source: /api/catalog/lineage/assumption-sets/demo-behavioral-v1");

    // A set no run consumed says so.
    const stress = await getCatalogLineage("assumption-sets", "stress-illustrative-v1");
    expect(stress.consumedBy).toEqual([]);
    const none = renderToStaticMarkup(<LineageView lc="assumption-sets" ids={ids} lid="stress-illustrative-v1" lineage={stress} onPick={noop} />);
    expect(none).toContain("No run has consumed it.");
    expect(text(none.match(/<dt>Content hash<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/)![1]!)).toBe(stress.contentHash);
  }, 60_000);
});
