// packages/engine/src/macro/__tests__/housingMortgage.test.ts
/**
 * HousingMortgage (spec v4 Sections 3 and 10): A2 at
 * instrument level, A3 schedule identity, A3b normalization continuity and C9
 * turnover isolation. The CPR is restated here from the spec formulas and the
 * kernel, never taken from housingCprSchedule.
 *
 * Monitoring trigger (Section 13): fails on a kernel re-vendor; re-pin only with a recorded hand check.
 * This file and housingFlatIdentity.test.ts are the A2 mirror parity guard named in packages/kernel/DIVERGENCE.md
 * ("Engine mirrors of kernel code"; not PROVENANCE.md, whose bytes are hashed into every run's provenance).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { FourFactorCPR, Mortgage, type MarketSnapshot, type MortgageTerms, type PrepayContext, type RatePath } from "@alm/kernel";
import { DEFAULT_GENERATOR_CONFIG, generatePortfolio } from "../../../../../data/src";
import { buildBaseCurve, buildRatePath } from "../../scenario/rateEnvironment";
import { loadMarket } from "../../run/__tests__/fixtures";
import { HousingMortgage, housingCprSchedule } from "../housingMortgage";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const ramp = (end: number) => Array.from({ length: 360 }, (_, i) => 1 + (end - 1) * Math.min(1, (i + 1) / 24));
let path: RatePath; let mortgages: MortgageTerms[];
beforeAll(async () => {
  const market: MarketSnapshot = await loadMarket();
  path = buildRatePath(buildBaseCurve(market), 360);
  const book = generatePortfolio({ ...DEFAULT_GENERATOR_CONFIG, portfolioId: "synthetic-2500-v1", portfolioLabel: "x", targetPositions: 2500 });
  mortgages = book.positions.filter((p) => p.terms.type === "mortgage").map((p) => p.terms as MortgageTerms);
});

// Section 3, restated in the test from the spec, independent of housingCprSchedule.
function restated(terms: MortgageTerms, hpi: number[]): number[] {
  const p = { ...terms.cprParams, wac: terms.noteRate * 100 };
  const spread = (p.secSpread + p.primSpread) / 1e4;
  const ctx: PrepayContext = { term: terms.maturityMonths, age: terms.ageMonths, noteRate: terms.noteRate, mortgageRateAt: (m) => path.forwardRateAt(m - 1, 10) + spread };
  const K = new FourFactorCPR(p).cprSchedule(ctx);
  const T = new FourFactorCPR({ ...p, maxCpr: p.minCpr }).cprSchedule(ctx);
  const n = terms.maturityMonths, i = terms.noteRate / 12;
  const out: number[] = [];
  for (let m = 1; m <= n; m++) {
    const b = i > 1e-12 ? (Math.pow(1 + i, n) - Math.pow(1 + i, m - 1)) / (Math.pow(1 + i, n) - 1) : 1 - (m - 1) / n;
    const Hm = hpi[Math.min(m - 1, hpi.length - 1)]!;
    const SR = (L: number) => 1 / (1 + Math.exp(20 * (L - 0.97)));
    const ST = (L: number) => 0.75 + 0.25 / (1 + Math.exp(10 * (L - 1)));
    const lb = 0.7 * b, L = lb / Hm, MR = SR(L) / SR(lb), MT = ST(L) / ST(lb);
    out.push(MR === 1 && MT === 1 ? K[m - 1]! : Math.min(1, (K[m - 1]! - T[m - 1]!) * MR + Math.max(T[m - 1]! * MT, Math.min(T[m - 1]!, 0.015))));
  }
  return out;
}
// The emitted CPR, recovered from the rows: smm = pp / max(0, bal - sp), cpr = 1 - (1 - smm)^12.
function emittedCpr(terms: MortgageTerms, rows: Array<{ balance: number; principalPaid: number }>): number[] {
  const i = terms.noteRate / 12, n = terms.maturityMonths;
  return rows.slice(0, -1).map((r, k) => {
    const rem = n - k; const sp = i > 1e-12 ? r.balance * (i / (Math.pow(1 + i, rem) - 1)) : r.balance / rem;
    const smm = (r.principalPaid - sp) / Math.max(0, r.balance - sp);
    return 1 - Math.pow(1 - smm, 12);
  });
}

describe("A2 at instrument level: flat path is the kernel byte for byte", () => {
  it("every seeded mortgage term set", () => {
    expect(mortgages.length).toBe(825); // 750 mortgages + 75 mbs, spec Section 2
    const flat = new Array(360).fill(1);
    for (const t of mortgages) {
      expect(JSON.stringify(new HousingMortgage(t, H, flat).generateCashflows(path))).toBe(JSON.stringify(new Mortgage(t).generateCashflows(path)));
      expect(new HousingMortgage(t, H, flat).repricingSchedule()).toEqual(new Mortgage(t).repricingSchedule());
    }
  });
});

describe("A3 schedule identity", () => {
  it("mortgages-0 (4.81 percent) and the first mbs position follow the restated CPR to 1e-12", () => {
    const m0 = mortgages.find((t) => t.id === "mortgages-0")!;
    expect(m0.noteRate).toBe(0.0481);
    const mbs0 = mortgages.find((t) => t.id.startsWith("mbs-"))!;
    expect([m0.maturityMonths, mbs0.maturityMonths]).toEqual([326, 335]); // remaining terms of the two seeded positions
    for (const t of [m0, mbs0]) {
      const hpi = ramp(0.7);
      const rows = new HousingMortgage(t, H, hpi).generateCashflows(path);
      const want = restated(t, hpi); const got = emittedCpr(t, rows);
      // Power (Slice 2 M2): one row per remaining month, the last dropped by emittedCpr, so a truncated schedule fails.
      expect(want.length).toBe(t.maturityMonths);
      expect(got.length).toBe(t.maturityMonths - 1);
      got.forEach((c, k) => expect(Math.abs(c - want[k]!)).toBeLessThanOrEqual(1e-12));
    }
  });
});

describe("A3b normalization continuity on H = 1 + 1e-9", () => {
  it("emitted CPR within 1e-7 K of the kernel every month", () => {
    const t = mortgages.find((x) => x.id === "mortgages-0")!;
    const hpi = new Array(360).fill(1 + 1e-9);
    const got = emittedCpr(t, new HousingMortgage(t, H, hpi).generateCashflows(path));
    const k = emittedCpr(t, new Mortgage(t).generateCashflows(path));
    expect([got.length, k.length]).toEqual([325, 325]); // mortgages-0 has 326 remaining months; the last row is dropped
    got.forEach((c, m) => expect(Math.abs(c - k[m]!)).toBeLessThanOrEqual(1e-7 * k[m]! + 1e-15));
  });
});

describe("b(m-1) zero-rate branch (F5, Slice 2 M2)", () => {
  it("at note rate 0 the balance fraction is linear: b(0) = 1, b(12) = 0.9666666666666667, b(359) = 1/360", () => {
    const term = 360;
    // H = asOfLtv makes L = b, so the refinancing logistic (mid 0.97, slope 20) reads b where it is steepest.
    const out = housingCprSchedule(new Array(term).fill(0.08), new Array(term).fill(0.03), H, new Array(term).fill(0.7), 0, term);
    expect(out.length).toBe(360);
    // Section 3 restated with K = 0.08, T = 0.03 and b given by hand, never computed by the module's branch.
    const SR = (L: number) => 1 / (1 + Math.exp(20 * (L - 0.97)));
    const ST = (L: number) => 0.75 + 0.25 / (1 + Math.exp(10 * (L - 1)));
    const cprAt = (b: number) => { const lb = 0.7 * b, L = lb / 0.7; return Math.min(1, 0.05 * (SR(L) / SR(lb)) + Math.max(0.03 * (ST(L) / ST(lb)), 0.015)); };
    for (const [m, b] of [[1, 1], [13, 0.9666666666666667], [360, 1 / 360]] as const) {
      expect(Math.abs(out[m - 1]! - cprAt(b)), `month ${m}`).toBeLessThanOrEqual(1e-14);
    }
  });
});

describe("C9 turnover isolation", () => {
  it("K - T >= 0 on every seeded position-month", () => {
    for (const t of mortgages) {
      const p = { ...t.cprParams, wac: t.noteRate * 100 }; const spread = (p.secSpread + p.primSpread) / 1e4;
      const ctx: PrepayContext = { term: t.maturityMonths, age: t.ageMonths, noteRate: t.noteRate, mortgageRateAt: (m) => path.forwardRateAt(m - 1, 10) + spread };
      const K = new FourFactorCPR(p).cprSchedule(ctx), T = new FourFactorCPR({ ...p, maxCpr: p.minCpr }).cprSchedule(ctx);
      for (let m = 0; m < K.length; m++) expect(K[m]! - T[m]!).toBeGreaterThanOrEqual(0);
    }
  });
});
