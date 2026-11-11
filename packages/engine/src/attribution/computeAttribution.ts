/**
 * Attribution engine: decompose each headline delta versus base into per-family,
 * per-driver contributions with an explicit, unhidden residual (contract
 * results.ts AttributionResult). This is the sole input the explain layer
 * narrates (tools.ts Explanation), so every number it emits must trace to a
 * concrete peel step, never to an impression of the report.
 *
 * INPUT, and why it is a metric evaluator rather than two endpoint numbers.
 * A headline delta cannot be split among seven drivers from the base and
 * scenario totals alone: two numbers carry no information about which driver
 * moved them. The decomposition therefore re-evaluates the metric under
 * intermediate configurations in which some drivers sit at their base values and
 * the rest at their scenario values. Producing those intermediate values is a
 * re-run of the projection/NII/EVE pipeline under a partial configuration; that
 * orchestration belongs to the run layer, not here. This module consumes it
 * through a caller-supplied `FamilyMetricEvaluator` and owns only the peel order
 * and the residual accounting. The evaluator's purity is the caller's contract:
 * the same (familyId, applied) must return the same number, or both determinism
 * and the peel identity break.
 *
 * Determinism: pure arithmetic over the input in a fixed order. Families iterate
 * in the caller's supplied order (the COA's declared family order); drivers
 * iterate in PEEL_ORDER. No clock, no RNG, no map-iteration-order dependence.
 */
import type { ProductFamilyId, ScenarioId } from "../contracts/ids";
import type {
  AttributionDriver,
  AttributionResult,
  DriverContribution,
  HeadlineAttribution,
} from "../contracts/results";

/**
 * THE FIXED PEEL ORDER. Read this before changing anything below.
 *
 * The decomposition is a CUMULATIVE peel: starting from the all-base state, the
 * drivers are switched to their scenario values ONE AT A TIME in this exact
 * order, and each driver's contribution is the change in the metric caused by
 * its switch given every earlier driver is already switched. That makes the
 * split ORDER-DEPENDENT: any interaction (cross) term between two drivers is
 * absorbed by whichever of them is peeled LATER, because the cross term only
 * activates once both are on. Reordering the list would move interaction mass
 * between drivers. The order is fixed here, once, so that re-running a decomposi-
 * tion is reproducible and two runs report identical contributions.
 *
 * The order matches the contract's AttributionDriver enum and reads outermost
 * (the rate environment everything else responds to) to innermost (new business,
 * the last thing layered onto the projected book):
 *   rate -> volume -> mix -> prepay -> deposit-beta -> decay -> new-business.
 *
 * The TOTAL explained (the sum of all contributions) is order-INDEPENDENT: it is
 * always evaluate(all-on) - evaluate(all-base). Only the split among drivers
 * depends on the order. The residual is what that total leaves unexplained
 * against the actual, independently-reported scenario delta; it is never driven
 * to zero by construction (see decomposeHeadline).
 */
export const PEEL_ORDER: readonly AttributionDriver[] = [
  "rate",
  "volume",
  "mix",
  "prepay",
  "deposit-beta",
  "decay",
  "new-business",
];

/** The three headline metrics attribution decomposes. */
export type HeadlineMetric = HeadlineAttribution["metric"];

/**
 * Evaluates one family's contribution to a headline metric under a peel state.
 * `applied` is always a prefix of PEEL_ORDER, in order: the drivers switched
 * from their base values to their scenario values. The empty prefix is the
 * all-base state; the full PEEL_ORDER prefix is the all-scenario state. To keep
 * the peel order this module's responsibility, the evaluator receives which
 * drivers are on, never a peel step index it would have to interpret.
 */
export type FamilyMetricEvaluator = (
  familyId: ProductFamilyId,
  applied: readonly AttributionDriver[],
) => number;

/** One headline movement to decompose. */
export interface HeadlineTarget {
  metric: HeadlineMetric;
  scenarioId: ScenarioId;
  /**
   * Actual base-scenario total for this metric, from the base run result. The
   * caller should anchor the evaluator's all-base state to this same base run so
   * the residual reflects only the scenario-end reconstruction gap, not a base
   * mismatch.
   */
  baseValue: number;
  /** Actual shocked-scenario total for this metric, from the shocked run result. */
  scenarioValue: number;
  /** Families to decompose, in report order (COA declared family order). */
  families: readonly ProductFamilyId[];
  /** Peel evaluator for this metric and scenario. */
  evaluate: FamilyMetricEvaluator;
}

export interface AttributionInput {
  headlines: readonly HeadlineTarget[];
}

/** Guard the anti-fabrication rule: a non-finite metric must surface, not serialize as NaN. */
function requireFinite(value: number, familyId: ProductFamilyId, metric: HeadlineMetric): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `attribution: evaluator returned a non-finite value (${value}) for family "${familyId}" on metric "${metric}"`,
    );
  }
  return value;
}

/**
 * Decompose one headline. The cumulative peel walks PEEL_ORDER per family,
 * differencing successive evaluations; the residual closes the reported
 * contributions against the actual delta.
 */
function decomposeHeadline(target: HeadlineTarget): HeadlineAttribution {
  const { metric, scenarioId, baseValue, scenarioValue, families, evaluate } = target;

  const contributions: DriverContribution[] = [];
  // Accumulated in the SAME order rows are pushed, so it equals a left-fold over
  // `contributions` bit-for-bit: this is exactly the contract's "sum(contributions)".
  let sumContribs = 0;

  const applied: AttributionDriver[] = [];
  for (const familyId of families) {
    applied.length = 0;
    let prev = requireFinite(evaluate(familyId, applied), familyId, metric);
    for (const driver of PEEL_ORDER) {
      applied.push(driver);
      const curr = requireFinite(evaluate(familyId, applied), familyId, metric);
      const amount = curr - prev;
      contributions.push({ familyId, driver, amount });
      sumContribs += amount;
      prev = curr;
    }
  }

  const totalDelta = scenarioValue - baseValue;
  // Contract definition: residual = sum(contributions) - totalDelta. When the
  // enumerated drivers fully reconstruct the scenario, this is zero; when they do
  // not, it carries the unexplained remainder explicitly. It is reported, never
  // folded back into a driver to fake a clean decomposition.
  const residual = sumContribs - totalDelta;

  return { metric, scenarioId, baseValue, scenarioValue, totalDelta, contributions, residual };
}

/** Decompose every headline movement into its per-family, per-driver contributions. */
export function computeAttribution(input: AttributionInput): AttributionResult {
  return { headlines: input.headlines.map(decomposeHeadline) };
}
