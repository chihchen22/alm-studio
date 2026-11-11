// apps/studio/src/__tests__/guidedBookVolumeReport.test.ts
/**
 * The guided Balance sheet tie check (spec point 4), the New volume projection (spec point 6) and the report builder's
 * choices (spec point 9). Inputs are small books and run results written here by hand; expected figures are worked by
 * hand (sums by side, a geometric path through a target, stored numbers summed by node), never read back from the code.
 */
import { describe, expect, it } from "vitest";
import type { InstrumentsFile, PortfolioSpec, RunResult } from "@alm/engine";
import { dateNote, inMillions, summarizeBook } from "../guided/book";
import { newRow, planOf, productProblems, productRowsFor, productsDirty, rowsFromPlan, templatesOf, toDollars, todaysRuleRow, volumeProblems, withRateType } from "../guided/volume";
import { buildReport, compareTables, distributionReading, normalizeChoice, optionsFor, reportCsv, type ReportChoice } from "../guided/report";

const COA = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "A", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "n-loan", label: "Loans", parentId: "A", side: "asset", isLeaf: true, familyId: "loan", order: 0 },
    { id: "n-sec", label: "Securities", parentId: "A", side: "asset", isLeaf: true, familyId: "sec", order: 1 },
    { id: "L", label: "Total Liabilities and Equity", parentId: null, side: "liability", isLeaf: false, order: 1 },
    { id: "n-dep", label: "Deposits", parentId: "L", side: "liability", isLeaf: true, familyId: "dep", order: 0 },
    { id: "n-eq", label: "Equity (plug)", parentId: "L", side: "equity", isLeaf: false, order: 1 },
  ],
  families: [
    { id: "loan", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "n-loan" },
    { id: "sec", label: "Securities", side: "asset", instrumentType: "fixed-loan", coaNodeId: "n-sec" },
    { id: "dep", label: "Deposits", side: "liability", instrumentType: "nmd", coaNodeId: "n-dep" },
  ],
};

function book(positions: Array<[string, string, number, string]>, coa: unknown = COA): PortfolioSpec {
  return { id: "b", label: "B", asOf: "2026-03-31", coa, positions: positions.map(([id, fam, notional, side]) => ({ id, familyId: fam, coaNodeId: `n-${fam}`, terms: { id, type: "fixed-loan", notional, side } })) } as unknown as PortfolioSpec;
}

describe("the balance sheet tie check", () => {
  it("assets 300M, liabilities 250M: equity is the 50M plug and the book ties", () => {
    const s = summarizeBook(book([["l1", "loan", 200_000_000, "asset"], ["s1", "sec", 100_000_000, "asset"], ["d1", "dep", 250_000_000, "liability"]]));
    expect([s.assets, s.liabilities, s.plug, s.positionCount]).toEqual([300_000_000, 250_000_000, 50_000_000, 3]);
    expect(s.tie.ok).toBe(true);
    expect(s.tie.sentence).toBe("Assets $300.0 million = liabilities $250.0 million + equity $50.0 million. Equity is the plug: assets less liabilities.");
    expect(s.families.map((f) => [f.label, f.positions, f.notional])).toEqual([["Loans", 1, 200_000_000], ["Securities", 1, 100_000_000], ["Deposits", 1, 250_000_000]]);
  });
  it("liabilities above assets: negative equity is flagged", () => {
    const s = summarizeBook(book([["l1", "loan", 100_000_000, "asset"], ["d1", "dep", 130_000_000, "liability"]]));
    expect(s.tie.ok).toBe(false);
    expect(s.tie.sentence).toMatch(/^Liabilities and equity exceed assets by \$30\.0 million/);
  });
  it("a surplus with no equity node to hold it is flagged", () => {
    const noEquity = { ...COA, nodes: COA.nodes.filter((n) => n.side !== "equity") };
    const s = summarizeBook(book([["l1", "loan", 100_000_000, "asset"], ["d1", "dep", 90_000_000, "liability"]], noEquity));
    expect(s.tie.ok).toBe(false);
    expect(s.tie.sentence).toMatch(/no equity node/);
  });
  it("a position on the other side from its family fails the check, whatever the plug absorbs (fix round 1, L7)", () => {
    // By hand: the loan family is an asset family, and l2 says liability.
    const s = summarizeBook(book([["l1", "loan", 200_000_000, "asset"], ["l2", "loan", 10_000_000, "liability"], ["d1", "dep", 150_000_000, "liability"]]));
    expect(s.sideMismatches).toEqual(["l2"]);
    expect(s.tie.ok).toBe(false);
    expect(s.tie.sentence).toBe("One position is on the other side from its family (l2), so the totals by side cannot be trusted. Check the side column.");
  });
  it("names a date difference and stays quiet on a match", () => {
    expect(dateNote("2026-03-31", "2026-03-31")).toBeNull();
    expect(dateNote("2026-03-31", "2026-10-31")).toMatch(/^The positions are dated 2026-03-31 and the workspace 2026-10-31\./);
    expect(inMillions(-1_250_000)).toBe("-$1.3 million");
  });
});

describe("new volume", () => {
  // Opening balances are dollars (the sum of the positions); a typed target is millions of dollars (fix round 1, L13).
  // The target path and the growth rate are drawn from the server's preview (the engine's rule); S2b-1 removed the
  // Studio's own copy of the steady-rate rule, so nothing here computes a path.
  const row = newRow("loan", "Loans", 100_000_000);
  it("reads millions to whole cents", () => {
    expect(toDollars(150)).toBe(150_000_000);
    expect(toDollars(1.25)).toBe(1_250_000);
    expect(toDollars(0.1)).toBe(100_000);
  });
  it("names each problem with the family", () => {
    expect(volumeProblems([{ ...row, kind: "grow", balance: "0", month: "400" }])).toEqual([
      "Loans: type the target balance in millions of dollars, above zero.",
      "Loans: type the month as a whole number from 1 to 360.",
    ]);
    expect(volumeProblems([row])).toEqual([]);
  });
  it("saves holds and grows as a balance plan in dollars, priced by each family's product; run-off families are left out", () => {
    const rows = [{ ...row, kind: "hold" as const }, { ...newRow("dep", "Deposits", 250_000_000), kind: "grow" as const, balance: "300", month: "12" }, newRow("sec", "Securities", 80_000_000)];
    const products = [
      { ...todaysRuleRow("loan", "Loans"), rateType: "floating" as const, indexTenor: "3", termMonths: "36", spreadBp: "175" },
      todaysRuleRow("dep", "Deposits", 60, -50),
    ];
    const plan = planOf({ id: "bp-g-1", label: "Targets", asOf: "2026-03-31" }, rows, products);
    expect(plan).toEqual({
      schemaVersion: "1.0.0", id: "bp-g-1", label: "Targets", asOf: "2026-03-31", unlistedFamilies: "runoff",
      targets: [
        { familyId: "loan", path: [{ month: 1, balance: 100_000_000 }], newBusinessPricing: { spreadOverIndexBp: 175, termMonths: 36 } },
        { familyId: "dep", path: [{ month: 12, balance: 300_000_000 }], newBusinessPricing: { spreadOverIndexBp: -50, termMonths: 60 } },
      ],
    });
    const back = rowsFromPlan([newRow("loan", "Loans", 100_000_000), newRow("dep", "Deposits", 250_000_000), newRow("sec", "Securities", 80_000_000)], plan);
    expect(back.map((r) => [r.familyId, r.kind, r.balance, r.month])).toEqual([["loan", "hold", "", ""], ["dep", "grow", "300", "12"], ["sec", "runoff", "", ""]]);
  });
});

describe("Not saved yet after a save (fix round M1)", () => {
  const fams = [
    { familyId: "loan", label: "Loans", suggested: { template: { rateType: "floating" as const, amortization: "level-pay" as const, indexTenorMonths: 1 }, termMonths: 36, basis: "Floating like the family's positions." } },
    { familyId: "dep", label: "Deposits", suggested: null },
  ];
  it("rows saved as they stand read as saved once the setup holds them, although their descriptive text changes", () => {
    const before = productRowsFor(fams, null, null);
    const edited = before.map((r) => (r.familyId === "loan" ? { ...r, indexTenor: "3", spreadBp: "175" } : r));
    const setup = { nii: { enabled: true, horizonMonths: 60, reportHorizons: [12], basis: { kind: "flat" as const, termMonths: 60, spreadOverIndexBp: 0 }, path: "single" as const, templates: templatesOf(edited) } };
    const after = productRowsFor(fams, setup, null);
    // The old comparison (the rows' whole JSON) still differs, on the origin text: it read "Not saved yet" for good.
    expect(JSON.stringify(edited)).not.toBe(JSON.stringify(after));
    expect(productsDirty(edited, after)).toBe(false);
    // A real edit after the save reads as not saved.
    expect(productsDirty(edited.map((r) => (r.familyId === "dep" ? { ...r, termMonths: "48" } : r)), after)).toBe(true);
  });
});

describe("new-volume products", () => {
  const fams = [
    { familyId: "loan", label: "Loans", suggested: { template: { rateType: "fixed" as const, amortization: "level-pay" as const, indexTenorMonths: 72, fixedIndex: "matched" as const }, termMonths: 72, basis: "Fixed rate, level payment." } },
    { familyId: "dep", label: "Deposits", suggested: null },
  ];
  it("a new analysis opens on each family's own product, today's rule where there is none", () => {
    const rows = productRowsFor(fams, null, null);
    expect(rows.map((r) => [r.familyId, r.rateType, r.amortization, r.termMonths, r.indexTenor, r.spreadBp])).toEqual([
      ["loan", "fixed", "level-pay", "72", "matched", "0"],
      ["dep", "fixed", "bullet", "60", "term", "0"],
    ]);
    // A fixed loan opens on its matched funding rate (fix round M3); the deposit keeps today's swap-priced bullet.
    expect(templatesOf(rows)).toEqual([
      { familyId: "loan", rateType: "fixed", amortization: "level-pay", indexTenorMonths: 72, fixedIndex: "matched", termMonths: 72, spreadOverIndexBp: 0 },
      { familyId: "dep", rateType: "fixed", amortization: "bullet", indexTenorMonths: 60, fixedIndex: "swap", termMonths: 60, spreadOverIndexBp: 0 },
    ]);
  });
  it("a stored analysis with no products keeps today's rule at its basis term and spread; nothing is chosen for it", () => {
    const setup = { nii: { enabled: true, horizonMonths: 60, reportHorizons: [12], basis: { kind: "flat" as const, termMonths: 60, spreadOverIndexBp: 0 }, path: "single" as const } };
    expect(productRowsFor(fams, setup, null).map((r) => [r.rateType, r.amortization, r.termMonths])).toEqual([["fixed", "bullet", "60"], ["fixed", "bullet", "60"]]);
  });
  it("reads a saved product back, and switching to floating starts on the one-month index", () => {
    const setup = { nii: { enabled: true, horizonMonths: 60, reportHorizons: [12], basis: { kind: "flat" as const, termMonths: 60, spreadOverIndexBp: 0 }, path: "single" as const, templates: [{ familyId: "loan", rateType: "floating" as const, amortization: "linear" as const, indexTenorMonths: 6, termMonths: 48, spreadOverIndexBp: 125 }] } };
    const [loan] = productRowsFor(fams, setup, null);
    expect([loan!.rateType, loan!.amortization, loan!.indexTenor, loan!.termMonths, loan!.spreadBp]).toEqual(["floating", "linear", "6", "48", "125"]);
    expect(withRateType(todaysRuleRow("x", "X"), "floating").indexTenor).toBe("1");
    expect(withRateType(withRateType(todaysRuleRow("x", "X"), "floating"), "fixed").indexTenor).toBe("matched");
  });
  it("names each product problem with the family, by the engine's own rule", () => {
    expect(productProblems([{ ...todaysRuleRow("loan", "Loans"), termMonths: "x" }])).toEqual(["Loans: type the term in whole months."]);
    expect(productProblems([{ ...todaysRuleRow("loan", "Loans"), rateType: "floating", indexTenor: "12", termMonths: "6" }])[0]).toMatch(/^Loans: the index tenor \(12 months\) of a floating template is longer than its term/);
    expect(productProblems([todaysRuleRow("loan", "Loans")])).toEqual([]);
  });
});

// A two-scenario run result for the book above, every number typed by hand.
const RESULT = {
  nii: {
    horizonsMonths: [12, 24],
    byScenario: [
      {
        scenarioId: "S0", totalNet12: 30, totalNet24: 58, totalNetByHorizon: { "12": 30, "24": 58 }, netMonthly: [3, 2, 1],
        byFamily: [
          { familyId: "loan", byHorizon: { "12": { net: 20 }, "24": { net: 40 } }, netMonthly: [2, 1, 1] },
          { familyId: "sec", byHorizon: { "12": { net: 15 }, "24": { net: 28 } }, netMonthly: [1, 1, 1] },
          { familyId: "dep", byHorizon: { "12": { net: -5 }, "24": { net: -10 } }, netMonthly: [0, 0, -1] },
        ],
      },
      {
        scenarioId: "S100", totalNet12: 33, totalNet24: 60, totalNetByHorizon: { "12": 33, "24": 60 }, netMonthly: [4, 2, 1],
        byFamily: [
          { familyId: "loan", byHorizon: { "12": { net: 22 }, "24": { net: 41 } }, netMonthly: [3, 1, 1] },
          { familyId: "sec", byHorizon: { "12": { net: 16 }, "24": { net: 30 } }, netMonthly: [1, 1, 1] },
          { familyId: "dep", byHorizon: { "12": { net: -5 }, "24": { net: -11 } }, netMonthly: [0, 0, -1] },
        ],
      },
    ],
  },
  eve: {
    byScenario: [
      { scenarioId: "S0", pvAssets: 310, pvLiabilities: 240, eve: 70, deltaEveVsBase: 0, byFamily: [{ familyId: "loan", pv: 205 }, { familyId: "sec", pv: 105 }, { familyId: "dep", pv: 240 }] },
      { scenarioId: "S100", pvAssets: 300, pvLiabilities: 236, eve: 64, deltaEveVsBase: -6, byFamily: [{ familyId: "loan", pv: 198 }, { familyId: "sec", pv: 102 }, { familyId: "dep", pv: 236 }] },
    ],
  },
  gap: {
    repricing: [
      { kind: "repricing", scenarioId: "S0", rows: [{ band: { label: "0-1M" }, gap: 10 }, { band: { label: "1-3M" }, gap: -4 }], byCoaNode: [{ coaNodeId: "A", rows: [{ band: { label: "0-1M" }, gap: 12 }, { band: { label: "1-3M" }, gap: 1 }] }] },
      { kind: "repricing", scenarioId: "S100", rows: [{ band: { label: "0-1M" }, gap: 11 }, { band: { label: "1-3M" }, gap: -3 }] },
    ],
    liquidity: [],
  },
} as unknown as RunResult;

const BOOK3 = book([["l1", "loan", 200, "asset"], ["s1", "sec", 100, "asset"], ["d1", "dep", 250, "liability"]]);
const choice = (c: Partial<ReportChoice>): ReportChoice => ({ metric: "nii", scenarios: ["S0", "S100"], horizon: 12, granularity: "horizon", grouping: "family", focus: "", ...c });

describe("the report builder", () => {
  it("offers the groupings each metric has; quarterly and annual roll-ups on flows and the gap, never on value", () => {
    expect(optionsFor("nii")).toEqual({ granularities: ["horizon", "monthly", "quarterly", "annual"], groupings: ["total", "family", "account", "position", "tag"] });
    expect(optionsFor("repricing")).toEqual({ granularities: ["buckets", "monthly", "quarterly", "annual"], groupings: ["total", "account", "tag"] });
    expect(JSON.stringify([optionsFor("eve"), optionsFor("ftp")])).not.toMatch(/quarter|annual/);
    expect(optionsFor("balance")).toEqual({ granularities: ["quarterly", "annual"], groupings: ["family", "tag"] });
    expect(normalizeChoice(choice({ metric: "repricing", grouping: "family", granularity: "horizon", horizon: 60 }), RESULT)).toMatchObject({ grouping: "total", granularity: "buckets", horizon: 12 });
  });
  it("NII by family at 24 months reads the stored family figures, and the book total", () => {
    const t = buildReport(RESULT, BOOK3, choice({ horizon: 24 }));
    expect(t.columns).toEqual(["S0", "S100"]);
    expect(t.rows).toEqual([{ label: "Loans", values: [40, 41] }, { label: "Securities", values: [28, 30] }, { label: "Deposits", values: [-10, -11] }]);
    expect(t.total).toEqual({ label: "Whole balance sheet", values: [58, 60] });
  });
  it("NII by account node sums its families: assets 20 + 15 = 35 and 22 + 16 = 38", () => {
    const t = buildReport(RESULT, BOOK3, choice({ grouping: "account" }));
    expect(t.rows).toEqual([{ label: "Total Assets", values: [35, 38] }, { label: "Total Liabilities and Equity", values: [-5, -5] }]);
    expect(t.notes[0]).toMatch(/sum of its families/);
  });
  it("monthly NII for one family over the horizon, with the months summed", () => {
    const t = buildReport(RESULT, { ...BOOK3 }, choice({ granularity: "monthly", horizon: 12, focus: "loan" }));
    expect(t.rows.slice(0, 3)).toEqual([{ label: "Month 1", values: [2, 3] }, { label: "Month 2", values: [1, 1] }, { label: "Month 3", values: [1, 1] }]);
    expect(t.rows[3]!.values).toEqual([null, null]);
    expect(t.total!.values).toEqual([null, null]);
  });
  it("EVE for the whole book reads assets, liabilities and the change from the base", () => {
    const t = buildReport(RESULT, BOOK3, choice({ metric: "eve", grouping: "total", scenarios: ["S100"] }));
    expect(t.rows.map((r) => [r.label, r.values[0]])).toEqual([["Present value of assets", 300], ["Present value of liabilities", 236], ["Change from the base", -6]]);
    expect(t.total!.values).toEqual([64]);
  });
  it("the repricing gap by bucket, and by account node from the stored node ladder", () => {
    const t = buildReport(RESULT, BOOK3, choice({ metric: "repricing", granularity: "buckets", grouping: "total" }));
    expect(t.rows).toEqual([{ label: "0-1M", values: [10, 11] }, { label: "1-3M", values: [-4, -3] }]);
    expect(t.total!.values).toEqual([6, 8]);
    const n = buildReport(RESULT, BOOK3, choice({ metric: "repricing", granularity: "buckets", grouping: "account" }));
    expect(n.rows).toEqual([{ label: "Total Assets, 0-1M", values: [12, null] }, { label: "Total Assets, 1-3M", values: [1, null] }]);
  });
  it("monthly gap buckets the run did not store, and per-position results it did not store, are refused in words", () => {
    expect(() => buildReport(RESULT, BOOK3, choice({ metric: "repricing", granularity: "monthly", grouping: "total" }))).toThrow(/monthly buckets are not stored/);
    expect(() => buildReport(RESULT, BOOK3, choice({ grouping: "position" }))).toThrow(/per-position results are not stored/);
  });
  it("per-position NII reads the stored 12-month figure, and says so for another horizon", () => {
    const inst = { positions: [{ positionId: "l1", side: "asset", byScenario: [{ scenarioId: "S0", nii12: 20, pv: 205 }, { scenarioId: "S100", nii12: 22, pv: 198 }] }] } as unknown as InstrumentsFile;
    const t = buildReport(RESULT, BOOK3, choice({ grouping: "position", horizon: 24 }), inst);
    expect(t.rows[0]).toEqual({ label: "l1", values: [20, 22] });
    expect(t.notes[0]).toMatch(/first 12 months/);
  });
  it("present value by position says in one line that an older file's balances held at book read 0 (Spec P1, K1)", () => {
    const rows = (version: string) => ({ schemaVersion: version, positions: [
      { positionId: "l1", side: "asset", type: "fixed-loan", byScenario: [{ scenarioId: "S0", pv: 205 }, { scenarioId: "S100", pv: 198 }] },
      { positionId: "c1", side: "asset", type: "non-rate-sensitive", byScenario: [{ scenarioId: "S0", pv: 0 }, { scenarioId: "S100", pv: 0 }] },
    ] }) as unknown as InstrumentsFile;
    const older = buildReport(RESULT, BOOK3, choice({ metric: "eve", grouping: "position" }), rows("1.0.0"));
    expect(older.title).toBe("Present value by position");
    expect(older.notes.filter((n) => n.startsWith("This results file was made before balances held at book were valued at par")).length).toBe(1);
    const current = buildReport(RESULT, BOOK3, choice({ metric: "eve", grouping: "position" }), rows("1.1.0"));
    expect(current.notes.some((n) => n.includes("valued at par"))).toBe(false);
  });
  it("per-position NII reconciles to the whole book with a new-volume line (fix round 1, M3)", () => {
    // By hand: positions S0 20 + 15 - 8 = 27 against the stored whole book 30, so new volume 3; S100 22 + 16 - 8 = 30
    // against 33, so 3. The total row is the stored whole-book figure, 30 and 33.
    const inst = { positions: [
      { positionId: "l1", side: "asset", byScenario: [{ scenarioId: "S0", nii12: 20 }, { scenarioId: "S100", nii12: 22 }] },
      { positionId: "s1", side: "asset", byScenario: [{ scenarioId: "S0", nii12: 15 }, { scenarioId: "S100", nii12: 16 }] },
      { positionId: "d1", side: "liability", byScenario: [{ scenarioId: "S0", nii12: -8 }, { scenarioId: "S100", nii12: -8 }] },
    ] } as unknown as InstrumentsFile;
    const t = buildReport(RESULT, BOOK3, choice({ grouping: "position", horizon: 12 }), inst);
    expect(t.rows).toEqual([
      { label: "l1", values: [20, 22] },
      { label: "s1", values: [15, 16] },
      { label: "d1", values: [-8, -8] },
      { label: "New volume (not split by position)", values: [3, 3] },
    ]);
    expect(t.total).toEqual({ label: "Whole balance sheet", values: [30, 33] });
    expect(t.notes.some((n) => n.startsWith("Each position carries only its own cash flows."))).toBe(true);
    // Positions that already add up to the whole book get no extra line.
    const exact = { positions: [{ positionId: "all", side: "asset", byScenario: [{ scenarioId: "S0", nii12: 30 }, { scenarioId: "S100", nii12: 33 }] }] } as unknown as InstrumentsFile;
    expect(buildReport(RESULT, BOOK3, choice({ grouping: "position", horizon: 12 }), exact).rows.map((r) => r.label)).toEqual(["all"]);
  });
  it("compares two runs on one scenario with B less A labelled derived, and exports full precision", () => {
    const a = buildReport(RESULT, BOOK3, choice({ grouping: "total" }));
    const b = { ...a, total: { label: "Whole balance sheet", values: [30.125, 33.5] } };
    const c = compareTables(a, b, "S100");
    expect(c.columns).toEqual(["Run A", "Run B", "B less A (derived)"]);
    expect(c.rows).toEqual([{ label: "Whole balance sheet", values: [33, 33.5, 0.5] }]);
    const csv = reportCsv(b, "run-1");
    expect(csv).toContain("Whole balance sheet,30.125,33.5");
    expect(csv.split("\n")[1]).toBe("# run run-1");
  });
});

describe("a stochastic run in plain figures", () => {
  it("reads the stored mean and the 5th, 50th and 95th percentiles, and says none when a row is absent", () => {
    const rows = [{ stat: "mean", p: null, value: 10 }, { stat: "quantile", p: 0.05, value: 7 }, { stat: "quantile", p: 0.5, value: 9.5 }, { stat: "quantile", p: 0.95, value: 13 }, { stat: "quantile", p: 0.25, value: 8 }];
    expect(distributionReading(rows)).toEqual({ mean: 10, p5: 7, p50: 9.5, p95: 13 });
    expect(distributionReading([])).toEqual({ mean: null, p5: null, p50: null, p95: null });
  });
});
