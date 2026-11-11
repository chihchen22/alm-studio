/**
 * The roll-up reader on a small hand book. Every expected value below is worked by hand
 * from the inputs written in this file (never read back from the module under test): flows sum, balances show the
 * end of the period and the average, rates are a ratio of sums annualised, the quarterly gap is the sum of the
 * stored monthly buckets, originations follow the 1 .. N convention (S2b-2 ruling 46), and calendar periods with a
 * cut-off mid-quarter start on a stub. A second block checks the reader against a stored engine run: the periods'
 * net interest income adds up to the run's own stored horizon totals.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { RunResult } from "../../contracts/run";
import { rollFlow, rollUpRun, rollUpWindows, RollUpOptionsError } from "../rollUp";
import { buildDemoPortfolio } from "../../../../../data/src/demo/request";

const coa = { families: [{ id: "loans", side: "asset" }, { id: "deposits", side: "liability" }] } as unknown as ChartOfAccounts;

// Seven months from a cut-off of 31 May 2026. Loans earn 10 .. 16 a month on a balance running 1000 down by 10 a month;
// deposits cost 2, 2, 3, 3, 4, 4, 5 on 500 down by 5 a month.
const loanInterest = [10, 11, 12, 13, 14, 15, 16];
const loanBalance = [1000, 990, 980, 970, 960, 950, 940];
const depInterest = [2, 2, 3, 3, 4, 4, 5];
const depBalance = [500, 495, 490, 485, 480, 475, 470];
const gaps = [100, -50, 20, 30, -10, 5, 7];
const cum = [100, 50, 70, 100, 90, 95, 102];
const band = (i: number) => ({ band: { label: `M${i + 1}`, startMonth: i, endMonth: i + 1 }, assets: Math.max(gaps[i]!, 0), liabilities: Math.max(-gaps[i]!, 0), gap: gaps[i]!, cumulativeGap: cum[i]! });

function hand(asOf: string): RunResult {
  return {
    schemaVersion: "1.13.0",
    cashflows: {
      grid: { horizonMonths: 7, asOf },
      byScenario: [{
        scenarioId: "S0",
        byFamily: [
          { familyId: "loans", series: { interest: loanInterest, balance: loanBalance, principal: [10, 10, 10, 10, 10, 10, 10] } },
          { familyId: "deposits", series: { interest: depInterest, balance: depBalance, principal: [5, 5, 5, 5, 5, 5, 5] } },
        ],
      }],
    },
    nii: {
      byScenario: [{
        scenarioId: "S0",
        netMonthly: [8, 9, 9, 10, 10, 11, 11],
        byFamily: [],
        // Index k is the tranche made at the end of month k; index 0 is always 0.
        newBusiness: [{ familyId: "loans", originations: [0, 5, 6, 7, 8, 9, 10] }],
      }],
    },
    gap: {
      repricing: [{ scenarioId: "S0", rows: [], byCoaNode: [], userBuckets: { kind: "monthly", rows: gaps.map((_, i) => band(i)) } }],
      liquidity: [{ scenarioId: "S0", rows: [], byCoaNode: [] }],
    },
  } as unknown as RunResult;
}

describe("rollUpWindows", () => {
  it("counts quarters and years from the cut-off, the last one labelled partial", () => {
    expect(rollUpWindows(7, "quarter")).toEqual([
      { label: "Quarter 1", firstMonth: 1, lastMonth: 3, months: 3, partial: false },
      { label: "Quarter 2", firstMonth: 4, lastMonth: 6, months: 3, partial: false },
      { label: "Quarter 3 (partial, 1 of 3 months)", firstMonth: 7, lastMonth: 7, months: 1, partial: true },
    ]);
    expect(rollUpWindows(24, "year").map((w) => [w.firstMonth, w.lastMonth, w.partial])).toEqual([[1, 12, false], [13, 24, false]]);
  });

  it("places calendar quarters on a cut-off mid-quarter: a one-month stub, then whole quarters", () => {
    // 31 May 2026: month 1 ends 30 June (Q2), months 2 to 4 are July to September, 5 to 7 October to December.
    expect(rollUpWindows(7, "quarter", "calendar", "2026-05-31")).toEqual([
      { label: "2026 Q2 (partial, 1 of 3 months)", firstMonth: 1, lastMonth: 1, months: 1, partial: true },
      { label: "2026 Q3", firstMonth: 2, lastMonth: 4, months: 3, partial: false },
      { label: "2026 Q4", firstMonth: 5, lastMonth: 7, months: 3, partial: false },
    ]);
    // 15 February 2026: month 1 ends 15 March, so it is a March month; months 2 to 4 end in April to June.
    expect(rollUpWindows(5, "quarter", "calendar", "2026-02-15").map((w) => [w.label, w.firstMonth, w.lastMonth])).toEqual([
      ["2026 Q1 (partial, 1 of 3 months)", 1, 1],
      ["2026 Q2", 2, 4],
      ["2026 Q3 (partial, 1 of 3 months)", 5, 5],
    ]);
    // Calendar years from 30 September 2026: October to December 2026 is a three-month stub, then 2027.
    expect(rollUpWindows(15, "year", "calendar", "2026-09-30").map((w) => [w.label, w.firstMonth, w.lastMonth])).toEqual([
      ["2026 (partial, 3 of 12 months)", 1, 3],
      ["2027", 4, 15],
    ]);
  });

  it("places a first-of-month cut-off by the half-open month rule (fix round M3)", () => {
    // 1 January: month 1 is [1 Jan, 1 Feb), its last day 31 January, so January to March are a full first quarter.
    expect(rollUpWindows(6, "quarter", "calendar", "2026-01-01").map((w) => [w.label, w.firstMonth, w.lastMonth, w.partial])).toEqual([
      ["2026 Q1", 1, 3, false],
      ["2026 Q2", 4, 6, false],
    ]);
    expect(rollUpWindows(12, "year", "calendar", "2026-01-01").map((w) => [w.label, w.firstMonth, w.lastMonth, w.partial])).toEqual([["2026", 1, 12, false]]);
    // 1 March: month 1 is March, a one-month first quarter; April to June follow.
    expect(rollUpWindows(4, "quarter", "calendar", "2026-03-01").map((w) => [w.label, w.firstMonth, w.lastMonth, w.partial])).toEqual([
      ["2026 Q1 (partial, 1 of 3 months)", 1, 1, true],
      ["2026 Q2", 2, 4, false],
    ]);
    // 31 March, the month-end case: month 1 is [31 Mar, 30 Apr), April, as before the fix.
    expect(rollUpWindows(4, "quarter", "calendar", "2026-03-31").map((w) => [w.label, w.firstMonth, w.lastMonth, w.partial])).toEqual([
      ["2026 Q2", 1, 3, false],
      ["2026 Q3 (partial, 1 of 3 months)", 4, 4, true],
    ]);
  });

  it("refuses an unknown period, a calendar roll-up with no as-of, and a non-positive month count", () => {
    expect(() => rollUpWindows(7, "month" as never)).toThrow(RollUpOptionsError);
    expect(() => rollUpWindows(7, "quarter", "calendar")).toThrow("as-of");
    expect(() => rollUpWindows(0, "quarter")).toThrow(RollUpOptionsError);
  });
});

describe("rollUpRun on a hand book", () => {
  const r = rollUpRun(hand("2026-05-31"), coa, { period: "quarter" });
  if (r.kind !== "rolled") throw new Error("expected a roll-up");
  const s = r.byScenario[0]!;
  const loans = s.byFamily.find((f) => f.familyId === "loans")!;
  const deps = s.byFamily.find((f) => f.familyId === "deposits")!;

  it("sums flows: income 10+11+12, 13+14+15, 16; expense 2+2+3, 3+4+4, 5; net the difference", () => {
    expect(loans.income).toEqual([33, 42, 16]);
    expect(deps.expense).toEqual([7, 11, 5]);
    expect(s.income).toEqual([33, 42, 16]);
    expect(s.expense).toEqual([7, 11, 5]);
    expect(s.net).toEqual([26, 31, 11]);
    expect(loans.principal).toEqual([30, 30, 10]);
  });

  it("shows the end-of-period balance (start of the next month) and the average beside it", () => {
    // Q1 ends at the start of month 4 (970); Q2 at the start of month 7 (940); Q3 ends on the projection's last month.
    expect(loans.balanceEnd).toEqual([970, 940, null]);
    expect(loans.balanceAverage).toEqual([990, 960, 940]);
    expect(deps.balanceEnd).toEqual([485, 470, null]);
    expect(deps.balanceAverage).toEqual([495, 480, 470]);
  });

  it("annualises rates as a ratio of sums, not an average of monthly rates", () => {
    expect(loans.rate[0]).toBeCloseTo((33 / 2970) * 12, 14);
    expect(loans.rate[1]).toBeCloseTo((42 / 2880) * 12, 14);
    expect(loans.rate[2]).toBeCloseTo((16 / 940) * 12, 14);
    // The average of the three monthly rates differs in the fourth decimal: a ratio of sums is not that.
    const avgOfRates = ((10 / 1000 + 11 / 990 + 12 / 980) / 3) * 12;
    expect(Math.abs(loans.rate[0]! - avgOfRates)).toBeGreaterThan(1e-5);
    expect(deps.rate[0]).toBeCloseTo((7 / 1485) * 12, 14);
  });

  it("sums the quarterly gap from the stored monthly buckets, the cumulative gap at the period's end", () => {
    expect(s.gap?.repricing?.map((g) => g.gap)).toEqual([70, 25, 7]);
    expect(s.gap?.repricing?.map((g) => g.cumulativeGap)).toEqual([70, 95, 102]);
    expect(s.gap?.repricing?.map((g) => g.assets)).toEqual([120, 30 + 5, 7]);
    expect(s.gap?.repricing?.map((g) => g.liabilities)).toEqual([50, 10, 0]);
    // A ladder that stored no monthly buckets is not rolled.
    expect(s.gap?.liquidity).toBeUndefined();
  });

  it("counts originations 1 .. N: quarter 1 is the tranches made at k = 1, 2, 3", () => {
    expect(loans.originations).toEqual([5 + 6 + 7, 8 + 9 + 10, 0]);
    // The bucket convention would have read k = 0, 1, 2 for quarter 1, which is not the window.
    expect(rollFlow([0, 5, 6, 7, 8, 9, 10], rollUpWindows(7, "quarter"), "bucket")[0]).toBe(11);
    expect(deps.originations).toBeUndefined();
  });

  it("rolls calendar quarters from a cut-off of 31 May: June alone, then July to September, then October to December", () => {
    const c = rollUpRun(hand("2026-05-31"), coa, { period: "quarter", alignment: "calendar" });
    if (c.kind !== "rolled") throw new Error("expected a roll-up");
    const l = c.byScenario[0]!.byFamily.find((f) => f.familyId === "loans")!;
    expect(c.periods.map((p) => p.label)).toEqual(["2026 Q2 (partial, 1 of 3 months)", "2026 Q3", "2026 Q4"]);
    expect(l.income).toEqual([10, 11 + 12 + 13, 14 + 15 + 16]);
    expect(l.balanceEnd).toEqual([990, 960, null]);
    expect(l.balanceAverage).toEqual([1000, 980, 950]);
    expect(l.rate[0]).toBeCloseTo((10 / 1000) * 12, 14);
    expect(l.originations).toEqual([5, 6 + 7 + 8, 9 + 10]);
    expect(c.byScenario[0]!.gap?.repricing?.map((g) => g.gap)).toEqual([100, 0, 2]);
  });

  it("rolls calendar quarters from a cut-off of 1 March: March alone (10), then April to June (11 + 12 + 13), then July to September (14 + 15 + 16)", () => {
    const c = rollUpRun(hand("2026-03-01"), coa, { period: "quarter", alignment: "calendar" });
    if (c.kind !== "rolled") throw new Error("expected a roll-up");
    expect(c.periods.map((p) => p.label)).toEqual(["2026 Q1 (partial, 1 of 3 months)", "2026 Q2", "2026 Q3"]);
    expect(c.byScenario[0]!.byFamily.find((f) => f.familyId === "loans")!.income).toEqual([10, 36, 45]);
  });

  it("rolls a year as one partial period of 7 months and the first n months when asked", () => {
    const y = rollUpRun(hand("2026-05-31"), coa, { period: "year" });
    if (y.kind !== "rolled") throw new Error("expected a roll-up");
    expect(y.periods).toEqual([{ label: "Year 1 (partial, 7 of 12 months)", firstMonth: 1, lastMonth: 7, months: 7, partial: true }]);
    expect(y.byScenario[0]!.net).toEqual([68]);
    const four = rollUpRun(hand("2026-05-31"), coa, { period: "quarter", months: 4 });
    if (four.kind !== "rolled") throw new Error("expected a roll-up");
    expect(four.byScenario[0]!.byFamily[0]!.income).toEqual([33, 13]);
    expect(() => rollUpRun(hand("2026-05-31"), coa, { period: "quarter", months: 8 })).toThrow(RollUpOptionsError);
  });

  it("rolls the stored forecast ladders too (fix round L2): the same bands, the same sums", () => {
    const withForecast = hand("2026-05-31") as unknown as { gap: Record<string, unknown> };
    withForecast.gap.forecast = { repricing: [{ scenarioId: "S0", rows: [], byCoaNode: [], userBuckets: { kind: "monthly", rows: gaps.map((_, i) => band(i)) } }], liquidity: [], note: "" };
    const f = rollUpRun(withForecast as unknown as RunResult, coa, { period: "quarter" });
    if (f.kind !== "rolled") throw new Error("expected a roll-up");
    expect(f.byScenario[0]!.gap?.forecastRepricing?.map((g) => g.gap)).toEqual([70, 25, 7]);
    expect(f.byScenario[0]!.gap?.forecastLiquidity).toBeUndefined();
  });

  it("returns the typed absent reply on a run without monthly NII", () => {
    const old = hand("2026-05-31");
    delete (old.nii.byScenario[0] as { netMonthly?: number[] }).netMonthly;
    expect(rollUpRun(old, coa, { period: "quarter" })).toEqual({ kind: "absent", reason: "no-netMonthly" });
  });
});

describe("rollUpRun against a stored engine run", () => {
  const GOLDEN = fileURLToPath(new URL("../../run/__tests__/golden/demo-run.id-rename.json", import.meta.url));
  const result = JSON.parse(readFileSync(GOLDEN, "utf8")) as RunResult;
  const demo = buildDemoPortfolio().coa;

  it("the first year's net interest income is the run's own stored 12-month total, and four quarters add to it", () => {
    const y = rollUpRun(result, demo, { period: "year" });
    const q = rollUpRun(result, demo, { period: "quarter" });
    if (y.kind !== "rolled" || q.kind !== "rolled") throw new Error("expected roll-ups");
    for (const stored of result.nii.byScenario) {
      const ys = y.byScenario.find((s) => s.scenarioId === stored.scenarioId)!;
      const qs = q.byScenario.find((s) => s.scenarioId === stored.scenarioId)!;
      const tol = Math.abs(stored.totalNet12) * 1e-12 + 1e-6;
      expect(Math.abs(ys.net[0]! - stored.totalNet12)).toBeLessThan(tol);
      expect(Math.abs(qs.net.slice(0, 4).reduce((a, b) => a + b, 0) - stored.totalNet12)).toBeLessThan(tol);
      expect(Math.abs(y.byScenario.find((s) => s.scenarioId === stored.scenarioId)!.net.slice(0, 2).reduce((a, b) => a + b, 0) - stored.totalNet24)).toBeLessThan(Math.abs(stored.totalNet24) * 1e-12 + 1e-6);
    }
    expect(q.periods.length).toBe(Math.ceil(result.cashflows.grid.horizonMonths / 3));
  });
});
