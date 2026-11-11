import { describe, expect, it } from "vitest";
import { contentHash } from "../../runtime/contentHash";
import { INDEX_HISTORY_ID_PATTERN, MAX_INDEX_HISTORY_MONTHS } from "../../contracts/indexHistory";
import { historyLastMonth, historyValueAt, isIndexHistoryId, monthIndex, namedHistoryIdsOf, startFromHistory, validateIndexHistory } from "../history";
import { indexHistoryIdOf } from "../id";

const SOURCE = { fileName: "synthetic-rfr-1m.csv", fileSha256: "a".repeat(64), format: "csv" as const, frequency: "monthly" as const, rows: 6, unit: "decimal" as const };
/** Six synthetic month-end fixings, 2025-10 to 2026-03 (the public pack's as-of month). */
const FULL = { label: "Synthetic one-month benchmark history (demonstration values)", firstMonth: "2025-10", values: [0.041, 0.0415, 0.042, 0.0425, 0.043, 0.0435], source: SOURCE };
/** The same series cut at 2025-12, three months before the cut-off month. */
const SHORT = { ...FULL, values: [0.041, 0.0415, 0.042], source: { ...SOURCE, rows: 3 } };

describe("the index history document (spec v6 decisions 47, 48)", () => {
  it("validates a well-formed history and caps it at 1,200 months", () => {
    expect(MAX_INDEX_HISTORY_MONTHS).toBe(1200);
    expect(validateIndexHistory(FULL)).toEqual([]);
    expect(validateIndexHistory({ ...FULL, values: [] })).toEqual(["values must list 1 to 1,200 monthly values"]);
    expect(validateIndexHistory({ ...FULL, values: Array.from({ length: 1201 }, () => 0.01) })).toEqual(["values must list 1 to 1,200 monthly values; got 1201"]);
    expect(validateIndexHistory({ ...FULL, values: [0.041, 0.0415, 4.31] })).toEqual(["values[2] (2025-12) must be a finite decimal rate from -1 to 1; got 4.31"]);
    expect(validateIndexHistory({ ...FULL, extra: 1 })).toEqual(['unknown field "extra"; an index history carries label, firstMonth, values and source']);
    expect(validateIndexHistory({ ...FULL, firstMonth: "2025-13" })).toEqual(['firstMonth must be a month YYYY-MM; got "2025-13"']);
    expect(validateIndexHistory({ ...FULL, label: " " })).toEqual(["label must be 1 to 120 characters"]);
    expect(validateIndexHistory({ ...FULL, source: { ...SOURCE, unit: "pct" } })).toEqual(['source.unit must be percent or decimal; got "pct"']);
    expect(validateIndexHistory({ ...FULL, source: { ...SOURCE, rows: 0 } })).toEqual(["source.rows must be a whole number of at least 1; got 0"]);
    expect(validateIndexHistory(null)).toEqual(["an index history is an object with label, firstMonth, values and source"]);
  });
  it("reads months: the last month, a value by month, nothing outside the series", () => {
    expect(monthIndex("2026-03") - monthIndex("2025-10")).toBe(5);
    expect(historyLastMonth(FULL)).toBe("2026-03");
    expect(historyLastMonth(SHORT)).toBe("2025-12");
    expect(historyValueAt(FULL, "2026-01")).toBe(0.0425);
    expect(historyValueAt(FULL, "2025-09")).toBeUndefined();
    expect(historyValueAt(FULL, "2026-04")).toBeUndefined();
  });
  it("its id is ih- and 16 hex of the canonical content hash, independent of key order", () => {
    const id = indexHistoryIdOf(FULL);
    expect(id).toBe(`ih-${contentHash(FULL).slice(0, 16)}`);
    expect(INDEX_HISTORY_ID_PATTERN.test(id)).toBe(true);
    expect(isIndexHistoryId(id)).toBe(true);
    expect(isIndexHistoryId("dc-0123456789abcdef")).toBe(false);
    const reordered = { source: FULL.source, values: FULL.values, firstMonth: FULL.firstMonth, label: FULL.label };
    expect(indexHistoryIdOf(reordered)).toBe(id);
    expect(indexHistoryIdOf({ ...FULL, values: [...FULL.values.slice(0, 5), 0.044] })).not.toBe(id);
  });
});

describe("the start fill (decision 53)", () => {
  it("fills start from the as-of month's value, minus the basis, in basis points", () => {
    expect(startFromHistory(FULL, "2026-03", 0)).toEqual({ startBp: 435 });
    expect(startFromHistory(FULL, "2026-03", 10)).toEqual({ startBp: 425 });
  });
  it("refuses a history that ends before the cut-off month, naming the last month, and one that starts after it", () => {
    expect(startFromHistory(SHORT, "2026-03", 0)).toEqual({ refusal: "the history ends 2025-12, before the cut-off month 2026-03; type the start value" });
    expect(startFromHistory(FULL, "2025-08", 0)).toEqual({ refusal: "the history starts 2025-10, after the cut-off month 2025-08; type the start value" });
  });
});

describe("namedHistoryIdsOf", () => {
  it("lists the history ids a market's indices name, distinct and sorted, and tolerates a malformed block", () => {
    const m = { rateIndices: [{ id: "a", historyId: "ih-ffffffffffffffff" }, { id: "b", historyId: "ih-0000000000000000" }, { id: "c", historyId: "ih-ffffffffffffffff" }, { id: "d" }] };
    expect(namedHistoryIdsOf(m)).toEqual(["ih-0000000000000000", "ih-ffffffffffffffff"]);
    expect(namedHistoryIdsOf({ rateIndices: "x" })).toEqual([]);
    expect(namedHistoryIdsOf({})).toEqual([]);
  });
});
