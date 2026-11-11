/**
 * Scenario cards (Studio S3b): each scenario of the plan, and each library
 * scenario the plan lacks, in words plus its shock picture. Every text is read
 * off the stored plan or library; the only number a card shows is one the spec
 * states.
 */
import type { PlanScenarioRef, RateSpec, RunPlan, ScenarioDefinition, ScenarioLibrary } from "@alm/engine";
import { lookupRef, scenarioIdOf } from "./scenarioEdits";
import { pictureFor, type Picture } from "./shockPicture";

export interface ScenarioCard {
  /** Position in plan.scenarios; null for a library scenario not in the plan. */
  index: number | null;
  id: string;
  label: string;
  source: string;
  /**
   * The library ref behind the card: the plan's `{ ref }`, the library card's
   * "<libId>#<scenarioId>", or the ref an inline copy matches; null for an
   * inline scenario no library holds.
   */
  ref: string | null;
  /** False only for a plan `{ ref }` that no library holds; `ref` is then that ref. */
  refKnown: boolean;
  rateText: string;
  timingText: string;
  setText: string;
  picture: Picture;
}

/** A signed bp shift: "+200bp", "-100bp", and "0bp" for zero. */
function bp(n: number): string {
  return n > 0 ? `+${n}bp` : `${n}bp`;
}

export function rateSpecText(spec: RateSpec): string {
  switch (spec.kind) {
    case "base":
      return "Base curve, no shock";
    case "parallel":
      return `Parallel ${bp(spec.shockBp)}, all tenors`;
    case "twist":
      return `Twist: ${bp(spec.shortBp)} at 0Y, 0 at ${spec.pivotYears}Y, ${bp(spec.longBp)} at the longest curve tenor`;
    case "custom":
      return spec.shocks.length === 0
        ? "Custom: no knot stated"
        : `Custom: ${spec.shocks.map((s) => `${bp(s.shockBp)} at ${s.tenorYears}Y`).join(", ")}, flat beyond`;
  }
}

function timingText(def: ScenarioDefinition): string {
  return def.timing?.kind === "ramp" ? `Ramp over ${def.timing.months} months` : "Immediate";
}

function defaultSetText(plan: RunPlan): string {
  const d = plan.inputs.assumptionSets?.[0];
  return d === undefined ? "plan default: none stated, validate refuses the plan until a default set is named" : `plan default: ${d}`;
}

/** The first library ref whose scenario id is `id`, for an inline copy. */
function libraryRefOf(id: string, libraries: ScenarioLibrary[]): string | undefined {
  const lib = libraries.find((l) => l.scenarios.some((s) => s.id === id));
  return lib === undefined ? undefined : `${lib.id}#${id}`;
}

function card(index: number | null, def: ScenarioDefinition, source: string, ref: string | null, plan: RunPlan): ScenarioCard {
  return {
    index,
    id: def.id,
    label: def.label ?? def.id,
    source,
    ref,
    refKnown: true,
    rateText: rateSpecText(def.rateSpec),
    timingText: timingText(def),
    setText: def.assumptionSetId ?? defaultSetText(plan),
    picture: pictureFor(def),
  };
}

function planCard(plan: RunPlan, s: PlanScenarioRef, index: number, libraries: ScenarioLibrary[]): ScenarioCard {
  if ("ref" in s) {
    const def = lookupRef(s.ref, libraries);
    const source = `library ref ${s.ref}`;
    if (def !== undefined) return card(index, def, source, s.ref, plan);
    const reason = `unknown scenario ref "${s.ref}"`;
    const id = scenarioIdOf(s);
    return {
      index, id, label: id, source, ref: s.ref, refKnown: false,
      rateText: reason, timingText: reason, setText: reason, picture: { kind: "refused", reason },
    };
  }
  const ref = libraryRefOf(s.id, libraries);
  return ref === undefined ? card(index, s, "inline", null, plan) : card(index, s, `inline copy of ${ref}`, ref, plan);
}

export function planCards(plan: RunPlan, libraries: ScenarioLibrary[]): ScenarioCard[] {
  return plan.scenarios.map((s, i) => planCard(plan, s, i, libraries));
}

/** Library scenarios whose id the plan lacks, in library order. */
export function libraryCards(plan: RunPlan, libraries: ScenarioLibrary[]): ScenarioCard[] {
  const have = new Set(plan.scenarios.map(scenarioIdOf));
  return libraries.flatMap((l) => l.scenarios
    .filter((s) => !have.has(s.id))
    .map((s) => card(null, s, `library ref ${l.id}#${s.id}`, `${l.id}#${s.id}`, plan)));
}
