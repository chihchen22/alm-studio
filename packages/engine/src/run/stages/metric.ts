/**
 * metric: the five result-producing arms over the `metrics` seam (spec Section
 * 2.3). Which arm runs is decided by the ONE contract type the stage declares it
 * produces, which is also what the compiler's L2 rule reads, so the plan and the
 * executor agree on what a metric stage is by construction.
 *
 * What each arm consumes:
 *   nii  Cashflow (the primary series, every scenario)
 *   eve  Cashflow (the static series, every scenario), ZeroCurve (the risk-free
 *        leg the shocks are built from), FundingCurve (the all-in leg it
 *        discounts on), Position
 *   gap  RepricingSchedule (every scenario), Position. The stage also DECLARES a
 *        Cashflow edge, which the arm never reads: T6 requires a metric stage's
 *        consumes to equal its plugin's declares as a set, and the gap plugin
 *        declares Cashflow.
 *   ftp  Cashflow (the base scenario), ZeroCurve, FundingCurve, Position, and the
 *        base NII row it bridges against, taken from the NiiResult on the shelf.
 *
 * The fifth arm is CustomMetricResult, which is not run from here:
 * it has its own stage function in `run/stages/customMetric.ts`, and it consumes
 * Cashflow and Position alone.
 *
 * Attribution and the two opt-in EVE blocks are NOT stages: they are post-metric
 * assembly on the metric results and run after the walk, exactly as they did.
 */
import type { RatePath, TLPCurve, ZeroCurve } from "@alm/kernel";
import { shockedCurve } from "../../scenario/rateEnvironment";
import type { ContractTypeName, PlanStage } from "../../contracts/plan";
import type {
  EVEResult,
  FtpResult,
  GapLadder,
  NIIResult,
  ScenarioCashflows,
} from "../../contracts/results";
import { wantsLiquidityInterest, type FamilySeries, type GapLadderBuckets } from "../../gap";
import { DEFAULT_NII_WINDOW_MONTHS, NII_HORIZONS_MONTHS } from "../../nii";
import { seasoningOffsetOf } from "../../portfolio/seasoning";
import { makeNotImplemented } from "../../runtime/notImplemented";
import { componentDecayRefusal } from "../../nmd/componentDecayRun";
import { replicatingPortfolioRefusal } from "../../ftp/replicatingPortfolioRun";
import { PlanGraphError } from "../executorErrors";
import type { StageFn, StageInput, StageRunEnv } from "./types";
import { positionsFor, requireRun, requireScenario } from "./types";

const UNREGISTERED = "<unregistered>";

/**
 * The closed metric id set (deviation 8, ruled): a metric stage produces exactly
 * one of these five, the fifth being CustomMetricResult since piece 3b. Exported once from here and re-exported through the barrel;
 * the walker reads it to decide which stages are metric producers.
 */
export const RESULT_TYPES: readonly ContractTypeName[] = [
  "NiiResult",
  "EveResult",
  "GapResult",
  "FtpResult",
  // The fifth slot. It is in this list so the compiler's producer map,
  // the walker's producer check and the one-of check all see it; since piece 5a
  // its producers are listed in ExecutedPlan.customProducers, not in
  // metricProducers; it is NOT a
  // required slot, and the required-slot rule in plan/compile.ts still names
  // NiiResult, EveResult and GapResult alone.
  "CustomMetricResult",
];

/**
 * The two curve legs as two edges. `requireRun` refuses a missing one naming the
 * type, which on a compiled plan cannot happen: tightened T1 already refused a
 * stage with no FundingCurve producer in its direct dependsOn.
 */
function legs(env: StageRunEnv, stage: PlanStage, input: StageInput): { base: ZeroCurve; tlp: TLPCurve } {
  return {
    base: requireRun<ZeroCurve>(env, stage, input, "ZeroCurve"),
    tlp: requireRun<TLPCurve>(env, stage, input, "FundingCurve"),
  };
}

/** Every scenario's slice of a scenario-scope input, in request order. */
function perScenario<T>(env: StageRunEnv, stage: PlanStage, input: StageInput, type: ContractTypeName): T[] {
  return env.request.scenarios.map((s) => requireScenario<T>(env, stage, input, type, s.id));
}

/** Tag a block a component decay run leaves empty, log the refusal, and hand the empty block back. */
function refusedBlock<T>(env: StageRunEnv, stage: PlanStage, block: "nii" | "eve", empty: T): T {
  env.notImplemented.push(componentDecayRefusal(block));
  env.log({ t: "refuse", error: `${block}.component-decay`, ids: { scenarioId: env.baseScenario.id, stageId: stage.id } });
  return empty;
}

/** True when every nmd of the book that carries the form also carries a replicating-portfolio credit. */
function everyFormPriced(book: { positions: readonly { terms: { type: string } }[] }, form: "componentDecay"): boolean {
  const carriers = book.positions.filter((p) => p.terms.type === "nmd" && (p.terms as Record<string, unknown>)[form] !== undefined);
  return carriers.length > 0 && carriers.every((p) => (p.terms as Record<string, unknown>).replicatingPortfolio !== undefined);
}

export const runMetricStage: StageFn = (env, stage, input) => {
  const produced = stage.produces.filter((t) => RESULT_TYPES.includes(t));
  if (produced.length !== 1) {
    throw new PlanGraphError(
      stage.id,
      `a metric stage must declare exactly one of [${RESULT_TYPES.join(", ")}] in produces, ` +
        `this one declares ${produced.length} ([${stage.produces.join(", ")}])`,
    );
  }
  switch (produced[0]!) {
    case "NiiResult": {
      // A run whose sets bind the component decay form prices volume, not the paid rate,
      // and NII is blank for that model by the map, so the block carries no scenario and its tag says why.
      // A component decay run that binds a credit still computes the base row, for the FTP
      // bridge only, and publishes the block as before.
      if (env.componentDecay === true && env.replicatingPortfolio !== true) return { run: { NiiResult: refusedBlock(env, stage, "nii", { horizonsMonths: [...(env.reportHorizons ?? NII_HORIZONS_MONTHS)], byScenario: [] }) } };
      const cashflows = perScenario<ScenarioCashflows>(env, stage, input, "Cashflow");
      // The cell dictionary rides as the optional fourth argument.
      // Slice three (spec decision 115): the third is the report horizons the
      // run asked for; a run that asked for none passes NII_HORIZONS_MONTHS, the
      // function's own default, explicitly so the dictionary can follow it, and
      // its bytes are what they always were. A requested list only adds windows:
      // net12 and net24 and the 12 and 24 month entries are computed the same way
      // whatever the list holds.
      const nii = env.metrics.get("nii")(
        cashflows,
        env.portfolio.coa,
        env.reportHorizons ?? NII_HORIZONS_MONTHS,
        env.cellPlan.groupingDimensions.length > 0 ? env.cellPlan.cells : undefined,
      );
      // Spec decision 118: the window Results > NII opens on, written only when
      // it is not 60, and here, as the block is built, so it always serializes
      // after byScenario and before the nimPct the assembly may add.
      // A replicating-portfolio run keeps the base row for the FTP bridge only, and the block
      // carries no scenario, with its tag.
      if (env.replicatingPortfolio === true && env.componentDecay === true) {
        env.ftpNiiBase = nii.byScenario.find((s) => s.scenarioId === env.baseScenario.id);
        return { run: { NiiResult: refusedBlock(env, stage, "nii", { horizonsMonths: [...(env.reportHorizons ?? NII_HORIZONS_MONTHS)], byScenario: [] }) } };
      }
      if (env.replicatingPortfolio === true) {
        env.ftpNiiBase = nii.byScenario.find((s) => s.scenarioId === env.baseScenario.id);
        env.notImplemented.push(replicatingPortfolioRefusal("nii", env.creditByScenario === true ? "scenario" : "base-only"));
        env.log({ t: "refuse", error: "nii.replicating-portfolio", ids: { scenarioId: env.baseScenario.id, stageId: stage.id } });
        return { run: { NiiResult: { horizonsMonths: nii.horizonsMonths, byScenario: [] } } };
      }
      if (env.windowMonths !== undefined && env.windowMonths !== DEFAULT_NII_WINDOW_MONTHS) {
        nii.windowMonths = env.windowMonths;
      }
      // Attach the typed shortfalls to their scenarios' NII rows. The field is
      // set only where a dynamic projection reported an under-hit, so a static
      // grid's serialized ScenarioNII shape is unchanged.
      for (const scn of nii.byScenario) {
        const sfs = env.shortfalls.get(scn.scenarioId);
        if (sfs) scn.shortfalls = sfs;
        // Studio A+E contract 24: set only where a dynamic projection ran, so a
        // static scenario's serialized shape is unchanged.
        const nb = env.newBusiness.get(scn.scenarioId);
        if (nb) scn.newBusiness = nb;
      }
      const pluginId = env.metrics.providerOf("nii") ?? UNREGISTERED;
      for (const scn of nii.byScenario) {
        env.log({ t: "resolve", key: "metrics", pluginId, scope: { scenarioId: scn.scenarioId, metricId: "nii", stageId: stage.id } });
      }
      return { run: { NiiResult: nii } };
    }
    case "EveResult": {
      // The component decay form reads a dated rate path, not a curve path, so the block
      // carries no scenario and its tag says why.
      if (env.componentDecay === true) {
        const eve: EVEResult = { discountBasis: env.discountBasis ?? "all-in", durationMode: env.durationMode ?? "per-scenario", byScenario: [] };
        return { run: { EveResult: refusedBlock(env, stage, "eve", eve) } };
      }
      // A replicating-portfolio credit run prices transfer rates, not EVE.
      if (env.replicatingPortfolio === true) {
        env.notImplemented.push(replicatingPortfolioRefusal("eve", env.creditByScenario === true ? "scenario" : "base-only"));
        env.log({ t: "refuse", error: "eve.replicating-portfolio", ids: { scenarioId: env.baseScenario.id, stageId: stage.id } });
        return { run: { EveResult: { discountBasis: env.discountBasis ?? "all-in", durationMode: env.durationMode ?? "per-scenario", byScenario: [] } } };
      }
      const curve = legs(env, stage, input);
      const cashflows = perScenario<ScenarioCashflows>(env, stage, input, "Cashflow");
      const eve: EVEResult = env.metrics.get("eve")({
        portfolio: positionsFor(env, stage, input, env.baseScenario.assumptionSetId),
        cashflows: { grid: env.grid, byScenario: cashflows },
        scenarios: env.request.scenarios,
        baseCurve: curve.base,
        tlp: curve.tlp,
        durationMode: env.durationMode,
        ...(env.discountBasis !== undefined ? { discountBasis: env.discountBasis } : {}),
        rateIndices: env.rateIndices,
        macro: env.macro,
        ...(env.nmdWarmup !== undefined ? { nmdWarmupByScenario: env.nmdWarmup.byScenario } : {}),
        ...(env.depositShiftByScenario !== undefined ? { depositShiftByScenario: env.depositShiftByScenario } : {}),
      });
      const pluginId = env.metrics.providerOf("eve") ?? UNREGISTERED;
      for (const scn of eve.byScenario) {
        env.log({ t: "resolve", key: "metrics", pluginId, scope: { scenarioId: scn.scenarioId, metricId: "eve", stageId: stage.id } });
      }
      return { run: { EveResult: eve } };
    }
    case "GapResult": {
      const buildGap = env.metrics.get("gap");
      const pluginId = env.metrics.providerOf("gap") ?? UNREGISTERED;
      const repricing: GapLadder[] = [];
      const liquidity: GapLadder[] = [];
      // Each ladder's user bucket setting rides as the trailing argument, and only when the run
      // named one, so a run that names none calls the metric with the four arguments it always did.
      const buckets: GapLadderBuckets | undefined =
        env.gapBuckets !== undefined || env.liquidityBuckets !== undefined
          ? {
              ...(env.gapBuckets !== undefined ? { repricing: env.gapBuckets } : {}),
              ...(env.liquidityBuckets !== undefined ? { liquidity: env.liquidityBuckets } : {}),
            }
          : undefined;
      for (const scenario of env.request.scenarios) {
        const series = requireScenario<FamilySeries>(env, stage, input, "RepricingSchedule", scenario.id);
        const book = positionsFor(env, stage, input, scenario.assumptionSetId);
        // The flows setting rides after the buckets, and only when it asks for interest, so a run
        // that asks for nothing new calls the metric with the arguments it always did.
        const gap = wantsLiquidityInterest(env.liquidityFlows)
          ? buildGap(book, scenario.id, series, env.horizonMonths, buckets, env.liquidityFlows)
          : buckets !== undefined
            ? buildGap(book, scenario.id, series, env.horizonMonths, buckets)
            : buildGap(book, scenario.id, series, env.horizonMonths);
        repricing.push(gap.repricing);
        liquidity.push(gap.liquidity);
        // The forecast arm adds new volume to these very series after the walk.
        if (env.forecastGap === true) (env.forecastGapInputs ??= new Map()).set(scenario.id, { series, book });
        env.log({ t: "resolve", key: "metrics", pluginId, scope: { scenarioId: scenario.id, metricId: "gap", stageId: stage.id } });
      }
      return { run: { GapResult: { repricing, liquidity } } };
    }
    case "FtpResult": {
      // Before the NII bridge, which a component decay run leaves empty.
      // Unless every component decay deposit of the base book carries a credit on its path.
      if (env.componentDecay === true && !everyFormPriced(positionsFor(env, stage, input, env.baseScenario.assumptionSetId), "componentDecay")) {
        (env.deferredNotImplemented ??= []).push(componentDecayRefusal("ftp"));
        env.log({ t: "refuse", error: "ftp.component-decay", ids: { scenarioId: env.baseScenario.id, stageId: stage.id } });
        return { run: { FtpResult: undefined } };
      }
      const curve = legs(env, stage, input);
      const book = positionsFor(env, stage, input, env.baseScenario.assumptionSetId);
      const nii = requireRun<NIIResult>(env, stage, input, "NiiResult");
      // A replicating-portfolio run publishes no NII scenario; its bridge reads the row kept.
      const niiBaseRow = env.replicatingPortfolio === true ? env.ftpNiiBase : nii.byScenario.find((s) => s.scenarioId === env.baseScenario.id);
      if (!niiBaseRow) {
        throw new PlanGraphError(
          stage.id,
          `run: base scenario "${env.baseScenario.id}" missing from the NII block; cannot bridge FTP`,
        );
      }
      // Seasoned-book refusal: the FTP module par-matches the
      // FULL original stream in instrument time, so a seasoned position would
      // publish mis-timed accruals and a broken NIM bridge. The block is absent,
      // never mis-timed; the key is still PRESENT on the returned record, which
      // is how an optional metric states its own absence to the walker.
      //
      // The register tag is DEFERRED, not pushed here (Ruling P5): the pre-1c
      // pipeline wrote eve.key-rate.regime-amplifier before ftp.seasoned-book,
      // and both before the attribution tags. Only the post-walk assembly knows
      // the key-rate outcome, so the assembly owns the order and drains this
      // list into env.notImplemented between the two. The `refuse` log entry is
      // written here, where the decision is actually taken.
      const seasonedIds: string[] = [];
      for (const pos of book.positions) {
        if (seasoningOffsetOf(pos.terms) !== 0) seasonedIds.push(pos.id);
      }
      if (seasonedIds.length > 0) {
        const named = seasonedIds.slice(0, 5).join(", ");
        const more = seasonedIds.length > 5 ? ` and ${seasonedIds.length - 5} more` : "";
        const n = seasonedIds.length;
        (env.deferredNotImplemented ??= []).push(
          makeNotImplemented(
            "ftp.seasoned-book",
            `the book carries ${n} seasoned position${n === 1 ? "" : "s"} (${named}${more}); ` +
              `the FTP module prices each position's full original stream and does not yet take a ` +
              `seasoned position's offset into account, so the ftp block is left out rather than ` +
              `published mis-timed.`,
          ),
        );
        env.log({
          t: "refuse",
          error: "ftp.seasoned-book",
          ids: { scenarioId: env.baseScenario.id, positions: String(seasonedIds.length), stageId: stage.id },
        });
        return { run: { FtpResult: undefined } };
      }
      // The FTP module prices an nmd-b on its S-curve at the path's step-0 rate and reads
      // neither the intercept, the dampening nor the base state of a full beta form, so the block is left out
      // rather than published on a schedule the deposit does not run.
      // A full-form deposit that carries a replicating-portfolio credit is priced on it instead.
      const fullFormIds = book.positions
        .filter((p) => p.terms.type === "nmd-b" && p.terms.fullBeta !== undefined && p.terms.replicatingPortfolio === undefined)
        .map((p) => p.id);
      if (fullFormIds.length > 0) {
        const n = fullFormIds.length;
        (env.deferredNotImplemented ??= []).push(
          makeNotImplemented(
            "ftp.full-beta-form",
            `the book carries ${n} deposit${n === 1 ? "" : "s"} on the full beta form (${fullFormIds.slice(0, 5).join(", ")}); ` +
              "the FTP module prices a deposit on its S-curve alone and does not read the form's intercept, dampening " +
              "or base state, so the ftp block is left out rather than published on another schedule.",
          ),
        );
        env.log({
          t: "refuse",
          error: "ftp.full-beta-form",
          ids: { scenarioId: env.baseScenario.id, positions: String(n), stageId: stage.id },
        });
        return { run: { FtpResult: undefined } };
      }
      const ftp: FtpResult = env.metrics.get("ftp")({
        portfolio: book,
        scenarios: env.request.scenarios,
        baseScenarioId: env.baseScenario.id,
        curve: curve.base,
        tlp: curve.tlp,
        path: requireScenario<RatePath>(env, stage, input, "RatePath", env.baseScenario.id),
        horizonMonths: env.horizonMonths,
        niiBase: niiBaseRow,
        rateIndices: env.rateIndices,
        macro: env.macro,
        // S3a-2 fix round (M2): the deposits are built on the base scenario's warmup history, as the projection's are.
        ...(env.nmdWarmup !== undefined ? { nmdWarmup: env.nmdWarmup.byScenario.get(env.baseScenario.id)! } : {}),
        // Read only by a replicating-portfolio credit with a steepener.
        ...(env.replicatingPortfolio === true ? { snapshot: env.request.marketSnapshot } : {}),
        // The base scenario's new-volume tranches, kept only when its rules carry a product template.
        ...(env.newVolumeTranches !== undefined ? { newVolume: env.newVolumeTranches, newVolumeWindowMonths: env.windowMonths ?? DEFAULT_NII_WINDOW_MONTHS } : {}),
        // Every scenario's deposit shift and own curve, read only by a credit on the balance
        // path or a capped life. The FTP block's series stay on the base scenario.
        ...(env.creditByScenario === true
          ? {
              creditScenarios: env.request.scenarios.map((s) => ({
                scenarioId: s.id,
                shiftPct: env.depositShiftByScenario?.get(s.id) ?? 0,
                curve: shockedCurve(curve.base, s.rateSpec),
              })),
            }
          : {}),
      });
      env.log({
        t: "resolve",
        key: "metrics",
        pluginId: env.metrics.providerOf("ftp") ?? UNREGISTERED,
        scope: { scenarioId: env.baseScenario.id, metricId: "ftp", stageId: stage.id },
      });
      return { run: { FtpResult: ftp } };
    }
    default:
      throw new PlanGraphError(stage.id, `unhandled metric result type "${produced[0]!}"`);
  }
};
