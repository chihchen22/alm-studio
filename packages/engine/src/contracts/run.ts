/**
 * Run lifecycle: the request the engine consumes and the result it emits.
 *
 * Determinism is the hard requirement: same RunRequest plus
 * same seed produce byte-identical results, timestamps excepted, and those are
 * injected on the request rather than read from a clock inside the compute path.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "./assumptions";
import type { CustomMetricResult } from "./customMetric";
import type { IndexHistoryEntry } from "./indexHistory";
import type { NotImplemented } from "./errors";
import type { PortfolioId, RunId } from "./ids";
import type { PlanRef } from "./plan";
import type { ProvenanceRecord, RunTimestamps } from "./provenance";
import type {
  AttributionResult,
  BucketedCashflowResult,
  BucketGrid,
  EVEResult,
  FtpResult,
  GapResult,
  LiquidityStressResult,
  NIIResult,
  SegResult,
} from "./results";
import type { Scenario } from "./scenario";
import type { ViewDef, ViewResult } from "./views";

/** Everything a run consumes. */
export interface RunRequest {
  runId: RunId;
  /** Portfolio to run; must have been registered via loadPortfolio. */
  portfolioId: PortfolioId;
  /** Market snapshot the base curve is bootstrapped from and scenarios shock. */
  marketSnapshot: MarketSnapshot;
  /** Base scenario MUST be present (a rateSpec of kind "base"); the rest are shocks. */
  scenarios: Scenario[];
  /** Assumption sets referenced by the scenarios, by id. */
  assumptionSets: AssumptionSet[];
  grid: BucketGrid;
  /**
   * Seed routed to the kernel PCG32 RNG (rates/random.ts). A string so large
   * integers survive JSON round-trips. The deterministic core reads it only
   * where a path is genuinely stochastic; the headline deterministic run does
   * not draw from it.
   */
  seed: string;
  /** Wall-clock stamps, supplied by the caller, never read inside compute. */
  timestamps: RunTimestamps;
  /** Present when the request was compiled from a run plan (harness Plane 4). Additive, 1.3.0. */
  plan?: PlanRef;
  /**
   * The views this run reports along. Absent or empty is the identity
   * cell plan, in which a cell IS a family and every fold is today's code.
   */
  views?: ViewDef[];
  /**
   * The index histories the run's lagged formula indices read before the cut-off, each
   * by its store id, sorted by id. Left out when the run reads none, so a run without history serializes
   * and hashes as before. The server resolves them at launch and pins each; inputsHash covers them.
   */
  indexHistories?: IndexHistoryEntry[];
}

/**
 * The deposit moving-average warmup a run asks for (Task
 * 16). Every nmd and nmd-b position is built on a
 * flat history of `months` entries at r0 (percent, the base scenario's
 * deterministic path at step 0), re-levelled in each scenario by that
 * scenario's shift in percent: the stated `shiftPctByScenario` value when
 * given, else 0 for the base scenario and shockBp / 100 for a parallel one; any
 * other scenario must be stated. A build may state the SRP31 shock at
 * tenor 0 (parallel +-2.00, short +-3.00, steepener -1.95, flattener +2.40).
 * `months` is a whole number from 1 to 600; an empty `shiftPctByScenario` is
 * left out when the option is copied.
 */
export interface NmdWarmupOption {
  kind: "flat-at-r0";
  months: number;
  shiftPctByScenario?: Record<string, number>;
}

/**
 * The warmup a run may name: the flat option above, or a dated history. Every entry point
 * (the run, the run route's engineOptions, the run setup) takes this union; `NmdWarmupOption` keeps its S2 meaning.
 */
export type NmdWarmupRequest = NmdWarmupOption | NmdWarmupHistoryOption;

/**
 * The model convention a run is executed under. One grouped value for the corrections:
 *
 *  - "book" is the behavior before the corrections: the CD book walks the kernel's own
 *    fixed 2026-03-31 grid and ignores the scenario, drops a CD cohort below $1,000 of walk balance, and an SEG
 *    replacement deposit vintage reads the kernel's built-in warmup series;
 *  - "corrected-v1" is the set: the CD book reads the curve of the scenario it is projected on plus the run's
 *    funding spread (it reacts to rate shocks and to the run's market), its minimum live balance is the $1 the kernel
 *    header documents, and an SEG replacement deposit vintage reads the run's deposit history.
 *
 * Absent means "book", now and later: a run or a stored setup written before the corrections keeps its numbers. A later
 * correction slice adds "corrected-v2" rather than changing what "corrected-v1" means.
 */
export type ModelConvention = "book" | "corrected-v1";

export interface NmdWarmupHistoryOption {
  /**
   * A dated monthly history, read up to and including the run's as-of month (a month
   * after it is never read), the same history in every scenario (realized history does not move with a shock, as the
   * kernel's own series does not). Unlike "flat-at-r0" it also reaches dynamic scenarios: their opening book's
   * deposits and their new deposit cohorts, which read the history followed by the scenario's own path to the month
   * they are made.
   */
  kind: "history";
  series: NmdWarmupSeries;
}

/** A dated monthly rate series: what it is and where it comes from, its first month and its values. */
export interface NmdWarmupSeries {
  /** What the series is and its source, in words; recorded on the run. */
  label: string;
  /** "YYYY-MM": the month of valuesPct[0]. */
  firstMonth: string;
  /** One value a month, percent per annum, oldest first. */
  valuesPct: number[];
}

/**
 * The user bucket setting a run asks of one gap ladder (Studio piece D slice
 * three, spec decisions 107 to 110): every month of the grid, or custom
 * whole-month edges, strictly increasing, from 1 to the grid horizon. There is
 * no "standard" arm: the nine standard bands are on every ladder, so a run that
 * wants only them names no setting at all.
 */
export type GapBucketsOption = { kind: "monthly" } | { kind: "custom"; edgesMonths: number[] };

/**
 * What the liquidity ladder carries. The setup's own
 * vocabulary (`gap.liquidity.flows`), one name from the setup to the gap metric.
 * "principal" is the default and changes nothing; "principal-plus-interest"
 * adds GapLadder.withInterest on the liquidity ladder. The principal ladder is
 * the same either way.
 */
export type LiquidityFlowsOption = "principal" | "principal-plus-interest";

/** What a run that named `nmdWarmup` records: the option resolved, one shift per run scenario in request order. */
export type NmdWarmupRecord =
  | {
      kind: "flat-at-r0";
      months: number;
      levelPct: number;
      shiftPctByScenario: Record<string, number>;
    }
  | {
      /** The history kind, as read: the series label, the months read and their first and last month. */
      kind: "history";
      label: string;
      months: number;
      firstMonth: string;
      lastMonth: string;
    };

/**
 * The deposit convention a run names. "behavioral" runs the book as
 * authored; "regulatory" replaces every deposit with a frozen core ladder plus a
 * non-core slice; "shocked-level" slots a full-beta
 * deposit with its core share at the shocked level, the behavioral EVE arm of
 * the full form's EVE book.
 */
export type NmdConvention = "behavioral" | "regulatory" | "shocked-level";

/** The full result of a run. Serializes to typed JSON with a stable schema. */
export interface RunResult {
  schemaVersion: string;
  provenance: ProvenanceRecord;
  cashflows: BucketedCashflowResult;
  nii: NIIResult;
  eve: EVEResult;
  gap: GapResult;
  /**
   * Deterministic FTP decomposition for the BASE scenario (ADR-015
   * additive, base-only with a typed in-block refusal for shocked
   * series). Optional so pre-1.2.0 archived envelopes remain valid; populated
   * on every run from the wave-2 pipeline onward.
   */
  ftp?: FtpResult;
  /**
   * Custom metrics of fixed shape, keyed by metric id. Present only
   * when the plan ran a custom metric stage; a run without one carries no arm,
   * so a pre-1.8.0 envelope is byte-identical.
   */
  custom?: Record<string, CustomMetricResult>;
  attribution: AttributionResult;
  /** One entry per declared view, carrying group membership and no numbers. */
  views?: ViewResult[];
  /**
   * Schema 1.9.0: the SEG, EBP and constant-balance NII
   * block. Present only when the run opts in to `seg`; absent otherwise.
   */
  seg?: SegResult;
  /** Schema 1.9.0: the liquidity stress ladder block. Present only on opt-in. */
  liquidityStress?: LiquidityStressResult;
  /**
   * Schema 1.9.0: a pointer that the per-position results file exists. Reserved:
   * neither the engine nor the server's post-run pass writes it, because the pass
   * leaves result.json's bytes alone. A reader finds the file by asking the
   * server (GET /api/runs/:id/instruments), which answers 404 when there is none.
   */
  instrumentsFile?: { schemaVersion: "1.0.0"; positions: number };
  /**
   * Schema 1.9.0: the deposit convention the run was executed under. Present
   * only when the run named one. "shocked-level" is
   * written only by a run that named it.
   */
  nmdConvention?: NmdConvention;
  /**
   * Schema 1.9.0: child position id -> parent position id, written by the
   * regulatory deposit-convention transform. Present only when that transform ran:
   * under "regulatory", and since Studio slice S3c-1 under "shocked-level"
   * on a book that also holds deposits without the full beta form.
   */
  parentOf?: Record<string, string>;
  /**
   * Schema 1.9.0: the deposit moving-average
   * warmup the run was executed under. Present only when the run named one;
   * a run without it built every deposit on the kernel's own warmup series.
   */
  nmdWarmup?: NmdWarmupRecord;
  /**
   * The model convention the run was executed under. Present only when the run named one; a run
   * without it ran on the original convention.
   */
  modelConvention?: ModelConvention;
  /**
   * Explicit tags for any layer that did not run. An unfinished layer appears
   * here; it never emits a plausible number. Empty when every layer ran.
   */
  notImplemented: NotImplemented[];
}
