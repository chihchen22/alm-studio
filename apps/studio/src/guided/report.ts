// apps/studio/src/guided/report.ts
/**
 * The guided Reports step's report builder (S2a spec point 9). The reader picks a metric, the scenarios, a horizon, a
 * granularity and a grouping; the table is read off the stored run result and nothing is recomputed: every cell is a
 * stored number, or a stored number summed over the families of one chart-of-accounts node (labelled so). Studio slice S2b-1 adds the new volume (its net interest income
 * by family, read off the stored line) and FTP (the stored block, opening book and new volume), each offered only when
 * the run stored it. Studio slice S2b-2 adds going-concern EVE beside run-off EVE and the forecast gap ladders (both
 * opt-in, each read off the stored block when the run stored it). A grouping the run did not store (per position, by
 * tag) is not built here: the page offers "re-run with this added".
 *
 * Studio slice S2b-3 adds quarterly and annual roll-ups, read through the engine's one roll-up reader
 * (`report/rollUp.ts`, the same module the server's route and CSV call): flows sum, balances show the end of the
 * period with the average beside it, rates are a ratio of sums annualised, the gap is summed from the stored monthly
 * buckets, and periods count from the cut-off unless the reader picks calendar periods. Value (EVE) and FTP offer no
 * roll-up. A "Balances and rates" metric shows each family's balances and rate by period.
 */
import { instrumentsBeforeParNote } from "@alm/engine/src/report/instrumentsNote";
import type { InstrumentsFile, PivotMetric, PivotResult, PortfolioSpec, RunResult } from "@alm/engine";
import { isMonthlyLadder, rollBalance, rollFlow, rollGapRows, rollUpRun, rollUpWindows, ROLL_UP_RULES, type RollUpAlignment, type RollUpWindow } from "@alm/engine/src/report/rollUp";
import { money } from "../format/figures";

export type Metric = "nii" | "eve" | "repricing" | "liquidity" | "repricing-forecast" | "liquidity-forecast" | "newvolume" | "ftp" | "balance";
export type Granularity = "horizon" | "monthly" | "quarterly" | "annual" | "buckets";

const isRollUp = (g: Granularity): g is "quarterly" | "annual" => g === "quarterly" || g === "annual";
const periodOf = (g: "quarterly" | "annual") => (g === "quarterly" ? ("quarter" as const) : ("year" as const));
export type Grouping = "total" | "family" | "account" | "position" | "tag";

export const METRIC_LABEL: Record<Metric, string> = {
  nii: "Net interest income",
  eve: "Economic value of equity",
  repricing: "Repricing gap",
  liquidity: "Liquidity gap",
  "repricing-forecast": "Repricing gap with new volume (forecast)",
  "liquidity-forecast": "Liquidity gap with new volume (forecast)",
  newvolume: "New volume",
  ftp: "Funds transfer pricing",
  balance: "Balances and rates",
};

/** Whether a run stored the new-volume detail: a scenario whose rules carried a product template. */
export function hasNewVolume(result: RunResult): boolean {
  return result.nii.byScenario.some((s) => (s.newBusiness ?? []).some((n) => n.netMonthly !== undefined));
}

/** The metrics a run can report: new volume only when it stored the detail, FTP only when it stored the block. */
export function metricsFor(result: RunResult): Metric[] {
  const all: Metric[] = ["nii", "eve", "repricing", "liquidity"];
  // The forecast arm only when the run opted in and stored it.
  if (result.gap.forecast !== undefined) all.push("repricing-forecast", "liquidity-forecast");
  if (hasNewVolume(result)) all.push("newvolume");
  if (result.ftp !== undefined && result.ftp !== null) all.push("ftp");
  // Balances and rates by quarter or year, on a run that stored its monthly net interest income (fix round L5).
  if (result.nii.byScenario.every((s) => s.netMonthly !== undefined)) all.push("balance");
  return all;
}
export const GROUPING_LABEL: Record<Grouping, string> = { total: "Whole balance sheet", family: "Family", account: "Account node", position: "Position", tag: "Tag" };
export const GRANULARITY_LABEL: Record<Granularity, string> = { horizon: "Horizon total", monthly: "Monthly", quarterly: "Quarterly", annual: "Annual", buckets: "Gap buckets" };

/** How roll-up periods are counted: from the cut-off (months 1 to 3 are the first quarter) or on the calendar. */
export const ALIGNMENT_LABEL: Record<RollUpAlignment, string> = { cutoff: "Counted from the cut-off", calendar: "Calendar quarters and years" };

export interface ReportChoice {
  metric: Metric;
  scenarios: string[];
  /** NII only: the horizon in months, one the run stored. */
  horizon: number;
  granularity: Granularity;
  grouping: Grouping;
  /** Monthly NII only: which group the months are shown for; "" is the whole book. */
  focus: string;
  /** Quarterly and annual only: periods from the cut-off (the default) or calendar periods. */
  alignment?: RollUpAlignment;
}

/** The granularities and groupings a metric offers. Position and tag are offered; whether the run stored them is the page's question. */
export function optionsFor(metric: Metric): { granularities: Granularity[]; groupings: Grouping[] } {
  if (metric === "nii") return { granularities: ["horizon", "monthly", "quarterly", "annual"], groupings: ["total", "family", "account", "position", "tag"] };
  // No roll-up of value; EVE is a present value, not a time series.
  if (metric === "eve") return { granularities: ["horizon"], groupings: ["total", "family", "account", "position", "tag"] };
  if (metric === "newvolume") return { granularities: ["horizon", "monthly", "quarterly", "annual"], groupings: ["total", "family"] };
  if (metric === "ftp") return { granularities: ["horizon"], groupings: ["family"] };
  if (metric === "balance") return { granularities: ["quarterly", "annual"], groupings: ["family", "tag"] };
  // The contractual gap ladders by tag read the run's view (the pivot's repricing and liquidity principal).
  const tag: Grouping[] = metric === "repricing" || metric === "liquidity" ? ["tag"] : [];
  return { granularities: ["buckets", "monthly", "quarterly", "annual"], groupings: ["total", "account", ...tag] };
}

/** A choice made valid for its metric: an unoffered granularity or grouping falls back to the first offered one. */
export function normalizeChoice(choice: ReportChoice, result: RunResult): ReportChoice {
  // A metric the run did not store (new volume, FTP) falls back to net interest income.
  const c = metricsFor(result).includes(choice.metric) ? choice : { ...choice, metric: "nii" as const };
  const o = optionsFor(c.metric);
  const ids = result.nii.byScenario.map((s) => s.scenarioId);
  const scenarios = c.scenarios.filter((s) => ids.includes(s));
  const horizons = result.nii.horizonsMonths;
  return {
    ...c,
    granularity: o.granularities.includes(c.granularity) ? c.granularity : o.granularities[0]!,
    grouping: o.groupings.includes(c.grouping) ? c.grouping : o.groupings[0]!,
    scenarios: scenarios.length > 0 ? scenarios : ids,
    horizon: horizons.includes(c.horizon) ? c.horizon : horizons[0] ?? 12,
  };
}

/** The reconciling row of a per-position report, and the sentence that says why it is there (fix round 1, M3). */
export const NEW_VOLUME_ROW = "New volume (not split by position)";
export const NEW_VOLUME_NOTE = "Each position carries only its own cash flows. New volume, added to keep a balance or reach a target, belongs to its family and not to a position, so it has its own line and the total agrees with the whole balance sheet.";

export interface ReportTable {
  title: string;
  /** The first column's heading (Family, Month, Band, ...), then one column per value. */
  rowHead: string;
  columns: string[];
  rows: Array<{ label: string; values: Array<number | null> }>;
  /** The total row, when one adds up; null otherwise. */
  total: { label: string; values: Array<number | null> } | null;
  /** "usd" money, "usd-month" money per month. */
  unit: "usd";
  /** Per row, when a table mixes rates with money (the FTP report): "rate" rows print as percent. Absent, every row is money. */
  rowUnits?: Array<"usd" | "rate">;
  notes: string[];
}

/** The root node of a family's leaf: the chart's top-level line it rolls up to. */
function rootOf(book: PortfolioSpec, familyId: string): { id: string; label: string } {
  const fam = book.coa.families.find((f) => f.id === familyId);
  const byId = new Map(book.coa.nodes.map((n) => [n.id, n]));
  let cur = fam === undefined ? undefined : byId.get(fam.coaNodeId);
  while (cur !== undefined && cur.parentId !== null && byId.has(cur.parentId)) cur = byId.get(cur.parentId);
  return cur === undefined ? { id: familyId, label: fam?.label ?? familyId } : { id: cur.id, label: cur.label };
}

const familyLabel = (book: PortfolioSpec, id: string): string => book.coa.families.find((f) => f.id === id)?.label ?? id;

function sumNullable(xs: Array<number | null>): number | null {
  return xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0);
}

/** Group rows by a key, summing value vectors; keeps first-seen order. */
function groupSum(rows: Array<{ key: string; label: string; values: Array<number | null> }>): Array<{ label: string; values: Array<number | null> }> {
  const out = new Map<string, { label: string; values: Array<number | null> }>();
  for (const r of rows) {
    const g = out.get(r.key);
    if (g === undefined) out.set(r.key, { label: r.label, values: [...r.values] });
    else g.values = g.values.map((v, i) => sumNullable([v, r.values[i]!]));
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Quarterly and annual roll-ups: every figure through the engine's roll-up reader
// ---------------------------------------------------------------------------

/** The periods of a roll-up choice over its first `months` months. */
function windowsOf(result: RunResult, c: ReportChoice, months: number): RollUpWindow[] {
  if (!isRollUp(c.granularity)) throw new Error("not a roll-up granularity");
  return rollUpWindows(months, periodOf(c.granularity), c.alignment ?? "cutoff", result.cashflows.grid.asOf);
}

/** The sentence every roll-up table opens its notes with: how the periods count, and the rules of the kinds it shows. */
function rollUpNotes(c: ReportChoice, result: RunResult, kinds: ReadonlyArray<keyof typeof ROLL_UP_RULES>): string[] {
  const counted = (c.alignment ?? "cutoff") === "calendar"
    ? `Calendar ${c.granularity === "quarterly" ? "quarters" : "years"}: a projection month belongs to the calendar month of its last day (cut-off ${result.cashflows.grid.asOf}), so a cut-off inside a period starts on a partial one.`
    : `${c.granularity === "quarterly" ? "Quarters" : "Years"} counted from the cut-off (${result.cashflows.grid.asOf}): months 1 to ${c.granularity === "quarterly" ? 3 : 12} are the first.`;
  return [counted, ...kinds.map((k) => ROLL_UP_RULES[k]), "A partial period is labelled so; its rate is annualised over its own months."];
}

const periodHead = (c: ReportChoice): string => (c.granularity === "quarterly" ? "Quarter" : "Year");

function niiRolled(result: RunResult, book: PortfolioSpec, c: ReportChoice): ReportTable {
  if (c.grouping === "position") throw new Error("per-position results store the first 12 months only; quarterly and annual periods read the families: group by family or account node");
  const months = Math.min(c.horizon, result.cashflows.grid.horizonMonths);
  const r = rollUpRun(result, book.coa, { period: periodOf(c.granularity as "quarterly" | "annual"), alignment: c.alignment ?? "cutoff", months });
  if (r.kind === "absent") throw new Error("this run stored no monthly net interest income to roll up");
  const scen = r.byScenario.filter((s) => c.scenarios.includes(s.scenarioId));
  const columns = scen.map((s) => s.scenarioId);
  const pick = (s: (typeof scen)[number], i: number): number | null => {
    if (c.focus === "") return s.net[i]!;
    const fams = s.byFamily.filter((f) => (c.grouping === "account" ? rootOf(book, f.familyId).id === c.focus : f.familyId === c.focus));
    return fams.length === 0 ? null : fams.reduce((a, f) => a + f.net[i]!, 0);
  };
  const rows = r.periods.map((p, i) => ({ label: p.label, values: scen.map((s) => pick(s, i)) }));
  const focusLabel = c.focus === "" ? "the whole balance sheet" : c.grouping === "account" ? book.coa.nodes.find((n) => n.id === c.focus)?.label ?? c.focus : familyLabel(book, c.focus);
  const notes = rollUpNotes(c, result, ["flows"]);
  if (c.focus !== "" && c.grouping === "account") notes.push("An account node's figure is the sum of its families' rolled figures.");
  return {
    title: `Net interest income by ${periodHead(c).toLowerCase()}, first ${months} months, ${focusLabel}`,
    rowHead: periodHead(c),
    columns,
    rows,
    total: { label: `Total, ${months} months`, values: columns.map((_, i) => sumNullable(rows.map((x) => x.values[i]!))) },
    unit: "usd",
    notes,
  };
}

function newVolumeRolled(result: RunResult, book: PortfolioSpec, c: ReportChoice): ReportTable {
  const months = Math.min(c.horizon, result.cashflows.grid.horizonMonths);
  const w = windowsOf(result, c, months);
  const scen = result.nii.byScenario.filter((s) => c.scenarios.includes(s.scenarioId));
  const columns = scen.map((s) => s.scenarioId);
  const lines = (s: (typeof scen)[number]) => (s.newBusiness ?? []).filter((n) => n.netMonthly !== undefined && (c.focus === "" || n.familyId === c.focus));
  const rows: ReportTable["rows"] = [];
  const nii = scen.map((s) => lines(s).map((n) => rollFlow(n.netMonthly!, w)));
  // Ruling 46: originations index k is the tranche made at the end of month k, so a period of months a .. b holds k = a .. b.
  const made = scen.map((s) => lines(s).map((n) => rollFlow(n.originations, w, "origination")));
  w.forEach((p, i) => {
    rows.push({ label: `${p.label}: net interest income`, values: nii.map((ls) => (ls.length === 0 ? null : ls.reduce((a, x) => a + x[i]!, 0))) });
    rows.push({ label: `${p.label}: made`, values: made.map((ls) => (ls.length === 0 ? null : ls.reduce((a, x) => a + x[i]!, 0))) });
  });
  const focus = c.focus === "" ? "all families" : familyLabel(book, c.focus);
  const total = nii.map((ls) => (ls.length === 0 ? null : ls.reduce((a, x) => a + x.reduce((p, q) => p + q, 0), 0)));
  return {
    title: `New volume by ${periodHead(c).toLowerCase()}, first ${months} months, ${focus}`,
    rowHead: `${periodHead(c)} and line`,
    columns,
    rows,
    total: { label: `New volume net interest income, ${months} months`, values: total },
    unit: "usd",
    notes: [...rollUpNotes(c, result, ["flows", "window"]), NEW_VOLUME_NII_NOTE],
  };
}

/** The family a balance report opens on: the one asked for, else the first with a balance. */
function balanceFocus(result: RunResult, book: PortfolioSpec, focus: string): string {
  if (focus !== "" && book.coa.families.some((f) => f.id === focus)) return focus;
  const first = result.cashflows.byScenario[0]?.byFamily.find((f) => (f.series.balance[0] ?? 0) !== 0);
  return first?.familyId ?? book.coa.families[0]?.id ?? "";
}

function balanceTable(result: RunResult, book: PortfolioSpec, c: ReportChoice): ReportTable {
  if (!isRollUp(c.granularity)) throw new Error("balances and rates read by quarter or by year");
  const months = Math.min(c.horizon, result.cashflows.grid.horizonMonths);
  const r = rollUpRun(result, book.coa, { period: periodOf(c.granularity), alignment: c.alignment ?? "cutoff", months });
  if (r.kind === "absent") throw new Error("this run stored no monthly series to roll up");
  const fam = balanceFocus(result, book, c.focus);
  const scen = r.byScenario.filter((s) => c.scenarios.includes(s.scenarioId));
  const columns = scen.map((s) => s.scenarioId);
  const of = (s: (typeof scen)[number]) => s.byFamily.find((f) => f.familyId === fam);
  const side = book.coa.families.find((f) => f.id === fam)?.side;
  const rows: ReportTable["rows"] = [];
  const units: Array<"usd" | "rate"> = [];
  r.periods.forEach((p, i) => {
    rows.push({ label: `${p.label}: balance at the end`, values: scen.map((s) => of(s)?.balanceEnd[i] ?? null) });
    units.push("usd");
    rows.push({ label: `${p.label}: average balance`, values: scen.map((s) => of(s)?.balanceAverage[i] ?? null) });
    units.push("usd");
    rows.push({ label: `${p.label}: ${side === "liability" ? "cost" : "yield"}, annualised`, values: scen.map((s) => of(s)?.rate[i] ?? null) });
    units.push("rate");
  });
  return {
    title: `${familyLabel(book, fam)}: balances and ${side === "liability" ? "cost" : "yield"} by ${periodHead(c).toLowerCase()}, first ${months} months`,
    rowHead: `${periodHead(c)} and line`,
    columns,
    rows,
    total: null,
    unit: "usd",
    rowUnits: units,
    notes: [...rollUpNotes(c, result, ["balances", "rates"]), "The last period's end balance is not stored when the period ends on the projection's last month."],
  };
}

function gapRolled(result: RunResult, c: ReportChoice, ladders: RunResult["gap"]["repricing"], title: string, notes: string[]): ReportTable {
  if (c.grouping === "account") throw new Error("account nodes carry the nine standard buckets only; quarterly and annual periods read the whole balance sheet's monthly buckets, so choose Whole balance sheet");
  const monthly = ladders.map((g) => (isMonthlyLadder(g.userBuckets) ? g.userBuckets.rows : null));
  if (monthly.some((m) => m === null)) throw new Error("monthly buckets are not stored for this run");
  // Fix round L2: the gap is rolled over the chosen earnings horizon, as the other roll-ups are, never past the buckets.
  const months = Math.min(monthly[0]?.length ?? 0, c.horizon);
  if (months === 0) throw new Error("monthly buckets are not stored for this run");
  const w = windowsOf(result, c, months);
  const rolled = monthly.map((m) => rollGapRows(m!, w));
  const columns = ladders.map((g) => g.scenarioId);
  const rows: ReportTable["rows"] = [];
  const gaps: ReportTable["rows"] = [];
  w.forEach((p, i) => {
    const row = { label: `${p.label}: gap`, values: rolled.map((r) => r[i]!.gap) };
    rows.push(row);
    gaps.push(row);
    rows.push({ label: `${p.label}: cumulative gap at the end`, values: rolled.map((r) => r[i]!.cumulativeGap) });
  });
  return {
    title: `${title}, by ${periodHead(c).toLowerCase()}`,
    rowHead: `${periodHead(c)} and line`,
    columns,
    rows,
    total: { label: "Sum of the periods' gaps", values: columns.map((_, i) => sumNullable(gaps.map((g) => g.values[i]!))) },
    unit: "usd",
    notes: [...notes, ...rollUpNotes(c, result, ["flows"]), "The quarterly or annual gap is the sum of the stored monthly buckets; the cumulative gap is its value at the period's last month."],
  };
}

function niiTable(result: RunResult, book: PortfolioSpec, c: ReportChoice, instruments: InstrumentsFile | null): ReportTable {
  if (isRollUp(c.granularity)) return niiRolled(result, book, c);
  const scen = result.nii.byScenario.filter((s) => c.scenarios.includes(s.scenarioId));
  const h = c.horizon;
  const columns = scen.map((s) => s.scenarioId);
  const notes: string[] = [];
  if (c.granularity === "monthly") {
    const months = c.horizon;
    const rows: ReportTable["rows"] = [];
    for (let m = 0; m < months; m++) {
      const values = scen.map((s) => {
        if (c.focus === "") return s.netMonthly?.[m] ?? null;
        const fams = s.byFamily.filter((f) => (c.grouping === "account" ? rootOf(book, f.familyId).id === c.focus : f.familyId === c.focus));
        return fams.length === 0 ? null : sumNullable(fams.map((f) => f.netMonthly?.[m] ?? null));
      });
      rows.push({ label: `Month ${m + 1}`, values });
    }
    const focusLabel = c.focus === "" ? "the whole balance sheet" : c.grouping === "account" ? book.coa.nodes.find((n) => n.id === c.focus)?.label ?? c.focus : familyLabel(book, c.focus);
    return { title: `Net interest income by month, first ${months} months, ${focusLabel}`, rowHead: "Month", columns, rows, total: { label: `Total, ${months} months`, values: columns.map((_, i) => sumNullable(rows.map((r) => r.values[i]!))) }, unit: "usd", notes };
  }
  const total = { label: "Whole balance sheet", values: scen.map((s) => s.totalNetByHorizon?.[h] ?? (c.horizon === 12 ? s.totalNet12 : c.horizon === 24 ? s.totalNet24 : null)) };
  if (c.grouping === "total") return { title: `Net interest income over ${c.horizon} months`, rowHead: "", columns, rows: [], total, unit: "usd", notes };
  if (c.grouping === "position") {
    if (instruments === null) throw new Error("per-position results are not stored for this run");
    if (c.horizon !== 12) notes.push("Per-position results store the first 12 months of net interest income; the horizon reads 12 months here.");
    const rows = instruments.positions.map((p) => ({ label: p.positionId, values: scen.map((s) => p.byScenario.find((r) => r.scenarioId === s.scenarioId)?.nii12 ?? null) }));
    // Fix round 1, M3: positions carry their own cash flows only; new volume belongs to its family. The difference to the
    // stored whole-book 12-month figure is shown on its own line, so the total agrees with the whole book.
    const sums = columns.map((_, i) => sumNullable(rows.map((r) => r.values[i]!)));
    const book12 = scen.map((s) => s.totalNet12 ?? null);
    const gap = book12.map((t, i) => (t === null || sums[i] === null ? null : t - sums[i]!));
    if (gap.some((g) => g !== null && Math.abs(g) >= 0.005)) {
      rows.push({ label: NEW_VOLUME_ROW, values: gap });
      notes.push(NEW_VOLUME_NOTE);
    }
    return { title: "Net interest income over 12 months by position", rowHead: "Position", columns, rows, total: { label: "Whole balance sheet", values: book12 }, unit: "usd", notes };
  }
  const famRows = book.coa.families.map((f) => ({
    key: c.grouping === "account" ? rootOf(book, f.id).id : f.id,
    label: c.grouping === "account" ? rootOf(book, f.id).label : f.label,
    values: scen.map((s) => s.byFamily.find((x) => x.familyId === f.id)?.byHorizon?.[h]?.net ?? null),
  })).filter((r) => r.values.some((v) => v !== null));
  const rows = c.grouping === "account" ? groupSum(famRows) : famRows.map(({ label, values }) => ({ label, values }));
  if (c.grouping === "account") notes.push("An account node's figure is the sum of its families' stored figures.");
  if (c.grouping === "family" && hasNewVolume(result)) {
    // Each family's new volume on its own line under the family, the stored monthly line summed to the horizon.
    const withLines: ReportTable["rows"] = [];
    for (const r of famRows) {
      withLines.push({ label: r.label, values: r.values });
      const nv = scen.map((s) => newVolumeOver(s, r.key, h));
      if (nv.some((v) => v !== null)) withLines.push({ label: `${r.label}: of which new volume`, values: nv });
    }
    notes.push(NEW_VOLUME_NII_NOTE);
    return { title: `Net interest income over ${c.horizon} months by family`, rowHead: GROUPING_LABEL[c.grouping], columns, rows: withLines, total, unit: "usd", notes };
  }
  return { title: `Net interest income over ${c.horizon} months by ${c.grouping === "account" ? "account node" : "family"}`, rowHead: GROUPING_LABEL[c.grouping], columns, rows, total, unit: "usd", notes };
}

/** The note every new-volume figure carries: what it is, and that it is not the regulatory measure. */
export const NEW_VOLUME_NII_NOTE = "New volume is what the run made to keep a balance or reach a target, as each family's product. Its net interest income is a management view: the regulatory change in net interest income holds the balance sheet constant.";

/** A family's stored new-volume net interest summed over the first h months; null when the scenario stored no line for it. */
function newVolumeOver(s: RunResult["nii"]["byScenario"][number], familyId: string, h: number): number | null {
  const line = s.newBusiness?.find((n) => n.familyId === familyId)?.netMonthly;
  if (line === undefined) return null;
  let sum = 0;
  for (let k = 0; k < Math.min(h, line.length); k++) sum += line[k]!;
  return sum;
}

/** One family's product in words, as the run stored it. A deposit product, and the behavior note when stored. */
export function productText(p: NonNullable<NonNullable<RunResult["nii"]["byScenario"][number]["newBusiness"]>[number]["product"]>): string {
  const behavior = p.behavior === undefined ? "" : ` ${p.behavior.note}`;
  if (p.rateType === "deposit") return `a new deposit at the family's own rate, running off by its decay model, over ${p.termMonths} months.${behavior}`;
  const rate = p.rateType === "fixed"
    ? p.fixedIndex === "matched" ? "fixed rate at its matched funding rate" : `fixed rate off the ${p.indexTenorMonths}-month swap rate`
    : p.indexTenorMonths === 1 ? "floating rate on the one-month rate, resetting monthly" : `floating rate on the ${p.indexTenorMonths}-month rate, resetting every ${p.indexTenorMonths} months`;
  const repay = p.amortization === "bullet" ? "repaid at maturity" : p.amortization === "level-pay" ? "level payment" : "equal principal each month";
  const spread = `${p.spreadOverIndexBp >= 0 ? "+" : ""}${p.spreadOverIndexBp} bp`;
  return `${rate}, ${repay}, ${p.termMonths} month${p.termMonths === 1 ? "" : "s"}, ${spread}${p.source === "fixed-bullet" ? " (today's rule)" : ""}.${behavior}`;
}

function newVolumeTable(result: RunResult, book: PortfolioSpec, c: ReportChoice): ReportTable {
  if (!hasNewVolume(result)) throw new Error("this run stored no new-volume detail: set the products on the New volume step and run again");
  if (isRollUp(c.granularity)) return newVolumeRolled(result, book, c);
  const scen = result.nii.byScenario.filter((s) => c.scenarios.includes(s.scenarioId));
  const columns = scen.map((s) => s.scenarioId);
  const h = c.horizon;
  const fams = book.coa.families.filter((f) => scen.some((s) => s.newBusiness?.some((n) => n.familyId === f.id && n.netMonthly !== undefined)));
  const notes = [NEW_VOLUME_NII_NOTE];
  const first = scen.find((s) => s.newBusiness !== undefined);
  for (const f of fams) {
    const p = first?.newBusiness?.find((n) => n.familyId === f.id)?.product;
    if (p !== undefined) notes.push(`${f.label}: ${productText(p)}`);
  }
  if (c.granularity === "monthly") {
    const rows: ReportTable["rows"] = [];
    for (let m = 0; m < h; m++) {
      rows.push({
        label: `Month ${m + 1}`,
        values: scen.map((s) => {
          const lines = (s.newBusiness ?? []).filter((n) => n.netMonthly !== undefined && (c.focus === "" || n.familyId === c.focus));
          return lines.length === 0 ? null : lines.reduce((a, n) => a + n.netMonthly![m]!, 0);
        }),
      });
    }
    const focus = c.focus === "" ? "all families" : familyLabel(book, c.focus);
    return { title: `Net interest income of new volume by month, first ${h} months, ${focus}`, rowHead: "Month", columns, rows, total: { label: `Total, ${h} months`, values: columns.map((_, i) => sumNullable(rows.map((r) => r.values[i]!))) }, unit: "usd", notes };
  }
  const nvTotal = scen.map((s) => sumNullable(fams.map((f) => newVolumeOver(s, f.id, h))));
  const stored = scen.map((s) => s.totalNetByHorizon?.[h] ?? (h === 12 ? s.totalNet12 : h === 24 ? s.totalNet24 : null));
  if (c.grouping === "total") {
    const held = stored.map((t, i) => (t === null || nvTotal[i] === null ? null : t - nvTotal[i]!));
    return {
      title: `Net interest income over ${h} months: the balance sheet held today and the new volume`,
      rowHead: "",
      columns,
      rows: [
        { label: "Balance sheet held today, run off (whole book less new volume, derived)", values: held },
        { label: "New volume", values: nvTotal },
      ],
      total: { label: "Whole balance sheet", values: stored },
      unit: "usd",
      notes,
    };
  }
  const rows: ReportTable["rows"] = [];
  for (const f of fams) {
    rows.push({ label: `${f.label}: net interest income`, values: scen.map((s) => newVolumeOver(s, f.id, h)) });
    rows.push({
      label: `${f.label}: made over ${h} months`,
      values: scen.map((s) => {
        const o = s.newBusiness?.find((n) => n.familyId === f.id)?.originations;
        // Ruling 46: originations[k] is the tranche made at the end of month k (index 0 is always 0: the sweep never
        // mints at 0), so "made over h months" is months 1 .. h, indices 1 .. h, as going-concern EVE counts them.
        return o === undefined ? null : o.slice(1, h + 1).reduce((a, b) => a + b, 0);
      }),
    });
  }
  return { title: `New volume over ${h} months by family`, rowHead: "Family", columns, rows, total: { label: "All new volume, net interest income", values: nvTotal }, unit: "usd", notes };
}

function ftpTable(result: RunResult, book: PortfolioSpec): ReportTable {
  const ftp = result.ftp;
  if (ftp === undefined || ftp === null) throw new Error("this run stored no FTP block");
  const rows: ReportTable["rows"] = [];
  const units: Array<"usd" | "rate"> = [];
  const push = (label: string, v: number | null | undefined, unit: "usd" | "rate") => { rows.push({ label, values: [v ?? null] }); units.push(unit); };
  // Fix round M2: the new volume's headline rows sit on the earnings window, rates weighted by the volume made in it;
  // the whole projection's figures follow, labelled so; the opening book's dollars are its first 12 months.
  const years = Math.round((result.cashflows?.grid?.horizonMonths ?? 360) / 12);
  let windowMonths: number | null = null;
  let windowTotal = 0;
  for (const r of ftp.byFamily) {
    if (r.positionCount === 0 && r.newVolume === undefined) continue;
    const label = familyLabel(book, r.familyId);
    push(`${label}: balance sheet held today, margin over the first 12 months`, r.margin12, "usd");
    push(`${label}: balance sheet held today, transfer rate (the book at the cut-off)`, r.allInFtpRate, "rate");
    const nv = r.newVolume;
    if (nv === undefined) continue;
    const w = nv.window;
    windowMonths = w.months;
    windowTotal += w.margin;
    push(`${label}: new volume made in the first ${w.months} months`, w.notional, "usd");
    push(`${label}: new volume coupon, made in the first ${w.months} months`, w.couponRate, "rate");
    push(`${label}: new volume transfer rate at origination, made in the first ${w.months} months`, w.allInFtpRate, "rate");
    push(`${label}: new volume margin, made in the first ${w.months} months`, w.ftpMarginRate, "rate");
    push(`${label}: new volume margin over the first ${w.months} months`, w.margin, "usd");
    push(`${label}: new volume made over the full ${years}-year projection`, nv.notional, "usd");
    push(`${label}: new volume margin, made over the full ${years}-year projection`, nv.ftpMarginRate, "rate");
  }
  const b = ftp.nimBridge.newVolume;
  const notes = [
    "Transfer pricing is computed for the base scenario only. Each new tranche is priced in the month it is made, on the base curve's forwards from that month, with the term liquidity premium as it stands today; its transfer rate is locked for its life (a floater's refixes at each reset).",
    `The new volume's rates are weighted by the volume made: the headline rows over the tranches made in the earnings window (the first ${windowMonths ?? "N"} months), beside its dollars over the same months; the last two rows of each family cover every tranche made over the full ${years}-year projection, where later tranches read forwards far out the curve. Margins read positive on both sides (assets: coupon less transfer rate; liabilities: transfer rate less coupon).`,
  ];
  if (b !== undefined) notes.push(`The new volume's 12-month margins and the funding centre's take re-sum to its 12-month net interest income: lending ${money(b.lendingMargin12)}, funding ${money(b.fundingMargin12)}, centre ${money(b.mismatchCenter12)}, total ${money(b.net12)} (full precision in the CSV export of the run's FTP table).`);
  return {
    title: "Funds transfer pricing by family: the balance sheet held today and the new volume",
    rowHead: "Family and line",
    columns: [ftp.scenarioId],
    rows,
    total: windowMonths === null ? null : { label: `New volume margins over the first ${windowMonths} months, all families (the sum of the families' stored figures)`, values: [windowTotal] },
    unit: "usd",
    rowUnits: units,
    notes,
  };
}

/** The span a stored going-concern block counts, in plain words (ruling 2026-11-03: 12 months by default). */
export function goingConcernSpanText(gc: NonNullable<RunResult["eve"]["goingConcern"]>): string {
  const m = gc.span.months;
  return `new volume made in the first ${m} month${m === 1 ? "" : "s"}`;
}

/**
 * The one plain sentence the Reports step puts beside the two values (S2b-2 spec point 3, fix round M4): what
 * going-concern EVE adds, over which span, and which of the two is the regulatory measure.
 */
export function goingConcernDifference(gc: NonNullable<RunResult["eve"]["goingConcern"]>): string {
  return `Run-off EVE values only the balance sheet held today; going-concern EVE adds the value of the ${goingConcernSpanText(gc)} by your plan, each tranche over its full life, so the gap between them is what that new business is worth on the same discount basis, and run-off EVE stays the regulatory measure.`;
}

function eveTable(result: RunResult, book: PortfolioSpec, c: ReportChoice, instruments: InstrumentsFile | null): ReportTable {
  const scen = result.eve.byScenario.filter((s) => c.scenarios.includes(s.scenarioId));
  const columns = scen.map((s) => s.scenarioId);
  const gc = result.eve.goingConcern;
  const gcOf = (id: string) => gc?.byScenario.find((g) => g.scenarioId === id);
  const total = { label: gc === undefined ? "EVE (assets less liabilities)" : "Run-off EVE (assets less liabilities, the regulatory measure)", values: scen.map((s) => s.eve) };
  const notes = ["Present values are on the run's discount basis at the cut-off date."];
  if (gc !== undefined) notes.push(goingConcernDifference(gc), gc.note);
  if (c.grouping === "total") {
    const rows: ReportTable["rows"] = [
      { label: "Present value of assets", values: scen.map((s) => s.pvAssets) },
      { label: "Present value of liabilities", values: scen.map((s) => s.pvLiabilities) },
      { label: "Change from the base", values: scen.map((s) => s.deltaEveVsBase) },
    ];
    if (gc !== undefined) {
      // Going-concern EVE beside run-off EVE, each a stored number.
      rows.push(
        { label: `Value of the ${goingConcernSpanText(gc)} (going concern)`, values: scen.map((s) => gcOf(s.scenarioId)?.newVolumeValue ?? null) },
        { label: "Going-concern EVE (run-off EVE plus the new volume's value)", values: scen.map((s) => gcOf(s.scenarioId)?.eve ?? null) },
        { label: "Going-concern change from the base", values: scen.map((s) => gcOf(s.scenarioId)?.deltaEveVsBase ?? null) },
      );
    }
    return { title: gc === undefined ? "Economic value of equity" : "Economic value of equity: run-off and going concern", rowHead: "", columns, rows, total, unit: "usd", notes };
  }
  if (c.grouping === "position") {
    if (instruments === null) throw new Error("per-position results are not stored for this run");
    const rows = instruments.positions.map((p) => ({ label: `${p.positionId} (${p.side})`, values: scen.map((s) => p.byScenario.find((r) => r.scenarioId === s.scenarioId)?.pv ?? null) }));
    // Spec P1, slice K1: an older file's balances held at book read 0, and the table says so.
    const older = instrumentsBeforeParNote(instruments);
    return { title: "Present value by position", rowHead: "Position", columns, rows, total, unit: "usd", notes: [...notes, "Each position's present value is shown as stored, without a side sign; EVE is assets less liabilities.", ...(older === null ? [] : [older])] };
  }
  const famRows = book.coa.families.map((f) => ({
    key: c.grouping === "account" ? rootOf(book, f.id).id : f.id,
    label: c.grouping === "account" ? rootOf(book, f.id).label : `${f.label} (${f.side})`,
    values: scen.map((s) => s.byFamily.find((x) => x.familyId === f.id)?.pv ?? null),
  })).filter((r) => r.values.some((v) => v !== null));
  const rows = c.grouping === "account" ? groupSum(famRows) : famRows.map(({ label, values }) => ({ label, values }));
  if (gc !== undefined && c.grouping === "family") {
    // Each family's new-volume value under its family, signed as it adds to EVE.
    const withLines: ReportTable["rows"] = [];
    book.coa.families.forEach((f) => {
      const r = rows.find((x) => x.label === `${f.label} (${f.side})`);
      if (r !== undefined) withLines.push(r);
      const v = scen.map((s) => gcOf(s.scenarioId)?.byFamily.find((x) => x.familyId === f.id)?.value ?? null);
      if (v.some((x) => x !== null)) withLines.push({ label: `${f.label}: new volume value, as it adds to EVE (going concern)`, values: v });
    });
    return { title: "Present value by family, with the new volume's value", rowHead: GROUPING_LABEL[c.grouping], columns, rows: withLines, total, unit: "usd", notes: [...notes, "Each line's present value is shown as stored, without a side sign; EVE is assets less liabilities. A new-volume line is signed as it adds to EVE."] };
  }
  return { title: `Present value by ${c.grouping === "account" ? "account node" : "family"}`, rowHead: GROUPING_LABEL[c.grouping], columns, rows, total, unit: "usd", notes: [...notes, "Each line's present value is shown as stored, without a side sign; EVE is assets less liabilities."] };
}

function gapTable(result: RunResult, book: PortfolioSpec, c: ReportChoice): ReportTable {
  // The forecast arm reads its own stored ladders; the contractual ones stay the default view.
  const forecast = c.metric === "repricing-forecast" || c.metric === "liquidity-forecast";
  if (forecast && result.gap.forecast === undefined) throw new Error("this run stored no forecast gap: turn it on on the Simulation step and run again");
  const source = c.metric === "repricing" ? result.gap.repricing
    : c.metric === "liquidity" ? result.gap.liquidity
      : c.metric === "repricing-forecast" ? result.gap.forecast!.repricing : result.gap.forecast!.liquidity;
  const ladders = source.filter((g) => c.scenarios.includes(g.scenarioId));
  const notes: string[] = forecast ? [result.gap.forecast!.note, "The contractual ladders (Repricing gap, Liquidity gap) run the balance sheet held today off and stay the default view."] : [];
  if (isRollUp(c.granularity)) return gapRolled(result, c, ladders, METRIC_LABEL[c.metric], notes);
  const pick = (g: (typeof ladders)[number]) => {
    if (c.granularity === "monthly") {
      if (g.userBuckets === undefined) return null;
      return g.userBuckets.rows;
    }
    return g.rows;
  };
  const first = ladders[0];
  const bands = first === undefined ? [] : pick(first);
  if (bands === null) throw new Error("monthly buckets are not stored for this run");
  const columns = ladders.map((g) => g.scenarioId);
  const title = `${METRIC_LABEL[c.metric]}, ${c.granularity === "monthly" ? "by month" : "by bucket"}`;
  if (c.grouping === "account") {
    const roots = book.coa.nodes.filter((n) => n.parentId === null);
    const rows: ReportTable["rows"] = [];
    for (const root of roots) {
      const per = ladders.map((g) => g.byCoaNode?.find((x) => x.coaNodeId === root.id)?.rows ?? null);
      if (per.every((p) => p === null)) continue;
      (per[0] ?? []).forEach((row, i) => rows.push({ label: `${root.label}, ${row.band.label}`, values: per.map((p) => p?.[i]?.gap ?? null) }));
    }
    notes.push("Account nodes carry the nine standard buckets.");
    return { title: `${METRIC_LABEL[c.metric]} by account node and bucket`, rowHead: "Node and bucket", columns, rows, total: null, unit: "usd", notes };
  }
  const rows = bands.map((b, i) => ({ label: b.band.label, values: ladders.map((g) => pick(g)?.[i]?.gap ?? null) }));
  return { title, rowHead: c.granularity === "monthly" ? "Month" : "Bucket", columns, rows, total: { label: "Sum of buckets", values: columns.map((_, i) => sumNullable(rows.map((r) => r.values[i]!))) }, unit: "usd", notes };
}

/** The table a choice reads off one stored run. Throws a sentence when the run did not store what the choice needs. */
export function buildReport(result: RunResult, book: PortfolioSpec, choice: ReportChoice, instruments: InstrumentsFile | null = null): ReportTable {
  const c = normalizeChoice(choice, result);
  if (c.grouping === "tag") throw new Error("the tag grouping reads the run's view, not this table");
  if (c.metric === "nii") return niiTable(result, book, c, instruments);
  if (c.metric === "eve") return eveTable(result, book, c, instruments);
  if (c.metric === "newvolume") return newVolumeTable(result, book, c);
  if (c.metric === "ftp") return ftpTable(result, book);
  if (c.metric === "balance") return balanceTable(result, book, c);
  return gapTable(result, book, c);
}

// ---------------------------------------------------------------------------
// By tag (S2b-3 spec point 3): every pivot metric, read from the run's view by one tag
// ---------------------------------------------------------------------------

/** The pivot's seven metrics in plain words, in the pivot's own order. */
export const TAG_MEASURE_LABEL: Record<PivotMetric, string> = {
  balance: "Balance outstanding",
  principal: "Principal cash flow",
  interest: "Interest cash flow",
  repricing: "Repricing gap",
  gapPrincipal: "Liquidity gap (principal)",
  nii: "Net interest income",
  evePv: "Present value, without a side sign",
};

/** The pivot measures that read a scenario's cells: absent on a scenario with new volume (a dynamic projection stores no cell arm). */
export const CELL_MEASURES: readonly PivotMetric[] = ["balance", "principal", "interest", "nii"];

/** The one sentence a run with new volume shows beside the tag measures it offers (fix round M1). */
export const NEW_VOLUME_TAG_NOTE =
  "On a run with new volume, balances, cash flows and net interest income are not reported by tag: new volume belongs to its family, not to a tag, so the run stores those figures by family only. Value and the gap ladders by tag are offered.";

/**
 * The tag measures a run offers on the chosen scenarios (fix round M1): all seven when every chosen scenario stored its
 * cells, else the three the run stores by tag on every scenario (value and the two gap ladders), with the sentence why.
 */
export function tagMeasuresOn(result: Pick<RunResult, "cashflows">, scenarios: readonly string[]): { measures: PivotMetric[]; note: string | null } {
  const dynamic = result.cashflows.byScenario.some((s) => scenarios.includes(s.scenarioId) && s.byCell === undefined);
  return dynamic ? { measures: PIVOT_METRICS_ORDER.filter((m) => !CELL_MEASURES.includes(m)), note: NEW_VOLUME_TAG_NOTE } : { measures: [...PIVOT_METRICS_ORDER], note: null };
}

const PIVOT_METRICS_ORDER: readonly PivotMetric[] = ["balance", "principal", "interest", "repricing", "gapPrincipal", "nii", "evePv"];

/** The tag measure a report metric opens on; the reader may pick any of the seven. */
export function tagMeasureFor(metric: Metric): PivotMetric {
  if (metric === "eve") return "evePv";
  if (metric === "repricing" || metric === "repricing-forecast") return "repricing";
  if (metric === "liquidity" || metric === "liquidity-forecast") return "gapPrincipal";
  if (metric === "balance") return "balance";
  return "nii";
}

/**
 * A report by tag off one pivot per scenario of the run's view (stored cells summed by group, nothing recomputed).
 * Bucketed measures read the first `months` months: a flow is their sum, a balance its value at the cut-off; by
 * quarter or year they go through the engine's roll-up reader. Gap measures show each tag's bands; net interest
 * income shows 12 months (24 when the horizon reaches it); present value is the unsigned group sum.
 */
export function tagTable(pivots: readonly PivotResult[], measure: PivotMetric, tagLabel: string, opts: { months: number; granularity: Granularity; alignment?: RollUpAlignment; asOf: string }): ReportTable {
  const columns = pivots.map((p) => p.scenarioId);
  const keys = new Map<string, string>();
  for (const p of pivots) for (const r of p.rows) keys.set(JSON.stringify(r.key), Object.values(r.key).map((v) => (Array.isArray(v) ? v.join(" | ") : v)).join(", "));
  const rowOf = (p: PivotResult, k: string) => p.rows.find((x) => JSON.stringify(x.key) === k);
  const rows: ReportTable["rows"] = [];
  const notes = ["Read from the run's view by this tag: stored cells summed by group, nothing recomputed."];
  let total: ReportTable["total"] = null;
  if (measure === "nii" || measure === "evePv") {
    const twelve = measure === "nii" && opts.months < 24;
    for (const [k, l] of keys) {
      rows.push({ label: l, values: pivots.map((p) => { const r = rowOf(p, k); return r === undefined ? null : measure === "evePv" ? r.value ?? null : (twelve ? r.nii?.net12 : r.nii?.net24) ?? null; }) });
    }
    total = { label: "All positions", values: columns.map((_, i) => sumNullable(rows.map((r) => r.values[i]!))) };
    if (measure === "nii") notes.push(`Net interest income over ${twelve ? 12 : 24} months: the view stores the 12 and 24-month figures by tag. New volume belongs to its family, not to a tag, so the sum is the positions' own.`);
    else notes.push("Each group's present value is the sum of its positions' values without a side sign: a group holding assets and liabilities adds them. EVE is the run's own figure on the Value report.");
    return { title: `${TAG_MEASURE_LABEL[measure]} by ${tagLabel}`, rowHead: tagLabel, columns, rows, total, unit: "usd", notes };
  }
  if (measure === "repricing" || measure === "gapPrincipal") {
    const bands = pivots[0]?.bands ?? [];
    for (const [k, l] of keys) bands.forEach((b, i) => rows.push({ label: `${l}, ${b.label}`, values: pivots.map((p) => rowOf(p, k)?.series?.[i] ?? null) }));
    notes.push("Each tag's gap in the run's nine standard buckets, positions only.");
    return { title: `${TAG_MEASURE_LABEL[measure]} by ${tagLabel} and bucket`, rowHead: `${tagLabel} and bucket`, columns, rows, total: null, unit: "usd", notes };
  }
  // balance, principal, interest: bucketed series, each group's positions added without a side sign.
  notes.push("Each group adds its positions' figures without a side sign: a group holding assets and liabilities adds both.");
  if (isRollUp(opts.granularity)) {
    const w = rollUpWindows(opts.months, periodOf(opts.granularity), opts.alignment ?? "cutoff", opts.asOf);
    for (const [k, l] of keys) {
      const per = pivots.map((p) => rowOf(p, k)?.series);
      w.forEach((win, i) => {
        if (measure === "balance") {
          const bal = per.map((s) => (s === undefined ? null : rollBalance(s, w)[i]!));
          rows.push({ label: `${l}, ${win.label}: balance at the end`, values: bal.map((b) => b?.end ?? null) });
          rows.push({ label: `${l}, ${win.label}: average balance`, values: bal.map((b) => b?.average ?? null) });
        } else {
          rows.push({ label: `${l}, ${win.label}`, values: per.map((s) => (s === undefined ? null : rollFlow(s, w)[i]!)) });
        }
      });
    }
    notes.push(ROLL_UP_RULES[measure === "balance" ? "balances" : "flows"]);
    return { title: `${TAG_MEASURE_LABEL[measure]} by ${tagLabel}, by ${opts.granularity === "quarterly" ? "quarter" : "year"}, first ${opts.months} months`, rowHead: `${tagLabel} and period`, columns, rows, total: null, unit: "usd", notes };
  }
  for (const [k, l] of keys) {
    rows.push({ label: l, values: pivots.map((p) => { const s = rowOf(p, k)?.series; if (s === undefined) return null; return measure === "balance" ? s[0] ?? null : s.slice(0, opts.months).reduce((a, b) => a + b, 0); }) });
  }
  total = { label: "All positions", values: columns.map((_, i) => sumNullable(rows.map((r) => r.values[i]!))) };
  notes.push(measure === "balance" ? "The balance outstanding at the cut-off (the start of month 1); choose Quarterly or Annual for the path." : `The sum over the first ${opts.months} months.`);
  return { title: measure === "balance" ? `${TAG_MEASURE_LABEL[measure]} at the cut-off by ${tagLabel}` : `${TAG_MEASURE_LABEL[measure]} over ${opts.months} months by ${tagLabel}`, rowHead: tagLabel, columns, rows, total, unit: "usd", notes };
}

/** One table as CSV, every stored number at full precision. */
export function reportCsv(t: ReportTable, runId: string): string {
  // Fix round L3: a text cell a spreadsheet would read as a formula (=, +, -, @) is prefixed with a quote.
  const esc = (raw: string): string => {
    const s = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [`# ${t.title}`, `# run ${runId}`, ...t.notes.map((n) => `# ${n}`), [t.rowHead === "" ? "Line" : t.rowHead, ...t.columns].map(esc).join(",")];
  for (const r of [...t.rows, ...(t.total === null ? [] : [t.total])]) lines.push([esc(r.label), ...r.values.map((v) => (v === null ? "" : String(v)))].join(","));
  return `${lines.join("\n")}\n`;
}

/** Two runs' tables side by side on one scenario: A, B and B less A (derived). Rows matched by label. */
export function compareTables(a: ReportTable, b: ReportTable, column: string): ReportTable {
  const ai = a.columns.indexOf(column);
  const bi = b.columns.indexOf(column);
  const all = [...a.rows, ...(a.total === null ? [] : [a.total])];
  const bRows = new Map([...b.rows, ...(b.total === null ? [] : [b.total])].map((r) => [r.label, r]));
  const rows = all.map((r) => {
    const av = ai < 0 ? null : r.values[ai] ?? null;
    const bv = bi < 0 ? null : bRows.get(r.label)?.values[bi] ?? null;
    return { label: r.label, values: [av, bv, av === null || bv === null ? null : bv - av] };
  });
  const rowUnits = a.rowUnits === undefined ? undefined : [...a.rowUnits, ...(a.total === null ? [] : ["usd" as const])];
  return { title: `${a.title}, scenario ${column}: run A, run B and B less A (derived)`, rowHead: a.rowHead, columns: ["Run A", "Run B", "B less A (derived)"], rows, total: null, unit: "usd", ...(rowUnits !== undefined ? { rowUnits } : {}), notes: a.notes };
}

/** One stored distribution row, as the stochastic summary serves it. */
export interface DistributionRow { stat: string; p: number | null; value: number }

/** The plain reading of a stored distribution: mean and the 5th, 50th and 95th percentiles, each a stored value; null when absent. */
export function distributionReading(rows: readonly DistributionRow[]): { mean: number | null; p5: number | null; p50: number | null; p95: number | null } {
  const q = (p: number): number | null => rows.find((r) => r.stat === "quantile" && r.p === p)?.value ?? null;
  return { mean: rows.find((r) => r.stat === "mean")?.value ?? null, p5: q(0.05), p50: q(0.5), p95: q(0.95) };
}
