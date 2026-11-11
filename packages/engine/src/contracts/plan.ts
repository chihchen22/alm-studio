/**
 * Run plan contract (harness Plane 4). A plan is DATA authored by a person or
 * an agent, validated by the type gate and the routing gate, and compiled into
 * a RunRequest. Nothing in a plan is a result. Shapes mirror
 * docs/harness/example-plan.json at schemaVersion 1.4.0 so composer.html and
 * the engine read one file. 1.2.0 is additive over 1.1.0: it adds `profile`,
 * and a 1.1.0 file that declares none compiles on DEFAULT_PROFILE unchanged.
 * 1.3.0 is additive over 1.2.0: it adds `StageSelector.dimensions`,
 * and a 1.2.0 file that states no predicate behaves exactly as before.
 * 1.4.0 is additive over 1.3.0: it adds `views`, and a 1.3.0 file
 * that declares none runs exactly as before.
 */
import type { Profile } from "@alm/harness";
import type { DimensionPredicate } from "./dimensions";
import type { AssumptionSetId, PortfolioId, ProductFamilyId, ScenarioId } from "./ids";
import type { NewBusinessTemplate, ScenarioDefinition } from "./scenario";
import type { ViewDef } from "./views";

// 1.3.0: StageSelector.dimensions.
// 1.4.0: RunPlan.views.
export const PLAN_SCHEMA_VERSION = "1.4.0" as const;

export const CONTRACT_TYPE_NAMES = [
  "MarketSnapshot", "ZeroCurve", "CapVolSurface", "RatePath", "DiscountFactorPath",
  "Position", "Cashflow", "RepricingSchedule", "CommitmentSchedule",
  "ClientRatePath", "DepositRatePath", "NiiResult", "EveResult", "GapResult",
  // The ftp metric's own result slot. Before this the ftp plugin
  // declared NiiResult, which T6 now refuses: two metric stages cannot fill one
  // result slot, and the envelope has carried a separate `ftp` block since 1.2.0.
  "FtpResult",
  // The all-in funding leg, distinct from the risk-free ZeroCurve.
  // EVE and FTP shock off the risk-free leg and discount on this one, and an
  // edge names one producer per consumed type, so the two legs are two types
  // rather than one artifact carrying both.
  "FundingCurve",
  // The fifth metric slot. ONE type for every custom metric, because
  // the result shape is fixed (ruling 1); the metric ID rides inside the
  // payload. A plan may carry one stage producing it, which is the existing
  // two-producer conflict rule and not a new one.
  "CustomMetricResult",
] as const;
export type ContractTypeName = (typeof CONTRACT_TYPE_NAMES)[number];

/** Types a context file supplies; a stage consuming one needs no upstream producer. */
export const CONTEXT_SUPPLIED_TYPES: readonly ContractTypeName[] = ["MarketSnapshot", "Position", "CapVolSurface"];

export const STAGE_KINDS = [
  "market-data", "curve", "term-structure", "contractual-cashflow", "behavioral",
  "panel-intake", "calibration", "balance-new-business", "metric",
] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const METRIC_IDS = ["nii", "eve", "ir-gap", "liq-gap"] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const BEHAVIORAL_CLASS_IDS = [
  "prepayment", "client-rate-asset", "draw-utilization", "product-mix",
  "new-volume", "decay", "early-withdrawal", "deposit-beta",
] as const;
export type BehavioralClassId = (typeof BEHAVIORAL_CLASS_IDS)[number];

export type Disposition = "M" | "A";
export type RoutingValue = Disposition | "none";
export type GovernanceTier = "Tier 1" | "Tier 2" | "Tier 3";

export interface StageSelector {
  productFamily?: ProductFamilyId | ProductFamilyId[];
  /** Compared lowercase against the COA family side. */
  side?: string;
  behavioralClasses?: BehavioralClassId | BehavioralClassId[];
  /** Authored tags the position must match, any-of within a tag and all-of across tags. */
  dimensions?: DimensionPredicate;
}

/**
 * Where an artifact lives. One shelf key is (contract type, scope,
 * producer stage id): the producer is part of the key because two stages may
 * honestly produce one type, which is what the bootstrap curve and the all-in
 * funding curve do. The three scopes are the three cardinalities the run has:
 * one per run, one per scenario, one per assumption set.
 */
export type ArtifactScope =
  | { kind: "run" }
  | { kind: "scenario"; scenarioId: string }
  | { kind: "assumptionSet"; assumptionSetId: string };

/**
 * The canonical string of a scope. Distinct scopes canonicalise distinctly even
 * when a scenario and an assumption set share an id, which they may: the kind is
 * part of the string, never dropped.
 */
export function scopeKey(scope: ArtifactScope): string {
  switch (scope.kind) {
    case "run":
      return "run";
    case "scenario":
      return `scenario:${scope.scenarioId}`;
    case "assumptionSet":
      return `assumptionSet:${scope.assumptionSetId}`;
  }
}

/**
 * One binding a behavioral stage licenses. The
 * stage is the license; the assumption set keeps the parameters. A binding has
 * exactly one licensee, which the compiler enforces.
 */
export interface LicensedBinding {
  stageId: string;
  assumptionSetId: AssumptionSetId;
  familyId: ProductFamilyId;
  /** The registry key of the overlay kind, `overlayKindOf(binding.overlay)`. */
  kind: string;
  /** Index into the assumption set's bindings: (familyId, kind) no longer identifies a binding. */
  bindingIndex: number;
}

export interface PlanStage {
  id: string;
  component: string;
  kind: StageKind;
  consumes: ContractTypeName[];
  produces: ContractTypeName[];
  dependsOn?: string[];
  selector?: StageSelector;
  disposition?: Disposition;
  tier?: GovernanceTier;
  feeds?: MetricId[];
  params?: Record<string, number | string | boolean>;
  note?: string;
}

export interface PlanInputs {
  marketSnapshot: string;
  positionBook: PortfolioId;
  routingPolicy: string;
  dimensionTaxonomy?: string;
  /** Assumption set ids the scenarios reference. Optional in 1.1.0 files; the compiler derives it from the scenarios when absent. */
  assumptionSets?: AssumptionSetId[];
}

export type PlanScenarioRef =
  | ScenarioDefinition
  | { ref: string };

export interface PlanReport {
  id: string;
  view: string;
  metrics: MetricId[];
  note?: string;
}

/**
 * Studio A+E contract 18: a balance sheet held flat by rolling every maturing
 * dollar into new business at `termMonths` and `spreadOverIndexBp`. Both are
 * optional; the dynamic projection supplies its own defaults when absent.
 */
export interface BalanceBasisFlat {
  kind: "flat";
  termMonths?: number;
  spreadOverIndexBp?: number;
}

export interface RunPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  planId: string;
  label: string;
  authoredBy: "person" | "orchestrator";
  asOf: string;
  grid: { horizonMonths: number };
  note?: string;
  inputs: PlanInputs;
  /**
   * The plugin rows this plan runs on. Absent means DEFAULT_PROFILE,
   * so every schema 1.1.0 plan compiles unchanged. Request patches apply after
   * these rows, in the order the request lists them.
   */
  profile?: Profile;
  /**
   * The views this plan reports along. Absent means no view, which
   * is today's behaviour. compilePlan copies the list onto the RunRequest.
   */
  views?: ViewDef[];
  stages: PlanStage[];
  scenarios: PlanScenarioRef[];
  balancePlan?: string;
  /**
   * Studio A+E contract 18: the Flat balance sheet basis without a stored plan.
   * Lowered at compile into one `reinvest: "flat"` rule per family with a positive
   * opening balance; mutually exclusive with `balancePlan`. Additive: absent means
   * today's behaviour and today's plan hash.
   */
  balanceBasis?: BalanceBasisFlat;
  /**
   * A balance plan per scenario, keyed by the scenario id the plan
   * resolves (inline id, or the text after "#" in a ref). A scenario's own
   * newBusiness wins over its entry; its entry wins over `balancePlan`.
   * Additive: absent means today's behaviour and today's plan hash.
   */
  scenarioBalancePlans?: Record<ScenarioId, string>;
  /**
   * The product each family's new volume is, one entry per family. The compile sets
   * each on the rule its basis lowers for that family (the Flat basis, `balancePlan`, `scenarioBalancePlans`), with
   * the entry's term and spread in place of the basis's or the target's; a scenario's own inline newBusiness is left
   * as written. A family that gets no rule (it runs off) does not read its entry. Additive: absent means today's
   * fixed bullet and today's plan hash.
   */
  newVolumeTemplates?: NewVolumeTemplateSpec[];
  reports: PlanReport[];
  validationRules: { typeGate: string[]; routingGate: string[] };
}

/** One family's new-volume product on a plan: the template, with the term and spread it is sold at. */
export interface NewVolumeTemplateSpec extends NewBusinessTemplate {
  familyId: ProductFamilyId;
  termMonths: number;
  spreadOverIndexBp: number;
}

export interface RoutingClass {
  id: BehavioralClassId;
  label: string;
  side: string;
  chapter?: string;
  routing: Record<MetricId, RoutingValue>;
  rationale?: string;
}

export interface RoutingPolicy {
  schemaVersion: string;
  id: string;
  label: string;
  metrics: Array<{ id: MetricId; label: string; basis: string }>;
  classes: RoutingClass[];
}

export type GateRule = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "R1" | "R2" | "R3" | "R4";

export interface GateFailure {
  gate: "type" | "routing";
  rule: GateRule;
  /** null when the failure is plan-wide. */
  stageId: string | null;
  detail: string;
}

export interface GateReport {
  passed: boolean;
  failures: GateFailure[];
  /** One line per check performed, so a pass is auditable, not silent. */
  checked: string[];
}

/** Plan identity stamped into a RunRequest and its provenance. */
export interface PlanRef {
  planId: string;
  planHash: string;
  /**
   * Content hash of the routing policy the plan compiled against (round-2
   * ruling 14). Optional on the contract, so a plan block written before this
   * field existed still reads: ADR-015, additive only. `compilePlan` always
   * stamps it and asserts that it did, so a COMPILED request carries it.
   */
  policyHash?: string;
  /** Content hash of the balance plan, when the plan declared one. */
  balancePlanHash?: string;
  /** Studio A+E contract 18: the Flat basis the plan declared, copied verbatim; absent otherwise. */
  balanceBasis?: BalanceBasisFlat;
  /** The content hash of the balance plan each mapped scenario consumed; consumers only. */
  scenarioBalancePlanHashes?: Record<ScenarioId, string>;
  /**
   * Which behavioral stage licenses which binding. Optional, by
   * An archived request written before this field existed still reads,
   * and a run given a plan with no licensing derives it the same way the
   * compiler does, from the same function.
   */
  licensedBindings?: LicensedBinding[];
}

export type { ScenarioId };
