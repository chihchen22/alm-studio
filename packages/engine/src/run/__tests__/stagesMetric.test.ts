/**
 * The metric stage is four arms over one seam, and the
 * post-walk assembly is everything the envelope needs that is not a stage:
 * the family WAL stamp, the two opt-in EVE blocks, attribution, provenance.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { ContractTypeName, PlanStage } from "../../contracts/plan";
import type { CustomMetricResult } from "../../contracts/customMetric";
import type { EVEResult, GapResult, NIIResult, ScenarioCashflows } from "../../contracts/results";
import type { FtpResult } from "../../contracts/results";
import { computeEve } from "../../eve";
import { defaultHarness } from "../../plugins/defaultHarness";
import { resolveDefaultContext } from "../engine";
import { makeShelf } from "../shelf";
import { PlanGraphError } from "../executorErrors";
import {
  assembleRunResult,
  runBalanceStage,
  runContractualStage,
  runCurveStage,
  runMetricStage,
  runTermStructureStage,
  runTlpStage,
} from "../stages";
import type { AssembleInput, StageInput, StageRunEnv } from "../stages";
import { makeTestEnv } from "./stageEnv";
import {
  fixedPosition,
  loadMarket,
  makeRunRequest,
  nmdPosition,
  twoSidedBook,
  NMD_DEFAULT_PARAMS,
} from "./fixtures";

const RUN = { kind: "run" } as const;
const EMPTY: StageInput = { run: {}, scenario: {}, assumptionSet: {} };

function stage(id: string, produces: ContractTypeName[], component: string): PlanStage {
  return { id, component, kind: "metric", consumes: [], produces };
}

let market: MarketSnapshot;
let env: StageRunEnv;
let full: StageInput;
/** The CONTRACTUAL stage's per-scenario series: what EVE and gap read. */
let staticSeries: ReadonlyMap<string, ScenarioCashflows>;
beforeAll(async () => {
  market = await loadMarket();
  env = makeTestEnv(makeRunRequest(market), twoSidedBook(), defaultHarness());
  const curve = runCurveStage(env, { id: "st-curve", component: "engine.curve.bootstrap", kind: "curve", consumes: [], produces: [] }, EMPTY);
  const tlp = runTlpStage(
    env,
    { id: "st-tlp", component: "engine.tlp-overlay", kind: "curve", consumes: [], produces: [] },
    { run: { ZeroCurve: curve.run!.ZeroCurve }, scenario: {}, assumptionSet: {} },
  );
  const term = runTermStructureStage(
    env,
    { id: "st-term", component: "engine.rate-path.deterministic", kind: "term-structure", consumes: [], produces: [] },
    { run: { ZeroCurve: curve.run!.ZeroCurve }, scenario: {}, assumptionSet: {} },
  );
  const contractual = runContractualStage(
    env,
    { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: [], produces: [] },
    { run: {}, scenario: term.scenario!, assumptionSet: {} },
  );
  staticSeries = contractual.scenario!.Cashflow as ReadonlyMap<string, ScenarioCashflows>;
  const balance = runBalanceStage(
    env,
    { id: "st-balance", component: "engine.balance-plan", kind: "balance-new-business", consumes: [], produces: [] },
    { run: {}, scenario: { ...term.scenario!, ...contractual.scenario! }, assumptionSet: {} },
  );
  full = {
    run: { ZeroCurve: curve.run!.ZeroCurve, FundingCurve: tlp.run!.FundingCurve },
    scenario: { ...term.scenario!, ...contractual.scenario!, Cashflow: balance.scenario!.Cashflow! },
    assumptionSet: {},
  };
});

describe("runMetricStage", () => {
  it("produces an NiiResult with one row per scenario", () => {
    const out = runMetricStage(env, stage("st-nii", ["NiiResult"], "engine.metric.nii"), full);
    const nii = out.run!.NiiResult as NIIResult;
    expect(nii.byScenario.map((s) => s.scenarioId)).toEqual(env.request.scenarios.map((s) => s.id));
  });

  it("produces an EveResult off the static series it was handed, on both curve legs", () => {
    // The EVE arm must read the CONTRACTUAL stage's series, not some other one:
    // the assertion is the whole EVEResult against a direct computeEve call on
    // exactly that series, so a wrong series or a wrong leg fails the case.
    const statics: StageInput = { ...full, scenario: { ...full.scenario, Cashflow: staticSeries } };
    const out = runMetricStage(env, stage("st-eve", ["EveResult"], "engine.metric.eve"), statics);
    const eve = out.run!.EveResult as EVEResult;
    const direct = computeEve({
      portfolio: env.portfolio,
      cashflows: {
        grid: env.grid,
        byScenario: env.request.scenarios.map((s) => staticSeries.get(s.id)!),
      },
      scenarios: env.request.scenarios,
      baseCurve: full.run.ZeroCurve as Parameters<typeof computeEve>[0]["baseCurve"],
      tlp: full.run.FundingCurve as Parameters<typeof computeEve>[0]["tlp"],
      durationMode: env.durationMode,
    });
    expect(eve).toEqual(direct);
    expect(eve.byScenario.map((s) => s.scenarioId)).toEqual(env.request.scenarios.map((s) => s.id));
  });

  it("reads the two legs as two edges, and refuses when the funding edge brought nothing", () => {
    const noFunding: StageInput = { ...full, run: { ZeroCurve: full.run.ZeroCurve } };
    expect(() => runMetricStage(env, stage("st-eve", ["EveResult"], "engine.metric.eve"), noFunding)).toThrow(
      /FundingCurve/,
    );
  });

  it("produces a GapResult with one repricing and one liquidity ladder per scenario", () => {
    const out = runMetricStage(env, stage("st-gap", ["GapResult"], "engine.metric.gap"), full);
    const gap = out.run!.GapResult as GapResult;
    expect(gap.repricing).toHaveLength(env.request.scenarios.length);
    expect(gap.liquidity).toHaveLength(env.request.scenarios.length);
  });

  it("produces an FtpResult for the base scenario", () => {
    const nii = runMetricStage(env, stage("st-nii", ["NiiResult"], "engine.metric.nii"), full);
    const withNii: StageInput = { ...full, run: { ...full.run, NiiResult: nii.run!.NiiResult } };
    const out = runMetricStage(env, stage("st-ftp", ["FtpResult"], "engine.metric.ftp"), withNii);
    expect(Object.hasOwn(out.run!, "FtpResult")).toBe(true);
    expect((out.run!.FtpResult as FtpResult).scenarioId).toBe(env.baseScenario.id);
  });

  it("refuses a metric stage that declares no result type", () => {
    expect(() => runMetricStage(env, stage("st-none", [], "engine.metric.nii"), full)).toThrow(PlanGraphError);
  });

  it("refuses a metric stage that declares two result types", () => {
    expect(() =>
      runMetricStage(env, stage("st-two", ["NiiResult", "EveResult"], "engine.metric.nii"), full),
    ).toThrow(PlanGraphError);
  });
});

describe("assembleRunResult", () => {
  it("assembles an envelope whose blocks are the shelf's metric artifacts", () => {
    const shelf = makeShelf();
    const nii = runMetricStage(env, stage("st-nii", ["NiiResult"], "engine.metric.nii"), full);
    shelf.put("NiiResult", RUN, "st-nii", nii.run!.NiiResult);
    const withNii: StageInput = { ...full, run: { ...full.run, NiiResult: nii.run!.NiiResult } };
    const eve = runMetricStage(env, stage("st-eve", ["EveResult"], "engine.metric.eve"), full);
    shelf.put("EveResult", RUN, "st-eve", eve.run!.EveResult);
    const gap = runMetricStage(env, stage("st-gap", ["GapResult"], "engine.metric.gap"), full);
    shelf.put("GapResult", RUN, "st-gap", gap.run!.GapResult);
    const ftp = runMetricStage(env, stage("st-ftp", ["FtpResult"], "engine.metric.ftp"), withNii);
    shelf.put("FtpResult", RUN, "st-ftp", ftp.run!.FtpResult);
    for (const [id, cf] of full.scenario.Cashflow!) shelf.put("Cashflow", { kind: "scenario", scenarioId: id }, "st-balance", cf);

    const base = resolveDefaultContext();
    const result = assembleRunResult({
      env,
      shelf,
      metricProducers: new Map<ContractTypeName, string>([
        ["NiiResult", "st-nii"],
        ["EveResult", "st-eve"],
        ["GapResult", "st-gap"],
        ["FtpResult", "st-ftp"],
      ]),
      primaryCashflowProducer: "st-balance",
      runLog: [],
      engineVersion: base.engineVersion,
      kernel: base.kernel,
      schemaVersion: "1.5.0",
    });
    expect(result.schemaVersion).toBe("1.5.0");
    expect(result.nii).toBe(nii.run!.NiiResult);
    expect(result.eve).toBe(eve.run!.EveResult);
    expect(result.gap).toBe(gap.run!.GapResult);
    expect(result.ftp).toBe(ftp.run!.FtpResult);
    expect(result.cashflows.byScenario.map((s) => s.scenarioId)).toEqual(env.request.scenarios.map((s) => s.id));
    // The WAL stamp lands on the FINAL per-scenario series, before the envelope.
    for (const scn of result.cashflows.byScenario as ScenarioCashflows[]) {
      expect(scn.byFamily.some((f) => f.walYears !== undefined)).toBe(true);
    }
    expect(result.attribution).toBeDefined();
    expect(result.provenance.runId).toBe(env.request.runId);
  });

  it("refuses when the walk produced no result of a required type", () => {
    const shelf = makeShelf();
    for (const [id, cf] of full.scenario.Cashflow!) {
      shelf.put("Cashflow", { kind: "scenario", scenarioId: id }, "st-balance", cf);
    }
    expect(() =>
      assembleRunResult({
        env,
        shelf,
        metricProducers: new Map<ContractTypeName, string>(),
        primaryCashflowProducer: "st-balance",
        runLog: [],
        engineVersion: "0.0.0",
        kernel: resolveDefaultContext().kernel,
        schemaVersion: "1.5.0",
      }),
    ).toThrow(PlanGraphError);
  });

  it("refuses two custom producers that published one metricId, naming both stages", () => {
    // The compiler's one-stage-per-custom-metric rule should have refused this
    // plan. The assembler is the backstop, and its message has to point at the
    // pair, not only at whichever stage the walk reached second.
    const shelf = makeShelf();
    for (const [id, cf] of full.scenario.Cashflow!) {
      shelf.put("Cashflow", { kind: "scenario", scenarioId: id }, "st-balance", cf);
    }
    const nii = runMetricStage(env, stage("st-nii", ["NiiResult"], "engine.metric.nii"), full);
    shelf.put("NiiResult", RUN, "st-nii", nii.run!.NiiResult);
    const eve = runMetricStage(env, stage("st-eve", ["EveResult"], "engine.metric.eve"), full);
    shelf.put("EveResult", RUN, "st-eve", eve.run!.EveResult);
    const gap = runMetricStage(env, stage("st-gap", ["GapResult"], "engine.metric.gap"), full);
    shelf.put("GapResult", RUN, "st-gap", gap.run!.GapResult);

    const custom = (value: number): CustomMetricResult => ({
      metricId: "liquidity-buffer",
      label: "Liquidity buffer",
      keys: [{ id: "buffer", label: "Buffer", unit: "currency" }],
      byScenario: env.request.scenarios.map((s) => ({
        scenarioId: s.id,
        values: { buffer: value },
      })),
    });
    shelf.put("CustomMetricResult", RUN, "st-custom-a", custom(1));
    shelf.put("CustomMetricResult", RUN, "st-custom-b", custom(2));

    let thrown: unknown;
    try {
      assembleRunResult({
        env,
        shelf,
        metricProducers: new Map<ContractTypeName, string>([
          ["NiiResult", "st-nii"],
          ["EveResult", "st-eve"],
          ["GapResult", "st-gap"],
        ]),
        customProducers: ["st-custom-a", "st-custom-b"],
        primaryCashflowProducer: "st-balance",
        runLog: [],
        engineVersion: "0.0.0",
        kernel: resolveDefaultContext().kernel,
        schemaVersion: "1.5.0",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PlanGraphError);
    const message = (thrown as Error).message;
    expect(message).toContain("st-custom-a");
    expect(message).toContain("st-custom-b");
    expect(message).toContain("liquidity-buffer");
  });

  it("takes the base book from the EVE stage's resolved Position edge, never the first chain link", () => {
    // Two Position producers at the base assumption-set scope, the way a
    // two-link behavioral chain leaves them. Which book the opt-in blocks
    // measure is observable through the regime-amplifier refusal, whose reason
    // names the count: the first link carries one amplified deposit, the last
    // two. The last link is the fully overlaid book, and it is the one pre-1c
    // measured, so the assembly must never settle for the first.
    const scope = { kind: "assumptionSet" as const, assumptionSetId: env.baseScenario.assumptionSetId };
    const amplified = (n: number) => ({ ...NMD_DEFAULT_PARAMS, regimeAlpha: n });
    const firstLink = {
      ...env.portfolio,
      positions: [nmdPosition("A1", { nmdParams: amplified(0.5) })],
    };
    const lastLink = {
      ...env.portfolio,
      positions: [
        nmdPosition("A1", { nmdParams: amplified(0.5) }),
        nmdPosition("A2", { nmdParams: amplified(0.25) }),
      ],
    };

    const build = (resolution?: AssembleInput["resolution"]): string => {
      const shelf = makeShelf();
      shelf.put("Position", scope, "st-beta", firstLink);
      shelf.put("Position", scope, "st-decay", lastLink);
      const keyRateEnv: StageRunEnv = { ...env, keyRate: true, notImplemented: [] };
      const nii = runMetricStage(env, stage("st-nii", ["NiiResult"], "engine.metric.nii"), full);
      shelf.put("NiiResult", RUN, "st-nii", nii.run!.NiiResult);
      const eve = runMetricStage(env, stage("st-eve", ["EveResult"], "engine.metric.eve"), full);
      shelf.put("EveResult", RUN, "st-eve", { ...(eve.run!.EveResult as EVEResult) });
      const gap = runMetricStage(env, stage("st-gap", ["GapResult"], "engine.metric.gap"), full);
      shelf.put("GapResult", RUN, "st-gap", gap.run!.GapResult);
      for (const [id, cf] of full.scenario.Cashflow!) {
        shelf.put("Cashflow", { kind: "scenario", scenarioId: id }, "st-balance", cf);
      }
      const base = resolveDefaultContext();
      assembleRunResult({
        env: keyRateEnv,
        shelf,
        metricProducers: new Map<ContractTypeName, string>([
          ["NiiResult", "st-nii"],
          ["EveResult", "st-eve"],
          ["GapResult", "st-gap"],
        ]),
        primaryCashflowProducer: "st-balance",
        runLog: [],
        engineVersion: base.engineVersion,
        kernel: base.kernel,
        schemaVersion: "1.5.0",
        ...(resolution === undefined ? {} : { resolution }),
      });
      const tag = keyRateEnv.notImplemented.find((n) => n.layer === "eve.key-rate.regime-amplifier");
      expect(tag).toBeDefined();
      return tag!.reason;
    };

    // The EVE stage's own edge names the first link: that is what the assembly measures.
    expect(build(new Map([["st-eve", new Map<ContractTypeName, string>([["Position", "st-beta"]])]]))).toContain(
      "carries 1 position(s)",
    );
    // With no resolution the walk-order LAST producer wins, never the first.
    expect(build()).toContain("carries 2 position(s)");
  });

  it("the FTP seasoned-book tag reads as a plain sentence: a count with the right plural, the names, and no build reference", () => {
    const scope = { kind: "assumptionSet" as const, assumptionSetId: env.baseScenario.assumptionSetId };
    const seasoned = (id: string) => fixedPosition(id, { notional: 1_000_000, coupon: 0.05, maturityMonths: 24, amortType: "bullet", originationOffsetMonths: -6 });
    const reasonFor = (ids: string[]): string => {
      const book = { ...env.portfolio, positions: [...env.portfolio.positions, ...ids.map(seasoned)] };
      const runEnv: StageRunEnv = { ...env, notImplemented: [], deferredNotImplemented: [] };
      const nii = runMetricStage(runEnv, stage("st-nii", ["NiiResult"], "engine.metric.nii"), full);
      const input: StageInput = {
        ...full,
        run: { ...full.run, NiiResult: nii.run!.NiiResult },
        assumptionSet: { Position: new Map([[scope.assumptionSetId, book]]) },
      };
      const ftp = runMetricStage(runEnv, stage("st-ftp", ["FtpResult"], "engine.metric.ftp"), input);
      expect(ftp.run!.FtpResult).toBeUndefined();
      const tags = (runEnv.deferredNotImplemented ?? []).filter((n) => n.layer === "ftp.seasoned-book");
      expect(tags).toHaveLength(1);
      return tags[0]!.reason;
    };
    const one = reasonFor(["F-SEASONED"]);
    expect(one).toContain("the book carries 1 seasoned position (F-SEASONED);");
    expect(one).toContain("the FTP module prices each position's full original stream and does not yet take a seasoned position's offset into account, so the ftp block is left out rather than published mis-timed.");
    expect(one).not.toMatch(/ADR-|W3-|NOTE|\(s\)/);
    const two = reasonFor(["F-A", "F-B"]);
    expect(two).toContain("the book carries 2 seasoned positions (F-A, F-B);");
    expect(two).not.toMatch(/ADR-|W3-|NOTE|\(s\)/);
  });

  it("pushes the register tags in the pre-1c order: key-rate, then FTP, then attribution", () => {
    // The FTP arm defers its seasoned-book tag rather than pushing it during
    // the walk, so the envelope's notImplemented keeps the order the pre-1c
    // pipeline wrote, which is a compared field of the golden.
    const scope = { kind: "assumptionSet" as const, assumptionSetId: env.baseScenario.assumptionSetId };
    const seasonedBook = {
      ...env.portfolio,
      positions: [
        ...env.portfolio.positions,
        fixedPosition("F-SEASONED", { notional: 1_000_000, coupon: 0.05, maturityMonths: 24, amortType: "bullet", originationOffsetMonths: -6 }),
      ],
    };
    const amplifiedBook = {
      ...env.portfolio,
      positions: [nmdPosition("A1", { nmdParams: { ...NMD_DEFAULT_PARAMS, regimeAlpha: 0.5 } })],
    };
    const runEnv: StageRunEnv = { ...env, keyRate: true, notImplemented: [] };

    const nii = runMetricStage(runEnv, stage("st-nii", ["NiiResult"], "engine.metric.nii"), full);
    const seasonedInput: StageInput = {
      ...full,
      run: { ...full.run, NiiResult: nii.run!.NiiResult },
      assumptionSet: { Position: new Map([[scope.assumptionSetId, seasonedBook]]) },
    };
    const ftp = runMetricStage(runEnv, stage("st-ftp", ["FtpResult"], "engine.metric.ftp"), seasonedInput);
    expect(Object.hasOwn(ftp.run!, "FtpResult")).toBe(true);
    expect(ftp.run!.FtpResult).toBeUndefined();
    // Nothing is pushed during the walk: the assembly owns the order.
    expect(runEnv.notImplemented).toHaveLength(0);

    const shelf = makeShelf();
    shelf.put("Position", scope, "st-decay", amplifiedBook);
    shelf.put("NiiResult", RUN, "st-nii", nii.run!.NiiResult);
    const eve = runMetricStage(runEnv, stage("st-eve", ["EveResult"], "engine.metric.eve"), full);
    shelf.put("EveResult", RUN, "st-eve", eve.run!.EveResult);
    const gap = runMetricStage(runEnv, stage("st-gap", ["GapResult"], "engine.metric.gap"), full);
    shelf.put("GapResult", RUN, "st-gap", gap.run!.GapResult);
    shelf.put("FtpResult", RUN, "st-ftp", ftp.run!.FtpResult);
    for (const [id, cf] of full.scenario.Cashflow!) {
      shelf.put("Cashflow", { kind: "scenario", scenarioId: id }, "st-balance", cf);
    }
    const base = resolveDefaultContext();
    const result = assembleRunResult({
      env: runEnv,
      shelf,
      metricProducers: new Map<ContractTypeName, string>([
        ["NiiResult", "st-nii"],
        ["EveResult", "st-eve"],
        ["GapResult", "st-gap"],
        ["FtpResult", "st-ftp"],
      ]),
      primaryCashflowProducer: "st-balance",
      runLog: [],
      engineVersion: base.engineVersion,
      kernel: base.kernel,
      schemaVersion: "1.5.0",
    });
    expect(Object.hasOwn(result, "ftp")).toBe(false);
    expect(result.notImplemented.slice(0, 2).map((n) => n.layer)).toEqual([
      "eve.key-rate.regime-amplifier",
      "ftp.seasoned-book",
    ]);
  });
});
