/**
 * Slice K1 in the Studio: new setups carry the corrections, a setup without the field says it was made
 * before them, and a new analysis's deposits read the shipped SOFR history when it covers the workspace date.
 * Expected months are counted here by hand: April 2018 to March 2020 is 24 months, April 2018 to February 2020 is 23.
 */
import { describe, expect, it } from "vitest";
import type { RunSetup } from "@alm/reader";
import { depositHistoryLine, guidedSetupBody, historyCovers, withDepositHistory } from "../guided/setup";
import { MADE_BEFORE_CORRECTIONS, modelConventionLine, modelConventionOf, newSetupDocument, withModelConvention } from "../rows/setupRows";
import { modelConventionNoteText } from "../pages/results/GridAsOf";

const HISTORY = {
  firstMonth: "2018-04",
  lastMonth: "2026-03",
  nmdWarmup: { kind: "history" as const, series: { label: "SOFR, monthly (FRED)", firstMonth: "2018-04", valuesPct: new Array<number>(96).fill(2) } },
};

describe("the model convention in the Studio (K1)", () => {
  it("a new guided analysis and a new Advanced setup carry corrected-v1", () => {
    expect(guidedSetupBody({ kind: "runoff" }).modelConvention).toBe("corrected-v1");
    expect(newSetupDocument("New").modelConvention).toBe("corrected-v1");
  });

  it("absent reads as the original convention with the made-before line; book and corrected read as themselves", () => {
    expect(modelConventionOf({})).toBe("book");
    expect(modelConventionLine({})).toBe("Made before the corrections; re-run with corrections to update.");
    expect(MADE_BEFORE_CORRECTIONS).toBe("Made before the corrections; re-run with corrections to update.");
    expect(modelConventionLine({ modelConvention: "book" })).toMatch(/^Original convention:/);
    expect(modelConventionLine({ modelConvention: "corrected-v1" })).toBeNull();
    const s = { ...newSetupDocument("x"), id: "rs-0000000000000000" } as RunSetup;
    expect(withModelConvention(s, "book").modelConvention).toBe("book");
  });

  it("a run's result says the same: no convention recorded is a run made before the corrections", () => {
    expect(modelConventionNoteText(undefined)).toBe("Made before the corrections; re-run with corrections to update.");
    expect(modelConventionNoteText("book")).toMatch(/^Original convention:/);
    expect(modelConventionNoteText("corrected-v1")).toBeNull();
  });
});

describe("a new analysis's deposit history (K1 point 6)", () => {
  it("covers a workspace date with at least 24 months up to it and not past the last month", () => {
    expect(historyCovers(HISTORY, "2026-03-31")).toBe(true);
    expect(historyCovers(HISTORY, "2020-03-31")).toBe(true);
    expect(historyCovers(HISTORY, "2020-02-29")).toBe(false);
    expect(historyCovers(HISTORY, "2026-04-30")).toBe(false);
  });

  it("sets the history on a new setup that has none, only when it covers the date", () => {
    const fresh = guidedSetupBody({ kind: "runoff" });
    expect(fresh.nmdWarmup).toBeUndefined();
    expect(withDepositHistory(fresh, HISTORY, "2026-03-31").nmdWarmup).toEqual(HISTORY.nmdWarmup);
    expect(withDepositHistory(fresh, HISTORY, "2026-06-30").nmdWarmup).toBeUndefined();
    const flat = { ...fresh, nmdWarmup: { kind: "flat-at-r0" as const, months: 36 } };
    expect(withDepositHistory(flat, HISTORY, "2026-03-31").nmdWarmup).toEqual({ kind: "flat-at-r0", months: 36 });
  });

  it("names the history in one plain line, or says the built-in series is not a published history", () => {
    expect(depositHistoryLine({ nmdWarmup: HISTORY.nmdWarmup })).toBe('Deposits read the rate history "SOFR, monthly", 2018-04 to 2026-03.');
    // Fix round L7: with the workspace date, the window a run reads: up to the as-of month, not the series' end.
    expect(depositHistoryLine({ nmdWarmup: HISTORY.nmdWarmup }, "2025-06-30")).toBe('Deposits read the rate history "SOFR, monthly", 2018-04 to 2025-06.');
    expect(depositHistoryLine({})).toMatch(/built-in rate series: hand-set rate levels from January 2001, not a published history/);
    expect(depositHistoryLine({ nmdWarmup: { kind: "flat-at-r0", months: 36 } })).toMatch(/flat 36-month history/);
  });
});
