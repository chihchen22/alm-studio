/**
 * @alm/engine scenario-binding module (m04).
 *
 * Assumption sets are DATA in, executable models out:
 *   - defineScenario: pure ScenarioSpec -> Scenario builder;
 *   - bindAssumptions: validate an AssumptionSet and fill its contentHash;
 *   - resolveAssumptions: OverlayBinding -> constructed kernel behavioral model;
 *   - rateEnvironment: build the base curve (a curve setup or the platform default curve) and shocked RatePaths;
 *   - deriveAssumptionSet: pure behavioral-shock derivation of one set from another.
 */
export { defineScenario, ScenarioSpecError } from "./defineScenario";
export { bindAssumptions, AssumptionValidationError } from "./bindAssumptions";
export {
  deriveAssumptionSet,
  derivedSetId,
  AssumptionDerivationError,
  MAX_DERIVATION_OPS,
  DERIVED_ID_PREFIX,
  DEMONSTRATION_SUFFIX,
  type DerivedSetResult,
  type DeriveOptions,
} from "./deriveAssumptionSet";
export {
  resolveAssumptions,
  UnknownFamilyError,
  DuplicateOverlayError,
  OverlayParamError,
  ClientRateSpreadMismatchError,
  type ResolvedAssumptions,
  type ResolvedOverlay,
} from "./resolveAssumptions";
export {
  buildBaseCurve,
  curveDefaultOf,
  curveDefaultStampOf,
  shockedCurve,
  twistCurve,
  twistShiftBp,
  customCurve,
  customShiftBp,
  validateCustomShocks,
  buildRatePath,
  discountFactorsMonotone,
  TwistError,
  CustomShockError,
} from "./rateEnvironment";
export {
  SHIPPED_LIBRARIES,
  REGULATORY_GRID_LIBRARY,
  STEEPENER_LIBRARY,
  FLATTENER_LIBRARY,
  RAMP_200_LIBRARY,
  SRP31_TENORS,
  SRP31_USD,
  srp31Scenario,
  srp31ShockBp,
  type Srp31Name,
} from "./library";
