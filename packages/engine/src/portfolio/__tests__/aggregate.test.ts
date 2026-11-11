import { describe, it, expect } from "vitest";
import { FixedLoan, Mortgage, type Cashflow, type RatePath } from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { aggregateScenario, aggregatePortfolio, type ScenarioRatePath } from "../aggregate";
import type { BucketGrid } from "../../contracts/results";
import {
  AS_OF,
  fixedLoanTerms,
  fixedPosition,
  mortgageTerms,
  mortgagePosition,
  makePortfolio,
} from "./fixtures";

const HORIZON = 360;
const grid: BucketGrid = { horizonMonths: HORIZON, asOf: AS_OF };
const path = new ConstantRatePath(0.04, HORIZON);

/** Reference bucketing of a kernel Cashflow[] using the bucket = monthOffset - 1 rule. */
function bucketDirect(cfs: Cashflow[], horizon = HORIZON) {
  const balance = new Array(horizon).fill(0);
  const principal = new Array(horizon).fill(0);
  const interest = new Array(horizon).fill(0);
  for (const cf of cfs) {
    const b = cf.monthOffset - 1;
    if (b < 0 || b >= horizon) continue;
    balance[b] += cf.balance;
    principal[b] += cf.principalPaid;
    interest[b] += cf.interestPaid;
  }
  return { balance, principal, interest };
}

function sp(rp: RatePath, scenarioId = "base"): ScenarioRatePath {
  return { scenarioId, path: rp };
}

describe("aggregateScenario conservation", () => {
  it("summed principal for a level-pay fixed loan equals its opening balance", () => {
    const terms = fixedLoanTerms("fl", { notional: 1_000_000, maturityMonths: 60, coupon: 0.05, amortType: "level-pay" });
    const pf = makePortfolio([{ id: "fl", familyId: "FIXED", coaNodeId: "fixed-loans", terms }]);
    const res = aggregateScenario(pf, sp(path), grid);
    const fam = res.byFamily.find((f) => f.familyId === "FIXED")!;
    const totalPrincipal = fam.series.principal.reduce((s, x) => s + x, 0);
    expect(totalPrincipal).toBeCloseTo(1_000_000, 3);
  });

  it("summed principal for a bullet equals its opening balance", () => {
    const terms = fixedLoanTerms("bl", { notional: 500_000, maturityMonths: 24, amortType: "bullet" });
    const pf = makePortfolio([{ id: "bl", familyId: "FIXED", coaNodeId: "fixed-loans", terms }]);
    const res = aggregateScenario(pf, sp(path), grid);
    const fam = res.byFamily.find((f) => f.familyId === "FIXED")!;
    const totalPrincipal = fam.series.principal.reduce((s, x) => s + x, 0);
    expect(totalPrincipal).toBeCloseTo(500_000, 6);
  });

  it("balance at bucket 0 equals the opening balance of the book", () => {
    const pf = makePortfolio([fixedPosition("a", { notional: 700_000, maturityMonths: 120 })]);
    const res = aggregateScenario(pf, sp(path), grid);
    const fam = res.byFamily.find((f) => f.familyId === "FIXED")!;
    expect(fam.series.balance[0]).toBeCloseTo(700_000, 6);
  });
});

describe("aggregateScenario reproduces the kernel instrument (Lab cross-check)", () => {
  it("fixed loan: per-bucket principal and interest match kernel generateCashflows to 1e-6", () => {
    const terms = fixedLoanTerms("fl", { notional: 1_000_000, maturityMonths: 60, coupon: 0.05 });
    const pf = makePortfolio([{ id: "fl", familyId: "FIXED", coaNodeId: "fixed-loans", terms }]);
    const res = aggregateScenario(pf, sp(path), grid);
    const fam = res.byFamily.find((f) => f.familyId === "FIXED")!;

    const expected = bucketDirect(new FixedLoan(terms).generateCashflows(path));
    for (let k = 0; k < HORIZON; k++) {
      expect(Math.abs(fam.series.principal[k] - expected.principal[k])).toBeLessThan(1e-6);
      expect(Math.abs(fam.series.interest[k] - expected.interest[k])).toBeLessThan(1e-6);
      expect(Math.abs(fam.series.balance[k] - expected.balance[k])).toBeLessThan(1e-6);
    }
  });

  it("mortgage: per-bucket principal and interest match kernel generateCashflows to 1e-6", () => {
    const terms = mortgageTerms("mg");
    const pf = makePortfolio([{ id: "mg", familyId: "MORTGAGE", coaNodeId: "mortgages", terms }]);
    const res = aggregateScenario(pf, sp(path), grid);
    const fam = res.byFamily.find((f) => f.familyId === "MORTGAGE")!;

    const expected = bucketDirect(new Mortgage(terms).generateCashflows(path));
    for (let k = 0; k < HORIZON; k++) {
      expect(Math.abs(fam.series.principal[k] - expected.principal[k])).toBeLessThan(1e-6);
      expect(Math.abs(fam.series.interest[k] - expected.interest[k])).toBeLessThan(1e-6);
      expect(Math.abs(fam.series.balance[k] - expected.balance[k])).toBeLessThan(1e-6);
    }
  });

  it("a full-horizon (360-month) mortgage does not overflow the last bucket", () => {
    const terms = mortgageTerms("mg360", { maturityMonths: 360 });
    const pf = makePortfolio([{ id: "mg360", familyId: "MORTGAGE", coaNodeId: "mortgages", terms }]);
    expect(() => aggregateScenario(pf, sp(path), grid)).not.toThrow();
  });
});

describe("aggregateScenario multi-position and determinism", () => {
  it("a family series is the sum of its positions' cashflows", () => {
    const t1 = fixedLoanTerms("a", { notional: 1_000_000, maturityMonths: 60, coupon: 0.05 });
    const t2 = fixedLoanTerms("b", { notional: 250_000, maturityMonths: 36, coupon: 0.03 });
    const pf = makePortfolio([
      { id: "a", familyId: "FIXED", coaNodeId: "fixed-loans", terms: t1 },
      { id: "b", familyId: "FIXED", coaNodeId: "fixed-loans", terms: t2 },
    ]);
    const res = aggregateScenario(pf, sp(path), grid);
    const fam = res.byFamily.find((f) => f.familyId === "FIXED")!;

    const e1 = bucketDirect(new FixedLoan(t1).generateCashflows(path));
    const e2 = bucketDirect(new FixedLoan(t2).generateCashflows(path));
    for (let k = 0; k < HORIZON; k++) {
      expect(fam.series.principal[k]).toBeCloseTo(e1.principal[k] + e2.principal[k], 6);
    }
  });

  it("two runs of the same portfolio are byte-identical (JSON serialization)", () => {
    const pf = makePortfolio([fixedPosition("a"), mortgagePosition("m")]);
    const a = aggregateScenario(pf, sp(path), grid);
    const b = aggregateScenario(pf, sp(path), grid);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("families appear in declared order regardless of position order", () => {
    const pf = makePortfolio([mortgagePosition("m"), fixedPosition("a")]);
    const res = aggregateScenario(pf, sp(path), grid);
    expect(res.byFamily.map((f) => f.familyId)).toEqual(["FIXED", "MORTGAGE"]);
  });

  it("throws when a position references a family absent from the COA", () => {
    const pf = makePortfolio([{ id: "x", familyId: "GHOST", coaNodeId: "fixed-loans", terms: fixedLoanTerms("x") }]);
    expect(() => aggregateScenario(pf, sp(path), grid)).toThrow(/unknown family/i);
  });
});

describe("aggregatePortfolio over multiple scenarios", () => {
  it("emits one ScenarioCashflows per scenario in input order", () => {
    const pf = makePortfolio([fixedPosition("a")]);
    const res = aggregatePortfolio(pf, [sp(path, "base"), sp(new ConstantRatePath(0.06, HORIZON), "up200")], grid);
    expect(res.grid).toBe(grid);
    expect(res.byScenario.map((s) => s.scenarioId)).toEqual(["base", "up200"]);
  });
});
