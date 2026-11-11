/**
 * The Monte Carlo distribution summary the stochastic envelope reports (moved out of run/stochastic.ts in slice 4b,
 * unchanged, so the stochastic gap summarises its per-path values through the very function the EVE and NII-12m
 * distributions use, with no circular import).
 */
import {
  PATHS_PER_PAIR,
  STOCHASTIC_QUANTILES,
  type StochasticDistribution,
  type StochasticQuantile,
} from "../contracts/stochastic";

/**
 * Quantile of a sorted sample by linear interpolation between order statistics
 * (position (n-1)·p, the convention the kernel's own distribution tests use).
 */
export function quantileSorted(sorted: Float64Array, p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const rest = pos - lo;
  const hi = lo + 1;
  if (hi < sorted.length) return sorted[lo] + rest * (sorted[hi] - sorted[lo]);
  return sorted[lo];
}

/**
 * Summarise one per-path value vector into a StochasticDistribution. The
 * standard error of the mean uses ANTITHETIC-PAIR AVERAGES as the independent
 * samples (paths 2j and 2j+1 share one normal draw and are negatively
 * correlated; a naive per-path SE would be wrong in the conservative-looking
 * direction, which is still wrong). The per-path stdev is reported separately
 * as plain dispersion.
 */
export function summarise(values: Float64Array): StochasticDistribution {
  const n = values.length;
  const nPairs = n / PATHS_PER_PAIR;

  let mean = 0;
  let min = values[0];
  let max = values[0];
  for (let p = 0; p < n; p++) {
    const v = values[p];
    mean += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  mean /= n;

  let ssPath = 0;
  for (let p = 0; p < n; p++) {
    const d = values[p] - mean;
    ssPath += d * d;
  }
  const stdev = n > 1 ? Math.sqrt(ssPath / (n - 1)) : 0;

  let ssPair = 0;
  for (let j = 0; j < nPairs; j++) {
    const pm =
      (values[PATHS_PER_PAIR * j] + values[PATHS_PER_PAIR * j + 1]) / PATHS_PER_PAIR;
    const d = pm - mean;
    ssPair += d * d;
  }
  const standardError =
    nPairs > 1 ? Math.sqrt(ssPair / (nPairs - 1)) / Math.sqrt(nPairs) : 0;

  const sorted = Float64Array.from(values).sort();
  const quantiles: StochasticQuantile[] = STOCHASTIC_QUANTILES.map((p) => ({
    p,
    value: quantileSorted(sorted, p),
  }));

  return { nPaths: n, mean, standardError, stdev, min, max, quantiles };
}
