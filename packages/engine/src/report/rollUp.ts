/**
 * Quarterly and annual roll-ups of a stored deterministic run. A READ, beside
 * `niiMonthly.ts`: the server route, the CSV export and the Studio Reports step all call this one module, so the
 * aggregation rule lives in one tested place and nothing is recomputed anywhere else.
 *
 * The rules (one per kind of number):
 *  - Flows sum over the period: interest income, interest expense, net interest income, principal, originations,
 *    and each month's repricing and liquidity gap (a monthly band is itself a sum of flows, so the sum of three
 *    monthly bands is the quarterly band exactly).
 *  - Balances (stocks) show the end-of-period value with the period average beside it. A stored balance is the
 *    balance outstanding at the START of its bucket, so the end of a period is the start of the month after it
 *    (null on the projection's last month, which the run does not store), and the average is the mean of the
 *    period's start-of-month balances, the balances each month's interest accrues on. The cumulative gap is a stock
 *    too: its value at the period's last month.
 *  - Rates are a ratio of sums, annualised: the period's interest over the sum of its start-of-month balances,
 *    times 12 (the same as interest over the average balance times 12 over the months in the period). Never an
 *    average of monthly rates.
 *  - There is no roll-up of EVE (no time series) and none of a stochastic run (a quantile of a sum is not a sum of
 *    quantiles, and no per-path monthly series is stored).
 *
 * The window convention (S2b-2 ruling 46, kept): a flow's bucket b is the cash flow of month b + 1, so quarter 1 of
 * a run counted from the cut-off is buckets 0 to 2; an origination's index k is the tranche made at the end of month
 * k (index 0 is always 0, the sweep never mints at the cut-off), so quarter 1 is k = 1 to 3.
 *
 * Periods are counted from the cut-off by default (months 1 to 3 are quarter 1). Calendar periods are an option: a
 * projection month belongs to the calendar month of its last day (bucket k covers [asOf + k, asOf + k + 1), so its last
 * day is asOf + k + 1 months less a day: on a 1 January cut-off month 1 is January, on a 31 March one it is April), so with
 * a cut-off mid-quarter the first period is a stub, and a horizon that ends mid-period leaves a last stub. A period
 * shorter than a full quarter or year is labelled partial, never silently annualised as a full one.
 */
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import type { BalanceSheetSide, ProductFamilyId, ScenarioId } from "../contracts/ids";
import type { GapBucketRow } from "../contracts/results";
import type { RunResult } from "../contracts/run";
import { DERIVATIVE_SIDE } from "../swap/derivatives";
import { niiMonthly } from "./niiMonthly";

export type RollUpPeriod = "quarter" | "year";
export type RollUpAlignment = "cutoff" | "calendar";

export const ROLL_UP_PERIODS: readonly RollUpPeriod[] = ["quarter", "year"];
export const ROLL_UP_ALIGNMENTS: readonly RollUpAlignment[] = ["cutoff", "calendar"];

/** Months in a full period. */
export const PERIOD_MONTHS: Record<RollUpPeriod, number> = { quarter: 3, year: 12 };

/** One period of a roll-up: projection months firstMonth .. lastMonth (1-based, inclusive). */
export interface RollUpWindow {
  label: string;
  firstMonth: number;
  lastMonth: number;
  months: number;
  /** True when the period holds fewer months than a full quarter or year. */
  partial: boolean;
}

/** The plain words of the three rules, written on every reply and every CSV so a reader never guesses. */
export const ROLL_UP_RULES = {
  flows: "Flows (interest income and expense, net interest income, principal, originations, gap amounts) are the sum of the period's months.",
  balances:
    "Balances show the end of the period (the balance outstanding at the start of the next month; blank on the projection's last month, which the run does not store) and the average of the period's start-of-month balances beside it.",
  rates: "Rates are a ratio of sums, annualised: the period's interest over the sum of its start-of-month balances, times 12.",
  window:
    "Month m is bucket m - 1 of a flow (bucket b is the cash flow of month b + 1) and index m of originations (the tranche made at the end of month m).",
} as const;

/** -0 becomes +0; every other value is unchanged. */
const plusZero = (x: number): number => (x === 0 ? 0 : x);

/** The calendar (year, month 0..11) an ISO date's month is, read off its first seven characters. */
function yearMonthOf(asOf: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(asOf);
  if (m === null) throw new RollUpOptionsError(`the run's as-of date "${asOf}" is not an ISO date, so calendar periods cannot be placed`);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) throw new RollUpOptionsError(`the run's as-of date "${asOf}" names no calendar day`);
  return { year: Number(m[1]), month, day };
}

/** A typed refusal of an option the reader cannot honour (an unknown period, a bad as-of date, a month count). */
export class RollUpOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollUpOptionsError";
  }
}

/**
 * The periods of a roll-up over projection months 1 .. totalMonths.
 *  - "cutoff": period j holds months (j - 1) n + 1 .. j n, the last one partial when totalMonths is not a multiple.
 *  - "calendar": month m ends in calendar month (asOf month + m); consecutive months of one calendar quarter or year
 *    form a period, so a cut-off mid-period gives a first stub.
 */
export function rollUpWindows(totalMonths: number, period: RollUpPeriod, alignment: RollUpAlignment = "cutoff", asOf?: string): RollUpWindow[] {
  if (!Number.isInteger(totalMonths) || totalMonths < 1) throw new RollUpOptionsError(`a roll-up needs a whole number of months of at least 1, got ${totalMonths}`);
  if (!ROLL_UP_PERIODS.includes(period)) throw new RollUpOptionsError(`period must be "quarter" or "year", got ${JSON.stringify(period)}`);
  if (!ROLL_UP_ALIGNMENTS.includes(alignment)) throw new RollUpOptionsError(`alignment must be "cutoff" or "calendar", got ${JSON.stringify(alignment)}`);
  const full = PERIOD_MONTHS[period];
  const out: RollUpWindow[] = [];
  if (alignment === "cutoff") {
    for (let first = 1, j = 1; first <= totalMonths; first += full, j++) {
      const last = Math.min(first + full - 1, totalMonths);
      const months = last - first + 1;
      const name = period === "quarter" ? `Quarter ${j}` : `Year ${j}`;
      out.push({ label: months < full ? `${name} (partial, ${months} of ${full} months)` : name, firstMonth: first, lastMonth: last, months, partial: months < full });
    }
    return out;
  }
  if (asOf === undefined) throw new RollUpOptionsError("calendar periods need the run's as-of date");
  const start = yearMonthOf(asOf);
  // Month m covers [asOf + (m - 1) months, asOf + m months) and belongs to the calendar month of its last day, asOf +
  // m months - 1 day: the calendar month asOf.month + m, except on a first-of-month cut-off, where that last day falls
  // at the end of the month before, asOf.month + m - 1 (fix round M3).
  const shift = start.day === 1 ? -1 : 0;
  const keyOf = (m: number): { key: string; label: string } => {
    const abs = start.year * 12 + start.month + m + shift;
    const year = Math.floor(abs / 12);
    const moy = abs - year * 12;
    if (period === "year") return { key: String(year), label: String(year) };
    const q = Math.floor(moy / 3) + 1;
    return { key: `${year}-Q${q}`, label: `${year} Q${q}` };
  };
  let cur: { key: string; label: string; first: number } | null = null;
  const close = (last: number) => {
    if (cur === null) return;
    const months = last - cur.first + 1;
    out.push({ label: months < full ? `${cur.label} (partial, ${months} of ${full} months)` : cur.label, firstMonth: cur.first, lastMonth: last, months, partial: months < full });
  };
  for (let m = 1; m <= totalMonths; m++) {
    const k = keyOf(m);
    if (cur === null || cur.key !== k.key) {
      close(m - 1);
      cur = { key: k.key, label: k.label, first: m };
    }
  }
  close(totalMonths);
  return out;
}

/** How a stored series is indexed: "bucket" (month m is index m - 1) or "origination" (month m is index m). */
export type SeriesIndexing = "bucket" | "origination";

const indexOfMonth = (m: number, indexing: SeriesIndexing): number => (indexing === "bucket" ? m - 1 : m);

/** A flow summed over each period; a month the series does not hold counts 0 (a grid shorter than the window gives what it holds). */
export function rollFlow(series: readonly number[], windows: readonly RollUpWindow[], indexing: SeriesIndexing = "bucket"): number[] {
  return windows.map((w) => {
    let s = 0;
    for (let m = w.firstMonth; m <= w.lastMonth; m++) s += series[indexOfMonth(m, indexing)] ?? 0;
    return plusZero(s);
  });
}

/**
 * A start-of-bucket balance series over each period: the end of the period (the balance at the start of the month
 * after it, null when the series does not hold that month) and the mean of the period's start-of-month balances.
 */
export function rollBalance(balance: readonly number[], windows: readonly RollUpWindow[]): Array<{ end: number | null; average: number }> {
  return windows.map((w) => {
    let s = 0;
    for (let m = w.firstMonth; m <= w.lastMonth; m++) s += balance[m - 1] ?? 0;
    const next = balance[w.lastMonth];
    return { end: next === undefined ? null : plusZero(next), average: plusZero(s / w.months) };
  });
}

/** A rate per period, a ratio of sums annualised: sum(interest) / sum(start-of-month balance) x 12; null on a zero balance. */
export function rollRate(interest: readonly number[], balance: readonly number[], windows: readonly RollUpWindow[]): Array<number | null> {
  return windows.map((w) => {
    let num = 0;
    let den = 0;
    for (let m = w.firstMonth; m <= w.lastMonth; m++) {
      num += interest[m - 1] ?? 0;
      den += balance[m - 1] ?? 0;
    }
    return den === 0 ? null : plusZero((num / den) * 12);
  });
}

/** A stock (a running sum such as the cumulative gap) at the period's last month. */
export function rollStockAtEnd(series: readonly number[], windows: readonly RollUpWindow[]): Array<number | null> {
  return windows.map((w) => {
    const v = series[w.lastMonth - 1];
    return v === undefined ? null : plusZero(v);
  });
}

/** One period of a rolled gap ladder: the summed flows and the cumulative gap at the period's end. */
export interface RolledGapRow {
  assets: number;
  liabilities: number;
  gap: number;
  cumulativeGap: number | null;
}

/** A monthly gap ladder (one stored band per month) rolled into periods: flows summed, cumulative gap at the end. */
export function rollGapRows(rows: readonly GapBucketRow[], windows: readonly RollUpWindow[]): RolledGapRow[] {
  const assets = rollFlow(rows.map((r) => r.assets), windows);
  const liabilities = rollFlow(rows.map((r) => r.liabilities), windows);
  const gap = rollFlow(rows.map((r) => r.gap), windows);
  const cum = rollStockAtEnd(rows.map((r) => r.cumulativeGap), windows);
  return windows.map((_, i) => ({ assets: assets[i]!, liabilities: liabilities[i]!, gap: gap[i]!, cumulativeGap: cum[i]! }));
}

/** True when a ladder's stored user buckets are one band per month from month 1 (the only shape a period sum reads). */
export function isMonthlyLadder(u: { kind: string; rows: readonly GapBucketRow[] } | undefined): u is { kind: "monthly"; rows: GapBucketRow[] } {
  return u !== undefined && u.kind === "monthly" && u.rows.every((r, i) => r.band.startMonth === i && r.band.endMonth === i + 1);
}

export interface RolledFamily {
  familyId: ProductFamilyId;
  side: BalanceSheetSide;
  income: number[];
  expense: number[];
  net: number[];
  principal: number[];
  balanceEnd: Array<number | null>;
  balanceAverage: number[];
  /** Interest over balance, annualised (asset yield or liability cost); null on a derivative family or a zero balance. */
  rate: Array<number | null>;
  /** Originations of the family's new volume, by the month each tranche was made; absent when the scenario made none. */
  originations?: number[];
}

export interface RolledScenario {
  scenarioId: ScenarioId;
  income: number[];
  expense: number[];
  net: number[];
  byFamily: RolledFamily[];
  /**
   * The repricing and liquidity gap by period, read from the stored monthly buckets; absent when the run stored none.
   * The forecast arm is rolled the same way when the run stored it with monthly buckets (fix round L2).
   */
  gap?: { repricing?: RolledGapRow[]; liquidity?: RolledGapRow[]; forecastRepricing?: RolledGapRow[]; forecastLiquidity?: RolledGapRow[] };
}

export type RollUpReply =
  | {
      kind: "rolled";
      period: RollUpPeriod;
      alignment: RollUpAlignment;
      asOf: string;
      /** The months rolled (the run's grid, or fewer when asked). */
      months: number;
      periods: RollUpWindow[];
      rules: typeof ROLL_UP_RULES;
      byScenario: RolledScenario[];
    }
  | { kind: "absent"; reason: "no-netMonthly" | "stochastic" };

export interface RollUpOptions {
  period: RollUpPeriod;
  alignment?: RollUpAlignment;
  /** Roll the first n months only (for example the NII window); default the run's whole grid. */
  months?: number;
}

/**
 * The run's roll-up: NII income, expense and net by family and in total, each family's principal, balance (end and
 * average) and rate, its originations, and the repricing and liquidity gap where the run stored monthly buckets.
 * Every value is a sum, an end value or a ratio of sums of stored monthly numbers.
 */
export function rollUpRun(result: Pick<RunResult, "schemaVersion" | "cashflows" | "nii" | "gap">, coa: ChartOfAccounts, options: RollUpOptions): RollUpReply {
  const monthly = niiMonthly(result, coa);
  if (monthly.kind === "absent") return monthly;
  const grid = result.cashflows.grid;
  const months = options.months ?? grid.horizonMonths;
  if (!Number.isInteger(months) || months < 1 || months > grid.horizonMonths) {
    throw new RollUpOptionsError(`months must be a whole number from 1 to the run's grid of ${grid.horizonMonths}, got ${options.months}`);
  }
  const alignment = options.alignment ?? "cutoff";
  const windows = rollUpWindows(months, options.period, alignment, grid.asOf);
  const byScenario = monthly.byScenario.map((scn): RolledScenario => {
    const cfs = result.cashflows.byScenario.find((s) => s.scenarioId === scn.scenarioId);
    const nii = result.nii.byScenario.find((s) => s.scenarioId === scn.scenarioId);
    const byFamily = scn.byFamily.map((f): RolledFamily => {
      const series = cfs?.byFamily.find((x) => x.familyId === f.familyId)?.series;
      const balance = series?.balance ?? [];
      const bal = rollBalance(balance, windows);
      const orig = nii?.newBusiness?.find((n) => n.familyId === f.familyId)?.originations;
      return {
        familyId: f.familyId,
        side: f.side,
        income: rollFlow(f.income, windows),
        expense: rollFlow(f.expense, windows),
        net: rollFlow(f.net, windows),
        principal: rollFlow(series?.principal ?? [], windows),
        balanceEnd: bal.map((b) => b.end),
        balanceAverage: bal.map((b) => b.average),
        rate: f.side === DERIVATIVE_SIDE ? windows.map(() => null) : rollRate(series?.interest ?? [], balance, windows),
        ...(orig !== undefined ? { originations: rollFlow(orig, windows, "origination") } : {}),
      };
    });
    const rep = result.gap.repricing.find((g) => g.scenarioId === scn.scenarioId)?.userBuckets;
    const liq = result.gap.liquidity.find((g) => g.scenarioId === scn.scenarioId)?.userBuckets;
    const fRep = result.gap.forecast?.repricing.find((g) => g.scenarioId === scn.scenarioId)?.userBuckets;
    const fLiq = result.gap.forecast?.liquidity.find((g) => g.scenarioId === scn.scenarioId)?.userBuckets;
    const gap = {
      ...(isMonthlyLadder(rep) ? { repricing: rollGapRows(rep.rows, windows) } : {}),
      ...(isMonthlyLadder(liq) ? { liquidity: rollGapRows(liq.rows, windows) } : {}),
      ...(isMonthlyLadder(fRep) ? { forecastRepricing: rollGapRows(fRep.rows, windows) } : {}),
      ...(isMonthlyLadder(fLiq) ? { forecastLiquidity: rollGapRows(fLiq.rows, windows) } : {}),
    };
    return {
      scenarioId: scn.scenarioId,
      income: rollFlow(scn.income, windows),
      expense: rollFlow(scn.expense, windows),
      net: rollFlow(scn.net, windows),
      byFamily,
      ...(Object.keys(gap).length > 0 ? { gap } : {}),
    };
  });
  return { kind: "rolled", period: options.period, alignment, asOf: grid.asOf, months, periods: windows, rules: ROLL_UP_RULES, byScenario };
}
