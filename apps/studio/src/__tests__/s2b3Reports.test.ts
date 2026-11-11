/**
 * The guided Reports step's quarterly and annual tables, the tag report on every pivot measure,
 * and the Advanced setup editor's views. Every expected figure is worked by hand from the inputs below.
 */
import { describe, expect, it } from "vitest";
import type { PivotResult, PortfolioSpec, RunResult } from "@alm/engine";
import type { RunSetup } from "@alm/reader";
import { buildReport, metricsFor, NEW_VOLUME_TAG_NOTE, optionsFor, reportCsv, tagMeasuresOn, tagTable, type ReportChoice } from "../guided/report";
import { nextSetupViewId, withoutSetupView, withSetupView } from "../rows/setupRows";

const BOOK = {
  coa: {
    nodes: [{ id: "a", label: "Assets", parentId: null, isLeaf: false }, { id: "l", label: "Liabilities", parentId: null, isLeaf: false }],
    families: [{ id: "loans", label: "Loans", side: "asset", coaNodeId: "a" }, { id: "deps", label: "Deposits", side: "liability", coaNodeId: "l" }],
  },
  positions: [],
} as unknown as PortfolioSpec;

const months = 6;
const loanInt = [10, 20, 30, 40, 50, 60];
const depInt = [1, 2, 3, 4, 5, 6];
const RESULT = {
  schemaVersion: "1.13.0",
  cashflows: {
    grid: { horizonMonths: months, asOf: "2026-02-28" },
    byScenario: [{ scenarioId: "S0", byFamily: [
      { familyId: "loans", series: { interest: loanInt, balance: [600, 500, 400, 300, 200, 100], principal: [100, 100, 100, 100, 100, 100] } },
      { familyId: "deps", series: { interest: depInt, balance: [300, 300, 300, 300, 300, 300], principal: [0, 0, 0, 0, 0, 0] } },
    ] }],
  },
  nii: { horizonsMonths: [6], byScenario: [{ scenarioId: "S0", netMonthly: loanInt.map((v, i) => v - depInt[i]!), byFamily: [], newBusiness: [{ familyId: "loans", originations: [0, 1, 2, 3, 4, 5], netMonthly: [0, 0.1, 0.2, 0.3, 0.4, 0.5] }] }] },
  eve: { byScenario: [] },
  gap: {
    repricing: [{ scenarioId: "S0", rows: [], byCoaNode: [], userBuckets: { kind: "monthly", rows: [5, -2, 1, 7, 0, -3].map((g, i, all) => ({ band: { label: `M${i + 1}`, startMonth: i, endMonth: i + 1 }, assets: Math.max(g, 0), liabilities: Math.max(-g, 0), gap: g, cumulativeGap: all.slice(0, i + 1).reduce((a, b) => a + b, 0) })) } }],
    liquidity: [{ scenarioId: "S0", rows: [], byCoaNode: [] }],
  },
} as unknown as RunResult;

const choice = (c: Partial<ReportChoice>): ReportChoice => ({ metric: "nii", scenarios: ["S0"], horizon: 6, granularity: "quarterly", grouping: "family", focus: "", ...c });

describe("quarterly and annual reports", () => {
  it("offers roll-ups on NII, new volume, the gap and balances, never on value or FTP", () => {
    expect(optionsFor("nii").granularities).toContain("quarterly");
    expect(optionsFor("eve").granularities).toEqual(["horizon"]);
    expect(optionsFor("ftp").granularities).toEqual(["horizon"]);
  });

  it("NII by quarter: (10+20+30) - (1+2+3) = 54 and (40+50+60) - (4+5+6) = 135; one family's own net", () => {
    const t = buildReport(RESULT, BOOK, choice({}));
    expect(t.rowHead).toBe("Quarter");
    expect(t.rows).toEqual([{ label: "Quarter 1", values: [54] }, { label: "Quarter 2", values: [135] }]);
    expect(t.total).toEqual({ label: "Total, 6 months", values: [189] });
    expect(buildReport(RESULT, BOOK, choice({ focus: "deps" })).rows.map((r) => r.values[0])).toEqual([-6, -15]);
  });

  it("calendar quarters from 28 February: March alone, April to June, then July and August as a stub", () => {
    const t = buildReport(RESULT, BOOK, choice({ alignment: "calendar" }));
    expect(t.rows.map((r) => r.label)).toEqual(["2026 Q1 (partial, 1 of 3 months)", "2026 Q2", "2026 Q3 (partial, 2 of 3 months)"]);
    expect(t.rows.map((r) => r.values[0])).toEqual([9, 18 + 27 + 36, 45 + 54]);
  });

  it("balances and yield by quarter: end 300 and blank, average 500 and 200, yield 60/1500 x 12 and 150/600 x 12", () => {
    const t = buildReport(RESULT, BOOK, choice({ metric: "balance", focus: "loans" }));
    expect(t.rows.map((r) => [r.label, r.values[0]])).toEqual([
      ["Quarter 1: balance at the end", 300],
      ["Quarter 1: average balance", 500],
      ["Quarter 1: yield, annualised", (60 / 1500) * 12],
      ["Quarter 2: balance at the end", null],
      ["Quarter 2: average balance", 200],
      ["Quarter 2: yield, annualised", (150 / 600) * 12],
    ]);
    expect(t.rowUnits).toEqual(["usd", "usd", "rate", "usd", "usd", "rate"]);
  });

  it("the quarterly gap sums three monthly bands (5 - 2 + 1 = 4, 7 + 0 - 3 = 4), cumulative at the end 4 and 8", () => {
    const t = buildReport(RESULT, BOOK, choice({ metric: "repricing", grouping: "total" }));
    expect(t.rows.map((r) => [r.label, r.values[0]])).toEqual([["Quarter 1: gap", 4], ["Quarter 1: cumulative gap at the end", 4], ["Quarter 2: gap", 4], ["Quarter 2: cumulative gap at the end", 8]]);
    expect(t.total!.values).toEqual([8]);
  });

  it("new volume by quarter: made k = 1 .. 3 is 1 + 2 + 3 and k = 4 .. 6 is 4 + 5", () => {
    const t = buildReport(RESULT, BOOK, choice({ metric: "newvolume", grouping: "total" }));
    expect(t.rows.find((r) => r.label === "Quarter 1: made")!.values).toEqual([6]);
    expect(t.rows.find((r) => r.label === "Quarter 2: made")!.values).toEqual([9]);
    expect(t.rows.find((r) => r.label === "Quarter 1: net interest income")!.values[0]).toBeCloseTo(0.3, 12);
  });
});

describe("the tag report on every pivot measure", () => {
  const pv = (metric: string, rows: PivotResult["rows"], bands?: PivotResult["bands"]): PivotResult[] => [{ viewId: "by-region", metric, scenarioId: "S0", groupBy: ["region"], rows, ...(bands ? { bands } : {}) } as PivotResult];
  const row = (region: string, extra: Partial<PivotResult["rows"][number]>) => ({ key: { region }, cellIds: [], positionCount: 1, ...extra });

  it("sums a flow over the horizon and reads a balance at the cut-off, with an all-positions total", () => {
    const flow = tagTable(pv("interest", [row("east", { series: [1, 2, 3, 4] }), row("west", { series: [10, 20, 30, 40] })]), "interest", "region", { months: 3, granularity: "horizon", asOf: "2026-03-31" });
    expect(flow.rows).toEqual([{ label: "east", values: [6] }, { label: "west", values: [60] }]);
    expect(flow.total!.values).toEqual([66]);
    const bal = tagTable(pv("balance", [row("east", { series: [100, 90, 80, 70] })]), "balance", "region", { months: 3, granularity: "horizon", asOf: "2026-03-31" });
    expect(bal.rows[0]!.values).toEqual([100]);
  });

  it("rolls a tag's series by quarter, shows each tag's bands, and reads NII at 12 or 24 months", () => {
    const q = tagTable(pv("principal", [row("east", { series: [1, 2, 3, 4, 5, 6] })]), "principal", "region", { months: 6, granularity: "quarterly", asOf: "2026-03-31" });
    expect(q.rows).toEqual([{ label: "east, Quarter 1", values: [6] }, { label: "east, Quarter 2", values: [15] }]);
    const g = tagTable(pv("repricing", [row("east", { series: [3, -1] })], [{ label: "0-1M", startMonth: 0, endMonth: 1 }, { label: "1-3M", startMonth: 1, endMonth: 3 }]), "repricing", "region", { months: 12, granularity: "horizon", asOf: "2026-03-31" });
    expect(g.rows).toEqual([{ label: "east, 0-1M", values: [3] }, { label: "east, 1-3M", values: [-1] }]);
    const nii = [row("east", { nii: { net12: 5, net24: 9, interestIncome12: 6, interestExpense12: 1 } })];
    expect(tagTable(pv("nii", nii), "nii", "region", { months: 12, granularity: "horizon", asOf: "x" }).rows[0]!.values).toEqual([5]);
    expect(tagTable(pv("nii", nii), "nii", "region", { months: 24, granularity: "horizon", asOf: "x" }).rows[0]!.values).toEqual([9]);
  });
});

describe("fix round lows on the report builder", () => {
  it("L2: the quarterly gap rolls over the chosen horizon only (3 of the 6 stored months: one quarter)", () => {
    const r3 = { ...RESULT, nii: { ...RESULT.nii, horizonsMonths: [3, 6] } } as unknown as RunResult;
    const t = buildReport(r3, BOOK, choice({ metric: "repricing", grouping: "total", horizon: 3 }));
    expect(t.rows.map((r) => [r.label, r.values[0]])).toEqual([["Quarter 1: gap", 4], ["Quarter 1: cumulative gap at the end", 4]]);
  });
  it("L5: Balances and rates is offered only on a run that stored its monthly net interest income", () => {
    expect(metricsFor(RESULT)).toContain("balance");
    const old = { ...RESULT, nii: { ...RESULT.nii, byScenario: RESULT.nii.byScenario.map((x) => ({ ...x, netMonthly: undefined })) } } as unknown as RunResult;
    expect(metricsFor(old)).not.toContain("balance");
  });
  it("L3: a text cell a spreadsheet would read as a formula is prefixed with a quote; numbers are not", () => {
    const csv = reportCsv({ title: "t", rowHead: "Tag", columns: ["S0"], rows: [{ label: "=cmd|' /C calc'!A0", values: [-5] }, { label: "@x", values: [1] }], total: null, unit: "usd", notes: [] }, "run");
    expect(csv.split("\n").slice(3, 5)).toEqual(["'=cmd|' /C calc'!A0,-5", "'@x,1"]);
  });
});

describe("tag measures on a run with new volume (fix round M1)", () => {
  const run = (cells: boolean[]) => ({ cashflows: { byScenario: cells.map((c, i) => ({ scenarioId: `S${i}`, byFamily: [], ...(c ? { byCell: [] } : {}) })) } }) as unknown as RunResult;
  it("offers all seven measures when every chosen scenario stored its cells", () => {
    expect(tagMeasuresOn(run([true, true]), ["S0", "S1"])).toEqual({ measures: ["balance", "principal", "interest", "repricing", "gapPrincipal", "nii", "evePv"], note: null });
  });
  it("offers value and the two gap ladders only, with the sentence why, when a chosen scenario made new volume", () => {
    expect(tagMeasuresOn(run([true, false]), ["S0", "S1"])).toEqual({ measures: ["repricing", "gapPrincipal", "evePv"], note: NEW_VOLUME_TAG_NOTE });
    expect(tagMeasuresOn(run([true, false]), ["S0"]).note).toBeNull();
    expect(NEW_VOLUME_TAG_NOTE).toBe("On a run with new volume, balances, cash flows and net interest income are not reported by tag: new volume belongs to its family, not to a tag, so the run stores those figures by family only. Value and the gap ladders by tag are offered.");
  });
});

describe("the Advanced setup editor's views", () => {
  const setup = { plan: { label: "x" } } as unknown as RunSetup;
  it("adds a view by two tags with the next free id, and removing the last one gives the document back", () => {
    const one = withSetupView(setup, " By region and segment ", ["region", "segment"]);
    expect(one.plan.views).toEqual([{ id: "view-1", label: "By region and segment", groupBy: ["region", "segment"] }]);
    expect(nextSetupViewId(one)).toBe("view-2");
    expect(withoutSetupView(one, "view-1")).toEqual(setup);
    expect(() => withSetupView(setup, "", ["region"])).toThrow("label");
    expect(() => withSetupView(setup, "x", ["region", "region"])).toThrow("each once");
  });
});
