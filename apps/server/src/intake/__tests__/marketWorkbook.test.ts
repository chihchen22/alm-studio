/**
 * Market workbook intake: reuses the kernel's importMarketWorkbook (the
 * 4-sheet market-data workbook layout), passes kernel refusals through verbatim, and returns
 * the kernel ImportSummary for the route to store.
 *
 * The workbook under test is built in memory from INVENTED synthetic numbers
 * (a flat-ish 4% curve, spreads of tens of basis points, vols near 80 bp
 * normal). No market quote is used or shipped.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseMarketWorkbook } from "../marketWorkbook";

type Aoa = (string | number)[][];

function buildWorkbook(sheets: Record<string, Aoa>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

const SYNTHETIC_SHEETS: Record<string, Aoa> = {
  SOFR_OIS_Curve: [
    ["Term", "InstType", "Mid"],
    ["1 D", "CASH", 0.04],
    ["1 MO", "CASH", 0.041],
    ["1 YR", "SWAP", 0.042],
    ["5 YR", "SWAP", 0.043],
  ],
  FHLB_Curve: [
    ["Term", "Mid"],
    ["1 D", 0.04],
    ["1 MO", 0.044],
    ["1 YR", 0.0455],
    ["5 YR", 0.047],
  ],
  Cap_Volatility: [
    ["Synthetic cap vol surface"],
    ["Expiry", "1.00%", "ATM"],
    ["1 YR", 0.008, 0.0085],
    ["5 YR", 0.0082, 0.0087],
  ],
  ATM_Swaption_Volatility: [
    ["Synthetic ATM swaption vols"],
    ["Expiry", "1 YR", "5 YR"],
    ["1 YR", 0.007, 0.0075],
    ["5 YR", 0.0072, 0.0077],
  ],
};

describe("parseMarketWorkbook", () => {
  it("parses a synthetic 4-sheet workbook and returns the kernel ImportSummary", () => {
    const bytes = buildWorkbook(SYNTHETIC_SHEETS);
    const result = parseMarketWorkbook(bytes, "synthetic_market_20260630.xlsx", "2026-01-01");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.summary).toEqual({
      sourceFile: "synthetic_market_20260630.xlsx",
      calibrationDate: "2026-06-30", // from the filename suffix, not the fallback
      dateFromFilename: true,
      curveNodes: 4,
      termFundingNodes: 4, // kernel re-sync: ImportSummary key renamed from fhlbNodes
      tlpNodes: 4,
      capExpiries: 2,
      capStrikes: 2,
      swaptionExpiries: 2,
      swaptionTenors: 2,
    });

    expect(result.snapshot.calibrationDate).toBe("2026-06-30");
    expect(result.snapshot.curveQuotes).toHaveLength(4);
    // Term LP: 1D pinned to zero at t 0; the others are FHLB minus SOFR.
    expect(result.snapshot.tlpNodes[0]).toEqual({ tYears: 0, spread: 0 });
    expect(result.snapshot.tlpNodes[1].spread).toBeCloseTo(0.003, 10);
    // The explicit ATM column arrives as isAtm quotes.
    expect(result.snapshot.capQuotes.filter((q) => q.isAtm)).toHaveLength(2);
  });

  it("falls back to the stated date when the filename has no suffix", () => {
    const result = parseMarketWorkbook(buildWorkbook(SYNTHETIC_SHEETS), "book.xlsx", "2026-03-31");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.calibrationDate).toBe("2026-03-31");
    expect(result.summary.dateFromFilename).toBe(false);
  });

  it("passes kernel refusals through verbatim (missing sheet)", () => {
    const { Cap_Volatility: _dropped, ...withoutCaps } = SYNTHETIC_SHEETS;
    const result = parseMarketWorkbook(buildWorkbook(withoutCaps), "book.xlsx", "2026-03-31");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Missing sheet "Cap_Volatility"');
  });

  it("refuses a non-ISO fallback date instead of inventing one", () => {
    const result = parseMarketWorkbook(buildWorkbook(SYNTHETIC_SHEETS), "book.xlsx", "yesterday");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("ISO date");
  });

  it("refuses corrupt bytes with the parser's own message", () => {
    const result = parseMarketWorkbook(new Uint8Array([1, 2, 3, 4]), "junk.xlsx", "2026-03-31");
    expect(result.ok).toBe(false);
  });
});
