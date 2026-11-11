/**
 * Shared scenario/aggregation helpers for the deposit-model live-path fan runners
 * (ddaChampionPaths.ts, mmaGranularPaths.ts). No engine-specific logic here --
 * both DDA and MMA reduce to the same {retention -> WAL, percentile bands,
 * size blend} shape once their own per-path retention curve is computed.
 */

/** Retention/balance fan across a Monte Carlo scenario, plus WAL and the
 *  pure-core curve (phi=0) for the reference overlay. effDur is computed
 *  separately per engine (needs the LabCurve/discount basis) and merged in
 *  by the caller -- see ddaChampionEffDur / mmaChampionEffDur. */
export interface ChampionScenarioOutput {
  retMean: Float64Array;
  retP5: Float64Array;
  retP95: Float64Array;
  coreRetMean: Float64Array;
  balMean: Float64Array;
  balP5: Float64Array;
  balP95: Float64Array;
  /** WAL of the cross-path MEAN retention curve (WAL of E[R]). */
  wal: number;
  /** Mean of the per-path book WALs (E[WAL]); differs from `wal` by Jensen. */
  walMean: number;
  /** 5th percentile of the per-path book WAL distribution -- the band gate's lower edge. */
  walP5: number;
  /** 95th percentile of the per-path book WAL distribution -- the band gate's upper edge. */
  walP95: number;
}

/** House sum convention, shared by ddaChampion.walYears and
 *  mmaTwoSleeve.walYears (same formula): WAL = (1/12) * sum(R[1..H]). */
export function walFromRetention(R: ArrayLike<number>): number {
  let s = 0;
  for (let h = 1; h < R.length; h++) s += R[h];
  return s / 12;
}

/**
 * Parallel-shift every step of every decimal-annualised rate path by
 * shockBp (shockBp/1e4 added at each step). Shared by both engines' effDur
 * functions -- no DDA/MMA-specific logic, so it lives here rather than being
 * duplicated in ddaChampionPaths.ts and mmaGranularPaths.ts.
 */
export function shiftDecimalPaths(
  pathsDecimal: ArrayLike<ArrayLike<number>>,
  shockBp: number,
): Float64Array[] {
  const nPaths = pathsDecimal.length;
  const out: Float64Array[] = new Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    const path = pathsDecimal[p];
    const shifted = new Float64Array(path.length);
    for (let h = 0; h < path.length; h++) shifted[h] = path[h] + shockBp / 1e4;
    out[p] = shifted;
  }
  return out;
}

/**
 * Size-blended retention: R_book(h) = (1 - phiB)*core[h] + phiB*overnight[h].
 * `core` and `overnight` must be the same length. phiB=0 returns core exactly
 * (up to float noise); phiB=1 returns overnight exactly.
 */
export function blendSizeCurve(
  core: ArrayLike<number>,
  overnight: ArrayLike<number>,
  phiB: number,
): Float64Array {
  if (core.length !== overnight.length) {
    throw new Error(
      `blendSizeCurve: core length ${core.length} != overnight length ${overnight.length}`,
    );
  }
  const out = new Float64Array(core.length);
  const w = 1 - phiB;
  for (let h = 0; h < out.length; h++) out[h] = w * core[h] + phiB * overnight[h];
  return out;
}

/** Linear-interpolation percentile (same convention as nmdModel.ts's percentile()). */
function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

/**
 * Per-path book WAL distribution: WAL of each path's book retention curve, then
 * the cross-path mean and P5/P95. This is the BOOK-LEVEL object the stochastic
 * band gate consumes: the deterministic WAL must sit inside the P5-P95 band of
 * the per-path book WALs and the band width must clear the ceiling; this is not
 * the pointwise retention band of percentileBands. `retMat` is the per-path BOOK (size-blended)
 * retention matrix; each row is one path's R_book(h).
 */
export function walBands(
  retMat: ReadonlyArray<ArrayLike<number>>,
): { mean: number; p5: number; p95: number; perPath: Float64Array } {
  if (retMat.length === 0) throw new Error("walBands: retMat must be non-empty");
  const perPath = new Float64Array(retMat.length);
  let sum = 0;
  for (let p = 0; p < retMat.length; p++) {
    const w = walFromRetention(retMat[p]);
    perPath[p] = w;
    sum += w;
  }
  return {
    mean: sum / retMat.length,
    p5: percentile(perPath, 0.05),
    p95: percentile(perPath, 0.95),
    perPath,
  };
}

/**
 * Cross-path mean and p5/p95 bands at every horizon step. `paths` must be
 * non-empty and every path the same length.
 */
export function percentileBands(
  paths: ReadonlyArray<ArrayLike<number>>,
): { mean: Float64Array; p5: Float64Array; p95: Float64Array } {
  if (paths.length === 0) throw new Error("percentileBands: paths must be non-empty");
  const H = paths[0].length;
  const mean = new Float64Array(H);
  const p5 = new Float64Array(H);
  const p95 = new Float64Array(H);
  const column = new Float64Array(paths.length);
  for (let h = 0; h < H; h++) {
    let sum = 0;
    for (let p = 0; p < paths.length; p++) {
      const v = paths[p][h];
      column[p] = v;
      sum += v;
    }
    mean[h] = sum / paths.length;
    p5[h] = percentile(column, 0.05);
    p95[h] = percentile(column, 0.95);
  }
  return { mean, p5, p95 };
}
