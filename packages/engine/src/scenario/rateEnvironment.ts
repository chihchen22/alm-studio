/**
 * Rate-environment resolution: build the base curve from a market snapshot
 * (buildBaseCurve: a curveSetup block, curve default version 1 or curve
 * default version 2) and turn a RateSpec into a shocked ZeroCurve and a
 * DeterministicRatePath.
 *
 * Two of the three shocks reuse the kernel directly:
 *   - "base"     returns the base curve unchanged;
 *   - "parallel" delegates to the kernel `shockCurve`, so a +Nbp shock is, by
 *     construction, byte-identical to the kernel's own parallel shift.
 * The third, "twist", has NO kernel primitive and is built here: a non-parallel
 * rotation about a pivot tenor. It is proven in tests to round-trip the base
 * curve at zero twist and to preserve discount-factor monotonicity for
 * regulatory-scale rotations.
 *
 * The twist needs a ZeroCurve factory. The kernel's `makeCurve` is module-
 * private, but the kernel exports `rehydrateCurve`, which builds a curve from
 * the {t, z, convention} triple through that same factory. `makeZeroCurve`
 * below delegates to it and passes the base curve's convention, so a twisted
 * or custom-shocked curve quotes forwards on the same basis as the bootstrapped
 * or parallel-shocked one. The zero-twist round-trip test guards the
 * exact-equality contract.
 *
 * Fast curves: a base built by the engine curve
 * builder off the legacy path (a curveSetup block, or, since B4 Task 5, the
 * platform default, curve default version 2) is the engine's fast curve
 * (curveBuilder/fastCurve.ts), which reads like the kernel's bit for bit in
 * logarithmic time. A shock of a fast base is a fast curve too: the parallel
 * shift with the kernel shockCurve's arithmetic (shiftCurveParallel), the
 * twist and the custom shock through makeZeroCurve on the fast factory. A
 * base that is not a fast curve (curve default version 1, marked or fallen
 * back to, or the legacy delegate) takes exactly the kernel route above, so
 * those runs are byte-identical to before.
 */
import {
  bootstrapZeroCurve,
  DeterministicRatePath,
  rehydrateCurve,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import type { CustomTenorShock, RateSpec } from "../contracts/scenario";
import { CURVE_DEFAULT_VERSION, type CurveDefaultStamp, type MarketWithCurveSetup } from "../contracts/curveSetup";
import {
  buildCurveFromSetup,
  CurveBuildError,
  defaultSetupFromSnapshot,
  inheritQuoteTenors,
  validateCurveSetup,
} from "../curveBuilder";
import { isFastCurve, makeFastCurve, shiftCurveParallel } from "../curveBuilder/fastCurve";

/** Default monthly step used by the deterministic path (matches the kernel). */
const DT_YEARS_DEFAULT = 1 / 12;

/** Thrown when a twist pivot falls outside the open interval (0, maxTenor). */
export class TwistError extends Error {
  readonly pivotYears: number;
  readonly maxTenorYears: number;
  constructor(pivotYears: number, maxTenorYears: number) {
    super(
      `twist pivot ${pivotYears}y must lie strictly inside (0, ${maxTenorYears}y): ` +
        `the front and long segments are both non-empty only for an interior pivot`,
    );
    this.name = "TwistError";
    this.pivotYears = pivotYears;
    this.maxTenorYears = maxTenorYears;
  }
}

/** Linear interpolation on ascending nodes, flat outside the range. */
function lerp(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[xs.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const w = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] * (1 - w) + ys[i + 1] * w;
    }
  }
  return ys[ys.length - 1];
}

/**
 * ZeroCurve over (t, z) with linear-in-zero-rate interpolation, on the base
 * curve's par-instrument convention. A fast base gives a fast curve; any other
 * base delegates to the kernel `rehydrateCurve`, which builds the curve
 * through the kernel's own factory; see the module header.
 */
function makeZeroCurve(base: ZeroCurve, t: number[], z: number[]): ZeroCurve {
  if (isFastCurve(base)) return makeFastCurve(t, z, base.convention);
  return rehydrateCurve({ t, z, convention: base.convention });
}

/** A marker value as the refusal shows it: a quoted string, a bare scalar, or "an object" or "an array". */
function shownMarker(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value !== null && typeof value === "object") return "an object";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * The curveDefault marker of a market: 1 when it carries `curveDefault: 1`, undefined when it carries
 * none. Any other value is refused with a plain-word Error, whether or not the
 * market carries a curveSetup block. Cheap: it reads one field.
 */
function markerOf(snapshot: MarketSnapshot): 1 | undefined {
  const marker: unknown = (snapshot as MarketWithCurveSetup).curveDefault;
  if (marker === undefined) return undefined;
  if (marker !== 1) {
    throw new Error(
      `The market's curveDefault is ${shownMarker(marker)}; the only value it takes is 1, which selects ` +
        `curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.`,
    );
  }
  return 1;
}

/**
 * Curve default version 2 for an unmarked market with no curveSetup block:
 * the setup defaultSetupFromSnapshot fills from the snapshot's quotes, built by buildCurveFromSetup. A
 * snapshot the default cannot represent (the fill is ok:false) or that the solver refuses (a
 * CurveBuildError at build time) is version 1 with the reason in words; the caller then builds the kernel
 * bootstrap. Any other throw propagates. Pure: the version 2 build of an 11-quote pack takes about 0.1 ms,
 * so the stamp recomputes it rather than caching a curve per snapshot.
 */
function platformDefault(snapshot: MarketSnapshot): { version: 2; curve: ZeroCurve } | { version: 1; reason: string } {
  const filled = defaultSetupFromSnapshot(snapshot);
  if (!filled.ok) return { version: 1, reason: filled.reason };
  try {
    return { version: CURVE_DEFAULT_VERSION, curve: buildCurveFromSetup(filled.block).curve };
  } catch (e) {
    if (e instanceof CurveBuildError) {
      return { version: 1, reason: `the default curve's solver refused this snapshot: ${e.refusals.join("; ")}` };
    }
    throw e;
  }
}

/**
 * The curve default version a market's no-setup build runs on:
 * 1 for a market marked `curveDefault: 1` (the kernel bootstrap by name) and for an unmarked market the
 * version 2 default cannot represent (the fallback to the kernel bootstrap); 2 for an unmarked market the
 * default builds. A marker value other than 1 is refused with a plain-word Error. The answer ignores any
 * curveSetup block: it is the default the market would build on without one (a block wins at build time),
 * which is what a derived curve's estimate on platform-default reads. It never throws for the
 * snapshot's quotes: a market carrying only a block, with no curveQuotes list, or one whose list holds an
 * entry that is not a quote, is a fill the default cannot take, so it reads 1 (defaultSetupFromSnapshot).
 */
export function curveDefaultOf(snapshot: MarketSnapshot): 1 | 2 {
  if (markerOf(snapshot) === 1) return 1;
  return platformDefault(snapshot).version;
}

/**
 * Which curve buildBaseCurve builds for this market, as the run's provenance stamp reads it (spec v7
 * decisions 61 and 70; B4 Task 6 writes it): `{kind: "setup", id}` for a market carrying a curveSetup
 * block (it wins over the marker); `{kind: "default", version: 1}` with no reason for a market marked
 * `curveDefault: 1`; `{kind: "default", version: 1, reason}` for a fallback; `{kind: "default",
 * version: 2}` otherwise. It refuses what buildBaseCurve refuses before building (a bad marker, a block
 * the validator refuses), with the same sentences. Pure; the snapshot is not changed.
 */
export function curveDefaultStampOf(snapshot: MarketSnapshot): CurveDefaultStamp {
  const marker = markerOf(snapshot);
  const setup = (snapshot as MarketWithCurveSetup).curveSetup;
  if (setup !== undefined) {
    const checked = validateCurveSetup(setup);
    if (!checked.ok) throw new Error(checked.refusals.join("; "));
    return { kind: "setup", id: checked.block.id };
  }
  if (marker === 1) return { kind: "default", version: 1 };
  const built = platformDefault(snapshot);
  return built.version === 1
    ? { kind: "default", version: 1, reason: built.reason }
    : { kind: "default", version: CURVE_DEFAULT_VERSION };
}

/**
 * The base zero curve of the run's market snapshot. A marker value other than 1 is refused first.
 *
 *   curveSetup block       validated and built by buildCurveFromSetup; it wins over the marker. Every
 *                          refusal, the validator's or the builder's, surfaces as one Error whose message
 *                          is the refusals joined with "; ". It never falls back: a market that names a
 *                          setup runs on that setup or not at all.
 *   curveDefault: 1        curve default version 1, the kernel bootstrap, byte for byte (decision 58).
 *   neither curve default version 2: the setup
 *                          defaultSetupFromSnapshot fills from the snapshot's quotes, log-linear on
 *                          discount factor, built by buildCurveFromSetup into a fast curve. A snapshot the
 *                          default cannot represent, or that the solver refuses with a CurveBuildError,
 *                          falls back to the kernel bootstrap (decision 70); curveDefaultStampOf names the
 *                          reason. A throw of the kernel bootstrap on that fallback propagates.
 */
export function buildBaseCurve(snapshot: MarketSnapshot): ZeroCurve {
  const marker = markerOf(snapshot);
  const setup = (snapshot as MarketWithCurveSetup).curveSetup;
  if (setup === undefined) {
    if (marker === 1) return bootstrapZeroCurve(snapshot);
    const built = platformDefault(snapshot);
    return built.version === CURVE_DEFAULT_VERSION ? built.curve : bootstrapZeroCurve(snapshot);
  }
  const checked = validateCurveSetup(setup);
  if (!checked.ok) throw new Error(checked.refusals.join("; "));
  try {
    return buildCurveFromSetup(checked.block).curve;
  } catch (e) {
    if (e instanceof CurveBuildError) throw new Error(e.refusals.join("; "));
    throw e;
  }
}

/**
 * Twist shift at tenor `tYears`, in basis points. A rotation about the pivot:
 *   - front-to-pivot: ramps linearly from `shortBp` at t=0 to 0 at the pivot;
 *   - pivot-to-long:  ramps linearly from 0 at the pivot to `longBp` at maxTenor.
 * Continuous (both segments are 0 at the pivot) and zero everywhere when both
 * ends are 0, which is what makes the zero-twist round-trip exact.
 */
export function twistShiftBp(
  tYears: number,
  shortBp: number,
  longBp: number,
  pivotYears: number,
  maxTenorYears: number,
): number {
  if (tYears <= pivotYears) {
    return shortBp * (1 - tYears / pivotYears);
  }
  return (longBp * (tYears - pivotYears)) / (maxTenorYears - pivotYears);
}

/**
 * Non-parallel twist of a zero curve. Each node's zero rate moves by the
 * tenor-dependent twist shift; interpolation stays linear in zero rate.
 */
export function twistCurve(
  base: ZeroCurve,
  shortBp: number,
  longBp: number,
  pivotYears: number,
): ZeroCurve {
  const t = base.t;
  const maxTenorYears = t[t.length - 1];
  if (!(pivotYears > 0 && pivotYears < maxTenorYears)) {
    throw new TwistError(pivotYears, maxTenorYears);
  }
  const z = base.z.map(
    (zi, i) => zi + twistShiftBp(t[i], shortBp, longBp, pivotYears, maxTenorYears) / 1e4,
  );
  return makeZeroCurve(base, [...t], z);
}

/**
 * Thrown when a custom shock vector is malformed. Carries the offending
 * field path (e.g. "rateSpec.shocks[2].tenorYears") and a detail that names
 * the offending tenor, so the refusal is inspectable and the platform's 422
 * message identifies the exact knot.
 */
export class CustomShockError extends Error {
  readonly field: string;
  readonly detail: string;
  constructor(field: string, detail: string) {
    super(`invalid custom shock vector at ${field}: ${detail}`);
    this.name = "CustomShockError";
    this.field = field;
    this.detail = detail;
  }
}

/**
 * Structural validation of a custom shock vector: a non-empty array of
 * { tenorYears, shockBp } knots, every number finite, tenors >= 0 and
 * strictly ascending. Pure and curve-free, so defineScenario can run it at
 * definition time; customCurve re-runs it defensively at shock time.
 * Defensive against wire input: shapes are checked, not assumed.
 */
export function validateCustomShocks(shocks: readonly CustomTenorShock[]): void {
  if (!Array.isArray(shocks) || shocks.length === 0) {
    throw new CustomShockError(
      "rateSpec.shocks",
      "must be a non-empty array of { tenorYears, shockBp } knots",
    );
  }
  for (let i = 0; i < shocks.length; i++) {
    const knot = shocks[i] as unknown;
    if (typeof knot !== "object" || knot === null) {
      throw new CustomShockError(
        `rateSpec.shocks[${i}]`,
        "must be an object { tenorYears, shockBp }",
      );
    }
    const { tenorYears, shockBp } = knot as { tenorYears?: unknown; shockBp?: unknown };
    if (typeof tenorYears !== "number" || !Number.isFinite(tenorYears)) {
      throw new CustomShockError(
        `rateSpec.shocks[${i}].tenorYears`,
        `tenor must be a finite number, got ${String(tenorYears)}`,
      );
    }
    if (tenorYears < 0) {
      throw new CustomShockError(
        `rateSpec.shocks[${i}].tenorYears`,
        `tenor ${tenorYears}y must be non-negative`,
      );
    }
    if (typeof shockBp !== "number" || !Number.isFinite(shockBp)) {
      throw new CustomShockError(
        `rateSpec.shocks[${i}].shockBp`,
        `shock at tenor ${tenorYears}y must be a finite number, got ${String(shockBp)}`,
      );
    }
    if (i > 0) {
      const prev = shocks[i - 1].tenorYears;
      if (!(tenorYears > prev)) {
        throw new CustomShockError(
          `rateSpec.shocks[${i}].tenorYears`,
          `tenor ${tenorYears}y must strictly exceed the preceding tenor ${prev}y ` +
            `(tenors ascending, no duplicates)`,
        );
      }
    }
  }
}

/**
 * Custom shift at tenor `tYears`, in basis points: linear interpolation on
 * the knot vector, flat outside the knot range. The same `lerp` the curve
 * factory uses for zero rates, which is what makes a custom vector placed on
 * the twist's knots reproduce `twistCurve` to machine precision.
 */
export function customShiftBp(tYears: number, shocks: readonly CustomTenorShock[]): number {
  return lerp(
    shocks.map((s) => s.tenorYears),
    shocks.map((s) => s.shockBp),
    tYears,
  );
}

/**
 * Arbitrary per-tenor shock of a zero curve. Each node's zero rate moves by
 * the interpolated shock at that node's tenor; interpolation of the shocked
 * curve stays linear in zero rate. Same machinery as `twistCurve`: node-wise
 * bp shift through the same `makeZeroCurve` factory.
 */
export function customCurve(base: ZeroCurve, shocks: readonly CustomTenorShock[]): ZeroCurve {
  validateCustomShocks(shocks);
  const z = base.z.map((zi, i) => zi + customShiftBp(base.t[i], shocks) / 1e4);
  return makeZeroCurve(base, [...base.t], z);
}

/** Carry the base curve's quote tenors (if registered) onto a shocked copy, and return the copy. */
function keepQuoteTenors(base: ZeroCurve, shocked: ZeroCurve): ZeroCurve {
  inheritQuoteTenors(base, shocked);
  return shocked;
}

/**
 * Apply a RateSpec to the base curve, returning the shocked (or base) curve.
 * A shocked copy keeps the base curve's quote tenors, so the
 * node-wise readers report the quotes a setup was built from; a curve with no
 * registration is untouched by that step.
 */
export function shockedCurve(base: ZeroCurve, spec: RateSpec): ZeroCurve {
  switch (spec.kind) {
    case "base":
      return base;
    case "parallel":
      return keepQuoteTenors(base, shiftCurveParallel(base, spec.shockBp));
    case "twist":
      return keepQuoteTenors(base, twistCurve(base, spec.shortBp, spec.longBp, spec.pivotYears));
    case "custom":
      return keepQuoteTenors(base, customCurve(base, spec.shocks));
  }
}

/** Wrap a zero curve into a deterministic monthly rate path. */
export function buildRatePath(
  curve: ZeroCurve,
  nSteps: number,
  dtYears: number = DT_YEARS_DEFAULT,
): DeterministicRatePath {
  return new DeterministicRatePath(curve, nSteps, dtYears);
}

/**
 * True iff the curve's discount factors are monotone non-increasing across the
 * supplied times. The economically required property of any admissible curve
 * (a positive one-period forward everywhere); the twist tests assert it holds
 * for regulatory-scale rotations.
 */
export function discountFactorsMonotone(curve: ZeroCurve, times: number[]): boolean {
  for (let i = 1; i < times.length; i++) {
    if (curve.discountFactor(times[i]) > curve.discountFactor(times[i - 1])) {
      return false;
    }
  }
  return true;
}
