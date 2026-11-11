/**
 * The run's curve id: the curve setup's own id
 * when the market carries a curveSetup block, else PLATFORM_DEFAULT_CURVE. A
 * derived curve whose base differs from this id is refused at the run.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { MarketWithCurveSetup } from "../contracts/curveSetup";
import { PLATFORM_DEFAULT_CURVE, type DerivedCurveBlock } from "../contracts/derivedCurve";

export function runCurveIdOf(market: MarketSnapshot): string {
  return (market as MarketWithCurveSetup).curveSetup?.id ?? PLATFORM_DEFAULT_CURVE;
}

/**
 * The platform default curve version a derived curve's spreads were estimated on (spec v7 decision
 * 63): null when its source names no platform-default side (a typed grid, or a source of two curve setups,
 * was not estimated on it); else its estimatedOnDefault stamp; else 1, since a curve whose source names
 * platform-default and carries no stamp was saved before the stamp existed, when the default was version 1.
 */
export function estimatedOnDefaultOf(curve: DerivedCurveBlock): 1 | 2 | null {
  const s = curve.source;
  if (s === undefined || (s.from !== PLATFORM_DEFAULT_CURVE && s.minus !== PLATFORM_DEFAULT_CURVE)) return null;
  return curve.estimatedOnDefault ?? 1;
}
