/**
 * Piece 7b follow-up (mfu-1, Slice 1 M6): parseFredCsv reads a plain decimal
 * number and nothing else, and cutAt refuses rows that are not consecutive
 * months. The shipped files still parse under their pinned hashes
 * (macroHistoryAlignment.test.ts). Texts restated by hand.
 */
import { describe, expect, it } from "vitest";
import { cutAt, parseFredCsv } from "../../scripts/macroSeed";

const csv = (...rows: string[]) => ["observation_date,UNRATE", ...rows].join("\n");

describe("parseFredCsv token grammar", () => {
  it("accepts plain decimals, a negative and an empty gap", () => {
    expect(parseFredCsv(csv("2026-01-01,4.3", "2026-02-01,", "2026-03-01,12", "2026-04-01,-0.25"), "UNRATE")).toEqual([
      { month: "2026-01", value: 4.3 }, { month: "2026-02", value: null }, { month: "2026-03", value: 12 }, { month: "2026-04", value: -0.25 },
    ]);
  });
  it("refuses a token that is a number to Number() but not a plain decimal", () => {
    for (const tok of ["0x10", "1e3", ".5", "5.", "+4", "Infinity", "4.3 "]) {
      expect(() => parseFredCsv(csv(`2026-01-01,${tok}`), "UNRATE")).toThrow(`FRED file for UNRATE: line 2 value ${JSON.stringify(tok)} is not a plain decimal number`);
    }
  });
});

describe("cutAt consecutive months", () => {
  it("keeps consecutive rows up to the end month", () => {
    const rows = [{ month: "2025-12", value: 1 }, { month: "2026-01", value: 2 }, { month: "2026-02", value: 3 }];
    expect(cutAt(rows, "2026-01")).toEqual(rows.slice(0, 2));
  });
  it("refuses a gap", () => {
    expect(() => cutAt([{ month: "2025-12", value: 1 }, { month: "2026-02", value: 3 }], "2026-03"))
      .toThrow("FRED rows are not consecutive months: 2026-02 follows 2025-12; expected 2026-01");
  });
  it("refuses a duplicated month", () => {
    expect(() => cutAt([{ month: "2025-12", value: 1 }, { month: "2025-12", value: 1 }, { month: "2026-01", value: 2 }], "2026-01"))
      .toThrow("FRED rows are not consecutive months: 2025-12 follows 2025-12; expected 2026-01");
  });
});
