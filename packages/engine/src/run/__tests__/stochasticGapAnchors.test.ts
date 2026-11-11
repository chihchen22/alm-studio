/**
 * Slice 4b, T2: the stochastic gap anchors (T2).
 *
 *  (a) zero-vol degeneracy: at sigma = 0 every path's banded SEG and EBP equals the deterministic computeSegBlock
 *      on the run's base path for the same book, to 1e-9 relative (of the book's gross notional where the reference
 *      is zero);
 *  (b) same seed, byte-identical envelope; different seed, different gap;
 *  (c) fold-and-drop equals the test-only keep-all variant, by hash;
 *  (d) absent option: byte-identical envelope and the 0.3.0 stamp (also stochasticGap.test.ts, and the HW golden in
 *      stochasticBgm.test.ts passes unchanged);
 *  the identity of ruling 7: run-off bands plus beyondHorizon equal the month-1 EBP balance, by side, per path;
 *  each path re-shocked around its own rates: the envelope's per-band min, max and mean equal every path banded by
 *  hand from computeSegBlock on that path's rates;
 *  a CD the block cannot cover is carried in `uncovered` and counted, and enters no figure;
 *  a single fixed bullet at sigma 0, banded by hand.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { PortfolioSpec, Position } from "../../contracts/position";
import type { RunRequest } from "../../contracts/run";
import type { StochasticDistribution, StochasticGapBlock } from "../../contracts/stochastic";
import { macroTargetsOf, resolveRunMacro } from "../../macro/runMacro";
import { defaultHarness } from "../../plugins/defaultHarness";
import { applyStaticOverlays } from "../../projection/static";
import { resolveRunRateIndices } from "../../rateIndex/resolve";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { bindAssumptions } from "../../scenario";
import type { StochasticEnvironment } from "../../scenario/stochasticEnvironment";
import { computeSegBlock, SEG_DEFAULTS } from "../../seg";
import { book as segBook, cdPosition, fixedLoan } from "../../seg/__tests__/fixtures";
import { runStochastic } from "../stochastic";
import { bandSegResult, computeStochasticGap, STOCHASTIC_GAP_BANDS, type GapPathValues } from "../stochasticGap";
import { fixedPosition, loadMarket, makeCoa, makeRunRequest, regulatoryScenarios, twoSidedBook, AS_OF } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function baseOnlyRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return makeRunRequest(market, { scenarios: regulatoryScenarios().slice(0, 1), ...overrides });
}

const ZERO = { a: 0.05, sigma: 0, reason: "zero-vol gap anchor" };
const VOL = { a: 0.05, sigma: 0.01, reason: "gap anchor" };
const GAP = { enabled: true } as const;

/** The entry's own effective book and factory, rebuilt for a direct call. */
function entryInputs(req: RunRequest, portfolio: PortfolioSpec) {
  const set = req.assumptionSets.find((s) => s.id === req.scenarios[0]!.assumptionSetId)!;
  const bound = bindAssumptions(set);
  const macro = resolveRunMacro(req, req.marketSnapshot);
  const book = bound.bindings.length > 0 ? applyStaticOverlays(portfolio, bound, undefined, macroTargetsOf(macro)) : portfolio;
  const rateIndices = resolveRunRateIndices(portfolio, req.marketSnapshot, undefined, req.indexHistories ?? []);
  return { book, mk: (p: Position) => makeInstrument(p.terms, { rateIndices, macro }) };
}

/** The deterministic SEG block at 120 months on the run's base path, banded on its own book series. */
function deterministicBanded(req: RunRequest, portfolio: PortfolioSpec): GapPathValues {
  const { book, mk } = entryInputs(req, portfolio);
  const h = defaultHarness();
  const base = req.scenarios[0]!;
  const path = h.get("ratePaths").get("deterministic")(h.get("curves").build(req.marketSnapshot), base, 361);
  const det = computeSegBlock({ book, basePath: path, scenarioId: base.id, ...SEG_DEFAULTS, horizonMonths: 120, makeInstrument: mk });
  return bandByHand(det.result.book);
}

/**
 * The banding restated here, not borrowed from the module under test (a check must not take its expected value
 * from the thing it checks): edges 0, 1, 3, 6, 12, 24, 36, 60, 120 months; SEG out(s) - out(e), beyond out(120);
 * EBP E(s) - E(e) with E(m) = ebp[m] below 120 and ebp[119] at 120, beyond ebp[119], month 1 ebp[0].
 */
function bandByHand(s: { segOutstanding: number[]; ebpAssets: number[]; ebpLiabilities: number[] }): GapPathValues {
  const edges = [0, 1, 3, 6, 12, 24, 36, 60, 120];
  const E = (ebp: number[], m: number) => ebp[m < 120 ? m : 119]!;
  const seg: number[] = [];
  const runOffA: number[] = [];
  const runOffL: number[] = [];
  for (let b = 0; b < 8; b++) {
    const [lo, hi] = [edges[b]!, edges[b + 1]!];
    seg.push(s.segOutstanding[lo]! - s.segOutstanding[hi]!);
    runOffA.push(E(s.ebpAssets, lo) - E(s.ebpAssets, hi));
    runOffL.push(E(s.ebpLiabilities, lo) - E(s.ebpLiabilities, hi));
  }
  return {
    seg,
    segBeyond: s.segOutstanding[120]!,
    runOffA,
    runOffL,
    beyondA: s.ebpAssets[119]!,
    beyondL: s.ebpLiabilities[119]!,
    month1A: s.ebpAssets[0]!,
    month1L: s.ebpLiabilities[0]!,
  };
}

function grossNotional(p: PortfolioSpec): number {
  return p.positions.reduce((s, x) => s + Math.abs(x.terms.notional), 0);
}

/** |x - ref| <= tol x max(|ref|, scale), on every path: min and max both sit at ref. */
function expectPointMass(d: StochasticDistribution, ref: number, scale: number, tol = 1e-9): void {
  const bound = tol * Math.max(Math.abs(ref), scale);
  expect(Math.abs(d.min - ref), `min ${d.min} vs ${ref}`).toBeLessThanOrEqual(bound);
  expect(Math.abs(d.max - ref), `max ${d.max} vs ${ref}`).toBeLessThanOrEqual(bound);
}

function sha(x: unknown): string {
  return createHash("sha256").update(JSON.stringify(x)).digest("hex");
}

function sum(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0);
}

describe("(a) zero-vol degeneracy", () => {
  it("every path's banded SEG and EBP equals the deterministic block on the base path, to 1e-9 relative", () => {
    const req = baseOnlyRequest();
    const book = twoSidedBook();
    const sto = runStochastic(req, book, { nPaths: 20, modelParams: ZERO, gap: GAP });
    const ref = deterministicBanded(req, book);
    const scale = grossNotional(book);
    const gap = sto.gap!;
    gap.repricing.bands.forEach((b, i) => expectPointMass(b.net, ref.seg[i]!, scale));
    expectPointMass(gap.repricing.beyondHorizon.net, ref.segBeyond, scale);
    gap.liquidity.bands.forEach((b, i) => {
      expectPointMass(b.runOff.assets, ref.runOffA[i]!, scale);
      expectPointMass(b.runOff.liabilities, ref.runOffL[i]!, scale);
      expectPointMass(b.runOff.net, ref.runOffA[i]! - ref.runOffL[i]!, scale);
    });
    expectPointMass(gap.liquidity.beyondHorizon.assets, ref.beyondA, scale);
    expectPointMass(gap.liquidity.beyondHorizon.liabilities, ref.beyondL, scale);
    expectPointMass(gap.liquidity.month1Balance.assets, ref.month1A, scale);
    expectPointMass(gap.liquidity.month1Balance.liabilities, ref.month1L, scale);
    // The book has bite: SEG and EBP are spread over several bands and both sides.
    expect(ref.seg.filter((x) => Math.abs(x) > 1).length).toBeGreaterThan(3);
    expect(ref.month1L).toBeGreaterThan(0);
  });
});

describe("(b) seed determinism", () => {
  it("same seed gives a byte-identical envelope; a different seed gives a different gap", () => {
    const r1 = runStochastic(baseOnlyRequest({ seed: "42" }), twoSidedBook(), { nPaths: 20, modelParams: VOL, gap: GAP });
    const r2 = runStochastic(baseOnlyRequest({ seed: "42" }), twoSidedBook(), { nPaths: 20, modelParams: VOL, gap: GAP });
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
    const r3 = runStochastic(baseOnlyRequest({ seed: "43" }), twoSidedBook(), { nPaths: 20, modelParams: VOL, gap: GAP });
    expect(sha(r3.gap)).not.toBe(sha(r1.gap));
    // The difference is numeric and real dispersion exists at sigma > 0.
    const moved = r1.gap!.repricing.bands.some((b, i) => b.net.mean !== r3.gap!.repricing.bands[i]!.net.mean);
    expect(moved).toBe(true);
    expect(r1.gap!.repricing.bands.some((b) => b.net.stdev > 0)).toBe(true);
  });
});

describe("(c) fold-and-drop equals keep-all", () => {
  it("the gap block from dropping each path's rows hashes equal to the one keeping every block and folding after", () => {
    const req = baseOnlyRequest();
    const portfolio = twoSidedBook();
    let env: StochasticEnvironment | undefined;
    const sto = runStochastic(req, portfolio, { nPaths: 20, modelParams: VOL, gap: GAP, onEnvironment: (e) => (env = e) });
    const { book, mk } = entryInputs(req, portfolio);
    const input = { book, paths: env!.paths, scenarioId: req.scenarios[0]!.id, makeInstrument: mk };
    const kept = computeStochasticGap(input, "keep-all");
    const dropped = computeStochasticGap(input, "fold-and-drop");
    expect(sha(dropped)).toBe(sha(sto.gap));
    expect(sha(kept)).toBe(sha(sto.gap));
  });
});

describe("(d) absent option", () => {
  it("the envelope without gap is byte-identical whether the key is omitted or undefined, at 0.3.0", () => {
    const a = runStochastic(baseOnlyRequest(), twoSidedBook(), { nPaths: 20, modelParams: VOL });
    const b = runStochastic(baseOnlyRequest(), twoSidedBook(), { nPaths: 20, modelParams: VOL, gap: undefined });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.schemaVersion).toBe("0.3.0");
    expect(JSON.stringify(a)).not.toContain('"gap"');
  });
});

describe("identities (ruling 7)", () => {
  it("per path: run-off bands plus beyondHorizon equal the month-1 EBP balance by side; SEG bands plus beyond equal out(0)", () => {
    const req = baseOnlyRequest();
    const portfolio = twoSidedBook();
    let env: StochasticEnvironment | undefined;
    const sto = runStochastic(req, portfolio, { nPaths: 20, modelParams: VOL, gap: GAP, onEnvironment: (e) => (env = e) });
    const { book, mk } = entryInputs(req, portfolio);
    const scale = grossNotional(portfolio);
    for (const p of [0, 1, 7, 19]) {
      const blk = computeSegBlock({ book, basePath: env!.paths[p]!, scenarioId: "S0", ...SEG_DEFAULTS, horizonMonths: 120, makeInstrument: mk });
      const v = bandSegResult(blk.result);
      expect(Math.abs(sum(v.runOffA) + v.beyondA - v.month1A)).toBeLessThanOrEqual(1e-9 * scale);
      expect(Math.abs(sum(v.runOffL) + v.beyondL - v.month1L)).toBeLessThanOrEqual(1e-9 * scale);
      expect(Math.abs(sum(v.seg) + v.segBeyond - blk.result.book.segOutstanding[0]!)).toBeLessThanOrEqual(1e-9 * scale);
    }
    // And of the envelope's means (the statistics are linear in the path values).
    const g = sto.gap!;
    for (const side of ["assets", "liabilities", "net"] as const) {
      const total = sum(g.liquidity.bands.map((b) => b.runOff[side].mean)) + g.liquidity.beyondHorizon[side].mean;
      expect(Math.abs(total - g.liquidity.month1Balance[side].mean)).toBeLessThanOrEqual(1e-9 * scale);
      // The last cumulative band plus beyond is the month-1 balance too, path by path.
      const lastCum = g.liquidity.bands[g.liquidity.bands.length - 1]!.cumulative[side];
      expect(Math.abs(lastCum.mean + g.liquidity.beyondHorizon[side].mean - g.liquidity.month1Balance[side].mean)).toBeLessThanOrEqual(1e-9 * scale);
    }
    // Signed net notional the block covers: assets F1 + M1 = 9M, liabilities D1 + B1 = 5M.
    const segTotal = sum(g.repricing.bands.map((b) => b.net.mean)) + g.repricing.beyondHorizon.net.mean;
    expect(Math.abs(segTotal - 4_000_000)).toBeLessThanOrEqual(1e-9 * scale);
  });
});

describe("each path re-shocked around its own rates", () => {
  it("the envelope's per-band min, max and mean equal every path banded by hand from computeSegBlock on env.paths[p]", () => {
    const req = baseOnlyRequest();
    const portfolio = twoSidedBook();
    let env: StochasticEnvironment | undefined;
    const sto = runStochastic(req, portfolio, { nPaths: 20, modelParams: VOL, gap: GAP, onEnvironment: (e) => (env = e) });
    const { book, mk } = entryInputs(req, portfolio);
    const scale = grossNotional(portfolio);
    const perPath = env!.paths.map((path) => {
      const blk = computeSegBlock({ book, basePath: path, scenarioId: req.scenarios[0]!.id, ...SEG_DEFAULTS, horizonMonths: 120, makeInstrument: mk });
      return bandByHand(blk.result.book);
    });
    expect(perPath.length).toBe(20);
    const stats = (xs: number[]) => ({ min: Math.min(...xs), max: Math.max(...xs), mean: sum(xs) / xs.length });
    const expectStats = (d: StochasticDistribution, xs: number[], what: string) => {
      const h = stats(xs);
      const bound = 1e-9 * scale;
      expect(Math.abs(d.min - h.min), `${what} min ${d.min} vs ${h.min}`).toBeLessThanOrEqual(bound);
      expect(Math.abs(d.max - h.max), `${what} max ${d.max} vs ${h.max}`).toBeLessThanOrEqual(bound);
      expect(Math.abs(d.mean - h.mean), `${what} mean ${d.mean} vs ${h.mean}`).toBeLessThanOrEqual(bound);
    };
    const g = sto.gap!;
    g.repricing.bands.forEach((b, i) => expectStats(b.net, perPath.map((v) => v.seg[i]!), `SEG ${b.label}`));
    expectStats(g.repricing.beyondHorizon.net, perPath.map((v) => v.segBeyond), "SEG beyond");
    g.liquidity.bands.forEach((b, i) => {
      expectStats(b.runOff.assets, perPath.map((v) => v.runOffA[i]!), `EBP ${b.label} assets`);
      expectStats(b.runOff.liabilities, perPath.map((v) => v.runOffL[i]!), `EBP ${b.label} liabilities`);
      expectStats(b.runOff.net, perPath.map((v) => v.runOffA[i]! - v.runOffL[i]!), `EBP ${b.label} net`);
    });
    expectStats(g.liquidity.beyondHorizon.assets, perPath.map((v) => v.beyondA), "EBP beyond assets");
    expectStats(g.liquidity.beyondHorizon.liabilities, perPath.map((v) => v.beyondL), "EBP beyond liabilities");
    expectStats(g.liquidity.month1Balance.liabilities, perPath.map((v) => v.month1L), "EBP month 1 liabilities");
    // The check has bite: the hand values differ across paths in several SEG bands, so one path's rates read for
    // every path would collapse min and max together and fail.
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(perPath[0]!.seg.filter((_, i) => spread(perPath.map((v) => v.seg[i]!)) > 1e-6 * scale).length).toBeGreaterThan(1);
  });
});

describe("an uncovered position (CD)", () => {
  const noBindings: AssumptionSet = { schemaVersion: "1.0.0", id: "AS-BASE", label: "No bindings", bindings: [] };

  it("is carried in uncovered with its reason and counted, and enters no gap figure", () => {
    const withCd = segBook([fixedLoan("fixed"), cdPosition("cd-1")]);
    const without = segBook([fixedLoan("fixed")]);
    const req = baseOnlyRequest({ portfolioId: withCd.id, assumptionSets: [noBindings] });
    const a = runStochastic(req, withCd, { nPaths: 20, modelParams: VOL, gap: GAP }).gap!;
    const b = runStochastic(req, without, { nPaths: 20, modelParams: VOL, gap: GAP }).gap!;
    expect(a.uncoveredCount).toBe(1);
    expect(a.uncovered).toEqual([{ positionId: "cd-1", reason: "no replacement vintage for cd (kernel rule)" }]);
    expect(b.uncoveredCount).toBe(0);
    const figures = (g: StochasticGapBlock) => JSON.stringify({ r: g.repricing, l: g.liquidity });
    expect(figures(a)).toBe(figures(b));
  });
});

describe("hand-checkable: one fixed bullet at sigma 0", () => {
  it("a 1M, 60-month 4% bullet reprices and runs off 1M in 3-5Y, nothing elsewhere, nothing beyond", () => {
    const bullet: PortfolioSpec = {
      id: "PF-BULLET",
      label: "Single fixed bullet",
      asOf: AS_OF,
      coa: makeCoa(),
      positions: [fixedPosition("Z1", { notional: 1_000_000, coupon: 0.04, maturityMonths: 60, amortType: "bullet" })],
    };
    const req = baseOnlyRequest({ portfolioId: bullet.id });
    const g = runStochastic(req, bullet, { nPaths: 20, modelParams: ZERO, gap: GAP }).gap!;
    const N = 1_000_000;
    const tol = 1e-6;
    // By hand: outstanding SEG is +N for t = 0..59 and 0 from t = 60, so band [36, 60) carries out(36) - out(60) = N.
    // EBP is N in months 1..60 and 0 after, so E(36) - E(60) = N in 3-5Y; month-1 balance N; nothing beyond month 120.
    const expected = [0, 0, 0, 0, 0, 0, N, 0];
    const cumulative = [0, 0, 0, 0, 0, 0, N, N];
    expect(STOCHASTIC_GAP_BANDS.map((b) => b.label)[6]).toBe("3-5Y");
    g.repricing.bands.forEach((b, i) => {
      expectPointMass(b.net, expected[i]!, 1, tol);
      expectPointMass(b.cumulative, cumulative[i]!, 1, tol);
    });
    expectPointMass(g.repricing.beyondHorizon.net, 0, 1, tol);
    g.liquidity.bands.forEach((b, i) => {
      expectPointMass(b.runOff.assets, expected[i]!, 1, tol);
      expectPointMass(b.runOff.liabilities, 0, 1, tol);
      expectPointMass(b.runOff.net, expected[i]!, 1, tol);
      expectPointMass(b.cumulative.net, cumulative[i]!, 1, tol);
    });
    expectPointMass(g.liquidity.beyondHorizon.net, 0, 1, tol);
    expectPointMass(g.liquidity.month1Balance.assets, N, 1, tol);
    expectPointMass(g.liquidity.month1Balance.liabilities, 0, 1, tol);
    // A point mass: dispersion and standard error at roundoff of the mean (1e-12 of N), N carried.
    expect(g.repricing.bands[6]!.net.stdev).toBeLessThan(1e-12 * N);
    expect(g.repricing.bands[6]!.net.standardError).toBeLessThan(1e-12 * N);
    expect(g.repricing.bands[6]!.net.nPaths).toBe(20);
  });
});
