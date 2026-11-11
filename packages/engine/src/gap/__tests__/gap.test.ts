/**
 * Gap engine acceptance tests.
 *
 * Cross-checked against the kernel instruments directly (the kernel IS the Lab
 * math), so every reference number comes from the same generator the engine
 * runs, not a retyped constant. Covers the acceptance criteria: a pure fixed
 * book carries no reset-driven repricing gap, a monthly floater reprices in
 * band 0, the liquidity ladder conserves principal, the final cumulative gap is
 * total assets minus total liabilities, and the COA roll-up sums the leaves.
 *
 * W1-H3 additions (defects D1 and D2): floaters band by
 * their ACTUAL next reset (monthly / quarterly / annual land in 0-1M / 1-3M /
 * 6-12M), a floater with no reset after origination reprices by runoff, and an
 * interest-bearing NMD splits its repricing volume by the kernel initialBeta()
 * (beta slice in band 0, rate-locked slice by decay runoff) with beta = 0
 * byte-continuous with the pre-split ladder and beta = 1 booking the full
 * balance in band 0. The liquidity ladder is untouched by both fixes.
 */
import { describe, it, expect } from "vitest";
import {
  BETA_S_CURVE_DEFAULTS,
  FIXED_LOAN_DEFAULTS,
  FLOATING_LOAN_DEFAULTS,
  FixedLoan,
  FloatingLoan,
  NMDBeta,
  NMD_B_TERMS_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  betaAtRate,
  type BetaSCurveParams,
  type FixedLoanTerms,
  type FloatingLoanTerms,
  type NMDBetaTerms,
  type NMDTerms,
} from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { ScenarioRatePath } from "../../portfolio/aggregate";
import { buildBands, bandForBucket } from "../bands";
import { buildScenarioGap, buildGapResult } from "../gapEngine";

const HORIZON = 360;
const RATE = 0.04;
const path = new ConstantRatePath(RATE, HORIZON);
const AS_OF = "2026-01-01";

/**
 * COA with both sides: assets (fixed loans, floating loans) and liabilities
 * (CDs, here bullet fixed-rate). Enough structure to exercise a two-level
 * asset roll-up and an asset-vs-liability gap.
 */
function gapCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: false, order: 0 },
      { id: "a-fixed", label: "Fixed Loans", parentId: "loans", side: "asset", isLeaf: true, familyId: "A_FIXED", order: 0 },
      { id: "a-float", label: "Floating Loans", parentId: "loans", side: "asset", isLeaf: true, familyId: "A_FLOAT", order: 1 },
      { id: "liabs", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "l-cd", label: "CDs", parentId: "liabs", side: "liability", isLeaf: true, familyId: "L_CD", order: 0 },
    ],
    families: [
      { id: "A_FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "a-fixed" },
      { id: "A_FLOAT", label: "Floating Loans", side: "asset", instrumentType: "floating-loan", coaNodeId: "a-float" },
      { id: "L_CD", label: "CDs", side: "liability", instrumentType: "fixed-loan", coaNodeId: "l-cd" },
    ],
  };
}

function fixedTerms(id: string, o: Partial<FixedLoanTerms> = {}): FixedLoanTerms {
  return { ...FIXED_LOAN_DEFAULTS, id, ...o };
}
function floatTerms(id: string, o: Partial<FloatingLoanTerms> = {}): FloatingLoanTerms {
  return { ...FLOATING_LOAN_DEFAULTS, id, ...o };
}

function fixedAsset(id: string, o: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "A_FIXED", coaNodeId: "a-fixed", terms: fixedTerms(id, o) };
}
function floatAsset(id: string, o: Partial<FloatingLoanTerms> = {}): Position {
  return { id, familyId: "A_FLOAT", coaNodeId: "a-float", terms: floatTerms(id, o) };
}
function cdLiab(id: string, o: Partial<FixedLoanTerms> = {}): Position {
  return { id, familyId: "L_CD", coaNodeId: "l-cd", terms: fixedTerms(id, o) };
}

function makePf(positions: Position[]): PortfolioSpec {
  return { id: "PF", label: "gap book", asOf: AS_OF, coa: gapCoa(), positions };
}

const sp = (id: string): ScenarioRatePath => ({ scenarioId: id, path });

/** Sum principalPaid within the horizon for a set of kernel cashflows. */
function totalPrincipal(cfs: { monthOffset: number; principalPaid: number }[]): number {
  let s = 0;
  for (const cf of cfs) {
    const k = cf.monthOffset - 1;
    if (k >= 0 && k < HORIZON) s += cf.principalPaid;
  }
  return s;
}

// --- Bands -------------------------------------------------------------------

describe("gap bands", () => {
  it("partitions the 360-month horizon into the nine standard bands", () => {
    const bands = buildBands(HORIZON);
    expect(bands.map((b) => b.label)).toEqual([
      "0-1M", "1-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-5Y", "5-10Y", "10Y+",
    ]);
    expect(bands.map((b) => [b.startMonth, b.endMonth])).toEqual([
      [0, 1], [1, 3], [3, 6], [6, 12], [12, 24], [24, 36], [36, 60], [60, 120], [120, 360],
    ]);
  });

  it("maps buckets into the band whose [start, end) contains the bucket index", () => {
    const bands = buildBands(HORIZON);
    expect(bandForBucket(0, bands)).toBe(0); // month 1 -> band 0
    expect(bandForBucket(1, bands)).toBe(1); // month 2 -> 1-3M
    expect(bandForBucket(2, bands)).toBe(1);
    expect(bandForBucket(11, bands)).toBe(3); // 6-12M
    expect(bandForBucket(12, bands)).toBe(4); // 1-2Y
    expect(bandForBucket(23, bands)).toBe(4);
    expect(bandForBucket(359, bands)).toBe(8); // 10Y+
  });

  it("truncates the final band to a short horizon", () => {
    const bands = buildBands(24);
    expect(bands.map((b) => b.label)).toEqual(["0-1M", "1-3M", "3-6M", "6-12M", "1-2Y"]);
    expect(bands[bands.length - 1].endMonth).toBe(24);
  });
});

// --- Repricing: fixed vs floater ---------------------------------------------

describe("repricing gap", () => {
  it("a monthly floater reprices its full balance in band 0", () => {
    const notional = 500_000;
    const pf = makePf([floatAsset("FL1", { notional, maturityMonths: 60, resetFrequencyMonths: 1 })]);
    const { repricing } = buildScenarioGap(pf, sp("base"), HORIZON);

    // Band 0 carries the whole notional; no other band carries repricing volume.
    expect(repricing.rows[0].assets).toBeCloseTo(notional, 6);
    for (let b = 1; b < repricing.rows.length; b++) {
      expect(repricing.rows[b].assets).toBe(0);
    }
    expect(repricing.rows[0].gap).toBeCloseTo(notional, 6);
    expect(repricing.rows[repricing.rows.length - 1].cumulativeGap).toBeCloseTo(notional, 6);
  });

  it("a pure fixed-rate book carries no reset-driven gap: repricing equals the liquidity ladder", () => {
    const pf = makePf([
      fixedAsset("F1", { notional: 1_000_000, maturityMonths: 60 }),
      cdLiab("C1", { notional: 800_000, maturityMonths: 24, amortType: "bullet" }),
    ]);
    const { repricing, liquidity } = buildScenarioGap(pf, sp("base"), HORIZON);

    // With no resets anywhere, both ladders are the principal-runoff ladder.
    expect(repricing.rows).toEqual(liquidity.rows);
    expect(repricing.byCoaNode).toEqual(liquidity.byCoaNode);

    // And it is a genuine ladder, not a degenerate all-zero one: the fixed
    // asset amortizes across several bands.
    const nonZero = repricing.rows.filter((r) => r.assets !== 0).length;
    expect(nonZero).toBeGreaterThan(1);
  });

  it("a floater and a fixed loan differ: the floater front-loads, the fixed amortizes", () => {
    const pf = makePf([
      fixedAsset("F1", { notional: 1_000_000, maturityMonths: 60 }),
      floatAsset("FL1", { notional: 1_000_000, maturityMonths: 60, resetFrequencyMonths: 1 }),
    ]);
    const { repricing, liquidity } = buildScenarioGap(pf, sp("base"), HORIZON);
    // Repricing band 0 holds the fixed month-1 amortization plus the floater's
    // full notional; liquidity band 0 holds only the two month-1 amortizations.
    expect(repricing.rows[0].assets).toBeGreaterThan(liquidity.rows[0].assets);
  });
});

// --- Liquidity: conservation and cumulative gap ------------------------------

describe("liquidity gap", () => {
  const pf = makePf([
    fixedAsset("F1", { notional: 1_000_000, maturityMonths: 60 }),
    floatAsset("FL1", { notional: 500_000, maturityMonths: 36, resetFrequencyMonths: 1 }),
    cdLiab("C1", { notional: 800_000, maturityMonths: 24, amortType: "bullet" }),
    cdLiab("C2", { notional: 300_000, maturityMonths: 12, amortType: "bullet" }),
  ]);
  const { liquidity } = buildScenarioGap(pf, sp("base"), HORIZON);

  const assetPrincipal =
    totalPrincipal(new FixedLoan(fixedTerms("F1", { notional: 1_000_000, maturityMonths: 60 })).generateCashflows(path)) +
    totalPrincipal(new FloatingLoan(floatTerms("FL1", { notional: 500_000, maturityMonths: 36, resetFrequencyMonths: 1 })).generateCashflows(path));
  const liabPrincipal =
    totalPrincipal(new FixedLoan(fixedTerms("C1", { notional: 800_000, maturityMonths: 24, amortType: "bullet" })).generateCashflows(path)) +
    totalPrincipal(new FixedLoan(fixedTerms("C2", { notional: 300_000, maturityMonths: 12, amortType: "bullet" })).generateCashflows(path));

  it("conserves principal: banded asset and liability runoff sum to the book totals", () => {
    const sumAssets = liquidity.rows.reduce((s, r) => s + r.assets, 0);
    const sumLiabs = liquidity.rows.reduce((s, r) => s + r.liabilities, 0);
    expect(sumAssets).toBeCloseTo(assetPrincipal, 4);
    expect(sumLiabs).toBeCloseTo(liabPrincipal, 4);
  });

  it("cumulative gap in the final band equals total asset minus total liability principal", () => {
    const last = liquidity.rows[liquidity.rows.length - 1];
    expect(last.cumulativeGap).toBeCloseTo(assetPrincipal - liabPrincipal, 4);
  });

  it("cumulative gap is the running sum of per-band gap", () => {
    let running = 0;
    for (const r of liquidity.rows) {
      running += r.gap;
      expect(r.cumulativeGap).toBeCloseTo(running, 9);
    }
  });

  it("liabilities land where the bullets mature: 12m in 6-12M, 24m in 1-2Y", () => {
    // bucket 11 (month 12) is in band 3 (6-12M); bucket 23 (month 24) in band 4 (1-2Y).
    expect(liquidity.rows[3].liabilities).toBeCloseTo(300_000, 4);
    expect(liquidity.rows[4].liabilities).toBeCloseTo(800_000, 4);
  });
});

// --- COA roll-up -------------------------------------------------------------

describe("gap COA roll-up", () => {
  const pf = makePf([
    fixedAsset("F1", { notional: 1_000_000, maturityMonths: 60 }),
    floatAsset("FL1", { notional: 500_000, maturityMonths: 36, resetFrequencyMonths: 1 }),
    cdLiab("C1", { notional: 800_000, maturityMonths: 24, amortType: "bullet" }),
  ]);

  for (const kind of ["repricing", "liquidity"] as const) {
    it(`${kind}: every parent node equals the sum of its child leaves, per band`, () => {
      const ladder = buildScenarioGap(pf, sp("base"), HORIZON)[kind];
      const node = (id: string) => ladder.byCoaNode.find((n) => n.coaNodeId === id)!.rows;

      const loans = node("loans");
      const aFixed = node("a-fixed");
      const aFloat = node("a-float");
      const assetsRoot = node("assets");
      for (let b = 0; b < loans.length; b++) {
        expect(loans[b].assets).toBeCloseTo(aFixed[b].assets + aFloat[b].assets, 6);
        expect(assetsRoot[b].assets).toBeCloseTo(aFixed[b].assets + aFloat[b].assets, 6);
      }

      // Top-level headline rows equal the combination of the two root nodes.
      const liabsRoot = node("liabs");
      for (let b = 0; b < ladder.rows.length; b++) {
        expect(ladder.rows[b].assets).toBeCloseTo(assetsRoot[b].assets, 6);
        expect(ladder.rows[b].liabilities).toBeCloseTo(liabsRoot[b].liabilities, 6);
        expect(ladder.rows[b].gap).toBeCloseTo(assetsRoot[b].assets - liabsRoot[b].liabilities, 6);
      }
    });
  }

  it("emits every COA node in declared node-array order for both ladders", () => {
    const both = buildScenarioGap(pf, sp("base"), HORIZON);
    const order = ["assets", "loans", "a-fixed", "a-float", "liabs", "l-cd"];
    expect(both.repricing.byCoaNode.map((n) => n.coaNodeId)).toEqual(order);
    expect(both.liquidity.byCoaNode.map((n) => n.coaNodeId)).toEqual(order);
  });
});

// --- Determinism and multi-scenario ------------------------------------------

describe("gap determinism", () => {
  const pf = makePf([
    fixedAsset("F1", { notional: 1_000_000, maturityMonths: 60 }),
    floatAsset("FL1", { notional: 500_000, maturityMonths: 36 }),
    cdLiab("C1", { notional: 800_000, maturityMonths: 24, amortType: "bullet" }),
  ]);

  it("produces byte-identical GapResult across repeated runs", () => {
    const a = buildGapResult(pf, [sp("base"), sp("up200")], HORIZON);
    const b = buildGapResult(pf, [sp("base"), sp("up200")], HORIZON);
    expect(a).toEqual(b);
  });

  it("emits one repricing and one liquidity ladder per scenario, in input order", () => {
    const res = buildGapResult(pf, [sp("base"), sp("up200")], HORIZON);
    expect(res.repricing.map((l) => l.scenarioId)).toEqual(["base", "up200"]);
    expect(res.liquidity.map((l) => l.scenarioId)).toEqual(["base", "up200"]);
    expect(res.repricing.every((l) => l.kind === "repricing")).toBe(true);
    expect(res.liquidity.every((l) => l.kind === "liquidity")).toBe(true);
  });
});

// --- D1: floaters band by their actual next reset ----------------------------

describe("repricing gap: floater next-reset banding (D1)", () => {
  it("bullet floaters land by reset cadence: monthly 0-1M, quarterly 1-3M, annual 6-12M", () => {
    // Bullet amortization so no principal runs off before the reset: each
    // floater's ENTIRE notional must appear at its next actual reset. The
    // kernel schedule is [1, 1+R, ...] with month 1 the origination reset
    // (coupon set at as-of), so the next resets are months 2 / 4 / 13, which
    // sit 1 / 3 / 12 months out: buckets 0 / 2 / 11, bands 0-1M / 1-3M / 6-12M.
    const pf = makePf([
      floatAsset("FM", { notional: 1_000_000, maturityMonths: 60, resetFrequencyMonths: 1, amortType: "bullet" }),
      floatAsset("FQ", { notional: 1_000_000, maturityMonths: 60, resetFrequencyMonths: 3, amortType: "bullet" }),
      floatAsset("FA", { notional: 1_000_000, maturityMonths: 60, resetFrequencyMonths: 12, amortType: "bullet" }),
    ]);
    const { repricing } = buildScenarioGap(pf, sp("base"), HORIZON);
    const rows = repricing.byCoaNode.find((n) => n.coaNodeId === "a-float")!.rows;

    expect(rows.map((r) => r.assets)).toEqual([
      1_000_000, // 0-1M: the monthly floater
      1_000_000, // 1-3M: the quarterly floater (bucket 2)
      0, //         3-6M
      1_000_000, // 6-12M: the annual floater (bucket 11)
      0, 0, 0, 0, 0,
    ]);
  });

  it("a floater with no reset after origination reprices by runoff, like fixed", () => {
    // resetFrequencyMonths >= maturityMonths gives the schedule [1] only: the
    // coupon was set at origination and never moves again, so the position is
    // fixed-rate for its whole remaining life.
    const pf = makePf([
      floatAsset("FL1", { notional: 1_000_000, maturityMonths: 24, resetFrequencyMonths: 24 }),
    ]);
    const { repricing, liquidity } = buildScenarioGap(pf, sp("base"), HORIZON);
    expect(repricing.rows).toEqual(liquidity.rows);
    expect(repricing.byCoaNode).toEqual(liquidity.byCoaNode);
  });

  it("level-pay floater conserves notional: runoff before the reset plus balance at the reset", () => {
    const notional = 1_000_000;
    const pf = makePf([
      floatAsset("FQ", { notional, maturityMonths: 60, resetFrequencyMonths: 3, amortType: "level-pay" }),
    ]);
    const { repricing, liquidity } = buildScenarioGap(pf, sp("base"), HORIZON);
    const reprSum = repricing.rows.reduce((s, r) => s + r.assets, 0);
    const liqSum = liquidity.rows.reduce((s, r) => s + r.assets, 0);
    // Band totals conserve the notional to 1e-9 relative on both ladders.
    expect(Math.abs(reprSum - notional)).toBeLessThan(1e-9 * notional);
    expect(Math.abs(liqSum - notional)).toBeLessThan(1e-9 * notional);
    // The two months of amortization before the bucket-2 reset reprice at
    // runoff; the reset carries the rest. Nothing reprices after the reset
    // band (bucket 2 sits in band 1, 1-3M).
    for (let b = 2; b < repricing.rows.length; b++) {
      expect(repricing.rows[b].assets).toBe(0);
    }
  });
});

// --- D2: NMD-B beta split ----------------------------------------------------

/** COA with a fixed-loan asset and both deposit kinds on the liability side. */
function depositCoa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "a-fixed", label: "Fixed Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "A_FIXED", order: 0 },
      { id: "liabs", label: "Total Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "l-dda", label: "DDA", parentId: "liabs", side: "liability", isLeaf: true, familyId: "L_DDA", order: 0 },
      { id: "l-mma", label: "MMA", parentId: "liabs", side: "liability", isLeaf: true, familyId: "L_MMA", order: 1 },
    ],
    families: [
      { id: "A_FIXED", label: "Fixed Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "a-fixed" },
      { id: "L_DDA", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "l-dda" },
      { id: "L_MMA", label: "MMA", side: "liability", instrumentType: "nmd-b", coaNodeId: "l-mma" },
    ],
  };
}

const MMA_NOTIONAL = 2_000_000;

/** Deposit book: one fixed asset, one non-IB NMD, one IB NMD-B with the given S-curve. */
function depositPf(sCurve: BetaSCurveParams): PortfolioSpec {
  const ddaTerms: NMDTerms = { ...NMD_TERMS_DEFAULTS, id: "D1", notional: 1_500_000, maturityMonths: 120 };
  const mmaTerms: NMDBetaTerms = { ...NMD_B_TERMS_DEFAULTS, id: "B1", notional: MMA_NOTIONAL, maturityMonths: 120, sCurve };
  return {
    id: "PF-DEP",
    label: "deposit gap book",
    asOf: AS_OF,
    coa: depositCoa(),
    positions: [
      { id: "F1", familyId: "A_FIXED", coaNodeId: "a-fixed", terms: fixedTerms("F1", { notional: 3_000_000, maturityMonths: 60 }) },
      { id: "D1", familyId: "L_DDA", coaNodeId: "l-dda", terms: ddaTerms },
      { id: "B1", familyId: "L_MMA", coaNodeId: "l-mma", terms: mmaTerms },
    ],
  };
}

/** An S-curve that evaluates to EXACTLY beta = 0 at the 4% test rate. */
const S_CURVE_BETA_0: BetaSCurveParams = { betaMin: 0, betaMax: 0.5, k: 1, m: 1000, lambda: 1 };
/** An S-curve that evaluates to EXACTLY beta = 1 at the 4% test rate. */
const S_CURVE_BETA_1: BetaSCurveParams = { betaMin: 0, betaMax: 1, k: 50, m: -10, lambda: 1 };

describe("repricing gap: NMD-B beta split (D2)", () => {
  it("the constructed S-curves pin beta to exactly 0 and exactly 1 at the test rate", () => {
    // RATE = 0.04 decimal = 4.0 in the % units betaAtRate takes.
    expect(betaAtRate(4.0, S_CURVE_BETA_0)).toBe(0);
    expect(betaAtRate(4.0, S_CURVE_BETA_1)).toBe(1);
  });

  it("beta = 0 is byte-continuous with the pre-split ladder: repricing equals runoff", () => {
    const { repricing, liquidity } = buildScenarioGap(depositPf(S_CURVE_BETA_0), sp("base"), HORIZON);
    const repr = repricing.byCoaNode.find((n) => n.coaNodeId === "l-mma")!.rows;
    const liq = liquidity.byCoaNode.find((n) => n.coaNodeId === "l-mma")!.rows;
    // Strict equality (toEqual compares exact numbers): the beta = 0 case must
    // take the identical arithmetic path as before the split existed, where an
    // NMD-B repriced purely by its decay runoff.
    expect(repr).toEqual(liq);
  });

  it("beta = 1 books the full balance in band 0", () => {
    const { repricing } = buildScenarioGap(depositPf(S_CURVE_BETA_1), sp("base"), HORIZON);
    const rows = repricing.byCoaNode.find((n) => n.coaNodeId === "l-mma")!.rows;
    expect(rows[0].liabilities).toBeCloseTo(MMA_NOTIONAL, 5);
    for (let b = 1; b < rows.length; b++) {
      expect(rows[b].liabilities).toBe(0);
    }
  });

  it("intermediate beta: band 0 carries the beta slice plus the locked slice's own runoff; every later band is (1 - beta) of runoff; totals conserved to 1e-9", () => {
    const { repricing, liquidity } = buildScenarioGap(depositPf(BETA_S_CURVE_DEFAULTS), sp("base"), HORIZON);
    const repr = repricing.byCoaNode.find((n) => n.coaNodeId === "l-mma")!.rows;
    const liq = liquidity.byCoaNode.find((n) => n.coaNodeId === "l-mma")!.rows;

    const beta = betaAtRate(4.0, BETA_S_CURVE_DEFAULTS);
    expect(beta).toBeGreaterThan(0);
    expect(beta).toBeLessThan(1);

    const runoffTotal = liq.reduce((s, r) => s + r.liabilities, 0);
    expect(repr[0].liabilities).toBeCloseTo(beta * runoffTotal + (1 - beta) * liq[0].liabilities, 6);
    for (let b = 1; b < repr.length; b++) {
      expect(repr[b].liabilities).toBeCloseTo((1 - beta) * liq[b].liabilities, 6);
    }

    const reprTotal = repr.reduce((s, r) => s + r.liabilities, 0);
    expect(Math.abs(reprTotal - runoffTotal)).toBeLessThan(1e-9 * runoffTotal);
  });

  it("non-interest-bearing NMD stays pure runoff", () => {
    const { repricing, liquidity } = buildScenarioGap(depositPf(BETA_S_CURVE_DEFAULTS), sp("base"), HORIZON);
    const repr = repricing.byCoaNode.find((n) => n.coaNodeId === "l-dda")!.rows;
    const liq = liquidity.byCoaNode.find((n) => n.coaNodeId === "l-dda")!.rows;
    expect(repr).toEqual(liq);
  });

  it("the beta split leaves the liquidity ladder untouched: it equals the kernel runoff banded directly", () => {
    const pf = depositPf(BETA_S_CURVE_DEFAULTS);
    const { liquidity } = buildScenarioGap(pf, sp("base"), HORIZON);
    const rows = liquidity.byCoaNode.find((n) => n.coaNodeId === "l-mma")!.rows;

    // Reference: the same kernel instrument's principal runoff, banded by hand.
    const mmaTerms = pf.positions.find((p) => p.id === "B1")!.terms as NMDBetaTerms;
    const cfs = new NMDBeta(mmaTerms).generateCashflows(path);
    const bands = buildBands(HORIZON);
    const expected = new Array(bands.length).fill(0);
    for (const cf of cfs) {
      const k = cf.monthOffset - 1;
      if (k < 0 || k >= HORIZON) continue;
      expected[bandForBucket(k, bands)] += cf.principalPaid;
    }
    for (let b = 0; b < rows.length; b++) {
      expect(rows[b].liabilities).toBeCloseTo(expected[b], 9);
    }
  });
});
