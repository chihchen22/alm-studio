/**
 * Engine-side fast curve.
 *
 * makeFastCurve must read BIT FOR BIT like the kernel's curve over the same
 * nodes (rehydrateCurve builds the kernel's own object), only through a binary
 * search instead of the kernel's linear node scan. The fixtures below are
 * restated here, not taken from the code under test: node sets of 0, 1, 2, 11
 * and 360 nodes on both conventions, read at every node, the midpoints, one ulp
 * either side of every node, month points, floating-noisy coupon times, before
 * the first node, after the last, and 20,000 seeded-random reads.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bootstrapZeroCurve,
  parseMarketSnapshot,
  rehydrateCurve,
  type CurveConvention,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import { buildCurveFromSetup } from "../buildCurve";
import { isFastCurve, makeFastCurve } from "../fastCurve";
import { monthExactSnapshot, setupFromSnapshot } from "./helpers";

// ------------------------------------------------------------ fixtures
const CONVENTIONS: CurveConvention[] = ["semiannual_bond", "annual_act360"];

const T11 = [1 / 12, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
const Z11 = [0.0431, 0.0428, 0.0419, 0.0402, 0.0388, 0.0379, 0.0373, 0.0377, 0.0384, 0.0412, 0.0405];

const T360: number[] = [];
const Z360: number[] = [];
for (let k = 1; k <= 360; k++) {
  T360.push(k / 12);
  Z360.push(0.035 + 0.008 * Math.sin(k / 37) - 0.002 * Math.cos(k / 11) + k * 1e-6);
}

const NODE_SETS: Array<{ name: string; t: number[]; z: number[] }> = [
  { name: "0 nodes", t: [], z: [] },
  { name: "1 node", t: [2], z: [0.041] },
  { name: "2 nodes", t: [0.5, 10], z: [0.044, 0.037] },
  { name: "11 nodes", t: T11, z: Z11 },
  { name: "360 nodes", t: T360, z: Z360 },
];

/** Next representable double above (dir +1) or below (dir -1) x, for finite x != 0. */
function nextAfter(x: number, dir: 1 | -1): number {
  const f = new Float64Array([x]);
  const b = new BigInt64Array(f.buffer);
  if (x === 0) return dir * Number.MIN_VALUE;
  b[0] += (x > 0) === (dir > 0) ? 1n : -1n;
  return f[0];
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function readTimes(t: number[]): number[] {
  const out: number[] = [-1, -1e-9, 0, 1e-12];
  const last = t.length > 0 ? t[t.length - 1] : 30;
  const first = t.length > 0 ? t[0] : 1;
  out.push(first - 0.5, first / 2, last + 1e-9, last + 0.5, last + 7, 100);
  for (let i = 0; i < t.length; i++) {
    out.push(t[i]);
    if (t[i] !== 0) out.push(nextAfter(t[i], 1), nextAfter(t[i], -1));
    if (i + 1 < t.length) out.push((t[i] + t[i + 1]) / 2);
  }
  for (let m = 0; m <= 400; m++) out.push(m / 12);
  for (let m = 1; m <= 360; m++) for (let k = 0; k <= 3; k++) out.push((m - 1) / 12 + k / 2);
  return out;
}

const TENORS = [1e-6, 1 / 12, 0.25, 0.4999999999, 0.5, 0.75, 0.9999999999, 1, 1.5, 2, 5, 10, 30];

function expectSame(fast: ZeroCurve, kernel: ZeroCurve, times: number[], seed: number): void {
  let mismatches = 0;
  const check = (a: number, b: number): void => {
    if (!Object.is(a, b)) mismatches++;
  };
  for (const x of times) {
    check(fast.zeroRate(x), kernel.zeroRate(x));
    check(fast.discountFactor(x), kernel.discountFactor(x));
    for (const d of TENORS) {
      check(fast.forwardRate(x, x + d), kernel.forwardRate(x, x + d));
      check(fast.forwardRateBey(x, x + d), kernel.forwardRateBey(x, x + d));
      check(fast.forwardSwapRate(x, x + d), kernel.forwardSwapRate(x, x + d));
    }
  }
  const rand = mulberry32(seed);
  const hi = (kernel.t.length > 0 ? kernel.t[kernel.t.length - 1] : 30) + 5;
  for (let i = 0; i < 20_000; i++) {
    const x = -1 + rand() * (hi + 1);
    const d = 1e-6 + rand() * 12;
    check(fast.zeroRate(x), kernel.zeroRate(x));
    check(fast.discountFactor(x), kernel.discountFactor(x));
    check(fast.forwardRate(x, x + d), kernel.forwardRate(x, x + d));
    check(fast.forwardRateBey(x, x + d), kernel.forwardRateBey(x, x + d));
    check(fast.forwardSwapRate(x, x + d), kernel.forwardSwapRate(x, x + d));
  }
  expect(mismatches).toBe(0);
}

// --------------------------------------------------------------- tests
describe("makeFastCurve reads bit for bit like the kernel curve over the same nodes", () => {
  let seed = 1;
  for (const convention of CONVENTIONS) {
    for (const set of NODE_SETS) {
      const s = seed++;
      it(`${set.name}, ${convention}`, () => {
        const fast = makeFastCurve([...set.t], [...set.z], convention);
        const kernel = rehydrateCurve({ t: [...set.t], z: [...set.z], convention });
        expect(fast.t).toEqual(set.t);
        expect(fast.z).toEqual(set.z);
        expect(fast.convention).toBe(convention);
        expect(Object.keys(fast)).toEqual(Object.keys(kernel));
        expect(isFastCurve(fast)).toBe(true);
        expect(isFastCurve(kernel)).toBe(false);
        expectSame(fast, kernel, readTimes(set.t), s);
      });
    }
  }

  it("t and z are the passed arrays, not copies", () => {
    const t = [1, 2];
    const z = [0.03, 0.04];
    const fast = makeFastCurve(t, z, "annual_act360");
    expect(fast.t).toBe(t);
    expect(fast.z).toBe(z);
  });

  it("an exact interior node picks the same interval as the kernel when nodes repeat", () => {
    const t = [1, 2, 2, 3];
    const z = [0.01, 0.02, 0.05, 0.03];
    const fast = makeFastCurve(t, z, "annual_act360");
    const kernel = rehydrateCurve({ t, z, convention: "annual_act360" });
    for (const x of [1.5, 2, nextAfter(2, 1), nextAfter(2, -1), 2.5]) {
      expect(Object.is(fast.zeroRate(x), kernel.zeroRate(x))).toBe(true);
    }
  });

  it("a NaN time reads as the kernel reads it", () => {
    const fast = makeFastCurve([...T11], [...Z11], "semiannual_bond");
    const kernel = rehydrateCurve({ t: [...T11], z: [...Z11], convention: "semiannual_bond" });
    expect(Object.is(fast.zeroRate(NaN), kernel.zeroRate(NaN))).toBe(true);
    expect(Object.is(fast.discountFactor(NaN), kernel.discountFactor(NaN))).toBe(true);
  });
});

describe("errors match the kernel's", () => {
  for (const convention of CONVENTIONS) {
    it(`forwardRate and forwardSwapRate refuse t2 <= t1 (${convention})`, () => {
      const fast = makeFastCurve([...T11], [...Z11], convention);
      const kernel = rehydrateCurve({ t: [...T11], z: [...Z11], convention });
      for (const [t1, t2] of [[2, 2], [3, 1]]) {
        const kMsg = (fn: () => unknown): string => {
          try {
            fn();
          } catch (e) {
            return (e as Error).message;
          }
          throw new Error("kernel did not throw");
        };
        expect(() => fast.forwardRate(t1, t2)).toThrow(kMsg(() => kernel.forwardRate(t1, t2)));
        expect(() => fast.forwardRate(t1, t2)).toThrow(`forwardRate: t2=${t2} must exceed t1=${t1}`);
        expect(() => fast.forwardSwapRate(t1, t2)).toThrow(kMsg(() => kernel.forwardSwapRate(t1, t2)));
        expect(() => fast.forwardRateBey(t1, t2)).toThrow(kMsg(() => kernel.forwardRateBey(t1, t2)));
      }
    });
  }
});

describe("read cost is logarithmic in the node count", () => {
  /** An array whose numeric index reads are counted. */
  function counted(xs: number[], tally: { n: number }): number[] {
    return new Proxy(xs, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) tally.n++;
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const BOUND = 2 * Math.ceil(Math.log2(360)) + 8;

  for (const x of [1 / 12, 0.03, 7.3, 15, 15.04, 29.95, 30, 31, 150 / 12, 359 / 12]) {
    it(`one discountFactor at ${x} on 360 nodes reads at most ${BOUND} elements`, () => {
      const tally = { n: 0 };
      const curve = makeFastCurve(counted([...T360], tally), counted([...Z360], tally), "semiannual_bond");
      const kernel = rehydrateCurve({ t: [...T360], z: [...Z360], convention: "semiannual_bond" });
      tally.n = 0;
      const df = curve.discountFactor(x);
      expect(tally.n).toBeLessThanOrEqual(BOUND);
      expect(tally.n).toBeGreaterThan(0);
      expect(Object.is(df, kernel.discountFactor(x))).toBe(true);
    });
  }
});

describe("buildCurveFromSetup returns a fast curve off the legacy path only", () => {
  const PUBLIC = new URL("../../../../kernel/public/market_public.json", import.meta.url);
  const load = (url: URL): MarketSnapshot => parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));
  const snap = monthExactSnapshot(load(PUBLIC)).snapshot;

  it("the legacy delegate is the kernel object, not a fast curve", () => {
    const built = buildCurveFromSetup(setupFromSnapshot(snap, "linear-zero"));
    const kernel = bootstrapZeroCurve(snap);
    expect(isFastCurve(built.curve)).toBe(false);
    expect(built.curve.t).toEqual(kernel.t);
    expect(built.curve.z).toEqual(kernel.z);
    expect(built.curve.convention).toBe(kernel.convention);
  });

  it("a log-linear-df setup returns a fast curve reading bit for bit like the kernel over the same nodes", () => {
    const built = buildCurveFromSetup(setupFromSnapshot(snap, "log-linear-df"));
    expect(isFastCurve(built.curve)).toBe(true);
    expect(built.curve.t).toHaveLength(360);
    const kernel = rehydrateCurve({ t: [...built.curve.t], z: [...built.curve.z], convention: built.curve.convention });
    expectSame(built.curve, kernel, readTimes(built.curve.t), 99);
  });

  it("a linear-zero setup off the kernel conventions (solver path) returns a fast curve", () => {
    const setup = { ...setupFromSnapshot(snap, "linear-zero"), dayCount: "ACT/365" as const, compounding: "annual" as const };
    const built = buildCurveFromSetup(setup);
    expect(isFastCurve(built.curve)).toBe(true);
    const kernel = rehydrateCurve({ t: [...built.curve.t], z: [...built.curve.z], convention: built.curve.convention });
    expectSame(built.curve, kernel, readTimes(built.curve.t), 7);
  });
});
