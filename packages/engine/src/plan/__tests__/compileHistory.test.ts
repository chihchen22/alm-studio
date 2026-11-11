/**
 * The results note on index history.
 *
 * Markets, all on the public pack:
 *   plain: rfr-1m, rfr-3m and three formulas on rfr-1m: lag-hist (level, lag 3), admin-hist (beta 0.5 from 4.33
 *          percent, lag 2) and level-now (level, no lag).
 *   full:  plain, with the FULL synthetic history attached to rfr-1m.
 *   short: plain, with the SHORT history (ends 2025-12) attached to rfr-1m.
 *
 * One Informational note, plan.rate-index.history, after the B3a note plan.rate-index.formula; the B3a note keeps its
 * text byte for byte on a market with no history and drops its lag caveat only where a history serves the lag. Ids and
 * sentences are restated as literals, never read back from the code under test.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { IndexHistoryEntry, IndexHistoryReading } from "../../contracts/indexHistory";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import { indexHistoryIdOf } from "../../indexHistory/id";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { historyReadingText, rateIndexHistoryNote } from "../../rateIndex/historyNote";
import { runStochastic, STOCHASTIC_SHOCKED_SCENARIOS_LAYER } from "../../run/stochastic";
import { AS_OF, baseAssumptions, loadMarket, makeRunRequest, twoSidedBook } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { compilePlan } from "../compile";
import { fixturePlan, loadPolicy } from "./fixtures";

const STAMPS = {
  runId: "RUN-1",
  seed: "42",
  timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" },
};

const SOURCE = { fileName: "synthetic-rfr-1m.csv", fileSha256: "a".repeat(64), format: "csv" as const, frequency: "monthly" as const, rows: 6, unit: "decimal" as const };
/** Six synthetic month-end fixings, 2025-10 to 2026-03 (the public pack's as-of month). */
const FULL = { label: "Synthetic one-month benchmark history (demonstration values)", firstMonth: "2025-10", values: [0.041, 0.0415, 0.042, 0.0425, 0.043, 0.0435], source: SOURCE };
/** The same series cut at 2025-12, three months before the cut-off month. */
const SHORT = { ...FULL, values: [0.041, 0.0415, 0.042], source: { ...SOURCE, rows: 3 } };
/** A history that starts after the cut-off month: no month a lag reads may use it (no look-ahead). */
const AFTER = { ...FULL, firstMonth: "2026-04", values: [0.044, 0.0445], source: { ...SOURCE, rows: 2 } };

const BASE_ID = "market-public-2026-03-31";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
];
const LAG3 = { op: "set-index", id: "lag-hist", label: "The one-month rate three months late (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, lagMonths: 3, basisBp: 0 };
const BETA2 = { op: "set-index", id: "admin-hist", label: "Half the one-month change, two months late (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.5, startBp: 433, lagMonths: 2, basisBp: 0 };
const NOW = { op: "set-index", id: "level-now", label: "The one-month rate through a formula (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, basisBp: 0 };
const E_FULL: IndexHistoryEntry = { id: indexHistoryIdOf(FULL), history: FULL };
const E_SHORT: IndexHistoryEntry = { id: indexHistoryIdOf(SHORT), history: SHORT };
const E_AFTER: IndexHistoryEntry = { id: indexHistoryIdOf(AFTER), history: AFTER };

let plain: MarketSnapshot;
let full: MarketSnapshot;
let short: MarketSnapshot;
let after: MarketSnapshot;
beforeAll(async () => {
  plain = deriveMarketSnapshot(structuredClone(await loadMarket()), [...SEED_OPS, LAG3, BETA2, NOW], { baseId: BASE_ID }).snapshot;
  const attach = (e: IndexHistoryEntry) =>
    deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: e.id }], { baseId: BASE_ID }).snapshot;
  full = attach(E_FULL);
  short = attach(E_SHORT);
  after = attach(E_AFTER);
});

function floaterPosition(id: string, rateIndexId?: string, notional = 1_000_000): Position {
  const terms = {
    id,
    type: "floating-loan",
    notional,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    ...(rateIndexId !== undefined ? { rateIndexId } : {}),
  } as unknown as PositionTerms;
  return { id, familyId: "floaters", coaNodeId: "floaters", terms };
}

function handBook(id: string, positions: Position[]): PortfolioSpec {
  return {
    id,
    label: "hand book H",
    asOf: AS_OF,
    coa: {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "floaters", label: "Floaters", parentId: "assets", side: "asset", isLeaf: true, familyId: "floaters", order: 0 },
      ],
      families: [{ id: "floaters", label: "Floaters", side: "asset", instrumentType: "floating-loan", coaNodeId: "floaters" }],
    },
    positions,
  };
}

const request = (market: MarketSnapshot) =>
  makeRunRequest(market, {
    runId: "IH-NOTE-STO",
    portfolioId: "PF-STO",
    scenarios: [
      { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } },
    ],
    assumptionSets: [{ ...baseAssumptions(), bindings: [] }],
    grid: { horizonMonths: 360, asOf: AS_OF },
  });

const open: Array<{ dispose(): void }> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.dispose();
});
function compileOn(market: MarketSnapshot, rateIndexId: string, indexHistories: IndexHistoryEntry[]) {
  const b = twoSidedBook();
  const terms = {
    id: "F",
    type: "floating-loan",
    notional: 1_000_000,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    rateIndexId,
  } as unknown as PositionTerms;
  const portfolio = { ...b, positions: [...b.positions, { id: "F", familyId: "FIXED", coaNodeId: "fixed-loans", terms }] };
  const c = compilePlan(
    fixturePlan(),
    {
      portfolio,
      marketSnapshot: market,
      assumptionSets: [baseAssumptions()],
      policy: loadPolicy(),
      libraries: SHIPPED_LIBRARIES,
      ...(indexHistories.length > 0 ? { indexHistories } : {}),
    },
    STAMPS,
  );
  open.push(c.harness);
  return c;
}

const reading = (over: Partial<IndexHistoryReading>): IndexHistoryReading => ({
  indexId: "rfr-1m", historyId: "ih-0123456789abcdef", readBy: ["lag-hist"], firstMonth: "2025-10", lastMonth: "2026-03", asOfMonth: "2026-03",
  flatAfter: 0, flatBefore: 0, asOfValue: 0.0435, curveMonth0: 0.0433, ...over,
});

describe("the index history note (decisions 49 and 52)", () => {
  it("prints the history at the as-of month, the curve's month 0 and the gap", () => {
    expect(historyReadingText(reading({}))).toBe(
      "rfr-1m (history ih-0123456789abcdef, read by lag-hist): history covers every month a lag reads; at 2026-03 the history is 4.35 percent and the curve's month 0 is 4.33 percent, a gap of -2 bp",
    );
  });
  it("Review Focus 1: says history ends YYYY-MM; N months filled flat, and when it has no as-of value", () => {
    expect(historyReadingText(reading({ lastMonth: "2025-12", flatAfter: 2, asOfValue: null }))).toBe(
      "rfr-1m (history ih-0123456789abcdef, read by lag-hist): history ends 2025-12; 2 months filled flat; the history has no value at 2026-03; the curve's month 0 is 4.33 percent",
    );
    expect(historyReadingText(reading({ firstMonth: "2026-01", flatBefore: 1 }))).toContain("history starts 2026-01; 1 month before it read its first value");
  });
  it("a history that starts at or after the cut-off: its own clause, never a last month after the cut-off", () => {
    expect(historyReadingText(reading({ firstMonth: "2026-04", lastMonth: "2026-05", flatAfter: 3, asOfValue: null }))).toBe(
      "rfr-1m (history ih-0123456789abcdef, read by lag-hist): history starts 2026-04, at or after the cut-off; 3 months filled flat; the history has no value at 2026-03; the curve's month 0 is 4.33 percent",
    );
    expect(historyReadingText(reading({ firstMonth: "2026-03", lastMonth: "2026-03", flatAfter: 1 }))).toBe(
      "rfr-1m (history ih-0123456789abcdef, read by lag-hist): history starts 2026-03, at or after the cut-off; 1 month filled flat; at 2026-03 the history is 4.35 percent and the curve's month 0 is 4.33 percent, a gap of -2 bp",
    );
  });
  it("the note lists every reading and ends with the unshocked sentence; none when no history is read", () => {
    const n = rateIndexHistoryNote([reading({})])!;
    expect(n.layer).toBe("plan.rate-index.history");
    expect(n.reason).toBe(
      "the run's lagged indices read these index histories before the cut-off: rfr-1m (history ih-0123456789abcdef, read by lag-hist): history covers every month a lag reads; at 2026-03 the history is 4.35 percent and the curve's month 0 is 4.33 percent, a gap of -2 bp. A history is not shocked: every scenario and every path reads the same values. The parent's own months read the curve; a lagged level index reads the history from its month 0, a beta index from month 1.",
    );
    expect(rateIndexHistoryNote([])).toBeUndefined();
  });
  it("a compiled run reading a short history carries the note after the formula note, and the formula note drops the lag caveat only for a lag history serves", () => {
    const notes = compileOn(short, "lag-hist", [E_SHORT]).notImplemented.filter((x) => x.layer.startsWith("plan.rate-index."));
    expect(notes.map((x) => x.layer)).toEqual(["plan.rate-index.formula", "plan.rate-index.history"]);
    expect(notes[0]!.reason).not.toContain("Until its lag has run");
    expect(notes[1]!.reason).toContain("history ends 2025-12; 2 months filled flat");
  });
  it("a compiled run reading a history that starts after the cut-off names its first month, not its last", () => {
    const note = compileOn(after, "lag-hist", [E_AFTER]).notImplemented.find((x) => x.layer === "plan.rate-index.history")!;
    expect(note.reason).toContain("history starts 2026-04, at or after the cut-off; 3 months filled flat; the history has no value at 2026-03");
    expect(note.reason).not.toContain("history ends");
  });
  it("a market with no history keeps the B3a note text byte for byte and carries no history note", () => {
    const notes = compileOn(plain, "lag-hist", []).notImplemented;
    expect(notes.some((x) => x.layer === "plan.rate-index.history")).toBe(false);
    expect(notes.find((x) => x.layer === "plan.rate-index.formula")!.reason).toContain("Until its lag has run, a lagged index reads its parent's cut-off value on the run's unshocked curve.");
  });
  it("the stochastic arm carries the history note after its own two", () => {
    const book = handBook("PF-STO", [floaterPosition("F", "lag-hist")]);
    const layers = runStochastic({ ...request(full), indexHistories: [E_FULL] }, book, { nPaths: 20 }).notImplemented.map((x) => x.layer);
    expect(layers).toEqual([STOCHASTIC_SHOCKED_SCENARIOS_LAYER, "plan.rate-index.formula", "plan.rate-index.history"]);
  });
});
