/**
 * The user bucket settings a run may ask of its gap ladders (spec decisions 107
 * to 111), and the one check of their shape and bound. The run route calls the check on
 * `engineOptions.gapBuckets` and `engineOptions.liquidityBuckets`; the pipeline calls it again before the
 * walk, the liquidity stress pattern, so an in-process caller meets the same refusal.
 */
import type { GapBucketsOption, LiquidityFlowsOption } from "../contracts/run";

/**
 * The trailing optional argument the gap metric receives: each ladder's setting, a key present only when
 * the run asked for that ladder. Absent altogether when the run asked for neither, so the metric is called
 * with the four arguments it always was.
 */
export interface GapLadderBuckets {
  repricing?: GapBucketsOption;
  liquidity?: GapBucketsOption;
}

const shown = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * Why `value` is not a bucket setting a grid of `gridHorizonMonths` months can carry, naming `path`; undefined
 * when it is one. Custom edges are whole months, at least 1, strictly increasing, at most the grid horizon.
 */
export function gapBucketsConfigError(value: unknown, path: string, gridHorizonMonths: number): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${path} must be an object { kind: "monthly" } or { kind: "custom", edgesMonths }, got ${shown(value)}`;
  }
  const v = value as Record<string, unknown>;
  if (v.kind === "monthly") return undefined;
  if (v.kind !== "custom") {
    return `${path}.kind must be "monthly" or "custom" (the nine standard bands need no setting), got ${shown(v.kind)}`;
  }
  const edges = v.edgesMonths;
  if (!Array.isArray(edges) || edges.length === 0) {
    return `${path}.edgesMonths must be a non-empty array of whole months, got ${shown(edges)}`;
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (typeof e !== "number" || !Number.isInteger(e) || e < 1) {
      return `${path}.edgesMonths[${i}] must be a whole number of months, at least 1, got ${shown(e)}`;
    }
    if (e > gridHorizonMonths) {
      return `${path}.edgesMonths[${i}] must be at most the grid horizon (${gridHorizonMonths}), got ${e}`;
    }
    if (i > 0 && e <= (edges[i - 1] as number)) {
      return `${path}.edgesMonths[${i}]: edges must strictly increase, ${e} follows ${shown(edges[i - 1])}`;
    }
  }
  return undefined;
}

/**
 * The liquidity ladder's flows setting, checked by the run route on
 * `engineOptions.liquidityFlows` and again by the pipeline before the walk, the bucket pattern above.
 */
export function liquidityFlowsConfigError(value: unknown, path: string): string | undefined {
  if (value === "principal" || value === "principal-plus-interest") return undefined;
  return `${path} must be "principal" or "principal-plus-interest", got ${shown(value)}`;
}

/** True when the run asked for the interest-inclusive liquidity ladder; "principal" and absent are the same run. */
export function wantsLiquidityInterest(flows: LiquidityFlowsOption | undefined): boolean {
  return flows === "principal-plus-interest";
}
