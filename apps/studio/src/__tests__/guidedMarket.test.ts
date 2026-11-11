// apps/studio/src/__tests__/guidedMarket.test.ts
/**
 * The guided Market step (S2a spec point 3): the snapshot summary, the plain market template and the curve edit.
 * The snapshot is written here by hand; the template's text and the edit's block are spelled out by hand. The
 * template's round trip is checked through the paste parser, a separate reader the Curve setups screen already uses.
 */
import { describe, expect, it } from "vitest";
import { parsePaste } from "../market/curveSetupModel";
import { applyPaste, changedRows, curveBlockOf, editRowsOf, marketTemplateCsv, nextVariantId, percentText, summarizeSnapshot, templateFromRows } from "../guided/market";

const SNAP = {
  calibrationDate: "2026-03-31",
  curveConvention: "semiannual_bond",
  curveQuotes: [
    { term: "1M", tYears: 0.083333, instrumentType: "BILL_BEY", rate: 0.0374 },
    { term: "1Y", tYears: 1, instrumentType: "CMT_BEY", rate: 0.0361 },
    { term: "10Y", tYears: 10, instrumentType: "CMT_BEY", rate: 0.0428 },
    { term: "ON", tYears: 0.0027, instrumentType: "CASH", rate: 0.0433 },
  ],
  capQuotes: [
    { expiryYears: 1, strike: 0.02, isAtm: false },
    { expiryYears: 1, strike: 0.03, isAtm: true },
    { expiryYears: 2, strike: 0.02, isAtm: false },
  ],
  swaptionATMQuotes: [{ expiryYears: 1, tenorYears: 5 }, { expiryYears: 1, tenorYears: 10 }, { expiryYears: 5, tenorYears: 5 }],
};

describe("snapshot summary", () => {
  it("says what the snapshot holds: curve quotes and span, cap and swaption grids", () => {
    const s = summarizeSnapshot(SNAP);
    expect([s.date, s.curvePoints, s.curveSpan, s.capExpiries, s.capStrikes, s.hasAtmCaps, s.swaptionExpiries, s.swaptionTenors]).toEqual(["2026-03-31", 4, "ON to 10Y", 2, 2, true, 2, 2]);
    expect(s.sentence).toBe("Holds a yield curve of 4 quotes, ON to 10Y; cap volatilities at 2 expiries and 2 strikes; swaption volatilities at 2 expiries and 2 tenors.");
    expect(summarizeSnapshot({}).sentence).toBe("Holds no yield curve quotes; no cap volatilities; no swaption volatilities.");
  });
});

describe("the plain market template", () => {
  it("is two columns, tenor and par rate in percent, the overnight quote left out", () => {
    expect(marketTemplateCsv(SNAP)).toBe("Tenor,Par rate percent\n1M,3.74\n1Y,3.61\n10Y,4.28\n");
  });
  it("pastes back through the paste reader to the snapshot's own decimals", () => {
    const r = parsePaste(marketTemplateCsv(SNAP), { unit: "auto" });
    expect(r.rows).toEqual([{ tenorMonths: 1, value: 0.0374 }, { tenorMonths: 12, value: 0.0361 }, { tenorMonths: 120, value: 0.0428 }]);
    expect(percentText(0.0428)).toBe("4.28");
  });
});

describe("the curve edit", () => {
  it("opens on the snapshot's quotes and lays a paste over them by tenor", () => {
    const rows = editRowsOf(SNAP);
    expect(rows.map((r) => [r.tenorMonths, r.snapshotPercent, r.editPercent])).toEqual([[1, "3.74", "3.74"], [12, "3.61", "3.61"], [120, "4.28", "4.28"]]);
    const pasted = applyPaste(rows, "Tenor\tRate\n10Y\t4.53\n2Y\t3.9\n");
    expect(pasted.rows.map((r) => r.editPercent)).toEqual(["3.74", "3.61", "4.53"]);
    expect(pasted.notes).toEqual(["2Y is not a tenor of this curve; it was left out."]);
    expect(changedRows(pasted.rows)).toEqual([{ tenor: "10Y", fromPercent: "4.28", toPercent: "4.53", changeBp: 25 }]);
  });
  it("builds the snapshot side and the edited side as curve setups on the snapshot's convention", () => {
    const rows = editRowsOf(SNAP);
    rows[2]!.editPercent = "4.53";
    const before = curveBlockOf(SNAP, rows, "snapshot", "edited-1", "Snapshot curve");
    const after = curveBlockOf(SNAP, rows, "edit", "edited-1", "Edited curve 1");
    expect(before.block).toEqual({
      id: "edited-1", label: "Snapshot curve", baseCurve: "UST", interpolation: "log-linear-df", dayCount: "ACT/365", compounding: "semi-annual",
      inputs: [
        { instrument: "ois-swap", tenorMonths: 1, quoteType: "par-rate", value: 0.0374 },
        { instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.0361 },
        { instrument: "ois-swap", tenorMonths: 120, quoteType: "par-rate", value: 0.0428 },
      ],
    });
    expect(after.block!.inputs[2]).toEqual({ instrument: "ois-swap", tenorMonths: 120, quoteType: "par-rate", value: 0.0453 });
    rows[1]!.editPercent = "abc";
    expect(curveBlockOf(SNAP, rows, "edit", "e", "E").problems).toEqual(["1Y: abc% is not a number"]);
  });
  it("names the next variant", () => {
    expect(nextVariantId([])).toBe("edited-1");
    expect(nextVariantId(["edited-1", "other"])).toBe("edited-2");
  });
});

describe("the template as the editor holds it (fix round 1, L12)", () => {
  it("carries the typed rates, the edit included, and pastes back to them", () => {
    const rows = editRowsOf(SNAP);
    rows[2]!.editPercent = "4.53";
    expect(templateFromRows(rows)).toBe("Tenor,Par rate percent\n1M,3.74\n1Y,3.61\n10Y,4.53\n");
    expect(parsePaste(templateFromRows(rows), { unit: "auto" }).rows[2]).toEqual({ tenorMonths: 120, value: 0.0453 });
  });
});
