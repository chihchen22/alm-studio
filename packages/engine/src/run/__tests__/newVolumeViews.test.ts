/**
 * The two opt-in views of new volume, the forecast gap arm and going-concern EVE.
 *
 *  (d) Forecast gap: on a small book worked by hand, each bucket is the contractual gap plus the new-volume tranches'
 *      cash flows (principal and repricing from the month each is made, its funding as negative principal in the
 *      bucket of the runoff it replaces, fix round M1); a flat plan nets each runoff in its own bucket, the first band
 *      of a whole run included; the default ladders are byte-equal with the arm and without it.
 *  (e) Going-concern EVE less run-off EVE is the PV of the new-volume tranches' net cash flows on the same discount
 *      basis, each over its full life, checked by hand; on the all-in basis a matched product is worth zero on the
 *      sloped premium it was priced on and +30 bp is worth the PV of 30 bp (fix round M2); the default span is the NII
 *      window (fix round M4); run-off EVE is byte-equal with the opt-in and without it.
 *
 * Expected values are written out here from the cash flows and the discount factors, never read back from the code
 * under test.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FixedLoan, type MarketSnapshot, type RatePath, type TLPCurve, type ZeroCurve } from "@alm/kernel";
import type { NewVolumeTemplateSpec, RunPlan } from "../../contracts/plan";
import type { PortfolioSpec } from "../../contracts/position";
import type { EVEResult } from "../../contracts/results";
import type { RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { computeGoingConcernEve } from "../../eve/goingConcern";
import { computeForecastGap } from "../../gap/forecastGap";
import { createFamilySeries } from "../../gap/gapEngine";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy, withBalanceStage } from "../../plan/__tests__/fixtures";
import { ForwardStartPath } from "../../projection/dynamic/forwardStart";
import { templateTranche } from "../../projection/dynamic/templateTranche";
import type { SweptTranche } from "../../projection/dynamic";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import { AS_OF, baseAssumptions, fixedPosition, loadMarket, makeCoa, twoSidedBook } from "./fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";

const H = 12;
const flatPath: RatePath = { nSteps: 400, times: Array.from({ length: 401 }, (_, i) => i / 12), rateAt: () => 0.03, forwardRateAt: () => 0.03 };

/** A fixed bullet tranche of the FIXED family (an asset) minted at bucket k, coupon c, term T. */
function bullet(k: number, notional: number, c: number, T: number, familyId = "FIXED"): SweptTranche {
  const instrument = new FixedLoan({ id: `t${k}`, type: "fixed-loan", notional, maturityMonths: T, originationOffsetMonths: 0, amortType: "bullet", coupon: c });
  return { familyId, bucket: k, notional, instrument, path: new ForwardStartPath(flatPath, k) };
}

describe("(d) the forecast gap arm on a small book, by hand", () => {
  const book: PortfolioSpec = { id: "PF-D", label: "d", asOf: AS_OF, coa: makeCoa(), positions: [fixedPosition("F1", { notional: 1000, maturityMonths: 3, amortType: "bullet", coupon: 0.05 })] };

  it("each bucket is the contractual gap plus the tranches' cash flows, the funding in the bucket of the runoff it replaces", () => {
    // Contractual: the opening 1,000 repays in bucket 2 (month 3). A growing plan replaces it with 2-month bullets of
    // 1,100 at k = 3, 1,150 at 5, 1,200 at 7, 1,250 at 9 and 1,300 at 11; each repays in bucket k + 1, and the one made at
    // 11 repays in bucket 12, past the 12-month grid. Fix round M1: each is funded in bucket k - 1, where the runoff it
    // replaces lands (time k / 12).
    const series = createFamilySeries(book, H);
    series.principal[0]![2] = 1000;
    series.repricing[0]![2] = 1000;
    const sizes: Array<[number, number]> = [[3, 1100], [5, 1150], [7, 1200], [9, 1250], [11, 1300]];
    const tranches = sizes.map(([k, n]) => bullet(k, n, 0.04, 2));
    const got = computeForecastGap([{ id: "S0" }], new Map([["S0", { series, book }]]), new Map([["S0", tranches]]), H, { repricing: { kind: "monthly" }, liquidity: { kind: "monthly" } });
    // Liquidity by hand: bucket 2, 1,000 back - 1,100 lent = -100; bucket 4, 1,100 back - 1,150 lent = -50; and so on.
    const liq = [0, 0, 1000 - 1100, 0, 1100 - 1150, 0, 1150 - 1200, 0, 1200 - 1250, 0, 1250 - 1300, 0];
    // Repricing: the opening book at bucket 2, then each tranche when it repays (k + 1); making one is not repricing.
    const rep = [0, 0, 1000, 0, 1100, 0, 1150, 0, 1200, 0, 1250, 0];
    expect(got.liquidity[0]!.userBuckets!.rows.map((r) => r.assets)).toEqual(liq);
    expect(got.repricing[0]!.userBuckets!.rows.map((r) => r.assets)).toEqual(rep);
    expect(got.liquidity[0]!.userBuckets!.rows.every((r) => r.liabilities === 0)).toBe(true);
    // The contractual series it started from is left as it was.
    expect(Array.from(series.principal[0]!)).toEqual([0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("a flat plan nets each replaced runoff in its own bucket", () => {
    const series = createFamilySeries(book, H);
    series.principal[0]![2] = 1000;
    const tranches = [3, 5, 7, 9, 11].map((k) => bullet(k, 1000, 0.04, 2));
    const got = computeForecastGap([{ id: "S0" }], new Map([["S0", { series, book }]]), new Map([["S0", tranches]]), H, { liquidity: { kind: "monthly" } });
    // Every runoff is lent again the month it comes back: by hand the ladder is zero in every month.
    expect(got.liquidity[0]!.userBuckets!.rows.map((r) => r.assets)).toEqual(new Array(H).fill(0));
  });

  it("a liability tranche books its funding as an inflow and its repayment as an outflow", () => {
    const series = createFamilySeries(book, H);
    const t = bullet(4, 500, 0.03, 3, "DDA");
    const got = computeForecastGap([{ id: "S0" }], new Map([["S0", { series, book }]]), new Map([["S0", [t]]]), H, { liquidity: { kind: "monthly" } });
    const rows = got.liquidity[0]!.userBuckets!.rows;
    // Liability principal: -500 at bucket 3 (cash taken in when the runoff it replaces left), +500 at bucket 6 (repaid).
    expect(rows.map((r) => r.liabilities)).toEqual([0, 0, 0, -500, 0, 0, 500, 0, 0, 0, 0, 0]);
    expect(rows[3]!.gap).toBe(500);
    expect(rows[6]!.gap).toBe(-500);
  });
});

describe("(e) going-concern EVE less run-off EVE is the PV of the tranches' net cash flows", () => {
  const df = (t: number): number => Math.exp(-0.04 * t);
  const curve = { discountFactor: df } as unknown as ZeroCurve;
  const tlp = { tlp: () => 0.01 } as unknown as TLPCurve;
  const scenarios: Scenario[] = [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "dynamic", rules: [] } }];
  const eve = { discountBasis: "risk-free", byScenario: [{ scenarioId: "S0", pvAssets: 0, pvLiabilities: 0, eve: 12_345, deltaEveVsBase: 0, deltaEvePct: 0, byFamily: [] }] } as unknown as EVEResult;
  const ALL = { months: 360 };

  it("an asset bullet and a liability bullet, by hand on the risk-free curve, each over its full life", () => {
    // Asset: 1,000 at k = 4, 3-month bullet at 6%: interest 5 a month, principal at month 3.
    // Liability: 400 at k = 10, 360-month bullet at 2%, running past any grid: valued over all 360 months.
    const a = bullet(4, 1000, 0.06, 3);
    const l = bullet(10, 400, 0.02, 360, "MMA");
    let pvA = 0;
    for (let m = 1; m <= 3; m++) pvA += df((4 + m) / 12) * (5 + (m === 3 ? 1000 : 0));
    const valueA = pvA - 1000 * df(4 / 12);
    let pvL = 0;
    for (let m = 1; m <= 360; m++) pvL += df((10 + m) / 12) * (400 * 0.02 / 12 + (m === 360 ? 400 : 0));
    const valueL = 400 * df(10 / 12) - pvL;
    const got = computeGoingConcernEve({ eve, coa: makeCoa(), positions: [], scenarios, tranchesByScenario: new Map([["S0", [a, l]]]), baseCurve: curve, tlp, span: ALL });
    const row = got.byScenario[0]!;
    expect(row.runoffEve).toBe(12_345);
    expect(Math.abs(row.newVolumeValue - (valueA + valueL))).toBeLessThan(1e-9);
    expect(Math.abs(row.eve - 12_345 - (valueA + valueL))).toBeLessThan(1e-9);
    expect(row.byFamily.map((f) => f.familyId)).toEqual(["FIXED", "MMA"]);
    // A 6% asset funded at 4% is worth more than nothing; a 2% deposit taken at 4% saves the bank value.
    expect(valueA).toBeGreaterThan(0);
    expect(valueL).toBeGreaterThan(0);
    expect(got.note).toMatch(/regulatory measure is run-off EVE/);
    expect(got.span).toEqual(ALL);
  });

  /** A tranche's net value on the risk-free curve, written out: interest each month, notional at maturity, funded at k / 12. */
  const hand = (k: number, n: number, c: number, T: number): number => {
    let pv = 0;
    for (let m = 1; m <= T; m++) pv += df((k + m) / 12) * ((n * c) / 12 + (m === T ? n : 0));
    return pv - n * df(k / 12);
  };

  it("a 6-month span counts the tranches made at k = 1 .. 6: k = 6 in, k = 7 out, each over its full life", () => {
    // A tranche at bucket k replaces month k's runoff and is funded at the end of month k, so month 6's is k = 6.
    const ts = [bullet(4, 1000, 0.06, 3), bullet(6, 700, 0.045, 12), bullet(7, 650, 0.05, 6), bullet(10, 400, 0.02, 360, "MMA")];
    const got = computeGoingConcernEve({ eve, coa: makeCoa(), positions: [], scenarios, tranchesByScenario: new Map([["S0", ts]]), baseCurve: curve, tlp, span: { months: 6 } });
    const row = got.byScenario[0]!;
    expect(row.byFamily).toEqual([{ familyId: "FIXED", trancheCount: 2, notional: 1700, value: row.newVolumeValue }]);
    expect(Math.abs(row.newVolumeValue - (hand(4, 1000, 0.06, 3) + hand(6, 700, 0.045, 12)))).toBeLessThan(1e-9);
    expect(got.note).toMatch(/new volume made in the first 6 months/);
  });

  it("ruling: a 12-month span counts the tranches made at k = 1 .. 12, by hand: k = 12 in, k = 13 out", () => {
    // Asset bullets made at k = 4, 11, 12, 13 and 30: the first three are made in the first 12 months, the others are not.
    const ts = [bullet(4, 1000, 0.06, 3), bullet(11, 500, 0.05, 24), bullet(12, 800, 0.07, 6), bullet(13, 600, 0.04, 9), bullet(30, 900, 0.03, 12)];
    const want = hand(4, 1000, 0.06, 3) + hand(11, 500, 0.05, 24) + hand(12, 800, 0.07, 6);
    const got = computeGoingConcernEve({ eve, coa: makeCoa(), positions: [], scenarios, tranchesByScenario: new Map([["S0", ts]]), baseCurve: curve, tlp, span: { months: 12 } });
    const row = got.byScenario[0]!;
    expect(row.byFamily).toEqual([{ familyId: "FIXED", trancheCount: 3, notional: 2300, value: row.newVolumeValue }]);
    expect(Math.abs(row.newVolumeValue - want)).toBeLessThan(1e-9);
    expect(Math.abs(row.eve - row.runoffEve - want)).toBeLessThan(1e-9);
    expect(got.span).toEqual({ months: 12 });
    expect(got.note).toMatch(/new volume made in the first 12 months/);
  });
});

describe("(e, fix round M2) on the all-in basis a matched product is worth zero on the curve it was priced on", () => {
  // A rising one-month path and a SLOPED liquidity premium (20 bp at 0, rising 8 bp a year: 60 bp at 5 years, 260 bp
  // at 30 years), so spot and forward premia differ; a flat premium would hide the question.
  const r = (s: number): number => 0.03 + 0.0001 * s;
  const path: RatePath = { nSteps: 800, times: Array.from({ length: 801 }, (_, i) => i / 12), rateAt: r, forwardRateAt: () => 0.035 };
  const tlpOf = (t: number): number => 0.002 + 0.0008 * t;
  const tlp = { tlp: tlpOf } as unknown as TLPCurve;
  const P = (t: number): number => Math.exp(-0.032 * t);
  const curve = { discountFactor: P } as unknown as ZeroCurve;
  const scenarios: Scenario[] = [{ id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "AS", newBusiness: { mode: "dynamic", rules: [] } }];
  const eveOf = (basis: string) => ({ discountBasis: basis, byScenario: [{ scenarioId: "S0", pvAssets: 0, pvLiabilities: 0, eve: 0, deltaEveVsBase: 0, deltaEvePct: 0, byFamily: [] }] }) as unknown as EVEResult;
  const FAM = { id: "FIXED", label: "Fixed Loans", side: "asset" as const };
  const swept = (k: number, term: number, spreadBp: number, amortization: "bullet" | "level-pay"): SweptTranche => {
    const t = templateTranche(FAM, k, 100, term, spreadBp, { rateType: "fixed", amortization, indexTenorMonths: term, fixedIndex: "matched" }, path, tlp);
    return { familyId: "FIXED", bucket: k, notional: 100, instrument: t.instrument, path: t.path };
  };
  const value = (t: SweptTranche, basis: string): number =>
    computeGoingConcernEve({ eve: eveOf(basis), coa: makeCoa(), positions: [], scenarios, tranchesByScenario: new Map([["S0", [t]]]), baseCurve: curve, tlp, span: { months: 360 } }).byScenario[0]!.newVolumeValue;
  /** The all-in discount factor of month m of a tranche made at k, written out: the path's one-month rates from k, the premium from origination. */
  const dfAtOrigination = (k: number, m: number): number => {
    let D = 1;
    for (let j = 0; j < m; j++) D /= 1 + r(k + j) / 12;
    return D * Math.exp(-tlpOf(m / 12) * (m / 12));
  };
  const backToT0 = (k: number): number => P(k / 12) * Math.exp(-tlpOf(k / 12) * (k / 12));

  it("a matched 0 bp 5-year bullet made at month 60 and a matched 0 bp 360-month level-pay made at month 24 are worth 0", () => {
    const v1 = value(swept(60, 60, 0, "bullet"), "all-in");
    const v2 = value(swept(24, 360, 0, "level-pay"), "all-in");
    expect(Math.abs(v1)).toBeLessThan(1e-9);
    expect(Math.abs(v2)).toBeLessThan(1e-9);
    // Under the old construction (the premium read from t0) the 5-year bullet made at month 60 was worth this much:
    const t = swept(60, 60, 0, "bullet");
    let old = 0;
    for (const cf of t.instrument.generateCashflows(t.path)) old += P((60 + cf.monthOffset) / 12) * Math.exp(-tlpOf((60 + cf.monthOffset) / 12) * (60 + cf.monthOffset) / 12) * (cf.principalPaid + cf.interestPaid);
    old -= 100 * backToT0(60);
    expect(Math.abs(old)).toBeGreaterThan(0.1);
    console.log(`M2 values per 100: 5y bullet at k = 60 ${v1.toExponential(3)}; 360-month level-pay at k = 24 ${v2.toExponential(3)}; the old t0-premium value of the bullet ${old.toFixed(4)}`);
  });

  it("a +30 bp 360-month level-pay made at month 24 is worth the PV of its 30 bp, by hand", () => {
    const t = swept(24, 360, 30, "level-pay");
    let pv30 = 0;
    for (const cf of t.instrument.generateCashflows(t.path)) pv30 += dfAtOrigination(24, cf.monthOffset) * cf.balance * 0.003 / 12;
    const hand = backToT0(24) * pv30;
    const got = value(t, "all-in");
    expect(Math.abs(got - hand)).toBeLessThan(1e-9);
    expect(hand).toBeGreaterThan(1);
    console.log(`M2 +30 bp value per 100: ${got.toFixed(9)} (hand ${hand.toFixed(9)})`);
  });

  it("on the risk-free basis today's construction stands: a matched loan shows the premium it earns as value", () => {
    expect(value(swept(24, 360, 0, "level-pay"), "risk-free")).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Whole runs: the default blocks are byte-equal with the opt-ins and without them
// ---------------------------------------------------------------------------

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const STAMPS = { runId: "RUN-VIEWS", seed: "42", timestamps: { startedAt: "2026-11-03T00:00:00.000Z", finishedAt: "2026-11-03T00:00:01.000Z" } };

const BEHAVIORAL: NewVolumeTemplateSpec[] = [
  { familyId: "MORTGAGE", rateType: "fixed", amortization: "level-pay", indexTenorMonths: 360, fixedIndex: "matched", behavior: "family", termMonths: 360, spreadOverIndexBp: 25 },
  { familyId: "MMA", rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family", termMonths: 360, spreadOverIndexBp: 0 },
  { familyId: "DDA", rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family", termMonths: 360, spreadOverIndexBp: 0 },
];

function run(views: { forecastGap?: boolean; goingConcernEve?: boolean; goingConcernSpan?: number; windowMonths?: number }, templates = BEHAVIORAL, basis: "flat" | "runoff" = "flat"): RunResult {
  const base = withBalanceStage(fixturePlan());
  const withFtp: RunPlan = { ...base, stages: [...base.stages, { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-term", "st-nii"] }] };
  const plan: RunPlan = basis === "flat" ? { ...withFtp, balanceBasis: { kind: "flat" }, newVolumeTemplates: templates } : withFtp;
  const c = compilePlan(plan, { portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES }, STAMPS);
  open.push(c.harness);
  return buildRunResult(c.request, twoSidedBook(), { ...resolveDefaultContext(), discountBasis: "risk-free", gapBuckets: { kind: "monthly" }, liquidityBuckets: { kind: "monthly" }, harness: c.harness, plan, planRunLog: c.runLog, profileHash: c.profileHash, ...views });
}

describe("the opt-ins move no default number", () => {
  it("run-off EVE, both contractual ladders and every other block are byte-equal with the opt-ins and without", () => {
    const plain = run({});
    const both = run({ forecastGap: true, goingConcernEve: true });
    expect(plain.eve.goingConcern).toBeUndefined();
    expect(plain.gap.forecast).toBeUndefined();
    const { goingConcern, ...eve } = both.eve;
    const { forecast, ...gap } = both.gap;
    expect(JSON.stringify(eve)).toBe(JSON.stringify(plain.eve));
    expect(JSON.stringify(gap)).toBe(JSON.stringify(plain.gap));
    expect(JSON.stringify({ ...both, eve: plain.eve, gap: plain.gap })).toBe(JSON.stringify(plain));
    // Ruling 2026-11-03: the default span is 12 months on a 60-month NII window; only tranches made in it count.
    expect(goingConcern!.span).toEqual({ months: 12 });
    expect(goingConcern!.note).toMatch(/new volume made in the first 12 months/);
    // Going concern: run-off plus the new volume's value in every scenario, the value the sum of its families'.
    for (const g of goingConcern!.byScenario) {
      const ro = plain.eve.byScenario.find((s) => s.scenarioId === g.scenarioId)!;
      expect(g.runoffEve).toBe(ro.eve);
      expect(g.eve).toBe(ro.eve + g.newVolumeValue);
      expect(Math.abs(g.newVolumeValue - g.byFamily.reduce((a, f) => a + f.value, 0))).toBeLessThan(1e-6);
      // Every ruled family, the one on today's fixed bullet (FIXED, no template) included; no family made more than
      // one tranche a month in the window.
      expect(g.byFamily.map((f) => f.familyId)).toEqual(["FIXED", "MORTGAGE", "DDA", "MMA"]);
      // k = 1 .. 12: at most 12 tranches per family in a 12-month span (one a month).
      expect(g.byFamily.every((f) => f.trancheCount <= 12)).toBe(true);
    }
    expect(goingConcern!.byScenario.find((g) => g.scenarioId === "S0")!.deltaEveVsBase).toBe(0);
    // The forecast arm differs from the contractual ladders by the new volume, and only there.
    expect(forecast!.repricing).toHaveLength(plain.gap.repricing.length);
    expect(JSON.stringify(forecast!.liquidity[0]!.rows)).not.toBe(JSON.stringify(plain.gap.liquidity[0]!.rows));
  }, 300_000);

  it("ruling: the span extends to the NII window (60 here), never past it; a 6-month window gives a 6-month span", () => {
    const first = run({ goingConcernEve: true }).eve.goingConcern!;
    const whole = run({ goingConcernEve: true, goingConcernSpan: 60 }).eve.goingConcern!;
    expect(whole.span).toEqual({ months: 60 });
    expect(whole.note).toMatch(/new volume made in the first 60 months/);
    const f0 = first.byScenario.find((g) => g.scenarioId === "S0")!;
    const w0 = whole.byScenario.find((g) => g.scenarioId === "S0")!;
    expect(w0.byFamily.find((f) => f.familyId === "MMA")!.trancheCount).toBeGreaterThan(f0.byFamily.find((f) => f.familyId === "MMA")!.trancheCount);
    expect(w0.runoffEve).toBe(f0.runoffEve);
    expect(() => run({ goingConcernEve: true, goingConcernSpan: 61 })).toThrow(/a whole number from 1 to 60, got 61/);
    expect(() => run({ goingConcernSpan: 12 })).toThrow(/send it with goingConcernEve: true/);
    const short = run({ goingConcernEve: true, windowMonths: 6 }).eve.goingConcern!;
    expect(short.span).toEqual({ months: 6 });
    // k = 1 .. 6, and the deposit families make one every month, so exactly 6.
    const s0 = short.byScenario.find((g) => g.scenarioId === "S0")!;
    expect(s0.byFamily.every((f) => f.trancheCount <= 6)).toBe(true);
    expect(s0.byFamily.find((f) => f.familyId === "MMA")!.trancheCount).toBe(6);
  }, 300_000);

  it("fix round M1: a flat plan's first forecast liquidity band nets the replaced runoff to its residual, by hand", () => {
    const flat = run({ forecastGap: true });
    const off = run({}, BEHAVIORAL, "runoff");
    // By hand from the contractual series: in bucket 0 each family pays principal p0, and the k = 1 tranche that holds
    // the family flat is b0 less the balance left, b1. The forecast bucket 0 is p0 - (b0 - b1), per side.
    const s0 = off.cashflows.byScenario.find((s) => s.scenarioId === "S0")!;
    const fam = (side: string) => makeCoa().families.filter((f) => f.side === side).map((f) => s0.byFamily.find((x) => x.familyId === f.id)!.series);
    const residual = (side: string) => fam(side).reduce((a, s) => a + s.principal[0]! - (s.balance[0]! - s.balance[1]!), 0);
    const row0 = flat.gap.forecast!.liquidity.find((l) => l.scenarioId === "S0")!.userBuckets!.rows[0]!;
    const contractual0 = flat.gap.liquidity.find((l) => l.scenarioId === "S0")!.userBuckets!.rows[0]!;
    expect(Math.abs(row0.assets - residual("asset"))).toBeLessThan(1e-6);
    expect(Math.abs(row0.liabilities - residual("liability"))).toBeLessThan(1e-6);
    // The residual is about zero, while the contractual first month carries the whole runoff.
    expect(Math.abs(row0.assets)).toBeLessThan(1e-6);
    expect(Math.abs(row0.liabilities)).toBeLessThan(1e-6);
    expect(Math.abs(contractual0.assets) + Math.abs(contractual0.liabilities)).toBeGreaterThan(1_000);
  }, 300_000);

  it("the products carry their family's behavior into NII: the deposit families' new volume decays and reprices", () => {
    const r = run({});
    const s0 = r.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    const mma = s0.newBusiness!.find((n) => n.familyId === "MMA")!;
    expect(mma.product).toMatchObject({ source: "template", rateType: "deposit", amortization: "decay", behavior: { model: "nmd-decay-beta", applied: true, source: "assumption-set" } });
    // A decaying deposit is replaced every month, unlike the bullet stand-in, which makes volume only as bullets mature.
    expect(mma.originations.slice(1, 13).every((x) => x > 0)).toBe(true);
    // The paid rate moves with the beta: first coupons of later cohorts differ from the first one.
    const coupons = mma.couponAtOrigination!.filter((c): c is number => c !== null);
    expect(new Set(coupons.slice(0, 24).map((c) => c.toFixed(10))).size).toBeGreaterThan(1);
    // FTP prices the behavioral tranches at origination, deposits and prepaying mortgages alike.
    for (const id of ["MORTGAGE", "MMA", "DDA"]) expect(r.ftp!.byFamily.find((f) => f.familyId === id)!.newVolume!.trancheCount).toBeGreaterThan(0);
    const b = r.ftp!.nimBridge;
    expect(Math.abs(b.newVolume!.net12 - b.newBusinessNet12!)).toBeLessThan(1e-6 * Math.max(1, Math.abs(b.newBusinessNet12!)));
  }, 300_000);
});
