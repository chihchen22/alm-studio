/**
 * The engine options a deterministic child hands the pipeline, read from the stored engine context
 * (request.json `engineContext`). One name per option across the setup, the run route, the stored context and
 * the pipeline context, so this function is a copy: every key is present only when the stored context carries
 * it (or carries it true), so a run that asked for nothing builds the context it always did.
 *
 * Kept out of runnerEntry.ts, which runs its main on import, so a test can hold the launch path's options
 * against the in-process path's (spec decision 111).
 */
import type { RunPipelineContext } from "@alm/engine";
import type { StoredEngineContext } from "./types";

export type PipelineOptions = Pick<
  RunPipelineContext,
  | "durationMode"
  | "shards"
  | "keyRate"
  | "eveChannels"
  | "discountBasis"
  | "nmdConvention"
  | "nmdWarmup"
  | "modelConvention"
  | "seg"
  | "segSettings"
  | "nextResetGap"
  | "fixedRateGap"
  | "forecastGap"
  | "goingConcernEve"
  | "goingConcernSpan"
  | "liquidityStress"
  | "gapBuckets"
  | "liquidityBuckets"
  | "liquidityFlows"
  | "reportHorizons"
  | "windowMonths"
>;

export function pipelineOptionsOf(engineContext: StoredEngineContext): PipelineOptions {
  return {
    durationMode: engineContext.durationMode,
    shards: engineContext.shards,
    // The opt-in EVE analytics, present only when the submission asked for them.
    ...(engineContext.keyRate === true ? { keyRate: true } : {}),
    ...(engineContext.eveChannels === true ? { eveChannels: true } : {}),
    // Spec E3: present only when the submission chose a basis other than "all-in".
    ...(engineContext.discountBasis !== undefined ? { discountBasis: engineContext.discountBasis } : {}),
    // Spec E2: present only when the submission chose the regulatory deposit convention.
    ...(engineContext.nmdConvention !== undefined ? { nmdConvention: engineContext.nmdConvention } : {}),
    // The deposit warmup, present only when the submission carried it.
    ...(engineContext.nmdWarmup !== undefined ? { nmdWarmup: engineContext.nmdWarmup } : {}),
    // The model convention, present only when the submission named one.
    ...(engineContext.modelConvention !== undefined ? { modelConvention: engineContext.modelConvention } : {}),
    // Spec E1: the SEG block, present only when the submission asked for it.
    ...(engineContext.seg === true ? { seg: true } : {}),
    // The SEG knobs, present only when the submission carried them.
    ...(engineContext.segSettings !== undefined ? { segSettings: engineContext.segSettings } : {}),
    // The next-reset ALCO ladder, present only when the submission asked for it.
    ...(engineContext.nextResetGap === true ? { nextResetGap: true } : {}),
    // The fixed-rate gap ladder, present only when the submission asked for it.
    ...(engineContext.fixedRateGap === true ? { fixedRateGap: true } : {}),
    // The forecast gap arm and going-concern EVE, present only when the submission asked for them.
    ...(engineContext.forecastGap === true ? { forecastGap: true } : {}),
    ...(engineContext.goingConcernEve === true ? { goingConcernEve: true } : {}),
    ...(engineContext.goingConcernSpan !== undefined ? { goingConcernSpan: engineContext.goingConcernSpan } : {}),
    // Spec E5: the liquidity stress ladder, present only when the submission carried it.
    ...(engineContext.liquidityStress !== undefined ? { liquidityStress: engineContext.liquidityStress } : {}),
    // The user bucket settings and the NII report horizons, present only when the submission carried them.
    ...(engineContext.gapBuckets !== undefined ? { gapBuckets: engineContext.gapBuckets } : {}),
    ...(engineContext.liquidityBuckets !== undefined ? { liquidityBuckets: engineContext.liquidityBuckets } : {}),
    // The interest-inclusive liquidity ladder, present only when the submission asked for it.
    ...(engineContext.liquidityFlows !== undefined ? { liquidityFlows: engineContext.liquidityFlows } : {}),
    ...(engineContext.reportHorizons !== undefined ? { reportHorizons: engineContext.reportHorizons } : {}),
    // Slice three (decision 118): the NII window, present only when the submission carried one other than 60.
    ...(engineContext.windowMonths !== undefined ? { windowMonths: engineContext.windowMonths } : {}),
  };
}
