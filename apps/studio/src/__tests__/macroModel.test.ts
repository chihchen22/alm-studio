// apps/studio/src/__tests__/macroModel.test.ts
import { describe, expect, it } from "vitest";
import { macroRows, parseProjectionText, seriesPoints } from "../market/macroModel";

const un = { id: "unrate", label: "Civilian unemployment rate (BLS via FRED)", kind: "rate", role: "history", unit: "decimal",
  firstMonth: "2025-09", values: [0.044, null, 0.045, 0.045, 0.044, 0.044, 0.043],
  source: { seriesId: "UNRATE", provider: "BLS via FRED", url: "u", retrievedOn: "2026-10-08", vintage: "FRED as retrieved 2026-10-08, revised, not point-in-time", endMonth: "2026-03", rawFileSha256: "a".repeat(64), knownGaps: ["2025-10"] } } as const;

describe("macroModel", () => {
  it("rows name source, end month and the gap", () => {
    expect(macroRows([un as never])).toEqual([{ id: "unrate", label: "Civilian unemployment rate (BLS via FRED)", kind: "rate", role: "history", unit: "decimal",
      firstMonth: "2025-09", endMonth: "2026-03", sourceText: "BLS via FRED, series UNRATE, retrieved 2026-10-08, FRED as retrieved 2026-10-08, revised, not point-in-time",
      gapsText: "Not published by the provider: 2025-10" }]);
  });
  it("keeps the gap as null, never interpolated", () => {
    expect(seriesPoints(un as never)).toEqual([[0, 0.044], [1, null], [2, 0.045], [3, 0.045], [4, 0.044], [5, 0.044], [6, 0.043]]);
  });
  it("parses pasted projections and refuses a non-number", () => {
    expect(parseProjectionText("1\n0.99, 0.98\n\n0.97")).toEqual({ values: [1, 0.99, 0.98, 0.97] });
    expect(parseProjectionText("1\nabc")).toEqual({ block: 'Line 2: "abc" is not a number' });
  });
});
