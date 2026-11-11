/**
 * The SEG knobs and the cohort-0 prepayment overlay, unit level.
 *
 * The overlay walk is the kernel loop restated with one change, so with cohort 0 and the vintage parent the same
 * instrument it must equal the kernel's runStaticBalanceScenario bit for bit.
 */
import { describe, expect, it } from "vitest";
import {
  MORTGAGE_DEFAULTS,
  Mortgage,
  ShockedPath,
  StochasticRatePath,
  runStaticBalanceScenario,
  type MortgageTerms,
} from "@alm/kernel";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { PortfolioSpec } from "../../contracts/position";
import { SEG_DEFAULTS, computeSegBlock } from "../computeSeg";
import { flatCprParams, mortgageAtFlatCpr, runStaticBalanceSplit } from "../cprOverlay";
import { segConstants, segCprOverlayBookError, segSettingsConfigError, segSettingsOf } from "../settings";

const N = 100_000_000;

function panelAMortgage(): Mortgage {
  const terms: MortgageTerms = {
    ...MORTGAGE_DEFAULTS,
    id: "m",
    notional: N,
    originalBalance: N,
    originalTermMonths: 360,
    maturityMonths: 360,
    ageMonths: 0,
    noteRate: 0.06,
    cprParams: flatCprParams({ ...MORTGAGE_DEFAULTS.cprParams, secSpread: 70, primSpread: 130 }, 0.1),
  };
  return new Mortgage(terms);
}

function coa(): ChartOfAccounts {
  return {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "mortgages", label: "Mortgages", parentId: "assets", side: "asset", isLeaf: true, familyId: "MORTGAGE", order: 0 },
      { id: "loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "FIXED", order: 1 },
    ],
    families: [
      { id: "MORTGAGE", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "mortgages" },
      { id: "FIXED", label: "Fixed loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "loans" },
    ],
  };
}

describe("segSettingsConfigError", () => {
  it("accepts a full settings object and an empty object", () => {
    expect(segSettingsConfigError({}, "s")).toBeUndefined();
    expect(
      segSettingsConfigError({ shockBp: 25, horizonMonths: 720, niiShockBp: 25, cprOverlay: [{ familyId: "M", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] }, "s"),
    ).toBeUndefined();
  });

  it("refuses each malformed field by name", () => {
    expect(segSettingsConfigError(null, "s")).toMatch(/^s must be an object/);
    expect(segSettingsConfigError({ shock: 25 }, "s")).toMatch(/^s\.shock is not a SEG setting/);
    expect(segSettingsConfigError({ shockBp: 0 }, "s")).toMatch(/^s\.shockBp must be/);
    expect(segSettingsConfigError({ shockBp: 201 }, "s")).toMatch(/^s\.shockBp must be/);
    expect(segSettingsConfigError({ niiShockBp: -25 }, "s")).toMatch(/^s\.niiShockBp must be/);
    expect(segSettingsConfigError({ horizonMonths: 60.5 }, "s")).toMatch(/^s\.horizonMonths must be a whole number/);
    expect(segSettingsConfigError({ horizonMonths: 721 }, "s")).toMatch(/^s\.horizonMonths must be a whole number/);
    expect(segSettingsConfigError({ cprOverlay: [] }, "s")).toMatch(/^s\.cprOverlay must be a non-empty array/);
    expect(segSettingsConfigError({ cprOverlay: [{ familyId: "M", upAnnualCpr: 9, downAnnualCpr: 0.14 }] }, "s")).toMatch(/upAnnualCpr must be a decimal/);
    expect(
      segSettingsConfigError({ cprOverlay: [{ familyId: "M", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }, { familyId: "M", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] }, "s"),
    ).toMatch(/appears twice/);
  });

  it("copies the known keys only", () => {
    const raw = { shockBp: 25, cprOverlay: [{ familyId: "M", upAnnualCpr: 0.09, downAnnualCpr: 0.14, extra: 1 }] };
    expect(segSettingsOf(raw as never)).toEqual({ shockBp: 25, cprOverlay: [{ familyId: "M", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] });
  });

  it("takes SEG_DEFAULTS where a setting is absent", () => {
    expect(segConstants(undefined)).toEqual({ ...SEG_DEFAULTS });
    expect(segConstants({})).toEqual({ ...SEG_DEFAULTS });
    expect(segConstants({ shockBp: 25, horizonMonths: 720 })).toEqual({ ...SEG_DEFAULTS, shockBp: 25, horizonMonths: 720 });
  });

  it("refuses an overlay family the chart does not declare as a mortgage family", () => {
    const row = (familyId: string) => ({ cprOverlay: [{ familyId, upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] });
    expect(segCprOverlayBookError(row("MORTGAGE"), coa(), "s")).toBeUndefined();
    expect(segCprOverlayBookError(row("NOPE"), coa(), "s")).toMatch(/does not declare/);
    expect(segCprOverlayBookError(row("FIXED"), coa(), "s")).toMatch(/a fixed-loan family/);
  });
});

describe("the cohort-0 overlay walk", () => {
  const flat = new StochasticRatePath(new Array<number>(400).fill(0.04));

  it("a flat CPR prepays the target every month (SMM from the kernel cash flows)", () => {
    const m = mortgageAtFlatCpr(panelAMortgage(), 0.14);
    const cf = m.generateCashflows(flat);
    for (const i of [0, 11, 59, 200]) {
      const c = cf[i]!;
      const rate = c.couponRate / 12;
      const left = 360 - i;
      const sched = (c.balance * rate) / (1 - Math.pow(1 + rate, -left)) - c.balance * rate;
      const smm = (c.principalPaid - sched) / (c.balance - sched);
      expect(1 - Math.pow(1 - smm, 12)).toBeCloseTo(0.14, 12);
    }
  });

  it("with cohort 0 and the vintage parent the same instrument it is the kernel walk, bit for bit", () => {
    const inst = panelAMortgage();
    const up = new ShockedPath(flat, 25);
    const a = runStaticBalanceSplit(inst, inst, up, up, flat, 121);
    const b = runStaticBalanceScenario(inst, up, up, flat, 121);
    expect(Array.from(a.totalInterest)).toEqual(Array.from(b.totalInterest));
    expect(Array.from(a.totalBalance)).toEqual(Array.from(b.totalBalance));
    expect(a.vintages.length).toBe(b.vintages.length);
  });

  it("a 6% mortgage at a flat 10% CPR with the cohort-0 overlay through computeSegBlock: Outstanding SEG equals the EBP", () => {
    const inst = panelAMortgage();
    const book: PortfolioSpec = {
      id: "PF",
      label: "Overlay mortgage",
      asOf: "2026-03-31",
      coa: coa(),
      positions: [{ id: "m", familyId: "MORTGAGE", coaNodeId: "mortgages", terms: inst.terms }],
    };
    const { perPosition } = computeSegBlock({
      book,
      basePath: new StochasticRatePath(new Array<number>(721).fill(0.04)),
      scenarioId: "S0",
      horizonMonths: 720,
      niiHorizonMonths: 12,
      shockBp: 25,
      niiShockBp: 200,
      makeInstrument: (q) => new Mortgage(q.terms as MortgageTerms),
      cprOverlay: new Map([["MORTGAGE", { upAnnualCpr: 0.09, downAnnualCpr: 0.14 }]]),
    });
    const row = perPosition.get("m")!;
    // Opening at the notional, run off by month 360, and the two series apart by under a dollar every month.
    expect(row.segOutstanding[0]).toBe(N);
    expect(Math.abs(row.segOutstanding[360]!)).toBeLessThan(1);
    let worst = 0;
    for (let t = 1; t <= 360; t++) worst = Math.max(worst, Math.abs(row.segOutstanding[t]! - row.ebp[t]!));
    expect(worst).toBeLessThan(1);
  });
});
