/**
 * Studio A+E contract 24: ScenarioNII.newBusiness carries the
 * reinvestment sweep's origination notional, verbatim, on a scenario that ran
 * dynamic new business, and on no other. A static envelope stays byte-identical.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { baseAssumptions, loadMarket, twoSidedBook } from "./fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy, withBalanceStage } from "../../plan/__tests__/fixtures";
import { buildRunResult } from "../orchestrate";
import { resolveDefaultContext } from "../engine";
import type { RunPlan } from "../../contracts/plan";
import type { RunResult } from "../../contracts/run";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const STAMPS = { runId: "RUN-NB", seed: "42", timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" } };
const resolved = () => ({ portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES });

/** Compile the plan and run it through the pipeline, plan walked (balance stage live). */
function runPlan(plan: RunPlan): RunResult {
  const c = compilePlan(plan, resolved(), STAMPS);
  open.push(c.harness);
  return buildRunResult(c.request, twoSidedBook(), { ...resolveDefaultContext(), harness: c.harness, plan });
}

/** The fixture plan with the balance stage and one dynamic scenario ruling all four families flat. */
function allFamiliesFlat(): RunPlan {
  const plan = withBalanceStage(fixturePlan());
  plan.scenarios = [
    {
      id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE",
      newBusiness: {
        mode: "dynamic",
        rules: [
          { familyId: "FIXED", reinvest: "flat" },
          { familyId: "MORTGAGE", reinvest: "flat" },
          { familyId: "DDA", reinvest: "flat" },
          { familyId: "MMA", reinvest: "flat" },
        ],
      },
    },
  ];
  return plan;
}

describe("ScenarioNII.newBusiness", () => {
  it("a static run carries no newBusiness key on any scenario", () => {
    const r = runPlan(fixturePlan());
    expect(r.nii.byScenario.length).toBe(5);
    for (const s of r.nii.byScenario) expect("newBusiness" in s).toBe(false);
  });
  it("a dynamic run carries originations of grid length per ruled family, and month 1 is zero", () => {
    const r = runPlan(allFamiliesFlat());
    const s = r.nii.byScenario[0]!;
    expect(s.newBusiness!.map((f) => f.familyId).sort()).toEqual(["DDA", "FIXED", "MMA", "MORTGAGE"]);
    for (const f of s.newBusiness!) {
      expect(f.originations.length).toBe(r.cashflows.grid.horizonMonths);
      expect(f.originations[0]).toBe(0);                       // the sweep starts at bucket 1 (dynamicNewBusiness.ts)
      expect(f.originations.some((v) => v > 0)).toBe(true);    // a running-off family tops up somewhere
      for (const v of f.originations) expect(Number.isFinite(v) && v >= 0).toBe(true);
    }
  });
  it("FIXED's first two originations restate by hand from the flat identity", () => {
    // FIXED is one level-pay loan, 5,000,000 at 5 percent over 60 months, with no overlay bound.
    // Bucket k carries the balance at the start of month k + 1, so bucket 0 is 5,000,000. Flat holds
    // the family at that level: the top-up at bucket k is the target minus the running balance,
    // which is the book's month-k principal (the new-business tranche is a bullet and holds its
    // balance). Level pay: payment = P r (1 + r)^60 / ((1 + r)^60 - 1), r = 0.05 / 12, and month-m
    // principal = (payment - P r) (1 + r)^(m - 1).
    const P = 5_000_000;
    const r = 0.05 / 12;
    const payment = (P * r * Math.pow(1 + r, 60)) / (Math.pow(1 + r, 60) - 1);
    const p1 = payment - P * r;
    const p2 = p1 * (1 + r);
    const res = runPlan(allFamiliesFlat());
    const fixed = res.nii.byScenario[0]!.newBusiness!.find((f) => f.familyId === "FIXED")!;
    expect(fixed.originations[1]!).toBeCloseTo(p1, 6);
    expect(fixed.originations[2]!).toBeCloseTo(p2, 6);
    // The payment is 94,356.17 a month and month-1 interest 20,833.33, so p1 is 73,522.83.
    expect(p1).toBeCloseTo(73_522.83, 1);
  });
  it("a dynamic scenario with zero rules carries the key as an empty list, so absence always means static", () => {
    const plan = withBalanceStage(fixturePlan());
    plan.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "dynamic", rules: [] } },
    ];
    const r = runPlan(plan);
    expect(r.nii.byScenario[0]!.newBusiness).toEqual([]);
  });
  it("in a mixed envelope only the dynamic scenarios carry the key", () => {
    const plan = withBalanceStage(fixturePlan());
    plan.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" }, assumptionSetId: "AS-BASE", newBusiness: { mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "flat" }] } },
      { id: "S100", label: "S100", rateSpec: { kind: "parallel", shockBp: 100 }, assumptionSetId: "AS-BASE", newBusiness: { mode: "static", rules: [] } },
    ];
    const r = runPlan(plan);
    expect(r.nii.byScenario.find((s) => s.scenarioId === "S0")!.newBusiness!.map((f) => f.familyId)).toEqual(["FIXED"]);
    expect("newBusiness" in r.nii.byScenario.find((s) => s.scenarioId === "S100")!).toBe(false);
  });
});
