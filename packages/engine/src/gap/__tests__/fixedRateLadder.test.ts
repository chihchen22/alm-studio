/**
 * The fixed-rate (rate-locked) gap ladder, the rate-locked half of the ALCO view.
 *
 * Expected figures are restated by hand, never read back from the code under test: a level-pay schedule from the
 * closed-form annuity, bullets at their maturity month.
 */
import { describe, expect, it } from "vitest";
import {
  FIXED_LOAN_DEFAULTS,
  FLOATING_LOAN_DEFAULTS,
  NMD_B_TERMS_DEFAULTS,
  NMD_TERMS_DEFAULTS,
} from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { GAP_BAND_LABELS } from "../bands";
import { computeFixedRateLadder, rateLockOf } from "../fixedRateLadder";

const M = 1_000_000;

interface Row { id: string; side: "asset" | "liability"; terms: PositionTerms; repricingTreatment?: "excluded" }

function book(rows: Row[]): PortfolioSpec {
  const coa = {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "liabilities", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      ...rows.map((r, i) => ({
        id: `coa-${r.id}`, label: r.id, parentId: r.side === "asset" ? "assets" : "liabilities",
        side: r.side, isLeaf: true, familyId: r.id, order: i,
      })),
    ],
    families: rows.map((r) => ({ id: r.id, label: r.id, side: r.side, instrumentType: r.terms.type, coaNodeId: `coa-${r.id}` })),
  } as ChartOfAccounts;
  return {
    id: "PF-FIXED-RATE",
    label: "Fixed-rate ladder test book",
    asOf: "2026-03-31",
    coa,
    positions: rows.map((r) => ({
      id: r.id, familyId: r.id, coaNodeId: `coa-${r.id}`, terms: r.terms,
      ...(r.repricingTreatment !== undefined ? { repricingTreatment: r.repricingTreatment } : {}),
    })),
  };
}

const levelPay = (id: string, notionalM: number, months: number, coupon: number, offset = 0): PositionTerms => ({
  ...FIXED_LOAN_DEFAULTS, id, notional: notionalM * M, maturityMonths: months, originationOffsetMonths: offset, amortType: "level-pay", coupon,
});
const bullet = (id: string, notionalM: number, months: number): PositionTerms => ({
  ...FIXED_LOAN_DEFAULTS, id, notional: notionalM * M, maturityMonths: months, originationOffsetMonths: 0, amortType: "bullet", coupon: 0.04,
});

/** Cash flows from the engine's own factory on a flat 4% path: a fixed schedule does not read the path. */
const flatPath = { rateAt: () => 0.04, length: 361 } as unknown as Parameters<ReturnType<typeof makeInstrument>["generateCashflows"]>[0];
const cashflowsOf = (p: Position) => makeInstrument(p.terms, {}).generateCashflows(flatPath);

/** Six buckets from the nine engine bands: 1-5Y is 1-2Y + 2-3Y + 3-5Y, beyond 5Y is 5-10Y + 10Y+. */
function sixBuckets(rows: { assets: number; liabilities: number }[]) {
  const groups = [[0], [1], [2], [3], [4, 5, 6], [7, 8]];
  return groups.map((ix) => ({
    assets: ix.reduce((s, i) => s + rows[i]!.assets, 0) / M,
    liabilities: ix.reduce((s, i) => s + rows[i]!.liabilities, 0) / M,
  }));
}

describe("computeFixedRateLadder", () => {
  it("slots a level-pay schedule by payment month: the closed-form annuity principal, summed by bucket", () => {
    // $500M, 30 years, 6.00%: payment A = N r / (1 - (1 + r)^-n) with r = 0.5% a month; principal in month k is
    // A (1 + r)^-(n - k + 1). Restated here from the annuity formula, not from the module.
    const N = 500, n = 360, r = 0.06 / 12;
    const A = (N * r) / (1 - (1 + r) ** -n);
    const principal = (k: number) => A * (1 + r) ** -(n - k + 1);
    const sum = (from: number, to: number) => { let t = 0; for (let k = from; k <= to; k++) t += principal(k); return t; };
    const want = [sum(1, 1), sum(2, 3), sum(4, 6), sum(7, 12), sum(13, 60), sum(61, 360)];
    const b = book([{ id: "mortgage", side: "asset", terms: levelPay("mortgage", N, n, 0.06) }]);
    const ladder = computeFixedRateLadder(b, "S0", cashflowsOf);
    expect(ladder.scenarioId).toBe("S0");
    expect(ladder.bands).toEqual([...GAP_BAND_LABELS]);
    expect(ladder.rows.map((x) => x.band)).toEqual([...GAP_BAND_LABELS]);
    sixBuckets(ladder.rows).forEach((x, i) => expect(Math.abs(x.assets - want[i]!)).toBeLessThan(1e-6));
    // The cumulative gap through the open last band is the whole book: nothing is cut at a horizon.
    expect(Math.abs(ladder.rows[8]!.cumulativeGap - N * M)).toBeLessThan(1e-3);
  });

  it("books each fixed bullet whole at its maturity month", () => {
    const b = book([
      { id: "term-3m", side: "liability", terms: bullet("term-3m", 300, 3) },
      { id: "term-6m", side: "liability", terms: bullet("term-6m", 250, 6) },
      { id: "term-12m", side: "liability", terms: bullet("term-12m", 200, 12) },
      { id: "advance-2y", side: "liability", terms: bullet("advance-2y", 150, 24) },
      { id: "advance-3y", side: "liability", terms: bullet("advance-3y", 100, 36) },
    ]);
    const six = sixBuckets(computeFixedRateLadder(b, "S0", cashflowsOf).rows);
    // 3m in 1-3M, 6m in 3-6M, 12m in 6-12M, the two advances in 1-5Y.
    expect(six.map((x) => Math.round(x.liabilities * 1e6) / 1e6)).toEqual([0, 300, 250, 200, 250, 0]);
    expect(six.every((x) => x.assets === 0)).toBe(true);
  });

  it("leaves floaters, nmd-b and a managed-rate nmd out, and places an nmd slice held out of repricing", () => {
    const floater: PositionTerms = { ...FLOATING_LOAN_DEFAULTS, id: "cash", notional: 1500 * M, maturityMonths: 60, originationOffsetMonths: 0, amortType: "bullet", margin: 0, resetFrequencyMonths: 1 };
    const nmdB: PositionTerms = { ...NMD_B_TERMS_DEFAULTS, id: "hys-a", notional: 3600 * M, maturityMonths: 360, originationOffsetMonths: 0 };
    const nmd: PositionTerms = { ...NMD_TERMS_DEFAULTS, id: "checking-nib", notional: 1667 * M, maturityMonths: 360, originationOffsetMonths: 0 };
    const b = book([
      { id: "cash", side: "asset", terms: floater },
      { id: "hys-a", side: "liability", terms: nmdB },
      { id: "checking-nib", side: "liability", terms: nmd },
    ]);
    const ladder = computeFixedRateLadder(b, "S0", cashflowsOf);
    expect(ladder.rows.every((r) => r.assets === 0 && r.liabilities === 0)).toBe(true);
    expect(ladder.uncovered).toEqual([]);
    expect(rateLockOf(b.positions[0]!)).toBe("not-locked");
    expect(rateLockOf(b.positions[1]!)).toBe("not-locked");
    expect(rateLockOf(b.positions[2]!)).toBe("not-locked");
    expect(rateLockOf({ ...b.positions[2]!, repricingTreatment: "excluded" })).toBe("locked");
  });

  it("names a swap and a commitment as uncovered, with the reason", () => {
    const swap = { id: "sw", familyId: "sw", coaNodeId: "x", terms: { type: "swap" } } as unknown as Position;
    const commitment = { id: "cm", familyId: "cm", coaNodeId: "x", terms: { type: "commitment" } } as unknown as Position;
    expect(rateLockOf(swap)).toEqual({ reason: expect.stringMatching(/swap/) });
    expect(rateLockOf(commitment)).toEqual({ reason: expect.stringMatching(/commitment/) });
  });

  it("drops the elapsed months of a seasoned loan: the cumulative gap is the balance still to come", () => {
    const fresh = book([{ id: "auto", side: "asset", terms: levelPay("auto", 1200, 60, 0.06) }]);
    const seasoned = book([{ id: "auto", side: "asset", terms: levelPay("auto", 1200, 60, 0.06, -12) }]);
    const all = computeFixedRateLadder(fresh, "S0", cashflowsOf);
    const left = computeFixedRateLadder(seasoned, "S0", cashflowsOf);
    // The first 12 months of the fresh schedule are elapsed on the seasoned one.
    const firstYear = all.rows.slice(0, 4).reduce((s, r) => s + r.assets, 0);
    expect(Math.abs(left.rows[8]!.cumulativeGap - (1200 * M - firstYear))).toBeLessThan(1e-3);
    // Month 13 of the schedule is month 1 from as-of.
    const month13 = cashflowsOf(fresh.positions[0]!).find((c) => c.monthOffset === 13)!.principalPaid;
    expect(Math.abs(left.rows[0]!.assets - month13)).toBeLessThan(1e-6);
  });
});
