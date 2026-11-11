/**
 * Fixed Explanation inputs for the m14 explain-composer tests.
 *
 * Each is a structured Explanation as m12's explain layer would emit it: the
 * supported flag, the HeadlineAttribution drawn from the run's AttributionResult,
 * and the already material-filtered, magnitude-sorted citations. The composer is
 * tested against these fixed inputs; it never runs the engine.
 *
 * Numeric values are chosen distinctive and label ids carry no digits, so a
 * numeric-token scan of a composed answer isolates the figures the composer
 * surfaced from the fields they trace to.
 */
import type { DriverContribution, Explanation, HeadlineAttribution } from "@alm/engine";

/** Two material rate contributions reconstruct the EVE delta exactly (residual 0). */
const SUPPORTED_HEADLINE: HeadlineAttribution = {
  metric: "eve",
  scenarioId: "parallelUp",
  baseValue: 1000.5,
  scenarioValue: 850.25,
  totalDelta: -150.25,
  contributions: [
    { familyId: "Mortgages", driver: "rate", amount: -120.25 },
    { familyId: "MMA", driver: "rate", amount: -30 },
    { familyId: "DDA", driver: "volume", amount: 0 },
  ],
  residual: 0,
};

const SUPPORTED_CITATIONS: DriverContribution[] = [
  { familyId: "Mortgages", driver: "rate", amount: -120.25 },
  { familyId: "MMA", driver: "rate", amount: -30 },
];

export const SUPPORTED: Explanation = {
  supported: true,
  // m12's baseline answer; the m14 composer authors its own and never reads this.
  answer: "",
  attribution: SUPPORTED_HEADLINE,
  citations: SUPPORTED_CITATIONS,
};

/** Supported, but no driver clears the materiality bar, so citations is empty. */
export const SUPPORTED_NO_MATERIAL: Explanation = {
  supported: true,
  answer: "",
  attribution: {
    metric: "eve",
    scenarioId: "parallelUp",
    baseValue: 1000.5,
    scenarioValue: 1000.5,
    totalDelta: 0,
    contributions: [{ familyId: "DDA", driver: "volume", amount: 0 }],
    residual: 0,
  },
  citations: [],
};

/** Not supported: the drivers leave a residual above tolerance (m12 declined it). */
export const NOT_SUPPORTED_RESIDUAL: Explanation = {
  supported: false,
  answer: "",
  attribution: {
    metric: "eve",
    scenarioId: "parallelUp",
    baseValue: 1000.5,
    scenarioValue: 850.25,
    totalDelta: -150.25,
    contributions: [{ familyId: "Mortgages", driver: "rate", amount: -145 }],
    residual: 5,
  },
  citations: [],
};

/** Not supported: no headline was decomposed for the requested metric/scenario. */
export const NOT_SUPPORTED_NO_HEADLINE: Explanation = {
  supported: false,
  answer: "",
  attribution: null,
  citations: [],
};

/**
 * Every numeric field a composed answer is allowed to surface, as rendered
 * strings. A number in the answer that is not in this set was invented.
 */
export function allowedFigures(h: HeadlineAttribution): Set<string> {
  const s = new Set<string>();
  s.add(String(h.baseValue));
  s.add(String(h.scenarioValue));
  s.add(String(h.totalDelta));
  s.add(String(h.residual));
  for (const c of h.contributions) s.add(String(c.amount));
  return s;
}
