/**
 * Chunked accumulation core for the static-projection pass.
 *
 * Determinism across shard counts is bought with one rule: the reduction tree
 * is FIXED and independent of how many workers run. Positions are cut into
 * chunks of SHARD_CHUNK in array order; each chunk accumulates its positions
 * sequentially into a zeroed chunk sink (the same per-position arithmetic as
 * the m03 aggregator plus the gap fold); the master series is then the flat
 * ordered sum of the chunk subtotals, chunk 0 first. Workers own contiguous
 * chunk ranges and ship per-chunk subtotals back, so the main-thread fold is
 * that same flat ordered sum regardless of shard count — shards=1 and
 * shards=N are byte-identical by construction, not by tolerance.
 *
 * A book of at most SHARD_CHUNK positions is a single chunk folded into a
 * zeroed master (0 + x = x bitwise for accumulator-reachable values), so every
 * small-book result is bit-identical to the pre-chunking sequential loop.
 */
import type { RatePath } from "@alm/kernel";
import { accumulateGapPosition, type BucketSeriesPair } from "../../gap";
import type { Position } from "../../contracts/position";
import type { RateIndexTable } from "../../contracts/rateIndex";
import type { RunMacro } from "../../macro/runMacro";
import { seasoningOffsetOf } from "../../portfolio/seasoning";
import { makeInstrument } from "../../runtime/instrumentFactory";

/** Positions per chunk. Fixed: the reduction tree must not depend on shard count. */
export const SHARD_CHUNK = 4096;

/** Metrics per cell in a chunk buffer, in fixed layout order. */
export const CHUNK_METRICS = 5; // balance, principal, interest, repricing, gapPrincipal

/**
 * The metric count when the run asked for the
 * interest-inclusive liquidity ladder. The sixth metric, gapInterest, is
 * APPENDED after the five above, so their offsets, their fold order and their
 * bytes are what they were; a run that did not ask allocates and folds five.
 */
export const CHUNK_METRICS_WITH_INTEREST = 6; // the five above, then gapInterest

/** The metric count of a pass: five, or six with the gap interest carrier. */
export function chunkMetricsOf(gapInterest: boolean): number {
  return gapInterest ? CHUNK_METRICS_WITH_INTEREST : CHUNK_METRICS;
}

/**
 * Per-CELL accumulation target: one Float64Array of `horizon` buckets per CELL
 * per metric. Views over one flat buffer (worker transfer) or standalone
 * arrays (the master) — the arithmetic does not care which.
 */
export interface ChunkSink {
  balance: Float64Array[];
  principal: Float64Array[];
  interest: Float64Array[];
  repricing: Float64Array[];
  gapPrincipal: Float64Array[];
  /**
   * The gap fold's interest cash flow (deposits and commitments add
   * nothing, a swap adds its net settlement). Present only on a pass that was
   * asked for it; the key is absent otherwise.
   */
  gapInterest?: Float64Array[];
}

/**
 * Byte layout of a chunk buffer: [metric][cell][bucket], metrics in sink order.
 * `gapInterest` views a sixth metric, which the buffer must have room for.
 */
export function sinkOverBuffer(buf: Float64Array, cells: number, horizon: number, gapInterest?: boolean): ChunkSink {
  const metric = (m: number): Float64Array[] => {
    const out: Float64Array[] = new Array(cells);
    for (let c = 0; c < cells; c++) {
      const off = (m * cells + c) * horizon;
      out[c] = buf.subarray(off, off + horizon);
    }
    return out;
  };
  const sink: ChunkSink = {
    balance: metric(0),
    principal: metric(1),
    interest: metric(2),
    repricing: metric(3),
    gapPrincipal: metric(4),
  };
  if (gapInterest === true) sink.gapInterest = metric(5);
  return sink;
}

/** A zeroed standalone master sink (one full Float64Array per cell per metric). */
export function allocMasterSink(cells: number, horizon: number, gapInterest?: boolean): ChunkSink {
  const arrays = (): Float64Array[] => {
    const out: Float64Array[] = new Array(cells);
    for (let c = 0; c < cells; c++) out[c] = new Float64Array(horizon);
    return out;
  };
  const sink: ChunkSink = {
    balance: arrays(),
    principal: arrays(),
    interest: arrays(),
    repricing: arrays(),
    gapPrincipal: arrays(),
  };
  if (gapInterest === true) sink.gapInterest = arrays();
  return sink;
}

/**
 * Accumulate positions [start, end) into `sink` in array order: the static
 * triple exactly as aggregateScenario's hot loop, then the gap fold via
 * accumulateGapPosition. Identical per-position arithmetic, aimed at a
 * chunk-local target instead of the run-wide master.
 *
 * The key is the CELL index, read straight out of a typed array
 * rather than looked up in a Map. One array index replaces one map lookup, so
 * the hot loop gets marginally cheaper, not more expensive. The unknown-family
 * refusal moved to buildCellPlan, which is where the family lookup now happens,
 * ONCE per run instead of once per position per scenario.
 * `cellIndexByPosition` is aligned with `positions`: index p of one is index p
 * of the other, which the sharded path holds by slicing both the same way.
 */
export function accumulateChunk(
  positions: Position[],
  start: number,
  end: number,
  cellIndexByPosition: Int32Array,
  path: RatePath,
  horizon: number,
  sink: ChunkSink,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
  nmdWarmup?: readonly number[],
  depositShiftPct?: number,
): void {
  // One options object per chunk, not per position: absent for an
  // unindexed run with no macro value, so the factory call is the one it always
  // was. Piece 7b adds the run's RunMacro beside the index table; Task 16 adds
  // the scenario's deposit warmup, only when the run named one.
  const baseOptions =
    nmdWarmup !== undefined
      ? { rateIndices, macro, nmdWarmup }
      : rateIndices === undefined && macro === undefined
        ? undefined
        : { rateIndices, macro };
  // The scenario's short-rate shift, only when the run's sets bind a full beta form.
  const factoryOptions = depositShiftPct === undefined ? baseOptions : { ...(baseOptions ?? { rateIndices, macro }), depositShiftPct };
  // Cell-indexed view so the gap fold reuses the one shared implementation.
  // The interest carrier rides only on a sink that has it, so a pass
  // that did not ask hands the fold the two-series view it always did.
  const gapView: BucketSeriesPair =
    sink.gapInterest !== undefined
      ? { repricing: sink.repricing, principal: sink.gapPrincipal, interest: sink.gapInterest }
      : { repricing: sink.repricing, principal: sink.gapPrincipal };
  for (let p = start; p < end; p++) {
    const pos = positions[p];
    const ci = cellIndexByPosition[p];
    const bal = sink.balance[ci];
    const prin = sink.principal[ci];
    const int = sink.interest[ci];
    // Seasoning re-anchor (D3a lift, W3-A7; spec: W2-A3 report NOTE 1).
    // The run gate (assertRunPipelineUnseasoned) is lifted: the
    // effective-duration engine now re-anchors seasoned streams itself, so a
    // seasoned fixed-loan flows through the whole pipeline. The validator
    // still throws typed on malformed or type-unsupported offsets, and the
    // static triple applies the same bucket shift as aggregateScenario and the
    // gap fold: bucket = monthOffset - 1 + off, elapsed (< 0) dropped. Adding
    // the literal 0 on the offset-0 path is bitwise-identical arithmetic.
    const off = seasoningOffsetOf(pos.terms);
    const inst = makeInstrument(pos.terms, factoryOptions);
    const cfs = inst.generateCashflows(path);
    for (let c = 0; c < cfs.length; c++) {
      const cf = cfs[c];
      const bucket = cf.monthOffset - 1 + off;
      // Below zero = elapsed before as-of (seasoned); at/above horizon = truncated.
      if (bucket < 0 || bucket >= horizon) continue;
      bal[bucket] += cf.balance;
      prin[bucket] += cf.principalPaid;
      int[bucket] += cf.interestPaid;
    }
    // `path` forwarded per the W1-H3 NOTE (applied by W2-A3): turns on the
    // NMD-B initial-beta repricing split in the run pipeline. Deterministic
    // per scenario and identical across shards, so shard byte-identity holds.
    // Schema 1.9.0: a position flagged repricingTreatment "excluded" books liquidity only.
    accumulateGapPosition(
      gapView,
      ci,
      inst,
      cfs,
      horizon,
      path,
      pos.repricingTreatment === "excluded",
    );
    // Instrument and Cashflow[] fall out of scope here: nothing retained.
  }
}

/**
 * Fold one chunk buffer into the master, element-wise. Callers MUST fold
 * chunks in ascending global chunk order: that order IS the arithmetic.
 * A master carrying gapInterest folds that sixth metric last; the
 * first five fold exactly as before, in the same order.
 */
export function foldChunk(
  master: ChunkSink,
  buf: Float64Array,
  cells: number,
  horizon: number,
): void {
  const metrics: Float64Array[][] = [
    master.balance,
    master.principal,
    master.interest,
    master.repricing,
    master.gapPrincipal,
  ];
  if (master.gapInterest !== undefined) metrics.push(master.gapInterest);
  for (let m = 0; m < metrics.length; m++) {
    const target = metrics[m];
    for (let c = 0; c < cells; c++) {
      const t = target[c];
      const off = (m * cells + c) * horizon;
      for (let k = 0; k < horizon; k++) t[k] += buf[off + k];
    }
  }
}

/**
 * The family series is the ordered fold of its cells, over the family's
 * contiguous cell range ascending.
 *
 * A range holding exactly one cell ALIASES that cell's array rather than
 * copying it: no allocation, no addition, and the family arrays that leave here
 * are the very objects the accumulation filled. Under the identity plan every
 * range holds one cell, so every family number is bit-identical to what the
 * pre-2b pass produced, by construction rather than by tolerance. A family with
 * two or more cells sums them in cell order, which adds the same values in a
 * different order than a direct position fold would; no golden book declares a
 * view, and a book that declares one is asking for the cell grain. An EMPTY
 * range (a declared family the book holds no position for under a general plan)
 * yields a zeroed series, which is what an empty family's series is today.
 */
export function foldCellsToFamilies(
  master: ChunkSink,
  familyCellRange: readonly { start: number; end: number }[],
  horizon: number,
): ChunkSink {
  const F = familyCellRange.length;
  const fold = (cells: Float64Array[]): Float64Array[] => {
    const out: Float64Array[] = new Array(F);
    for (let i = 0; i < F; i++) {
      const { start, end } = familyCellRange[i]!;
      if (end - start === 1) {
        out[i] = cells[start]!;
        continue;
      }
      const acc = new Float64Array(horizon);
      for (let c = start; c < end; c++) {
        const s = cells[c]!;
        for (let k = 0; k < horizon; k++) acc[k] += s[k]!;
      }
      out[i] = acc;
    }
    return out;
  };
  const out: ChunkSink = {
    balance: fold(master.balance),
    principal: fold(master.principal),
    interest: fold(master.interest),
    repricing: fold(master.repricing),
    gapPrincipal: fold(master.gapPrincipal),
  };
  if (master.gapInterest !== undefined) out.gapInterest = fold(master.gapInterest);
  return out;
}
