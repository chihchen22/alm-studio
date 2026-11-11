/**
 * Studio slice S3d fix round: the cd book's principal split into contractual maturities and early withdrawals, which
 * the liquidity stress ladder reads (a renewal share rolls maturities only). The split must add back to the stream
 * `generateCashflows` writes, month by month, and a zero-hazard book must withdraw nothing early.
 */
import { describe, expect, it } from "vitest";
import type { RatePath } from "@alm/kernel";
import { CdBookInstrument } from "../cdInstrument";
import { zeroHazardParams } from "../params";
import { cdMaturityMonths, type CdCohortSpec, type CdTerms } from "../terms";

const NO_PATH = {} as RatePath;
const BOOK: readonly CdCohortSpec[] = [
  { termMonths: 6, monthsToMaturity: 3, balance: 20, contractRate: 0.03 },
  { termMonths: 12, monthsToMaturity: 7, balance: 50, contractRate: 0.041 },
  { termMonths: 36, monthsToMaturity: 24, balance: 30, contractRate: 0.038 },
];
const terms: CdTerms = { id: "cd-split", type: "cd", label: "CD split", notional: 100_000_000, maturityMonths: cdMaturityMonths(BOOK), originationOffsetMonths: 0, amortType: "bullet", side: "liability", cohorts: BOOK };

describe("CdBookInstrument.principalSplit", () => {
  it("maturities plus early withdrawals are the stream's principal in every month", () => {
    const inst = new CdBookInstrument(terms);
    const stream = inst.generateCashflows(NO_PATH);
    const split = inst.principalSplit(NO_PATH);
    expect(split.map((s) => s.monthOffset)).toEqual(stream.map((c) => c.monthOffset));
    for (let i = 0; i < stream.length; i++) expect(Math.abs(split[i]!.maturity + split[i]!.early - stream[i]!.principalPaid)).toBeLessThan(1e-6);
    // Maturities fall only in the cohorts' maturity months (3, 7 and 24); early withdrawals are there and positive.
    expect(split.filter((s) => s.maturity > 0).map((s) => s.monthOffset)).toEqual([3, 7, 24]);
    expect(split.reduce((a, s) => a + s.early, 0)).toBeGreaterThan(0);
  });

  it("with no hazard every dollar matures: $20M at 3, $50M at 7, $30M at 24, nothing early", () => {
    const inst = new CdBookInstrument(terms, { params: zeroHazardParams() });
    const split = inst.principalSplit(NO_PATH);
    expect(split.every((s) => s.early === 0)).toBe(true);
    const at = (m: number) => split.find((s) => s.monthOffset === m)!.maturity;
    expect([at(3), at(7), at(24)].map((v) => Math.round(v))).toEqual([20_000_000, 50_000_000, 30_000_000]);
  });
});
