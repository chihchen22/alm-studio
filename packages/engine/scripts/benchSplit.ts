/**
 * Pure timing helpers for bench-e2e-runs.ts.
 *
 * A stochastic run is timed at three points: its start, the moment the environment is ready (the
 * onEnvironment or onBgmEnvironment hand-out, after simulation and before the per-path loop), and its
 * end. A BGM envelope also carries simulation.fixedCostMs, the calibration plus simulation plus
 * reconstruction timed inside buildBgmEnvironment. The split:
 *   fixed cost       simulation.fixedCostMs (0 for Hull-White, whose envelope carries none);
 *   environment      start to ready, less the fixed cost (binding, curve, the rest of the build);
 *   projection       whole run less the fixed cost less the environment build, i.e. ready to end;
 *   per path         projection divided by the path count.
 */

export interface StochasticRunTiming {
  wholeMs: number;
  envReadyMs: number;
  fixedCostMs?: number;
  nPaths: number;
}

export interface StochasticRunSplit {
  wholeMs: number;
  fixedCostMs: number;
  envBuildMs: number;
  projectionMs: number;
  perPathMs: number;
}

export function splitStochasticTiming(t: StochasticRunTiming): StochasticRunSplit {
  const fixedCostMs = t.fixedCostMs ?? 0;
  if (!(t.nPaths > 0)) throw new Error(`bench: nPaths must be positive, got ${t.nPaths}`);
  if (!(fixedCostMs >= 0 && fixedCostMs <= t.envReadyMs && t.envReadyMs <= t.wholeMs)) {
    throw new Error(
      `bench: timings do not nest (fixed cost ${fixedCostMs} ms, environment ready ${t.envReadyMs} ms, whole ${t.wholeMs} ms)`,
    );
  }
  const projectionMs = t.wholeMs - t.envReadyMs;
  return {
    wholeMs: t.wholeMs,
    fixedCostMs,
    envBuildMs: t.envReadyMs - fixedCostMs,
    projectionMs,
    perPathMs: projectionMs / t.nPaths,
  };
}

/** Round-by-round ratios num[r] / den[r] (the paired measure: both arms ran in the same round). */
export function pairedRatios(num: number[], den: number[]): number[] {
  if (num.length !== den.length) throw new Error(`bench: paired ratios need equal rounds, got ${num.length} and ${den.length}`);
  return num.map((n, i) => n / den[i]);
}

/** The script's median: the upper middle of the sorted values. */
export function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
