/**
 * The flip: a market with no
 * curveSetup block and no curveDefault marker builds curve default version 2,
 * the setup defaultSetupFromSnapshot fills from its quotes, log-linear on
 * discount factor, through buildCurveFromSetup. A snapshot the default cannot
 * represent (ok:false from the fill, or a CurveBuildError from the solver)
 * falls back to the kernel bootstrap, version 1, and the stamp carries the
 * reason. The marker still builds the kernel bytes and a block still wins.
 * Par repricing and every expected sentence are restated by hand, never
 * imported from the code under test.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootstrapZeroCurve, parseMarketSnapshot, type CurveQuote, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import { buildBaseCurve, curveDefaultOf, curveDefaultStampOf } from "../rateEnvironment";
import { buildBaseCurve as fromIndex, curveDefaultStampOf as stampFromIndex } from "../index";
import { buildCurveFromSetup, defaultSetupFromSnapshot, validateCurveSetup } from "../../curveBuilder";
import { isFastCurve } from "../../curveBuilder/fastCurve";
import { setupFromSnapshot } from "../../curveBuilder/__tests__/helpers";
import type { MarketWithCurveSetup } from "../../contracts/curveSetup";

const load = (url: URL): MarketSnapshot => parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));
const PUBLIC = load(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const CONSTRUCTED = load(
  new URL("../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json", import.meta.url),
);

const marked = (s: MarketSnapshot): MarketSnapshot => ({ ...s, curveDefault: 1 }) as MarketSnapshot;
const withQuotes = (s: MarketSnapshot, curveQuotes: CurveQuote[]): MarketSnapshot => ({ ...s, curveQuotes });

/** The default's own build of a snapshot, outside buildBaseCurve. */
function v2Of(s: MarketSnapshot): ZeroCurve {
  const filled = defaultSetupFromSnapshot(s);
  if (!filled.ok) throw new Error(filled.reason);
  return buildCurveFromSetup(filled.block).curve;
}

/**
 * The par rate a curve gives a semi-annual Treasury row at `months`, restated from the public pack's basis
 * disclosure: under six months a pure discount bill quoted coupon-equivalent, DF = (1 + y/2)^(-2t); at six
 * months one coupon at maturity, DF = 1 / (1 + y/2); from one year a semi-annual par bond,
 * y = 2 (1 - DF(T)) / sum_{k=1..2T} DF(k/2).
 */
function semiParOf(curve: ZeroCurve, months: number): number {
  const t = months / 12;
  const df = curve.discountFactor(t);
  if (months < 6) return 2 * (df ** (-1 / (2 * t)) - 1);
  if (months < 12) return 2 * (1 / df - 1);
  let annuity = 0;
  for (let k = 1; k <= 2 * t; k++) annuity += curve.discountFactor(k / 2);
  return (2 * (1 - df)) / annuity;
}

describe("a market with no curveSetup and no marker builds curve default version 2", () => {
  const curve = buildBaseCurve(PUBLIC);
  const kernel = bootstrapZeroCurve(PUBLIC);

  it("is the curve buildCurveFromSetup builds from defaultSetupFromSnapshot, node for node", () => {
    const direct = v2Of(PUBLIC);
    expect(curve.t).toEqual(direct.t);
    expect(curve.z).toEqual(direct.z);
    expect(curve.convention).toBe("semiannual_bond");
    expect(isFastCurve(curve)).toBe(true);
    // 360 whole-month nodes, the first at exactly 1/12 (the kernel's first node is the quote's 0.083333).
    expect(curve.t.length).toBe(360);
    expect(curve.t[0]).toBe(1 / 12);
    expect(curve.t[359]).toBe(30);
    expect(kernel.t[0]).toBe(0.083333);
    // The package index exports the same function.
    expect(fromIndex(PUBLIC).z).toEqual(curve.z);
  });

  it("reprices every public quote at par to 1e-10, on a hand-restated Treasury par formula", () => {
    const months = [1, 3, 6, 12, 24, 36, 60, 84, 120, 240, 360];
    expect(PUBLIC.curveQuotes.map((q) => Math.round(q.tYears * 12))).toEqual(months);
    PUBLIC.curveQuotes.forEach((q, i) => {
      expect(Math.abs(semiParOf(curve, months[i]) - q.rate), q.term).toBeLessThan(1e-10);
    });
  });

  it("agrees with the kernel on the 1M, 3M and 6M rows and differs slightly off-node at the long end", () => {
    // Short rows are direct under both: z = 2 ln(1 + y/2) at 1M, 3M and 6M whatever t is.
    expect(Math.abs(curve.z[0] - kernel.z[0])).toBeLessThan(1e-15);
    expect(Math.abs(curve.zeroRate(0.25) - kernel.zeroRate(0.25))).toBeLessThan(1e-15);
    expect(Math.abs(curve.zeroRate(0.5) - kernel.zeroRate(0.5))).toBeLessThan(1e-15);
    // At the par nodes the zeros move a little (the coupon dates between nodes are read log-linear on
    // discount factor): -0.23 bp at 10Y, -3.34 bp at 20Y. Off-node in the ten-year gap the move is larger:
    // log-linear on discount factor puts z(15) near z10/3 + 2 z20/3 where linear in zero puts it at the
    // midpoint, so the 15-year zero reads about +10.4 bp above the kernel's. Pinned as bands, not values.
    const bp = (t: number): number => (curve.zeroRate(t) - kernel.zeroRate(t)) * 1e4;
    // B4 Task 10 (Task 5 review minor): +-0.05 bp bands around an independent rebuild of both curves (Python, no engine
    // code: kernel linear in zero on the quote nodes, the default log-linear on discount factor, each par row solved by
    // bisection), which gives -0.2272 bp at 10Y, +10.3786 bp at 15Y and -3.3369 bp at 20Y. Deltas Step 1.
    expect(Math.abs(bp(10) - -0.2272)).toBeLessThan(0.05);
    expect(Math.abs(bp(15) - 10.3786)).toBeLessThan(0.05);
    expect(Math.abs(bp(20) - -3.3369)).toBeLessThan(0.05);
  });

  it("is log-linear on discount factor across the 10Y to 20Y gap, where the kernel is linear in zero", () => {
    // B4 Task 10 (Task 5 review minor): no quote between 10 and 20 years, so ln DF is linear in t across the gap and
    // ln DF(15) is the mean of ln DF(10) and ln DF(20); the kernel puts z(15) at the mean of z(10) and z(20) instead.
    const lnDf = (c: ZeroCurve, t: number): number => Math.log(c.discountFactor(t));
    expect(Math.abs(lnDf(curve, 15) - (lnDf(curve, 10) + lnDf(curve, 20)) / 2)).toBeLessThan(1e-12);
    for (const t of [12, 17.5]) {
      const w = (t - 10) / 10;
      expect(Math.abs(lnDf(curve, t) - ((1 - w) * lnDf(curve, 10) + w * lnDf(curve, 20))), `t = ${t}`).toBeLessThan(1e-12);
    }
    expect(Math.abs(kernel.zeroRate(15) - (kernel.zeroRate(10) + kernel.zeroRate(20)) / 2)).toBeLessThan(1e-15);
    expect(Math.abs(lnDf(kernel, 15) - (lnDf(kernel, 10) + lnDf(kernel, 20)) / 2)).toBeGreaterThan(1e-4);
  });

  it("reads 2 from curveDefaultOf and stamps {kind: default, version: 2}", () => {
    expect(curveDefaultOf(PUBLIC)).toBe(2);
    expect(curveDefaultStampOf(PUBLIC)).toEqual({ kind: "default", version: 2 });
    expect(stampFromIndex(PUBLIC)).toEqual({ kind: "default", version: 2 });
  });
});

describe("the constructed pack (annual_act360, a 1D quote)", () => {
  it("builds version 2 with the 1D quote dropped, the short end read from the 1M row", () => {
    const filled = defaultSetupFromSnapshot(CONSTRUCTED);
    expect(filled.ok && filled.dropped).toEqual(["1D"]);
    const curve = buildBaseCurve(CONSTRUCTED);
    const direct = v2Of(CONSTRUCTED);
    expect(curve.t).toEqual(direct.t);
    expect(curve.z).toEqual(direct.z);
    expect(curve.convention).toBe("annual_act360");
    expect(curve.t[0]).toBe(1 / 12);
    // The 1M row is a non-cash par row of a year or less: DF = 1 / (1 + r t) on t = 1/12, hand-restated.
    expect(Math.abs(curve.discountFactor(1 / 12) - 1 / (1 + 0.0375 / 12))).toBeLessThan(1e-15);
    expect(curveDefaultStampOf(CONSTRUCTED)).toEqual({ kind: "default", version: 2 });
  });
});

describe("a snapshot the default cannot represent falls back to curve default version 1", () => {
  // 61 month-exact usable quotes: months 1 to 11, then every 6 months from 12 to 306.
  const tenors = [...Array.from({ length: 11 }, (_, i) => i + 1), ...Array.from({ length: 50 }, (_, i) => 12 + 6 * i)];
  const sixtyOne = withQuotes(
    PUBLIC,
    tenors.map((m) => ({ term: `${m}M`, tYears: m / 12, instrumentType: m < 12 ? "BILL_BEY" : "CMT_PAR", rate: 0.04 }) as CurveQuote),
  );

  it("a 61-usable-row market builds the kernel bootstrap and stamps version 1 with the reason", () => {
    expect(sixtyOne.curveQuotes.length).toBe(61);
    const curve = buildBaseCurve(sixtyOne);
    const kernel = bootstrapZeroCurve(sixtyOne);
    expect(curve.t).toEqual(kernel.t);
    expect(curve.z).toEqual(kernel.z);
    expect(isFastCurve(curve)).toBe(false);
    expect(curveDefaultOf(sixtyOne)).toBe(1);
    expect(curveDefaultStampOf(sixtyOne)).toEqual({
      kind: "default",
      version: 1,
      reason: "the snapshot holds 61 curve quotes of one month or longer; the default curve takes at most 60",
    });
  });

  // An annual ACT/360 cash row at 12 months quoted at -99 percent: the fill and the validator take it (a rate
  // within 1.0 in magnitude), but the new methods' cash accrual gives DF = 1 / (1 - 0.99 x 365/360), which is
  // negative, so the solver refuses it with a CurveBuildError. The kernel accrues on t years, DF = 1 / 0.01,
  // and builds.
  const solverRefuses = withQuotes(CONSTRUCTED, [
    { term: "1M", tYears: 1 / 12, instrumentType: "CASH", rate: 0.04 },
    { term: "12M", tYears: 1, instrumentType: "CASH", rate: -0.99 },
  ]);

  it("a snapshot that passes the fill but fails the solver builds the kernel bootstrap and stamps the solver's reason", () => {
    expect(defaultSetupFromSnapshot(solverRefuses).ok).toBe(true);
    const curve = buildBaseCurve(solverRefuses);
    const kernel = bootstrapZeroCurve(solverRefuses);
    expect(curve.t).toEqual(kernel.t);
    expect(curve.z).toEqual(kernel.z);
    expect(curveDefaultOf(solverRefuses)).toBe(1);
    const df = 1 / (1 - 0.99 * (365 / 360));
    expect(curveDefaultStampOf(solverRefuses)).toEqual({
      kind: "default",
      version: 1,
      reason: `the default curve's solver refused this snapshot: the par-rate cash row at 12 months gives a discount factor of ${df}, which has no zero rate`,
    });
  });

  it("a quote the fill refuses (off a whole month) falls back with the fill's reason", () => {
    const threeWeeks = withQuotes(PUBLIC, [{ term: "3W", tYears: 0.0575, instrumentType: "BILL_BEY", rate: 0.037 }, ...PUBLIC.curveQuotes]);
    const curve = buildBaseCurve(threeWeeks);
    expect(curve.z).toEqual(bootstrapZeroCurve(threeWeeks).z);
    expect(curveDefaultStampOf(threeWeeks)).toEqual({
      kind: "default",
      version: 1,
      reason: "quote 3W at 0.0575 years is not within 0.0001 years of a whole month",
    });
  });
});

describe("the marker and the block keep their routes after the flip", () => {
  it("a marked market builds the kernel bytes and stamps version 1 with no reason", () => {
    const curve = buildBaseCurve(marked(PUBLIC));
    const kernel = bootstrapZeroCurve(PUBLIC);
    expect(curve.t).toEqual(kernel.t);
    expect(curve.z).toEqual(kernel.z);
    for (const t of [0.25, 1, 2.5, 7, 10, 15, 20, 30]) expect(curve.discountFactor(t)).toBe(kernel.discountFactor(t));
    expect(curveDefaultOf(marked(PUBLIC))).toBe(1);
    const stamp = curveDefaultStampOf(marked(PUBLIC));
    expect(stamp).toEqual({ kind: "default", version: 1 });
    expect("reason" in stamp).toBe(false);
  });

  it("a curveSetup block wins over both the marker and the default, and stamps its id", () => {
    const setup = { ...setupFromSnapshot(PUBLIC, "cubic-zero"), id: "cs-mine" };
    const checked = validateCurveSetup(setup);
    if (!checked.ok) throw new Error(checked.refusals.join("; "));
    const direct = buildCurveFromSetup(checked.block).curve;
    for (const m of [{ ...PUBLIC, curveSetup: setup }, { ...PUBLIC, curveDefault: 1, curveSetup: setup }] as MarketWithCurveSetup[]) {
      const built = buildBaseCurve(m);
      expect(built.z).toEqual(direct.z);
      expect(built.z).not.toEqual(v2Of(PUBLIC).z);
      expect(curveDefaultStampOf(m)).toEqual({ kind: "setup", id: "cs-mine" });
    }
  });

  it("the stamp refuses a marker value other than 1, as buildBaseCurve does", () => {
    const bad = { ...PUBLIC, curveDefault: 2 } as MarketSnapshot;
    const sentence =
      "The market's curveDefault is 2; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.";
    expect(() => curveDefaultStampOf(bad)).toThrow(sentence);
    expect(() => buildBaseCurve(bad)).toThrow(sentence);
  });

  it("the stamp and the build leave the snapshot unchanged", () => {
    const copy = JSON.parse(JSON.stringify(PUBLIC)) as MarketSnapshot;
    buildBaseCurve(copy);
    curveDefaultStampOf(copy);
    expect(copy).toEqual(JSON.parse(JSON.stringify(PUBLIC)));
  });
});

// B4 Task 7 (Task 5 review minor 4): curveDefaultOf reads a market for the derived-curve stamp and the
// readiness warning, so a snapshot whose quotes the fill cannot read answers version 1 and never throws.
describe("curveDefaultOf never throws for a snapshot the fill cannot read", () => {
  const { curveQuotes: _q, ...noQuotes } = PUBLIC;
  void _q;
  const setup = { ...setupFromSnapshot(PUBLIC, "cubic-zero"), id: "cs-mine" };

  it("a snapshot carrying a curveSetup block and no curveQuotes list reads 1, and the stamp names the setup", () => {
    const withBlock = { ...noQuotes, curveSetup: setup } as unknown as MarketSnapshot;
    expect(curveDefaultOf(withBlock)).toBe(1);
    expect(curveDefaultStampOf(withBlock)).toEqual({ kind: "setup", id: "cs-mine" });
  });

  it("a snapshot with no block and no curveQuotes list reads 1, and the fill says why in words", () => {
    const bare = noQuotes as unknown as MarketSnapshot;
    expect(curveDefaultOf(bare)).toBe(1);
    expect(defaultSetupFromSnapshot(bare)).toEqual({ ok: false, reason: "the snapshot carries no curveQuotes list" });
    expect(curveDefaultStampOf(bare)).toEqual({ kind: "default", version: 1, reason: "the snapshot carries no curveQuotes list" });
  });

  it("a curveQuotes entry that is not a quote is a reason, not a throw", () => {
    const holey = { ...PUBLIC, curveQuotes: [null, ...PUBLIC.curveQuotes] } as unknown as MarketSnapshot;
    expect(curveDefaultOf(holey)).toBe(1);
    expect(defaultSetupFromSnapshot(holey)).toEqual({ ok: false, reason: "curve quote 1 is not a quote" });
  });

  it("a marker still reads 1 without the fill, and a bad marker is still refused in words", () => {
    expect(curveDefaultOf({ ...noQuotes, curveDefault: 1 } as unknown as MarketSnapshot)).toBe(1);
    expect(() => curveDefaultOf({ ...PUBLIC, curveDefault: 2 } as unknown as MarketSnapshot)).toThrow(/^The market's curveDefault is 2; the only value it takes is 1/);
  });
});
