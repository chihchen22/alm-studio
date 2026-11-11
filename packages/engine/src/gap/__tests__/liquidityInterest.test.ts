/**
 * The interest-inclusive liquidity ladder, `GapLadder.withInterest`.
 *
 * Part 1 holds each instrument kind to a HAND-COMPUTED expectation, folded through the shared gap fold and built
 * by buildGapFromSeries on a flat rate path, so every number below is written out from the terms and the path
 * alone, never read back from the engine. Part 2 runs the pipeline: absence, the byte-equality of every principal
 * field between an ON run and an OFF run, the fold order of the chunk sinks, shard 4 versus 1 in both modes,
 * user buckets on the interest basis, and the reconciliation to NII (spec Amendment A1 item 4).
 *
 * Amendment A1 (2026-10-19): interest counts on its payment date. Deposit interest is credited monthly and counts as
 * paid monthly (ruling 5 reversed); a CD pays its accrued interest with the principal it accrued on.
 *
 * Bands (buildBands at 360 months): index 0 is 0-1M (bucket 0), 1 is 1-3M (buckets 1-2), 2 is 3-6M (3-5), 3 is
 * 6-12M (6-11), 4 is 1-2Y (12-23).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Cashflow, MarketSnapshot, RatePath } from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { GapBucketRow, GapLadder } from "../../contracts/results";
import type { GapBucketsOption, RunResult } from "../../contracts/run";
import { EMPTY_DRAW_PATH } from "../../commitment/terms";
import { buildRunResult, type RunPipelineContext } from "../../run/orchestrate";
import { resolveDefaultContext } from "../../run/engine";
import { buildCellPlan } from "../../portfolio/cells";
import { SHARD_CHUNK, CHUNK_METRICS, CHUNK_METRICS_WITH_INTEREST } from "../../run/shard/chunk";
import { runStaticPass } from "../../run/shard/staticPass";
import { makeInstrument, type MakeInstrumentOptions } from "../../runtime/instrumentFactory";
import { zeroHazardParams } from "../../cd/params";
import { cdMaturityMonths, type CdCohortSpec } from "../../cd/terms";
import { buildBaseCurve } from "../../scenario";
import { buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { buildBands } from "../bands";
import { accumulateGapPosition, buildGapFromSeries, createFamilySeries } from "../index";
import {
  AS_OF,
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  nmdBetaPosition,
  nmdPosition,
  twoSidedBook,
} from "../../run/__tests__/fixtures";
import { coaWithSwapFamilies, hedgedBook, swapPosition, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";

const H = 360;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const relClose = (a: number, b: number, rel = 1e-9): boolean =>
  Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

// ---------------------------------------------------------------------------
// Part 1: hand-computed fixtures through the shared fold
// ---------------------------------------------------------------------------

/** A flat path: the 1M rate is `r` at every step. Restated, no curve. */
function flatPath(r: number): RatePath {
  const times = Array.from({ length: H + 1 }, (_, i) => i / 12);
  return { nSteps: H, times, rateAt: () => r, forwardRateAt: () => r };
}

/** One leaf per family under three roots, plus an equity root; each family's side and type as named. */
function unitCoa(): ChartOfAccounts {
  const fam = (id: string, side: "asset" | "liability" | "equity" | "derivative", instrumentType: string, parent: string, order: number) => ({
    node: { id: `n-${id}`, label: id, parentId: parent, side, isLeaf: true, familyId: id, order },
    family: { id, label: id, side, instrumentType, coaNodeId: `n-${id}` },
  });
  const leaves = [
    fam("FIX", "asset", "fixed-loan", "A", 0),
    fam("FLT", "asset", "floating-loan", "A", 1),
    fam("COM", "asset", "commitment", "A", 2),
    fam("DDA", "liability", "nmd", "L", 0),
    fam("MMA", "liability", "nmd-b", "L", 1),
    fam("BOR", "liability", "fixed-loan", "L", 2),
    fam("CD", "liability", "cd", "L", 3),
    fam("SWP", "derivative", "swap", "D", 0),
    fam("EQ", "equity", "fixed-loan", "E", 0),
  ];
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "A", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "L", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "D", label: "Derivatives", parentId: null, side: "derivative", isLeaf: false, order: 2 },
      { id: "E", label: "Equity", parentId: null, side: "equity", isLeaf: false, order: 3 },
      ...leaves.map((l) => l.node),
    ],
    families: leaves.map((l) => l.family),
  } as unknown as ChartOfAccounts;
}

const pos = (id: string, familyId: string, terms: Record<string, unknown>, extra: Partial<Position> = {}): Position =>
  ({ id, familyId, coaNodeId: `n-${familyId}`, terms: { id, ...terms }, ...extra }) as unknown as Position;

/** Zero early-withdrawal hazard: a CD held to maturity (the bullet). */
const HELD: MakeInstrumentOptions = { cd: { params: zeroHazardParams() } };

const cdPos = (id: string, cohorts: CdCohortSpec[], notional: number) =>
  pos(id, "CD", { type: "cd", notional, maturityMonths: cdMaturityMonths(cohorts), originationOffsetMonths: 0, amortType: "bullet", side: "liability", cohorts });

const fixedBullet = (id: string, familyId: string, notional: number, coupon: number, maturityMonths: number, offset = 0) =>
  pos(id, familyId, { type: "fixed-loan", notional, coupon, maturityMonths, originationOffsetMonths: offset, amortType: "bullet" });

/** Fold `positions` on `path` and build both ladders, asking for the interest-inclusive ladder. */
function unitGap(
  positions: Position[],
  path: RatePath,
  buckets?: { liquidity?: GapBucketsOption },
  factory?: MakeInstrumentOptions,
  streamOf?: (p: Position) => Cashflow[] | undefined,
) {
  const book: PortfolioSpec = { id: "PF-UNIT", label: "unit", asOf: AS_OF, coa: unitCoa(), positions };
  const series = createFamilySeries(book, H, true);
  for (const p of positions) {
    const inst = makeInstrument(p.terms, factory);
    const cfs = streamOf?.(p) ?? inst.generateCashflows(path);
    accumulateGapPosition(series, series.famIndex.get(p.familyId)!, inst, cfs, H, path, p.repricingTreatment === "excluded");
  }
  return { book, series, gap: buildGapFromSeries(book, "S0", series, H, buckets, "principal-plus-interest") };
}

/** The first `n` band rows' assets and liabilities, the shape every expectation below is written in. */
const cols = (rows: readonly GapBucketRow[], n = 5) => rows.slice(0, n).map((r) => [r.assets, r.liabilities]);

function expectRows(actual: readonly GapBucketRow[], expected: number[][]): void {
  const got = cols(actual, expected.length);
  expected.forEach(([a, l], b) => {
    expect(got[b]![0], `band ${b} assets`).toBeCloseTo(a!, 6);
    expect(got[b]![1], `band ${b} liabilities`).toBeCloseTo(l!, 6);
  });
  // Everything past the expected bands is zero.
  for (const r of actual.slice(expected.length)) {
    expect(r.assets).toBe(0);
    expect(r.liabilities).toBe(0);
  }
  for (const r of actual) expect(r.gap).toBe(r.assets - r.liabilities);
}

describe("hand-computed fixtures (slice 4a, Task 2)", () => {
  const path = flatPath(0.06);

  it("fixed loan, bullet: 1.2M at 6% for 12 months pays 6,000 a month and the notional in month 12", () => {
    // Interest 1,200,000 x 0.06 / 12 = 6,000 in each of buckets 0..11; principal 1,200,000 in bucket 11.
    const { gap } = unitGap([fixedBullet("F", "FIX", 1_200_000, 0.06, 12)], path);
    const liq = gap.liquidity;
    expectRows(liq.rows, [[0, 0], [0, 0], [0, 0], [1_200_000, 0]]);
    expectRows(liq.withInterest!.rows, [[6_000, 0], [12_000, 0], [18_000, 0], [1_236_000, 0]]);
    // Amendment A2: the interest on its own, from the interest carrier: 6,000 a month, no principal.
    expectRows(liq.withInterest!.interest.rows, [[6_000, 0], [12_000, 0], [18_000, 0], [36_000, 0]]);
    expect(has(gap.repricing, "withInterest")).toBe(false);
  });

  it("floating loan, bullet, monthly reset: 1M at 6% + 100bp margin for 6 months", () => {
    // Coupon r(m-1) + margin = 0.07 every month on a flat path: 1,000,000 x 0.07 / 12 = 5,833.33... a month,
    // buckets 0..5; principal 1,000,000 in bucket 5.
    const m = (1_000_000 * 0.07) / 12;
    const { gap } = unitGap(
      [pos("V", "FLT", { type: "floating-loan", notional: 1_000_000, maturityMonths: 6, originationOffsetMonths: 0, amortType: "bullet", indexTenorMonths: 1, margin: 0.01, resetFrequencyMonths: 1 })],
      path,
    );
    expectRows(gap.liquidity.rows, [[0, 0], [0, 0], [1_000_000, 0]]);
    expectRows(gap.liquidity.withInterest!.rows, [[m, 0], [2 * m, 0], [3 * m + 1_000_000, 0]]);
  });

  it("seasoned fixed loan: four months elapsed are dropped from the interest exactly as from the principal", () => {
    // Offset -4: months 1..4 shift below bucket 0 and drop; months 5..12 land in buckets 0..7. Eight months of
    // 6,000 interest; principal 1,200,000 in bucket 7 (band 6-12M).
    const { gap } = unitGap([fixedBullet("S", "FIX", 1_200_000, 0.06, 12, -4)], path);
    expectRows(gap.liquidity.rows, [[0, 0], [0, 0], [0, 0], [1_200_000, 0]]);
    expectRows(gap.liquidity.withInterest!.rows, [[6_000, 0], [12_000, 0], [18_000, 0], [1_212_000, 0]]);
  });

  it("liability: a 600k fixed borrowing at 4% books its interest in the liabilities column", () => {
    // 600,000 x 0.04 / 12 = 2,000 a month for 3 months; principal 600,000 in bucket 2.
    const { gap } = unitGap([fixedBullet("B", "BOR", 600_000, 0.04, 3)], path);
    expectRows(gap.liquidity.rows, [[0, 0], [0, 600_000]]);
    expectRows(gap.liquidity.withInterest!.rows, [[0, 2_000], [0, 604_000]]);
    // Amendment A2: interest expense on its own, in the liabilities column; net interest is its negative.
    expectRows(gap.liquidity.withInterest!.interest.rows, [[0, 2_000], [0, 4_000]]);
    expect(gap.liquidity.withInterest!.interest.rows[1]!.cumulativeGap).toBeCloseTo(-6_000, 6);
  });

  it("pay-fixed swap: the signed net settlement bands into assets; the principal ladder carries nothing", () => {
    // Receive floating 1,200,000 x 0.06 / 12 = 6,000, pay fixed 1,200,000 x 0.03 / 12 = 3,000: net +3,000 in
    // each of buckets 0..2. The notional exchanges are never cash.
    const { gap } = unitGap(
      [pos("W", "SWP", { type: "swap", notional: 1_200_000, maturityMonths: 3, originationOffsetMonths: 0, amortType: "bullet", direction: "pay-fixed", fixedRate: 0.03 })],
      path,
    );
    for (const r of gap.liquidity.rows) expect([r.assets, r.liabilities]).toEqual([0, 0]);
    expectRows(gap.liquidity.withInterest!.rows, [[3_000, 0], [6_000, 0]]);
    expectRows(gap.liquidity.withInterest!.interest.rows, [[3_000, 0], [6_000, 0]]);
  });

  it("receive-fixed swap: the net settlement is negative in assets when floating pays more than fixed", () => {
    // Receive fixed 3,000, pay floating 6,000: net -3,000 a month for 3 months.
    const { gap } = unitGap(
      [pos("W", "SWP", { type: "swap", notional: 1_200_000, maturityMonths: 3, originationOffsetMonths: 0, amortType: "bullet", direction: "receive-fixed", fixedRate: 0.03 })],
      path,
    );
    expectRows(gap.liquidity.withInterest!.rows, [[-3_000, 0], [-6_000, 0]]);
  });

  it("commitment: an undrawn line and a drawing line both add nothing to either ladder", () => {
    const { gap } = unitGap(
      [
        pos("C0", "COM", { type: "commitment", notional: 1_000_000, maturityMonths: 12, originationOffsetMonths: 0, amortType: "bullet", side: "asset", draw: EMPTY_DRAW_PATH }),
        pos("C1", "COM", { type: "commitment", notional: 1_000_000, maturityMonths: 12, originationOffsetMonths: 0, amortType: "bullet", side: "asset", draw: { rampRates: [0.25], steadyRate: 0.05 } }),
      ],
      path,
    );
    for (const r of [...gap.liquidity.rows, ...gap.liquidity.withInterest!.rows]) expect([r.assets, r.liabilities]).toEqual([0, 0]);
  });

  it("NMD monthly (A1 item 2): NMD, NMD-B and a regulatory child book their monthly interest in the liabilities column", () => {
    const deposits = [
      pos("D", "DDA", { ...nmdPosition("D", { notional: 3_000_000, depositRate: 0.02 }).terms }),
      pos("B", "MMA", { ...nmdBetaPosition("B", { notional: 2_000_000 }).terms }),
      // A regulatory non-core slice is a floating-loan by type and a deposit by parentPositionId; the rule is the
      // same as for any liability: its monthly coupon is paid monthly.
      pos("X", "BOR", { type: "floating-loan", notional: 500_000, maturityMonths: 1, originationOffsetMonths: 0, amortType: "bullet", indexTenorMonths: 1, margin: -0.03, resetFrequencyMonths: 1 }, { parentPositionId: "B" }),
    ];
    // The plain NMD credits interest on its opening balance at the deposit rate: 3,000,000 x 0.02 / 12 = 5,000 in
    // month 1, then balance x 0.02 / 12 on each month's opening balance, restated here from the balance column.
    const dda = makeInstrument(deposits[0]!.terms).generateCashflows(path);
    expect(dda[0]!.balance).toBeCloseTo(3_000_000, 6);
    expect(dda[0]!.interestPaid).toBeCloseTo(5_000, 9);
    for (const cf of dda.slice(0, 24)) expect(cf.interestPaid).toBeCloseTo((cf.balance * 0.02) / 12, 6);
    const { gap, series } = unitGap(deposits, path);
    const famInt = (f: string) => series.interest![series.famIndex.get(f)!]!;
    // Each deposit family's carrier is its own generator's interest month by month: no deposit is left out.
    for (const [f, p] of [["DDA", deposits[0]!], ["MMA", deposits[1]!]] as const) {
      const want = new Float64Array(H);
      for (const cf of makeInstrument(p.terms).generateCashflows(path)) if (cf.monthOffset - 1 < H) want[cf.monthOffset - 1] += cf.interestPaid;
      expect(want.some((v) => v > 0), f).toBe(true);
      famInt(f).forEach((v, k) => expect(v, `${f} month ${k + 1}`).toBe(want[k]));
    }
    // The non-core slice: (0.06 - 0.03) x 500,000 / 12 = 1,250 in bucket 0, beside its 500,000 principal.
    expect(famInt("BOR")[0]).toBeCloseTo(1_250, 9);
    expect(famInt("BOR").slice(1).every((v) => v === 0)).toBe(true);
    // In the ladder: liabilities column, interest added on top of principal, assets untouched.
    const monthly = (f: string, b0: number, b1: number) => famInt(f).slice(b0, b1).reduce((a, v) => a + v, 0);
    const bands = buildBands(H);
    gap.liquidity.rows.forEach((r, b) => {
      const w = gap.liquidity.withInterest!.rows[b]!;
      const band = bands[b]!;
      const want = monthly("DDA", band.startMonth, band.endMonth) + monthly("MMA", band.startMonth, band.endMonth) + monthly("BOR", band.startMonth, band.endMonth);
      expect(w.assets).toBe(0);
      expect(w.liabilities - r.liabilities, `band ${b}`).toBeCloseTo(want, 4);
    });
    expect(gap.liquidity.withInterest!.rows[0]!.liabilities - gap.liquidity.rows[0]!.liabilities).toBeGreaterThan(1_250);
  });

  it("held bullet CD (A1 item 3): zero interest cash until its maturity month, then the sum of its accruals", () => {
    // One 12-month cohort at 4%, notional 1,200,000, no early withdrawal (zero hazard): it accrues
    // 1,200,000 x 0.04 / 12 = 4,000 a month and pays nothing until month 12, which pays 12 x 4,000 = 48,000 with
    // the 1,200,000 principal (bucket 11, band 6-12M).
    const p = cdPos("C", [{ termMonths: 12, monthsToMaturity: 12, balance: 1, contractRate: 0.04 }], 1_200_000);
    const stream = makeInstrument(p.terms, HELD).generateCashflows(path);
    for (const cf of stream.slice(0, 12)) expect(cf.interestPaid).toBeCloseTo(4_000, 6);
    const { gap, series } = unitGap([p], path, undefined, HELD);
    const ci = series.interest![series.famIndex.get("CD")!]!;
    for (let k = 0; k < 11; k++) expect(ci[k], `month ${k + 1}`).toBe(0);
    expect(ci[11]).toBeCloseTo(48_000, 6);
    expect(ci.slice(12).every((v) => v === 0)).toBe(true);
    expectRows(gap.liquidity.rows, [[0, 0], [0, 0], [0, 0], [0, 1_200_000]]);
    expectRows(gap.liquidity.withInterest!.rows, [[0, 0], [0, 0], [0, 0], [0, 1_248_000]]);
  });

  it("CD early exit slice (A1 item 3): the leaving slice takes its pro rata share of the interest accrued to that point", () => {
    // A hand-written 1,200,000 CD stream at 4% (the fold reads the stream; the instrument only names the type):
    //   month 1: opening 1,200,000, accrues 4,000, nothing leaves               pays 0, accrued 4,000
    //   month 2: opening 1,200,000, accrues 4,000, 300,000 (25%) leaves early   pays 25% x 8,000 = 2,000, accrued 6,000
    //   month 3: opening   900,000, accrues 3,000, nothing leaves               pays 0, accrued 9,000
    //   month 4: opening   900,000, accrues 3,000, 900,000 matures              pays 12,000
    // Total paid 14,000 = 4,000 + 4,000 + 3,000 + 3,000, the accruals; only the timing moves.
    const p = cdPos("C", [{ termMonths: 6, monthsToMaturity: 4, balance: 1, contractRate: 0.04 }], 1_200_000);
    const row = (m: number, balance: number, principalPaid: number, interestPaid: number): Cashflow => ({
      monthOffset: m,
      balance,
      principalPaid,
      interestPaid,
      couponRate: 0.04,
    });
    const hand = [row(1, 1_200_000, 0, 4_000), row(2, 1_200_000, 300_000, 4_000), row(3, 900_000, 0, 3_000), row(4, 900_000, 900_000, 3_000)];
    const { gap, series } = unitGap([p], path, undefined, HELD, () => hand);
    const ci = Array.from(series.interest![series.famIndex.get("CD")!]!.slice(0, 5));
    expect(ci[0]).toBe(0);
    expect(ci[1]).toBeCloseTo(2_000, 9);
    expect(ci[2]).toBe(0);
    expect(ci[3]).toBeCloseTo(12_000, 9);
    expect(ci[4]).toBe(0);
    // Bands: 0-1M (bucket 0) nothing; 1-3M (buckets 1-2) 300,000 + 2,000; 3-6M (bucket 3) 900,000 + 12,000.
    expectRows(gap.liquidity.rows, [[0, 0], [0, 300_000], [0, 900_000]]);
    expectRows(gap.liquidity.withInterest!.rows, [[0, 0], [0, 302_000], [0, 912_000]]);
  });

  it("CD under the calibrated early-withdrawal hazard: interest is paid only in months principal leaves; the total is the accrual total", () => {
    const p = cdPos(
      "C",
      [
        { termMonths: 12, monthsToMaturity: 9, balance: 40, contractRate: 0.035 },
        { termMonths: 24, monthsToMaturity: 20, balance: 60, contractRate: 0.042 },
      ],
      10_000_000,
    );
    const stream = makeInstrument(p.terms).generateCashflows(path);
    // A real early exit before the first maturity, so the pro rata branch is exercised.
    expect(stream.some((cf) => cf.principalPaid > 0 && cf.monthOffset < 9)).toBe(true);
    const { series } = unitGap([p], path);
    const ci = series.interest![series.famIndex.get("CD")!]!;
    // The pay-with-principal pool, restated from the generator stream alone.
    const want = new Float64Array(H);
    let pool = 0;
    stream.forEach((cf, i) => {
      pool += cf.interestPaid;
      const share = i === stream.length - 1 || cf.principalPaid >= cf.balance ? 1 : cf.principalPaid / cf.balance;
      const paid = pool * share;
      pool -= paid;
      want[cf.monthOffset - 1] += paid;
    });
    ci.forEach((v, k) => expect(v, `month ${k + 1}`).toBeCloseTo(want[k]!, 6));
    for (const cf of stream) if (cf.principalPaid === 0) expect(ci[cf.monthOffset - 1]).toBe(0);
    const accrued = stream.reduce((a, cf) => a + cf.interestPaid, 0);
    expect(relClose(ci.reduce((a, v) => a + v, 0), accrued)).toBe(true);
    // The timing is not the accrual stream: month 1 accrues on the whole book but pays only the leavers' share.
    expect(ci[0]).toBeLessThan(stream[0]!.interestPaid);
  });

  it("an excluded non-deposit position books its interest as it books its liquidity (ruling 8)", () => {
    const plain = unitGap([fixedBullet("F", "FIX", 1_200_000, 0.06, 12)], path).gap.liquidity.withInterest!;
    const excluded = unitGap([{ ...fixedBullet("F", "FIX", 1_200_000, 0.06, 12), repricingTreatment: "excluded" }], path).gap.liquidity.withInterest!;
    expect(JSON.stringify(excluded)).toBe(JSON.stringify(plain));
  });

  it("an equity family drops at banding in both ladders", () => {
    const { gap, series } = unitGap([fixedBullet("Q", "EQ", 1_000_000, 0.06, 12)], path);
    expect(series.interest![series.famIndex.get("EQ")!]!.reduce((s, v) => s + v, 0)).toBeCloseTo(60_000, 6);
    for (const r of [...gap.liquidity.rows, ...gap.liquidity.withInterest!.rows]) expect([r.assets, r.liabilities]).toEqual([0, 0]);
  });

  it("user buckets on the interest basis: monthly rows are principal plus interest month by month", () => {
    const { gap } = unitGap([fixedBullet("F", "FIX", 1_200_000, 0.06, 12)], path, { liquidity: { kind: "monthly" } });
    const ub = gap.liquidity.withInterest!.userBuckets!;
    expect(ub.kind).toBe("monthly");
    expect(Object.keys(gap.liquidity.withInterest!)).toEqual(["rows", "userBuckets", "interest"]);
    expect(ub.rows).toHaveLength(H);
    for (let k = 0; k < 12; k++) expect(ub.rows[k]!.assets).toBeCloseTo(k === 11 ? 1_206_000 : 6_000, 6);
    for (let k = 12; k < H; k++) expect(ub.rows[k]!.assets).toBe(0);
    // Amendment A2: the interest's own monthly rows, 6,000 in each of months 1 to 12 and nothing after.
    const iub = gap.liquidity.withInterest!.interest.userBuckets!;
    expect(Object.keys(gap.liquidity.withInterest!.interest)).toEqual(["rows", "userBuckets"]);
    expect(iub.kind).toBe("monthly");
    expect(iub.rows).toHaveLength(H);
    for (let k = 0; k < 12; k++) expect(iub.rows[k]!.assets).toBeCloseTo(6_000, 6);
    for (let k = 12; k < H; k++) expect(iub.rows[k]!.assets).toBe(0);
    // The principal userBuckets stay principal.
    expect(gap.liquidity.userBuckets!.rows[0]!.assets).toBe(0);
    expect(gap.liquidity.userBuckets!.rows[11]!.assets).toBe(1_200_000);
  });

  it("user buckets on the interest basis: custom edges [2, 7] fold months 1-2, 3-7 and 8-360", () => {
    const { gap } = unitGap([fixedBullet("F", "FIX", 1_200_000, 0.06, 12)], path, { liquidity: { kind: "custom", edgesMonths: [2, 7] } });
    const ub = gap.liquidity.withInterest!.userBuckets!;
    expect(ub.edgesMonths).toEqual([2, 7]);
    expect(ub.rows.map((r) => r.band.label)).toEqual(["M1-M2", "M3-M7", "M8-M360"]);
    expect(ub.rows[0]!.assets).toBeCloseTo(12_000, 6);
    expect(ub.rows[1]!.assets).toBeCloseTo(30_000, 6);
    expect(ub.rows[2]!.assets).toBeCloseTo(1_230_000, 6);
    const iub = gap.liquidity.withInterest!.interest.userBuckets!;
    expect(iub.edgesMonths).toEqual([2, 7]);
    expect(iub.rows.map((r) => [r.assets, r.liabilities])).toEqual([[12_000, 0], [30_000, 0], [30_000, 0]].map(([a, l]) => [expect.closeTo(a!, 6), l]));
  });

  it("no bucket setting: withInterest carries rows and the interest rows only", () => {
    const { gap } = unitGap([fixedBullet("F", "FIX", 1_200_000, 0.06, 12)], path);
    expect(Object.keys(gap.liquidity.withInterest!)).toEqual(["rows", "interest"]);
    expect(Object.keys(gap.liquidity.withInterest!.interest)).toEqual(["rows"]);
  });

  it("asked for interest on a series with no interest carrier: refused, not read as zero", () => {
    const book: PortfolioSpec = { id: "PF-NO", label: "x", asOf: AS_OF, coa: unitCoa(), positions: [] };
    expect(() => buildGapFromSeries(book, "S0", createFamilySeries(book, H), H, undefined, "principal-plus-interest")).toThrow(/carries no interest/);
  });
});

// ---------------------------------------------------------------------------
// Part 2: the pipeline
// ---------------------------------------------------------------------------

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

type Opts = { liquidityFlows?: "principal" | "principal-plus-interest"; liquidityBuckets?: GapBucketsOption; shards?: number };

function runBook(book: PortfolioSpec, opts: Opts = {}): RunResult {
  const request = makeRunRequest(market, { portfolioId: book.id });
  return buildRunResult(request, book, { ...resolveDefaultContext(), ...opts } as RunPipelineContext);
}

/** The envelope with every withInterest key removed: what an OFF run must equal byte for byte. */
const stripInterest = (r: RunResult): string =>
  JSON.stringify({
    ...r,
    gap: {
      ...r.gap,
      repricing: r.gap.repricing,
      liquidity: r.gap.liquidity.map(({ withInterest: _w, ...rest }) => rest),
    },
  });

/** A multi-chunk book: fixed loans, mortgages, both deposit kinds and swaps, past two chunks. */
function bigBook(id: string): PortfolioSpec {
  const positions: Position[] = [];
  const n = Math.ceil((2 * SHARD_CHUNK + 300) / 4);
  for (let i = 0; i < n; i++) {
    const jitter = 1 + (i % 89) / 1000;
    positions.push(fixedPosition(`F${i}`, { notional: 250_000 * jitter, coupon: 0.05, maturityMonths: 12 + (i % 120) }));
    positions.push(nmdPosition(`D${i}`, { notional: 150_000 * jitter }));
    positions.push(nmdBetaPosition(`B${i}`, { notional: 100_000 * jitter }));
    positions.push(swapPosition(`W${i}`, SWAP_FAMILY_ID, { notional: 50_000 * jitter, maturityMonths: 6 + (i % 60) }));
  }
  return { id, label: "slice 4a shard book", asOf: AS_OF, coa: coaWithSwapFamilies(makeCoa()), positions };
}

describe("absence and presence (slice 4a, Task 2)", () => {
  it("nothing asked and principal asked: no ladder carries withInterest, and the two envelopes are byte-equal", () => {
    const book = hedgedBook("PF-LI-A", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60 })]);
    const off = runBook(book);
    const principal = runBook(book, { liquidityFlows: "principal" });
    for (const l of [...off.gap.repricing, ...off.gap.liquidity, ...principal.gap.liquidity]) expect(has(l, "withInterest")).toBe(false);
    expect(JSON.stringify(principal)).toBe(JSON.stringify(off));
  });

  it("principal-plus-interest: every liquidity ladder carries it as its last key; no repricing ladder does", () => {
    const r = runBook(twoSidedBook("PF-LI-P"), { liquidityFlows: "principal-plus-interest", liquidityBuckets: { kind: "monthly" } });
    for (const l of r.gap.liquidity) {
      expect(Object.keys(l).at(-1)).toBe("withInterest");
      expect(Object.keys(l.withInterest!)).toEqual(["rows", "userBuckets", "interest"]);
      expect(Object.keys(l.withInterest!.interest)).toEqual(["rows", "userBuckets"]);
    }
    for (const l of r.gap.repricing) expect(has(l, "withInterest")).toBe(false);
  });
});

describe("principal byte-equality ON versus OFF (rulings 2 and 11)", () => {
  for (const [label, book, buckets] of [
    ["two-sided book", () => twoSidedBook("PF-LI-BE1"), undefined],
    ["hedged book with monthly liquidity buckets", () => hedgedBook("PF-LI-BE2", [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60 })]), { kind: "monthly" } as GapBucketsOption],
  ] as const) {
    it(`${label}: rows, byCoaNode and every other field equal the OFF run once withInterest is removed`, () => {
      const b = book();
      const extra = buckets !== undefined ? { liquidityBuckets: buckets } : {};
      const off = runBook(b, extra);
      const on = runBook(b, { ...extra, liquidityFlows: "principal-plus-interest" });
      off.gap.liquidity.forEach((l, i) => {
        expect(JSON.stringify(on.gap.liquidity[i]!.rows)).toBe(JSON.stringify(l.rows));
        expect(JSON.stringify(on.gap.liquidity[i]!.byCoaNode)).toBe(JSON.stringify(l.byCoaNode));
      });
      expect(stripInterest(on)).toBe(JSON.stringify(off));
    });
  }
});

describe("fold order and shard invariance (ruling 11)", () => {
  it(
    "the first five chunk metrics are byte-equal ON and OFF, inline and on 4 shards; the sink grows by one metric only when asked",
    () => {
      const book = bigBook("PF-LI-FOLD");
      expect(book.positions.length).toBeGreaterThan(2 * SHARD_CHUNK);
      const plan = buildCellPlan(book, undefined);
      const r = makeRunRequest(market, { portfolioId: book.id });
      const base = r.scenarios.find((s) => s.rateSpec.kind === "base")!;
      // The path the shard worker builds for the base scenario, rebuilt with the same pure functions.
      const path = buildRatePath(shockedCurve(buildBaseCurve(market), base.rateSpec), H);
      const groups = [{ positions: book.positions, scenarios: [{ scenarioId: base.id, rateSpec: base.rateSpec, path }] }];
      const five = ["balance", "principal", "interest", "repricing", "gapPrincipal"] as const;
      const dump = (s: Record<string, Float64Array[] | undefined>, keys: readonly string[]) =>
        JSON.stringify(keys.map((k) => s[k]!.map((a) => Array.from(a))));
      const off1 = runStaticPass(groups, plan, H, 1, market).get(base.id)!;
      const on1 = runStaticPass(groups, plan, H, 1, market, undefined, undefined, undefined, "principal-plus-interest").get(base.id)!;
      const off4 = runStaticPass(groups, plan, H, 4, market).get(base.id)!;
      const on4 = runStaticPass(groups, plan, H, 4, market, undefined, undefined, undefined, "principal-plus-interest").get(base.id)!;
      expect(has(off1, "gapInterest")).toBe(false);
      expect(has(off4, "gapInterest")).toBe(false);
      expect(CHUNK_METRICS_WITH_INTEREST).toBe(CHUNK_METRICS + 1);
      const ref = dump(off1 as never, five);
      for (const s of [on1, off4, on4]) expect(dump(s as never, five)).toBe(ref);
      expect(dump(on4 as never, ["gapInterest"])).toBe(dump(on1 as never, ["gapInterest"]));
      // Amendment A1: on this book (fixed loans, both deposit kinds, swaps; no CD, no commitment) every interest is
      // paid in the month it accrues, so the carrier is the static interest metric bit for bit.
      expect(dump(on1 as never, ["gapInterest"])).toBe(dump(on1 as never, ["interest"]));
    },
    300_000,
  );

  it(
    "the whole envelope is byte-equal on 4 shards and on 1, with the switch ON and with it OFF",
    () => {
      const book = bigBook("PF-LI-SHARD");
      const opts: Opts = { liquidityBuckets: { kind: "custom", edgesMonths: [2, 7, 30, 90] } };
      const off1 = runBook(book, opts);
      const off4 = runBook(book, { ...opts, shards: 4 });
      const on1 = runBook(book, { ...opts, liquidityFlows: "principal-plus-interest" });
      const on4 = runBook(book, { ...opts, liquidityFlows: "principal-plus-interest", shards: 4 });
      expect(JSON.stringify(off4)).toBe(JSON.stringify(off1));
      expect(JSON.stringify(on4)).toBe(JSON.stringify(on1));
      expect(on1.gap.liquidity.every((l) => l.withInterest?.userBuckets !== undefined)).toBe(true);
      expect(stripInterest(on1)).toBe(JSON.stringify(off1));
      // Amendment A2 item 2 on the custom buckets of the same runs.
      for (const r of [on1, on4]) for (const l of r.gap.liquidity) expectLadderIdentity(l);
    },
    600_000,
  );
});

// ---------------------------------------------------------------------------
// Amendment A2 item 2: principal plus interest equals the combined rows
// ---------------------------------------------------------------------------

/**
 * Per band, the principal row plus the interest row equals the combined (principal plus interest) row, for assets,
 * liabilities, net (gap) and the running net, within float tolerance. The interest rows are built from the interest
 * carrier directly and the combined rows from principal plus interest month by month, so the two sides are summed in
 * different orders; the tolerance is 1e-12 of the largest figure on the ladder.
 */
function expectRowsIdentity(principal: readonly GapBucketRow[], interest: readonly GapBucketRow[], combined: readonly GapBucketRow[], where: string): void {
  expect(principal.map((r) => r.band), `${where} principal bands`).toEqual(combined.map((r) => r.band));
  expect(interest.map((r) => r.band), `${where} interest bands`).toEqual(combined.map((r) => r.band));
  const fields = ["assets", "liabilities", "gap", "cumulativeGap"] as const;
  let scale = 1;
  for (const rows of [principal, interest, combined]) for (const r of rows) for (const f of fields) scale = Math.max(scale, Math.abs(r[f]));
  let interestSeen = false;
  combined.forEach((c, b) => {
    const p = principal[b]!;
    const i = interest[b]!;
    if (i.assets !== 0 || i.liabilities !== 0) interestSeen = true;
    for (const f of fields) {
      expect(Math.abs(p[f] + i[f] - c[f]) <= 1e-12 * scale, `${where} band ${c.band.label} ${f}: ${p[f]} + ${i[f]} vs ${c[f]}`).toBe(true);
    }
    // Each view's net is its own assets less liabilities.
    expect(i.gap).toBe(i.assets - i.liabilities);
  });
  expect(interestSeen, `${where}: the interest rows carry money`).toBe(true);
}

/** The identity on one liquidity ladder: the nine bands, and the run's own buckets when stored. */
function expectLadderIdentity(l: GapLadder): void {
  const w = l.withInterest!;
  expectRowsIdentity(l.rows, w.interest.rows, w.rows, `${l.scenarioId} nine bands`);
  expect(w.interest.userBuckets !== undefined, `${l.scenarioId} interest userBuckets present with the principal ones`).toBe(l.userBuckets !== undefined);
  if (l.userBuckets !== undefined) {
    expect(w.interest.userBuckets!.kind).toBe(l.userBuckets.kind);
    expect(w.interest.userBuckets!.edgesMonths).toEqual(l.userBuckets.edgesMonths);
    expectRowsIdentity(l.userBuckets.rows, w.interest.userBuckets!.rows, w.userBuckets!.rows, `${l.scenarioId} ${l.userBuckets.kind} buckets`);
  }
}

describe("identity: principal plus interest equals the combined rows (Amendment A2 item 2)", () => {
  it(
    "on the shard book with monthly liquidity buckets, inline and on 4 shards, every scenario, nine bands and months",
    () => {
      const book = bigBook("PF-LI-ID");
      const opts: Opts = { liquidityBuckets: { kind: "monthly" }, liquidityFlows: "principal-plus-interest" };
      const on1 = runBook(book, opts);
      const on4 = runBook(book, { ...opts, shards: 4 });
      expect(JSON.stringify(on4)).toBe(JSON.stringify(on1));
      expect(on1.gap.liquidity.length).toBeGreaterThan(1);
      for (const r of [on1, on4]) {
        for (const l of r.gap.liquidity) {
          expect(l.userBuckets!.rows).toHaveLength(H);
          expectLadderIdentity(l);
        }
      }
    },
    600_000,
  );
});

describe("user buckets on the interest basis (pipeline)", () => {
  it("monthly withInterest user rows re-band to the withInterest nine-band rows (one root per column, bit for bit)", () => {
    const r = runBook(twoSidedBook("PF-LI-UB"), { liquidityFlows: "principal-plus-interest", liquidityBuckets: { kind: "monthly" } });
    const bands = buildBands(H);
    for (const l of r.gap.liquidity) {
      const wi = l.withInterest!;
      const re = bands.map(() => ({ assets: 0, liabilities: 0 }));
      for (const u of wi.userBuckets!.rows) {
        const b = bands.findIndex((x) => u.band.startMonth >= x.startMonth && u.band.startMonth < x.endMonth);
        re[b]!.assets += u.assets;
        re[b]!.liabilities += u.liabilities;
      }
      wi.rows.forEach((row, b) => {
        expect(re[b]!.assets).toBe(row.assets);
        expect(re[b]!.liabilities).toBe(row.liabilities);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Reconciliation to NII (spec Amendment A1 item 4)
// ---------------------------------------------------------------------------

/** A CD family and a commitment family beside the hedged book's. Each family's COA leaf is a root of its side. */
function reconCoa(base: ChartOfAccounts): ChartOfAccounts {
  return {
    ...base,
    nodes: [
      ...base.nodes,
      { id: "cds", label: "CDs", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "CDS", order: 2 },
      { id: "commitments", label: "Undrawn lines", parentId: null, side: "asset", isLeaf: true, familyId: "COMMIT", order: 2 },
    ],
    families: [
      ...base.families,
      { id: "CDS", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "cds" },
      { id: "COMMIT", label: "Undrawn lines", side: "asset", instrumentType: "commitment", coaNodeId: "commitments" },
    ],
  } as unknown as ChartOfAccounts;
}

/**
 * The hedged two-sided book (fixed loans, mortgages, DDA, MMA, a pay-fixed swap), an interest-bearing DDA, an
 * excluded fixed loan, a CD
 * cohort book under the calibrated early-withdrawal hazard, and a commitment that draws. No equity family holds a
 * position: the pipeline refuses one (equity is a derived plug, computeFtpResult); its drop at banding is pinned in
 * Part 1.
 */
function reconBook(id: string): PortfolioSpec {
  const base = hedgedBook(id, [swapPosition("SW1", SWAP_FAMILY_ID, { maturityMonths: 60, fixedRate: 0.03 })]);
  const cohorts: CdCohortSpec[] = [
    { termMonths: 6, monthsToMaturity: 4, balance: 30, contractRate: 0.031 },
    { termMonths: 12, monthsToMaturity: 9, balance: 40, contractRate: 0.035 },
    { termMonths: 24, monthsToMaturity: 20, balance: 30, contractRate: 0.042 },
  ];
  return {
    ...base,
    coa: reconCoa(base.coa),
    positions: [
      ...base.positions,
      // An interest-bearing DDA beside the fixture's non-interest-bearing one, so the deposit term is real money.
      nmdPosition("D2", { notional: 1_500_000, depositRate: 0.015 }),
      // An excluded non-deposit position: its interest stays in the ladder (ruling 8).
      { ...fixedPosition("FX1", { notional: 900_000, coupon: 0.045, maturityMonths: 24 }), repricingTreatment: "excluded" as const },
      {
        id: "CD1",
        familyId: "CDS",
        coaNodeId: "cds",
        terms: { id: "CD1", type: "cd", notional: 4_000_000, maturityMonths: cdMaturityMonths(cohorts), originationOffsetMonths: 0, amortType: "bullet", side: "liability", cohorts },
      } as unknown as Position,
      {
        id: "LN1",
        familyId: "COMMIT",
        coaNodeId: "commitments",
        terms: { id: "LN1", type: "commitment", notional: 5_000_000, maturityMonths: 36, originationOffsetMonths: 0, amortType: "bullet", side: "asset", draw: { rampRates: [0.35, 0.15], steadyRate: 0.02 } },
      } as unknown as Position,
    ],
  };
}

/**
 * The families, hand-listed by id: the column each bands into and when its interest is paid. Nothing here is
 * classified by the code under test.
 *   monthly        interest is paid in the month it accrues (loans, mortgages, deposits credited monthly, swap net
 *                  settlement);
 *   with-principal a CD pays its accrued interest when the principal it accrued on leaves;
 *   none           a commitment carries no interest on either ladder.
 */
const RECON_FAMILIES: ReadonlyArray<{ id: string; column: "assets" | "liabilities"; paid: "monthly" | "with-principal" | "none" }> = [
  { id: "FIXED", column: "assets", paid: "monthly" },
  { id: "MORTGAGE", column: "assets", paid: "monthly" },
  { id: "DDA", column: "liabilities", paid: "monthly" },
  { id: "MMA", column: "liabilities", paid: "monthly" },
  { id: SWAP_FAMILY_ID, column: "assets", paid: "monthly" },
  { id: "CDS", column: "liabilities", paid: "with-principal" },
  { id: "COMMIT", column: "assets", paid: "none" },
];

/** Accrued interest by month bucket from the generators: the NII basis. */
function accrualByMonth(positions: readonly Position[], path: RatePath): Float64Array {
  const out = new Float64Array(H);
  for (const p of positions) {
    for (const cf of makeInstrument(p.terms).generateCashflows(path)) {
      const k = cf.monthOffset - 1;
      if (k >= 0 && k < H) out[k] += cf.interestPaid;
    }
  }
  return out;
}

/** CD interest by payment month from the generators: the accrued pool paid pro rata as principal leaves (A1 item 3). */
function paidWithPrincipalByMonth(positions: readonly Position[], path: RatePath): Float64Array {
  const out = new Float64Array(H);
  for (const p of positions) {
    const stream = makeInstrument(p.terms).generateCashflows(path);
    let pool = 0;
    stream.forEach((cf, i) => {
      pool += cf.interestPaid;
      const share = i === stream.length - 1 || cf.principalPaid >= cf.balance ? 1 : cf.principalPaid / cf.balance;
      const paid = pool * share;
      pool -= paid;
      const k = cf.monthOffset - 1;
      if (k >= 0 && k < H) out[k] += paid;
    });
  }
  return out;
}

/** Band a monthly series on a ladder's own band edges (endMonth exclusive). */
const bandSums = (rows: readonly GapBucketRow[], monthly: Float64Array): number[] =>
  rows.map((r) => monthly.slice(r.band.startMonth, r.band.endMonth).reduce((a, v) => a + v, 0));

/** The ladder's interest by band in one column, read from the interest rows themselves (Amendment A2). */
const ladderInterestByBand = (l: GapLadder, column: "assets" | "liabilities"): number[] =>
  l.withInterest!.interest.rows.map((r) => r[column]);

const sum = (xs: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
};

/** a equals b to 1e-9 of the band's scale (Amendment A2: the interest rows are read directly, so the scale is the interest's own). */
const nearBand = (a: number, b: number, scale: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(scale), Math.abs(b));

describe("reconciliation to the NII stage (spec Amendment A1 item 4)", () => {
  it("per family, on the static base scenario: ladder interest equals NII interest; for the CD the total is equal and only the timing differs", () => {
    const book = reconBook("PF-LI-REC");
    const scenarioId = "S0";
    const request = makeRunRequest(market, { portfolioId: book.id });
    const scenario = request.scenarios.find((s) => s.id === scenarioId)!;
    // A static run-off scenario: no new business, so the NII stage's interest is the existing book's alone.
    expect(scenario.newBusiness.mode).toBe("static");
    expect(scenario.rateSpec.kind).toBe("base");
    const path = buildRatePath(shockedCurve(buildBaseCurve(market), scenario.rateSpec), H);
    // Every hand-listed family holds a position, and every family of the book is hand-listed.
    expect(new Set(book.positions.map((p) => p.familyId))).toEqual(new Set(RECON_FAMILIES.map((f) => f.id)));

    const full = runBook(book, { liquidityFlows: "principal-plus-interest" });
    const nii = full.cashflows.byScenario.find((s) => s.scenarioId === scenarioId)!;
    const fullLadder = full.gap.liquidity.find((l) => l.scenarioId === scenarioId)!;
    const wantFull = { assets: fullLadder.rows.map(() => 0), liabilities: fullLadder.rows.map(() => 0) };
    let signedNii = 0;
    let cdTimingMoved = false;

    for (const fam of RECON_FAMILIES) {
      const positions = book.positions.filter((p) => p.familyId === fam.id);
      // Term 1, from the generators over the scenario path: what accrues, and what is paid when.
      const accrued = accrualByMonth(positions, path);
      const paid = fam.paid === "monthly" ? accrued : fam.paid === "with-principal" ? paidWithPrincipalByMonth(positions, path) : new Float64Array(H);
      // Term 2, the NII stage: the family's interest series on the same run.
      const niiSeries = nii.byFamily.find((f) => f.familyId === fam.id)?.series.interest ?? [];
      // Term 3, the ladder: the same run on the family's positions alone, read in the family's column.
      const only: PortfolioSpec = { ...book, id: `${book.id}-${fam.id}`, positions };
      const ladder = runBook(only, { liquidityFlows: "principal-plus-interest" }).gap.liquidity.find((l) => l.scenarioId === scenarioId)!;
      const got = ladderInterestByBand(ladder, fam.column);
      const other = ladderInterestByBand(ladder, fam.column === "assets" ? "liabilities" : "assets");
      const want = bandSums(ladder.rows, paid);
      got.forEach((g, b) => expect(nearBand(g, want[b]!, g), `${fam.id} band ${b}: ${g} vs ${want[b]}`).toBe(true));
      other.forEach((g) => expect(g, `${fam.id} other column`).toBe(0));

      // The NII stage carries what accrues; the ladder total equals it for every family but the commitment.
      expect(relClose(sum(niiSeries), sum(accrued)), `${fam.id} NII vs generators`).toBe(true);
      if (fam.paid !== "none") {
        expect(relClose(sum(got), sum(niiSeries)), `${fam.id}: ladder ${sum(got)} vs NII ${sum(niiSeries)}`).toBe(true);
        expect(Math.abs(sum(got)), fam.id).toBeGreaterThan(0);
      } else {
        expect(sum(niiSeries), `${fam.id} NII`).toBe(0);
      }
      // Timing: the CD ladder differs from its accrual by band; every other family's ladder is its accrual by band.
      const niiBands = bandSums(ladder.rows, Float64Array.from(niiSeries));
      if (fam.paid === "with-principal") cdTimingMoved = got.some((g, b) => Math.abs(g - niiBands[b]!) > 1);
      else if (fam.paid === "monthly") got.forEach((g, b) => expect(nearBand(g, niiBands[b]!, g), `${fam.id} band ${b} vs NII`).toBe(true));

      bandSums(fullLadder.rows, paid).forEach((v, b) => (wantFull[fam.column][b] += v));
      signedNii += (fam.column === "liabilities" ? -1 : 1) * sum(niiSeries);
    }
    expect(cdTimingMoved).toBe(true);

    // The whole book, band by band and in total: ladder interest is the sum of the families' paid interest by
    // column, and its signed total ties to the signed NII interest of the whole book.
    for (const column of ["assets", "liabilities"] as const) {
      ladderInterestByBand(fullLadder, column).forEach((g, b) =>
        expect(nearBand(g, wantFull[column][b]!, g), `full ${column} band ${b}`).toBe(true),
      );
    }
    const signedLadder = sum(ladderInterestByBand(fullLadder, "assets")) - sum(ladderInterestByBand(fullLadder, "liabilities"));
    expect(relClose(signedLadder, signedNii), `${signedLadder} vs ${signedNii}`).toBe(true);
  }, 300_000);
});
