/**
 * The two curve stages. `runCurveStage` wraps the `curves`
 * seam's bootstrap; `runTlpStage` wraps the all-in funding overlay the pre-1c
 * pipeline built inline. Neither rewrites the function it wraps, which is what
 * keeps the numbers identical.
 */
import { DEFAULT_TLP_CURVE, buildTLPCurve, type TLPCurve, type ZeroCurve } from "@alm/kernel";
import type { RunRequest } from "../../contracts/run";
import type { StageFn } from "./types";
import { requireRun } from "./types";

/** Build the all-in-funding TLP overlay from the snapshot, or the kernel default. */
export function tlpFromSnapshot(request: RunRequest): TLPCurve {
  return tlpOfSnapshot(request.marketSnapshot);
}

/** The same overlay from a snapshot alone (the New volume preview reads it outside a run). */
export function tlpOfSnapshot(snapshot: RunRequest["marketSnapshot"]): TLPCurve {
  const nodes = snapshot.tlpNodes;
  return nodes.length > 0 ? buildTLPCurve(nodes) : DEFAULT_TLP_CURVE;
}

/** curve (bootstrap): MarketSnapshot -> ZeroCurve, at run scope. */
export const runCurveStage: StageFn = (env) => {
  return { run: { ZeroCurve: env.curves.build(env.request.marketSnapshot) } };
};

/**
 * curve (tlp): ZeroCurve + MarketSnapshot -> FundingCurve, at run scope.
 *
 * A SECOND type, not a second ZeroCurve: EVE shocks off the risk-free leg and
 * discounts on the all-in leg, and an edge names one producer per consumed
 * type, so a consumer that needs both names both producers. The overlay is
 * derived from the snapshot rather than from the curve it consumes; the
 * ZeroCurve edge is read and asserted so the graph states the dependency the
 * pre-1c pipeline had implicitly, and so T1 refuses a TLP stage wired to
 * nothing.
 */
export const runTlpStage: StageFn = (env, stage, input) => {
  requireRun<ZeroCurve>(env, stage, input, "ZeroCurve");
  return { run: { FundingCurve: tlpFromSnapshot(env.request) } };
};
