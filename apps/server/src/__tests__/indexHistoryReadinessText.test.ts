// apps/server/src/__tests__/indexHistoryReadinessText.test.ts
// B3b follow-up, items 1 and 2: the rates item's words on an index history, as pure functions of the engine's
// problem text and readings. Item 1: the import hint follows a missing or unreadable history only; a market that
// carries no readable calibration date gets a hint that points at the market. Item 2: the Warning's explanation
// follows the reading (flatAfter, flatBefore, and the no-look-ahead case of a history that starts at or after the
// cut-off). The engine sentences are restated by hand from packages/engine/src/rateIndex/resolve.ts; every expected
// sentence is restated by hand, none read back from the code under test.
import { describe, expect, it } from "vitest";
import type { IndexHistoryReading } from "@alm/engine";
import { historyShortText, indexHistoryProblemHint } from "../workspaces/readiness";

const IMPORT = " Import the history again on Market > Rate indices.";
const MARKET_DATE =
  " The months before the cut-off are dated by the market's calibration date, so the history is not the fix: attach a base snapshot with a readable calibration date on Market > Yield curves and derive the market again on Market > Rate indices.";

describe("the hint after an index history problem (item 1)", () => {
  const head = 'rate index "prime-demo" lags on "rfr-1m", which reads index history "ih-0123456789abcdef"';
  it("a history the run was not given, or one it cannot read, gets the import hint", () => {
    expect(indexHistoryProblemHint(`${head}, and the run was not given that history`)).toBe(IMPORT);
    expect(indexHistoryProblemHint('index history "ih-0123456789abcdef" given to the run is not readable: values: expected a list')).toBe(IMPORT);
    expect(indexHistoryProblemHint('index history "ih-0123456789abcdef" given to the run does not hash to its id (its content hashes to "ih-fedcba9876543210")')).toBe(IMPORT);
  });
  it("a market with no readable calibration date points at the market, never at the history", () => {
    for (const shown of ['market "b3b-prime-lag-v1"', "the run's market"]) {
      const p = `${head}, but ${shown} carries no readable calibrationDate to date the months before the cut-off`;
      expect(indexHistoryProblemHint(p)).toBe(MARKET_DATE);
    }
  });
  it("a problem that is not about a history is not answered here", () => {
    expect(indexHistoryProblemHint('rate index "rfr-6m" is not carried by market "m"')).toBeNull();
    expect(indexHistoryProblemHint('rate index "rfr-3m" reads derived curve "c", which market "m" does not carry')).toBeNull();
  });
});

/** A reading at the 2026-03 cut-off; each case overrides the months and the counts. */
const reading = (over: Partial<IndexHistoryReading>): IndexHistoryReading => ({
  indexId: "rfr-1m",
  historyId: "ih-0123456789abcdef",
  readBy: ["prime-demo"],
  firstMonth: "2025-10",
  lastMonth: "2026-02",
  asOfMonth: "2026-03",
  flatAfter: 0,
  flatBefore: 0,
  asOfValue: null,
  curveMonth0: 0.0435,
  ...over,
});
const CLOSE = " Acknowledge the warning to launch, or import a longer history on Market > Rate indices.";
const AFTER = "months after a history's last month read the index's cut-off value on the unshocked curve";
const BEFORE = "months before a history's first month read its first value";
const LATE =
  "a history that starts at or after the cut-off fills nothing before it (no look-ahead), so every month a lag reads before the cut-off reads the index's cut-off value on the unshocked curve";
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const clauseOf = (r: IndexHistoryReading, cover: string) =>
  `${r.indexId} (history ${r.historyId}, read by ${r.readBy.join(", ")}): ${cover}; the history has no value at 2026-03; the curve's month 0 is 4.35 percent`;

describe("the Warning when a history stops short (item 2)", () => {
  it("a history that ends early says only what the months after its last month read", () => {
    const r = reading({ lastMonth: "2025-12", flatAfter: 2 });
    expect(historyShortText([r])).toBe(
      `An index history stops short of a month a lag reads: ${clauseOf(r, "history ends 2025-12; 2 months filled flat")}. ${cap(AFTER)}.${CLOSE}`,
    );
  });
  it("a history that starts after the earliest month a lag reads says only what the months before its first month read", () => {
    const r = reading({ firstMonth: "2026-01", flatBefore: 1 });
    expect(historyShortText([r])).toBe(
      `An index history stops short of a month a lag reads: ${clauseOf(r, "history starts 2026-01; 1 month before it read its first value")}. ${cap(BEFORE)}.${CLOSE}`,
    );
  });
  it("a history short at both ends says both", () => {
    const r = reading({ firstMonth: "2026-01", lastMonth: "2026-01", flatAfter: 1, flatBefore: 1 });
    expect(historyShortText([r])).toBe(
      `An index history stops short of a month a lag reads: ${clauseOf(r, "history ends 2026-01; 1 month filled flat; history starts 2026-01; 1 month before it read its first value")}. ${cap(AFTER)}; ${BEFORE}.${CLOSE}`,
    );
  });
  it("a history that starts at or after the cut-off never says a month reads its first value (no look-ahead)", () => {
    const r = reading({ firstMonth: "2026-03", lastMonth: "2026-04", flatAfter: 2 });
    const text = historyShortText([r]);
    expect(text).toBe(
      `An index history stops short of a month a lag reads: ${clauseOf(r, "history starts 2026-03, at or after the cut-off; 2 months filled flat")}. ${cap(LATE)}.${CLOSE}`,
    );
    expect(text).not.toContain("read its first value");
    expect(text).not.toContain("last month");
  });
  it("two histories, one late and one ending early, say each reading once, in a fixed order", () => {
    const late = reading({ indexId: "rfr-1m", firstMonth: "2026-03", lastMonth: "2026-04", flatAfter: 2 });
    const ends = reading({ indexId: "rfr-3m", historyId: "ih-1111111111111111", lastMonth: "2025-12", flatAfter: 2 });
    expect(historyShortText([late, ends])).toBe(
      `An index history stops short of a month a lag reads: ${clauseOf(late, "history starts 2026-03, at or after the cut-off; 2 months filled flat")}; ${clauseOf(ends, "history ends 2025-12; 2 months filled flat")}. ${cap(AFTER)}; ${LATE}.${CLOSE}`,
    );
  });
});
