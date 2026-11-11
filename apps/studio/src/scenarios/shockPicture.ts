/**
 * The shock picture of one scenario (Studio S3b): the knots its rate spec
 * states, and nothing it does not. The right end of every picture is the
 * longest curve tenor, which lives in the market snapshot and not in the spec,
 * so it is drawn as a position ("end") and labelled in words, never with a
 * number: the words sit above the plot (ShockPicture), not among the tenor
 * ticks, where they would print over the last numeric knot. A scenario the
 * compiler refuses has no picture, only the reason.
 */
import type { RateSpec, ScenarioDefinition } from "@alm/engine";

/** A knot's tenor in years, or "end": the longest curve tenor, which the spec does not state. */
export type KnotX = number | "end";

export interface Knot { x: KnotX; bp: number }

/**
 * The knots a spec states, joined by straight lines. A twist is shortBp at 0Y,
 * zero at the pivot and longBp at the longest tenor (the engine's twistShiftBp).
 * A custom vector extends flat beyond its first and last knots.
 */
export function knotsFor(spec: RateSpec): Knot[] {
  switch (spec.kind) {
    case "base":
      return [{ x: 0, bp: 0 }, { x: "end", bp: 0 }];
    case "parallel":
      return [{ x: 0, bp: spec.shockBp }, { x: "end", bp: spec.shockBp }];
    case "twist":
      return [{ x: 0, bp: spec.shortBp }, { x: spec.pivotYears, bp: 0 }, { x: "end", bp: spec.longBp }];
    case "custom": {
      const knots: Knot[] = spec.shocks.map((s) => ({ x: s.tenorYears, bp: s.shockBp }));
      const first = knots[0];
      const last = knots[knots.length - 1];
      if (first === undefined || last === undefined) return [];
      return [
        ...((first.x as number) > 0 ? [{ x: 0, bp: first.bp }] : []),
        ...knots,
        { x: "end", bp: last.bp },
      ];
    }
  }
}

export type Picture = { kind: "picture"; knots: Knot[] } | { kind: "refused"; reason: string };

/** The picture of a scenario, or the compile refusal it will meet (resolveScenarios order: ramp, then environment). */
export function pictureFor(def: ScenarioDefinition): Picture {
  if (def.timing?.kind === "ramp") {
    return { kind: "refused", reason: `refused at compile: ScenarioNotExecutableError (ramp timing over ${def.timing.months} months is typed, not executed)` };
  }
  if (def.environment !== undefined) {
    return { kind: "refused", reason: "refused at compile: ScenarioNotExecutableError (environment paths are refused; map a macro path in the assumption set)" };
  }
  const knots = knotsFor(def.rateSpec);
  if (knots.length === 0) return { kind: "refused", reason: "the custom shock vector states no knot" };
  return { kind: "picture", knots };
}

export interface Geometry {
  points: Array<{ x: number; y: number }>;
  zeroY: number;
  xTicks: Array<{ x: number; text: string }>;
}

/** Where the numeric tenors end on the 0..100 box; the gap to 100 is the unstated stretch to the longest tenor. */
const NUMERIC_SPAN = 80;

export function tenorText(x: KnotX): string {
  return x === "end" ? "longest curve tenor" : `${x}Y`;
}

/** Knots on a 0..100 by 0..100 box, top the high value; y spans min(0, bps) to max(0, bps). The "end" knot takes no tick. */
export function geometry(knots: Knot[]): Geometry {
  const numeric = knots.map((k) => k.x).filter((x): x is number => x !== "end");
  const maxTenor = Math.max(0, ...numeric) || 1;
  const px = (x: KnotX) => (x === "end" ? 100 : (x / maxTenor) * NUMERIC_SPAN);
  const bps = knots.map((k) => k.bp);
  const hi = Math.max(0, ...bps);
  const lo = Math.min(0, ...bps);
  const span = hi - lo || 1;
  const py = (bp: number) => ((hi - bp) / span) * 100;
  const xTicks: Geometry["xTicks"] = [];
  for (const k of knots) {
    if (k.x === "end") continue;
    const text = tenorText(k.x);
    if (!xTicks.some((t) => t.text === text)) xTicks.push({ x: px(k.x), text });
  }
  return { points: knots.map((k) => ({ x: px(k.x), y: py(k.bp) })), zeroY: py(0), xTicks };
}
