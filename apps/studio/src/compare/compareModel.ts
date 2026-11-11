// apps/studio/src/compare/compareModel.ts
/**
 * The Compare page's view model (Studio S3b). GET /api/compare serves the
 * aligned table compare.csv renders, as JSON at full precision; this file only
 * reads the query, lists the pickable runs and turns cells into text. The one
 * derived number on the page is the reply's own delta (B - A); nothing
 * here does arithmetic on a result value. Two stochastic runs compare over
 * GET /api/compare/stochastic; the listing's mode picks the route and
 * the server derives every B - A there. A pair naming BGM also reads both runs'
 * single-run summaries for their calibration arms.
 */
import type { CompareCell, CompareReply, ExportTable, RunMode, RunSummary, StochasticCompareReply, StochasticStatRow } from "@alm/reader";
import { screenHref } from "../pageLinks";

/** The six tables, in apps/server/src/export/csv.ts EXPORT_TABLES order. */
export const COMPARE_TABLES: readonly ExportTable[] = ["nii", "eve", "repricing-gap", "liquidity-gap", "attribution", "cashflows"];

const isCompareTable = (t: string | undefined): t is ExportTable => t !== undefined && (COMPARE_TABLES as readonly string[]).includes(t);

const sideOf = (s: string | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

/** runs=a,b names run A and run B; an empty side is unchosen. A missing or unknown table is nii. */
export function parseCompareQuery(q: Record<string, string>): { a: string | null; b: string | null; table: ExportTable } {
  const [a, b] = (q.runs ?? "").split(",");
  return { a: sideOf(a), b: sideOf(b), table: isCompareTable(q.table) ? q.table : "nii" };
}

/** The Compare href; every other query key passes through. With no run chosen, runs is left out. */
export function compareHref(ws: string, q: Record<string, string>, a: string | null, b: string | null, table: ExportTable): string {
  const next: Record<string, string> = { ...q };
  delete next.runs;
  delete next.table;
  if (a !== null || b !== null) next.runs = `${a ?? ""},${b ?? ""}`;
  next.table = table;
  return screenHref({ ws, section: "results", screen: "compare" }, next);
}

export const STOCHASTIC_REASON = "stochastic run: the other run is deterministic, and a distribution compares only with another stochastic run";
export const DETERMINISTIC_REASON = "deterministic run: the other run is stochastic, and a deterministic result compares only with another deterministic run";

/** The mode the listing stores for a run; a row with no mode reads deterministic. Null for no run or an unlisted one. */
export function modeIn(runs: RunSummary[], id: string | null): RunMode | null {
  if (id === null) return null;
  const hit = runs.find((r) => r.runId === id);
  if (hit === undefined) return null;
  return hit.mode === "stochastic" ? "stochastic" : "deterministic";
}

/** The route a pair reads: stochastic when either side is a stochastic run, so a mixed pair gets the server's own refusal. */
export function compareRouteOf(runs: RunSummary[], a: string, b: string): "deterministic" | "stochastic" {
  return modeIn(runs, a) === "stochastic" || modeIn(runs, b) === "stochastic" ? "stochastic" : "deterministic";
}

/** Null on the deterministic route (the Table select shows); otherwise the truthful line that stands in its place. */
export function tableLabelOf(runs: RunSummary[], a: string | null, b: string | null): string | null {
  const ma = modeIn(runs, a);
  const mb = modeIn(runs, b);
  if (ma !== "stochastic" && mb !== "stochastic") return null;
  if (ma === "stochastic" && mb === "stochastic") return "Table: both distribution tables (a stochastic pair)";
  if (ma === null || mb === null) return "Table: both distribution tables, once the other run is a stochastic run";
  return "Table: none, a deterministic run and a stochastic run do not compare (the server's reason is below)";
}

/** Done runs only, newest first by the stored submittedAt; a run whose mode differs from the other chosen run's is disabled with why. */
export function runOptions(runs: RunSummary[], other: RunMode | null = null): Array<{ runId: string; text: string; disabled: string | null }> {
  return runs
    .filter((r) => r.state === "done")
    .sort((x, y) => (x.submittedAt < y.submittedAt ? 1 : x.submittedAt > y.submittedAt ? -1 : 0))
    .map((r) => {
      const mode: RunMode = r.mode === "stochastic" ? "stochastic" : "deterministic";
      const disabled = other === null || other === mode ? null : mode === "stochastic" ? STOCHASTIC_REASON : DETERMINISTIC_REASON;
      return { runId: r.runId, text: r.label === undefined || r.label === "" ? r.runId : `${r.runId} (${r.label})`, disabled };
    });
}

/** The BGM rate model's id as a stochastic run stores it. */
export const BGM_MODEL_ID = "bgm-lmm-2f";

/**
 * Whether a stochastic comparison gets the Calibration parameters card: when either side of
 * the reply's `model` context row reads BGM. A Hull-White pair does not, so it reads no single-run summary.
 */
export function calibrationCardWanted(reply: Pick<StochasticCompareReply, "context">): boolean {
  const row = reply.context.find((c) => c.field === "model");
  return row !== undefined && (row.a === BGM_MODEL_ID || row.b === BGM_MODEL_ID);
}

/** The two distribution tables of a stochastic comparison, in reply order. */
export const STOCHASTIC_TABLES = [
  { key: "eveDistribution", title: "EVE distribution" },
  { key: "nii12mDistribution", title: "NII 12m distribution" },
] as const;

/** A stochastic statistic row's label; a quantile prints its p. */
export function statLabel(row: Pick<StochasticStatRow, "stat" | "p">): string {
  switch (row.stat) {
    case "mean": return "Mean";
    case "standardError": return "Standard error of the mean";
    case "stdev": return "Standard deviation (per path)";
    case "min": return "Minimum";
    case "max": return "Maximum";
    case "quantile": return `Quantile at ${String(row.p)}`;
  }
}

/** A like-for-like context value as text: a number or boolean via String, null as none, a string as itself. */
export function contextText(v: string | number | boolean | null): string {
  return v === null ? "none" : String(v);
}

const FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 6 };

/** A row the side lacks prints its reason; an unset cell in a present row prints none; a number is formatted for reading. */
export function cellText(v: CompareCell | undefined, side: "A" | "B", present: boolean): string {
  if (!present) return `not in run ${side}`;
  if (v === null || v === undefined) return "none";
  if (typeof v === "number") {
    // A negative that rounds to zero prints "0", as the delta column prints it. This is what signDisplay "negative"
    // does, but that option needs the ES2023 Intl lib, and tsconfig.base.json loads ES2022.
    const text = v.toLocaleString("en-US", FORMAT);
    return text === "-0" ? "0" : text;
  }
  return String(v);
}

/** The reply's B - A with its sign; zero prints bare; null (a side lacks a number) prints none. */
export function deltaText(d: number | null): string {
  if (d === null) return "none";
  return d.toLocaleString("en-US", { ...FORMAT, signDisplay: "exceptZero" });
}

/** Key columns, then per value column its A and B and, for a num column, the derived B - A. */
export function headerCells(reply: CompareReply): string[] {
  const keys = reply.columns.filter((c) => c.role === "key").map((c) => c.name);
  const values = reply.columns
    .filter((c) => c.role !== "key")
    .flatMap((c) => (c.role === "num" ? [`${c.name} A`, `${c.name} B`, `${c.name} B - A (derived)`] : [`${c.name} A`, `${c.name} B`]));
  return [...keys, ...values];
}
