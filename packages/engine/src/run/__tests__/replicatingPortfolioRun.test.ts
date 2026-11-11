/**
 * The floater's funding-tenor flag and the replicating-portfolio credit through the run
 * pipeline. A flagged floater's FTP reads the one-month forward on the bond-equivalent quoting basis and the premium
 * at its funding tenor, and nothing else in the block moves; an unflagged floater is the kernel's row. A deposit bound
 * to a credit construction reads its family rates off the credit, NII and EVE carry no scenario with their tags, and
 * the options that cannot run beside the credit refuse.
 */
import { NMD_DEFAULTS, bootstrapZeroCurve, buildTLPCurve, type MarketSnapshot } from "@alm/kernel";
import { beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { EngineFloatingLoanTerms, EngineNMDTerms, PortfolioSpec, ReplicatingPortfolioForm } from "../../contracts/position";
import type { RunRequest, RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { ReplicatingPortfolioCredit } from "../../ftp/replicatingPortfolio";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { runStochastic } from "../stochastic";
import { loadMarket, makeRunRequest } from "./fixtures";

const coa: ChartOfAccounts = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "n-assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "n-fix", label: "Fixed", parentId: "n-assets", side: "asset", isLeaf: true, familyId: "FIX", order: 0 },
    { id: "n-flt", label: "Floating", parentId: "n-assets", side: "asset", isLeaf: true, familyId: "FLT", order: 1 },
    { id: "n-le", label: "Total Liabilities & Equity", parentId: null, side: "liability", isLeaf: false, order: 1 },
    { id: "n-dep", label: "Deposit", parentId: "n-le", side: "liability", isLeaf: true, familyId: "DEP", order: 0 },
  ],
  families: [
    { id: "FIX", label: "Fixed", side: "asset", instrumentType: "fixed-loan", coaNodeId: "n-fix" },
    { id: "FLT", label: "Floating", side: "asset", instrumentType: "floating-loan", coaNodeId: "n-flt" },
    { id: "DEP", label: "Deposit", side: "liability", instrumentType: "nmd", coaNodeId: "n-dep" },
  ],
};

const floater = (fundingTenorMonths?: number): EngineFloatingLoanTerms => ({
  id: "flt-1",
  type: "floating-loan",
  notional: 100e6,
  maturityMonths: 60,
  originationOffsetMonths: 0,
  amortType: "bullet",
  side: "asset",
  indexTenorMonths: 1,
  margin: 0.02,
  resetFrequencyMonths: 1,
  ...(fundingTenorMonths !== undefined ? { fundingTenorMonths } : {}),
});

const deposit = (o: Partial<EngineNMDTerms> = {}): EngineNMDTerms => ({
  id: "dep-1",
  type: "nmd",
  notional: 100e6,
  maturityMonths: 24,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "liability",
  depositRate: 0,
  beta: 0.5,
  nmdParams: { ...NMD_DEFAULTS },
  linearDecay: { horizonMonths: 24 },
  ...o,
});

function book(flag?: number, dep: EngineNMDTerms = deposit(), extra: PortfolioSpec["positions"] = []): PortfolioSpec {
  return {
    id: "BOOK-RP",
    label: "two loans and a deposit",
    asOf: "2026-03-31",
    coa,
    positions: [
      { id: "fix-1", familyId: "FIX", coaNodeId: "n-fix", terms: { id: "fix-1", type: "fixed-loan", notional: 100e6, maturityMonths: 60, originationOffsetMonths: 0, amortType: "bullet", side: "asset", coupon: 0.05 } },
      { id: "flt-1", familyId: "FLT", coaNodeId: "n-flt", terms: floater(flag) },
      { id: "dep-1", familyId: "DEP", coaNodeId: "n-dep", terms: dep },
      ...extra,
    ],
  };
}

const RP_A: ReplicatingPortfolioForm = { construction: "life-target", pillarGridMonths: [1, 3, 6, 12, 24, 36, 60, 84, 120], steepener: { topBp: 50, topYears: 5 } };
const set = (form?: ReplicatingPortfolioForm): AssumptionSet => ({
  schemaVersion: "1.0.0",
  id: "AS-RP",
  label: "the deposit on a replicating portfolio",
  bindings: form === undefined ? [] : [{ familyId: "DEP", modelVersion: "t", overlay: { kind: "nmd-decay", params: { ...NMD_DEFAULTS }, replicatingPortfolio: form } }],
});
const scenario = (id: string, rateSpec: Scenario["rateSpec"], mode: "static" | "dynamic" = "static"): Scenario => ({
  id,
  label: id,
  rateSpec,
  assumptionSetId: "AS-RP",
  newBusiness: { mode, rules: [] },
});

let market: MarketSnapshot;
beforeAll(async () => {
  market = { ...(await loadMarket()), curveDefault: 1 } as MarketSnapshot;
});

function request(form?: ReplicatingPortfolioForm, scenarios: Scenario[] = [scenario("S0", { kind: "base" })]): RunRequest {
  return makeRunRequest(market, { runId: "RUN-RP", portfolioId: "BOOK-RP", scenarios, assumptionSets: [set(form)], grid: { horizonMonths: 120, asOf: "2026-03-31" } });
}
const ctx = (extra?: Partial<RunPipelineContext>): RunPipelineContext => ({ ...resolveDefaultContext(), ...extra });
const ftpRow = (r: RunResult, fam: string) => r.ftp!.byFamily.find((f) => f.familyId === fam)!;

describe("the floater's funding tenor", () => {
  it("reads the IR leg at the reset tenor on the quoting basis and the premium at the funding tenor", () => {
    const r = buildRunResult(request(), book(60), ctx());
    const curve = bootstrapZeroCurve(market);
    const tlp = buildTLPCurve(market.tlpNodes);
    const f = ftpRow(r, "FLT");
    expect(f.irFtpRate).toBe(curve.forwardRateBey(0, 1 / 12));
    expect(f.lpFtpRate).toBe(tlp.tlp(5));
    expect(f.allInFtpRate).toBe(curve.forwardRateBey(0, 1 / 12) + tlp.tlp(5));
    // Month 13 refixes the forward over its own reset window and keeps the five-year premium.
    expect(f.monthly.ftpAccrual[12]! / (100e6 / 12)).toBeCloseTo(curve.forwardRateBey(1, 13 / 12) + tlp.tlp(5), 15);
  });

  it("moves nothing but the flagged floater's own FTP row, and an unflagged floater is the kernel's", () => {
    const flagged = buildRunResult(request(), book(60), ctx());
    const plain = buildRunResult(request(), book(), ctx());
    expect(ftpRow(flagged, "FIX")).toEqual(ftpRow(plain, "FIX"));
    expect(ftpRow(flagged, "DEP")).toEqual(ftpRow(plain, "DEP"));
    expect(flagged.cashflows).toEqual(plain.cashflows);
    expect(flagged.nii).toEqual(plain.nii);
    // Unflagged, the kernel par-matches the floater's whole principal stream: a 5Y bullet reads the fixed loan's term rate
    // and premium, and its monthly series charges the premium at the one-month reset tenor.
    expect(ftpRow(plain, "FLT").irFtpRate).toBe(ftpRow(plain, "FIX").irFtpRate);
    expect(ftpRow(plain, "FLT").lpFtpRate).toBe(ftpRow(plain, "FIX").lpFtpRate);
    const fwd = bootstrapZeroCurve(market).forwardRate(0, 1 / 12) + buildTLPCurve(market.tlpNodes).tlp(1 / 12);
    expect(ftpRow(plain, "FLT").monthly.ftpAccrual[0]! / (100e6 / 12)).toBeCloseTo(fwd, 15);
    expect(ftpRow(plain, "FLT").replicatingPortfolio).toBeUndefined();
  });

  it("reads its margin on one basis: the coupon less each month's transfer rate, weighted by balance (fix round 1)", () => {
    const f = ftpRow(buildRunResult(request(), book(60), ctx()), "FLT");
    // The same margin by the dollar route: interest less the FTP charge over the dollar-years of balance, months 1 to 60.
    const m = f.monthly;
    let dollars = 0;
    let dollarYears = 0;
    for (let k = 0; k < 60; k++) {
      dollars += m.couponInterest[k]! - m.ftpAccrual[k]!;
      dollarYears += m.balance[k]! / 12;
    }
    expect(Math.abs(f.ftpMarginRate! - dollars / dollarYears)).toBeLessThan(1e-12);
    // The desk keeps its 200 bp over the IR FTP, so about 155 bp over all-in, not the 171 bp a lifetime coupon
    // less a month-one transfer rate gave.
    expect(Math.abs(f.ftpMarginRate! - 0.0155)).toBeLessThan(0.0005);
  });

  it("refuses a funding tenor that is not a whole number of months", () => {
    expect(() => buildRunResult(request(), book(2.5), ctx())).toThrow(/fundingTenorMonths 2.5; it must be a whole number of months from 1/);
  });
});

describe("the replicating-portfolio credit in a run", () => {
  it("the deposit family reads the credit, and the readout rides on its FTP row", () => {
    const r = buildRunResult(request(RP_A), book(60), ctx());
    const d = ftpRow(r, "DEP");
    const own = new ReplicatingPortfolioCredit({ positionId: "dep-1", notional: 100e6, beta: 0.5, runoffMonths: 24 }, RP_A).readout(bootstrapZeroCurve(market), buildTLPCurve(market.tlpNodes), market);
    expect(d.replicatingPortfolio).toEqual(own);
    expect(d.irFtpRate).toBe(own.rateCredit);
    expect(d.lpFtpRate).toBe(own.liquidityCredit);
    expect(d.allInFtpRate).toBe(own.totalCredit);
    expect("rateCredit" in own.steepener!).toBe(true);
    // The deposit's own cash flows run off in a straight line.
    const bal = r.cashflows.byScenario[0]!.byFamily.find((f) => f.familyId === "DEP")!.series.balance;
    expect(bal[12]).toBeCloseTo(50e6, 6);
    expect(bal[24]).toBe(0);
  });

  it("NII and EVE carry no scenario, each with its tag; the FTP bridge still closes; the gaps run", () => {
    const r = buildRunResult(request(RP_A), book(60), ctx());
    expect(r.nii.byScenario).toEqual([]);
    expect(r.eve.byScenario).toEqual([]);
    const layers = r.notImplemented.map((n) => n.layer);
    expect(layers).toContain("nii.replicating-portfolio");
    expect(layers).toContain("eve.replicating-portfolio");
    const b = r.ftp!.nimBridge;
    expect(Math.abs(b.bridgeNet12 - b.niiNet12)).toBeLessThan(1e-6);
    expect(r.gap.liquidity.length).toBe(1);
    expect(r.attribution.headlines ?? []).toEqual([]);
  });

  it("a run without a credit binding is unchanged by the new keys: NII and EVE run, no tag is written", () => {
    const r = buildRunResult(request(), book(), ctx());
    expect(r.nii.byScenario.length).toBe(1);
    expect(r.eve.byScenario.length).toBe(1);
    expect(r.notImplemented.map((n) => n.layer).filter((l) => l.endsWith("replicating-portfolio"))).toEqual([]);
  });

  it("refuses what cannot run beside the credit", () => {
    expect(() => buildRunResult(request(RP_A), book(), ctx({ seg: true }))).toThrow(/seg cannot run beside the replicating-portfolio credit/);
    expect(() => buildRunResult(request(RP_A), book(), ctx({ keyRate: true }))).toThrow(/keyRate cannot run beside/);
    expect(() => buildRunResult(request(RP_A), book(), ctx({ eveChannels: true }))).toThrow(/eveChannels cannot run beside/);
    expect(() => buildRunResult(request(RP_A), book(), ctx({ nmdConvention: "regulatory" }))).toThrow(/slots deposits for EVE/);
    expect(() => buildRunResult(request(RP_A, [scenario("S0", { kind: "base" }), scenario("U200", { kind: "parallel", shockBp: 200 })]), book(), ctx())).toThrow(/read on the base curve only/);
    expect(() => buildRunResult(request(RP_A, [scenario("S0", { kind: "base" }, "dynamic")]), book(), ctx())).toThrow(/static-runoff scenarios only/);
    expect(() => runStochastic(request(RP_A), book(), { nPaths: 20 })).toThrow(/stochastic FTP is not built/);
  });

  it("refuses a credit on a deposit without a linear decay, and a credit-priced deposit sharing its family", () => {
    const { linearDecay: _drop, ...plainDep } = deposit();
    expect(() => buildRunResult(request(RP_A), book(undefined, { ...plainDep, maturityMonths: 360 }), ctx())).toThrow(/carries no linear decay/);
    const twin = { id: "dep-2", familyId: "DEP", coaNodeId: "n-dep", terms: deposit({ id: "dep-2" }) };
    expect(() => buildRunResult(request(RP_A), book(undefined, deposit(), [twin]), ctx())).toThrow(/put a credit-priced deposit in a family of its own/);
  });
});
