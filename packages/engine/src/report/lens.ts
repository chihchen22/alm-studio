/**
 * The lens reading: score one finished run through one stored
 * lens definition.
 *
 * PURE. It reads a RunResult and a definition and returns a reading. No engine,
 * no portfolio, no market snapshot, no clock, and no recomputation of any
 * result number: every value is an envelope field a reader handed back.
 *
 * Byte identity. Object keys are written in the order the interfaces declare
 * them and arrays in the orders stated (constraints in lens author order,
 * scenarios in envelope order), so two readings of one envelope and one
 * definition serialize to the same bytes.
 *
 * Refusal versus unobservable. A refusal is what the envelope cannot answer at
 * all and it aborts the whole reading as a throw. An unobservable constraint is
 * the reader saying the number does not exist as a concept for this run or in
 * this build; it sits in the reading with its reason and contributes no
 * headroom.
 */
import type { ConstraintOp, LensDefinition, LensObjective, LensReaderId } from "../contracts/lens";
import type { RunResult } from "../contracts/run";
import { LENS_READERS } from "./lensReaders";
import { validateLens } from "./lensValidate";

export type ConstraintStatus = "pass" | "breach" | "unobservable";

export interface ConstraintReading {
  constraintId: string;
  reader: LensReaderId;
  params?: Record<string, string | number>;
  op: ConstraintOp;
  limit: number;
  /** Present on pass and breach. Absent on unobservable. */
  value?: number;
  /** Present on pass and breach. Absent on unobservable. */
  headroom?: number;
  /** "fraction" when limit is not 0, "absolute" when it is. Present with headroom. */
  headroomBasis?: "fraction" | "absolute";
  status: ConstraintStatus;
  /** Present on unobservable only. */
  reason?: string;
}

export interface ScenarioLensReading {
  scenarioId: string;
  /** Lens author order. */
  constraints: ConstraintReading[];
  /**
   * Min headroom over observable FRACTION-basis constraints; absent when none
   * is one. An absolute-basis constraint, which is
   * one whose limit is 0, still passes or breaches and still drives `status`;
   * it never sets the headline, because a currency or count slack is not
   * comparable with a fraction of a limit.
   */
  headline?: number;
  worstConstraintId?: string;
  /** breach if any breach; else pass if any pass; else unobservable. */
  status: ConstraintStatus;
}

export interface LensReading {
  lensId: string;
  objective: LensObjective;
  baseScenarioId: string;
  /** Envelope scenario order. */
  byScenario: ScenarioLensReading[];
  /**
   * Min headline over scenarios that have one; absent when none has one. Since
   * piece 3b a scenario has one only when at least one of its observable
   * constraints is fraction basis (ruling 5).
   */
  headline?: number;
  worst?: { scenarioId: string; constraintId: string };
  status: ConstraintStatus;
}

export interface LensQuery {
  /**
   * The scenario deltaNiiPct anchors to. Required even when no constraint needs
   * it, so one query shape serves every lens.
   */
  baseScenarioId: string;
  /** Optional: restrict to these scenario ids. The reading stays in envelope order. */
  scenarioIds?: string[];
}

/** The envelope cannot answer at all. Thrown, never returned; never a softened answer. */
export class LensUnavailableError extends Error {
  readonly lensId: string;
  readonly detail: string;
  constructor(lensId: string, detail: string) {
    super(`lens "${lensId}" cannot be read from this run: ${detail}`);
    this.name = "LensUnavailableError";
    this.lensId = lensId;
    this.detail = detail;
  }
}

export function readLens(
  result: RunResult,
  lens: LensDefinition,
  query: LensQuery,
): LensReading {
  // The route validates first, but the function validates too, so a caller
  // bypassing the route cannot read an invalid lens.
  const lensId = typeof lens?.id === "string" ? lens.id : String(lens?.id);
  const problems = validateLens(lens);
  if (problems.length > 0) {
    throw new LensUnavailableError(
      lensId,
      `the definition is not valid: ` +
        problems.map((p) => `${p.rule} ${p.field}: ${p.message}`).join("; "),
    );
  }

  // Envelope scenario order. EVE is one of the three mandatory result blocks the
  // compiler requires a producer for, so this list is the run's scenario list.
  const envelopeOrder = result.eve.byScenario.map((s) => s.scenarioId);
  const carried = `this envelope carries [${envelopeOrder.map((s) => `"${s}"`).join(", ")}]`;
  if (!envelopeOrder.includes(query.baseScenarioId)) {
    throw new LensUnavailableError(
      lensId,
      `the base scenario "${query.baseScenarioId}" is not on this envelope; ${carried}`,
    );
  }
  let scenarioIds = envelopeOrder;
  if (query.scenarioIds !== undefined) {
    for (const id of query.scenarioIds) {
      if (!envelopeOrder.includes(id)) {
        throw new LensUnavailableError(
          lensId,
          `the requested scenario "${id}" is not on this envelope; ${carried}`,
        );
      }
    }
    const asked = new Set(query.scenarioIds);
    scenarioIds = envelopeOrder.filter((id) => asked.has(id));
  }

  const byScenario: ScenarioLensReading[] = scenarioIds.map((scenarioId) =>
    readScenario(result, lens, lensId, scenarioId, query.baseScenarioId),
  );

  let worst: { headline: number; scenarioId: string; constraintId: string } | undefined;
  for (const s of byScenario) {
    if (s.headline === undefined || s.worstConstraintId === undefined) continue;
    // Strict less-than, so a tie keeps the FIRST scenario in envelope order.
    if (worst === undefined || s.headline < worst.headline) {
      worst = { headline: s.headline, scenarioId: s.scenarioId, constraintId: s.worstConstraintId };
    }
  }

  return {
    lensId: lens.id,
    objective: lens.objective,
    baseScenarioId: query.baseScenarioId,
    byScenario,
    ...(worst !== undefined
      ? { headline: worst.headline, worst: { scenarioId: worst.scenarioId, constraintId: worst.constraintId } }
      : {}),
    status: rollUp(byScenario.map((s) => s.status)),
  };
}

function readScenario(
  result: RunResult,
  lens: LensDefinition,
  lensId: string,
  scenarioId: string,
  baseScenarioId: string,
): ScenarioLensReading {
  const constraints: ConstraintReading[] = lens.constraints.map((c) => {
    const outcome = LENS_READERS[c.reader]({
      result,
      scenarioId,
      baseScenarioId,
      ...(c.params !== undefined ? { params: c.params } : {}),
    });
    if (outcome.kind === "refusal") {
      throw new LensUnavailableError(
        lensId,
        `constraint "${c.id}" on scenario "${scenarioId}": ${outcome.missing}`,
      );
    }
    const head = {
      constraintId: c.id,
      reader: c.reader,
      ...(c.params !== undefined ? { params: c.params } : {}),
      op: c.op,
      limit: c.limit,
    };
    if (outcome.kind === "unobservable") {
      return { ...head, status: "unobservable" as const, reason: outcome.reason };
    }
    // atMost: how far under the ceiling. atLeast: how far over the floor.
    const slack = c.op === "atMost" ? c.limit - outcome.value : outcome.value - c.limit;
    // A fraction of zero is undefined, so a zero limit keeps the absolute number.
    const headroom = c.limit === 0 ? slack : slack / Math.abs(c.limit);
    return {
      ...head,
      value: outcome.value,
      headroom,
      headroomBasis: c.limit === 0 ? ("absolute" as const) : ("fraction" as const),
      // Exactly 0 is a PASS: a constraint sitting on its limit has not broken it.
      status: headroom >= 0 ? ("pass" as const) : ("breach" as const),
    };
  });

  let worst: { headroom: number; constraintId: string } | undefined;
  for (const c of constraints) {
    if (c.headroom === undefined) continue;
    // FRACTION BASIS ONLY. A headroom on absolute
    // basis is a raw slack in the reader's own unit: a count of shortfalls, a
    // currency gap. Folding it together with a fraction of a limit would make
    // the headline a comparison of unlike things, and the demonstration lens
    // proved it: strategy-demo-v1's headline sat at 0 from a zero-limit
    // shortfall count and hid the NII headroom beside it. The constraint keeps
    // its value, its headroom and its status; only the HEADLINE is restricted.
    if (c.headroomBasis !== "fraction") continue;
    // Strict less-than, so a tie keeps the FIRST constraint in author order.
    if (worst === undefined || c.headroom < worst.headroom) {
      worst = { headroom: c.headroom, constraintId: c.constraintId };
    }
  }

  return {
    scenarioId,
    constraints,
    ...(worst !== undefined
      ? { headline: worst.headroom, worstConstraintId: worst.constraintId }
      : {}),
    status: rollUp(constraints.map((c) => c.status)),
  };
}

/** breach if any breach; else pass if any pass; else unobservable. */
function rollUp(statuses: readonly ConstraintStatus[]): ConstraintStatus {
  if (statuses.includes("breach")) return "breach";
  if (statuses.includes("pass")) return "pass";
  return "unobservable";
}
