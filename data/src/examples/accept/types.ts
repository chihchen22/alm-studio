/**
 * Acceptance-battery contract. One file per capability lives in this
 * directory (accept/cd.ts, accept/stochastic.ts, ...), each exporting a
 * CapabilityCheck registered in ./registry.ts. The battery driver is
 * data/src/examples/acceptance.ts (`npm run accept`).
 *
 * The standard is: a check must assert an
 * INDEPENDENT ANCHOR (a hand computation, a kernel identity, a degeneracy
 * limit, a mathematical invariant), never merely that code ran. Every emitted
 * line carries the measured value and names its anchor. A capability that is
 * not built does not get a check here; it gets an entry and the driver prints SKIPPED.
 */
import type { MarketSnapshot } from "@alm/kernel";

export type CheckStatus = "pass" | "fail" | "skip";

/** One printed line of the battery, with its measured value and anchor. */
export interface CheckLine {
  /** Stable line id, e.g. "cd.kernel-identity". */
  id: string;
  status: CheckStatus;
  /** Human line: the claim, the measured value, and the anchor that grounds it. */
  detail: string;
}

/** What a capability check hands back to the driver. */
export interface CapabilityCheckResult {
  lines: CheckLine[];
  /**
   * Every RunResult.notImplemented layer observed in engine runs this check
   * performed. The driver diffs the union of these against the register
   * (stage 4); an observed tag the register does not expect fails the verdict,
   * and so does an expected tag that never appears.
   */
  observedNotImplemented?: string[];
}

/** Context the driver provides so checks do not re-load shared inputs. */
export interface CapabilityCheckContext {
  /** Absolute repo root. */
  repoRoot: string;
  /** The vendored market snapshot, already loaded. */
  market: MarketSnapshot;
}

export interface CapabilityCheck {
  /** Must equal the capability `id` in declared-deferred.json (status "shipped"). */
  capabilityId: string;
  title: string;
  run(ctx: CapabilityCheckContext): Promise<CapabilityCheckResult> | CapabilityCheckResult;
}

// --- The declared-deferred register --

export type CapabilityStatus = "shipped" | "in-window" | "stretch" | "declined";

export interface RegisterEntry {
  id: string;
  title: string;
  status: CapabilityStatus;
  /** Build-plan module id(s) for in-window work, e.g. "W2-A1". */
  module?: string;
  /** Why it is not (yet) shipped; printed verbatim on the SKIPPED line. */
  reason: string;
  /**
   * RunResult.notImplemented layers the battery's runs are EXPECTED to emit
   * because of this entry. Empty for most entries; stage 4 asserts exact set
   * equality between the union of these and what the runs actually emitted.
   */
  expectedNotImplementedLayers: string[];
}

export interface DeclaredDeferredRegister {
  schemaVersion: string;
  updatedAt: string;
  updatedBy: string;
  capabilities: RegisterEntry[];
}
