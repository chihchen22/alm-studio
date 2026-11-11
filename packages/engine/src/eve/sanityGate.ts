/**
 * Duration sanity gate (Lab rule).
 *
 * A surprising effective duration is a finding or a bug, never a number to
 * patch. The gate checks a duration before it is trusted; a rejected duration is
 * left `undefined` and the scenario's `durationSanityPassed` flag goes false, so
 * the wrong number never reaches a screen wearing the disguise of a right one.
 *
 * Two checks, ordered:
 *   1. Finiteness — a non-finite duration (e.g. equity PV ≈ 0 blowing up the
 *      finite difference) is always rejected.
 *   2. Magnitude — |D| above a generous cap catches near-singular equity and
 *      numeric blow-ups without second-guessing a genuinely long asset.
 *   3. Sign (only when `requiredSign === "positive"`) — an asset and a deposit
 *      franchise BOTH shorten in PV as rates rise, so their effective duration
 *      is non-negative; a materially negative value is the classic NMD/mortgage
 *      re-leveling bug the Lab warns about. Equity duration's sign is genuinely
 *      ambiguous (it depends on the asset/liability duration gap), so equity is
 *      gated on finiteness and magnitude only (`requiredSign === "any"`).
 *
 * The per-family positive-sign law holds at the BASE environment, where an
 * asset and a deposit both lengthen in value as rates fall. It does NOT hold for
 * a behavioral family measured at a shocked environment: the local ±bump there
 * straddles a region in which the embedded option is firing (a mortgage's down
 * bump reaches the refi wave, an interest-bearing deposit's up bump reaches the
 * steep part of the beta S-curve), so a genuinely negative effective duration is
 * the real optionality, not a re-leveling fault. The gate policy therefore
 * applies the family sign check only at the base environment and drops to
 * finiteness-and-magnitude at shocked environments. Equity keeps its any-sign
 * finiteness+magnitude gate everywhere.
 */

export interface DurationBounds {
  /** Reject |D| above this many years (catches EVE ≈ 0 blow-ups). */
  maxAbsYears: number;
  /**
   * A duration below −signTolYears fails a positive-sign check. Small so a
   * near-par floater's ≈ 0 duration (which numeric noise can nudge slightly
   * negative) still passes, while a genuine sign flip (order 1 year) does not.
   */
  signTolYears: number;
}

export const DEFAULT_DURATION_BOUNDS: DurationBounds = {
  maxAbsYears: 100,
  signTolYears: 1e-3,
};

export interface DurationSanity {
  passed: boolean;
  /** Populated only when the gate rejects, for provenance / diagnostics. */
  reason?: string;
}

/**
 * Gate one effective duration. `requiredSign` is "positive" for a single
 * instrument or product family (asset or deposit liability), "any" for equity.
 */
export function checkDurationSanity(
  effDur: number,
  requiredSign: "positive" | "any",
  bounds: DurationBounds = DEFAULT_DURATION_BOUNDS,
): DurationSanity {
  if (!Number.isFinite(effDur)) {
    return { passed: false, reason: "non-finite effective duration" };
  }
  if (Math.abs(effDur) > bounds.maxAbsYears) {
    return {
      passed: false,
      reason: `|D| = ${effDur.toFixed(2)}y exceeds the ${bounds.maxAbsYears}y plausibility cap`,
    };
  }
  if (requiredSign === "positive" && effDur < -bounds.signTolYears) {
    return {
      passed: false,
      reason: `effective duration ${effDur.toFixed(3)}y is negative (sign flip)`,
    };
  }
  return { passed: true };
}

export interface RawFamilyDuration {
  familyId: string;
  effectiveDuration: number;
}

export interface GatedDurations {
  /** familyId → effective duration; a rejected family maps to undefined. */
  familyDurations: Map<string, number | undefined>;
  /** Equity effective duration, undefined when the gate rejected it. */
  effectiveDurationEquity: number | undefined;
  /** True iff every family (positive-sign gate) AND equity (any-sign gate) passed. */
  durationSanityPassed: boolean;
}

/**
 * Apply the gate to a scenario's per-family durations and its equity duration.
 * Equity is always gated on finiteness and magnitude only (any sign). Families
 * are gated on sign per `familySignGate`: "positive" at the base environment
 * (where the sign law holds and a flip is a genuine re-leveling regression to
 * catch), "any" at shocked environments (where behavioral optionality makes a
 * negative effective duration real, not a fault). A single rejection
 * anywhere sets `durationSanityPassed` false — the scenario flags that at least
 * one duration was not trustworthy.
 */
export function applyDurationGate(
  families: RawFamilyDuration[],
  equityDuration: number,
  familySignGate: "positive" | "any" = "positive",
  bounds: DurationBounds = DEFAULT_DURATION_BOUNDS,
): GatedDurations {
  const familyDurations = new Map<string, number | undefined>();
  let allPassed = true;
  for (const f of families) {
    const g = checkDurationSanity(f.effectiveDuration, familySignGate, bounds);
    familyDurations.set(f.familyId, g.passed ? f.effectiveDuration : undefined);
    if (!g.passed) allPassed = false;
  }
  const eq = checkDurationSanity(equityDuration, "any", bounds);
  return {
    familyDurations,
    effectiveDurationEquity: eq.passed ? equityDuration : undefined,
    durationSanityPassed: allPassed && eq.passed,
  };
}
