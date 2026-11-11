/**
 * Run-pipeline seasoning: the D3a gate LIFT (per W2-A3 NOTE 1) and
 * the chunk.ts step.
 *
 * RE-EXPECTATION: W2-A3 shipped this
 * file asserting the run pipeline REFUSES every nonzero originationOffsetMonths
 * (NotImplementedError, layer "run.seasoning"), because the effective-duration
 * engine was not offset-aware. That was the gate this wave lifts — the duration
 * engine now re-anchors seasoned streams (drop elapsed, shift the rest,
 * remaining-maturity reuse guard) and the sharded static pass applies the same
 * bucket shift as the aggregator, the two changes W2-A3 required as one unit.
 * The old refusal expectations are therefore inverted BY DESIGN:
 *
 *  - a seasoned fixed-loan ACCUMULATES, shifted by exactly its offset;
 *  - a full run over a seasoned book COMPLETES, and its NII / EVE / gap /
 *    cashflow blocks are identical to a fresh-twin book whose bullet carries
 *    the seasoned position's remaining terms (the degeneracy anchor: a
 *    seasoned 24M bullet at -6 IS an 18M bullet, stream for stream);
 *  - malformed and type-unsupported offsets still refuse typed
 *    (SeasoningError) — validation did not lift, only the blanket gate;
 *  - FTP is the one consumer still refusing: a seasoned book's envelope
 *    omits the ftp block and carries the typed "ftp.seasoned-book" register
 *    tag instead (nothing fakes a number; the FTP module par-matches full
 *    original streams in instrument time and is not yet offset-aware).
 *
 * The W1-H3 NMD-B beta-split test is retained unchanged.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  BETA_S_CURVE_DEFAULTS,
  betaAtRate,
  type MarketSnapshot,
} from "@alm/kernel";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import type { Position } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import { SeasoningError } from "../../portfolio/seasoning";
import { clearPortfolios } from "../../portfolio/registry";
import { accumulateChunk, allocMasterSink } from "../shard/chunk";
import { createEngine } from "../index";
import {
  fixedPosition,
  loadMarket,
  makeRunRequest,
  nmdBetaPosition,
  nmdPosition,
  twoSidedBook,
} from "./fixtures";

const HORIZON = 360;
const RATE = 0.04;
const path = new ConstantRatePath(RATE, HORIZON);

function runChunk(positions: Position[], familyIds: string[]) {
  const cellIndex = new Int32Array(positions.length);
  for (let p = 0; p < positions.length; p++) cellIndex[p] = familyIds.indexOf(positions[p]!.familyId);
  const sink = allocMasterSink(familyIds.length, HORIZON);
  accumulateChunk(positions, 0, positions.length, cellIndex, path, HORIZON, sink);
  return sink;
}

describe("static pass — the seasoning re-anchor is LIVE (gate lifted)", () => {
  it("a seasoned 24M bullet at -6 lands its principal at bucket 17, coupons in buckets 0..17", () => {
    const notional = 1_000_000;
    const coupon = 0.05;
    const pos = fixedPosition("F-SEASONED", {
      notional, coupon, maturityMonths: 24, amortType: "bullet", originationOffsetMonths: -6,
    });
    const sink = runChunk([pos], ["FIXED"]);
    // Principal: single repayment at instrument month 24 -> bucket 24 - 1 - 6 = 17.
    expect(sink.principal[0][17]).toBe(notional);
    for (let k = 0; k < HORIZON; k++) {
      if (k !== 17) expect(sink.principal[0][k]).toBe(0);
    }
    // Interest: remaining months only (instrument months 7..24 -> buckets 0..17),
    // the elapsed 6 coupon months dropped.
    for (let k = 0; k <= 17; k++) expect(sink.interest[0][k]).toBe((notional * coupon) / 12);
    expect(sink.interest[0][18]).toBe(0);
    // The gap fold shifted identically (both series honor the same offset).
    expect(sink.gapPrincipal[0][17]).toBe(notional);
  });

  it("shift identity: seasoned bucket j carries the same doubles as the fresh comparator's bucket j (remaining terms)", () => {
    const seasoned = runChunk(
      [fixedPosition("F-S", { notional: 800_000, coupon: 0.05, maturityMonths: 24, amortType: "bullet", originationOffsetMonths: -6 })],
      ["FIXED"],
    );
    const freshTwin = runChunk(
      [fixedPosition("F-T", { notional: 800_000, coupon: 0.05, maturityMonths: 18, amortType: "bullet" })],
      ["FIXED"],
    );
    for (let k = 0; k < HORIZON; k++) {
      expect(seasoned.balance[0][k]).toBe(freshTwin.balance[0][k]);
      expect(seasoned.principal[0][k]).toBe(freshTwin.principal[0][k]);
      expect(seasoned.interest[0][k]).toBe(freshTwin.interest[0][k]);
      expect(seasoned.repricing[0][k]).toBe(freshTwin.repricing[0][k]);
      expect(seasoned.gapPrincipal[0][k]).toBe(freshTwin.gapPrincipal[0][k]);
    }
  });

  it("an offset-0 book accumulates exactly as before the lift (adding a literal 0)", () => {
    const pos = fixedPosition("F1", { notional: 1_000_000, maturityMonths: 24, amortType: "bullet" });
    const sink = runChunk([pos], ["FIXED"]);
    expect(sink.principal[0][23]).toBe(1_000_000);
    expect(sink.gapPrincipal[0][23]).toBe(1_000_000);
  });

  it("still refuses malformed and type-unsupported offsets typed (validation did not lift)", () => {
    expect(() =>
      runChunk([fixedPosition("F-FWD", { originationOffsetMonths: 3 })], ["FIXED"]),
    ).toThrow(SeasoningError);
    expect(() =>
      runChunk([nmdPosition("D-S", { originationOffsetMonths: -6 })], ["DDA"]),
    ).toThrow(SeasoningError);
    expect(() =>
      runChunk([fixedPosition("F-NAN", { originationOffsetMonths: NaN })], ["FIXED"]),
    ).toThrow(SeasoningError);
  });
});

describe("run pipeline — NMD-B beta split live via the W1-H3 step", () => {
  it("accumulateChunk books the beta slice in bucket 0 and (1 - beta) at runoff", () => {
    const pos = nmdBetaPosition("B1", { notional: 2_000_000, maturityMonths: 120 });
    const sink = runChunk([pos], ["MMA"]);

    const beta = betaAtRate(RATE * 100, BETA_S_CURVE_DEFAULTS);
    expect(beta).toBeGreaterThan(0);
    expect(beta).toBeLessThan(1);

    const runoff = sink.gapPrincipal[0];
    const repr = sink.repricing[0];
    let runoffTotal = 0;
    for (let k = 0; k < HORIZON; k++) runoffTotal += runoff[k];

    // Independent expectation from the kernel beta and the accumulated runoff.
    expect(repr[0]).toBeCloseTo(beta * runoffTotal + (1 - beta) * runoff[0], 6);
    for (let k = 1; k < HORIZON; k++) {
      expect(repr[k]).toBeCloseTo((1 - beta) * runoff[k], 6);
    }
  });
});

describe("engine run() — a seasoned book flows end to end (the lift, verified by degeneracy)", () => {
  let market: MarketSnapshot;
  beforeAll(async () => {
    market = await loadMarket();
  });

  function runBook(extra: Position): RunResult {
    clearPortfolios();
    const engine = createEngine();
    const book = twoSidedBook();
    book.positions.push(extra);
    engine.loadPortfolio(book);
    return engine.run(makeRunRequest(market));
  }

  it("a seasoned book completes and equals its fresh-twin book on every computed block", () => {
    // Degeneracy anchor: a seasoned 24M bullet observed at -6 IS an 18M bullet
    // — same remaining stream, double for double. So the seasoned run and the
    // fresh-twin run must agree EXACTLY on NII, EVE (including durations), gap
    // ladders, cashflows, and attribution. The anchor is independent of the
    // lift's own arithmetic: the twin never exercises the re-anchor path.
    const seasoned = runBook(
      fixedPosition("FX", { notional: 1_500_000, coupon: 0.05, maturityMonths: 24, amortType: "bullet", originationOffsetMonths: -6 }),
    );
    const twin = runBook(
      fixedPosition("FX", { notional: 1_500_000, coupon: 0.05, maturityMonths: 18, amortType: "bullet" }),
    );

    expect(seasoned.nii).toEqual(twin.nii);
    expect(seasoned.eve).toEqual(twin.eve);
    expect(seasoned.gap).toEqual(twin.gap);
    expect(seasoned.cashflows).toEqual(twin.cashflows);
    expect(seasoned.attribution).toEqual(twin.attribution);

    // The duration block is PRESENT — the wrong-duration hole the gate
    // protected is closed, not bypassed.
    const base = seasoned.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(base.effectiveDurationEquity).toBeDefined();
    expect(Number.isFinite(base.effectiveDurationEquity!)).toBe(true);

    // Family WAL rides the same envelope and agrees between the two runs.
    const walSeasoned = seasoned.cashflows.byScenario[0].byFamily.find((f) => f.familyId === "FIXED")!.walYears;
    const walTwin = twin.cashflows.byScenario[0].byFamily.find((f) => f.familyId === "FIXED")!.walYears;
    expect(walSeasoned).toBeDefined();
    expect(walSeasoned).toBe(walTwin);
  });

  it("the seasoned run omits the ftp block with the typed ftp.seasoned-book tag; the twin carries ftp", () => {
    const seasoned = runBook(
      fixedPosition("FX", { notional: 1_500_000, coupon: 0.05, maturityMonths: 24, amortType: "bullet", originationOffsetMonths: -6 }),
    );
    const twin = runBook(
      fixedPosition("FX", { notional: 1_500_000, coupon: 0.05, maturityMonths: 18, amortType: "bullet" }),
    );

    expect(seasoned.ftp).toBeUndefined();
    const tags = seasoned.notImplemented.filter((t) => t.layer === "ftp.seasoned-book");
    expect(tags).toHaveLength(1);
    expect(tags[0].reason).toContain("FX");
    expect(tags[0]._tag).toBe("not-implemented");

    expect(twin.ftp).toBeDefined();
    expect(twin.notImplemented.filter((t) => t.layer === "ftp.seasoned-book")).toHaveLength(0);
  });

  it("a malformed offset still refuses the whole run typed (SeasoningError)", () => {
    clearPortfolios();
    const engine = createEngine();
    const book = twoSidedBook();
    book.positions.push(fixedPosition("F-FWD", { originationOffsetMonths: 5 }));
    engine.loadPortfolio(book);
    expect(() => engine.run(makeRunRequest(market))).toThrow(SeasoningError);
  });

  it("an unseasoned book's envelope carries no seasoning-related tag (offset-0 continuity)", () => {
    clearPortfolios();
    const engine = createEngine();
    engine.loadPortfolio(twoSidedBook());
    const result = engine.run(makeRunRequest(market));
    expect(result.notImplemented).toEqual([]);
    expect(result.ftp).toBeDefined();
  });
});
