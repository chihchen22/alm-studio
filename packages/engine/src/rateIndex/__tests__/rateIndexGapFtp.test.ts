/**
 * Rate indices through the gap engine and the FTP block (sub-part S2b). Hand book: one bullet floater F (N 1e6, 12 months, margin
 * 0.0125, monthly reset) in family "floaters". Book A names no index; book B
 * names "prime-demo" (tenor 1, basis 0.03); book C names "rfr-3m" (tenor 3,
 * basis 0). The market is the public pack with the three seeded indices derived
 * onto it.
 *
 * Expected values are restated here, not read back from the code under test:
 *   - the repricing and liquidity ladders do not move, because the ladder keys
 *     on the repricing schedule and the principal stream, neither of which an
 *     index touches;
 *   - FTP: the kernel par-matches principal and balance only, so the IR, LP and
 *     all-in rates are unchanged, and the family coupon (assetRate) and margin
 *     move by exactly the basis for a tenor-1 index, since every month's coupon
 *     is the base reset plus 0.03 plus the margin.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, DEFAULT_TLP_CURVE, type MarketSnapshot } from "@alm/kernel";
import type { MarketWithIndices } from "../../contracts/rateIndex";
import type { PortfolioSpec, Position, PositionTerms } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { computeFtpResult } from "../../ftp/computeFtp";
import { buildGapResult, buildScenarioGap } from "../../gap";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { buildBaseCurve } from "../../scenario";
import { buildScenarioRatePath } from "../../projection/static";
import { AS_OF, loadMarket } from "../../run/__tests__/fixtures";
import { RateIndexUnresolvedError } from "../resolve";
import { rateIndexTable } from "../rateIndices";

const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];
const HORIZON = 24;

let plain: MarketSnapshot;
let indexed: MarketSnapshot;
beforeAll(async () => {
  plain = await loadMarket();
  indexed = deriveMarketSnapshot(structuredClone(plain), SEED_OPS, { baseId: "market-public-2026-03-31" }).snapshot;
});

function floaterPosition(rateIndexId?: string): Position {
  const terms = {
    id: "F",
    type: "floating-loan",
    notional: 1_000_000,
    maturityMonths: 12,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    indexTenorMonths: 1,
    margin: 0.0125,
    resetFrequencyMonths: 1,
    ...(rateIndexId !== undefined ? { rateIndexId } : {}),
  } as unknown as PositionTerms;
  return { id: "F", familyId: "floaters", coaNodeId: "floaters", terms };
}

function handBook(id: string, rateIndexId?: string): PortfolioSpec {
  return {
    id,
    label: "hand book",
    asOf: AS_OF,
    coa: {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "floaters", label: "Floaters", parentId: "assets", side: "asset", isLeaf: true, familyId: "floaters", order: 0 },
      ],
      families: [{ id: "floaters", label: "Floaters", side: "asset", instrumentType: "floating-loan", coaNodeId: "floaters" }],
    },
    positions: [floaterPosition(rateIndexId)],
  };
}

const S0: Scenario = {
  id: "S0",
  label: "S0",
  rateSpec: { kind: "base" },
  assumptionSetId: "AS-BASE",
  newBusiness: { mode: "static", rules: [] },
};

function pathOn(market: MarketSnapshot) {
  return buildScenarioRatePath(buildBaseCurve(market), S0, HORIZON);
}

describe("gap engine reads the table (S2b)", () => {
  it("leaves both ladders exactly as the unindexed book's, for a one-month and a three-month index", () => {
    const table = rateIndexTable((indexed as MarketWithIndices).rateIndices);
    const sp = { scenarioId: "S0", path: pathOn(indexed) };
    const a = buildScenarioGap(handBook("PF-A"), sp, HORIZON);
    for (const idx of ["prime-demo", "rfr-3m"]) {
      const b = buildScenarioGap(handBook(`PF-${idx}`, idx), sp, HORIZON, table);
      expect(b.repricing).toEqual(a.repricing);
      expect(b.liquidity).toEqual(a.liquidity);
    }
    // Non-vacuous: the book is a 1e6 bullet, so the liquidity ladder carries it all in bucket 12.
    const total = a.liquidity.rows.reduce((s, r) => s + r.assets, 0);
    expect(total).toBeCloseTo(1_000_000, 6);
  });

  it("buildGapResult forwards the table to every scenario", () => {
    const table = rateIndexTable((indexed as MarketWithIndices).rateIndices);
    const sps = [
      { scenarioId: "S0", path: pathOn(indexed) },
      { scenarioId: "S0b", path: pathOn(indexed) },
    ];
    const book = handBook("PF-B", "prime-demo");
    const withTable = buildGapResult(book, sps, HORIZON, table);
    expect(withTable.repricing.map((l) => l.scenarioId)).toEqual(["S0", "S0b"]);
    expect(() => buildGapResult(book, sps, HORIZON)).toThrow(RateIndexUnresolvedError);
  });

  it("refuses an indexed floater when no table is passed, and when the table lacks the id", () => {
    const sp = { scenarioId: "S0", path: pathOn(indexed) };
    const book = handBook("PF-B", "prime-demo");
    expect(() => buildScenarioGap(book, sp, HORIZON)).toThrow(RateIndexUnresolvedError);
    expect(() => buildScenarioGap(book, sp, HORIZON, rateIndexTable([]))).toThrow(
      /names rate index "prime-demo", which this call was not given/,
    );
  });
});

describe("FTP block reads the table (S2b)", () => {
  function ftpOn(book: PortfolioSpec, table?: ReturnType<typeof rateIndexTable>) {
    const curve = buildBaseCurve(indexed);
    const tlp = indexed.tlpNodes.length > 0 ? buildTLPCurve(indexed.tlpNodes) : DEFAULT_TLP_CURVE;
    return computeFtpResult({
      portfolio: book,
      scenarios: [S0],
      baseScenarioId: "S0",
      curve,
      tlp,
      path: pathOn(indexed),
      horizonMonths: HORIZON,
      niiBase: { scenarioId: "S0", totalNet12: 0 },
      rateIndices: table,
    });
  }

  it("moves the family coupon and margin by exactly the basis, and nothing else, for a tenor-1 index", () => {
    const table = rateIndexTable((indexed as MarketWithIndices).rateIndices);
    const a = ftpOn(handBook("PF-A")).byFamily.find((f) => f.familyId === "floaters")!;
    const b = ftpOn(handBook("PF-B", "prime-demo"), table).byFamily.find((f) => f.familyId === "floaters")!;
    expect(b.couponRate! - a.couponRate!).toBeCloseTo(0.03, 12);
    expect(b.ftpMarginRate! - a.ftpMarginRate!).toBeCloseTo(0.03, 12);
    expect(b.irFtpRate).toBe(a.irFtpRate);
    expect(b.lpFtpRate).toBe(a.lpFtpRate);
    expect(b.allInFtpRate).toBe(a.allInFtpRate);
    expect(b.positionCount).toBe(a.positionCount);
    expect(b.notional).toBe(a.notional);
  });

  it("a three-month index changes the coupon but not the par-matched funding rates", () => {
    const table = rateIndexTable((indexed as MarketWithIndices).rateIndices);
    const a = ftpOn(handBook("PF-A")).byFamily.find((f) => f.familyId === "floaters")!;
    const c = ftpOn(handBook("PF-C", "rfr-3m"), table).byFamily.find((f) => f.familyId === "floaters")!;
    expect(c.couponRate).not.toBe(a.couponRate);
    expect(c.irFtpRate).toBe(a.irFtpRate);
    expect(c.allInFtpRate).toBe(a.allInFtpRate);
  });

  it("refuses an indexed floater when no table is passed", () => {
    expect(() => ftpOn(handBook("PF-B", "prime-demo"))).toThrow(RateIndexUnresolvedError);
  });

  it("an unindexed book is unchanged by the optional table", () => {
    const table = rateIndexTable((indexed as MarketWithIndices).rateIndices);
    expect(ftpOn(handBook("PF-A"), table)).toEqual(ftpOn(handBook("PF-A")));
  });
});
