/**
 * The component decay form through the run pipeline. An nmd-decay binding carrying the form
 * reaches the deposit as `componentDecay`, the static pass hands it each scenario's level shift, the family WAL reads
 * the full runoff with its note, NII, EVE and FTP stand aside with their tags, and the options that cannot run beside
 * the form refuse. The form is the round one of nmd/__tests__/componentDecay.test.ts, so month 1 of the base scenario
 * keeps 0.9702 of the book and month 1 of +200 bp keeps 0.9506, worked by hand there.
 */
import { NMD_DEFAULTS, type NMDTerms } from "@alm/kernel";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { ComponentDecayForm, PortfolioSpec } from "../../contracts/position";
import type { RunRequest, RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { ComponentDecayDeposit } from "../../nmd/componentDecay";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { runStochastic } from "../stochastic";
import { loadMarket, makeRunRequest } from "./fixtures";

const FORM: ComponentDecayForm = {
  retention: 0.98,
  drift: 0.01,
  coefficientPerPp: -0.01,
  lookbackMonths: 2,
  series: { firstMonth: "2020-01", label: "a round test series", valuesPct: [1, 3, 4, 2] },
  window: { firstMonth: "2020-03", lastMonth: "2020-04" },
  beyondWindow: "hold-last",
};
const NOTIONAL = 1_000_000_000;

const coa: ChartOfAccounts = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "n-assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "n-le", label: "Total Liabilities & Equity", parentId: null, side: "liability", isLeaf: true, familyId: "SAV", order: 1 },
  ],
  families: [{ id: "SAV", label: "Savings", side: "liability", instrumentType: "nmd", coaNodeId: "n-le" }],
};

function book(): PortfolioSpec {
  const terms: NMDTerms = {
    id: "sav-1",
    type: "nmd",
    label: "savings",
    notional: NOTIONAL,
    maturityMonths: 360,
    originationOffsetMonths: 0,
    amortType: "level-pay",
    side: "liability",
    depositRate: 0,
    beta: 0,
    nmdParams: { ...NMD_DEFAULTS },
  };
  return { id: "BOOK-CD", label: "one savings deposit", asOf: "2026-01-01", coa, positions: [{ id: "sav-1", familyId: "SAV", coaNodeId: "n-le", terms }] };
}

const set = (form: ComponentDecayForm = FORM): AssumptionSet => ({
  schemaVersion: "1.0.0",
  id: "AS-CD",
  label: "savings on the component decay form",
  bindings: [{ familyId: "SAV", modelVersion: "t", overlay: { kind: "nmd-decay", params: { ...NMD_DEFAULTS }, componentDecay: form } }],
});

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const scenario = (id: string, rateSpec: Scenario["rateSpec"], mode: "static" | "dynamic" = "static"): Scenario => ({
  id,
  label: id,
  rateSpec,
  assumptionSetId: "AS-CD",
  newBusiness: { mode, rules: [] },
});
const SLATE = (): Scenario[] => [scenario("S0", { kind: "base" }), scenario("U200", { kind: "parallel", shockBp: 200 }), scenario("D200", { kind: "parallel", shockBp: -200 })];

function request(scenarios: Scenario[] = SLATE(), form?: ComponentDecayForm): RunRequest {
  return makeRunRequest(market, { runId: "RUN-CD", portfolioId: "BOOK-CD", scenarios, assumptionSets: [set(form)] });
}
const ctx = (extra?: Partial<RunPipelineContext>): RunPipelineContext => ({ ...resolveDefaultContext(), ...extra });
const fam = (r: RunResult, s: string) => r.cashflows.byScenario.find((x) => x.scenarioId === s)!.byFamily[0]!;

describe("component decay form in a run", () => {
  it("each scenario's deposit reads its level shift; the curve path is not read", () => {
    const r = buildRunResult(request(), book(), ctx());
    expect(fam(r, "S0").series.balance[1]).toBeCloseTo(NOTIONAL * 0.9702, 3);
    expect(fam(r, "U200").series.balance[1]).toBeCloseTo(NOTIONAL * 0.9506, 3);
    expect(fam(r, "D200").series.balance[1]).toBeCloseTo(NOTIONAL * 0.9898, 3);
    expect(fam(r, "S0").series.interest.every((v) => v === 0)).toBe(true);
  });

  it("the family WAL reads the full runoff, and the note says so", () => {
    const r = buildRunResult(request(), book(), ctx());
    for (const [id, shift] of [["S0", 0], ["U200", 2], ["D200", -2]] as const) {
      const dep = new ComponentDecayDeposit({ ...(book().positions[0]!.terms as NMDTerms), componentDecay: FORM }, shift);
      // The geometric tail by brute force: 20,000 months is far past any remainder.
      const s = dep.survival(20_000);
      let dm = 0;
      for (let m = 1; m < s.length; m++) dm += m * (s[m - 1]! - s[m]!);
      expect(Math.abs(fam(r, id).walYears! - dm / 12)).toBeLessThan(1e-9);
    }
    const note = r.notImplemented.find((n) => n.layer === "cashflows.wal.full-runoff");
    expect(note?.reason).toMatch(/exact geometric tail past the 360-month grid/);
  });

  it("NII and EVE carry no scenario and FTP is left out, each with its tag; attribution peels nothing", () => {
    const r = buildRunResult(request(), book(), ctx());
    expect(r.nii.byScenario).toEqual([]);
    expect(r.eve.byScenario).toEqual([]);
    expect(r.ftp).toBeUndefined();
    const layers = r.notImplemented.map((n) => n.layer);
    for (const l of ["nii.component-decay", "eve.component-decay", "ftp.component-decay"]) expect(layers).toContain(l);
    expect(r.attribution.headlines ?? []).toEqual([]);
    expect(r.gap.liquidity.length).toBe(3);
  });

  it("the static bifurcation runs one schedule in every scenario", () => {
    const r = buildRunResult(request(SLATE(), { ...FORM, staticShare: 0.5 }), book(), ctx());
    expect(fam(r, "U200").series.balance).toEqual(fam(r, "S0").series.balance);
    expect(fam(r, "D200").walYears).toBe(fam(r, "S0").walYears);
    expect(fam(r, "S0").series.balance[1]).toBeCloseTo(NOTIONAL * 0.5 * 0.9702, 3);
  });

  it("refuses the options that cannot run beside the form", () => {
    expect(() => buildRunResult(request(), book(), ctx({ seg: true }))).toThrow(/seg cannot run beside the component decay form/);
    expect(() => buildRunResult(request(), book(), ctx({ keyRate: true }))).toThrow(/keyRate cannot run beside the component decay form/);
    expect(() => buildRunResult(request(), book(), ctx({ eveChannels: true }))).toThrow(/eveChannels cannot run beside/);
    expect(() => buildRunResult(request(), book(), ctx({ nmdConvention: "regulatory" }))).toThrow(/slots deposits for EVE/);
    expect(() => buildRunResult(request(), book(), ctx({ nmdConvention: "shocked-level" }))).toThrow(/slots deposits for EVE/);
    expect(() => buildRunResult(request([scenario("S0", { kind: "base" }, "dynamic")]), book(), ctx())).toThrow(/static-runoff scenarios only/);
    expect(() => runStochastic(request([scenario("S0", { kind: "base" })]), book(), { nPaths: 20 })).toThrow(/binds the component decay form/);
  });
});
