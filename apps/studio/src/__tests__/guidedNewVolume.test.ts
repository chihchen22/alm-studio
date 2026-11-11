// apps/studio/src/__tests__/guidedNewVolume.test.ts
/**
 * Studio slice S2b-1 in the guided setup and the report builder. Every expected figure is typed by hand
 * into a small run result; nothing is read back from the code under test.
 *  - A new guided setup discounts EVE on the risk-free curve and carries the families' starting products; a stored
 *    setup is never rewritten by these edits.
 *  - The earnings horizon edits the NII window and the report horizons only: the projection grid stays at 360.
 *  - The New volume and FTP reports read the stored lines, and are offered only when the run stored them.
 */
import { describe, expect, it } from "vitest";
import type { PortfolioSpec, RunResult } from "@alm/engine";
import { guidedSetupBody, horizonProblems, readHorizons, withDiscount, withHorizon, withTemplates } from "../guided/setup";
import { buildReport, metricsFor, normalizeChoice, type ReportChoice } from "../guided/report";

const TPL = [{ familyId: "loan", rateType: "floating" as const, amortization: "level-pay" as const, indexTenorMonths: 3, termMonths: 60, spreadOverIndexBp: 150 }];

describe("the guided setup", () => {
  it("a new guided setup discounts EVE on the risk-free curve and carries the products it is given", () => {
    const s = guidedSetupBody({ kind: "flat" }, TPL);
    expect(s.eve.discountBasis).toBe("risk-free");
    expect(s.nii.templates).toEqual(TPL);
    expect("templates" in guidedSetupBody({ kind: "runoff" }).nii).toBe(false);
  });
  it("all-in is one choice away, and back", () => {
    const s = guidedSetupBody({ kind: "flat" });
    expect(withDiscount(s, "all-in").eve.discountBasis).toBe("all-in");
    expect(withDiscount(withDiscount(s, "all-in"), "risk-free").eve.discountBasis).toBe("risk-free");
  });
  it("an empty product list removes the field: back to today's rule, and the setup's other bytes unchanged", () => {
    const s = guidedSetupBody({ kind: "flat" }, TPL);
    const back = withTemplates(s, []);
    expect("templates" in back.nii).toBe(false);
    expect(JSON.stringify(withTemplates(guidedSetupBody({ kind: "flat" }), []))).toBe(JSON.stringify(guidedSetupBody({ kind: "flat" })));
  });
  it("the earnings horizon sets the NII window and report horizons and never the grid", () => {
    const s = withHorizon(guidedSetupBody({ kind: "flat" }), 24, [12, 24]);
    expect(s.nii.horizonMonths).toBe(24);
    expect(s.nii.reportHorizons).toEqual([12, 24]);
    expect(s.gridHorizonMonths).toBe(360);
  });
  it("refuses a report horizon beyond the earnings horizon (fix round L5)", () => {
    expect(horizonProblems("24", "12, 60", 360)).toEqual(["Each report horizon is at most the earnings horizon (24 months): the results show and sum 24 months."]);
    expect(horizonProblems("60", "12, 24, 60", 360)).toEqual([]);
  });
  it("names horizon problems: 12 to 360, rising", () => {
    expect(horizonProblems("24", "12, 24", 360)).toEqual([]);
    expect(horizonProblems("6", "12", 360)).toEqual(["Type the earnings horizon as a whole number of months from 12 to 360."]);
    expect(horizonProblems("360", "12, 400", 360)).toEqual(["Each report horizon is a whole number of months from 12 to 360."]);
    expect(horizonProblems("60", "24, 12", 360)).toEqual(["List the report horizons from the shortest to the longest, each once."]);
    expect(readHorizons("12, 24 60")).toEqual([12, 24, 60]);
  });
});

const BOOK = {
  id: "b", label: "Book", asOf: "2026-03-31", positions: [],
  coa: {
    schemaVersion: "1.0.0",
    nodes: [{ id: "A", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 }, { id: "L", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 }],
    families: [
      { id: "loan", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "A" },
      { id: "dep", label: "Deposits", side: "liability", instrumentType: "nmd", coaNodeId: "L" },
    ],
  },
} as unknown as PortfolioSpec;

// Two scenarios, three months stored, every number typed by hand. Loans' new volume earns 1, 2, 3; deposits' costs 1, 1, 1.
const RESULT = {
  nii: {
    horizonsMonths: [12],
    byScenario: [
      {
        scenarioId: "S0", totalNet12: 30, totalNet24: 0, totalNetByHorizon: { "12": 30 }, netMonthly: [5, 6, 7],
        byFamily: [
          { familyId: "loan", byHorizon: { "12": { net: 40 } }, netMonthly: [6, 7, 8] },
          { familyId: "dep", byHorizon: { "12": { net: -10 } }, netMonthly: [-1, -1, -1] },
        ],
        newBusiness: [
          { familyId: "loan", originations: [0, 100, 50], product: { source: "template", rateType: "floating", amortization: "level-pay", indexTenorMonths: 3, termMonths: 60, spreadOverIndexBp: 150 }, balance: [0, 100, 150], netMonthly: [1, 2, 3], couponAtOrigination: [null, 0.05, 0.051] },
          { familyId: "dep", originations: [0, 20, 0], product: { source: "fixed-bullet", rateType: "fixed", amortization: "bullet", indexTenorMonths: 60, termMonths: 60, spreadOverIndexBp: 0 }, balance: [0, 20, 20], netMonthly: [-1, -1, -1], couponAtOrigination: [null, 0.04, null] },
        ],
      },
      {
        scenarioId: "S100", totalNet12: 33, totalNet24: 0, totalNetByHorizon: { "12": 33 }, netMonthly: [5, 6, 8],
        byFamily: [
          { familyId: "loan", byHorizon: { "12": { net: 44 } }, netMonthly: [6, 7, 9] },
          { familyId: "dep", byHorizon: { "12": { net: -11 } }, netMonthly: [-1, -1, -1] },
        ],
        newBusiness: [
          { familyId: "loan", originations: [0, 100, 50], balance: [0, 100, 150], netMonthly: [2, 2, 4], couponAtOrigination: [null, 0.06, 0.061] },
          { familyId: "dep", originations: [0, 20, 0], balance: [0, 20, 20], netMonthly: [-2, -1, -1], couponAtOrigination: [null, 0.05, null] },
        ],
      },
    ],
  },
  eve: { byScenario: [] },
  gap: { repricing: [], liquidity: [] },
  ftp: {
    scenarioId: "S0",
    byFamily: [
      { familyId: "loan", positionCount: 2, margin12: 9, allInFtpRate: 0.045, newVolume: { notional: 900, couponRate: 0.06, allInFtpRate: 0.05, ftpMarginRate: 0.01, margin12: 1.5, trancheCount: 9,
        window: { months: 60, trancheCount: 2, notional: 150, couponRate: 0.0505, allInFtpRate: 0.041, ftpMarginRate: 0.0095, couponInterest: 20, ftpAccrual: 17, margin: 3 } } },
      { familyId: "dep", positionCount: 1, margin12: 4, allInFtpRate: 0.04 },
    ],
    nimBridge: { newVolume: { lendingMargin12: 1.5, fundingMargin12: 0.25, mismatchCenter12: 0.25, net12: 2 } },
  },
} as unknown as RunResult;

const choice = (c: Partial<ReportChoice>): ReportChoice => ({ metric: "newvolume", scenarios: ["S0", "S100"], horizon: 12, granularity: "horizon", grouping: "family", focus: "", ...c });

describe("the new-volume and FTP reports", () => {
  it("offers New volume and FTP only on a run that stored them", () => {
    expect(metricsFor(RESULT)).toEqual(["nii", "eve", "repricing", "liquidity", "newvolume", "ftp", "balance"]);
    const bare = { ...RESULT, ftp: undefined, nii: { ...RESULT.nii, byScenario: RESULT.nii.byScenario.map((s) => ({ ...s, newBusiness: s.newBusiness!.map((n) => ({ familyId: n.familyId, originations: n.originations })) })) } } as unknown as RunResult;
    expect(metricsFor(bare)).toEqual(["nii", "eve", "repricing", "liquidity", "balance"]);
    expect(normalizeChoice(choice({}), bare).metric).toBe("nii");
  });
  it("new volume by family: its net interest income and what was made, over the horizon", () => {
    const t = buildReport(RESULT, BOOK, choice({}));
    // By hand: S0 loans 1 + 2 + 3 = 6, made 0 + 100 + 50 = 150; deposits -3, made 20. S100 loans 8, deposits -4.
    expect(t.rows).toEqual([
      { label: "Loans: net interest income", values: [6, 8] },
      { label: "Loans: made over 12 months", values: [150, 150] },
      { label: "Deposits: net interest income", values: [-3, -4] },
      { label: "Deposits: made over 12 months", values: [20, 20] },
    ]);
    expect(t.total).toEqual({ label: "All new volume, net interest income", values: [3, 4] });
    expect(t.notes.some((n) => n.startsWith("Loans: floating rate on the 3-month rate, resetting every 3 months, level payment, 60 months, +150 bp"))).toBe(true);
    expect(t.notes.some((n) => n.includes("Deposits: fixed rate off the 60-month swap rate, repaid at maturity, 60 months, +0 bp (today's rule)"))).toBe(true);
  });
  it("the whole book split into the balance sheet held today (derived) and the new volume", () => {
    const t = buildReport(RESULT, BOOK, choice({ grouping: "total" }));
    // S0: 30 stored, new volume 6 - 3 = 3, so 27 held; S100: 33 stored, 8 - 4 = 4, so 29 held.
    expect(t.rows.map((r) => r.values)).toEqual([[27, 29], [3, 4]]);
    expect(t.total!.values).toEqual([30, 33]);
  });
  it("monthly new volume for one family", () => {
    const t = buildReport(RESULT, BOOK, choice({ granularity: "monthly", horizon: 12, focus: "dep" }));
    expect(t.rows.slice(0, 3).map((r) => r.values)).toEqual([[-1, -2], [-1, -1], [-1, -1]]);
  });
  it("NII by family carries each family's new volume on its own line", () => {
    const t = buildReport(RESULT, BOOK, choice({ metric: "nii" }));
    expect(t.rows).toEqual([
      { label: "Loans", values: [40, 44] },
      { label: "Loans: of which new volume", values: [6, 8] },
      { label: "Deposits", values: [-10, -11] },
      { label: "Deposits: of which new volume", values: [-3, -4] },
    ]);
  });
  it("FTP: the balance sheet held today and the new volume, rates marked as rates", () => {
    const t = buildReport(RESULT, BOOK, choice({ metric: "ftp" }));
    expect(t.columns).toEqual(["S0"]);
    // Fix round M2: the headline rows name the earnings window (60 months), the whole projection's rows name theirs
    // (the result has no grid, so the 360-month default: 30 years).
    expect(t.rows.map((r) => [r.label, r.values[0]])).toEqual([
      ["Loans: balance sheet held today, margin over the first 12 months", 9],
      ["Loans: balance sheet held today, transfer rate (the book at the cut-off)", 0.045],
      ["Loans: new volume made in the first 60 months", 150],
      ["Loans: new volume coupon, made in the first 60 months", 0.0505],
      ["Loans: new volume transfer rate at origination, made in the first 60 months", 0.041],
      ["Loans: new volume margin, made in the first 60 months", 0.0095],
      ["Loans: new volume margin over the first 60 months", 3],
      ["Loans: new volume made over the full 30-year projection", 900],
      ["Loans: new volume margin, made over the full 30-year projection", 0.01],
      ["Deposits: balance sheet held today, margin over the first 12 months", 4],
      ["Deposits: balance sheet held today, transfer rate (the book at the cut-off)", 0.04],
    ]);
    expect(t.rowUnits).toEqual(["usd", "rate", "usd", "rate", "rate", "rate", "usd", "usd", "rate", "usd", "rate"]);
    expect(t.total).toEqual({ label: "New volume margins over the first 60 months, all families (the sum of the families' stored figures)", values: [3] });
  });
});
