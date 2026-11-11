/**
 * defineScenario: a pure builder from a ScenarioSpec to a Scenario. No side
 * effect, no mutation, no aliasing of the caller's nested objects.
 *
 * Validation here is structural only: ids present, the rate spec well-formed
 * (finite shocks, a positive twist pivot, a well-formed custom tenor vector).
 * The twist pivot cannot be checked against the curve's longest tenor at this
 * layer (no curve is bound yet); that bound is enforced by twistCurve at run
 * time. The custom vector's structural gate (validateCustomShocks) is curve-
 * free by design, so the full knot check runs here at definition time.
 */
import type { RateSpec, Scenario } from "../contracts/scenario";
import type { ScenarioSpec } from "../contracts/tools";
import { validateCustomShocks } from "./rateEnvironment";

/** Thrown when a ScenarioSpec is structurally invalid. */
export class ScenarioSpecError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`invalid scenario spec at ${field}: ${detail}`);
    this.name = "ScenarioSpecError";
    this.field = field;
  }
}

/** Describe a value's runtime kind for a shape-gate detail message. */
function foundKind(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "an array";
  return typeof x;
}

/**
 * Shape gate for direct callers: the spec and its nested objects are wire
 * input here, not trusted platform output. Every failure is the same typed
 * ScenarioSpecError the field gates throw; no raw TypeError ("Cannot read
 * properties of ...") ever escapes this module.
 */
function requireObjectShape(x: unknown, field: string): void {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new ScenarioSpecError(field, `expected an object, got ${foundKind(x)}`);
  }
}

function validateRateSpec(rateSpec: RateSpec): void {
  switch (rateSpec.kind) {
    case "base":
      return;
    case "parallel":
      if (!Number.isFinite(rateSpec.shockBp)) {
        throw new ScenarioSpecError("rateSpec.shockBp", "must be a finite number");
      }
      return;
    case "twist":
      if (!Number.isFinite(rateSpec.shortBp) || !Number.isFinite(rateSpec.longBp)) {
        throw new ScenarioSpecError("rateSpec", "shortBp and longBp must be finite");
      }
      if (!(rateSpec.pivotYears > 0)) {
        throw new ScenarioSpecError("rateSpec.pivotYears", "must be positive");
      }
      return;
    case "custom":
      // Structural gate on the per-tenor vector: throws CustomShockError with
      // the offending knot's field path and tenor in the message, which the
      // platform's `validated` wrapper surfaces verbatim as a 422.
      validateCustomShocks(rateSpec.shocks);
      return;
    default: {
      const bad = rateSpec as { kind: string };
      throw new ScenarioSpecError("rateSpec.kind", `unrecognized rate spec kind ${bad.kind}`);
    }
  }
}

/** Build a Scenario from a validated spec. Pure; returns fresh nested objects. */
export function defineScenario(spec: ScenarioSpec): Scenario {
  requireObjectShape(spec, "spec");
  if (typeof spec.id !== "string" || spec.id.length === 0) {
    throw new ScenarioSpecError("id", "must be a non-empty string");
  }
  if (typeof spec.assumptionSetId !== "string" || spec.assumptionSetId.length === 0) {
    throw new ScenarioSpecError("assumptionSetId", "must be a non-empty string");
  }
  requireObjectShape(spec.rateSpec, "rateSpec");
  validateRateSpec(spec.rateSpec);
  requireObjectShape(spec.newBusiness, "newBusiness");
  if (!Array.isArray(spec.newBusiness.rules)) {
    throw new ScenarioSpecError(
      "newBusiness.rules",
      `expected an array, got ${foundKind(spec.newBusiness.rules)}`,
    );
  }
  return {
    id: spec.id,
    label: spec.label,
    rateSpec:
      spec.rateSpec.kind === "custom"
        ? { kind: "custom", shocks: spec.rateSpec.shocks.map((k) => ({ ...k })) }
        : { ...spec.rateSpec },
    assumptionSetId: spec.assumptionSetId,
    newBusiness: {
      mode: spec.newBusiness.mode,
      rules: spec.newBusiness.rules.map((r) => ({ ...r })),
    },
  };
}
