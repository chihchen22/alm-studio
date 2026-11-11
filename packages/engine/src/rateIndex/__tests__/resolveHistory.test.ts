/**
 * The pre-cut-off read. A
 * lagged formula whose parent carries an index history reads the history for the months before the cut-off, the
 * history's first value before its first month, and the unshocked anchor after its last month. A run that needs a
 * history it was not given is refused. Expected texts and values are restated here, not imported from the code under
 * test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DeterministicRatePath, loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { fileURLToPath } from "node:url";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import type { AnchoredFormulaIndex } from "../../contracts/rateIndex";
import { indexHistoryIdOf } from "../../indexHistory/id";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { ResolvedIndexPath } from "../indexSeries";
import { checkRateIndexRefs, indexHistoryIdsRead, indexHistoryReadings } from "../resolve";

function floater(id: string, rateIndexId: string): Position {
  const terms = {
    id,
    type: "floating-loan",
    notional: 1_000_000,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    rateIndexId,
  } as unknown as PositionTerms;
  return { id, familyId: "floaters", coaNodeId: "floaters", terms };
}
const bookOf = (positions: Position[]): PortfolioSpec => ({
  id: "PF-DC",
  label: "derived curve book",
  asOf: "2026-01-01",
  coa: { schemaVersion: "1.0.0", nodes: [], families: [] },
  positions,
});

const SOURCE = { fileName: "synthetic-rfr-1m.csv", fileSha256: "a".repeat(64), format: "csv" as const, frequency: "monthly" as const, rows: 6, unit: "decimal" as const };
/** Six synthetic month-end fixings, 2025-10 to 2026-03 (the public pack's as-of month). */
const FULL = { label: "Synthetic one-month benchmark history (demonstration values)", firstMonth: "2025-10", values: [0.041, 0.0415, 0.042, 0.0425, 0.043, 0.0435], source: SOURCE };
/** The same series cut at 2025-12, three months before the cut-off month. */
const SHORT = { ...FULL, values: [0.041, 0.0415, 0.042], source: { ...SOURCE, rows: 3 } };

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
];
const LAG3 = { op: "set-index", id: "lag-hist", label: "The one-month rate three months late (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, lagMonths: 3, basisBp: 0 };
const BETA2 = { op: "set-index", id: "admin-hist", label: "Half the one-month change, two months late (demonstration values)", kind: "formula", parent: "rfr-1m", beta: 0.5, startBp: 433, lagMonths: 2, basisBp: 0 };
const NOW = { op: "set-index", id: "level-now", label: "The one-month rate through a formula (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, basisBp: 0 };
const E_FULL = { id: indexHistoryIdOf(FULL), history: FULL };
const E_SHORT = { id: indexHistoryIdOf(SHORT), history: SHORT };

let plain: MarketSnapshot;
let full: MarketSnapshot;
let short: MarketSnapshot;
beforeAll(async () => {
  plain = deriveMarketSnapshot(await loadMarketSnapshot(FIXTURE), [...SEED_OPS, LAG3, BETA2, NOW], { baseId: BASE_ID }).snapshot;
  full = deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: E_FULL.id }], { baseId: BASE_ID }).snapshot;
  short = deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: E_SHORT.id }], { baseId: BASE_ID }).snapshot;
});
const entry = (m: MarketSnapshot, id: string, read: string, h: readonly (typeof E_FULL)[]) =>
  checkRateIndexRefs(bookOf([floater("F", read)]), m, undefined, h).table!.get(id) as AnchoredFormulaIndex;

describe("the months before the cut-off read history (spec v6 decision 52)", () => {
  it("lists the histories a run reads: a lagged formula's parent only", () => {
    expect(indexHistoryIdsRead(bookOf([floater("F", "lag-hist")]), full)).toEqual([E_FULL.id]);
    expect(indexHistoryIdsRead(bookOf([floater("F", "level-now")]), full)).toEqual([]);
    expect(indexHistoryIdsRead(bookOf([floater("F", "rfr-1m")]), full)).toEqual([]);
    expect(indexHistoryIdsRead(bookOf([floater("F", "lag-hist")]), plain)).toEqual([]);
  });
  it("puts the history months on the lagged formula's entry, month -1 first", () => {
    expect(entry(full, "lag-hist", "lag-hist", [E_FULL]).parentBeforeCutoff).toEqual([0.043, 0.0425, 0.042]);
  });
  it("a lag-3 level index reads 2025-12, 2026-01 and 2026-02 from history, then the curve from month 3", () => {
    const table = checkRateIndexRefs(bookOf([floater("F", "lag-hist")]), full, undefined, [E_FULL]).table!;
    // Twelve steps, as anchorFormulas builds the anchor path, so step 3 is the anchor bit for bit.
    const path = new DeterministicRatePath(buildBaseCurve(full), 12);
    const idx = new ResolvedIndexPath(path, "lag-hist", table);
    expect([idx.rateAt(0), idx.rateAt(1), idx.rateAt(2)]).toEqual([0.042, 0.0425, 0.043]);
    expect(idx.rateAt(3)).toBe((table.get("lag-hist") as AnchoredFormulaIndex).parentAtCutoff);
  });
  it("Review Focus 1: months after the history's last month read the flat fill", () => {
    const e = entry(short, "lag-hist", "lag-hist", [E_SHORT]);
    expect(e.parentBeforeCutoff).toEqual([e.parentAtCutoff, e.parentAtCutoff, 0.042]);
  });
  it("ruling D1: the change form's month 0 is the start plus basis; history enters from month 1", () => {
    const table = checkRateIndexRefs(bookOf([floater("F", "admin-hist")]), full, undefined, [E_FULL]).table!;
    const anchor = (table.get("admin-hist") as AnchoredFormulaIndex).parentAtCutoff;
    // Twelve steps, as the anchor path (N1): a 360-step path's month 0 agrees with it to about 6 places only.
    const idx = new ResolvedIndexPath(new DeterministicRatePath(buildBaseCurve(full), 12), "admin-hist", table);
    expect(idx.rateAt(0)).toBe(0.0433);
    expect(idx.rateAt(1)).toBeCloseTo(0.0433 + 0.5 * (0.043 - 0.0425), 12);
    expect(idx.rateAt(2)).toBeCloseTo(idx.rateAt(1) + 0.5 * (anchor - 0.043), 12);
  });
  it("ruling D3: months before a history's first month read its first value, so a beta index sees no jump from the anchor", () => {
    const late = { ...FULL, firstMonth: "2026-01", values: [0.0425, 0.043] };
    const eLate = { id: indexHistoryIdOf(late), history: late };
    const m = deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: eLate.id }], { baseId: BASE_ID }).snapshot;
    // Lag 3 at a March cut-off reads 2026-02, 2026-01 (both in the history) and 2025-12 (before it: the first value).
    expect(entry(m, "lag-hist", "lag-hist", [eLate]).parentBeforeCutoff).toEqual([0.043, 0.0425, 0.0425]);
    const lateFeb = { ...FULL, firstMonth: "2026-02", values: [0.043] };
    const eFeb = { id: indexHistoryIdOf(lateFeb), history: lateFeb };
    const mFeb = deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: eFeb.id }], { baseId: BASE_ID }).snapshot;
    const table = checkRateIndexRefs(bookOf([floater("F", "admin-hist")]), mFeb, undefined, [eFeb]).table!;
    const idx = new ResolvedIndexPath(new DeterministicRatePath(buildBaseCurve(mFeb), 12), "admin-hist", table);
    // Lag 2: month 1 moves by 0.5 x (2026-02 less 2026-01), both 0.043 under D3, so it stays at the start exactly.
    expect(idx.rateAt(1)).toBe(0.0433);
  });
  it("no look-ahead: a history that starts at or after the cut-off month fills nothing before the cut-off, so the lag reads the B3a anchor", () => {
    const b3a = checkRateIndexRefs(bookOf([floater("F", "admin-hist")]), plain).table!;
    const b3aIdx = new ResolvedIndexPath(new DeterministicRatePath(buildBaseCurve(plain), 12), "admin-hist", b3a);
    const anchor = (b3a.get("admin-hist") as AnchoredFormulaIndex).parentAtCutoff;
    for (const firstMonth of ["2026-03", "2026-04"]) {
      const after = { ...FULL, firstMonth, values: [0.05, 0.051] };
      const eAfter = { id: indexHistoryIdOf(after), history: after };
      const m = deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: eAfter.id }], { baseId: BASE_ID }).snapshot;
      const table = checkRateIndexRefs(bookOf([floater("F", "admin-hist")]), m, undefined, [eAfter]).table!;
      expect((table.get("admin-hist") as AnchoredFormulaIndex).parentBeforeCutoff).toEqual([anchor, anchor]);
      const idx = new ResolvedIndexPath(new DeterministicRatePath(buildBaseCurve(m), 12), "admin-hist", table);
      expect([idx.rateAt(0), idx.rateAt(1), idx.rateAt(2)]).toEqual([b3aIdx.rateAt(0), b3aIdx.rateAt(1), b3aIdx.rateAt(2)]);
      const [r] = indexHistoryReadings(bookOf([floater("F", "admin-hist")]), m, [eAfter]);
      expect([r!.firstMonth, r!.flatAfter, r!.flatBefore]).toEqual([firstMonth, 2, 0]);
    }
  });
  it("ruling D3 keeps the anchor after the last month (decisions 45 and 49): the two sides differ", () => {
    const e = entry(short, "lag-hist", "lag-hist", [E_SHORT]);
    expect(e.parentBeforeCutoff![0]).toBe(e.parentAtCutoff);
    expect(e.parentBeforeCutoff![2]).toBe(0.042);
  });
  it("N9: a history on a constant-maturity-swap index is read by its lagged formula child", () => {
    const CMS_H = { op: "set-index", id: "cms-10y", label: "Ten-year swap rate (demonstration index)", kind: "constant-maturity-swap", tenorYears: 10, basisBp: 0, historyId: E_FULL.id };
    const CMS_LAG = { op: "set-index", id: "cms-lag2", label: "The ten-year swap two months late (demonstration values)", kind: "formula", parent: "cms-10y", coefficient: 1, lagMonths: 2, basisBp: 0 };
    const m = deriveMarketSnapshot(structuredClone(plain), [CMS_H, CMS_LAG], { baseId: BASE_ID }).snapshot;
    expect(indexHistoryIdsRead(bookOf([floater("F", "cms-lag2")]), m)).toEqual([E_FULL.id]);
    expect(entry(m, "cms-lag2", "cms-lag2", [E_FULL]).parentBeforeCutoff).toEqual([0.043, 0.0425]);
  });
  it("a market without history, and a formula without a lag, build the B3a entry", () => {
    expect("parentBeforeCutoff" in entry(plain, "lag-hist", "lag-hist", [])).toBe(false);
    expect("parentBeforeCutoff" in entry(full, "level-now", "level-now", [E_FULL])).toBe(false);
    expect(checkRateIndexRefs(bookOf([floater("F", "level-now")]), full).message).toBeUndefined();
  });
});

describe("refusals: a lag never reads a flat fill in place of a history the market names", () => {
  it("refuses a run that was not given the history, naming the formula, its parent and the id", () => {
    const r = checkRateIndexRefs(bookOf([floater("F", "lag-hist")]), full);
    expect(r.table).toBeUndefined();
    expect(r.message).toBe(
      `run refused: 1 rate index history problem(s), and a lag never reads a flat fill in place of a history the market names: rate index "lag-hist" lags on "rfr-1m", which reads index history "${E_FULL.id}", and the run was not given that history`,
    );
    expect(r.first).toEqual({ positionId: "F", rateIndexId: "lag-hist" });
  });
  it("refuses a given history that does not hash to its id", () => {
    const moved = { id: E_FULL.id, history: { ...FULL, values: [...FULL.values.slice(0, 5), 0.044] } };
    const r = checkRateIndexRefs(bookOf([floater("F", "lag-hist")]), full, undefined, [moved]);
    expect(r.message).toContain(`index history "${E_FULL.id}" given to the run does not hash to its id (its content hashes to "${indexHistoryIdOf(moved.history)}")`);
  });
});

describe("indexHistoryReadings (decisions 49 and 52)", () => {
  it("reads the as-of month value and the curve's month 0 when the history reaches the cut-off", () => {
    const anchor = entry(full, "lag-hist", "lag-hist", [E_FULL]).parentAtCutoff;
    expect(indexHistoryReadings(bookOf([floater("F", "lag-hist"), floater("G", "admin-hist")]), full, [E_FULL])).toEqual([
      { indexId: "rfr-1m", historyId: E_FULL.id, readBy: ["admin-hist", "lag-hist"], firstMonth: "2025-10", lastMonth: "2026-03", asOfMonth: "2026-03", flatAfter: 0, flatBefore: 0, asOfValue: 0.0435, curveMonth0: anchor },
    ]);
  });
  it("counts the months a lag reads that the history does not cover, after its end and before its start", () => {
    const [r] = indexHistoryReadings(bookOf([floater("F", "lag-hist")]), short, [E_SHORT]);
    expect([r!.lastMonth, r!.flatAfter, r!.flatBefore, r!.asOfValue]).toEqual(["2025-12", 2, 0, null]);
    const late = { ...FULL, firstMonth: "2026-01", values: [0.0425, 0.043] };
    const eLate = { id: indexHistoryIdOf(late), history: late };
    const m = deriveMarketSnapshot(structuredClone(plain), [{ op: "set-index-history", indexId: "rfr-1m", historyId: eLate.id }], { baseId: BASE_ID }).snapshot;
    const [s] = indexHistoryReadings(bookOf([floater("F", "lag-hist")]), m, [eLate]);
    expect([s!.flatAfter, s!.flatBefore]).toEqual([0, 1]);
  });
  it("reads nothing when no lagged formula is read, or the run is refused", () => {
    expect(indexHistoryReadings(bookOf([floater("F", "level-now")]), full, [E_FULL])).toEqual([]);
    expect(indexHistoryReadings(bookOf([floater("F", "lag-hist")]), full, [])).toEqual([]);
  });
});
