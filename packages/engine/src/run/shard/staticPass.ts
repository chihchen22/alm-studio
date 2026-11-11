/**
 * The static-projection pass, single-threaded or position-sharded.
 *
 * One entry point, runStaticPass, computes every scenario's per-CELL static
 * series (balance / principal / interest) and gap series (repricing / principal
 * runoff) in one generation pass per scenario. A cell is a family under the
 * identity plan, so a run with no view declared has the same layout it always
 * had; the caller folds cells back to families over each family's contiguous
 * cell range (chunk.ts foldCellsToFamilies). shards=1 (the default) runs the
 * chunk loop inline on the calling thread; shards>1 fans contiguous chunk
 * ranges out to worker_threads. Both paths produce the master series as the
 * SAME flat ordered fold of per-chunk subtotals (chunk.ts), so the numeric
 * output is byte-identical across shard counts.
 *
 * Worker protocol: run() is synchronous, so the fan-out uses the standard
 * synchronous handshake — each worker gets a MessagePort and a SharedArrayBuffer
 * flag, posts its transferable Float64Array chunk subtotals on the port, then
 * flips the flag; the main thread blocks on Atomics.wait and drains the port
 * with receiveMessageOnPort. Workers rebuild their scenario rate paths from the
 * market snapshot with the same pure functions the orchestrator uses
 * (buildBaseCurve, shockedCurve, buildRatePath), so path numbers are identical.
 *
 * Worker loading: the entry is workerEntry.mjs, a two-line plain-JS bootstrap
 * that registers tsx (tsImport) and loads shardWorker.ts — worker_threads
 * cannot load TypeScript directly, and this keeps one loader that works under
 * both vitest and tsx on Windows.
 */
import { availableParallelism } from "node:os";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from "node:worker_threads";
import type { MarketSnapshot, RatePath } from "@alm/kernel";
import type { Position } from "../../contracts/position";
import type { RateIndex, RateIndexTable } from "../../contracts/rateIndex";
import { toWire, type RunMacro } from "../../macro/runMacro";
import type { RateSpec } from "../../contracts/scenario";
import type { CellPlan } from "../../portfolio/cells";
import { CellBudgetError } from "../executorErrors";
import type { LiquidityFlowsOption } from "../../contracts/run";
import { wantsLiquidityInterest } from "../../gap/bucketOptions";
import {
  accumulateChunk,
  allocMasterSink,
  CHUNK_METRICS,
  chunkMetricsOf,
  foldChunk,
  SHARD_CHUNK,
  sinkOverBuffer,
  type ChunkSink,
} from "./chunk";

/** Shard policy (EngineContext.shards): a count, "auto", or undefined = 1. */
export type ShardsOption = number | "auto" | undefined;

/**
 * The default ceiling on a pass's predicted peak bytes. Safe on a 16 GB host
 * and clear of every case in the suite: the largest, the 100k perf book, runs
 * the identity plan at four cells and predicts single-digit megabytes.
 */
export const DEFAULT_CELL_BUDGET_BYTES = 4 * 1024 ** 3;

/**
 * One ChunkSink's bytes. The `[metric][cell][bucket]` layout is dense over cells.
 * `metrics` is CHUNK_METRICS unless the pass carries the slice 4a gap interest.
 */
function sinkBytes(cells: number, horizon: number, metrics: number = CHUNK_METRICS): number {
  return metrics * cells * horizon * 8;
}

/**
 * The pass's predicted peak bytes for ONE group, which is the shape a caller
 * sizing a view has in hand. Masters are one per scenario on both paths; the
 * inline path adds one scratch buffer reused across chunks, while the sharded
 * path adds one retained buffer per (scenario, chunk) until it posts, which is
 * the term that grows with the book.
 *
 * Confirmed against measurement in `run/__tests__/cardinality.test.ts`: exact
 * on the inline path, and within about ten percent of the process high-water
 * mark on the sharded one, which is as tight as that mark gets because it
 * moves with garbage-collection timing.
 */
export function predictedPassBytes(
  cells: number,
  horizon: number,
  positions: number,
  scenarios: number,
  workers: number,
  metrics: number = CHUNK_METRICS,
): number {
  const sink = sinkBytes(cells, horizon, metrics);
  const chunkTerm = workers <= 1 ? sink : Math.ceil(positions / SHARD_CHUNK) * scenarios * sink;
  return scenarios * sink + chunkTerm;
}

/**
 * The same formula over the real groups. Master sinks are shared across groups,
 * because `out` is keyed by scenario id and scenario ids are unique across
 * groups; retained chunk buffers are not, so that term sums per group. On a
 * single group this agrees with predictedPassBytes exactly.
 */
function predictedPassBytesOverGroups(
  groups: StaticPassGroup[],
  cells: number,
  horizon: number,
  workers: number,
  metrics: number,
): number {
  const sink = sinkBytes(cells, horizon, metrics);
  const scenarios = groups.reduce((a, g) => a + g.scenarios.length, 0);
  const chunkTerm =
    workers <= 1
      ? sink
      : groups.reduce(
          (a, g) => a + Math.ceil(g.positions.length / SHARD_CHUNK) * g.scenarios.length * sink,
          0,
        );
  return scenarios * sink + chunkTerm;
}

/** One scenario inside a pass group: its id, shock, and ready rate path. */
export interface StaticPassScenario {
  scenarioId: string;
  rateSpec: RateSpec;
  path: RatePath;
  /** The deposit warmup history this scenario's deposits are built on; absent, the kernel's own. */
  nmdWarmup?: readonly number[];
  /** The short-rate shift a full-form deposit reads, percent; absent when no set binds one. */
  depositShiftPct?: number;
}

/** Scenarios sharing one effective (overlay-applied) portfolio. */
export interface StaticPassGroup {
  positions: Position[];
  scenarios: StaticPassScenario[];
}

/** Resolve the shard policy to a concrete worker count. */
export function resolveShardCount(shards: ShardsOption): number {
  if (shards === undefined) return 1;
  if (shards === "auto") return Math.max(1, availableParallelism());
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`runStaticPass: shards must be a positive integer or "auto", got ${shards}`);
  }
  return shards;
}

/** The message a worker posts back: per group, per scenario, per-chunk subtotals. */
interface WorkerResult {
  error?: string;
  groups?: { scenarios: { scenarioId: string; chunks: Float64Array[] }[] }[];
}

/** Wall-clock cap on one worker's whole task, generous over the measured pass. */
const WORKER_TIMEOUT_MS = 600_000;

/**
 * Compute every scenario's master ChunkSink, at CELL grain. Scenario
 * ids must be unique across groups (the run contract already guarantees this).
 *
 * One cellIndexByPosition serves every group because every group's positions
 * array is an overlay-applied copy of the SAME book in the SAME order. Read the
 * guard below for what it is: a LENGTH equality, and nothing more. It does NOT
 * verify order, and an overlay that reordered a book of the same size would
 * pass it and then mis-attribute every position silently.
 *
 * Order preservation rests elsewhere, on the single site that produces these
 * books: orchestrate.ts builds the cell plan on the RAW book, and
 * applyLicensedOverlays maps positions in place, returning per position either
 * the same object or a terms-patched copy. The array order is therefore the
 * same array order by construction, not by check. What the length guard buys is
 * the failure that IS reachable, a cell plan built from a different book than
 * the one being projected, caught at the top of the pass instead of showing up
 * as numbers in the wrong cell.
 */
export function runStaticPass(
  groups: StaticPassGroup[],
  cellPlan: CellPlan,
  horizon: number,
  shards: ShardsOption,
  marketSnapshot: MarketSnapshot,
  budgetBytes: number = DEFAULT_CELL_BUDGET_BYTES,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
  liquidityFlows?: LiquidityFlowsOption,
): Map<string, ChunkSink> {
  const C = cellPlan.cells.length;
  // "principal-plus-interest" appends the gapInterest metric to every
  // sink and buffer; anything else runs the five-metric pass it always ran.
  const gapInterest = wantsLiquidityInterest(liquidityFlows);
  const M = chunkMetricsOf(gapInterest);
  const cellIndex = cellPlan.cellIndexByPosition;
  for (const g of groups) {
    if (g.positions.length !== cellIndex.length) {
      throw new Error(
        `runStaticPass: the cell plan covers ${cellIndex.length} positions but a group carries ` +
          `${g.positions.length}; the cell plan and every effective book must share one position order`,
      );
    }
  }

  const out = new Map<string, ChunkSink>();
  const maxPositions = groups.reduce((a, g) => Math.max(a, g.positions.length), 0);
  const workerCount = Math.min(
    resolveShardCount(shards),
    Math.max(1, Math.ceil(maxPositions / SHARD_CHUNK)),
  );

  // The cell budget, checked BEFORE the first allocation. The peak is arithmetic
  // on numbers already in hand, so a pass too large for the host refuses with
  // them named instead of dying as an out-of-memory partway through.
  const predicted = predictedPassBytesOverGroups(groups, C, horizon, workerCount, M);
  if (predicted > budgetBytes) {
    throw new CellBudgetError(
      cellPlan.views.map((v) => v.viewId),
      C,
      maxPositions,
      groups.reduce((a, g) => a + g.scenarios.length, 0),
      workerCount,
      predicted,
      budgetBytes,
    );
  }

  if (workerCount <= 1) {
    // Inline path: same chunked fold, one reusable scratch buffer.
    const scratch = new Float64Array(M * C * horizon);
    const scratchSink = sinkOverBuffer(scratch, C, horizon, gapInterest);
    for (const group of groups) {
      const positions = group.positions;
      for (const sc of group.scenarios) {
        const master = allocMasterSink(C, horizon, gapInterest);
        for (let start = 0; start < positions.length; start += SHARD_CHUNK) {
          scratch.fill(0);
          const end = Math.min(start + SHARD_CHUNK, positions.length);
          accumulateChunk(positions, start, end, cellIndex, sc.path, horizon, scratchSink, rateIndices, macro, sc.nmdWarmup, sc.depositShiftPct);
          foldChunk(master, scratch, C, horizon);
        }
        out.set(sc.scenarioId, master);
      }
    }
    return out;
  }

  // Sharded path: contiguous chunk ranges per worker, one worker task covering
  // every group. Worker w takes chunks [floor(w·C/W), floor((w+1)·C/W)) of each
  // group, where C is that group's chunk count.
  const entry = new URL("./workerEntry.mjs", import.meta.url);
  const workers: { worker: Worker; port: MessagePort; flag: Int32Array }[] = [];
  try {
    for (let w = 0; w < workerCount; w++) {
      const payloadGroups = groups.map((g) => {
        const chunks = Math.ceil(g.positions.length / SHARD_CHUNK);
        const lo = Math.floor((w * chunks) / workerCount) * SHARD_CHUNK;
        const hi = Math.min(
          Math.floor(((w + 1) * chunks) / workerCount) * SHARD_CHUNK,
          g.positions.length,
        );
        return {
          positions: g.positions.slice(lo, hi),
          // Slice-relative, cut on the same boundaries as the positions beside
          // it, so index p of one is index p of the other inside the worker
          // (plan deviation 1). Int32Array.slice copies, so each worker owns
          // its own buffer; workerData is structured-cloned on the way in, the
          // same way the positions array already is, and the inbound
          // transferList still carries only channel.port2.
          cellIndex: cellIndex.slice(lo, hi),
          scenarios: g.scenarios.map((s) => ({
            scenarioId: s.scenarioId,
            rateSpec: s.rateSpec,
            // A plain number array clones as it is; absent stays absent.
            ...(s.nmdWarmup !== undefined ? { nmdWarmup: [...s.nmdWarmup] } : {}),
            ...(s.depositShiftPct !== undefined ? { depositShiftPct: s.depositShiftPct } : {}),
          })),
        };
      });
      const sab = new SharedArrayBuffer(4);
      const flag = new Int32Array(sab);
      const channel = new MessageChannel();
      const worker = new Worker(entry, {
        workerData: {
          port: channel.port2,
          sab,
          marketSnapshot,
          cellCount: C,
          horizon,
          groups: payloadGroups,
          // Present only when the run asked, so a worker of an OFF run gets the data it always did.
          ...(gapInterest ? { gapInterest: true } : {}),
          // The run's indices as a plain list (a Map clones, but the
          // worker rebuilds its own table), or undefined for an unindexed run.
          rateIndices: rateIndices === undefined ? undefined : ([...rateIndices.values()] as RateIndex[]),
          // The plain wire form; the brand does not survive a structured
          // clone, so the shard worker re-mints it from this wire form.
          macro: macro === undefined ? undefined : toWire(macro),
        },
        transferList: [channel.port2],
      });
      worker.unref();
      workers.push({ worker, port: channel.port1, flag });
    }

    // Collect and fold. Worker order is ascending shard index and each worker's
    // chunk list is ascending within its contiguous range, so folding worker 0's
    // chunks first, then worker 1's, is exactly the flat global chunk order.
    const results: WorkerResult[] = workers.map(({ port, flag }) => {
      // No clock read (determinism scan): the budget is counted in bounded
      // Atomics.wait slices instead of wall-clock timestamps.
      let remainingMs = WORKER_TIMEOUT_MS;
      while (Atomics.load(flag, 0) === 0) {
        if (remainingMs <= 0) {
          throw new Error("runStaticPass: shard worker timed out");
        }
        Atomics.wait(flag, 0, 0, 1_000);
        remainingMs -= 1_000;
      }
      const received = receiveMessageOnPort(port);
      if (!received) throw new Error("runStaticPass: shard worker signalled but posted no result");
      return received.message as WorkerResult;
    });
    for (const r of results) {
      if (r.error !== undefined) {
        throw new Error(`runStaticPass: shard worker failed: ${r.error}`);
      }
    }

    for (let g = 0; g < groups.length; g++) {
      const scenarios = groups[g].scenarios;
      for (let s = 0; s < scenarios.length; s++) {
        const master = allocMasterSink(C, horizon, gapInterest);
        for (const r of results) {
          for (const buf of r.groups![g].scenarios[s].chunks) {
            foldChunk(master, buf, C, horizon);
          }
        }
        out.set(scenarios[s].scenarioId, master);
      }
    }
    return out;
  } finally {
    for (const { worker } of workers) void worker.terminate();
  }
}
