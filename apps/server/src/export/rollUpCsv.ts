/**
 * The quarterly and annual roll-up as a CSV table. Every value comes from the engine's
 * one roll-up reader (`rollUpRun`, packages/engine/src/report/rollUp.ts) at full precision; nothing is summed here.
 * Served at GET /api/runs/:id/export/rollup-quarterly.csv and rollup-annual.csv, with `?align=calendar` for calendar
 * periods (periods count from the cut-off by default) and `?months=N` to roll the first N months only.
 *
 * Long format, one row per scenario, line and period. `line` is "total" (the whole balance sheet's net interest
 * income), "family" (one family's flows, balances and rate), "repricing-gap" or "liquidity-gap" (from the stored
 * monthly buckets, present only when the run stored them), and "forecast-repricing-gap" or "forecast-liquidity-gap"
 * (the forecast arm, the same way). A column a line does not carry is blank.
 */
import type { RollUpReply } from "@alm/engine";
import type { CsvTable } from "./csv";

export const ROLL_UP_TABLES = { "rollup-quarterly": "quarter", "rollup-annual": "year" } as const;
export type RollUpTable = keyof typeof ROLL_UP_TABLES;

export function isRollUpTable(x: string): x is RollUpTable {
  return Object.prototype.hasOwnProperty.call(ROLL_UP_TABLES, x);
}

export function rollUpTable(reply: Extract<RollUpReply, { kind: "rolled" }>): CsvTable {
  const columns: CsvTable["columns"] = [
    { name: "scenarioId", role: "key" },
    { name: "line", role: "key" },
    { name: "familyId", role: "key" },
    { name: "period", role: "key" },
    { name: "firstMonth", role: "text" },
    { name: "lastMonth", role: "text" },
    { name: "months", role: "text" },
    { name: "partial", role: "text" },
    { name: "interestIncome", role: "num" },
    { name: "interestExpense", role: "num" },
    { name: "netInterestIncome", role: "num" },
    { name: "principal", role: "num" },
    { name: "balanceEnd", role: "num" },
    { name: "balanceAverage", role: "num" },
    { name: "rateAnnualised", role: "num" },
    { name: "originations", role: "num" },
    { name: "gapAssets", role: "num" },
    { name: "gapLiabilities", role: "num" },
    { name: "gap", role: "num" },
    { name: "cumulativeGap", role: "num" },
  ];
  const rows: CsvTable["rows"] = [];
  const at = (i: number) => {
    const p = reply.periods[i]!;
    return { period: p.label, firstMonth: p.firstMonth, lastMonth: p.lastMonth, months: p.months, partial: p.partial };
  };
  for (const s of reply.byScenario) {
    reply.periods.forEach((_, i) => {
      rows.push({ scenarioId: s.scenarioId, line: "total", familyId: "", ...at(i), interestIncome: s.income[i], interestExpense: s.expense[i], netInterestIncome: s.net[i] });
    });
    for (const f of s.byFamily) {
      reply.periods.forEach((_, i) => {
        rows.push({
          scenarioId: s.scenarioId,
          line: "family",
          familyId: f.familyId,
          ...at(i),
          interestIncome: f.income[i],
          interestExpense: f.expense[i],
          netInterestIncome: f.net[i],
          principal: f.principal[i],
          balanceEnd: f.balanceEnd[i],
          balanceAverage: f.balanceAverage[i],
          rateAnnualised: f.rate[i],
          originations: f.originations?.[i],
        });
      });
    }
    const lines = [["repricing", "repricing-gap"], ["liquidity", "liquidity-gap"], ["forecastRepricing", "forecast-repricing-gap"], ["forecastLiquidity", "forecast-liquidity-gap"]] as const;
    for (const [kind, line] of lines) {
      const g = s.gap?.[kind];
      if (g === undefined) continue;
      g.forEach((row, i) => {
        rows.push({ scenarioId: s.scenarioId, line, familyId: "", ...at(i), gapAssets: row.assets, gapLiabilities: row.liabilities, gap: row.gap, cumulativeGap: row.cumulativeGap });
      });
    }
  }
  const notes = [
    `${reply.period === "quarter" ? "Quarterly" : "Annual"} roll-up of ${reply.months} months, periods ${reply.alignment === "cutoff" ? "counted from the cut-off" : "on the calendar"} (as-of ${reply.asOf}).`,
    reply.rules.flows,
    reply.rules.balances,
    reply.rules.rates,
    reply.rules.window,
    "Value (EVE) and stochastic results are not rolled up. Every value is the stored engine figure at full precision; the screen rounds for display.",
  ];
  return { columns, rows, notes };
}
