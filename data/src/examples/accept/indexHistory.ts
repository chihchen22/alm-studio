/**
 * Acceptance check: index-history-store.
 *
 * An index history is an append-only store document of monthly month-end fixings, imported from a CSV or .xlsx file
 * with a declared unit; a rate index carries its id, and a lagged formula reads its parent's history for the months
 * before the cut-off. Independent anchors, each restated on paper rather than read back from the code under test:
 *
 *   1. IMPORT: a daily percent file whose January and February month ends fall on Saturdays (31 January and 28
 *      February 2026) keeps each month's last weekday fixing: 30 January 4.31, 27 February 4.34, 31 March (a Tuesday)
 *      4.36, so firstMonth 2026-01 and values [0.0431, 0.0434, 0.0436].
 *   2. STORE: the id is `ih-` plus the first 16 hex of the document's content hash; a second store of the same
 *      content is the same id and writes nothing; the stored bytes re-validate.
 *   3. LAG READ: a lag-3 floater on the March 2026 cut-off reads December, January and February from the history,
 *      so its first three months of interest are 1M x (h + 0.0125) / 12 for h = 0.042, 0.0425, 0.043.
 *   4. FLAT FILL (a degeneracy limit): a history that ends in December leaves January and February to the flat fill,
 *      which is the cut-off value, the same number month 4 reads as the run path's month 0 at lag 3.
 *   5. NOTE: the history note counts the coverage on paper: a lag of 3 at a March cut-off reads December, January and
 *      February; a series ending in December covers one and fills two flat, and has no value at March.
 *
 * Every run here goes through buildRunResult, which emits no compile-time Informational note, so the check observes
 * no notImplemented layer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketSnapshot } from "@alm/kernel";
import { FLOATING_LOAN_DEFAULTS } from "@alm/kernel";
import type { IndexHistory, IndexHistoryEntry, PortfolioSpec, Position, PositionTerms, RunRequest, RunResult } from "@alm/engine";
import {
  buildRunResult,
  deriveMarketSnapshot,
  indexHistoryIdOf,
  indexHistoryReadings,
  rateIndexHistoryNote,
  resolveDefaultContext,
  validateIndexHistory,
} from "@alm/engine";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { parseIndexHistoryFile } from "../../../../apps/server/src/intake/indexHistory";
import { putIndexHistory } from "../../../../apps/server/src/http/routes/indexHistories";
import { FileStore } from "../../../../apps/server/src/store/store";
import { ACCEPT_TS, baseScenario, emptySet, smallBook } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

const N = 1_000_000;
const MARGIN = 0.0125;
const LAG_ID = "lag-hist";

/** The daily file, restated: 31 Jan and 28 Feb 2026 are Saturdays; 16 Feb is a holiday row with no value. */
const DAILY = [
  "date,rate", "2026-01-29,4.30", "2026-01-30,4.31", "2026-02-02,4.32", "2026-02-16,.", "2026-02-26,4.33", "2026-02-27,4.34", "2026-03-02,4.35", "2026-03-31,4.36", "",
].join("\r\n");

const SOURCE = { fileName: "synthetic-rfr-1m.csv", fileSha256: "a".repeat(64), format: "csv" as const, frequency: "monthly" as const, rows: 6, unit: "decimal" as const };
/** Six synthetic month-end fixings, 2025-10 to 2026-03 (the public pack's as-of month). */
const FULL: IndexHistory = { label: "Synthetic one-month benchmark history (demonstration values)", firstMonth: "2025-10", values: [0.041, 0.0415, 0.042, 0.0425, 0.043, 0.0435], source: SOURCE };
/** The same series cut at 2025-12, three months before the cut-off month. */
const SHORT: IndexHistory = { ...FULL, values: [0.041, 0.0415, 0.042], source: { ...SOURCE, rows: 3 } };

const BASE_ID = "market-public-2026-03-31";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
];
const LAG3 = { op: "set-index", id: LAG_ID, label: "The one-month rate three months late (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, lagMonths: 3, basisBp: 0 };

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

function lagBook(): PortfolioSpec {
  const terms = { ...FLOATING_LOAN_DEFAULTS, id: "lag-floater", notional: N, maturityMonths: 12, amortType: "bullet", margin: MARGIN, side: "asset", rateIndexId: LAG_ID } as unknown as PositionTerms;
  const position: Position = { id: "lag-floater", familyId: "FLT", coaNodeId: "coa-FLT", terms };
  return smallBook("accept-index-history", [{ id: "FLT", side: "asset", instrumentType: "floating-loan", label: "lag-3 floater" }], [position]);
}

function historyMarket(market: MarketSnapshot, historyId: string): MarketSnapshot {
  return deriveMarketSnapshot(structuredClone(market), [...SEED_OPS, LAG3, { op: "set-index-history", indexId: "rfr-1m", historyId }], { baseId: BASE_ID }).snapshot;
}

function runWith(book: PortfolioSpec, market: MarketSnapshot, entry: IndexHistoryEntry, runId: string): RunResult {
  const set = emptySet();
  const request: RunRequest = {
    runId,
    portfolioId: book.id,
    marketSnapshot: market,
    scenarios: [baseScenario(set.id)],
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: book.asOf },
    seed: "accept",
    timestamps: { ...ACCEPT_TS },
    indexHistories: [entry],
  };
  return buildRunResult(request, book, { ...resolveDefaultContext(), durationMode: "base-only" });
}

const interestOf = (r: RunResult): number[] =>
  r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((f) => f.familyId === "FLT")!.series.interest;

export const indexHistoryCheck: CapabilityCheck = {
  capabilityId: "index-history-store",
  title: "Rate index history store, CSV and Excel import, lag reads before the cut-off",
  run({ market }) {
    const lines: CheckLine[] = [];
    const observed: string[] = [];

    // 1. The import keeps each month's last weekday fixing.
    const parsed = parseIndexHistoryFile(Buffer.from(DAILY, "utf8"), "sofr-daily.csv", { unit: "percent" });
    const imported = parsed.ok ? parsed.history : undefined;
    const want = [0.0431, 0.0434, 0.0436];
    const importOk =
      imported !== undefined && imported.firstMonth === "2026-01" && imported.values.length === 3 && imported.values.every((v, i) => v === want[i]);
    lines.push({
      id: "index-history.import",
      status: importOk ? "pass" : "fail",
      detail:
        `daily percent file -> firstMonth ${imported?.firstMonth ?? "(refused)"}, values ${JSON.stringify(imported?.values ?? (parsed.ok ? [] : parsed.refusals))} ` +
        `(2026-01, [0.0431, 0.0434, 0.0436]: ${importOk}) (anchor: on paper, 30 January and 27 February 2026 are the Fridays before ` +
        `Saturday month ends and 31 March is a Tuesday, so each month keeps its last weekday fixing)`,
    });

    // 2. The store: content-hash id, idempotent, the bytes re-validate.
    const dir = mkdtempSync(join(tmpdir(), "accept-index-history-"));
    try {
      const store = new FileStore(dir);
      const doc = imported ?? FULL;
      const first = putIndexHistory(store, doc);
      const second = putIndexHistory(store, doc);
      const expectedId = `ih-${contentHash(doc).slice(0, 16)}`;
      const bytes = store.getDocumentBytes("index-histories", first.id);
      const problems = validateIndexHistory(JSON.parse(bytes.toString("utf8")));
      const storeOk = imported !== undefined && first.id === second.id && first.created && !second.created && first.id === expectedId && problems.length === 0;
      lines.push({
        id: "index-history.store",
        status: storeOk ? "pass" : "fail",
        detail:
          `two stores of one document -> ids ${first.id} and ${second.id}, created ${first.created} then ${second.created}; ` +
          `id equals ih- + first 16 hex of contentHash(document) ${expectedId}: ${first.id === expectedId}; stored bytes re-validate ` +
          `with ${problems.length} problem(s): ${storeOk} (anchor: content addressing; the second store writes nothing)`,
      });
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The OS temp cleaner owns the leftovers.
      }
    }

    const book = lagBook();

    // 3. The lag reads December, January and February from the history.
    const fullEntry: IndexHistoryEntry = { id: indexHistoryIdOf(FULL), history: FULL };
    const fullRun = runWith(book, historyMarket(market, fullEntry.id), fullEntry, "accept-index-history-full");
    observed.push(...fullRun.notImplemented.map((t) => t.layer));
    const fi = interestOf(fullRun);
    const handFull = [0.042, 0.0425, 0.043].map((h) => (N * (h + MARGIN)) / 12);
    const lagOk = handFull.every((v, k) => near(fi[k]!, v, 1e-6));
    lines.push({
      id: "index-history.lag-read",
      status: lagOk ? "pass" : "fail",
      detail:
        `lag-3 floater, months 1 to 3 interest ${fi.slice(0, 3).map((v) => v.toFixed(6)).join(", ")} vs ` +
        `${handFull.map((v) => v.toFixed(6)).join(", ")} within 1e-6: ${lagOk} (anchor: on paper, 1M x (h + 0.0125) / 12 for the ` +
        `2025-12, 2026-01 and 2026-02 fixings h = 0.042, 0.0425, 0.043 a lag of 3 reads at a March cut-off)`,
    });

    // 4. Where the history stops short the months read flat: the cut-off value, which month 4 reads as path month 0.
    const shortEntry: IndexHistoryEntry = { id: indexHistoryIdOf(SHORT), history: SHORT };
    const shortMarket = historyMarket(market, shortEntry.id);
    const shortRun = runWith(book, shortMarket, shortEntry, "accept-index-history-short");
    observed.push(...shortRun.notImplemented.map((t) => t.layer));
    const si = interestOf(shortRun);
    const month1 = near(si[0]!, (N * (0.042 + MARGIN)) / 12, 1e-6);
    const flatEqual = si[1] === si[2];
    const month4 = near(si[3]!, si[1]!, 1e-6);
    lines.push({
      id: "index-history.flat-fill",
      status: month1 && flatEqual && month4 ? "pass" : "fail",
      detail:
        `history ending 2025-12: month 1 ${si[0]!.toFixed(6)} (1M x (0.042 + 0.0125) / 12: ${month1}); months 2 and 3 ` +
        `${si[1]!.toFixed(9)} and ${si[2]!.toFixed(9)} equal exactly: ${flatEqual}; month 4 ${si[3]!.toFixed(9)} within 1e-6 ` +
        `of them: ${month4} (anchor: degeneracy; the flat fill is the cut-off value, which month 4 reads as the run path's ` +
        `month 0 at lag 3; the anchor is built on a 12-step path and the run on a 360-step one, so the last comparison is not exact)`,
    });

    // 5. The note counts the coverage.
    const note = rateIndexHistoryNote(indexHistoryReadings(book, shortMarket, [shortEntry]));
    const wantText = `rfr-1m (history ${shortEntry.id}, read by ${LAG_ID}): history ends 2025-12; 2 months filled flat; the history has no value at 2026-03`;
    const noteOk = note !== undefined && note.layer === "plan.rate-index.history" && note.reason.includes(wantText);
    lines.push({
      id: "index-history.note",
      status: noteOk ? "pass" : "fail",
      detail:
        `history note layer ${note?.layer ?? "(none)"} carries "${wantText}": ${noteOk} (anchor: on paper, a lag of 3 at a ` +
        `March cut-off reads December, January and February; a series ending in December covers one and fills two flat)`,
    });

    return { lines, observedNotImplemented: observed };
  },
};
