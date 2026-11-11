/**
 * Shapes of the MMA repricing surface: parameters and the book bin block.
 *
 * The types live here, where math modules and tabs can name the shape without a
 * data module in the import graph. Values live in
 * illustrative/repricingIllustrative.ts.
 *
 * UNITS: the rate axis is PERCENT p.a. (see repricingSurface.ts).
 */

/** The 8 free surface parameters plus the frozen centering constant. */
export interface RepricingSurfaceParams {
  /** Shared deposit-rate intercept (percent): D_target = alpha + beta(r,z)*r. */
  alpha: number;
  /** beta_max logistic intercept: beta_max(z) = sigmoid(c0 + c1*z). */
  c0: number;
  /** beta_max balance loading (positive: bigger accounts reprice more). */
  c1: number;
  /** Shared floor ratio: beta_min(z) = s * beta_max(z). */
  s: number;
  /** Rate S-curve slope. */
  k: number;
  /** Rate S-curve midpoint (percent p.a.). */
  m: number;
  /** lambda logistic intercept: lambda(z) = sigmoid(l0 + l1*z). */
  l0: number;
  /** lambda balance loading (positive: bigger accounts reprice faster). */
  l1: number;
  /** Frozen centering constant: z = ln(balance$) - lnBRef. */
  lnBRef: number;
}

/** The log-balance bin block that book-level exhibits aggregate over. */
export interface RepricingSurfaceBins {
  /** Mean ln(balance$) per bin (natural log). */
  lnbLast: readonly number[];
  /** Balance share per bin (sums to 1). */
  weightsLast: readonly number[];
  /** Anchor deposit rate per bin (percent p.a.). */
  anchorsLast: readonly number[];
}
