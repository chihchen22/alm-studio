/**
 * Read-cost benchmark for the curve setup builder.
 *
 *   npx tsx packages/engine/scripts/bench-curve-reads.ts
 *
 * The public pack's curve (packages/kernel/public/market_public.json, made
 * month-exact by the curveBuilder test helper: tYears = months / 12, so the
 * stored 1M at 0.083333 reads as 1/12) is built two ways:
 *   (a) kernel   bootstrapZeroCurve, 11 quote nodes (1M to 30Y);
 *   (b) dense    a log-linear-df setup through buildCurveFromSetup, which
 *                writes 360 monthly nodes (the pack already runs to 30Y, so
 *                no quote is added).
 * Each curve is timed on 2,000,000 forwardSwapRate(k/12, k/12 + 10) reads and
 * 200,000 forwardRate(k/12, k/12 + 1/12) reads, k cycling 0..119. One warm-up
 * pass, then the median of 5 timed runs. The ratio is dense / kernel.
 *
 * STOP RULE: a ratio above 5x on either read is reported to the
 * owner; the cost is not patched here.
 */
import { readFileSync } from "node:fs";
import { bootstrapZeroCurve, parseMarketSnapshot, type ZeroCurve } from "@alm/kernel";
import { buildCurveFromSetup } from "../src/curveBuilder/buildCurve";
import { monthExactSnapshot, setupFromSnapshot } from "../src/curveBuilder/__tests__/helpers";

const SWAP_READS = 2_000_000;
const FORWARD_READS = 200_000;
const RUNS = 5;
const STOP_RATIO = 5;

const raw = JSON.parse(readFileSync(new URL("../../kernel/public/market_public.json", import.meta.url), "utf8"));
const { snapshot } = monthExactSnapshot(parseMarketSnapshot(raw));

const kernel = bootstrapZeroCurve(snapshot);
const dense = buildCurveFromSetup(setupFromSnapshot(snapshot, "log-linear-df")).curve;
if (dense.t.length !== 360) throw new Error(`expected 360 dense nodes, got ${dense.t.length}`);

let sink = 0;

function swapReads(curve: ZeroCurve): void {
  for (let i = 0; i < SWAP_READS; i++) {
    const k = i % 120;
    sink += curve.forwardSwapRate(k / 12, k / 12 + 10);
  }
}

function forwardReads(curve: ZeroCurve): void {
  for (let i = 0; i < FORWARD_READS; i++) {
    const k = i % 120;
    sink += curve.forwardRate(k / 12, k / 12 + 1 / 12);
  }
}

function medianMs(fn: (c: ZeroCurve) => void, curve: ZeroCurve): number {
  fn(curve); // warm-up
  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    fn(curve);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)];
}

const rows: Array<{ read: string; kernelMs: number; denseMs: number }> = [
  { read: `forwardSwapRate x ${SWAP_READS.toLocaleString("en-US")}`, kernelMs: medianMs(swapReads, kernel), denseMs: medianMs(swapReads, dense) },
  { read: `forwardRate x ${FORWARD_READS.toLocaleString("en-US")}`, kernelMs: medianMs(forwardReads, kernel), denseMs: medianMs(forwardReads, dense) },
];

console.log(`curve nodes: kernel ${kernel.t.length}, dense ${dense.t.length} (convention ${kernel.convention})`);
console.log(`median of ${RUNS} runs after one warm-up, node ${process.version}`);
console.log("read | kernel ms | dense ms | ratio");
let tripped = false;
for (const r of rows) {
  const ratio = r.denseMs / r.kernelMs;
  if (ratio > STOP_RATIO) tripped = true;
  console.log(`${r.read} | ${r.kernelMs.toFixed(1)} | ${r.denseMs.toFixed(1)} | ${ratio.toFixed(2)}x`);
}
console.log(tripped ? `STOP RULE TRIPPED: a ratio exceeds ${STOP_RATIO}x` : `stop rule clear: every ratio is at or below ${STOP_RATIO}x`);
console.log(`(checksum ${sink.toPrecision(6)})`);
