/**
 * IndexRatePath. Expected values are literals measured on
 * unmodified source plus the formula (probe2.ts, probe3.ts); none is imported
 * from the code under test.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type RatePath, type ZeroCurve } from "@alm/kernel";
import { buildBaseCurve, buildRatePath, shockedCurve } from "../../scenario/rateEnvironment";
import { IndexRatePath } from "../indexRatePath";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));

/** A stub path: rateAt reads the table, clamped to its last value. */
class Stub implements RatePath {
  readonly nSteps = 400;
  readonly times: number[] = [];
  constructor(private readonly r: (s: number) => number) {}
  rateAt(s: number): number {
    return this.r(s);
  }
  forwardRateAt(step: number, tenorYears: number): number {
    return step * 1000 + tenorYears;
  }
}

let curve: ZeroCurve;
let path: RatePath;
beforeAll(async () => {
  const snap = await loadMarketSnapshot(FIXTURE);
  curve = buildBaseCurve(snap);
  path = buildRatePath(shockedCurve(curve, { kind: "base" }), 360);
});

describe("identity: tenor 1, basis 0", () => {
  it("returns the wrapped rate exactly for every step", () => {
    const w = new IndexRatePath(path, { tenorMonths: 1, basis: 0 });
    for (let s = 0; s <= 399; s++) expect(Object.is(w.rateAt(s), path.rateAt(s))).toBe(true);
    // R(0) = 12 (exp(z1M / 12) - 1) with the first node at exactly 1/12 (was 0.03711187754093537 at 0.083333); interpolation, deltas Step 1
    expect(path.rateAt(0)).toBe(0.03711187832875318);
  });
});

describe("flat stub 0.04", () => {
  const flat = new Stub(() => 0.04);
  it("compounds the one-month rate over the tenor", () => {
    expect(new IndexRatePath(flat, { tenorMonths: 3, basis: 0 }).rateAt(0)).toBeCloseTo(0.0401334814814831, 14);
    expect(new IndexRatePath(flat, { tenorMonths: 6, basis: 0 }).rateAt(0)).toBeCloseTo(0.0403348185234611, 14);
    expect(new IndexRatePath(flat, { tenorMonths: 12, basis: 0 }).rateAt(0)).toBeCloseTo(0.040741542919790596, 14);
  });
});

describe("step stub 0.03, 0.036, 0.042, 0.048 then clamped", () => {
  const steps = new Stub((s) => [0.03, 0.036, 0.042, 0.048][Math.min(s, 3)]!);
  it("reads the path's own resets over the window", () => {
    expect(new IndexRatePath(steps, { tenorMonths: 3, basis: 0 }).rateAt(0)).toBeCloseTo(0.03610710499999925, 14);
    expect(new IndexRatePath(steps, { tenorMonths: 3, basis: 0 }).rateAt(1)).toBeCloseTo(0.042146167999999484, 14);
  });
  it("adds the basis after compounding", () => {
    expect(new IndexRatePath(steps, { tenorMonths: 3, basis: 0.005 }).rateAt(0)).toBeCloseTo(0.04110710499999925, 14);
  });
});

describe("public deterministic path", () => {
  it("tenor 3 at step 0 telescopes to the curve's simple forward", () => {
    const w = new IndexRatePath(path, { tenorMonths: 3, basis: 0 });
    expect(w.rateAt(0)).toBeCloseTo(0.03683043983766954, 14);
    // curve.forwardRate(0, 0.25) measured at 0.036830439837670426
    expect(Math.abs(w.rateAt(0) - curve.forwardRate(0, 0.25))).toBeLessThan(1e-14);
    expect(curve.forwardRate(0, 0.25)).toBeCloseTo(0.036830439837670426, 14);
  });
  it("tenor 3 at step 12, tenor 6 and tenor 12 at step 0", () => {
    // The 1Y to 1.25Y simple forward, now flat across the 1Y to 2Y par gap (log-linear on DF; was 0.03802255558583578); deltas Step 1
    expect(new IndexRatePath(path, { tenorMonths: 3, basis: 0 }).rateAt(12)).toBeCloseTo(0.0388539126232601, 14);
    expect(new IndexRatePath(path, { tenorMonths: 6, basis: 0 }).rateAt(0)).toBeCloseTo(0.03719999999999901, 14);
    // The 12 one-month resets compound to the 1Y node forward in exact arithmetic on both curves; the monthly rates
    // between nodes differ, so the roundoff moved 1.3e-14 (was 0.03713481303740518); deltas Step 1
    expect(new IndexRatePath(path, { tenorMonths: 12, basis: 0 }).rateAt(0)).toBeCloseTo(0.03713481303739252, 14);
  });
});

describe("pass-through", () => {
  it("takes nSteps and times from the wrapped path; forwardRateAt is the wrapped path's", () => {
    const stub = new Stub(() => 0.04);
    const w = new IndexRatePath(stub, { tenorMonths: 6, basis: 0.01 });
    expect(w.nSteps).toBe(400);
    expect(w.times).toBe(stub.times);
    expect(w.forwardRateAt(2, 0.25)).toBe(2000.25);
    expect(new IndexRatePath(path, { tenorMonths: 3, basis: 0.01 }).forwardRateAt(0, 0.25)).toBe(path.forwardRateAt(0, 0.25));
  });
});
