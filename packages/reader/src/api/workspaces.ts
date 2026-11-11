/**
 * Workspace, readiness, run setup and positions client (Studio A+E spec v3.1 Section 2.8, contract
 * 11): one function per route, over the shared transport of ./client.
 *
 * THE TYPES ARE COPIES, AND THE COPIES ARE GUARDED. The reader cannot import the server, so every
 * interface below is the server's text, declaration for declaration:
 *
 *   apps/server/src/workspaces/types.ts           the manifest, history, setup and event types
 *   apps/server/src/workspaces/readiness.ts       ReadinessState, SectionId, StaleRole, ReadinessItem, ReadinessReport
 *   apps/server/src/store/paths.ts                Collection
 *   apps/server/src/http/routes/workspaceCompare.ts   the compare reply (names prefixed "Workspace" here)
 *
 * `__tests__/workspacesTypesDiff.test.ts` compares each copy to its source text, comments included,
 * and a server-side test compares them as types, so a change on either side fails a test instead
 * of drifting. The reply shapes the routes build inline (launch, validate, runs, run-setups, clone)
 * are written by hand from the route files named at each one and are pinned by the live round trip
 * in `apps/server/src/__tests__/readerWorkspacesLive.test.ts`. The curve setup replies are written by hand from `apps/server/src/http/routes/curveSetups.ts`, and the setup is
 * the engine's own CurveSetupBlock, imported rather than copied.
 *
 * Honesty rules of ./client carry over: a reply is returned verbatim, nothing here rounds, sums or
 * re-derives a value, and a refusal arrives as ApiError with the server's typed body (`body` holds
 * the whole of it).
 */
import type {
  CurveCompounding,
  CurveDayCount,
  CurveInput,
  CurveInterpolation,
  CurveSetupBlock,
  DerivedCurveBlock,
  DerivedCurveSpread,
  GateReport,
  LiquidityStressOptions,
  NewVolumeTemplateSpec,
  ModelConvention,
  NmdWarmupRequest,
  NotImplemented,
  PlanReport,
  PlanScenarioRef,
  PlanStage,
  SegCprOverlay,
  ViewDef,
} from "@alm/engine";
import type { Profile } from "@alm/harness";
import {
  apiBase,
  apiEnc as enc,
  apiParseError as parseError,
  apiPostJson as postJson,
  apiRequest as request,
  type RunState,
} from "./client";

// ---------------------------------------------------------------------------
// Copied from apps/server/src/store/paths.ts
// ---------------------------------------------------------------------------

export type Collection =
  | "portfolios"
  | "market"
  | "assumption-sets"
  | "scenario-slates"
  | "coa"
  | "taxonomy"
  | "lens"
  | "plans"
  | "routing-policies"
  | "run-plans"
  | "approvals"
  | "hierarchies"
  | "run-setups"
  | "curve-setups"
  | "derived-curves"
  | "index-histories"
  | "reference"
  /** Saved rate-model fits, `cal-<16 hex>` of the content hash, append-only. */
  | "calibrations";

// ---------------------------------------------------------------------------
// Copied from apps/server/src/workspaces/types.ts (spec Section 2.2 and 5.2 types, verbatim)
// ---------------------------------------------------------------------------

export type WorkspaceType = "production" | "test" | "ftp" | "stress" | "monthly";
/** "superseded" is terminal (ruling 14): a corrected Production month replaced this one by clone. */
export type WorkspaceStatus = "active" | "archived" | "locked" | "superseded";

/** One pinned reference: a stored document and the hash the manifest saw. */
export interface DocRef {
  collection: Collection;        // "portfolios" | "market" | "assumption-sets" | ...
  id: string;
  contentHash: string;           // the store meta contentHash at pin time
  pinnedAt: string;              // ISO 8601, server clock
}

/**
 * A derived market in the block. `definitionKey` is the stable name a setup resolves the market by
 * (ruling 17): the id of the first derived market that carried this definition, never changed by a
 * roll-forward. `parentKey` is the definitionKey of the derived market this one was derived from, or
 * null when its base is the workspace's base snapshot.
 */
export interface DerivedRef extends DocRef {
  definitionKey: string;
  parentKey: string | null;
}

/** Ruling 6 and ruling 17: a definition carried across a roll-forward until it is re-applied on the new base. */
export interface CarriedDefinition {
  definitionKey: string;
  parentKey: string | null;
  /** The derived market in the source workspace. Its `derivedFrom.ops` are read from this pin at re-apply; the manifest copies no ops. */
  source: DocRef;
  status: "awaiting" | "applied" | "refused";
  /** The DerivedRef added to `market.derived` when applied. */
  appliedId: string | null;
  /** The engine's refusal text when refused (for example a macro history that ends at the old as-of month). */
  refusal: string | null;
}

/** One saved curve setup lineage: the setup's own `id` names it; the document behind it is immutable. */
export interface CurveSetupSlot {
  lineageKey: string;            // the setup block's own `id`; a save under the same key moves `current`
  current: DocRef;               // the newest curve setup document (collection "curve-setups", id `cs-<16 hex>`)
}

/** Saved curve setups: several per workspace, at most one active. */
export interface CurveSetupsBlock {
  setups: CurveSetupSlot[];
  /** The document id of the setup a launch runs on; left out until a setup is made active. */
  active?: string;
}

/** One saved derived curve lineage: the curve's own `id` names it; the document behind it is immutable. */
export interface DerivedCurveSlot {
  lineageKey: string;            // the derived curve block's own `id`, the id an index's `spreadCurve` names
  current: DocRef;               // the newest derived curve document (collection "derived-curves", id `dc-<16 hex>`)
}

/** Saved derived curves: several per workspace, no active pointer; a launch pins the ones an index names. */
export interface DerivedCurvesBlock {
  curves: DerivedCurveSlot[];
}

export interface MarketBlock {
  /** The one base snapshot at the cut-off date. Its date is `calibrationDate`. */
  snapshot: DocRef | null;
  /** Derived markets off the same base (TLP shock, vol shock, rate indices, macro series). Same date by construction. */
  derived: DerivedRef[];
  /** Non-empty only on a roll-forward whose source held derived markets; entries leave it when applied and stay when refused. */
  carried: CarriedDefinition[];
  carriedFrom: { workspaceId: string; at: string } | null;
  /** Left out until the first curve setup is saved, so a workspace with none hashes as before. */
  curveSetups?: CurveSetupsBlock;
  /** Left out until the first derived curve is saved, so a workspace with none hashes as before. */
  derivedCurves?: DerivedCurvesBlock;
}

export interface PositionsBlock {
  /** The one position book at the cut-off date. */
  book: DocRef | null;
  /** Books the hierarchies route wrote from it (`<bookId>--<hierarchyId>`, `routes/hierarchies.ts:13`); same positions, more tags. */
  retagged: DocRef[];
  /** The stored chart of accounts the CSV import targets (`coa` collection); the book also embeds its COA. */
  coa: DocRef | null;
  taxonomy: DocRef | null;
  hierarchies: DocRef[];
}

export interface TargetsBlock {
  /** Balance plans and their derived shock plans (`plans` collection). Needed by the Custom dynamic basis only. */
  balancePlans: DocRef[];
  /** Instrument templates. Empty in Slice 1; the key exists so a clone carries it. */
  templates: DocRef[];
}

export interface AssumptionsBlock {
  sets: DocRef[];                // assumption sets and their derived sets
  /**
   * MAJOR 4: the set a `{ kind: "block-default" }` setup input resolves to. Set to the first set added to an
   * empty block; moved by the `set-default` block op; null while the block is empty. Must name an entry of `sets`.
   */
  defaultSetId: string | null;
  routingPolicy: DocRef | null;  // `routing-policies`
}

export interface ScenarioBlock {
  /** Slates the analyst authored. Launch slates the server writes (`plan-<planId>`) are never listed here. */
  slates: DocRef[];
}

/** A run setup slot: stable identity for the URL and the launch counter; the document behind it is immutable. */
export interface SetupSlot {
  setupLineageId: string;        // Section 2.10; stable for the life of the workspace and across clones
  current: DocRef;               // the newest setup document (collection "run-setups")
}

export interface RunBlock {
  setups: SetupSlot[];
  /** Lenses the Results screens score runs through (`lens` collection). */
  lenses: DocRef[];
}

export interface CutoffClash {
  block: "positions" | "market";
  id: string;
  documentAsOf: string;
  recordedAt: string;
  /** Only "warned" is ever stored: a Production workspace refuses instead of recording. */
  outcome: "warned";
}

export interface WorkspaceLock {
  lockedAt: string;
  by: string;                    // typed by the signer, never verified (the approvals rule)
  approvalId: string;            // the approval record this lock rests on
  signedHash: string;            // the hash the approval was recorded against
}

export interface WorkspaceLineage {
  mode: "blank" | "copy" | "roll-forward" | "supersede" | "seed";
  fromWorkspaceId: string | null;
  fromSignedHash: string | null;
  /** The blocks the clone checklist carried. */
  carried: Array<keyof WorkspaceBlocks>;
  /** Set on the SOURCE when a supersede clone replaced it (ruling 14). */
  supersededBy: string | null;
  /** Set on a supersede CLONE from its creation until the source is marked (Section 2.3); cleared by the same write that marks the source, or by boot reconcile. */
  pendingSupersede: boolean;
}

export interface WorkspaceBlocks {
  market: MarketBlock;
  positions: PositionsBlock;
  targets: TargetsBlock;
  assumptions: AssumptionsBlock;
  scenarios: ScenarioBlock;
  run: RunBlock;
}

export interface WorkspaceManifest {
  schemaVersion: "1.0.0";
  id: string;                    // matches ID_PATTERN (paths.ts:25); Section 2.10
  name: string;                  // 1 to 80 characters
  type: WorkspaceType;
  status: WorkspaceStatus;
  /** ISO date. Set at creation. IMMUTABLE: the server refuses any later change (422). */
  cutoffDate: string;
  owner: string;                 // typed, never verified; the platform has no sign-in
  createdAt: string;
  updatedAt: string;
  /** Monotonic per workspace; each head write increments it and appends a history line. */
  revision: number;
  blocks: WorkspaceBlocks;
  /** sha256 per block over the canonical JSON of that block's entry tuples (the rule below). Compare reads this; nothing else does. */
  blockHashes: Record<keyof WorkspaceBlocks, string>;
  /** sha256 over canonical JSON of { id, type, cutoffDate, blockHashes }. The approval binds to THIS. */
  signedHash: string;
  /** sha256 over the whole head with `updatedAt`, `revision` and `manifestHash` removed. Identifies a revision in history; nothing signs it. */
  manifestHash: string;
  lineage: WorkspaceLineage;
  clashes: CutoffClash[];
  lock: WorkspaceLock | null;
  note: string;                  // 0 to 500 characters
}
export type BlockName = keyof WorkspaceBlocks;   // "market" | "positions" | "targets" | "assumptions" | "scenarios" | "run"

export type HistoryChange =
  | { kind: "create" }
  // `curveSetup` tells a curve setup edit-save and a deactivate apart from an add or an
  // activate; it is left out of every other line. `derivedCurve` marks every derived curve
  // save, a new slot (op "add") and an edit (op "set") alike; it is left out of every other line.
  | {
      kind: "set-block";
      block: BlockName;
      op: "set" | "add" | "remove";
      ref: { collection: Collection; id: string };
      curveSetup?: "edit" | "deactivate";
      derivedCurve?: "edit";
    }
  | { kind: "set-default"; setId: string }
  | { kind: "meta"; name?: string; note?: string }
  | { kind: "status"; from: WorkspaceStatus; to: WorkspaceStatus }
  | { kind: "lock"; approvalId: string }
  | { kind: "supersede"; by: string }
  | { kind: "re-pin"; block: BlockName; id: string; from: string; to: string }
  | { kind: "reapply"; definitionKey: string; appliedId: string | null; refusal: string | null }
  | { kind: "clash"; block: "positions" | "market"; id: string; documentAsOf: string };

/** One line of workspaces/<wsId>/history.ndjson: the complete manifest as of that revision. */
export interface HistoryLine {
  revision: number;
  at: string;
  by: string;
  change: HistoryChange;
  manifest: WorkspaceManifest;
  reconciled?: true;
}

/** One line of workspaces/<wsId>/runs.ndjson (Sections 2.7 and 5.2). */
export interface RunAttachment {
  runId: string;
  attachedBy: "launch" | "migration" | "reconcile";
  at: string;
  setupLineageId?: string;
  launchNo?: number;
  pins: "consumed" | "reconstructed";
  /** Written only on a stochastic launch's line; absent means a deterministic run. */
  mode?: "stochastic";
  /** The setup document a stochastic launch ran, written on its line only. */
  setupDocId?: string;
}

/** Which document in a block this setup runs on; the block may hold more than one. */
export interface SetupInputs {
  book: { role: "base" } | { role: "retagged"; id: string };
  /** A derived market is named by its definitionKey (Section 2.2), so the name survives a roll-forward and a re-apply. */
  market: { role: "base" } | { role: "derived"; definitionKey: string };
  /**
   * MAJOR 4. Either explicit set ids, each in the assumptions block, or the workspace's designated default
   * (`assumptions.defaultSetId`), resolved at compile and recorded in `consumed` as `set:<id>`. Standard ALCO
   * uses the second arm, so an immutable document created on an empty block runs the moment a set is attached.
   */
  assumptionSetIds: string[] | { kind: "block-default" };
}

export type SetupScenarios =
  | { kind: "library"; refs: string[] }                                   // "<library id>#<scenario id>", resolved by the engine (resolveScenarios.ts:25-35)
  | { kind: "slate"; slateId: string; include: string[] | "all" }         // a stored slate in the scenarios block, inlined at compile
  | { kind: "plan-scenarios"; items: PlanScenarioRef[] };                 // an imported plan's own list, refs and inline definitions mixed (plan.ts:142-144)

/**
 * The balance sheet basis (rulings 18 and 20).
 *  - "flat" (default): every non-derivative family with a positive opening balance is held at that balance; the mix across
 *    chart of account nodes is static by construction. Top-ups are the engine's existing rule: fixed bullets at the par
 *    swap rate plus the spread, over the term (60 months at 0 bp unless set; S2b-1 lifts the pin to the plan's range: a
 *    whole number of months from 1 to 360 and any finite spread). A family with a new-volume template (`nii.templates`)
 *    is topped up with that product instead.
 *  - "runoff": the engine's mode "static", no new business. Labelled "Runoff" everywhere, never "static".
 *  - "custom": a balance plan in the targets block lowered into per-family rules; targets per family or per strategic
 *    chart of account node (Section 5.6 contract 20).
 */
export type NiiBasis =
  | { kind: "flat"; termMonths: number; spreadOverIndexBp: number }
  | { kind: "runoff" }
  | { kind: "custom"; balancePlanId: string };

/** MAJOR 1: where a resolved scenario's new-business strategy came from. Recorded per scenario on the validation line. */
export type BasisSource =
  | { kind: "scenario" }                                   // the scenario's own newBusiness (an inline definition)
  | { kind: "scenario-plan"; balancePlanId: string }       // a scenarioBalancePlans entry (compile.ts:716-722)
  | { kind: "plan"; balancePlanId: string }                // the plan-level balancePlan (compile.ts:723-725)
  | { kind: "flat" }                                       // the new balanceBasis (contract 18)
  | { kind: "runoff" };                                    // the compiler's static fallback (compile.ts:723)

export interface NiiSettings {
  enabled: boolean;
  horizonMonths: number;         // months shown and summed by default in Results > NII. Default 60. Must be <= gridHorizonMonths. Sent as engineOptions.windowMonths when not 60
  reportHorizons: number[];      // default [12, 24, 60]; passed into computeNII as engineOptions.reportHorizons when not [12, 24]
  basis: NiiBasis;               // default { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 }
  path: "single";                // stochastic NII is piece D
  /**
   * The product each family's new volume is, one row per family, compiled onto the plan's
   * `newVolumeTemplates`. A family with a row is topped up with that product (its term and spread replace the basis's or
   * the target's); a family without one keeps today's fixed bullet. Left out when absent, so a setup written
   * before it keeps its bytes and its id; a family that runs off does not read its row.
   */
  templates?: NewVolumeTemplateSpec[];
}

export interface EveSettings {
  enabled: boolean;
  discountBasis: "all-in" | "risk-free" | "spread-consistent";   // honoured through engineOptions
  durationMode: "base-only" | "per-scenario";  // honoured today through engineOptions
  valuationDates: "as-of" | "every-nii-date" | "every-12-months" | "custom";   // grid as-of only in Slice 1
  customValuationMonths?: number[];
  keyRate: boolean;
  channels: boolean;
  path: "single" | "stochastic";
  /**
   * The stochastic simulation choice. `model` is optional and written only when the
   * guided Simulation step names it; the deterministic compile reads none of this block, so a setup that carries it
   * still launches on one path, and the guided Run step submits it on POST /api/runs.
   */
  stochastic?: {
    nPaths: number;
    seed?: string;
    model?: "hull-white-1f" | "bgm-lmm-2f";
    modelParams?: { a: number; sigma: number; reason: string };
    /** A saved calibration the run uses instead of fitting at run time; written only when chosen. */
    calibrationId?: string;
  };
  /**
   * Going-concern EVE beside run-off EVE, sent as `engineOptions.goingConcernEve` when
   * true. Left out when absent, so a setup written before it keeps its bytes and its id.
   */
  goingConcern?: boolean;
  /**
   * The months of new volume going-concern EVE counts, a whole number from 1 to the earnings horizon
   * (`nii.horizonMonths`), never past it. Absent: the first 12 months, or the earnings horizon when it is shorter (decided
   * 2026-11-03). Sent as `engineOptions.goingConcernSpan`, read only with `goingConcern` on; left out when
   * absent.
   */
  goingConcernSpan?: number;
}

export interface GapSettings {
  enabled: boolean;
  repricingBuckets: { kind: "monthly" } | { kind: "standard" } | { kind: "custom"; edgesMonths: number[] };   // monthly default; monthly and custom add userBuckets to the repricing ladder, as the liquidity interval monthly or custom-months does to the liquidity ladder
  fixedRateLadder: boolean;      // honoured: sent as engineOptions.fixedRateGap, writes gap.fixedRate
  liquidity: {
    enabled: boolean;
    /** `principal-plus-interest` adds `GapLadder.withInterest`, the interest-inclusive ladder, beside the principal one. */
    flows: "principal" | "principal-plus-interest";
    /** `standard` (additive): the nine standard bands only, no user buckets on the liquidity ladder. */
    interval: { kind: "standard" } | { kind: "monthly" } | { kind: "custom-months"; edgesMonths: number[] } | { kind: "daily" };
  };
  /**
   * The next-reset ALCO repricing ladder (the ALCO convention), sent as
   * `engineOptions.nextResetGap`. Left out when absent, so a setup written before it keeps its bytes.
   */
  nextReset?: boolean;
  /**
   * The forecast gap arm (both ladders with new volume), sent as
   * `engineOptions.forecastGap` when true. Left out when absent.
   */
  forecast?: boolean;
}

export interface InstrumentResultSettings {
  save: boolean;                 // default false; honoured: the launch sends it and the runner writes instruments.json
  /** Chart of account nodes whose positions are stored (a summation node reaches its leaves). Absent means every position. */
  coaNodeIds?: string[];
}

/**
 * The liquidity stress opt-in a setup carries: the stress table, the buffer and the
 * undrawn commitment face, in dollars and decimals, the shape the run route's `engineOptions.liquidityStress` takes.
 * The buffer may be left out (read from the hqla-stock positions' tags), and the
 * commitment dials and the survival path may be added; the engine's own type.
 */
export type SetupLiquidityStress = LiquidityStressOptions;

/** The plan template: everything a RunPlan carries that the workspace does not supply. */
export interface SetupPlanTemplate {
  planId: string | null;         // kept verbatim on an import; null for a new or edited setup, which hashes one at compile (Section 2.10)
  label: string;
  authoredBy: "person" | "orchestrator";
  note?: string;
  /** A literal stage list (imports), or "derived-default": the engine's default plan for the resolved inputs, with the balance stage on when the basis is flat or custom (Standard ALCO). */
  stages: PlanStage[] | "derived-default";
  reports: PlanReport[];
  validationRules: { typeGate: string[]; routingGate: string[] };
  profile?: Profile;
  views?: ViewDef[];
  scenarioBalancePlans?: Record<string, string>;
}

export interface RunSetup {
  schemaVersion: "1.0.0";
  id: string;                    // rs-<16 hex>, Section 2.10; immutable
  name: string;                  // "Standard ALCO"
  gridHorizonMonths: number;     // default 360
  inputs: SetupInputs;
  scenarios: SetupScenarios;
  plan: SetupPlanTemplate;
  nii: NiiSettings;
  eve: EveSettings;
  gap: GapSettings;
  ftp: { enabled: boolean };     // base scenario only, as today
  instrumentResults: InstrumentResultSettings;
  /**
   * The schema 1.9.0 fields, each left out when absent, so a setup written
   * before them keeps its bytes and its id. `nmdConvention` absent means "behavioral"; `seg` turns the
   * SEG, EBP and constant-balance NII block on; `liquidityStress` turns the stress ladder on.
   */
  nmdConvention?: "behavioral" | "regulatory" | "shocked-level";
  /**
   * The deposit moving-average warmup, sent as `engineOptions.nmdWarmup`: a flat history at r0
   * re-levelled per scenario. Left out when absent, and then every
   * deposit runs on the kernel's own warmup series.
   */
  nmdWarmup?: NmdWarmupRequest;
  /**
   * The model convention, sent as `engineOptions.modelConvention`. "corrected-v1" applies the K1
   * corrections (the CD book reacts to rate shocks and reads the run's market at the documented $1 minimum balance; an
   * SEG deposit vintage reads the run's history); "book" is the labelled original convention. Left
   * out when absent, and absent means the original convention: a setup written before K1 keeps its bytes, its id
   * and its numbers, and the Studio says it was made before the corrections. New setups and the seeds write
   * "corrected-v1".
   */
  modelConvention?: ModelConvention;
  /**
   * The SEG block. Teach slice C2 adds the knobs, each left out when absent, so a setup
   * written before them keeps its bytes and its id: the shock size and horizon of the SEG pair, the NII shock of the
   * 12-month block, and the cohort-0 CPR overlay of a mortgage family. Sent as `engineOptions.segSettings`.
   */
  seg?: { enabled: boolean; shockBp?: number; horizonMonths?: number; niiShockBp?: number; cprOverlay?: SegCprOverlay[] };
  liquidityStress?: SetupLiquidityStress;
  batch: Array<{ label: string; scenarios: SetupScenarios; assumptionSetIds: SetupInputs["assumptionSetIds"]; basis: NiiBasis }>;
  importedFrom: string | null;   // a seeded or hand-saved RunPlan id
  supersedes: string | null;     // the previous document's id; the store is append-only
  note: string;
}

/** One line of workspaces/<wsId>/setups.ndjson. */
export type SetupEvent =
  | { t: "validate"; setupLineageId: string; setupDocId: string; at: string; by: string; consumed: ConsumedPins; outcome: "pass" | "warn" | "fail"; basisLabel: string; basisByScenario: Record<string, BasisSource>; skippedFamilies: string[]; reports: unknown }
  | { t: "launch"; setupLineageId: string; setupDocId: string; at: string; by: string; consumed: ConsumedPins; launchNo: number; acknowledged: string[]; batch: boolean; state: "submitting" }
  | { t: "launch-complete"; setupLineageId: string; launchNo: number; at: string; runIds: string[]; failed: Array<{ row: string; status: number; message: string }>; reconciled?: true };

/**
 * `derivedCurve:<curve id>`: one role per derived curve a launch pins, keyed by the
 * curve's own id (the id an index's `spreadCurve` names), as `set:<id>` keys one role per assumption set.
 * `indexHistory:<ih- id>`: one role per index history a launch pins.
 */
export type ConsumedRole =
  | "book"
  | "market"
  | "routingPolicy"
  | "slate"
  | "balancePlan"
  | "setup"
  | "curveSetup"
  | `set:${string}`
  | `balancePlan:${string}`
  | `derivedCurve:${string}`
  | `indexHistory:${string}`
  /** The saved calibration a stochastic launch uses. */
  | "calibration";
export type ConsumedPins = Partial<Record<ConsumedRole, DocRef>>;

// ---------------------------------------------------------------------------
// Copied from apps/server/src/workspaces/readiness.ts (the public shapes)
// ---------------------------------------------------------------------------

export type ReadinessState = "not-set" | "draft" | "valid" | "warning" | "error" | "stale";
export type SectionId = "workspace" | "market" | "balance" | "assumptions" | "run" | "results" | "govern";

export interface StaleRole {
  role: string;
  pinned: string;
  current: string | null;
}

export interface ReadinessItem {
  section: SectionId;
  item: string;
  state: ReadinessState;
  required: boolean;
  detail: string;
  staleRoles?: StaleRole[];
}

export interface ReadinessReport {
  items: ReadinessItem[];
  sections: Record<SectionId, ReadinessState>;
  launchable: Record<string, { ok: boolean; blocking: string[]; acknowledgeable: string[] }>;
}

// ---------------------------------------------------------------------------
// Copied from apps/server/src/http/routes/workspaceCompare.ts and workspaces/hashes.ts (names prefixed Workspace)
// ---------------------------------------------------------------------------

export type WorkspaceCompareTuple = Array<string | null>;

export type WorkspaceCompareVerdict = "same" | "changed" | "only-a" | "only-b";

export interface WorkspaceCompareBlock {
  verdict: WorkspaceCompareVerdict;
  a?: WorkspaceCompareTuple[];
  b?: WorkspaceCompareTuple[];
}

export interface WorkspaceCompareSide {
  id: string;
  name: string;
  type: WorkspaceManifest["type"];
  status: WorkspaceManifest["status"];
  cutoffDate: string;
  revision: number;
  signedHash: string;
}

export interface WorkspaceCompareReply {
  a: WorkspaceCompareSide;
  b: WorkspaceCompareSide;
  blocks: Record<BlockName, WorkspaceCompareBlock>;
}

// ---------------------------------------------------------------------------
// Request bodies and the reply shapes the routes build inline
// ---------------------------------------------------------------------------

/** The `op` values of POST /api/workspaces/:id/blocks (apps/server/src/workspaces/rules.ts BLOCK_OPS). */
export type BlockOp = "set" | "add" | "remove" | "set-default";

/** The readiness item ids a launch acknowledges (apps/server/src/workspaces/readiness.ts). */
export const RUN_SETUPS_ITEM = "run/setups";
export const RUN_SETUP_WARNINGS_ITEM = "run/setup-warnings";

/** POST /api/workspaces. `id` defaults to the slug of `name`. */
export interface CreateWorkspaceBody {
  id?: string;
  name: string;
  type: WorkspaceType;
  cutoffDate: string;
  owner: string;
  by: string;
  note?: string;
}

/** Every mutating workspace body carries `by` (typed, never verified) and `expectedRevision`. */
export interface SetBlockBody {
  expectedRevision: number;
  by: string;
  block: BlockName;
  op: BlockOp;
  ref: { collection: Collection; id: string };
}

export interface SetMetaBody {
  expectedRevision: number;
  by: string;
  name?: string;
  note?: string;
}

/** `cutoffDate` is required on a roll-forward and refused on a copy; `blocks` is the clone checklist. */
export interface CloneWorkspaceBody {
  expectedRevision: number;
  by: string;
  mode: "copy" | "roll-forward";
  id?: string;
  name: string;
  type?: WorkspaceType;
  cutoffDate?: string;
  blocks: BlockName[];
  supersedeSource?: boolean;
}

/** POST /api/workspaces/:id/clone answers 201 with the new head and its readiness report. */
export interface CloneWorkspaceReply {
  manifest: WorkspaceManifest;
  readiness: ReadinessReport;
}

export interface ReapplyMarketBody {
  expectedRevision: number;
  by: string;
}

export interface ArchiveWorkspaceBody {
  expectedRevision: number;
  by: string;
  note?: string;
}

/** `signedHash` is the 64 hex signedHash of the head the signer reviewed; a moved head is a 409. */
export interface SignOffBody {
  expectedRevision: number;
  by: string;
  note?: string;
  signedHash: string;
}

/** runs/<id>/status.json as GET /api/workspaces/:id/runs joins it (apps/server/src/jobs/types.ts RunStatus). */
export interface WorkspaceRunStatus {
  runId: string;
  state: RunState;
  phase?: string;
  label?: string;
  submittedAt: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  pid?: number;
  platformRequestHash: string;
  error?: { message: string; detail?: string };
  summary: {
    portfolioId: string;
    marketId: string;
    scenarioSlateId: string;
    scenarioCount: number;
    workspaceId?: string;
  };
}

/** One row of GET /api/workspaces/:id/runs: the attachment line, the run's status and the basis label read off its request. */
export type WorkspaceRunRow = RunAttachment & { status: WorkspaceRunStatus | null; basisLabel: string | null };

/** One slot with its current document. */
export interface RunSetupListed {
  slot: SetupSlot;
  setup: RunSetup;
}

/** A slot whose document is gone from the store: skipped from `setups`, named here. */
export interface RunSetupMissing {
  setupLineageId: string;
  docId: string;
  problem: string;
}

/** GET /api/run-setups?workspaceId= */
export interface RunSetupsReply {
  setups: RunSetupListed[];
  missing: RunSetupMissing[];
}

/**
 * POST /api/run-setups. `setup` is the document without an id (an id in it is ignored); the server
 * names it `rs-<16 hex>` from its content. `setupLineageId` names a slot, new or existing.
 */
export interface SaveRunSetupBody {
  workspaceId: string;
  setupLineageId: string;
  expectedRevision: number;
  by: string;
  setup: Omit<RunSetup, "id"> & { id?: string };
}

/** 201 when the slot moved or was added, 200 when the slot already held this document. */
export interface SaveRunSetupReply {
  setup: RunSetup;
  manifest: WorkspaceManifest;
}

export interface ValidateSetupBody {
  by: string;
}

export interface SetupReadinessLists {
  blocking: string[];
  acknowledgeable: string[];
}

/** A validation that compiled: both gate reports, the compile's warnings and the readiness lists beside this setup. */
export interface ValidatePassReports {
  type: GateReport;
  routing: GateReport;
  warnings: string[];
  notImplemented: NotImplemented[];
  readiness: SetupReadinessLists;
}

/** A validation the compile refused (422 inside the compile): the engine's text, verbatim. */
export interface ValidateRefusedReports {
  error: { code: string; message: string; detail?: unknown };
}

/**
 * POST /api/workspaces/:id/setups/:lineageId/validate. 200 whatever the outcome; a pin or state
 * conflict is a 409 and a missing slot a 404. `compiledChain` is the plan's stage list, empty
 * when the roles themselves did not resolve.
 */
export interface ValidateSetupReply {
  outcome: "pass" | "warn" | "fail";
  basisLabel: string;
  basisByScenario: Record<string, BasisSource>;
  skippedFamilies: string[];
  reports: ValidatePassReports | ValidateRefusedReports;
  compiledChain: PlanStage[];
  planId: string | null;
  consumed: ConsumedPins;
}

/**
 * One stored validation of a setup slot, as GET /api/workspaces/:id/setups/:lineageId/validations
 * answers it (built by hand from apps/server/src/http/routes/workspaceLaunch.ts). `current` is true
 * when the slot still pins the document that was validated; false means the setup was saved again.
 */
export interface SetupValidationEntry {
  at: string;
  by: string;
  setupDocId: string;
  outcome: "pass" | "warn" | "fail";
  basisLabel: string;
  skippedFamilies: string[];
  current: boolean;
  /**
   * Why a failed validation failed, read back from its stored reports: the refusal's message, then each gate
   * failure's sentence, joined with "; ". Absent when the stored line holds no refusal (a pass, or an older line
   * that stored none).
   */
  reason?: string;
}

/** `acknowledge` lists readiness item ids; `batch` launches every batch row of the setup. */
export interface LaunchSetupBody {
  by: string;
  acknowledge?: string[];
  batch?: boolean;
  /** "stochastic" launches the setup's stochastic choice (`eve.stochastic`), attached to the workspace. */
  mode?: "deterministic" | "stochastic";
}

/** The completion line of a launch, as the launch route answers it. */
export type LaunchComplete = Extract<SetupEvent, { t: "launch-complete" }>;

/** A queued run offered for cancel after a later batch row was refused (207). Never auto-cancelled. */
export interface LaunchCancelOffer {
  runId: string;
  method: "POST";
  path: string;
}

/** 200: every row queued. 207: some queued, a later row refused; `cancel` offers each queued run. */
export type LaunchReply = LaunchComplete & { cancel?: LaunchCancelOffer[] };

/** The body of a 409 launch refusal ("launch-blocked" or "acknowledge-required"), kept on `ApiError.body`. */
export interface LaunchGateRefusal {
  error: { code: "launch-blocked" | "acknowledge-required"; message: string };
  blocking: string[];
  acknowledgeable: string[];
  staleRoles: StaleRole[];
}

/** One batch row of a 422 launch refusal. */
export type LaunchRowReport =
  | { label: string; outcome: "pass"; planId: string; basisLabel: string; skippedFamilies: string[]; warnings: string[] }
  | { label: string; outcome: "fail"; status: number; error: { code: string; message: string; detail?: unknown } };

/** The body of a 422 launch refusal when a batch row failed to compile: nothing was submitted. Kept on `ApiError.body`. */
export interface LaunchBatchRefusal {
  error: { code: "validation"; message: string };
  rows: LaunchRowReport[];
}

// Curve setups. Written by hand from apps/server/src/http/routes/curveSetups.ts; the
// setup itself is the engine's CurveSetupBlock, imported, not copied. A refused setup (the 422 that
// carries `refusals`) is answered as data, { ok: false, refusals }; every other refusal is an ApiError.

/** One row of GET /api/workspaces/:id/curve-setups: the slot's current document, summarised, with `rows` its inputs verbatim. */
export interface CurveSetupListRow {
  id: string;                    // the document id, cs-<16 hex>
  setupId: string;               // the setup's own id (the slot's lineageKey): what a derived curve's base and the estimate name
  label: string;
  interpolation: CurveInterpolation;
  dayCount: CurveDayCount;
  compounding: CurveCompounding;
  rows: readonly CurveInput[];
  active: boolean;
}

/** GET /api/workspaces/:id/curve-setups. `missing` names slots whose document is gone; the server leaves it out when empty. */
export interface CurveSetupsReply {
  setups: CurveSetupListRow[];
  missing?: Array<{ id: string; problem: string }>;
}

/** A setup the engine's validator or builder refused: its sentences, verbatim and in order. */
export interface CurveSetupRefused {
  ok: false;
  refusals: string[];
}

/** POST /api/workspaces/:id/curve-setups: 201 (slot added or moved) or 200 (the slot already held it) as { id, revision }, or the refusals. */
export type SaveCurveSetupResult = { ok: true; id: string; revision: number } | CurveSetupRefused;

/** One quote node of a preview: the built curve read at the row's node tenor. */
export interface CurveSetupQuoteNode {
  tenorMonths: number;
  zeroRate: number;
  discountFactor: number;
}

/** POST /api/curve-setups/preview, both arms verbatim: 200 the built curve at its quote nodes, 422 the refusals. */
export type CurveSetupPreview =
  | { ok: true; quoteNodes: CurveSetupQuoteNode[]; denseCount: number; warnings: string[] }
  | CurveSetupRefused;

// Derived curves. Written by hand from apps/server/src/http/routes/derivedCurves.ts;
// the curve itself is the engine's DerivedCurveBlock, imported, not copied. A refused curve or estimate
// (the 422 that carries `refusals`) is answered as data, { ok: false, refusals }; every other refusal is an ApiError.

/** One row of GET /api/workspaces/:id/derived-curves: `id` the document id (dc-<16 hex>), `curveId` the curve's own id. */
export interface DerivedCurveListRow {
  id: string;
  curveId: string;
  label: string;
  base: string;
  spreads: DerivedCurveBlock["spreads"];
  /** Left out when the grid was typed. */
  source?: DerivedCurveBlock["source"];
  /** The platform default version the spreads were estimated on; left out when the curve carries none. */
  estimatedOnDefault?: DerivedCurveBlock["estimatedOnDefault"];
}

/** GET /api/workspaces/:id/derived-curves. `missing` names slots whose document is gone; the server leaves it out when empty. */
export interface DerivedCurvesReply {
  curves: DerivedCurveListRow[];
  missing?: Array<{ id: string; problem: string }>;
}

/** POST /api/workspaces/:id/derived-curves: 201 (slot added or moved) or 200 (the slot already held it) as { id, revision }, or the refusals. */
export type SaveDerivedCurveResult = { ok: true; id: string; revision: number } | CurveSetupRefused;

/** POST /api/workspaces/:id/derived-curves/estimate, both arms verbatim: 200 the estimated spread rows, 422 the refusals. */
export type DerivedCurveEstimate = { ok: true; spreads: DerivedCurveSpread[] } | CurveSetupRefused;

// ---------------------------------------------------------------------------
// The routes of spec Section 2.8, one function each
// ---------------------------------------------------------------------------

/** GET /api/workspaces: heads, newest cut-off first. */
export function listWorkspaces(): Promise<WorkspaceManifest[]> {
  return request<WorkspaceManifest[]>("/workspaces");
}

/** POST /api/workspaces: 201 with the blank head and its Standard ALCO slot; 409 on a taken id or a second Production month. */
export function createWorkspace(body: CreateWorkspaceBody): Promise<WorkspaceManifest> {
  return postJson<WorkspaceManifest>("/workspaces", body);
}

/** GET /api/workspaces/compare?a=&b=: per block `same`, `changed`, `only-a` or `only-b`, by block hash. */
export function compareWorkspaces(a: string, b: string): Promise<WorkspaceCompareReply> {
  return request<WorkspaceCompareReply>(`/workspaces/compare?a=${enc(a)}&b=${enc(b)}`);
}

/** GET /api/workspaces/:id: the head, after the server's reconcile. 404 for an unknown id. */
export function getWorkspace(id: string): Promise<WorkspaceManifest> {
  return request<WorkspaceManifest>(`/workspaces/${enc(id)}`);
}

/** GET /api/workspaces/:id/history: one line per revision, oldest first, each carrying the whole manifest as of it. */
export function getWorkspaceHistory(id: string): Promise<HistoryLine[]> {
  return request<HistoryLine[]>(`/workspaces/${enc(id)}/history`);
}

/** GET /api/workspaces/:id/readiness: item states, section states and the per-slot launch gate. */
export function getReadiness(id: string): Promise<ReadinessReport> {
  return request<ReadinessReport>(`/workspaces/${enc(id)}/readiness`);
}

/** GET /api/workspaces/:id/runs: attached runs, newest first, joined to status.json and the basis label. */
export function listWorkspaceRuns(id: string): Promise<WorkspaceRunRow[]> {
  return request<WorkspaceRunRow[]>(`/workspaces/${enc(id)}/runs`);
}

/**
 * One stored routing policy of GET /api/routing-policies. The route replies `id`, `label` (an empty string when the
 * policy has none) and `contentHash` today; `seeded` and `classCount` are the store meta the route may carry
 * (apps/server/src/http/routes/plans.ts writes `classCount` at POST, the seed writes `seeded`), so both are optional.
 */
export interface RoutingPolicyListItem {
  id: string;
  label?: string;
  seeded?: boolean;
  classCount?: number;
  contentHash: string;
}

/** GET /api/routing-policies: every stored routing policy, by id. The attach control on Assumptions lists these. */
export function listRoutingPolicies(): Promise<RoutingPolicyListItem[]> {
  return request<RoutingPolicyListItem[]>("/routing-policies");
}

/** One stored chart of accounts of GET /api/coa: `label` is an empty string when the chart has none. */
export interface CoaListItem {
  id: string;
  label: string;
  contentHash: string;
}

/** GET /api/coa: every stored chart of accounts, by id. The positions import form offers these as its pick. */
export async function listCoa(): Promise<CoaListItem[]> {
  const reply = await request<{ coa: CoaListItem[] }>("/coa");
  return reply.coa;
}

/** POST /api/workspaces/:id/blocks: set, add, remove or set-default. 201 with the new head; 409 stale revision or locked. */
export function setBlock(id: string, body: SetBlockBody): Promise<WorkspaceManifest> {
  return postJson<WorkspaceManifest>(`/workspaces/${enc(id)}/blocks`, body);
}

/** POST /api/workspaces/:id/meta: rename and note. The cut-off date, type and id never change (422). */
export function setMeta(id: string, body: SetMetaBody): Promise<WorkspaceManifest> {
  return postJson<WorkspaceManifest>(`/workspaces/${enc(id)}/meta`, body);
}

/** POST /api/workspaces/:id/clone: copy, roll-forward or (with supersedeSource) supersede. 201 with the clone and its readiness. */
export function cloneWorkspace(id: string, body: CloneWorkspaceBody): Promise<CloneWorkspaceReply> {
  return postJson<CloneWorkspaceReply>(`/workspaces/${enc(id)}/clone`, body);
}

/** POST /api/workspaces/:id/market/reapply: re-apply the carried market definitions on the new base. Answers the head. */
export function reapplyMarket(id: string, body: ReapplyMarketBody): Promise<WorkspaceManifest> {
  return postJson<WorkspaceManifest>(`/workspaces/${enc(id)}/market/reapply`, body);
}

/** POST /api/workspaces/:id/archive: no unarchive in Slice 1. Answers the head. */
export function archiveWorkspace(id: string, body: ArchiveWorkspaceBody): Promise<WorkspaceManifest> {
  return postJson<WorkspaceManifest>(`/workspaces/${enc(id)}/archive`, body);
}

/**
 * POST /api/workspaces/:id/sign-off: writes the approval record; a Production workspace is then
 * locked. Answers the head. 409 when `signedHash` no longer matches the head.
 */
export function signOffWorkspace(id: string, body: SignOffBody): Promise<WorkspaceManifest> {
  return postJson<WorkspaceManifest>(`/workspaces/${enc(id)}/sign-off`, body);
}

/** GET /api/run-setups?workspaceId=: the workspace's slots joined to their current documents. */
export function listRunSetups(workspaceId: string): Promise<RunSetupsReply> {
  return request<RunSetupsReply>(`/run-setups?workspaceId=${enc(workspaceId)}`);
}

/** GET /api/run-setups/:docId: one immutable setup document. */
export function getRunSetup(docId: string): Promise<RunSetup> {
  return request<RunSetup>(`/run-setups/${enc(docId)}`);
}

/** POST /api/run-setups: append-only. A new document moves or adds the slot (201); the same content is 200 and moves nothing. */
export function saveRunSetup(body: SaveRunSetupBody): Promise<SaveRunSetupReply> {
  return postJson<SaveRunSetupReply>("/run-setups", body);
}

/** POST /api/workspaces/:id/setups/:lineageId/validate: compile, check the pins, report. Writes one line to setups.ndjson. */
export function validateSetup(id: string, lineageId: string, body: ValidateSetupBody): Promise<ValidateSetupReply> {
  return postJson<ValidateSetupReply>(`/workspaces/${enc(id)}/setups/${enc(lineageId)}/validate`, body);
}

/**
 * GET /api/workspaces/:id/setups/:lineageId/validations: the slot's stored validations, newest first,
 * at most the last 20. Read-only; the reply's `validations` array is returned unwrapped.
 */
export async function listSetupValidations(id: string, lineageId: string): Promise<SetupValidationEntry[]> {
  const r = await request<{ validations: SetupValidationEntry[] }>(`/workspaces/${enc(id)}/setups/${enc(lineageId)}/validations`);
  return r.validations;
}

/**
 * POST /api/workspaces/:id/setups/:lineageId/launch: compile, check the gate, submit. 200 and 207
 * are replies (a 207 carries `cancel` offers). A refusal is an ApiError whose `body` is a
 * LaunchGateRefusal (409), a LaunchBatchRefusal (422) or the refused submission's own error.
 */
export function launchSetup(id: string, lineageId: string, body: LaunchSetupBody): Promise<LaunchReply> {
  return postJson<LaunchReply>(`/workspaces/${enc(id)}/setups/${enc(lineageId)}/launch`, body);
}

// ---------------------------------------------------------------------------
// Curve setups: apps/server/src/http/routes/curveSetups.ts
// ---------------------------------------------------------------------------

/** The `refusals` list of a 422 body, when it carries one as a list of sentences; otherwise null. */
function refusalsOf(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const r = (body as { refusals?: unknown }).refusals;
  return Array.isArray(r) && r.every((s) => typeof s === "string") ? (r as string[]) : null;
}

/**
 * POST JSON where a refused setup is a reply: a 422 whose body carries `refusals` answers
 * { ok: false, refusals }; any other non-2xx is the ApiError the shared transport raises.
 */
async function postRefusable<T>(path: string, body: unknown): Promise<T | CurveSetupRefused> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 422) {
    let parsed: unknown;
    try {
      parsed = await res.clone().json();
    } catch {
      // Not JSON: fall through to the ApiError below.
    }
    const refusals = refusalsOf(parsed);
    if (refusals !== null) return { ok: false, refusals };
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/** GET /api/workspaces/:id/curve-setups: each slot's current document, summarised, and whether it is the active one. */
export function listCurveSetups(workspaceId: string): Promise<CurveSetupsReply> {
  return request<CurveSetupsReply>(`/workspaces/${enc(workspaceId)}/curve-setups`);
}

/** GET /api/curve-setups/:docId: one immutable curve setup document, the whole block (id and baseCurve included). */
export function getCurveSetup(docId: string): Promise<CurveSetupBlock> {
  return request<CurveSetupBlock>(`/curve-setups/${enc(docId)}`);
}

/**
 * POST /api/workspaces/:id/curve-setups: append-only; the setup's own `id` names its slot. A refused
 * setup is { ok: false, refusals }; a stale revision or a locked workspace is a 409 ApiError, as for run setups.
 */
export async function saveCurveSetup(
  workspaceId: string,
  setup: CurveSetupBlock,
  expectedRevision: number,
  by: string,
): Promise<SaveCurveSetupResult> {
  const reply = await postRefusable<{ id: string; revision: number }>(`/workspaces/${enc(workspaceId)}/curve-setups`, {
    setup,
    expectedRevision,
    by,
  });
  return "refusals" in reply ? reply : { ok: true, id: reply.id, revision: reply.revision };
}

/** POST /api/workspaces/:id/curve-setups/:setupId/activate: the workspace runs on this setup. 404 unknown setup, 409 stale revision. */
export function activateCurveSetup(workspaceId: string, setupId: string, expectedRevision: number, by: string): Promise<{ revision: number }> {
  return postJson<{ revision: number }>(`/workspaces/${enc(workspaceId)}/curve-setups/${enc(setupId)}/activate`, { expectedRevision, by });
}

/** POST /api/workspaces/:id/curve-setups/deactivate: back to the platform default curve. 409 stale revision or nothing active. */
export function deactivateCurveSetup(workspaceId: string, expectedRevision: number, by: string): Promise<{ revision: number }> {
  return postJson<{ revision: number }>(`/workspaces/${enc(workspaceId)}/curve-setups/deactivate`, { expectedRevision, by });
}

/** POST /api/curve-setups/preview: build without saving. Both arms verbatim; a refused setup is data, never thrown. */
export function previewCurveSetup(setup: CurveSetupBlock): Promise<CurveSetupPreview> {
  return postRefusable<CurveSetupPreview>("/curve-setups/preview", { setup });
}

// ---------------------------------------------------------------------------
// Derived curves: apps/server/src/http/routes/derivedCurves.ts
// ---------------------------------------------------------------------------

/** GET /api/workspaces/:id/derived-curves: each slot's current document, with `missing` naming any slot whose document is gone. */
export function listDerivedCurves(workspaceId: string): Promise<DerivedCurvesReply> {
  return request<DerivedCurvesReply>(`/workspaces/${enc(workspaceId)}/derived-curves`);
}

/** GET /api/derived-curves/:docId: one immutable derived curve document, the whole block. */
export function getDerivedCurve(docId: string): Promise<DerivedCurveBlock> {
  return request<DerivedCurveBlock>(`/derived-curves/${enc(docId)}`);
}

/**
 * POST /api/workspaces/:id/derived-curves: append-only; the curve's own `id` names its slot. A refused
 * curve is { ok: false, refusals }; a stale revision or a locked workspace is a 409 ApiError.
 */
export async function saveDerivedCurve(
  workspaceId: string,
  curve: DerivedCurveBlock,
  expectedRevision: number,
  by: string,
): Promise<SaveDerivedCurveResult> {
  const reply = await postRefusable<{ id: string; revision: number }>(`/workspaces/${enc(workspaceId)}/derived-curves`, {
    curve,
    expectedRevision,
    by,
  });
  return "refusals" in reply ? reply : { ok: true, id: reply.id, revision: reply.revision };
}

/**
 * POST /api/workspaces/:id/derived-curves/estimate: the spread rows `from` minus `minus` at the given
 * tenors, written nowhere. `from` and `minus` each name a curve setup by its own id, or "platform-default".
 * Both arms verbatim; a refused estimate is data, never thrown.
 */
export function estimateDerivedCurve(workspaceId: string, from: string, minus: string, tenors: readonly number[]): Promise<DerivedCurveEstimate> {
  return postRefusable<DerivedCurveEstimate>(`/workspaces/${enc(workspaceId)}/derived-curves/estimate`, { from, minus, tenors });
}
