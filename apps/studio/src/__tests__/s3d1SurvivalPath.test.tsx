// apps/studio/src/__tests__/s3d1SurvivalPath.test.tsx
/**
 * Results > Liquidity's survival path, the commitment dials and the buffer readout; the
 * Home card; the setup editor's liquidity switches. Static markup and pure functions, no DOM. The ladder fixture is
 * the engine's own ladder on a synthetic book with round numbers; each expected figure is restated by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FIXED_LOAN_DEFAULTS, NMD_B_TERMS_DEFAULTS, NMD_TERMS_DEFAULTS } from "@alm/kernel";
import type { LiquidityStressResult, PortfolioSpec, RunResult } from "@alm/engine";
import { computeLiquidityStress, computeSurvivalPath, liquidityStressConfigError } from "@alm/engine/src/liquidity";
import { LiquidityTab } from "../pages/results/LiquidityTab";
import { rowParams, runDialsOf, runFormOf, runInputOf, runLegs, SurvivalPathPanel } from "../pages/results/SurvivalPathSection";
import { SURVIVAL_PATH_CARDS, cardFor, wordCount } from "../guided/featureDemos";
import { DEFAULT_LIQUIDITY_STRESS, withBufferFromTags, withCdRenewal, withDials, withFacility, withFacilityField, withLiquidityStress, withSurvivalMonths, withSurvivalPath } from "../rows/setupRows";
import { BLOCKS_DETAIL } from "./fixtures/blocks";
import { freshResult } from "./fixtures/results";
import { STANDARD_ALCO } from "./fixtures/setup";

const M = 1e6;

/** HYS 1,000M, NIB 500M, a loan paying 10M a month, a 300M CD book, two tagged securities (100M l1, 200M l2a). */
function book(): PortfolioSpec {
  const fam = (id: string, side: "asset" | "liability", type: "fixed-loan" | "nmd" | "nmd-b") => ({ id, label: id, side, instrumentType: type, coaNodeId: id });
  const pos = (id: string, family: string, notional: number, dims: Record<string, string>) => ({ id, familyId: family, coaNodeId: family, terms: { ...FIXED_LOAN_DEFAULTS, id, notional, maturityMonths: 24, amortType: "bullet" as const }, dimensions: dims });
  return {
    id: "PF", label: "PF", asOf: "2026-03-31",
    coa: { schemaVersion: "1.0.0", nodes: [], families: [fam("L", "asset", "fixed-loan"), fam("S", "asset", "fixed-loan"), fam("H", "liability", "nmd-b"), fam("N", "liability", "nmd"), fam("C", "liability", "fixed-loan")] },
    positions: [
      pos("loan", "L", 1_000 * M, { liquidityRole: "inflow-asset" }),
      pos("bill", "S", 100 * M, { liquidityRole: "hqla-stock", "hqla-level": "l1" }),
      pos("agency", "S", 200 * M, { liquidityRole: "hqla-stock", "hqla-level": "l2a" }),
      { id: "hys", familyId: "H", coaNodeId: "H", terms: { ...NMD_B_TERMS_DEFAULTS, id: "hys", notional: 1_000 * M }, dimensions: { liquidityRole: "hys-pool" } },
      { id: "nib", familyId: "N", coaNodeId: "N", terms: { ...NMD_TERMS_DEFAULTS, id: "nib", notional: 500 * M }, dimensions: { liquidityRole: "nib-pool" } },
      pos("cds", "C", 300 * M, { liquidityRole: "term-deposit" }),
    ],
  };
}

const TABLE = {
  bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0, cdRenewal: 0.9 },
  moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12, cdRenewal: 0.6 },
  severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25, cdRenewal: 0.3 },
};
/** The dials a ladder takes: no amount of their own; they read the ladder's undrawn face, 120M, as the amount undrawn now. */
const DIALS = { expectedUtilization: 0.15, tailUtilization: 0.35, fundingSpreadBp: 50, lcrFactor: 0.1, thirtyDayShare: 1 / 12 };

function ladder(): LiquidityStressResult {
  const cd = new Array<number>(12).fill(0);
  cd[1] = 100 * M;
  const principal = new Map([["loan", new Array<number>(12).fill(10 * M)], ["cds", cd]]);
  const b = computeLiquidityStress({ book: book(), principalByPosition: principal, table: TABLE, undrawnFace: 120 * M, dials: DIALS, horizonMonths: 12 });
  const legs = runLegs(b);
  b.survivalPath = computeSurvivalPath({ scenarioId: "severe", params: b.scenarios[2]!.params, legs, horizonMonths: 12, buffer: b.buffer, facility: { label: "FHLB borrowing capacity, unused", capacity: 100 * M, haircut: 0.2 } });
  return b;
}

const props = (result: RunResult) => ({ runId: "run-s3d", detail: BLOCKS_DETAIL, result, query: {}, scenarioLabel: (id: string) => id });

describe("the survival path's pure parts", () => {
  const b = ladder();
  it("the run's legs rebuild the ladder: a 12-month path on the severe row is the ladder's row", () => {
    const { survivalPath: _sp, ...noPath } = b;
    void _sp;
    const legs = runLegs(noPath);
    expect(legs.cdMaturities[1]).toBe(100 * M);
    const p = computeSurvivalPath({ scenarioId: "severe", params: b.scenarios[2]!.params, legs, horizonMonths: 12, buffer: b.buffer });
    expect(p.rows.map((r) => r.cumulative)).toEqual(b.scenarios[2]!.cumulative);
  });

  it("the link: severe draws the requirement, a rate of (U99 - Ubar) / (1 - Ubar) on the undrawn face; unlinked, the table's 25 percent; other rows keep theirs", () => {
    // U99 45, Ubar 15: (0.45 - 0.15) / 0.85 = 0.352941...
    expect(rowParams(b, "severe", true, { undrawn: 120 * M, ...DIALS, tailUtilization: 0.45 }).drawRate).toBeCloseTo(0.3 / 0.85, 12);
    // The ladder ran the same rule: (0.35 - 0.15) / 0.85.
    expect(b.scenarios[2]!.params.drawRate).toBeCloseTo(0.2 / 0.85, 12);
    expect(rowParams(b, "severe", false, DIALS).drawRate).toBe(0.25);
    expect(rowParams(b, "moderate", true, DIALS).drawRate).toBe(0.12);
  });

  it("the run form opens on the stored path and names a month count past the run's balances", () => {
    const f = runFormOf(b);
    expect(f).toMatchObject({ scenarioId: "severe", months: "12", facilityOn: true, capacityMusd: "100", haircutPct: "20", linked: true });
    expect(runDialsOf(b)).toEqual({ undrawn: 120 * M, ...DIALS });
    const bad = runInputOf(b, { ...f, months: "13" }, { ok: true, value: { undrawn: 120 * M, ...DIALS } });
    expect(bad).toEqual({ ok: false, reason: "Months: give a whole number from 1 to 12, the months this run's balances reach. Turn the survival path on in the run setup for a longer one." });
  });
});

describe("Results > Liquidity with the survival path", () => {
  const r = freshResult();
  r.liquidityStress = ladder();
  const html = renderToStaticMarkup(<LiquidityTab ws="ws-a" {...props(r)} />);

  it("shows the buffer read from the tags: 100M at level 1 and 200M at 2A less 15 percent, 270M", () => {
    expect(html).toContain('aria-label="The buffer"');
    expect(html).toContain("Level 2A");
    expect(html).toContain("$270.0M");
    expect(html).toContain("are not applied");
  });

  it("shows the CD column, the CD renewal and the draw rule with the dials' rate", () => {
    expect(html).toContain("CDs out");
    expect(html).toContain("CD renewal");
    expect(html).toContain("U99 - Ubar");
    expect(html).toContain("in place of the table");
    expect(html).toContain("Export liquidity-stress.csv");
  });

  it("puts the survival path under the ladder: months, days, the borrowing line on its own line, the LCR reference beside", () => {
    expect(html.indexOf('aria-label="Survival path"')).toBeGreaterThan(html.indexOf('aria-label="Stress table"'));
    expect(html).toContain("Built from this run");
    expect(html).toContain("Type your own path");
    expect(html).toContain("Survival on the run&#x27;s path");
    expect(html).toContain("Survival, days");
    expect(html).toContain("Buffer plus FHLB borrowing capacity, unused");
    expect(html).toContain("$80.0M");
    expect(html).toContain("LCR reference, beside");
    // The LCR reference reads the 120M undrawn now: 10 percent, $12.0M; the face is 120M / 0.85, $141.2M.
    expect(html).toContain("$12.0M");
    expect(html).toContain("$141.2M");
    expect(html).toContain("Commitment dials");
    expect(html).not.toContain("This run set no dials");
    expect(html).toContain("Export survival-path.csv");
    expect(html).toContain("As the run stored it.");
  });

  it("M1: a run that set no dials opens them on starting values, says so, and shows no LCR reference until one is edited", () => {
    const { commitmentDials: _d, ...noDials } = ladder();
    void _d;
    const out = renderToStaticMarkup(<SurvivalPathPanel block={noDials} presets={[]} />);
    expect(out).toContain("Starting values. This run set no dials.");
    expect(out).not.toContain("LCR reference, beside");
    expect(out).not.toContain("LCR reference outflow");
  });

  it("M2: one name per pool on the page", () => {
    for (const word of ["Savings pool out", "Checking pool out", "savings pool", "checking pool"]) expect(html).toContain(word);
    for (const old of ["High yield savings", "Non-interest-bearing out", "non-interest-bearing $", "Savings and money market out"]) expect(html).not.toContain(old);
  });

  it("L6: a book whose hqla-stock positions carry no level says so and how to fix it", () => {
    const b = ladder();
    b.bufferDerivation = { ...b.bufferDerivation!, notCounted: [{ positionId: "x", familyId: "S", notional: 5 * M, reason: "no hqla-level tag" }] };
    const r2 = freshResult();
    r2.liquidityStress = b;
    const out = renderToStaticMarkup(<LiquidityTab ws="ws-a" {...props(r2)} />);
    expect(out).toContain("carry no HQLA level, so they count for nothing");
    expect(out).toContain("import version 1.3 again");
  });

  it("a typed path computes in the calculator from the run's severe row and buffer", () => {
    const out = renderToStaticMarkup(<SurvivalPathPanel block={ladder()} presets={[]} initial={{ kind: "stated" }} />);
    expect(out).toContain("Path inputs");
    expect(out).toContain("Survival on the path");
    expect(out).toContain('value="270"');
  });
});

describe("the Home card", () => {
  it("is one plain paragraph of 60 to 90 words, says where to look and one change, and what the page cannot show", () => {
    expect(SURVIVAL_PATH_CARDS.map((c) => c.id)).toEqual(["survival-path"]);
    const c = cardFor("survival-path")!;
    const n = wordCount(c.text);
    expect(n).toBeGreaterThanOrEqual(60);
    expect(n).toBeLessThanOrEqual(90);
    expect(c.text).toContain("Launch it, then open Results");
    expect(c.text).toContain("Change ");
    const all = c.text + c.title + c.look + c.notes.join(" ");
    expect([0x2014, 0x2013, 0xa7].map((x) => String.fromCharCode(x)).some((ch) => all.includes(ch))).toBe(false);
    expect(all).not.toMatch(/Chapter \d|Table \d|Figure \d/);
    expect(c.notes.join(" ")).toContain("cannot show");
    expect(c.notes.join(" ")).toContain("not a full LCR");
  });
});

describe("the setup editor's liquidity switches", () => {
  it("each switch adds its part and takes it away, and every state passes the engine's own check", () => {
    let s = withLiquidityStress(STANDARD_ALCO, true);
    expect(s.liquidityStress).toEqual(DEFAULT_LIQUIDITY_STRESS);
    s = withCdRenewal(s, true);
    expect([s.liquidityStress!.table.bau.cdRenewal, s.liquidityStress!.table.severe.cdRenewal]).toEqual([0.9, 0.3]);
    s = withBufferFromTags(s, true);
    expect("buffer" in s.liquidityStress!).toBe(false);
    s = withDials(s, true);
    // The dials carry no amount: they read the undrawn face as the amount undrawn now.
    expect(s.liquidityStress!.dials).toEqual(DIALS);
    s = withFacility(withSurvivalMonths(withSurvivalPath(s, true), 36), true);
    s = withFacilityField(s, "capacity", 500 * M);
    expect(s.liquidityStress!.survivalPath).toEqual({ horizonMonths: 36, facility: { label: "Borrowing capacity", capacity: 500 * M, haircut: 0.2 } });
    expect(liquidityStressConfigError(s.liquidityStress, "liquidityStress")).toBeUndefined();
    // Every switch back off returns the starting table, key for key.
    let off = withSurvivalPath(withDials(withBufferFromTags(withCdRenewal(s, false), false), false), false);
    expect(JSON.stringify(off.liquidityStress)).toBe(JSON.stringify(DEFAULT_LIQUIDITY_STRESS));
    off = withLiquidityStress(off, false);
    expect("liquidityStress" in off).toBe(false);
  });
});
