/**
 * The replicating-portfolio credit on a life that is not a straight-line runoff's, on hand
 * cases, and the rules around it (validation, the merge, the run's scenario check).
 *
 * The hand cases price on a flat curve, so every bullet rate is known in closed form by the test (a k-month bullet on
 * a flat continuously compounded zero z has the par rate 12 (e^(z/12) - 1), whatever k). The term liquidity premium is
 * sloped (fix round 1: a flat premium could not tell a leg read at the wrong tenor), so each premium is the test's own
 * par-match of a bullet on the all-in discount factors. Nothing is read back from the code under test.
 */
import { describe, expect, test } from "vitest";
import { buildTLPCurve, rehydrateCurve } from "@alm/kernel";
import type { ReplicatingPortfolioForm } from "../../contracts/position";
import { replicatingPortfolioIssues } from "../../contracts/paramSchema";
import { applyOverlayToTerms } from "../../projection/static/applyOverlays";
import type { Scenario } from "../../contracts/scenario";
import { checkReplicatingPortfolioRun, creditReadsShocks } from "../replicatingPortfolioRun";
import { RpPricer, scenarioCredit } from "../replicatingPortfolio";

const Z = 0.04;
/** The premium rises linearly from 10 bp at time 0 to 160 bp at 30 years. */
const P0 = 0.001;
const P30 = 0.016;
const flat = rehydrateCurve({ t: [0.5, 1, 5, 10, 30], z: [Z, Z, Z, Z, Z], convention: "semiannual_bond" });
const tlp = buildTLPCurve([
  { term: "ON", tYears: 0, spread: P0 },
  { term: "30Y", tYears: 30, spread: P30 },
] as never);
const par = (z: number) => 12 * (Math.exp(z / 12) - 1);
const spreadAt = (t: number) => P0 + ((P30 - P0) * t) / 30;
/** The test's own premium of a k-month bullet: its all-in par rate (monthly accrual on the balance) less par(Z). */
function premium(k: number): number {
  let annuity = 0;
  let last = 1;
  for (let m = 1; m <= k; m++) {
    const t = m / 12;
    last = Math.exp(-(Z + spreadAt(t)) * t);
    annuity += last / 12;
  }
  return (1 - last) / annuity - par(Z);
}
const p = new RpPricer(flat, tlp);

const grid = [1, 12, 24, 60];
const form = (over: Partial<ReplicatingPortfolioForm>): ReplicatingPortfolioForm => ({
  construction: "life-target",
  pillarGridMonths: grid,
  life: { source: "capped", months: 18 },
  scenarioCurve: "shift",
  ...over,
});

describe("the scenario credit on hand cases", () => {
  test("the flat curve prices every bullet at one rate; the sloped premium differs by tenor and matches the test's own par-match", () => {
    expect(p.bulletRate(1)).toBeCloseTo(par(Z), 12);
    expect(p.bulletRate(84)).toBeCloseTo(par(Z), 12);
    expect(p.bulletPremium(18)).toBeCloseTo(premium(18), 12);
    expect(p.bulletPremium(1)).toBeCloseTo(premium(1), 12);
    expect(premium(18) - premium(1)).toBeGreaterThan(5e-4);
  });

  test("life-target: beta overnight, the rest on the two pillars whose lives bracket 18 months, the whole balance at the premium", () => {
    const r = scenarioCredit({ scenarioId: "base", beta: 0.25, lifeMonths: 18 }, form({}), p);
    // Pillar lives (k + 1) / 2: 12 -> 6.5, 24 -> 12.5, 60 -> 30.5; 18 sits between 24 and 60, w60 = (18 - 12.5) / 18.
    expect(r.tranches.map((t) => [t.kind, t.months])).toEqual([["overnight", 1], ["pillar", 24], ["pillar", 60]]);
    expect(r.tranches[2]!.weight).toBeCloseTo(0.75 * (5.5 / 18), 14);
    expect(r.tranches.reduce((s, t) => s + t.weight, 0)).toBeCloseTo(1, 14);
    expect(r.liquidityLegs.map((l) => [l.months, l.weight])).toEqual([[18, 1]]);
    expect(r.liquidityCredit).toBeCloseTo(premium(18), 12);
    expect(r.totalCredit).toBeCloseTo(par(Z) + premium(18), 12);
  });

  test("static-share: s (1 - beta) on the pillars, the rest overnight; liquidity s at the life and (1 - s) at one month", () => {
    const r = scenarioCredit({ scenarioId: "base", beta: 0.5, lifeMonths: 18, staticShare: 0.4 }, form({ construction: "static-share", life: { source: "balance-path" } }), p);
    expect(r.tranches[0]).toMatchObject({ kind: "overnight", weight: 0.5 + 0.6 * 0.5 });
    expect(r.tranches.slice(1).reduce((s, t) => s + t.weight, 0)).toBeCloseTo(0.4 * 0.5, 14);
    expect(r.liquidityLegs.map((l) => [l.months, l.weight])).toEqual([[18, 0.4], [1, 0.6]]);
    expect(r.liquidityCredit).toBeCloseTo(0.4 * premium(18) + 0.6 * premium(1), 12);
    // A leg read at another tenor (the remainder at three months, or the share at the 24-month pillar) would miss.
    expect(Math.abs(r.liquidityCredit - (0.4 * premium(18) + 0.6 * premium(3)))).toBeGreaterThan(1e-5);
    expect(Math.abs(r.liquidityCredit - (0.4 * premium(24) + 0.6 * premium(1)))).toBeGreaterThan(1e-5);
  });

  test("a paid rate rides through; a beta outside [0, 1] and a missing static share refuse", () => {
    expect(scenarioCredit({ scenarioId: "s", beta: 0.1, lifeMonths: 20, paidRate: 0.005 }, form({}), p).paidRate).toBe(0.005);
    expect(() => scenarioCredit({ scenarioId: "s", beta: 1.2, lifeMonths: 20 }, form({}), p)).toThrow(/beta share must be a fraction/);
    expect(() => scenarioCredit({ scenarioId: "s", beta: 0.1, lifeMonths: 18 }, form({ construction: "static-share", life: { source: "balance-path" } }), p)).toThrow(/static share/);
  });
});

describe("the rules around it", () => {
  test("validation: static-share needs the balance path; the strip, the haircut and the steepener refuse a life; scenarioCurve needs a life", () => {
    expect(replicatingPortfolioIssues(form({}))).toEqual([]);
    expect(replicatingPortfolioIssues(form({ construction: "static-share" })).map((i) => i.path)).toContain("replicatingPortfolio.life");
    expect(replicatingPortfolioIssues({ construction: "strip", life: { source: "balance-path" } }).map((i) => i.path)).toContain("replicatingPortfolio.life");
    expect(replicatingPortfolioIssues({ construction: "pillar", pillarMonths: 60, scenarioCurve: "shift" }).map((i) => i.path)).toContain("replicatingPortfolio.scenarioCurve");
    expect(replicatingPortfolioIssues(form({ life: { source: "capped", months: 0 } })).map((i) => i.path)).toContain("replicatingPortfolio.life.months");
    expect(replicatingPortfolioIssues(form({ beta: { source: "fixed", value: 1.5 } })).map((i) => i.path)).toContain("replicatingPortfolio.beta.value");
  });

  test("the merge: a deposit-beta credit needs the full form and a capped life", () => {
    const nmdb = { id: "d", type: "nmd-b", notional: 1, maturityMonths: 12, originationOffsetMonths: 0, amortType: "bullet", side: "liability", sCurve: { betaMin: 0, betaMax: 0.5, k: 1, m: 3, lambda: 0.5 } } as never;
    const sCurve = { betaMin: 0, betaMax: 0.5, k: 1, m: 3, lambda: 0.5 };
    expect(() => applyOverlayToTerms(nmdb, { kind: "deposit-beta", params: sCurve, replicatingPortfolio: form({}) } as never, "d")).toThrow(/full beta form/);
    const fullForm = { alphaPct: 0.1, deltaUp: 0, deltaDown: 0, volRatio: 1, baseShortRatePct: 3, baseLastMove: "rise", balances: "flat" };
    expect(() => applyOverlayToTerms(nmdb, { kind: "deposit-beta", params: sCurve, fullForm, replicatingPortfolio: form({ life: { source: "balance-path" } }) } as never, "d")).toThrow(/capped life/);
    const merged = applyOverlayToTerms(nmdb, { kind: "deposit-beta", params: sCurve, fullForm, replicatingPortfolio: form({}) } as never, "d") as { replicatingPortfolio?: unknown; fullBeta?: unknown };
    expect(merged.replicatingPortfolio).toEqual(form({}));
    expect(merged.fullBeta).toEqual(fullForm);
  });

  test("the run: a credit that says how it reads a shock takes parallel scenarios; one that does not keeps the base-only refusal", () => {
    const sc = (id: string, rateSpec: Scenario["rateSpec"]): Scenario => ({ id, label: id, rateSpec, assumptionSetId: "s", newBusiness: { mode: "static", rules: [] } }) as Scenario;
    const slate = [sc("base", { kind: "base" }), sc("up", { kind: "parallel", shockBp: 200 })];
    expect(creditReadsShocks([form({})])).toBe(true);
    expect(() => checkReplicatingPortfolioRun(slate, {}, [form({})])).not.toThrow();
    const baseOnly: ReplicatingPortfolioForm = { construction: "life-target", pillarGridMonths: grid };
    expect(() => checkReplicatingPortfolioRun(slate, {}, [baseOnly])).toThrow(/scenario "up" shifts the curve, so run the base slate/);
    expect(() => checkReplicatingPortfolioRun(slate, {}, [form({}), baseOnly])).toThrow(/run the base slate/);
    expect(() => checkReplicatingPortfolioRun([sc("tw", { kind: "twist", shortBp: 100, longBp: -100, pivotYears: 2 } as never)], {}, [form({})])).toThrow(/parallel shocks on the deterministic path only/);
  });
});
