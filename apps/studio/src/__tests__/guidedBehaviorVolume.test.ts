/**
 * The guided New volume rows with behavior, the two opt-in views on the setup, and the
 * Reports step's going-concern and forecast rows. Every number in the stored result below is typed by hand; the report
 * reads stored numbers and recomputes none.
 */
import { describe, expect, it } from "vitest";
import type { PortfolioSpec, RunResult } from "@alm/engine";
import { guidedSetupBody, newVolumeViewsOf, withHorizon, withNewVolumeViews } from "../guided/setup";
import { buildReport, goingConcernDifference, metricsFor, productText, type ReportChoice } from "../guided/report";
import { behaviorWords, productRowsFor, productsDirty, standInReason, templateOfRow, todaysRuleRow, withRateType, type ProductRow } from "../guided/volume";

const FAMS = [
  { familyId: "mort", label: "Mortgages", suggested: { template: { rateType: "fixed" as const, amortization: "level-pay" as const, indexTenorMonths: 360, fixedIndex: "matched" as const, behavior: "family" as const }, termMonths: 360, basis: "b" } },
  { familyId: "sav", label: "Savings", suggested: { template: { rateType: "deposit" as const, amortization: "decay" as const, indexTenorMonths: 1, behavior: "family" as const }, termMonths: 360, basis: "d" } },
  { familyId: "td", label: "Term deposits", suggested: null },
];

describe("product rows carry the family's behavior", () => {
  it("a new analysis opens on the suggestions with behavior on, a deposit as a deposit product", () => {
    const rows = productRowsFor(FAMS, null, null);
    expect(rows.map((r) => [r.rateType, r.behavior])).toEqual([["fixed", true], ["deposit", true], ["fixed", false]]);
    expect(templateOfRow(rows[0]!)).toEqual({ familyId: "mort", rateType: "fixed", amortization: "level-pay", indexTenorMonths: 360, fixedIndex: "matched", behavior: "family", termMonths: 360, spreadOverIndexBp: 0 });
    expect(templateOfRow(rows[1]!)).toEqual({ familyId: "sav", rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family", termMonths: 360, spreadOverIndexBp: 0 });
  });

  it("an S2b-1 saved product opens contractual and saves back as it was (no behavior key)", () => {
    const setup = { nii: { basis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 }, templates: [{ familyId: "mort", rateType: "fixed" as const, amortization: "level-pay" as const, indexTenorMonths: 360, fixedIndex: "matched" as const, termMonths: 360, spreadOverIndexBp: 10 }] } } as unknown as Parameters<typeof productRowsFor>[1];
    const rows = productRowsFor(FAMS, setup, null);
    expect(rows[0]!.behavior).toBe(false);
    expect("behavior" in templateOfRow(rows[0]!)!).toBe(false);
    // Ticking the box is an edit; unticking it again is not.
    const on = rows.map((r, i) => (i === 0 ? { ...r, behavior: true } : r));
    expect(productsDirty(on, rows)).toBe(true);
    expect(productsDirty(on.map((r, i) => (i === 0 ? { ...r, behavior: false } : r)), rows)).toBe(false);
  });

  it("switching a deposit family to a deposit product and back", () => {
    const stand = todaysRuleRow("sav", "Savings");
    const dep = withRateType(stand, "deposit");
    expect(dep).toMatchObject({ rateType: "deposit", amortization: "decay", indexTenor: "1", spreadBp: "0", behavior: true });
    const back = withRateType(dep, "fixed");
    expect(back).toMatchObject({ rateType: "fixed", amortization: "bullet", indexTenor: "matched", behavior: false });
  });

  it("fix round M3: a deposit family whose form new deposits cannot carry opens on the stand-in with its reason", () => {
    const fams = [{ familyId: "sav", label: "Savings", instrumentType: "nmd-b", suggested: null, model: { model: "none", reason: "new deposits of Savings cannot carry its full beta form yet, so its new volume is the fixed-rate stand-in" } }];
    const rows = productRowsFor(fams, null, null);
    expect(rows[0]).toMatchObject({ rateType: "fixed", amortization: "bullet", behavior: false, origin: "New deposits of Savings cannot carry its full beta form yet, so its new volume is the fixed-rate stand-in." });
    expect(standInReason({ instrumentType: "nmd-b", model: { model: "nmd-decay-beta" } })).toBeNull();
    expect(standInReason({ instrumentType: "fixed-loan", model: { model: "none", reason: "x" } })).toBeNull();
  });

  it("the behavior column reads the preview's words", () => {
    const row = { behavior: true } as ProductRow;
    expect(behaviorWords({ behavior: false } as ProductRow, undefined, undefined)).toMatch(/^Contractual/);
    expect(behaviorWords(row, { behavior: { applied: true, note: "n" } }, { label: "Four-factor CPR prepayment" })).toBe("Four-factor CPR prepayment, aged from the month it is made.");
    expect(behaviorWords(row, { behavior: { applied: false, note: "New volume is contractual: x." } }, { label: "L" })).toBe("New volume is contractual: x.");
  });
});

describe("the two opt-in views on the setup", () => {
  it("are absent on a new setup, written only when on, and removed again when off", () => {
    const s = guidedSetupBody({ kind: "flat" });
    expect("goingConcern" in s.eve || "forecast" in s.gap).toBe(false);
    const on = withNewVolumeViews(s, { goingConcern: true, forecastGap: true, span: "default" });
    expect(newVolumeViewsOf(on)).toEqual({ goingConcern: true, forecastGap: true, span: "default" });
    expect("goingConcernSpan" in on.eve).toBe(false);
    // Ruling 2026-11-03: the whole earnings horizon (60 months on a new setup) is the one extension, written only
    // beside going-concern value.
    const whole = withNewVolumeViews(s, { goingConcern: true, forecastGap: false, span: "horizon" });
    expect(whole.eve.goingConcernSpan).toBe(60);
    expect("goingConcernSpan" in withNewVolumeViews(s, { goingConcern: false, forecastGap: false, span: "horizon" }).eve).toBe(false);
    // On a 12-month horizon the whole horizon is the default, so nothing is written.
    expect("goingConcernSpan" in withNewVolumeViews(withHorizon(s, 12, [12]), { goingConcern: true, forecastGap: false, span: "horizon" }).eve).toBe(false);
    // A whole-horizon span follows the horizon, never past it.
    expect(withHorizon(whole, 24, [12, 24]).eve.goingConcernSpan).toBe(24);
    expect("goingConcernSpan" in withHorizon(whole, 12, [12]).eve).toBe(false);
    const off = withNewVolumeViews(on, { goingConcern: false, forecastGap: false, span: "default" });
    expect(JSON.stringify(off)).toBe(JSON.stringify(s));
  });
});

const BOOK = {
  id: "b", label: "Book", asOf: "2026-03-31", positions: [],
  coa: {
    schemaVersion: "1.0.0",
    nodes: [{ id: "A", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 }, { id: "L", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 }],
    families: [
      { id: "loan", label: "Loans", side: "asset", instrumentType: "mortgage", coaNodeId: "A" },
      { id: "dep", label: "Deposits", side: "liability", instrumentType: "nmd", coaNodeId: "L" },
    ],
  },
} as unknown as PortfolioSpec;

const band = (label: string, a: number, l: number) => ({ band: { label, fromMonth: 0, toMonth: 1 }, assets: a, liabilities: l, gap: a - l, cumulativeGap: 0 });
const RESULT = {
  nii: { horizonsMonths: [12], byScenario: [{ scenarioId: "S0", byFamily: [] }, { scenarioId: "S100", byFamily: [] }] },
  eve: {
    discountBasis: "risk-free",
    byScenario: [
      { scenarioId: "S0", pvAssets: 900, pvLiabilities: 800, eve: 100, deltaEveVsBase: 0, byFamily: [{ familyId: "loan", pv: 900 }, { familyId: "dep", pv: 800 }] },
      { scenarioId: "S100", pvAssets: 850, pvLiabilities: 780, eve: 70, deltaEveVsBase: -30, byFamily: [{ familyId: "loan", pv: 850 }, { familyId: "dep", pv: 780 }] },
    ],
    goingConcern: {
      note: "stored note",
      span: { months: 12 },
      byScenario: [
        { scenarioId: "S0", runoffEve: 100, newVolumeValue: 25, eve: 125, deltaEveVsBase: 0, deltaEvePct: 0, byFamily: [{ familyId: "loan", trancheCount: 3, notional: 300, value: 10 }, { familyId: "dep", trancheCount: 2, notional: 50, value: 15 }] },
        { scenarioId: "S100", runoffEve: 70, newVolumeValue: 20, eve: 90, deltaEveVsBase: -35, deltaEvePct: -0.28, byFamily: [{ familyId: "loan", trancheCount: 3, notional: 300, value: 4 }, { familyId: "dep", trancheCount: 2, notional: 50, value: 16 }] },
      ],
    },
  },
  gap: {
    repricing: [{ scenarioId: "S0", rows: [band("0-1M", 1, 0)] }],
    liquidity: [{ scenarioId: "S0", rows: [band("0-1M", 2, 0)] }],
    forecast: { note: "forecast note", repricing: [{ scenarioId: "S0", rows: [band("0-1M", 5, 1)] }], liquidity: [{ scenarioId: "S0", rows: [band("0-1M", 7, 3)] }] },
  },
} as unknown as RunResult;
const choice = (c: Partial<ReportChoice>): ReportChoice => ({ metric: "eve", scenarios: ["S0", "S100"], horizon: 12, granularity: "horizon", grouping: "total", focus: "", ...c });

describe("the Reports step reads going-concern EVE and the forecast gap off the stored blocks", () => {
  it("going-concern EVE beside run-off EVE, with the one sentence on the difference", () => {
    const t = buildReport(RESULT, BOOK, choice({}));
    const row = (label: string) => t.rows.find((r) => r.label === label)!.values;
    expect(t.total!.label).toMatch(/Run-off EVE.*regulatory measure/);
    expect(t.total!.values).toEqual([100, 70]);
    expect(row("Value of the new volume made in the first 12 months (going concern)")).toEqual([25, 20]);
    expect(row("Going-concern EVE (run-off EVE plus the new volume's value)")).toEqual([125, 90]);
    expect(row("Going-concern change from the base")).toEqual([0, -35]);
    // Fix round M4: the sentence names the span in plain words.
    const sentence = goingConcernDifference(RESULT.eve.goingConcern!);
    expect(sentence).toMatch(/new volume made in the first 12 months by your plan/);
    expect(t.notes).toContain(sentence);
    const fam = buildReport(RESULT, BOOK, choice({ grouping: "family" }));
    expect(fam.rows.map((r) => r.label)).toEqual(["Loans (asset)", "Loans: new volume value, as it adds to EVE (going concern)", "Deposits (liability)", "Deposits: new volume value, as it adds to EVE (going concern)"]);
    expect(fam.rows[3]!.values).toEqual([15, 16]);
  });

  it("the forecast ladders are offered only when stored, and read their own rows", () => {
    expect(metricsFor(RESULT)).toEqual(expect.arrayContaining(["repricing-forecast", "liquidity-forecast"]));
    const t = buildReport(RESULT, BOOK, choice({ metric: "liquidity-forecast", granularity: "buckets", grouping: "total" }));
    expect(t.rows[0]!.values).toEqual([4]);
    expect(t.notes[0]).toBe("forecast note");
    const plain = buildReport(RESULT, BOOK, choice({ metric: "liquidity", granularity: "buckets", grouping: "total" }));
    expect(plain.rows[0]!.values).toEqual([2]);
    const { forecast: _f, ...gap } = RESULT.gap;
    expect(metricsFor({ ...RESULT, gap } as RunResult)).not.toContain("repricing-forecast");
  });

  it("a deposit product and a behavior note read in words", () => {
    const p = { source: "template", rateType: "deposit", amortization: "decay", indexTenorMonths: 1, termMonths: 360, spreadOverIndexBp: 0, behavior: { model: "nmd-decay", applied: true, source: "position", note: "Each new tranche runs deposit decay." } } as never;
    expect(productText(p)).toBe("a new deposit at the family's own rate, running off by its decay model, over 360 months. Each new tranche runs deposit decay.");
  });
});

describe("ruling 46: the New volume report's \"made over h months\" sums months 1 .. h", () => {
  it("over 6 months it sums the originations of months 1 to 6, by hand", () => {
    // originations[k] is the tranche made at the end of month k; index 0 is the opening bucket and holds nothing.
    const originations = [0, 10, 20, 30, 40, 50, 60, 70, 80];
    const result = {
      nii: {
        horizonsMonths: [6],
        byScenario: [{ scenarioId: "S0", totalNetByHorizon: { "6": 0 }, byFamily: [{ familyId: "loan", byHorizon: { "6": { net: 0 } }, netMonthly: new Array(9).fill(0) }], newBusiness: [{ familyId: "loan", originations, netMonthly: new Array(9).fill(0) }] }],
      },
      eve: { byScenario: [] },
      gap: { repricing: [], liquidity: [] },
    } as unknown as RunResult;
    const t = buildReport(result, BOOK, { metric: "newvolume", scenarios: ["S0"], horizon: 6, granularity: "horizon", grouping: "family", focus: "" });
    // Months 1 to 6: 10 + 20 + 30 + 40 + 50 + 60 = 210 (the old slice of indices 0 to 5 read 150).
    expect(t.rows.find((r) => r.label === "Loans: made over 6 months")!.values).toEqual([210]);
  });
});
