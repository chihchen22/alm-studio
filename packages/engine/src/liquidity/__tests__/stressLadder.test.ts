/**
 * The liquidity stress ladder and the survival horizon, on a synthetic mini book with round
 * illustrative numbers. Every expected value is restated by hand in the comment beside it, never imported from the
 * module under test.
 *
 *   recursion  hysOut = pool x hysOutflowMonthly, then pool -= hysOut; nibOut likewise; wholesaleOut = maturity x
 *              (1 - renewal); draws = undrawnFace x drawRate / 12; net = inflow - hysOut - nibOut - wholesaleOut - draws
 *   survival   the first month where buffer + cumulative < 0, interpolated from the month before
 */
import { describe, expect, it } from "vitest";
import { NMD_B_TERMS_DEFAULTS, NMD_TERMS_DEFAULTS, FIXED_LOAN_DEFAULTS } from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { LiquidityStressTable } from "../../contracts/results";
import { computeLiquidityStress, liquidityStressConfigError, survivalMonths } from "../stressLadder";

const M = 1_000_000;

/** A synthetic stress table. */
const TABLE: LiquidityStressTable = {
  bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0 },
  moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12 },
  severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25 },
};
const BUFFER = 500 * M;
const UNDRAWN = 240 * M;
const HYS_POOL = 1_000 * M;
const NIB_POOL = 500 * M;

function coa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "LOANS", order: 0 },
      { id: "bills", label: "Bills", parentId: "assets", side: "asset", isLeaf: true, familyId: "BILLS", order: 1 },
      { id: "liabilities", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "hys", label: "HYS", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "HYS", order: 0 },
      { id: "nib", label: "NIB", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "NIB", order: 1 },
      { id: "wholesale", label: "Wholesale", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "WHOLESALE", order: 2 },
    ],
    families: [
      { id: "LOANS", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "loans" },
      { id: "BILLS", label: "Bills", side: "asset", instrumentType: "fixed-loan", coaNodeId: "bills" },
      { id: "HYS", label: "HYS", side: "liability", instrumentType: "nmd-b", coaNodeId: "hys" },
      { id: "NIB", label: "NIB", side: "liability", instrumentType: "nmd", coaNodeId: "nib" },
      { id: "WHOLESALE", label: "Wholesale", side: "liability", instrumentType: "fixed-loan", coaNodeId: "wholesale" },
    ],
  };
}

function loan(id: string, familyId: string, coaNodeId: string, notional: number, maturityMonths: number, role: string): Position {
  return { id, familyId, coaNodeId, terms: { ...FIXED_LOAN_DEFAULTS, id, notional, maturityMonths, amortType: "bullet" }, dimensions: { liquidityRole: role } };
}

/** Pooled HYS as two nmd-b positions (700M + 300M), NIB 500M, two wholesale bullets, one inflow asset, HQLA, an untagged loan. */
function miniBook(): PortfolioSpec {
  return {
    id: "PF-LIQ-SYNTH",
    label: "Liquidity stress synthetic mini book",
    asOf: "2026-03-31",
    coa: coa(),
    positions: [
      loan("inflow", "LOANS", "loans", 2_000 * M, 120, "inflow-asset"),
      loan("bills", "BILLS", "bills", 400 * M, 3, "hqla-stock"),
      { id: "hys-a", familyId: "HYS", coaNodeId: "hys", terms: { ...NMD_B_TERMS_DEFAULTS, id: "hys-a", notional: 700 * M }, dimensions: { liquidityRole: "hys-pool" } },
      { id: "hys-b", familyId: "HYS", coaNodeId: "hys", terms: { ...NMD_B_TERMS_DEFAULTS, id: "hys-b", notional: 300 * M }, dimensions: { liquidityRole: "hys-pool" } },
      { id: "nib", familyId: "NIB", coaNodeId: "nib", terms: { ...NMD_TERMS_DEFAULTS, id: "nib", notional: NIB_POOL }, dimensions: { liquidityRole: "nib-pool" } },
      loan("repo", "WHOLESALE", "wholesale", 200 * M, 1, "wholesale"),
      loan("brokered-6m", "WHOLESALE", "wholesale", 300 * M, 6, "wholesale"),
      // No role: enters nothing.
      loan("untagged", "LOANS", "loans", 99 * M, 2, "none-of-the-five"),
    ],
  };
}

function bullet(notional: number, month: number, length = 12): number[] {
  const out = new Array<number>(length).fill(0);
  if (month <= length) out[month - 1] = notional;
  return out;
}

/** The inflow asset returns 50M of principal every month; the bullets mature in their month. */
function principal(): Map<string, number[]> {
  return new Map<string, number[]>([
    ["inflow", new Array<number>(12).fill(50 * M)],
    ["bills", bullet(400 * M, 3)],
    ["repo", bullet(200 * M, 1)],
    ["brokered-6m", bullet(300 * M, 6)],
    ["untagged", bullet(99 * M, 2)],
  ]);
}

const run = () => computeLiquidityStress({ book: miniBook(), principalByPosition: principal(), table: TABLE, buffer: BUFFER, undrawnFace: UNDRAWN, horizonMonths: 12 });
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("survivalMonths", () => {
  it("interpolates between the listed months: cumulative [-400, -900, -1200] at months 1, 3, 6, buffer 600 -> 1.8", () => {
    // Running 200 at month 1 and -300 at month 3: 1 + 200 / 500 x (3 - 1) = 1.8.
    near(survivalMonths([1, 3, 6], [-400, -900, -1_200], 600)!, 1.8, 1e-12);
  });

  it("returns null when the buffer is never pierced inside the horizon", () => {
    expect(survivalMonths([1, 2, 3], [-100, -200, -300], 1_000)).toBeNull();
    // Touching zero is not a breach: the rule is running < 0.
    expect(survivalMonths([1, 2], [-500, -1_000], 1_000)).toBeNull();
  });

  it("a breach in month 1 interpolates from month 0 at the full buffer", () => {
    // prev 100 at m0, running -300 at m1: 0 + 100 / 400 x 1.
    expect(survivalMonths([1], [-400], 100)).toBe(0.25);
  });

  it("refuses arrays of different lengths", () => {
    expect(() => survivalMonths([1, 2], [-1], 10)).toThrow(/2 months but 1 cumulative values/);
  });
});

describe("computeLiquidityStress on the synthetic mini book", () => {
  it("reads pools, wholesale maturities and inflows by liquidityRole only", () => {
    const r = run();
    expect(r.horizonMonths).toBe(12);
    expect(r.buffer).toBe(BUFFER);
    expect(r.undrawnFace).toBe(UNDRAWN);
    expect(r.pools).toEqual({ hys: HYS_POOL, nib: NIB_POOL });
    expect(r.wholesaleMaturities).toEqual(bullet(200 * M, 1).map((v, i) => v + bullet(300 * M, 6)[i]!));
    expect(r.scenarios.map((s) => s.id)).toEqual(["bau", "moderate", "severe"]);
    // HQLA stock and an unrecognized role enter no inflow: 50M every month.
    expect(r.scenarios[2]!.inflow).toEqual(new Array(12).fill(50 * M));
  });

  it("severe, month by month: the recursion restated by hand", () => {
    const severe = run().scenarios.find((s) => s.id === "severe")!;
    expect(severe.params).toEqual(TABLE.severe);
    // Month 1: hys 1,000 x 0.08 = 80; nib 500 x 0.015 = 7.5; repo 200 x (1 - 0.2) = 160; draws 240 x 0.25 / 12 = 5.
    near(severe.hysOut[0]!, 80 * M);
    near(severe.nibOut[0]!, 7.5 * M);
    near(severe.wholesaleOut[0]!, 160 * M);
    expect(severe.draws).toEqual(new Array(12).fill(5 * M));
    near(severe.net[0]!, (50 - 80 - 7.5 - 160 - 5) * M); // -202.5
    // Month 2: hys pool 920 -> 73.6; nib pool 492.5 -> 7.3875; no maturity: net 50 - 73.6 - 7.3875 - 5 = -35.9875.
    near(severe.hysOut[1]!, 73.6 * M);
    near(severe.nibOut[1]!, 7.3875 * M);
    near(severe.net[1]!, -35.9875 * M);
    near(severe.cumulative[1]!, (-202.5 - 35.9875) * M);
    // Month 6: the 300M bullet, 80% not renewed.
    near(severe.wholesaleOut[5]!, 240 * M);
  });

  it("severe: the ladder month by month, the buffer pierced at month 6 and interpolated from month 5, the peak at month 9", () => {
    const severe = run().scenarios.find((s) => s.id === "severe")!;
    // Worked by hand from the recursion (pools 1,000 and 500 decaying at 8% and 1.5% a month, draws 5, inflow 50, the
    // 200M bullet out 160 at month 1 and the 300M bullet out 240 at month 6), in $M, months 1 to 12:
    const cumulativeM = [-202.5, -238.4875, -268.476188, -292.938765, -312.310226, -566.990871, -577.349083, -583.723876, -586.427245, -585.746325, -581.945379, -575.267628];
    severe.cumulative.forEach((c, i) => near(c, cumulativeM[i]! * M, 1));
    // The 500M buffer holds at month 5 (500 - 312.31 = 187.69) and breaks at month 6 (500 - 566.99 = -66.99):
    // 5 + 187.689774 / (187.689774 + 66.990871) = 5.736961.
    near(severe.survivalMonths!, 5.736961279, 1e-6);
    // Net turns positive after month 9 as the pools shrink, so the lowest cumulative is month 9's.
    near(severe.peakShortfall, -586.427245 * M, 1);
    expect(severe.peakMonth).toBe(9);
  });

  it("bau: full renewal and no draws; inflow covers the outflow every month, so the buffer is never pierced", () => {
    const bau = run().scenarios.find((s) => s.id === "bau")!;
    expect(bau.wholesaleOut).toEqual(new Array(12).fill(0));
    expect(bau.draws).toEqual(new Array(12).fill(0));
    // Month 1: 50 - 1,000 x 0.004 - 500 x 0.001 = 45.5.
    near(bau.net[0]!, 45.5 * M);
    expect(bau.survivalMonths).toBeNull();
  });

  it("every series is a plain 12-entry number array and the block serializes with no NaN, deterministically", () => {
    const r = run();
    for (const s of r.scenarios) {
      for (const series of [s.inflow, s.hysOut, s.nibOut, s.wholesaleOut, s.draws, s.net, s.cumulative]) {
        expect(Array.isArray(series)).toBe(true);
        expect(series).toHaveLength(12);
      }
    }
    expect(JSON.stringify(r)).not.toMatch(/NaN/);
    expect(JSON.stringify(run())).toBe(JSON.stringify(r));
  });

  it("a principal series shorter than the horizon reads zeros beyond its end; a missing one reads zeros", () => {
    const p = principal();
    p.set("repo", [200 * M]);
    p.delete("brokered-6m");
    const r = computeLiquidityStress({ book: miniBook(), principalByPosition: p, table: TABLE, buffer: BUFFER, undrawnFace: UNDRAWN, horizonMonths: 12 });
    expect(r.wholesaleMaturities[0]).toBe(200 * M);
    expect(r.wholesaleMaturities[5]).toBe(0);
  });
});

describe("liquidityStressConfigError: the opt-in's shape", () => {
  const ok = { table: TABLE, buffer: BUFFER, undrawnFace: UNDRAWN };
  it("accepts a well-formed table", () => {
    expect(liquidityStressConfigError(ok, "engineOptions.liquidityStress")).toBeUndefined();
  });
  it("names the object and the field", () => {
    expect(liquidityStressConfigError("yes", "engineOptions.liquidityStress")).toBe(
      'engineOptions.liquidityStress must be an object { table, buffer, undrawnFace }, got "yes"',
    );
    expect(liquidityStressConfigError({ ...ok, buffer: -1 }, "x")).toBe("x.buffer must be a finite number >= 0, got -1");
    expect(liquidityStressConfigError({ ...ok, undrawnFace: "240" }, "x")).toBe('x.undrawnFace must be a finite number >= 0, got "240"');
    expect(liquidityStressConfigError({ ...ok, table: { bau: TABLE.bau, moderate: TABLE.moderate } }, "x")).toBe(
      "x.table.severe must be an object { hysOutflowMonthly, wholesaleRenewal, nibOutflowMonthly, drawRate }, got undefined",
    );
    expect(liquidityStressConfigError({ ...ok, table: { ...TABLE, moderate: { ...TABLE.moderate, drawRate: 1.5 } } }, "x")).toBe(
      "x.table.moderate.drawRate must be a decimal in [0, 1], got 1.5",
    );
  });
  it("computeLiquidityStress refuses a malformed table and a non-integer horizon", () => {
    expect(() =>
      computeLiquidityStress({ book: miniBook(), principalByPosition: principal(), table: { ...TABLE, bau: { ...TABLE.bau, hysOutflowMonthly: Number.NaN } }, buffer: BUFFER, undrawnFace: UNDRAWN, horizonMonths: 12 }),
    ).toThrow(/liquidity stress: table.bau.hysOutflowMonthly must be a decimal in \[0, 1\], got NaN/);
    expect(() =>
      computeLiquidityStress({ book: miniBook(), principalByPosition: principal(), table: TABLE, buffer: BUFFER, undrawnFace: UNDRAWN, horizonMonths: 0 }),
    ).toThrow(/liquidity stress: horizonMonths must be a positive integer, got 0/);
  });
});
