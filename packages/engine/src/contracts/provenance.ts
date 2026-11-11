/**
 * Provenance ledger. Every run emits one of these so any number on any screen
 * traces back to the inputs and assumptions that produced it. This is the
 * SR 11-7 governance surface a GUI-bound ALM system rarely offers: a hashed input
 * snapshot plus seed plus model versions, reproducible bit-for-bit.
 */
import type { AssumptionSetId, PortfolioId, RunId, ScenarioId } from "./ids";
import type { RunLogEntry } from "./runLog";
import type { CurveDefaultStamp } from "./curveSetup";

/**
 * Wall-clock stamps, INJECTED from outside the deterministic core so the
 * compute path never reads a clock. Same inputs plus same seed reproduce every
 * field of the result except these two.
 */
export interface RunTimestamps {
  startedAt: string;
  finishedAt: string;
}

/**
 * Reference to the vendored kernel's per-file hash set (packages/kernel/
 * PROVENANCE.md). The record carries the digest of that manifest and the source
 * commit, not the full per-file list.
 */
export interface KernelProvenanceRef {
  sourceCommit: string;
  provenanceFileHash: string;
}

/** Machine-readable record emitted with every run. */
export interface ProvenanceRecord {
  runId: RunId;
  engineVersion: string;
  kernel: KernelProvenanceRef;
  portfolioId: PortfolioId;
  /**
   * Hash over the full serialized run inputs (portfolio, scenarios, assumption
   * sets, grid, seed, market snapshot, index histories when given, and, for a
   * market with no curveSetup and no curveDefault marker, the curveDefault
   * stamp), excluding timestamps. Two runs with the
   * same inputsHash and seed produce byte-identical results.
   */
  inputsHash: string;
  seed: string;
  scenarioIds: ScenarioId[];
  assumptionSets: Array<{ id: AssumptionSetId; hash: string }>;
  /** Named model versions active in the run, keys serialized in sorted order. */
  modelVersions: Record<string, string>;
  timestamps: RunTimestamps;
  /** Plan identity when the run was compiled from a plan; absent otherwise. Additive, 1.3.0. */
  planId?: string;
  planHash?: string;
  /**
   * The routing policy and the balance plan the compile read, by content hash
   * (round-2 ruling 14). Without them a plan hash alone cannot reproduce the
   * request: both are inputs the plan names rather than carries.
   */
  policyHash?: string;
  balancePlanHash?: string;
  /** Per-scenario balance plan hashes, copied from the plan block when present. */
  scenarioBalancePlanHashes?: Record<ScenarioId, string>;
  /**
   * The plugin context the run executed on, and the log of which plugin
   * answered for each seam (additive 1.4.0). Absent on archived
   * pre-1.4.0 envelopes. The hard rule these two serve: every number in this
   * result traces to an entry in `runLog`.
   */
  profileHash?: string;
  runLog?: RunLogEntry[];
  /**
   * Which curve the run's base curve built on (additive 1.10.0):
   * `{kind: "default", version: 2}` for a market with no curveSetup and no marker,
   * `{kind: "default", version: 1}` for a market marked `curveDefault: 1`, the same with a
   * `reason` for a fallback to version 1, and `{kind: "setup", id}` for a market on a setup.
   * Written on every 1.10.0 record. It enters inputsHash only for a market with no setup and
   * no marker (the market bytes alone do not say which default built the curve). Absent on
   * archived pre-1.10.0 envelopes, which ran before the stamp existed.
   */
  curveDefault?: CurveDefaultStamp;
}
