/**
 * Shard worker body. Loaded via workerEntry.mjs (tsx bootstrap).
 *
 * Receives its contiguous position slice per group (already cut on chunk
 * boundaries by runStaticPass), rebuilds each scenario's rate path from the
 * market snapshot with the same pure functions the main thread uses, and
 * accumulates per-chunk subtotal buffers with the shared chunk core. Results go
 * back over the dedicated MessagePort as transferred Float64Array buffers, then
 * the SharedArrayBuffer flag flips so the synchronously-blocked main thread can
 * drain the port. Errors post {error} and flip the flag to 2 — the main thread
 * must never be left blocked.
 */
import { workerData } from "node:worker_threads";
import type { MarketSnapshot } from "@alm/kernel";
import type { Position } from "../../contracts/position";
import type { RateIndex } from "../../contracts/rateIndex";
import { runMacroFromWire, type RunMacroWire } from "../../macro/runMacro";
import type { RateSpec } from "../../contracts/scenario";
import { rateIndexTable } from "../../rateIndex/rateIndices";
import { buildBaseCurve } from "../../scenario";
import { buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { accumulateChunk, chunkMetricsOf, SHARD_CHUNK, sinkOverBuffer } from "./chunk";

interface ShardWorkerData {
  port: import("node:worker_threads").MessagePort;
  sab: SharedArrayBuffer;
  marketSnapshot: MarketSnapshot;
  /** The run's cell count sizes the sink; the family count no longer does. */
  cellCount: number;
  horizon: number;
  /** The run's rate indices, rebuilt into a table here; undefined when none are named. */
  rateIndices?: RateIndex[];
  /** The run's RunMacro in its wire form; undefined outside a run. */
  macro?: RunMacroWire;
  /** True when the run asked for the interest-inclusive liquidity ladder; absent otherwise. */
  gapInterest?: true;
  groups: {
    positions: Position[];
    /** Slice-relative cell index, cut on the same chunk boundaries as `positions`. */
    cellIndex: Int32Array;
    /** nmdWarmup is the scenario's deposit history, absent when the run named none. */
    /** depositShiftPct is the scenario's short-rate shift, absent when no set binds a full beta form. */
    scenarios: { scenarioId: string; rateSpec: RateSpec; nmdWarmup?: number[]; depositShiftPct?: number }[];
  }[];
}

const { port, sab, marketSnapshot, cellCount, horizon, groups, rateIndices, macro, gapInterest } = workerData as ShardWorkerData;
const withInterest = gapInterest === true;
const flag = new Int32Array(sab);

try {
  const base = buildBaseCurve(marketSnapshot);
  const C = cellCount;
  const indexTable = rateIndices === undefined ? undefined : rateIndexTable(rateIndices);
  const runMacro = macro === undefined ? undefined : runMacroFromWire(macro);

  const transfers: ArrayBuffer[] = [];
  const outGroups = groups.map((g) => ({
    scenarios: g.scenarios.map((s) => {
      const path = buildRatePath(shockedCurve(base, s.rateSpec), horizon);
      const chunks: Float64Array[] = [];
      for (let start = 0; start < g.positions.length; start += SHARD_CHUNK) {
        const buf = new Float64Array(chunkMetricsOf(withInterest) * C * horizon);
        const sink = sinkOverBuffer(buf, C, horizon, withInterest);
        const end = Math.min(start + SHARD_CHUNK, g.positions.length);
        accumulateChunk(g.positions, start, end, g.cellIndex, path, horizon, sink, indexTable, runMacro, s.nmdWarmup, s.depositShiftPct);
        chunks.push(buf);
        transfers.push(buf.buffer);
      }
      return { scenarioId: s.scenarioId, chunks };
    }),
  }));

  port.postMessage({ groups: outGroups }, transfers);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
} catch (err) {
  // Name and message only: the stack carries absolute paths and node_modules
  // frames, and the caller folds this string into the run's failure line.
  port.postMessage({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  Atomics.store(flag, 0, 2);
  Atomics.notify(flag, 0);
}
