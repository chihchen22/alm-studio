/**
 * Short-rate volatility ops on deriveMarketSnapshot.
 * The fixture is the public pack's constructed illustrative short-rate vol
 * analog, not market quotes. Every expected value is restated here as a
 * literal; the scipy figures (an independent least_squares fit on the same 15
 * ATM targets) are literals compared against the kernel result within stated
 * tolerances, and this file never shells out.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapZeroCurve, calibrateHW, loadMarketSnapshot, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import { deriveMarketSnapshot, MarketDerivationError } from "../deriveMarketSnapshot";

const FIXTURE = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const BASE_ID = "market-public-2026-03-31";
const BASE_HASH = "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651";
const OPTS = { baseId: BASE_ID };

const ATM_X15: Array<[number, number]> = [
  [1, 0.0095175],
  [2, 0.009318],
  [3, 0.0091755],
  [4, 0.009066],
  [5, 0.008976],
  [6, 0.0088995],
  [7, 0.008835],
  [8, 0.0087765],
  [9, 0.008724],
  [10, 0.0086775],
  [12, 0.008595],
  [15, 0.008493],
  [20, 0.008358],
  [25, 0.008253],
  [30, 0.008166],
];

let loaded: MarketSnapshot;
let curve: ZeroCurve;
beforeAll(async () => {
  loaded = await loadMarketSnapshot(FIXTURE);
  curve = bootstrapZeroCurve(loaded);
});
const load = (): MarketSnapshot => structuredClone(loaded);

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    if (e instanceof MarketDerivationError) return e.problems;
    throw e;
  }
  throw new Error("expected a MarketDerivationError");
}
const one = (fn: () => unknown): { at: string; message: string } => {
  const p = problemsOf(fn);
  expect(p).toHaveLength(1);
  return p[0]!;
};
const d = (ops: unknown[], base: MarketSnapshot = load()) => () => deriveMarketSnapshot(base, ops, OPTS);
const atmOf = (s: MarketSnapshot): Array<[number, number]> => s.capQuotes.filter((q) => q.isAtm).map((q) => [q.expiryYears, q.normalVol]);
const ceilingText = (t: string, n: number, m: number, lo: string, hi: string): string =>
  `short-rate volatilities at the ${t}-year expiry: ${n} of ${m} derived values fall outside the open range 0 to 0.05 (lowest ${lo}, highest ${hi}); a short-rate volatility must be finite, greater than 0 and below 0.05 (500 bp), the ceiling of the Hull-White sigma the calibration fits`;

describe("base fixture", () => {
  it("is the public pack: 390 cap points, 15 ATM expiries, restated hash", () => {
    const b = load();
    expect(b.capQuotes).toHaveLength(390);
    expect(atmOf(b).map(([t]) => t)).toEqual(ATM_X15.map(([t]) => t));
    expect(atmOf(b)[0]).toEqual([1, 0.006345]);
    expect(b.termFundingCurveQuotes).toHaveLength(11);
    expect(createHash("sha256").update(JSON.stringify(b)).digest("hex")).toHaveLength(64);
  });
});

describe("V0: scale 1.5 at every expiry, shape and bytes", () => {
  let base: MarketSnapshot;
  let r: ReturnType<typeof deriveMarketSnapshot>;
  beforeAll(() => {
    base = load();
    r = deriveMarketSnapshot(base, [{ op: "scale-short-rate-vol", value: 1.5 }], OPTS);
  });
  it("keeps the base key order and appends derivedFrom last", () => {
    expect(Object.keys(r.snapshot)).toEqual([...Object.keys(base), "derivedFrom"]);
  });
  it("keeps 390 quotes with the element key order expiryYears, strike, normalVol, isAtm", () => {
    expect(r.snapshot.capQuotes).toHaveLength(390);
    for (const q of r.snapshot.capQuotes) expect(Object.keys(q)).toEqual(["expiryYears", "strike", "normalVol", "isAtm"]);
  });
  it("scales the ATM column", () => {
    expect(atmOf(r.snapshot)).toEqual(ATM_X15);
  });
  it("copies every other block unchanged", () => {
    expect(r.snapshot.swaptionATMQuotes).toEqual(base.swaptionATMQuotes);
    expect(r.snapshot.curveQuotes).toEqual(base.curveQuotes);
    expect(r.snapshot.tlpNodes).toEqual(base.tlpNodes);
    expect(r.snapshot.termFundingCurveQuotes).toEqual(base.termFundingCurveQuotes);
    expect(r.snapshot.termFundingCurveQuotes).toHaveLength(11);
    expect(r.termFundingQuotesDropped).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.indexChanges).toEqual([]);
  });
  it("reports one volChanges row per expiry, the first as restated", () => {
    expect(r.volChanges).toHaveLength(15);
    expect(r.volChanges[0]).toEqual({ expiryYears: 1, quotes: 26, quotesChanged: 26, atmFrom: 0.006345, atmTo: 0.0095175, atmChangeBp: 31.725, ops: [0] });
  });
  it("records derivedFrom, the default id and the default label", () => {
    expect(r.snapshot.derivedFrom).toEqual({
      baseId: BASE_ID,
      baseContentHash: BASE_HASH,
      ops: [{ op: "scale-short-rate-vol", value: 1.5 }],
    });
    expect(r.id).toBe("derived-mk-fdb4bee2e09a");
    expect(r.label).toBe("Short-rate volatility shock on market-public-2026-03-31 (demonstration values)");
  });
  it("stores the restated bytes", () => {
    const text = `${JSON.stringify(r.snapshot, null, 2)}\n`;
    expect(createHash("sha256").update(text).digest("hex")).toBe("f9737f2aae0c8b7d9c86dd3fbd49f280019cd47c6011c571bb206c3ff73e95f6");
  });
  it("does not mutate the base", () => {
    expect(atmOf(base)[0]).toEqual([1, 0.006345]);
    expect(base).not.toHaveProperty("derivedFrom");
  });
});

describe("V1: scale linearity through the kernel calibration", () => {
  it("scales sigma by k and RMSE by k, and leaves a unchanged", () => {
    const base = calibrateHW(load(), curve);
    expect(base.a).toBeCloseTo(0.0107424885, 7);
    expect(Math.abs(base.a - 0.0107424885)).toBeLessThan(1e-7);
    expect(Math.abs(base.sigma - 0.00611845133)).toBeLessThan(1e-8);
    expect(Math.abs(base.rmseBp - 0.892497)).toBeLessThan(1e-5);
    // scipy least_squares on the same 15 targets: base a 0.0107424946, sigma 0.0061184515.
    expect(Math.abs(base.a - 0.0107424946)).toBeLessThan(1e-6);
    expect(Math.abs(base.sigma - 0.0061184515)).toBeLessThan(1e-7);
    const shocked = deriveMarketSnapshot(load(), [{ op: "scale-short-rate-vol", value: 1.5 }], OPTS).snapshot;
    const fit = calibrateHW(shocked, curve);
    expect(Math.abs(fit.sigma / base.sigma - 1.5) / 1.5).toBeLessThan(1e-6);
    expect(Math.abs(fit.a - base.a)).toBeLessThan(1e-7);
    expect(Math.abs(fit.rmseBp / base.rmseBp - 1.5) / 1.5).toBeLessThan(1e-6);
    expect(Math.abs(fit.sigma - 0.009177677)).toBeLessThan(1e-8);
    // scipy x1.5 sigma 0.0091776773.
    expect(Math.abs(fit.sigma - 0.0091776773)).toBeLessThan(1e-7);
  });
});

describe("V2: additive shift refits a", () => {
  it("adds 25 bp to every row", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add-short-rate-vol", value: 25 }], OPTS);
    const atm = atmOf(r.snapshot);
    expect(atm[0]).toEqual([1, 0.008845]);
    expect(atm[14]).toEqual([30, 0.007944]);
    const base = calibrateHW(load(), curve);
    const fit = calibrateHW(r.snapshot, curve);
    expect(Math.abs(fit.a - 0.00736594)).toBeLessThan(1e-7);
    expect(Math.abs(fit.sigma - 0.00858429)).toBeLessThan(1e-8);
    expect(Math.abs(fit.rmseBp - 0.939036)).toBeLessThan(1e-5);
    // scipy: a 0.0073659467, sigma 0.0085842854.
    expect(Math.abs(fit.a - 0.0073659467)).toBeLessThan(1e-6);
    expect(Math.abs(fit.sigma - 0.0085842854)).toBeLessThan(1e-7);
    expect(Math.abs(fit.a - base.a)).toBeGreaterThan(0.003);
  });
});

describe("V3: refusals", () => {
  it("refuses an add that takes the 1Y row to exactly 0, with one row-level problem", () => {
    const base = load();
    const idx = base.capQuotes.findIndex((q) => q.isAtm && q.expiryYears === 1);
    const p = one(d([{ target: { expiryYears: 1 }, op: "add-short-rate-vol", value: -63.45 }], base));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(p.at).toBe(`capQuotes[${idx}].normalVol`);
    expect(p.message).toBe(ceilingText("1", 1, 26, "0", "0"));
  });
  it("lists one problem per offending row for a uniform -60 bp", () => {
    const p = problemsOf(d([{ op: "add-short-rate-vol", value: -60 }]));
    expect(p).toHaveLength(11);
    expect(p[0]!.message).toBe(ceilingText("5", 1, 26, "-0.000016", "-0.000016"));
    expect(p[10]!.message).toContain("at the 30-year expiry");
    expect(p[10]!.message).toContain("lowest -0.000556");
    expect(p.map((x) => x.message.split(" at the ")[1]!.split("-year")[0])).toEqual(["5", "6", "7", "8", "9", "10", "12", "15", "20", "25", "30"]);
    for (const x of p) expect(x.at).toMatch(/^capQuotes\[\d+\]\.normalVol$/);
  });
  it("refuses +400 bp at the 1Y and 2Y rows (at or above the 0.05 ceiling)", () => {
    const p = problemsOf(d([{ op: "add-short-rate-vol", value: 400 }]));
    expect(p).toHaveLength(2);
    expect(p[0]!.message).toContain("at the 1-year expiry: 8 of 26 derived values");
    expect(p[0]!.message).toContain("highest 0.052025)");
    expect(p[1]!.message).toContain("at the 2-year expiry: 2 of 26 derived values");
    expect(p[1]!.message).toContain("(lowest 0.050179, highest 0.050554)");
  });
  it("refuses a scale factor outside 0.25 to 4", () => {
    expect(one(d([{ op: "scale-short-rate-vol", value: 4.5 }])).message).toBe("ops[0]: a short-rate volatility scale factor must be from 0.25 to 4; got 4.5");
    expect(one(d([{ op: "scale-short-rate-vol", value: 0.2 }])).message).toBe("ops[0]: a short-rate volatility scale factor must be from 0.25 to 4; got 0.2");
  });
  it("accepts scale 4 and scale 0.25 at the range edges", () => {
    const hi = deriveMarketSnapshot(load(), [{ op: "scale-short-rate-vol", value: 4 }], OPTS).snapshot;
    const lo = deriveMarketSnapshot(load(), [{ op: "scale-short-rate-vol", value: 0.25 }], OPTS).snapshot;
    expect(Math.max(...hi.capQuotes.map((q) => q.normalVol))).toBe(0.0481);
    expect(Math.min(...hi.capQuotes.map((q) => q.normalVol))).toBe(0.021776);
    expect(Math.min(...lo.capQuotes.map((q) => q.normalVol))).toBe(0.001361);
  });
  it("refuses a non-number value, and an add value that is not finite", () => {
    expect(one(d([{ op: "scale-short-rate-vol", value: "2" }])).message).toBe("ops[0]: value must be a finite number");
    expect(one(d([{ op: "add-short-rate-vol", value: Number.NaN }])).message).toBe("ops[0]: value must be a finite number of basis points");
    expect(one(d([{ op: "add-short-rate-vol", value: Number.POSITIVE_INFINITY }])).message).toBe("ops[0]: value must be a finite number of basis points");
  });
  it("refuses a target that carries no ATM quote, and lists the ATM expiries", () => {
    expect(one(d([{ target: { expiryYears: 11 }, op: "add-short-rate-vol", value: 5 }])).message).toBe(
      'ops[0]: market "market-public-2026-03-31" has no at-the-money short-rate volatility at 11 years; its at-the-money expiries are 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30 years, and a volatility shock cannot add an expiry',
    );
  });
  it("refuses a malformed target", () => {
    const m = "ops[0]: target.expiryYears must be a finite number naming an expiry that carries an at-the-money short-rate volatility";
    expect(one(d([{ target: { expiryYears: "1" }, op: "add-short-rate-vol", value: 5 }])).message).toBe(m);
    expect(one(d([{ target: 1, op: "add-short-rate-vol", value: 5 }])).message).toBe(m);
  });
  it("refuses unknown fields and unknown target fields", () => {
    expect(one(d([{ op: "scale-short-rate-vol", value: 1.1, strike: 0.01 }])).message).toBe(
      'ops[0]: unknown field "strike"; a short-rate volatility op carries op, value and optionally target',
    );
    expect(one(d([{ target: { expiryYears: 1, strike: 0.01 }, op: "add-short-rate-vol", value: 5 }])).message).toBe(
      'ops[0]: unknown target field "strike"; a short-rate volatility target carries expiryYears',
    );
  });
  it("refuses an op that changes nothing with the three-kind text", () => {
    expect(one(d([{ op: "scale-short-rate-vol", value: 1 }]))).toEqual({
      at: "ops",
      message: 'the ops change no TLP node, no rate index and no short-rate volatility; the derived market would carry what market "market-public-2026-03-31" carries',
    });
  });
  it("names the two new ops in the unknown-kind and TLP unknown-field texts", () => {
    expect(one(d([{ op: "set", value: 1 }])).message).toBe(
      'ops[0]: op must be add, scale, set-index, add-index-basis, scale-short-rate-vol or add-short-rate-vol; got "set"',
    );
    expect(one(d([{ op: "add", value: 5, capQuotes: [] }])).message).toBe(
      'ops[0]: unknown field "capQuotes"; an op carries target, op and value and changes the TLP nodes only; a rate index op is set-index or add-index-basis; a short-rate volatility op is scale-short-rate-vol or add-short-rate-vol',
    );
  });
  it("refuses a base with no ATM quote, alone", () => {
    const base: MarketSnapshot = { ...load(), capQuotes: [] };
    const p = problemsOf(d([{ op: "scale-short-rate-vol", value: 1.5 }], base));
    expect(p).toEqual([
      {
        at: "base",
        message: 'market "market-public-2026-03-31" carries no at-the-money short-rate volatility; a stochastic run on it refuses, and a volatility shock would change nothing a run reads',
      },
    ]);
  });
  it("refuses a base with two ATM quotes at one expiry, alone", () => {
    const base: MarketSnapshot = {
      ...load(),
      capQuotes: [
        { expiryYears: 1, strike: null, normalVol: 0.006, isAtm: true },
        { expiryYears: 1, strike: null, normalVol: 0.007, isAtm: true },
      ] as MarketSnapshot["capQuotes"],
    };
    const p = problemsOf(d([{ op: "scale-short-rate-vol", value: 1.5 }], base));
    expect(p).toEqual([
      {
        at: "base",
        message: 'market "market-public-2026-03-31" carries two at-the-money short-rate volatilities at 1 years; a derivation cannot say which one feeds the calibration',
      },
    ]);
  });
  it("refuses an unreadable cap block with the existing base text", () => {
    const base = load();
    (base as unknown as Record<string, unknown>).capQuotes = [{ expiryYears: 0, strike: null, normalVol: 0.006, isAtm: true }];
    expect(one(d([{ op: "scale-short-rate-vol", value: 1.5 }], base)).message).toBe(
      'market "market-public-2026-03-31" is not a market snapshot the derivation can read',
    );
  });
  it("does not read capQuotes when no vol op is present", () => {
    const base = load();
    (base as unknown as Record<string, unknown>).capQuotes = "x";
    expect(() => deriveMarketSnapshot(base, [{ op: "add", value: 10 }], OPTS)).not.toThrow();
  });
  it("collects shape problems across ops", () => {
    const p = problemsOf(d([{ op: "scale-short-rate-vol", value: 9 }, { op: "add-short-rate-vol", value: "x" }]));
    expect(p.map((x) => x.at)).toEqual(["ops[0]", "ops[1]"]);
  });
});

describe("V4: the ceiling restated by behavior", () => {
  it("pins sigma at 0.05 and a at 1e-4 on an all-0.06 surface", () => {
    const flat: MarketSnapshot = { ...load(), capQuotes: load().capQuotes.map((q) => ({ ...q, normalVol: 0.06 })) };
    const fit = calibrateHW(flat, curve);
    expect(fit.sigma).toBe(0.05);
    expect(fit.a).toBe(0.0001);
  });
});

describe("V5: composition", () => {
  it("applies a TLP op and a vol op in one derivation", () => {
    const r = deriveMarketSnapshot(load(), [{ op: "add", value: 50 }, { op: "scale-short-rate-vol", value: 1.5 }], OPTS);
    expect(r.snapshot.tlpNodes.map((n) => n.spread)).toEqual([0, 0.007, 0.007, 0.0075, 0.0075, 0.008, 0.0085, 0.0095, 0.0105, 0.0115, 0.014, 0.015]);
    expect(r.snapshot.termFundingCurveQuotes).toEqual([]);
    expect(atmOf(r.snapshot)).toEqual(ATM_X15);
    expect(r.volChanges[0]!.ops).toEqual([1]);
    expect(r.label).toBe("Funding spread shock and short-rate volatility shock on market-public-2026-03-31 (demonstration values)");
  });
  it("labels three kinds", () => {
    const r = deriveMarketSnapshot(
      load(),
      [{ op: "add", value: 50 }, { op: "set-index", id: "prime-demo", label: "Prime demo", tenorMonths: 1, basisBp: 300 }, { op: "scale-short-rate-vol", value: 1.5 }],
      OPTS,
    );
    expect(r.label).toBe("Funding spread shock, rate indices and short-rate volatility shock on market-public-2026-03-31 (demonstration values)");
  });
  it("labels a rate index and vol pair", () => {
    const r = deriveMarketSnapshot(
      load(),
      [{ op: "set-index", id: "prime-demo", label: "Prime demo", tenorMonths: 1, basisBp: 300 }, { op: "scale-short-rate-vol", value: 1.5 }],
      OPTS,
    );
    expect(r.label).toBe("Rate indices and short-rate volatility shock on market-public-2026-03-31 (demonstration values)");
  });
  it("takes a vol-only derivation on a base with no TLP nodes", () => {
    const base: MarketSnapshot = { ...load(), tlpNodes: [] };
    const r = deriveMarketSnapshot(base, [{ op: "scale-short-rate-vol", value: 1.5 }], OPTS);
    expect(r.snapshot.tlpNodes).toEqual([]);
    expect(atmOf(r.snapshot)).toEqual(ATM_X15);
  });
  it("a targeted op moves the whole 3Y row only, composes in order, and reports it", () => {
    const base = load();
    const r = deriveMarketSnapshot(
      base,
      [{ target: { expiryYears: 3 }, op: "add-short-rate-vol", value: 10 }, { target: { expiryYears: 3 }, op: "scale-short-rate-vol", value: 2 }],
      OPTS,
    );
    expect(r.volChanges).toHaveLength(1);
    expect(r.volChanges[0]!.expiryYears).toBe(3);
    expect(r.volChanges[0]!.ops).toEqual([0, 1]);
    expect(r.volChanges[0]!.quotesChanged).toBe(26);
    // 0.006117 + 0.001 = 0.007117, times 2 = 0.014234.
    expect(r.volChanges[0]!.atmFrom).toBe(0.006117);
    expect(r.volChanges[0]!.atmTo).toBe(0.014234);
    expect(r.volChanges[0]!.atmChangeBp).toBe(81.17);
    const moved = r.snapshot.capQuotes.filter((q, i) => q.normalVol !== base.capQuotes[i]!.normalVol);
    expect(moved).toHaveLength(26);
    expect(moved.every((q) => q.expiryYears === 3)).toBe(true);
  });
});

describe("V6: a targeted shift can breach the 5 bp gate", () => {
  it("refits a and sigma and reports RMSE above 5 bp", () => {
    const r = deriveMarketSnapshot(load(), [{ target: { expiryYears: 1 }, op: "add-short-rate-vol", value: 25 }], OPTS);
    const fit = calibrateHW(r.snapshot, curve);
    expect(Math.abs(fit.a - 0.0223724)).toBeLessThan(1e-6);
    expect(Math.abs(fit.sigma - 0.0066406)).toBeLessThan(1e-7);
    expect(Math.abs(fit.rmseBp - 6.4639)).toBeLessThan(1e-3);
    expect(fit.rmseBp).toBeGreaterThan(5);
  });
});
