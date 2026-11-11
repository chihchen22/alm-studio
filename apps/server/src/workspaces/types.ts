/**
 * Workspace manifest types (Studio A+E spec v3.1 Section 2.2) and the run setup
 * document types (Section 5.2), verbatim, plus the history and attachment line
 * shapes the workspace store writes (plan Shared interfaces).
 *
 * A workspace owns references, not copies: every DocRef pins a stored document
 * by id and the store's meta contentHash at pin time.
 */
import type { LiquidityStressOptions, ModelConvention, NewVolumeTemplateSpec, NmdWarmupRequest, PlanReport, PlanScenarioRef, PlanStage, SegCprOverlay, ViewDef } from "@alm/engine";
import type { Profile } from "@alm/harness";
import type { Collection } from "../store/paths";

// ---------------------------------------------------------------------------
// Spec Section 2.2: the manifest
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

// ---------------------------------------------------------------------------
// Plan Shared interfaces: block names, history lines, attachments
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Spec Section 5.2: the run setup document
// ---------------------------------------------------------------------------

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
