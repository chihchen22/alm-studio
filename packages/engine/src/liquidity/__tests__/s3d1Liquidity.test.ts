/**
 * The term-deposit role, the buffer read from the HQLA tags, the dials' severe draw rate
 * and the survival path, on a synthetic mini book with round illustrative numbers. Every expected value is restated
 * by hand in the test (the arithmetic is in the comment beside it), never read from the module under test.
 */
import { describe, expect, it } from "vitest";
import { FIXED_LOAN_DEFAULTS, NMD_B_TERMS_DEFAULTS, NMD_TERMS_DEFAULTS } from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { LiquidityStressTable, SurvivalPathLegs } from "../../contracts/results";
import {
  computeLiquidityStress,
  deriveLiquidityBuffer,
  liquidityStressConfigError,
  liquidityStressOptionsOf,
} from "../stressLadder";
import { computeSurvivalPath } from "../survivalPath";

const M = 1_000_000;
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

const TABLE: LiquidityStressTable = {
  bau: { hysOutflowMonthly: 0.01, wholesaleRenewal: 1, nibOutflowMonthly: 0.005, drawRate: 0 },
  moderate: { hysOutflowMonthly: 0.05, wholesaleRenewal: 0.5, nibOutflowMonthly: 0.01, drawRate: 0.1 },
  severe: { hysOutflowMonthly: 0.1, wholesaleRenewal: 0, nibOutflowMonthly: 0.02, drawRate: 0.24 },
};
const WITH_CD: LiquidityStressTable = {
  bau: { ...TABLE.bau, cdRenewal: 0.9 },
  moderate: { ...TABLE.moderate, cdRenewal: 0.6 },
  severe: { ...TABLE.severe, cdRenewal: 0.25 },
};

function coa(): ChartOfAccounts {
  const leaf = (id: string, side: "asset" | "liability", order: number) => ({ id, label: id, parentId: side === "asset" ? "a" : "l", side, isLeaf: true, familyId: id.toUpperCase(), order });
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "a", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      leaf("loans", "asset", 0), leaf("cash", "asset", 1), leaf("ust", "asset", 2), leaf("agency", "asset", 3), leaf("corp", "asset", 4), leaf("other", "asset", 5),
      { id: "l", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      leaf("hys", "liability", 0), leaf("nib", "liability", 1), leaf("cds", "liability", 2),
    ],
    families: [
      ...["loans", "cash", "ust", "agency", "corp", "other"].map((id) => ({ id: id.toUpperCase(), label: id, side: "asset" as const, instrumentType: "fixed-loan" as const, coaNodeId: id })),
      { id: "HYS", label: "hys", side: "liability" as const, instrumentType: "nmd-b" as const, coaNodeId: "hys" },
      { id: "NIB", label: "nib", side: "liability" as const, instrumentType: "nmd" as const, coaNodeId: "nib" },
      { id: "CDS", label: "cds", side: "liability" as const, instrumentType: "fixed-loan" as const, coaNodeId: "cds" },
    ],
  };
}

function pos(id: string, family: string, notional: number, dims: Record<string, string>): Position {
  return { id, familyId: family.toUpperCase(), coaNodeId: family, terms: { ...FIXED_LOAN_DEFAULTS, id, notional, maturityMonths: 24, amortType: "bullet" }, dimensions: dims };
}

/** HYS 1,000M, NIB 500M, one inflow loan, a term-deposit book, and five hqla-stock positions (one untagged, one mistagged). */
function book(): PortfolioSpec {
  return {
    id: "PF-S3D1", label: "S3d-1 synthetic", asOf: "2026-03-31", coa: coa(),
    positions: [
      pos("loan", "loans", 1_000 * M, { liquidityRole: "inflow-asset" }),
      pos("cash", "cash", 100 * M, { liquidityRole: "hqla-stock", "hqla-level": "l1" }),
      pos("ust", "ust", 200 * M, { liquidityRole: "hqla-stock", "hqla-level": "l1" }),
      pos("agency", "agency", 200 * M, { liquidityRole: "hqla-stock", "hqla-level": "l2a" }),
      pos("corp", "corp", 40 * M, { liquidityRole: "hqla-stock", "hqla-level": "l2b" }),
      pos("untagged", "other", 50 * M, { liquidityRole: "hqla-stock" }),
      pos("mistagged", "other", 30 * M, { liquidityRole: "hqla-stock", "hqla-level": "level-1" }),
      { id: "hys", familyId: "HYS", coaNodeId: "hys", terms: { ...NMD_B_TERMS_DEFAULTS, id: "hys", notional: 1_000 * M }, dimensions: { liquidityRole: "hys-pool" } },
      { id: "nib", familyId: "NIB", coaNodeId: "nib", terms: { ...NMD_TERMS_DEFAULTS, id: "nib", notional: 500 * M }, dimensions: { liquidityRole: "nib-pool" } },
      pos("cds", "cds", 300 * M, { liquidityRole: "term-deposit" }),
    ],
  };
}

/** The loan returns 10M a month; the CDs pay 100M in month 2 and 200M in month 5. */
function principal(): Map<string, number[]> {
  const cd = new Array<number>(12).fill(0);
  cd[1] = 100 * M;
  cd[4] = 200 * M;
  return new Map([["loan", new Array<number>(12).fill(10 * M)], ["cds", cd]]);
}

const ladder = (extra: Partial<Parameters<typeof computeLiquidityStress>[0]> = {}) =>
  computeLiquidityStress({ book: book(), principalByPosition: principal(), table: TABLE, buffer: 400 * M, undrawnFace: 120 * M, horizonMonths: 12, ...extra });

describe("the term-deposit role", () => {
  it("a row that states cdRenewal pays out the CDs at one less the renewal share; month 5 on severe is 200M x 0.75", () => {
    const r = ladder({ table: WITH_CD });
    const severe = r.scenarios.find((s) => s.id === "severe")!;
    expect(r.cdMaturities![1]).toBe(100 * M);
    expect(r.cdMaturities![4]).toBe(200 * M);
    near(severe.cdOut![1]!, 75 * M); // 100M x (1 - 0.25)
    near(severe.cdOut![4]!, 150 * M); // 200M x (1 - 0.25)
    near(r.scenarios[0]!.cdOut![4]!, 20 * M); // bau: 200M x (1 - 0.9)
    // Month 1 on severe: inflow 10, HYS 1000 x 0.10 = 100, NIB 500 x 0.02 = 10, no wholesale, no CD, draws 120 x 0.24 / 12 = 2.4.
    near(severe.net[0]!, (10 - 100 - 10 - 0 - 0 - 2.4) * M);
    // Month 2: HYS 900 x 0.10 = 90, NIB 490 x 0.02 = 9.8, CD 75.
    near(severe.net[1]!, (10 - 90 - 9.8 - 75 - 2.4) * M);
  });

  it("a table with no cdRenewal reads no term deposit: the result carries no CD key and equals the ladder with the role removed", () => {
    const withRole = ladder();
    const noRole: PortfolioSpec = { ...book(), positions: book().positions.map((p) => (p.id === "cds" ? { ...p, dimensions: {} } : p)) };
    const without = computeLiquidityStress({ book: noRole, principalByPosition: principal(), table: TABLE, buffer: 400 * M, undrawnFace: 120 * M, horizonMonths: 12 });
    expect(JSON.stringify(withRole)).toBe(JSON.stringify(without));
    expect("cdMaturities" in withRole).toBe(false);
    expect(withRole.scenarios.every((s) => !("cdOut" in s))).toBe(true);
  });
});

describe("S3d fix round: renewal rolls maturities only; early withdrawals leave in full; mixed rows", () => {
  it("severe month 2 is 100M maturing x 0.75 plus 6M withdrawn early in full; a row without cdRenewal carries no CD key", () => {
    const early = new Map([["cds", Array.from({ length: 12 }, (_, i) => (i === 1 ? 6 * M : 0))]]);
    const mixed: LiquidityStressTable = { bau: TABLE.bau, moderate: { ...TABLE.moderate, cdRenewal: 0.5 }, severe: { ...TABLE.severe, cdRenewal: 0.25 } };
    const r = ladder({ table: mixed, earlyByPosition: early });
    expect(r.cdEarlyWithdrawals![1]).toBe(6 * M);
    near(r.scenarios[2]!.cdOut![1]!, 100 * M * 0.75 + 6 * M); // 81M
    near(r.scenarios[1]!.cdOut![1]!, 100 * M * 0.5 + 6 * M); // 56M
    expect("cdOut" in r.scenarios[0]!).toBe(false);
    // bau states no renewal, so it reads no CD at all: its net equals the same row on a book with no term deposits.
    const noCd = computeLiquidityStress({ book: { ...book(), positions: book().positions.filter((p) => p.id !== "cds") }, principalByPosition: principal(), table: mixed, buffer: 400 * M, undrawnFace: 120 * M, horizonMonths: 12 });
    expect(r.scenarios[0]!.net).toEqual(noCd.scenarios[0]!.net);
  });
});

describe("the buffer read from the HQLA tags", () => {
  it("counts face x (1 - haircut) per level, lists the untagged and the unknown level, and is the ladder's buffer when none is stated", () => {
    const d = deriveLiquidityBuffer(book());
    // 100 + 200 at level 1 (no haircut), 200 x 0.85 = 170 at 2A, 40 x 0.5 = 20 at 2B: 490.
    near(d.total, 490 * M);
    near(d.byLevel.l1, 300 * M);
    near(d.byLevel.l2a, 170 * M);
    near(d.byLevel.l2b, 20 * M);
    expect(d.positions.map((p) => [p.positionId, p.level, p.haircut])).toEqual([["cash", "l1", 0], ["ust", "l1", 0], ["agency", "l2a", 0.15], ["corp", "l2b", 0.5]]);
    expect(d.notCounted.map((x) => [x.positionId, x.reason])).toEqual([["untagged", "no hqla-level tag"], ["mistagged", 'hqla-level "level-1" is not l1, l2a or l2b']]);
    const { buffer: _b, ...noBuffer } = { buffer: 0 };
    void _b;
    const r = ladder({ ...noBuffer, buffer: undefined });
    near(r.buffer, 490 * M);
    expect(r.bufferDerivation?.total).toBe(r.buffer);
  });

  it("a stated buffer overrides the tags and writes no derivation", () => {
    const r = ladder();
    expect(r.buffer).toBe(400 * M);
    expect("bufferDerivation" in r).toBe(false);
  });
});

describe("the dials set the severe draw (S3d fix round: the undrawn face is the amount undrawn now)", () => {
  const dials = { expectedUtilization: 0.1, tailUtilization: 0.3, fundingSpreadBp: 50, lcrFactor: 0.1, thirtyDayShare: 1 / 12 };
  it("undrawn 120M with Ubar 10 percent is a 133.33M face; severe draws the requirement 0.2 x 133.33M = 26.67M over 12 months; bau and moderate keep the table's rate", () => {
    const r = ladder({ dials });
    const severe = r.scenarios.find((s) => s.id === "severe")!;
    // Rate on the undrawn face: (0.3 - 0.1) / (1 - 0.1) = 0.2222...; a month: 120M x 0.2222 / 12 = 2.2222M.
    near(severe.params.drawRate, 0.2 / 0.9, 1e-12);
    near(severe.draws[0]!, (0.2 * (120 / 0.9) * M) / 12, 1e-6);
    near(severe.draws.reduce((a, b) => a + b, 0), 0.2 * (120 / 0.9) * M, 1e-5);
    expect(r.scenarios[1]!.params.drawRate).toBe(0.1);
    expect(r.commitmentDials!.statedSevereDrawRate).toBe(0.24);
    // The dials as the ladder read them: undrawn 120M, no face of their own; the result's face 120M / 0.9.
    expect(r.commitmentDials!.dials).toEqual({ undrawn: 120 * M, ...dials });
    near(r.commitmentDials!.result.face, (120 / 0.9) * M, 1e-6);
    near(r.commitmentDials!.result.expectedDrawn, ((0.1 * 120) / 0.9) * M, 1e-6);
    near(r.commitmentDials!.result.bufferRequirement, (0.2 * 120 / 0.9) * M, 1e-6);
    // The LCR reference reads the amount undrawn now: 0.1 x 120M = 12M.
    near(r.commitmentDials!.result.lcrReferenceOutflow, 12 * M, 1e-6);
    // The contingent charge in bp is unchanged by the reading (the face cancels): 0.2 / 0.9 x 50 = 11.111 bp; a year on 120M.
    near(r.commitmentDials!.result.contingentChargeBp, (0.2 / 0.9) * 50, 1e-12);
    near(r.commitmentDials!.result.contingentChargeAnnual, ((0.2 / 0.9) * 50 / 1e4) * 120 * M, 1e-6);
  });
  it("without dials the result carries no dials key", () => {
    expect("commitmentDials" in ladder()).toBe(false);
  });
});

describe("the opt-in's shape", () => {
  const ok = { table: TABLE, buffer: 1, undrawnFace: 1 };
  it("accepts a missing buffer, a cdRenewal, dials and a survival path; names each bad field", () => {
    expect(liquidityStressConfigError({ table: TABLE, undrawnFace: 1 }, "x")).toBeUndefined();
    expect(liquidityStressConfigError({ ...ok, table: WITH_CD, survivalPath: { horizonMonths: 24, facility: { capacity: 5, haircut: 0.2 } } }, "x")).toBeUndefined();
    expect(liquidityStressConfigError({ ...ok, table: { ...TABLE, severe: { ...TABLE.severe, cdRenewal: 1.5 } } }, "x")).toBe("x.table.severe.cdRenewal must be a decimal in [0, 1] when given, got 1.5");
    expect(liquidityStressConfigError({ ...ok, survivalPath: { horizonMonths: 11 } }, "x")).toBe("x.survivalPath.horizonMonths must be a whole number of months from 12 to 120, got 11");
    expect(liquidityStressConfigError({ ...ok, survivalPath: { horizonMonths: 121 } }, "x")).toMatch(/from 12 to 120, got 121/);
    expect(liquidityStressConfigError({ ...ok, survivalPath: { horizonMonths: 24, facility: { capacity: 5, haircut: 2 } } }, "x")).toBe("x.survivalPath.facility.haircut must be a decimal in [0, 1], got 2");
    const d = { expectedUtilization: 0.1, tailUtilization: 0.3, fundingSpreadBp: 50, lcrFactor: 0.1, thirtyDayShare: 0.1 };
    expect(liquidityStressConfigError({ ...ok, dials: d }, "x")).toBeUndefined();
    expect(liquidityStressConfigError({ ...ok, dials: { ...d, face: 5 } }, "x")).toMatch(/^x\.dials read the undrawn face as the amount undrawn now/);
    expect(liquidityStressConfigError({ ...ok, undrawnFace: 0, dials: d }, "x")).toMatch(/^x\.undrawnFace must be above 0 when the dials are set/);
    expect(liquidityStressConfigError({ ...ok, dials: { ...d, tailUtilization: 0.05 } }, "x")).toMatch(/^x\.dials\.tailUtilization 0\.05 is below the expected 0\.1/);
  });
  it("stores a 1.9.0 opt-in with its keys and order, and drops any key it does not know", () => {
    const v19 = { table: TABLE, buffer: 7, undrawnFace: 3 };
    expect(JSON.stringify(liquidityStressOptionsOf(v19))).toBe(JSON.stringify(v19));
    const extra = { undrawnFace: 3, note: "x", table: { ...TABLE, bau: { ...TABLE.bau, extra: 1 } }, survivalPath: { horizonMonths: 24, junk: 1 } };
    expect(liquidityStressOptionsOf(extra)).toEqual({ table: TABLE, undrawnFace: 3, survivalPath: { horizonMonths: 24 } });
  });
});

/** Fourteen months of legs: HYS 1,000M, NIB 500M, inflows 10M a month, a 100M wholesale maturity at month 13, CDs as above. */
function legs(): SurvivalPathLegs {
  const h = 14;
  const cd = new Array<number>(h).fill(0);
  cd[1] = 100 * M;
  cd[4] = 200 * M;
  const ws = new Array<number>(h).fill(0);
  ws[12] = 100 * M;
  return { horizonMonths: h, pools: { hys: 1_000 * M, nib: 500 * M }, inflow: new Array<number>(h).fill(10 * M), inflowStress: new Array<number>(h).fill(5 * M), wholesaleMaturities: ws, cdMaturities: cd, undrawnFace: 120 * M };
}

describe("the survival path", () => {
  it("months 1..12 are the ladder's severe row, bit for bit; the draws stop after month 12", () => {
    const r = ladder({ table: WITH_CD });
    const severe = r.scenarios.find((s) => s.id === "severe")!;
    const l = legs();
    const twelve: SurvivalPathLegs = { ...l, horizonMonths: 12, inflow: new Array<number>(12).fill(10 * M), inflowStress: new Array<number>(12).fill(10 * M), wholesaleMaturities: new Array<number>(12).fill(0), cdMaturities: r.cdMaturities! };
    const p = computeSurvivalPath({ scenarioId: "severe", params: severe.params, legs: twelve, horizonMonths: 12, buffer: r.buffer });
    expect(p.rows.map((x) => x.cumulative)).toEqual(severe.cumulative);
    expect(p.ladderBuffer.survivalMonths).toBe(severe.survivalMonths);
    const long = computeSurvivalPath({ scenarioId: "severe", params: WITH_CD.severe, legs: l, horizonMonths: 14, buffer: 400 * M });
    near(long.rows[11]!.draws, 2.4 * M); // 120M x 0.24 / 12
    expect(long.rows[12]!.draws).toBe(0);
    near(long.rows[12]!.wholesaleOut, 100 * M); // renewal 0 on severe
  });

  it("reads the stress inflow line on severe, crosses the buffer where the hand ladder does, and counts the facility after its haircut", () => {
    // Severe, inflow 5M a month. Month 1: 5 - 100 - 10 - 2.4 = -107.4. Month 2: 5 - 90 - 9.8 - 75 - 2.4 = -172.2,
    // cumulative -279.6. Month 3: 5 - 81 - 9.604 - 2.4 = -88.004, cumulative -367.604. Month 4: 5 - 72.9 - 9.41192
    // - 2.4 = -79.71192, cumulative -447.31592. Against a 400M buffer: month 3 leaves 32.396, month 4 is -47.31592, so
    // the crossing is 3 + 32.396 / (32.396 + 47.31592) = 3.40642...
    const p = computeSurvivalPath({ scenarioId: "severe", params: WITH_CD.severe, legs: legs(), horizonMonths: 14, buffer: 400 * M, facility: { label: "Borrowing line", capacity: 200 * M, haircut: 0.25 } });
    near(p.rows[3]!.cumulative, -447.31592 * M, 1e-3);
    const crossing = 3 + 32.396 / (32.396 + 47.31592);
    near(p.ladderBuffer.survivalMonths!, crossing, 1e-9);
    near(p.ladderBuffer.survivalDays!, crossing * 365 / 12, 1e-7);
    expect(p.facility).toEqual({ label: "Borrowing line", capacity: 200 * M, haircut: 0.25, counted: 150 * M });
    expect(p.withFacility!.buffer).toBe(550 * M);
    // Month 5: 5 - 65.61 - 9.2236816 - 150 - 2.4 = -222.2336816, cumulative -669.5496016; month 4 leaves 550 - 447.31592 = 102.68408.
    const withF = 4 + 102.68408 / (102.68408 + 119.5496016);
    near(p.withFacility!.survivalMonths!, withF, 1e-8);
    expect(p.peakMonth).toBe(14);
    near(p.ladderBuffer.termFundingNeed, -p.peakShortfall - 400 * M);
  });

  it("a path that never goes negative has no peak month, no crossing and no term-funding need", () => {
    const l = legs();
    const rich = { ...l, inflow: new Array<number>(14).fill(500 * M), inflowStress: new Array<number>(14).fill(500 * M) };
    const p = computeSurvivalPath({ scenarioId: "severe", params: WITH_CD.severe, legs: rich, horizonMonths: 14, buffer: 0, facility: { capacity: 10 * M, haircut: 0 } });
    expect(p.rows.every((x) => x.cumulative > 0)).toBe(true);
    expect(p.peakShortfall).toBe(0);
    expect(p.peakMonth).toBeNull();
    expect(p.ladderBuffer).toEqual({ buffer: 0, survivalMonths: null, survivalDays: null, termFundingNeed: 0 });
    expect(p.withFacility!.survivalMonths).toBeNull();
  });

  it("early withdrawals in the legs leave in full, after the renewal share of the maturities", () => {
    const l = { ...legs(), cdEarlyWithdrawals: Array.from({ length: 14 }, (_, i) => (i === 1 ? 6 * M : 0)) };
    const p = computeSurvivalPath({ scenarioId: "severe", params: WITH_CD.severe, legs: l, horizonMonths: 14, buffer: 400 * M });
    near(p.rows[1]!.cdOut, 100 * M * 0.75 + 6 * M);
  });

  it("refuses a path longer than the run's balances", () => {
    expect(() => computeSurvivalPath({ scenarioId: "bau", params: TABLE.bau, legs: legs(), horizonMonths: 15, buffer: 0 })).toThrow(/reach 14 months, so the path can run at most that long, not 15/);
  });
});
