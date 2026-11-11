/**
 * The second inflow line of the liquidity stress ladder. The bau row reads the base-path
 * principal; the moderate and severe rows read a position's stress series where one is given and its base series
 * otherwise; with no stress series at all the ladder is the one-line ladder, value for value.
 */
import { describe, expect, it } from "vitest";
import { FIXED_LOAN_DEFAULTS, NMD_B_TERMS_DEFAULTS, NMD_TERMS_DEFAULTS } from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { LiquidityStressTable } from "../../contracts/results";
import { LIQUIDITY_STRESS_ROWS, computeLiquidityStress } from "../stressLadder";

const M = 1_000_000;
const TABLE: LiquidityStressTable = {
  bau: { hysOutflowMonthly: 0.005, wholesaleRenewal: 1, nibOutflowMonthly: 0.002, drawRate: 0 },
  moderate: { hysOutflowMonthly: 0.05, wholesaleRenewal: 0.5, nibOutflowMonthly: 0.01, drawRate: 0.15 },
  severe: { hysOutflowMonthly: 0.1, wholesaleRenewal: 0, nibOutflowMonthly: 0.02, drawRate: 0.3 },
};

function coa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "LOANS", order: 0 },
      { id: "liabilities", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "hys", label: "HYS", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "HYS", order: 0 },
      { id: "nib", label: "NIB", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "NIB", order: 1 },
    ],
    families: [
      { id: "LOANS", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "loans" },
      { id: "HYS", label: "HYS", side: "liability", instrumentType: "nmd-b", coaNodeId: "hys" },
      { id: "NIB", label: "NIB", side: "liability", instrumentType: "nmd", coaNodeId: "nib" },
    ],
  };
}

const loan = (id: string): Position => ({
  id,
  familyId: "LOANS",
  coaNodeId: "loans",
  terms: { ...FIXED_LOAN_DEFAULTS, id, notional: 1_000 * M, maturityMonths: 48 },
  dimensions: { liquidityRole: "inflow-asset" },
});

const book: PortfolioSpec = {
  id: "PF-B1",
  label: "two inflow loans",
  asOf: "2026-03-31",
  coa: coa(),
  positions: [
    loan("personal"),
    loan("auto"),
    { id: "hys", familyId: "HYS", coaNodeId: "hys", terms: { ...NMD_B_TERMS_DEFAULTS, id: "hys", notional: 4_833 * M }, dimensions: { liquidityRole: "hys-pool" } },
    { id: "nib", familyId: "NIB", coaNodeId: "nib", terms: { ...NMD_TERMS_DEFAULTS, id: "nib", notional: 1_667 * M }, dimensions: { liquidityRole: "nib-pool" } },
  ],
};

const flat = (v: number) => new Array<number>(12).fill(v);
const base = new Map([
  ["personal", flat(70 * M)],
  ["auto", flat(30 * M)],
]);
const input = { book, principalByPosition: base, table: TABLE, buffer: 2_170 * M, undrawnFace: 500 * M, horizonMonths: 12 };

describe("the stress inflow line", () => {
  it("names moderate and severe as the rows that read it", () => {
    expect(LIQUIDITY_STRESS_ROWS).toEqual(["moderate", "severe"]);
  });

  it("bau reads base principal; the stress rows read the stress series of a position that has one", () => {
    const stress = new Map([["personal", flat(40 * M)]]);
    const out = computeLiquidityStress({ ...input, stressPrincipalByPosition: stress });
    const [bau, moderate, severe] = out.scenarios;
    expect(bau!.inflow).toEqual(flat(100 * M));
    expect(moderate!.inflow).toEqual(flat(70 * M));
    expect(severe!.inflow).toEqual(flat(70 * M));
    // A slower stress line can only shorten the horizon.
    const one = computeLiquidityStress(input);
    expect(moderate!.cumulative[11]).toBeCloseTo(one.scenarios[1]!.cumulative[11]! - 12 * 30 * M, 3);
  });

  it("with no stress series, or an empty map, the ladder equals the one-line ladder exactly", () => {
    const one = computeLiquidityStress(input);
    expect(computeLiquidityStress({ ...input, stressPrincipalByPosition: new Map() })).toEqual(one);
    for (const s of one.scenarios) expect(s.inflow).toEqual(flat(100 * M));
  });
});
