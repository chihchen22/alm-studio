/**
 * Gap engines: repricing and liquidity ladders bucketed into the standard time
 * bands, rolled up the COA tree, with cumulative gap per band.
 */
export { buildBands, buildUserBands, bandForBucket, GAP_BAND_LABELS } from "./bands";
export {
  accumulateGapPosition,
  buildGapFromSeries,
  buildGapResult,
  buildScenarioGap,
  createFamilySeries,
  type BucketSeriesPair,
  type CellSeriesView,
  type FamilySeries,
} from "./gapEngine";
export { computeNextResetLadder } from "./nextResetLadder";
export { computeFixedRateLadder, rateLockOf } from "./fixedRateLadder";
export {
  gapBucketsConfigError,
  liquidityFlowsConfigError,
  wantsLiquidityInterest,
  type GapLadderBuckets,
} from "./bucketOptions";
