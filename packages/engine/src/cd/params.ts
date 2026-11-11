/**
 * CD adapter parameter mapping.
 *
 * The engine-side seam over the kernel's competing-risk CD model parameters.
 * Two jobs only:
 *
 *  1. `resolveCdParams` — produce a `CdModelParams` from the kernel's
 *     illustrative CD parameters plus optional per-section overrides: the
 *     defaults are `CD_DEFAULT_PARAMS`, the kernel's `CD_ILLUSTRATIVE_PARAMS`,
 *     hand-set round values.
 *  2. `zeroHazardParams` — the degeneracy configuration: an exact-zero early
 *     withdrawal hazard. With hazard exactly zero and renewals off, the cohort
 *     walk must reproduce a fixed-rate bullet, which is the posture the
 *     adapter replaces. This is the wiring anchor, so the zero must be exact,
 *     not "a very negative logit": the kernel clips the logit argument at
 *     +/-`logitClip` before the expit, and expit(-35) is ~6e-16, not 0. Setting
 *     `intercept = -Infinity`, all slopes 0, and `logitClip = +Infinity` makes
 *     `clippedExpit` evaluate 1/(1+exp(+Infinity)) = 0 exactly, so the monthly
 *     withdrawal is exactly 0 in IEEE arithmetic and the degeneracy holds to
 *     the last bit rather than to 6e-16 per month.
 *
 * The engine never re-implements any CD math; every number comes from the
 * kernel walk. This file only builds the parameter object the kernel consumes.
 */
import { CD_DEFAULT_PARAMS, type CdModelParams } from "@alm/kernel";

/**
 * Per-section partial overrides over the vendored defaults. Sections merge
 * shallowly (an override section replaces individual fields, not the whole
 * section); top-level scalars replace directly. The curve, if overridden, is
 * replaced whole — a half-overridden curve (t from one source, z from another)
 * is a fabrication hazard, so no field-wise merge is offered there.
 */
export interface CdParamOverrides {
  hazard?: Partial<CdModelParams["hazard"]>;
  renewal?: Partial<CdModelParams["renewal"]>;
  severityPart1?: Partial<CdModelParams["severityPart1"]>;
  eSevPartial?: number;
  offerSpreadByTerm?: Readonly<Record<number, number>>;
  curve?: CdModelParams["curve"];
  horizonMonths?: number;
  maxRenewalGenerations?: number;
  minLiveBalance?: number;
  walkScale?: number;
}

/**
 * Kernel `CdModelParams` from the kernel's illustrative defaults plus optional
 * overrides. Returns a fresh object every call (callers may not mutate the
 * kernel's `CD_DEFAULT_PARAMS` singleton through the result).
 */
export function resolveCdParams(overrides: CdParamOverrides = {}): CdModelParams {
  const d = CD_DEFAULT_PARAMS;
  return {
    hazard: { ...d.hazard, ...overrides.hazard },
    renewal: { ...d.renewal, ...overrides.renewal },
    severityPart1: { ...d.severityPart1, ...overrides.severityPart1 },
    eSevPartial: overrides.eSevPartial ?? d.eSevPartial,
    offerSpreadByTerm: { ...(overrides.offerSpreadByTerm ?? d.offerSpreadByTerm) },
    curve: overrides.curve ?? {
      t: [...d.curve.t],
      z: [...d.curve.z],
      tlpSpread: [...d.curve.tlpSpread],
    },
    horizonMonths: overrides.horizonMonths ?? d.horizonMonths,
    maxRenewalGenerations: overrides.maxRenewalGenerations ?? d.maxRenewalGenerations,
    minLiveBalance: overrides.minLiveBalance ?? d.minLiveBalance,
    walkScale: overrides.walkScale ?? d.walkScale,
  };
}

/**
 * The degeneracy configuration: `base` with the early-withdrawal hazard forced
 * to exactly zero (see the module header for why -Infinity/+Infinity rather
 * than a large finite logit). Renewal and severity parameters are untouched:
 * "zero renewal" in the degeneracy anchor is the walk's `renewals: false`
 * run-off switch, not a parameter, and severity is inert when the incidence
 * hazard is zero (pi = h * severity = 0 exactly).
 */
export function zeroHazardParams(base: CdModelParams = resolveCdParams()): CdModelParams {
  return {
    ...base,
    hazard: {
      ...base.hazard,
      intercept: Number.NEGATIVE_INFINITY,
      b1Moneyness: 0,
      bLogTtmStd: 0,
      bLogBalStd: 0,
      logitClip: Number.POSITIVE_INFINITY,
    },
  };
}
