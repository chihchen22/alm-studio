/**
 * The plan barrel (harness Plane 4): parse, gates, lowering, and the
 * compiler that turns a validated plan into a RunRequest. No compute lives here.
 */
export { parseRunPlan, parseRoutingPolicy, PlanShapeError } from "./parse";
export { typeGate, type StageProducers } from "./typeGate";
export { routingGate, selectorMatchesFamily } from "./routingGate";
export { derivedClassesByFamily, OVERLAY_KIND_TO_CLASS } from "./behavioralClasses";
export { lowerBalancePlan, BalancePlanUnsupported } from "./lowerBalancePlan";
// The new-volume template rule, pure (no kernel import), shared with the Studio.
export {
  DEFAULT_NEW_BUSINESS_TERM_MONTHS,
  MAX_TEMPLATE_TERM_MONTHS,
  TEMPLATE_AMORTIZATIONS,
  TEMPLATE_RATE_TYPES,
  newVolumeTemplateProblem,
} from "./newVolumeTemplate";
// The pure balance-shock derivation (additive; no run path imports it).
export {
  deriveBalancePlan,
  derivedBalancePlanId,
  BalancePlanDerivationError,
  BALANCE_DERIVED_ID_PREFIX,
  type BalancePlanDeriveOptions,
  type BalancePlanDeriveResult,
  type DerivationBook,
} from "./deriveBalancePlan";
export { resolveScenarios, ScenarioRefError } from "./resolveScenarios";
export { mergePlanTags } from "./mergePlanTags";
export {
  compilePlan,
  openingBalances,
  planHash,
  registryProducers,
  DuplicateScenarioIdError,
  PlanNotExecutableError,
  PlanRejected,
  ScenarioNotExecutableError,
  type CompiledPlan,
  type PlanStamps,
  type ResolvedPlanInputs,
} from "./compile";
export { COMPONENT_ALIASES, resolveComponent } from "./componentAliases";
export { producersOf } from "./edges";
export { kindsByPlugin, licenseBindings, type LicenseGap, type LicenseOutcome } from "./license";
// The compile refusals piece 2a adds. They live with the other executor errors
// so the server's 422 mapping already covers them; the plan barrel re-exports
// them because a caller that compiles a plan catches them here.
export {
  OverlappingBindingError,
  TaxonomyMismatchError,
  UnknownDimensionError,
  ViewDefinitionError,
} from "../run/executorErrors";
export {
  canonicalPredicate,
  checkPredicateAgainstTaxonomy,
  positionsMatchedBy,
  selectorMatchesBag,
  stageSelectorMatchesPosition,
} from "./dimensions";
