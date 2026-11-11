/**
 * The `liquidityStress` opt-in on the
 * run pipeline. It reads the base scenario's overlaid book, regenerates each
 * inflow-asset and wholesale position's principal on the base deterministic
 * path through the instrument factory, writes RunResult.liquidityStress and
 * leaves every other byte alone; a run without the opt-in carries no key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { LiquidityStressTable } from "../../contracts/results";
import type { RunResult } from "../../contracts/run";
import { computeLiquidityStress } from "../../liquidity";
import { defaultHarness } from "../../plugins/defaultHarness";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import {
  AS_OF,
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  mortgagePosition,
  nmdBetaPosition,
  nmdPosition,
} from "./fixtures";

const M = 1_000_000;
let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const TABLE: LiquidityStressTable = {
  bau: { hysOutflowMonthly: 0.005, wholesaleRenewal: 1, nibOutflowMonthly: 0.002, drawRate: 0 },
  moderate: { hysOutflowMonthly: 0.05, wholesaleRenewal: 0.5, nibOutflowMonthly: 0.01, drawRate: 0.15 },
  severe: { hysOutflowMonthly: 0.1, wholesaleRenewal: 0, nibOutflowMonthly: 0.02, drawRate: 0.3 },
};
const OPT_IN = { table: TABLE, buffer: 2 * M, undrawnFace: 0.5 * M };

function ctx(extra?: Partial<RunPipelineContext>): RunPipelineContext {
  return { ...resolveDefaultContext(), ...extra };
}

function role(p: Position, liquidityRole: string): Position {
  return { ...p, dimensions: { liquidityRole } };
}

function wholesale(id: string, notional: number, maturityMonths: number): Position {
  const p = fixedPosition(id, { notional, maturityMonths, amortType: "bullet", coupon: 0.04 });
  return { ...p, familyId: "WHOLESALE", coaNodeId: "wholesale", dimensions: { liquidityRole: "wholesale" } };
}

/** The run fixture book with liquidity roles, an HQLA bill and three wholesale bullets. */
function liquidityBook(): PortfolioSpec {
  const coa = makeCoa();
  coa.nodes.push({ id: "wholesale", label: "Wholesale", parentId: "liabilities", side: "liability", isLeaf: true, familyId: "WHOLESALE", order: 2 });
  coa.families.push({ id: "WHOLESALE", label: "Wholesale", side: "liability", instrumentType: "fixed-loan", coaNodeId: "wholesale" });
  return {
    id: "PF-LIQ",
    label: "Liquidity block test book",
    asOf: AS_OF,
    coa,
    positions: [
      role(fixedPosition("F1", { notional: 5 * M, coupon: 0.05, maturityMonths: 60 }), "inflow-asset"),
      role(mortgagePosition("M1", { notional: 4 * M, originalBalance: 4 * M }), "inflow-asset"),
      role(fixedPosition("T1", { notional: 2 * M, coupon: 0.04, maturityMonths: 3, amortType: "bullet" }), "hqla-stock"),
      role(nmdPosition("D1", { notional: 3 * M }), "nib-pool"),
      role(nmdBetaPosition("B1", { notional: 2 * M }), "hys-pool"),
      role(nmdBetaPosition("B2", { notional: 1 * M }), "hys-pool"),
      wholesale("W1", 1 * M, 1),
      wholesale("W6", 1.5 * M, 6),
      wholesale("W24", 0.5 * M, 24),
    ],
  };
}

function request() {
  return makeRunRequest(market, { portfolioId: "PF-LIQ" });
}

/** Months 1..12 of a position's principal on the base path, built outside the run. */
function directPrincipal(book: PortfolioSpec): Map<string, number[]> {
  const h = defaultHarness();
  const base = request().scenarios[0]!;
  const path = h.get("ratePaths").get("deterministic")(h.get("curves").build(market), base, 361);
  const out = new Map<string, number[]>();
  for (const p of book.positions) {
    const series = new Array<number>(12).fill(0);
    for (const cf of makeInstrument(p.terms).generateCashflows(path)) {
      if (cf.monthOffset >= 1 && cf.monthOffset <= 12) series[cf.monthOffset - 1]! += cf.principalPaid;
    }
    out.set(p.id, series);
  }
  return out;
}

function withoutBlock(r: RunResult): string {
  const copy = JSON.parse(JSON.stringify(r)) as { liquidityStress?: unknown };
  delete copy.liquidityStress;
  return JSON.stringify(copy);
}

describe("run pipeline: the liquidityStress opt-in (spec E5)", () => {
  it("writes the block: pools and wholesale maturities by role, HQLA stock and maturities beyond 12 months left out", () => {
    const result = buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: OPT_IN }));
    const block = result.liquidityStress!;
    expect(block.horizonMonths).toBe(12);
    expect(block.buffer).toBe(2 * M);
    expect(block.undrawnFace).toBe(0.5 * M);
    expect(block.pools).toEqual({ hys: 3 * M, nib: 3 * M });
    const expected = new Array<number>(12).fill(0);
    expected[0] = 1 * M;
    expected[5] = 1.5 * M;
    expect(block.wholesaleMaturities).toEqual(expected);
    expect(block.scenarios.map((s) => s.id)).toEqual(["bau", "moderate", "severe"]);
    // Inflows are the two inflow assets' principal on the base path; the bill's 2M at month 3 is not one.
    const direct = directPrincipal(liquidityBook());
    for (let m = 0; m < 12; m++) {
      expect(block.scenarios[0]!.inflow[m]).toBeCloseTo(direct.get("F1")![m]! + direct.get("M1")![m]!, 6);
    }
    expect(block.scenarios[0]!.inflow[2]!).toBeLessThan(1 * M);
    expect(JSON.stringify(result)).not.toMatch(/NaN/);
  });

  it("the block equals computeLiquidityStress on the run's book with the principal regenerated on the base path", () => {
    const result = buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: OPT_IN }));
    const direct = computeLiquidityStress({
      book: liquidityBook(),
      principalByPosition: directPrincipal(liquidityBook()),
      ...OPT_IN,
      horizonMonths: 12,
    });
    expect(JSON.stringify(result.liquidityStress)).toBe(JSON.stringify(direct));
  });

  it("reports survival per scenario (null when never pierced) and the peak shortfall with its month", () => {
    const block = buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: OPT_IN })).liquidityStress!;
    const severe = block.scenarios[2]!;
    // Severe month 1: 10% of 3M, 2% of 3M, the 1M wholesale bullet with no renewal, 0.5M x 0.30 / 12.
    expect(severe.hysOut[0]).toBeCloseTo(0.3 * M, 6);
    expect(severe.nibOut[0]).toBeCloseTo(0.06 * M, 6);
    expect(severe.wholesaleOut[0]).toBe(1 * M);
    expect(severe.draws[0]).toBeCloseTo(12_500, 9);
    expect(typeof severe.survivalMonths).toBe("number");
    const minCum = Math.min(...severe.cumulative);
    expect(severe.peakShortfall).toBe(minCum);
    expect(severe.peakMonth).toBe(severe.cumulative.indexOf(minCum) + 1);
    const bau = block.scenarios[0]!;
    expect(bau.survivalMonths).toBeNull();
    expect(bau.wholesaleOut).toEqual(new Array(12).fill(0));
  });

  it("the regulatory convention leaves pools and wholesale maturities unchanged (the children carry the parent's role)", () => {
    const behavioral = buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: OPT_IN })).liquidityStress!;
    const regulatory = buildRunResult(
      request(),
      liquidityBook(),
      ctx({ liquidityStress: OPT_IN, nmdConvention: "regulatory" }),
    );
    expect(regulatory.parentOf).toBeDefined();
    const block = regulatory.liquidityStress!;
    expect(Math.abs(block.pools.hys - behavioral.pools.hys)).toBeLessThan(1e-6);
    expect(Math.abs(block.pools.nib - behavioral.pools.nib)).toBeLessThan(1e-6);
    expect(block.wholesaleMaturities).toEqual(behavioral.wholesaleMaturities);
  });

  it("the opt-in moves no other byte: the run minus liquidityStress equals the plain run", () => {
    const plain = buildRunResult(request(), liquidityBook(), ctx());
    const withBlock = buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: OPT_IN }));
    expect(withoutBlock(withBlock)).toBe(JSON.stringify(plain));
  });

  it("a run without the opt-in carries no liquidityStress key, and two opted-in runs serialize byte-identically", () => {
    const plain = buildRunResult(request(), liquidityBook(), ctx());
    expect("liquidityStress" in plain).toBe(false);
    const a = buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: OPT_IN }));
    const b = buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: OPT_IN }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("S3d-1: the survival path runs past month 12 on the run's own principal, months 1..12 the severe row; the derived buffer is the tagged bill", () => {
    const tagged = liquidityBook();
    tagged.positions = tagged.positions.map((p) => (p.id === "T1" ? { ...p, dimensions: { liquidityRole: "hqla-stock", "hqla-level": "l1" } } : p));
    const { buffer: _b, ...noBuffer } = OPT_IN;
    void _b;
    const opt = { ...noBuffer, survivalPath: { horizonMonths: 30, facility: { capacity: 1 * M, haircut: 0.2 } } };
    const block = buildRunResult(request(), tagged, ctx({ liquidityStress: opt })).liquidityStress!;
    expect(block.buffer).toBe(2 * M); // the 2M bill at level 1, no haircut
    const sp = block.survivalPath!;
    expect(sp.legs.horizonMonths).toBe(30);
    expect(sp.rows).toHaveLength(30);
    expect(sp.rows.slice(0, 12).map((r) => r.cumulative)).toEqual(block.scenarios[2]!.cumulative);
    // The 0.5M wholesale bullet maturing at month 24 enters at month 24, with no renewal on severe.
    expect(sp.legs.wholesaleMaturities[23]).toBe(0.5 * M);
    expect(sp.rows[23]!.wholesaleOut).toBe(0.5 * M);
    expect(sp.rows[12]!.draws).toBe(0);
    expect(sp.facility!.counted).toBeCloseTo(0.8 * M, 9);
    expect(sp.withFacility!.buffer).toBeCloseTo(2.8 * M, 9);
    // Inflows past month 12 are the inflow assets' own base-path principal, regenerated outside the run.
    const h = defaultHarness();
    const path = h.get("ratePaths").get("deterministic")(h.get("curves").build(market), request().scenarios[0]!, 361);
    let m20 = 0;
    for (const id of ["F1", "M1"]) for (const cf of makeInstrument(tagged.positions.find((p) => p.id === id)!.terms).generateCashflows(path)) if (cf.monthOffset === 20) m20 += cf.principalPaid;
    expect(sp.legs.inflow[19]).toBeCloseTo(m20, 6);
    // Every other block is the run without the path, byte for byte.
    const plain = buildRunResult(request(), tagged, ctx({ liquidityStress: noBuffer }));
    const strip = (r: RunResult) => { const c = JSON.parse(JSON.stringify(r)) as { liquidityStress?: { survivalPath?: unknown } }; delete c.liquidityStress!.survivalPath; return JSON.stringify(c); };
    expect(strip(buildRunResult(request(), tagged, ctx({ liquidityStress: opt })))).toBe(JSON.stringify(plain));
  });

  it("refuses a malformed opt-in before the walk, naming the field", () => {
    const bad = { ...OPT_IN, table: { ...TABLE, severe: { ...TABLE.severe, wholesaleRenewal: 2 } } };
    expect(() => buildRunResult(request(), liquidityBook(), ctx({ liquidityStress: bad }))).toThrow(
      "run: context.liquidityStress.table.severe.wholesaleRenewal must be a decimal in [0, 1], got 2",
    );
  });
});
