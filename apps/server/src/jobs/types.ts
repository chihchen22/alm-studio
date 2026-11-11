/**
 * Shared job-plane types: the run state machine, the persisted run documents,
 * and the child stdout protocol (design Sections 3.1, 3.2, 3.4).
 *
 * State machine, persisted at every transition:
 *
 *   queued -> running -> done
 *                     -> error        (child exited nonzero or wrote an error record)
 *                     -> cancelled    (user asked; child killed if running)
 *   queued -> cancelled
 *   running -> interrupted            (boot scan found a run without a live
 *                                      supervisor; terminal — the platform
 *                                      never silently re-runs compute)
 */
import type { GapBucketsOption, LiquidityStressOptions, ModelConvention, NmdWarmupRequest, NotImplemented, RunLogEntry, RunPlan, RunRequest, SegSettings } from "@alm/engine";
import type { Profile } from "@alm/harness";
import type { ConsumedPins } from "../workspaces/types";

/**
 * Studio A+E contract 1: who launched a run from a workspace, and the pins it consumed
 * (spec Section 5.2 step 9). Written only by the workspace launch route; a raw
 * POST /api/runs may not carry it.
 */
export interface RunWorkspaceStamp {
  workspaceId: string;
  setupLineageId: string;
  setupDocId: string;
  launchNo: number;
  consumed: ConsumedPins;
}

export type RunState = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "done",
  "error",
  "cancelled",
  "interrupted",
]);

/** Engine runtime policy recorded beside the request (outside inputsHash). */
export interface StoredEngineContext {
  durationMode: "base-only" | "per-scenario";
  shards: number | "auto";
  /**
   * The engine's opt-in EVE analytics: key-rate durations and the channel
   * decomposition. Written only when true, so a run that did not ask stores the
   * context it always did.
   */
  keyRate?: true;
  eveChannels?: true;
  /**
   * EVE discount basis, written only when it is not "all-in", so a run
   * on the default basis stores the context it always did.
   */
  discountBasis?: "risk-free" | "spread-consistent";
  /**
   * Deposit convention, written only when it is "regulatory" or (teach
   * slice C4) "shocked-level", so a run on the default behavioral
   * convention stores the context it always did.
   */
  nmdConvention?: "regulatory" | "shocked-level";
  /**
   * The deposit moving-average warmup, written only when the
   * submission carried it, so a run that did not ask stores the context it
   * always did.
   */
  nmdWarmup?: NmdWarmupRequest;
  /**
   * The model convention, written only when the submission named one, so a run that did not ask
   * stores the context it always did (the original convention).
   */
  modelConvention?: ModelConvention;
  /**
   * The SEG block opt-in, written only when true, so a run that did
   * not ask stores the context it always did.
   */
  seg?: true;
  /**
   * The SEG block's knobs, known keys only, written
   * only when the submission carried them beside `seg`, so a run that did not
   * ask stores the context it always did.
   */
  segSettings?: SegSettings;
  /**
   * The next-reset ALCO repricing ladder opt-in, written only when
   * true, so a run that did not ask stores the context it always did.
   */
  nextResetGap?: true;
  /**
   * The fixed-rate gap ladder opt-in, written only when true, so a
   * run that did not ask stores the context it always did.
   */
  fixedRateGap?: true;
  /** The forecast gap arm, written only when true. */
  forecastGap?: true;
  /** Going-concern EVE, written only when true. */
  goingConcernEve?: true;
  /** The months of new volume going-concern EVE counts, written only when the submission named them. */
  goingConcernSpan?: number;
  /**
   * The liquidity stress opt-in: the stress table, the buffer and the
   * undrawn face, in dollars and decimals. Written only when the submission
   * carried it, so a run that did not ask stores the context it always did.
   */
  liquidityStress?: LiquidityStressOptions;
  /**
   * Slice three (spec decisions 107 to 111): each gap ladder's user bucket
   * setting, known keys only, written only when the submission carried it, so a
   * run that did not ask stores the context it always did.
   */
  gapBuckets?: GapBucketsOption;
  liquidityBuckets?: GapBucketsOption;
  /**
   * The interest-inclusive liquidity ladder, written only as
   * "principal-plus-interest", so a run that did not ask (or asked for
   * "principal") stores the context it always did.
   */
  liquidityFlows?: "principal-plus-interest";
  /**
   * The NII report horizons (spec decision 115), written only when they differ
   * from the engine default [12, 24].
   */
  reportHorizons?: number[];
  /**
   * The NII window Results > NII opens on (spec decision 118), written only
   * when it is not 60.
   */
  windowMonths?: number;
}

/**
 * The per-position results opt-in, carried beside the engine context.
 * Written only when the submission asked for it, so a run that did not ask stores
 * the request it always did. `coaNodeIds` names chart-of-accounts nodes (a
 * summation node reaches the leaves beneath it); absent means every position.
 */
export interface StoredInstrumentResults {
  save: true;
  coaNodeIds?: string[];
}

/**
 * runs/<id>/request.json — everything the child needs to replay the run bit for
 * bit (timestamps excepted): the full RunRequest minus portfolio inlining, the
 * engine context, and the portfolio pin (id + store content hash). The child
 * verifies the pin against the artifact before computing (pin-vs-artifact).
 */
export interface StoredRunRequest {
  engineContext: StoredEngineContext;
  /** Per-position results opt-in; the child runs the instruments pass after result.json. */
  instrumentResults?: StoredInstrumentResults;
  /** RunRequest with placeholder timestamps; the child injects real ones. */
  request: RunRequest;
  portfolioRef: { id: string; contentHash: string };
  /**
   * Compile-time NotImplemented tags from a plan submission (harness Plane 4):
   * a stage the pipeline does not execute, a ramp the rate environment cannot
   * carry, a declared balance plan nothing consumed. The child merges them into
   * the result envelope, so what the compiler learned is not silently dropped
   * between the front door and the answer. Absent on a direct /api/runs
   * submission.
   */
  planTags?: NotImplemented[];
  /**
   * Compile-time run-log entries from a plan submission (harness Plane 4): the profile dump, the catalog and the two gate reports. The
   * child replays them into the run's log before the pipeline appends its own,
   * so one log reads compile-then-run in order. Absent on a direct submission.
   */
  planRunLog?: RunLogEntry[];
  /** Hash of the composed profile the plan compiled against; stamped into provenance. */
  profileHash?: string;
  /**
   * The composed profile: the plan's rows after the request's patch layers.
   * THE RUN EXECUTES IN A CHILD PROCESS, so the rows travel with the request:
   * the child mounts this profile over the same catalog (built-ins plus the
   * operator plugin list) and runs the pipeline through it. Absent means the
   * child runs on the process default harness, which is what every request
   * written before this field existed asked for.
   */
  profile?: Profile;
  /**
   * The compiled plan the run walks. THE RUN EXECUTES IN A CHILD
   * PROCESS, so the graph travels with the request the way the profile rows do:
   * without it the child would derive the default plan and compute a different
   * graph than the one the gates checked. Absent means the default plan, which
   * is what every request written before this field existed asked for.
   */
  planDocument?: RunPlan;
  /** Studio A+E contract 1: present on a workspace launch only; absent on every earlier request. */
  workspace?: RunWorkspaceStamp;
  /** Store-facing metadata for listings; never fed to the engine. */
  submission: {
    portfolioId: string;
    marketId: string;
    scenarioSlateId: string;
    assumptionSetIds: string[];
    scenarios: Array<{ id: string; label: string; rateSpec: unknown }>;
  };
}

/** runs/<id>/status.json — the supervisor-owned state record. */
export interface RunStatus {
  runId: string;
  state: RunState;
  /** Last progress phase reported by the child ("done" is the only one wave-1
   * children can honestly report; finer phases arrive with the seam). */
  phase?: string;
  label?: string;
  submittedAt: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  pid?: number;
  /** SHA-256 over the stored request.json bytes (identity badge,
   * never a cache key — the platform always runs fresh). */
  platformRequestHash: string;
  error?: { message: string; detail?: string };
  /** Listing convenience copied from the submission (not engine output). */
  summary: {
    portfolioId: string;
    marketId: string;
    scenarioSlateId: string;
    scenarioCount: number;
    /** Studio A+E contract 1: the launching workspace, on a workspace launch only. */
    workspaceId?: string;
  };
}

/** One line of the child stdout protocol / the run log. */
export type RunEvent =
  | { t: "status"; state: RunState; at: string; error?: { message: string } }
  | { t: "phase"; phase: string }
  | { t: "log"; line: string }
  | { t: "stderr"; line: string }
  | { t: "error"; message: string; detail?: string };
