/**
 * Everything the envelope needs that is NOT a stage (last
 * paragraph): the family WAL stamp, the two opt-in EVE blocks, attribution, the
 * provenance stamp. It reads the metric artifacts the walk left on the shelf and
 * computes no cash flow of its own.
 *
 * The walker and this function are the only shelf readers; a stage function
 * never touches it.
 */
import type { ArtifactScope, ContractTypeName } from "../../contracts/plan";
import type { PortfolioSpec } from "../../contracts/position";
import type { CustomMetricResult } from "../../contracts/customMetric";
import type { KernelProvenanceRef } from "../../contracts/provenance";
import type {
  BucketedCashflowResult,
  EVEResult,
  FtpResult,
  GapResult,
  NIIResult,
  ScenarioCashflows,
} from "../../contracts/results";
import type { RunLogEntry } from "../../contracts/runLog";
import type { Instrument, RatePath } from "@alm/kernel";
import type { RunResult } from "../../contracts/run";
import { computeEveChannels } from "../../eve/channels";
import { computeKeyRateDurations, regimeAmplifiedPositionIds } from "../../eve/keyRate";
import { niiNimPct, totalAssetNotional } from "../../nii/computeNII";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { ConstantCprFixedLoan } from "../../loanPrepay";
import { computeSegBlock, type PositionSegRow } from "../../seg/computeSeg";
import { segConstants } from "../../seg/settings";
import { computeNextResetLadder } from "../../gap/nextResetLadder";
import { computeFixedRateLadder } from "../../gap/fixedRateLadder";
import { computeForecastGap } from "../../gap/forecastGap";
import { computeGoingConcernEve, defaultGoingConcernMonths } from "../../eve/goingConcern";
import { DEFAULT_NII_WINDOW_MONTHS } from "../../nii/reportHorizons";
import { runBetaAtR0 } from "../../nmd/runEntry";
import { componentDecayWalCorrections, componentDecayWalNote, stampComponentDecayWal } from "../../nmd/componentDecayRun";
import {
  LIQUIDITY_STRESS_HORIZON_MONTHS,
  computeLiquidityStress,
  ladderLegs,
  liquidityRoleOf,
} from "../../liquidity/stressLadder";
import { computeSurvivalPath } from "../../liquidity/survivalPath";
import { CdBookInstrument } from "../../cd";
import { seasoningOffsetOf } from "../../portfolio/seasoning";
import { COMMITMENT_INSTRUMENT_TYPE } from "../../commitment/offBalanceSheet";
import { SWAP_INSTRUMENT_TYPE } from "../../swap/derivatives";
import { stampFamilyWal } from "../../portfolio";
import { toViewResults } from "../../portfolio/cells";
import { assembleProvenance } from "../../provenance";
import { makeNotImplemented } from "../../runtime/notImplemented";
import { buildRunAttribution } from "../attribution";
import { PlanGraphError } from "../executorErrors";
import type { InstrumentEnvironment } from "../instrumentEnvironment";
import type { Shelf } from "../shelf";
import type { StageRunEnv } from "./types";

const RUN: ArtifactScope = { kind: "run" };

/** Steps of the base path the SEG block reads: 361, as the book builds it (DeterministicRatePath(curve, 361)). */
const SEG_PATH_STEPS = 361;

export interface AssembleInput {
  env: StageRunEnv;
  shelf: Shelf;
  /** Which stage produced each run-scope metric result, from the walk. */
  metricProducers: ReadonlyMap<ContractTypeName, string>;
  /** The stages that produced a custom metric, in walk order. Absent means none. */
  customProducers?: readonly string[];
  /** The stage the NII metric's Cashflow edge resolved to: the primary series. */
  primaryCashflowProducer: string;
  /**
   * Per stage: which producer each consumed type resolved to, as the walk
   * resolved it (`ExecutedPlan.resolution`). The opt-in EVE blocks read the EVE
   * stage's own `Position` edge through it, so they measure exactly the book the
   * EVE block measured (Ruling P4). Optional: a caller that has no resolution
   * gets the walk-order LAST `Position` producer at the base assumption-set
   * scope instead, which is the last link of a behavioral chain and therefore
   * the fully overlaid book the pre-1c pipeline used. Never the first link.
   */
  resolution?: ReadonlyMap<string, ReadonlyMap<ContractTypeName, string>>;
  runLog: RunLogEntry[];
  profileHash?: string;
  engineVersion: string;
  kernel: KernelProvenanceRef;
  schemaVersion: string;
  /**
   * Observational seam for the per-position results pass; see instrumentEnvironment.ts. A build failure
   * reaches it as the Error itself, and the run still completes.
   */
  onInstrumentEnvironment?: (environment: InstrumentEnvironment | Error) => void;
}

export function assembleRunResult(input: AssembleInput): RunResult {
  const { env, shelf, metricProducers } = input;
  const producerOf = (type: ContractTypeName): string => {
    const id = metricProducers.get(type);
    if (id === undefined) {
      throw new PlanGraphError(
        null,
        `run: the walk produced no "${type}"; the compiler's required-metric rule should have refused this plan`,
      );
    }
    return id;
  };

  // Family WAL: stamped on the FINAL per-scenario series, after the
  // dynamic new-business merge, so the reported WAL covers exactly the principal
  // the envelope carries. Nothing computes FROM walYears; it is an envelope
  // field, which is why stamping it here rather than before the NII stage moves
  // no number.
  const primaryCFs: ScenarioCashflows[] = env.request.scenarios.map((s) =>
    shelf.get<ScenarioCashflows>("Cashflow", { kind: "scenario", scenarioId: s.id }, input.primaryCashflowProducer),
  );
  for (const scn of primaryCFs) stampFamilyWal(scn);
  // On a run whose sets bind the component decay form, a family holding such deposits reads
  // the full runoff (the exact tail past the grid, the overnight remainder at zero life), and the note says so.
  if (env.componentDecay === true) {
    const restamped = new Set<string>();
    for (const scn of primaryCFs) {
      const set = env.request.scenarios.find((s) => s.id === scn.scenarioId)!.assumptionSetId;
      const corrections = componentDecayWalCorrections(effectiveBookFor(input, set), env.depositShiftByScenario?.get(scn.scenarioId) ?? 0, env.horizonMonths);
      for (const id of stampComponentDecayWal(scn, corrections)) restamped.add(id);
    }
    if (restamped.size > 0) env.notImplemented.push(componentDecayWalNote([...restamped], env.horizonMonths));
  }
  // The cell dictionary rides ONCE on the cashflow block; every
  // cellId in every block indexes into it.
  const hasCells = env.cellPlan.groupingDimensions.length > 0;
  const cashflows: BucketedCashflowResult = {
    grid: env.grid,
    byScenario: primaryCFs,
    ...(hasCells ? { cells: env.cellPlan.cells } : {}),
  };

  const nii = shelf.get<NIIResult>("NiiResult", RUN, producerOf("NiiResult"));
  const eve = shelf.get<EVEResult>("EveResult", RUN, producerOf("EveResult"));
  const gap = shelf.get<GapResult>("GapResult", RUN, producerOf("GapResult"));
  const ftpProducer = metricProducers.get("FtpResult");
  const ftp =
    ftpProducer !== undefined && shelf.has("FtpResult", RUN, ftpProducer)
      ? shelf.get<FtpResult | undefined>("FtpResult", RUN, ftpProducer)
      : undefined;

  // Opt-in EVE analytics, OFF by default. Both are cost-labeled on the
  // pipeline context and regenerate the book many times over. Additive fields on
  // the eve block; the standard grid's serialized shape is unchanged when the
  // flags are absent.
  if (env.keyRate) {
    const book = effectiveBaseBook(input);
    const amplified = regimeAmplifiedPositionIds(book);
    if (amplified.length > 0) {
      // Regime-amplifier refusal: no constant warmup shift pins
      // a shaped node bump's excursion, so the decomposition's additivity gate
      // cannot pass. The run proceeds and the keyRate block is omitted.
      const named = amplified.slice(0, 5).join(", ");
      const more = amplified.length > 5 ? ` (and ${amplified.length - 5} more)` : "";
      env.notImplemented.push(
        makeNotImplemented(
          "eve.key-rate.regime-amplifier",
          `key-rate durations were requested but the book carries ${amplified.length} ` +
            `position(s) with a nonzero one-sided regime amplifier (${named}${more}); ` +
            `no constant warmup shift pins a shaped node bump's r − MA excursion, so ` +
            `the decomposition's additivity gate cannot pass and the keyRate block is ` +
            `omitted rather than published non-convergent.`,
        ),
      );
      env.log({
        t: "refuse",
        error: "eve.key-rate.regime-amplifier",
        ids: { scenarioId: env.baseScenario.id, positions: String(amplified.length) },
      });
    } else {
      eve.keyRate = computeKeyRateDurations({
        portfolio: book,
        scenarioId: env.baseScenario.id,
        curve: baseLeg(input),
        tlp: allInLeg(input),
        horizonMonths: env.horizonMonths,
        ...(env.discountBasis !== undefined ? { discountBasis: env.discountBasis } : {}),
        bumpBp: typeof env.keyRate === "object" ? env.keyRate.bumpBp : undefined,
        rateIndices: env.rateIndices,
        macro: env.macro,
      });
    }
  }
  if (env.eveChannels) {
    eve.channels = computeEveChannels({
      portfolio: effectiveBaseBook(input),
      scenarios: env.request.scenarios,
      baseCurve: baseLeg(input),
      tlp: allInLeg(input),
      horizonMonths: env.horizonMonths,
      ...(env.discountBasis !== undefined ? { discountBasis: env.discountBasis } : {}),
      rateIndices: env.rateIndices,
      macro: env.macro,
    });
  }

  // Going-concern EVE, written only on a run that opted in, after every run-off block.
  // It reads the run-off EVE the walk produced and the tranches the balance stage kept, and moves neither.
  if (env.goingConcernEve === true && eve.byScenario.length > 0) {
    eve.goingConcern = computeGoingConcernEve({
      eve,
      coa: env.portfolio.coa,
      positions: effectiveBaseBook(input).positions,
      scenarios: env.request.scenarios,
      tranchesByScenario: env.allNewVolumeTranches,
      baseCurve: baseLeg(input),
      tlp: allInLeg(input),
      // Ruling 2026-11-03: 12 months by default, the NII window when shorter; the run's span when it names one.
      span: { months: env.goingConcernSpan ?? defaultGoingConcernMonths(Math.min(env.windowMonths ?? DEFAULT_NII_WINDOW_MONTHS, env.horizonMonths)) },
    });
  }

  // The deferred tags land here, AFTER the key-rate outcome and BEFORE the
  // attribution tags, which is the order the pre-1c pipeline wrote and the order
  // the golden compares (Ruling P5). Today the one deferring arm is FTP.
  if (env.deferredNotImplemented !== undefined) {
    for (const tag of env.deferredNotImplemented) env.notImplemented.push(tag);
    env.deferredNotImplemented.length = 0;
  }

  const attribution = buildRunAttribution(nii, eve, env.request.scenarios, env.portfolio.coa, env.baseScenario);
  for (const tag of attribution.notImplemented) env.notImplemented.push(tag);

  const provenance = assembleProvenance(env.request, env.portfolio, {
    engineVersion: input.engineVersion,
    kernel: input.kernel,
    ...(input.profileHash !== undefined ? { profileHash: input.profileHash } : {}),
    runLog: input.runLog,
  });

  const result: RunResult = {
    schemaVersion: input.schemaVersion,
    provenance,
    cashflows,
    nii,
    eve,
    gap,
    attribution: attribution.result,
    ...(hasCells ? { views: toViewResults(env.cellPlan) } : {}),
    // Schema 1.9.0: written only when the run named a convention.
    ...(env.nmdConvention !== undefined ? { nmdConvention: env.nmdConvention } : {}),
    ...(env.parentOf !== undefined ? { parentOf: env.parentOf } : {}),
    // Written only when the run named a deposit warmup.
    ...(env.nmdWarmup !== undefined ? { nmdWarmup: env.nmdWarmup.record } : {}),
    // Written only when the run named a model convention.
    ...(env.modelConvention !== undefined ? { modelConvention: env.modelConvention } : {}),
    notImplemented: env.notImplemented,
  };
  // Set only when computed, so the in-memory object matches the serialized shape.
  if (ftp !== undefined) result.ftp = ftp;

  // Schema 1.9.0 (E7): the SEG block and the engine-convention NIM,
  // both written only on a run that opted in, so a default run is
  // byte-identical. The block reads the book the EVE block measured and the
  // base scenario's deterministic path, rebuilt through the same registry the
  // walk used at the book's 361 steps (the base path's own length is the run
  // grid's horizon, which may stop short of the 61 months the block reads).
  let perPositionSeg: ReadonlyMap<string, PositionSegRow> | undefined;
  if (env.seg === true) {
    const book = effectiveBaseBook(input);
    const modelId = env.baseScenario.ratePathModel ?? "deterministic";
    // The knobs, SEG_DEFAULTS where absent; a horizon past 360 months needs a longer path.
    const constants = segConstants(env.segSettings);
    const overlay = env.segSettings?.cprOverlay;
    const basePath = env.ratePaths.get(modelId)(baseLeg(input), env.baseScenario, Math.max(SEG_PATH_STEPS, constants.horizonMonths + 1));
    // The existing deposits read the UNSHIFTED flat history (the book
    // does not re-level a deposit history for its own small NII and SEG
    // shocks). Under the original convention the replacement vintages the kernel
    // builds keep its own warmup; slice K1 (D6) hands them the same
    // history the existing deposits read.
    const factoryOptions = {
      rateIndices: env.rateIndices,
      macro: env.macro,
      ...(env.nmdWarmup !== undefined ? { nmdWarmup: env.nmdWarmup.unshifted } : {}),
    };
    const vintageHistory = env.corrections?.segVintageHistory === true ? env.nmdWarmup?.unshifted : undefined;
    const segBlock = computeSegBlock({
      book,
      basePath,
      scenarioId: env.baseScenario.id,
      ...constants,
      ...(vintageHistory !== undefined ? { depositHistory: vintageHistory } : {}),
      makeInstrument: (p) => makeInstrument(p.terms, factoryOptions),
      ...(overlay !== undefined ? { cprOverlay: new Map(overlay.map((r) => [r.familyId, { upAnnualCpr: r.upAnnualCpr, downAnnualCpr: r.downAnnualCpr }])) } : {}),
    });
    result.seg = segBlock.result;
    perPositionSeg = segBlock.perPosition;
    const nimPct = niiNimPct(nii, env.baseScenario.id, totalAssetNotional(env.portfolio));
    if (nimPct !== undefined) nii.nimPct = nimPct;
  }

  // The next-reset ALCO repricing ladder, written only on a run that
  // opted in. It reads the run's book (the transformed one on a regulatory run)
  // and the beta at r0 through the same reader the regulatory transform uses,
  // so the repricing slice of a deposit is the beta the run split it on.
  if (env.nextResetGap === true) {
    const { betaAtR0 } = runBetaAtR0(env.portfolio, env.request, env.baseScenario, env.setById, env.curves, env.ratePaths);
    gap.nextReset = computeNextResetLadder(env.portfolio, betaAtR0);
  }

  // The forecast gap arm, written only on a run that opted in. It copies the very
  // contractual series the gap metric banded, adds each scenario's new volume, and bands the copy with the same
  // builder and the same bucket and flows settings; the contractual ladders are left as they are.
  if (env.forecastGap === true && env.forecastGapInputs !== undefined) {
    const buckets =
      env.gapBuckets !== undefined || env.liquidityBuckets !== undefined
        ? {
            ...(env.gapBuckets !== undefined ? { repricing: env.gapBuckets } : {}),
            ...(env.liquidityBuckets !== undefined ? { liquidity: env.liquidityBuckets } : {}),
          }
        : undefined;
    gap.forecast = computeForecastGap(env.request.scenarios, env.forecastGapInputs, env.allNewVolumeTranches, env.horizonMonths, buckets, env.liquidityFlows);
  }

  // The fixed-rate (rate-locked) gap ladder, written only on a run
  // that opted in. Same book and same base path as the SEG block, so a
  // prepayment overlay the run applied moves principal here exactly as it does
  // in the run's own cash flows; only rate-locked positions are regenerated.
  if (env.fixedRateGap === true) {
    const book = effectiveBaseBook(input);
    const modelId = env.baseScenario.ratePathModel ?? "deterministic";
    const basePath = env.ratePaths.get(modelId)(baseLeg(input), env.baseScenario, SEG_PATH_STEPS);
    const factoryOptions = { rateIndices: env.rateIndices, macro: env.macro };
    gap.fixedRate = computeFixedRateLadder(book, env.baseScenario.id, (p) =>
      makeInstrument(p.terms, factoryOptions).generateCashflows(basePath),
    );
  }

  // Schema 1.9.0: the liquidity stress ladder, written only on a run
  // that opted in. Same book and same base path as the SEG block; principal is
  // regenerated per inflow-asset and wholesale position (the only roles whose
  // cash flows the ladder reads) and banded as the liquidity gap bands it:
  // month monthOffset + the seasoning offset, months 1..12 kept. An
  // off-balance-sheet commitment and a swap carry no principal cash here, as in
  // the gap fold; the undrawn face is a stated constant of the opt-in.
  if (env.liquidityStress !== undefined) {
    const book = effectiveBaseBook(input);
    // Principal is banded to the survival path's length when the setup asks for one; the ladder
    // reads its first 12 months, the same numbers as before.
    const survival = env.liquidityStress.survivalPath;
    const horizon = Math.max(LIQUIDITY_STRESS_HORIZON_MONTHS, survival?.horizonMonths ?? 0);
    const modelId = env.baseScenario.ratePathModel ?? "deterministic";
    const basePath = env.ratePaths.get(modelId)(baseLeg(input), env.baseScenario, SEG_PATH_STEPS);
    const factoryOptions = { rateIndices: env.rateIndices, macro: env.macro };
    const principalByPosition = new Map<string, number[]>();
    // The second inflow line, for an inflow asset whose constant CPR names a stress speed.
    const stressPrincipalByPosition = new Map<string, number[]>();
    // S3d fix round: a cd book's principal split into maturities and early withdrawals, banded the same way.
    const earlyByPosition = new Map<string, number[]>();
    const bandedSplit = (inst: CdBookInstrument, off: number): { maturity: number[]; early: number[] } => {
      const maturity = new Array<number>(horizon).fill(0);
      const early = new Array<number>(horizon).fill(0);
      for (const r of inst.principalSplit(basePath)) {
        const k = r.monthOffset - 1 + off;
        if (k < 0 || k >= horizon) continue;
        maturity[k]! += r.maturity;
        early[k]! += r.early;
      }
      return { maturity, early };
    };
    const banded = (inst: Instrument, off: number): number[] => {
      const series = new Array<number>(horizon).fill(0);
      for (const cf of inst.generateCashflows(basePath)) {
        const k = cf.monthOffset - 1 + off;
        if (k < 0 || k >= horizon) continue;
        series[k]! += cf.principalPaid;
      }
      return series;
    };
    for (const p of book.positions) {
      const role = liquidityRoleOf(p);
      if (role !== "inflow-asset" && role !== "wholesale" && role !== "term-deposit") continue;
      const type = p.terms.type as string;
      if (type === COMMITMENT_INSTRUMENT_TYPE || type === SWAP_INSTRUMENT_TYPE) continue;
      const off = seasoningOffsetOf(p.terms);
      const inst = makeInstrument(p.terms, factoryOptions);
      if (role === "term-deposit" && (inst as unknown) instanceof CdBookInstrument) {
        const split = bandedSplit(inst as unknown as CdBookInstrument, off);
        principalByPosition.set(p.id, split.maturity);
        earlyByPosition.set(p.id, split.early);
        continue;
      }
      principalByPosition.set(p.id, banded(inst, off));
      if (role === "inflow-asset" && inst instanceof ConstantCprFixedLoan && inst.terms.prepay.stressAnnualCpr !== undefined) {
        stressPrincipalByPosition.set(p.id, banded(inst.atStress(), off));
      }
    }
    const { survivalPath: _survival, ...ladderOptions } = env.liquidityStress;
    void _survival;
    const ladder = computeLiquidityStress({
      book,
      principalByPosition,
      ...(earlyByPosition.size > 0 ? { earlyByPosition } : {}),
      ...(stressPrincipalByPosition.size > 0 ? { stressPrincipalByPosition } : {}),
      ...ladderOptions,
      horizonMonths: LIQUIDITY_STRESS_HORIZON_MONTHS,
    });
    if (survival !== undefined) {
      const legs = ladderLegs(book, principalByPosition, stressPrincipalByPosition.size > 0 ? stressPrincipalByPosition : undefined, horizon, earlyByPosition);
      const severe = ladder.scenarios.find((x) => x.id === "severe")!;
      ladder.survivalPath = computeSurvivalPath({
        scenarioId: "severe",
        params: severe.params,
        legs: {
          horizonMonths: horizon,
          pools: legs.pools,
          inflow: legs.inflow,
          inflowStress: legs.inflowStress,
          wholesaleMaturities: legs.wholesale,
          cdMaturities: legs.cd,
          cdEarlyWithdrawals: legs.early,
          undrawnFace: ladder.undrawnFace,
        },
        horizonMonths: survival.horizonMonths,
        buffer: ladder.buffer,
        ...(survival.facility !== undefined ? { facility: survival.facility } : {}),
      });
    }
    result.liquidityStress = ladder;
  }

  // Schema 1.9.0: hand the per-position results pass the books, paths
  // and curve legs this run used. Observational: nothing flows back. The build is
  // guarded: a plan that left a scenario without a path must not fail a
  // finished run, so the observer receives the error as a value and the pass
  // reports it by name.
  if (input.onInstrumentEnvironment !== undefined) {
    let environment: InstrumentEnvironment | Error;
    try {
      environment = instrumentEnvironmentOf(input, perPositionSeg);
    } catch (err) {
      environment = err instanceof Error ? err : new Error(String(err));
    }
    input.onInstrumentEnvironment(environment);
  }

  // Piece 3b, widened in 5a: one entry per custom producer, keyed by the
  // metric's own id, in walk order. Written ONLY when a stage produced one, so
  // a run that names no custom metric stage carries no `custom` key at all.
  // Never an empty object: an empty arm reads as a metric that ran and found
  // nothing.
  // The first stage id that published each metric id, so a duplicate names the
  // PAIR rather than only whichever stage the walk reached second.
  const customFirstProducer = new Map<string, string>();
  for (const producer of input.customProducers ?? []) {
    if (!shelf.has("CustomMetricResult", RUN, producer)) continue;
    const custom = shelf.get<CustomMetricResult>("CustomMetricResult", RUN, producer);
    result.custom ??= {};
    if (result.custom[custom.metricId] !== undefined) {
      const first = customFirstProducer.get(custom.metricId)!;
      throw new PlanGraphError(
        producer,
        `run: two custom metric stages, "${first}" and "${producer}", published "${custom.metricId}"; the compiler's one-stage-per-metric rule should have refused this plan`,
      );
    }
    customFirstProducer.set(custom.metricId, producer);
    result.custom[custom.metricId] = custom;
  }
  return result;
}

/**
 * The effective base-scenario book the EVE stage ran on (Ruling P4). First
 * choice: the producer the EVE stage's own `Position` edge resolved to, so the
 * opt-in blocks and the EVE block agree on which book they measured. Fallback,
 * for a caller with no resolution: the walk-order LAST `Position` producer at
 * the base assumption-set scope, which is the last link of the behavioral chain
 * and therefore the fully overlaid book pre-1c measured. NEVER the first link,
 * which on a two-or-more-link chain is a partially overlaid book. A plan with no
 * behavioral stage leaves no `Position` on the shelf at all and falls through to
 * the raw context book, which is what such a run has always measured.
 */
function effectiveBaseBook(input: AssembleInput): PortfolioSpec {
  return effectiveBookFor(input, input.env.baseScenario.assumptionSetId);
}

/** The same rule for any assumption set on the axis (see effectiveBaseBook). */
function effectiveBookFor(input: AssembleInput, assumptionSetId: string): PortfolioSpec {
  const { env, shelf } = input;
  const scope: ArtifactScope = { kind: "assumptionSet", assumptionSetId };

  const eveStageId = input.metricProducers.get("EveResult");
  const resolved = eveStageId === undefined ? undefined : input.resolution?.get(eveStageId)?.get("Position");
  if (resolved !== undefined) {
    if (shelf.has("Position", scope, resolved)) return shelf.get<PortfolioSpec>("Position", scope, resolved);
    if (shelf.has("Position", RUN, resolved)) return shelf.get<PortfolioSpec>("Position", RUN, resolved);
  }

  let last: string | undefined;
  for (const entry of shelf.entries()) {
    if (entry.type !== "Position") continue;
    if (entry.scope.kind !== "assumptionSet") continue;
    if (entry.scope.assumptionSetId !== assumptionSetId) continue;
    last = entry.producerStageId;
  }
  if (last !== undefined) return shelf.get<PortfolioSpec>("Position", scope, last);
  return env.portfolio;
}

/**
 * A run-scope curve leg the opt-in EVE blocks discount on. Same shape as
 * `effectiveBaseBook` and for the same reason (Ruling P4 extended to the legs):
 * FIRST the producer the EVE stage's own edge resolved to, so the opt-in blocks
 * discount on exactly the leg the EVE block discounted on. Two bootstrap stages
 * in one plan are legal, so "the first run-scope entry of this type" could hand
 * the key-rate and channel blocks a curve the EVE stage never read. The
 * fallback, for a caller with no resolution, is the walk-order LAST run-scope
 * producer rather than the first, matching `effectiveBaseBook`; on every shipped
 * plan there is exactly one producer of each leg, so neither rule moves a number
 * there.
 */
function runArtifact<T>(input: AssembleInput, type: ContractTypeName, what: string): T {
  const { shelf } = input;

  const eveStageId = input.metricProducers.get("EveResult");
  const resolved = eveStageId === undefined ? undefined : input.resolution?.get(eveStageId)?.get(type);
  if (resolved !== undefined && shelf.has(type, RUN, resolved)) {
    return shelf.get<T>(type, RUN, resolved);
  }

  let last: { type: ContractTypeName; scope: ArtifactScope; producerStageId: string } | undefined;
  for (const entry of shelf.entries()) {
    if (entry.type !== type || entry.scope.kind !== "run") continue;
    last = entry;
  }
  if (last !== undefined) return shelf.get<T>(last.type, last.scope, last.producerStageId);
  throw new PlanGraphError(
    null,
    `run: no stage produced ${what}; the opt-in EVE analytics have nothing to measure against`,
  );
}

/** The risk-free leg the shocks are built from. */
function baseLeg(input: AssembleInput): Parameters<typeof computeEveChannels>[0]["baseCurve"] {
  return runArtifact(input, "ZeroCurve", "a ZeroCurve");
}

/** The all-in funding leg the discounting uses. */
function allInLeg(input: AssembleInput): Parameters<typeof computeEveChannels>[0]["tlp"] {
  return runArtifact(input, "FundingCurve", "a FundingCurve (the all-in funding leg)");
}

/**
 * The environment the per-position results pass reads: one effective
 * book per assumption set a scenario references, each scenario's rate path as
 * the walk left it on the shelf, and the two curve legs. A scenario with no
 * path on the shelf is a plan that did not project it, and is refused by name.
 */
function instrumentEnvironmentOf(
  input: AssembleInput,
  perPositionSeg: ReadonlyMap<string, PositionSegRow> | undefined,
): InstrumentEnvironment {
  const { env, shelf } = input;
  const booksBySet = new Map<string, PortfolioSpec>();
  for (const id of env.assumptionSetIds) booksBySet.set(id, effectiveBookFor(input, id));
  const ratePaths = new Map<string, RatePath>();
  for (const scenario of env.request.scenarios) {
    let producer: string | undefined;
    for (const entry of shelf.entries()) {
      if (entry.type !== "RatePath") continue;
      if (entry.scope.kind !== "scenario" || entry.scope.scenarioId !== scenario.id) continue;
      producer = entry.producerStageId;
    }
    if (producer === undefined) {
      throw new PlanGraphError(
        null,
        `run: no stage left a RatePath for scenario "${scenario.id}", so the per-position results pass has no path to project it on`,
      );
    }
    ratePaths.set(scenario.id, shelf.get<RatePath>("RatePath", { kind: "scenario", scenarioId: scenario.id }, producer));
  }
  return {
    baseScenarioId: env.baseScenario.id,
    booksBySet,
    ratePaths,
    baseCurve: baseLeg(input),
    tlp: allInLeg(input),
    discountBasis: env.discountBasis ?? "all-in",
    ...(env.rateIndices !== undefined ? { rateIndices: env.rateIndices } : {}),
    ...(env.macro !== undefined ? { macro: env.macro } : {}),
    ...(perPositionSeg !== undefined ? { perPositionSeg } : {}),
    ...(env.nmdWarmup !== undefined ? { nmdWarmupByScenario: env.nmdWarmup.byScenario } : {}),
    ...(env.depositShiftByScenario !== undefined ? { depositShiftByScenario: env.depositShiftByScenario } : {}),
  };
}
