/**
 * Provenance ledger. Every run emits one ProvenanceRecord so any number on any
 * screen traces back to the inputs and assumptions that produced it (SR 11-7
 * governance surface; architecture Section 5).
 *
 * The record is assembled from the run inputs alone. It reads no clock and draws
 * no randomness: the wall-clock stamps are injected on the request, and the
 * inputsHash is a pure content hash of the full input snapshot. Two runs with
 * the same inputs and seed therefore carry the same inputsHash; changing only
 * the timestamps leaves it untouched.
 */
import type { AssumptionSet } from "../contracts/assumptions";
import type { MarketWithCurveSetup } from "../contracts/curveSetup";
import type { PortfolioSpec } from "../contracts/position";
import type { KernelProvenanceRef, ProvenanceRecord } from "../contracts/provenance";
import type { RunLogEntry } from "../contracts/runLog";
import type { RunRequest } from "../contracts/run";
import { canonicalPredicate } from "../plan/dimensions";
import { contentHash } from "../runtime";
import { assumptionSetHash } from "../runtime/assumptionSetHash";
import { curveDefaultStampOf } from "../scenario/rateEnvironment";

/** Run-invariant context the assembler cannot derive from the request alone. */
export interface ProvenanceContext {
  /** @alm/engine package version stamped on the record. */
  engineVersion: string;
  /** Reference to the vendored kernel (source commit + manifest digest). */
  kernel: KernelProvenanceRef;
  /**
   * Hash of the composed profile the run's plugin context was mounted from,
   * and the run log itself (additive 1.4.0). Both are copied through
   * only when supplied, so an archived envelope's shape is unchanged. Neither
   * enters inputsHash: the plugin context decides who computes, and a run whose
   * inputs and profile agree is already identified by the pair.
   */
  profileHash?: string;
  runLog?: RunLogEntry[];
}

/**
 * Collect the named model versions active in the run from every overlay binding
 * across the assumption sets. The key is `${familyId}::${overlay.kind}` for a
 * binding that covers its whole family, and gains a third segment, the binding
 * selector's canonical predicate, when the binding carries one: piece 2a makes
 * two same-kind bindings on one family legal as long as they name different
 * segments, and each segment's model version has to survive to the ledger. A
 * book with no selectors keys exactly as before. The returned object is built
 * with its keys in sorted order so it serializes sorted. A key that appears
 * twice with conflicting versions is a genuine provenance ambiguity and throws
 * rather than silently keeping one.
 */
function collectModelVersions(assumptionSets: AssumptionSet[]): Record<string, string> {
  const collected = new Map<string, string>();
  for (const set of assumptionSets) {
    for (const binding of set.bindings) {
      const base = `${binding.familyId}::${binding.overlay.kind}`;
      // Keyed on whether the binding NARROWS, which is the canonical predicate,
      // not on whether the field is present. That is the same test the
      // assumption diff key uses, so the two agree by construction.
      const predicate = canonicalPredicate(binding.selector);
      const key = predicate === "" ? base : `${base}::${predicate}`;
      const existing = collected.get(key);
      if (existing !== undefined && existing !== binding.modelVersion) {
        throw new Error(
          `assembleProvenance: conflicting model version for ${key}: "${existing}" vs "${binding.modelVersion}"`,
        );
      }
      collected.set(key, binding.modelVersion);
    }
  }
  const sorted: Record<string, string> = {};
  for (const key of [...collected.keys()].sort()) {
    sorted[key] = collected.get(key) as string;
  }
  return sorted;
}

/**
 * Assemble the ProvenanceRecord for a run.
 *
 * `portfolio` is the resolved PortfolioSpec the request names; it is hashed into
 * the input snapshot (the request carries only its id). The snapshot excludes the
 * timestamps and the runId: the hash identifies the computation, not the occasion
 * of running it. The index histories the run reads
 * (`indexHistories`) are hashed after the market when the request carries any, and
 * left out when it carries none, so a run without history hashes as before.
 *
 * The record always carries `curveDefault`, the stamp
 * curveDefaultStampOf gives for the run's market. The stamp enters the hash, under the key
 * `curveDefault` beside the market, only when the market carries neither a curveSetup block nor the
 * curveDefault 1 marker: on that path the market bytes alone no longer say which default built the
 * curve (version 2, or version 1 on a fallback, whose reason is hashed with it). A block or a marker is
 * already in the hashed market bytes, so those runs hash exactly as before.
 */
export function assembleProvenance(
  request: RunRequest,
  portfolio: PortfolioSpec,
  context: ProvenanceContext,
): ProvenanceRecord {
  if (portfolio.id !== request.portfolioId) {
    throw new Error(
      `assembleProvenance: portfolio id "${portfolio.id}" does not match request portfolioId "${request.portfolioId}"`,
    );
  }

  // The stamp names the curve buildBaseCurve built for this market. It refuses what the
  // build refuses, so a run that reached assembly has a market it accepts.
  // Assumption (recorded from the review): the stamp is computed from the market, not
  // read off the curve the run built. That holds because the only curves provider registered today
  // (plugins/curves.ts, engine.curve.bootstrap) wraps buildBaseCurve, and curveDefaultStampOf and
  // buildBaseCurve share one decision (rateEnvironment.ts platformDefault). A curves provider that builds
  // the base curve any other way must write its own stamp, or this one would name a curve it did not build.
  const curveDefault = curveDefaultStampOf(request.marketSnapshot);
  const market = request.marketSnapshot as MarketWithCurveSetup;
  const stampIsHashed = market.curveSetup === undefined && market.curveDefault === undefined;

  const inputsHash = contentHash({
    portfolio,
    scenarios: request.scenarios,
    assumptionSets: request.assumptionSets,
    grid: request.grid,
    seed: request.seed,
    marketSnapshot: request.marketSnapshot,
    ...(request.indexHistories !== undefined && request.indexHistories.length > 0 ? { indexHistories: request.indexHistories } : {}),
    ...(stampIsHashed ? { curveDefault } : {}),
  });

  return {
    runId: request.runId,
    engineVersion: context.engineVersion,
    kernel: context.kernel,
    portfolioId: request.portfolioId,
    inputsHash,
    seed: request.seed,
    scenarioIds: request.scenarios.map((s) => s.id),
    assumptionSets: request.assumptionSets.map((set) => ({
      id: set.id,
      // The one helper bind uses, so a mapping moves this hash too.
      hash: assumptionSetHash(set),
    })),
    modelVersions: collectModelVersions(request.assumptionSets),
    timestamps: request.timestamps,
    ...(request.plan !== undefined
      ? {
          planId: request.plan.planId,
          planHash: request.plan.planHash,
          // Copied only when present, so an archived plan block that predates
          // ruling 14 never serializes an undefined-valued key.
          ...(request.plan.policyHash !== undefined ? { policyHash: request.plan.policyHash } : {}),
          ...(request.plan.balancePlanHash !== undefined ? { balancePlanHash: request.plan.balancePlanHash } : {}),
          ...(request.plan.scenarioBalancePlanHashes !== undefined ? { scenarioBalancePlanHashes: request.plan.scenarioBalancePlanHashes } : {}),
        }
      : {}),
    ...(context.profileHash !== undefined ? { profileHash: context.profileHash } : {}),
    ...(context.runLog !== undefined ? { runLog: context.runLog } : {}),
    curveDefault,
  };
}
