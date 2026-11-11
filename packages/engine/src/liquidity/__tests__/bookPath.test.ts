/**
 * The stated or built liquidity path and the commitment dials, on synthetic round numbers.
 * Every expected value is worked by hand in the comment beside it, never read back from the module under test.
 */
import { describe, expect, it } from "vitest";
import { blendedDepositRate, bookPathConfigError, computeBookPathLiquidity, type BookPathInput, type BookPathPoint } from "../bookPath";
import { commitmentDialsError, computeCommitmentDials } from "../commitmentDials";
import { computeLiquidityStress } from "../stressLadder";

const M = 1_000_000;

/** A stated path, USD: cumulative net funding at a week and three month-ends, against an 800M buffer. */
const STATED: BookPathInput = {
  source: {
    kind: "stated",
    points: [
      { label: "Day 1-7", days: 7, cumulative: -200 * M },
      { label: "Month 1", month: 1, cumulative: -500 * M },
      { label: "Month 3", month: 3, cumulative: -900 * M },
      { label: "Month 6", month: 6, cumulative: -1_100 * M },
    ],
  },
  buffer: { hqla: 600 * M, receivedFacilities: 200 * M, receivedHaircut: 0 },
};

describe("a stated path", () => {
  const r = computeBookPathLiquidity(STATED);

  it("reads the buffer, the net positions and the coverage ratios", () => {
    // Buffer 600 + 200 = 800; net = 800 + cumulative; coverage = 800 / outflow.
    expect(r.buffer).toBe(800 * M);
    expect(r.rows.map((x) => Math.round(x.netPosition / M))).toEqual([600, 300, -100, -300]);
    expect(r.rows.map((x) => Number(x.coverageRatio!.toFixed(3)))).toEqual([4, 1.6, 0.889, 0.727]);
  });

  it("puts the first-week bucket at seven days and the peak at month 6, 300M beyond the buffer", () => {
    expect(r.firstWeek?.label).toBe("Day 1-7");
    expect(r.firstWeek?.month).toBeCloseTo(7 / (365 / 12), 12);
    expect(r.peakLabel).toBe("Month 6");
    expect(r.peakShortfall).toBe(-1_100 * M);
    expect(r.termFundingNeed).toBeCloseTo(300 * M, 3);
  });

  it("crosses the buffer between months 1 and 3 and survives two full months", () => {
    // 1 + 2 x 300 / (900 - 500) = 2.5: the bucket spread evenly.
    expect(r.crossingMonth!).toBeCloseTo(2.5, 12);
    expect(r.fullMonthsSurvived).toBe(2);
  });
});

describe("the draw overlay and the received-facility haircut", () => {
  const monthEnds: BookPathInput = { ...STATED, source: { kind: "stated", points: (STATED.source as { points: BookPathPoint[] }).points.slice(1) } };
  const draw = { amount: 100 * M, cumulativeShare: [0.5, 0.75, 1] };
  const haircut = { ...monthEnds.buffer, receivedHaircut: 0.5 };

  it("adds the phased draw to the path: 50M, 75M and 100M", () => {
    const r = computeBookPathLiquidity({ ...monthEnds, draw });
    expect(r.rows.map((x) => x.draw / M)).toEqual([50, 75, 100]);
    expect(r.rows.map((x) => x.cumulative / M)).toEqual([-550, -975, -1_200]);
  });

  it("counts the received facilities at half and leaves HQLA whole", () => {
    const r = computeBookPathLiquidity({ ...monthEnds, buffer: haircut });
    // 600 + 200 x 0.5.
    expect(r.buffer).toBe(700 * M);
    expect(r.receivedCounted).toBe(100 * M);
  });

  it("moves the crossing earlier with a haircut and with a draw", () => {
    const crossing = (input: BookPathInput) => computeBookPathLiquidity(input).crossingMonth!;
    // Haircut: net 200 at month 1, -200 at month 3: 1 + 2 x 200 / 400 = 2.
    expect(crossing({ ...monthEnds, buffer: haircut })).toBeCloseTo(2, 12);
    // Draw: net 250 at month 1, -175 at month 3: 1 + 2 x 250 / 425.
    expect(crossing({ ...monthEnds, draw })).toBeCloseTo(1 + (2 * 250) / 425, 12);
  });
});

describe("a built path", () => {
  it("forms the whole-book rate from the split", () => {
    // 0.5 x 1% + 0.5 x 9% = 5%.
    expect(blendedDepositRate(0.5, 0.01, 0.09)).toBeCloseTo(0.05, 15);
    expect(blendedDepositRate(1, 0.01, 0.09)).toBeCloseTo(0.01, 15);
  });

  it("builds deposit and wholesale outflow less inflow, month by month", () => {
    const r = computeBookPathLiquidity({
      source: {
        kind: "built",
        horizonMonths: 2,
        inflowCumulative: [100 * M, 150 * M],
        deposits: { balance: 1_000 * M, stableShare: 0, stableRateMonthly: 0, nonStableRateMonthly: 0.05 },
        wholesale: { balance: 300 * M, cumulativeShare: [1, 1] },
      },
      buffer: { hqla: 400 * M, receivedFacilities: 0, receivedHaircut: 0 },
    });
    // Month 1: 1,000 x 5% of deposits and the 300M wholesale book out, 100M in: gross 350, cumulative -250.
    expect(r.built!.grossOutflow[0]).toBeCloseTo(350 * M, 3);
    expect(r.rows[0]!.cumulative).toBeCloseTo(-250 * M, 3);
    // Two months of runoff at 5%: 1,000 x (1 - 0.95^2) = 97.5.
    expect(r.built!.depositOutflow[1]).toBeCloseTo(97.5 * M, 3);
    expect(r.rows.map((x) => x.label)).toEqual(["Month 1", "Month 2"]);
  });

  it("reports no crossing and no term-funding need when the buffer holds", () => {
    const r = computeBookPathLiquidity({
      source: { kind: "stated", points: [{ label: "Month 1", month: 1, cumulative: -100 * M }, { label: "Month 2", month: 2, cumulative: 50 * M }] },
      buffer: { hqla: 200 * M, receivedFacilities: 0, receivedHaircut: 0 },
    });
    expect(r.crossingMonth).toBeNull();
    expect(r.fullMonthsSurvived).toBeNull();
    expect(r.termFundingNeed).toBe(0);
    expect(r.rows[1]!.coverageRatio).toBeNull();
    expect(r.firstWeek).toBeNull();
  });
});

describe("input checks name the field", () => {
  it("refuses points out of time order, a point with both month and days, and a falling draw share", () => {
    const pts = (STATED.source as { points: unknown[] }).points;
    expect(bookPathConfigError({ ...STATED, source: { kind: "stated", points: [pts[1], pts[0]] } })).toMatch(/points\[1\] .*time order/);
    expect(bookPathConfigError({ ...STATED, source: { kind: "stated", points: [{ label: "x", month: 1, days: 7, cumulative: 0 }] } })).toMatch(/exactly one/);
    expect(bookPathConfigError({ ...STATED, draw: { amount: 1, cumulativeShare: [0.5, 0.4, 0.6, 1] } })).toMatch(/draw\.cumulativeShare\[1\].*never falls/);
    expect(bookPathConfigError({ ...STATED, draw: { amount: 1, cumulativeShare: [1] } })).toMatch(/must list 4 shares, one per point/);
    expect(bookPathConfigError({ ...STATED, buffer: { ...STATED.buffer, receivedHaircut: 1.5 } })).toMatch(/receivedHaircut must be a decimal/);
    expect(bookPathConfigError(STATED)).toBeUndefined();
    expect(() => computeBookPathLiquidity({ ...STATED, buffer: { ...STATED.buffer, hqla: -1 } })).toThrow(/book path: buffer\.hqla/);
  });
});

describe("the commitment dials", () => {
  const dials = {
    face: 400 * M,
    expectedUtilization: 0.4,
    tailUtilization: 0.7,
    fundingSpreadBp: 20,
    lcrFactor: 0.1,
    thirtyDayShare: 0.5,
    delayedDraws: [2, 5].map((month) => ({ month, amount: 40 * M })),
  };
  const r = computeCommitmentDials(dials);

  it("gives 160M drawn, 240M undrawn, 280M in the tail and a 120M buffer requirement", () => {
    // 400 x 0.4; 400 - 160; 400 x 0.7; (0.7 - 0.4) x 400.
    expect(r.expectedDrawn).toBeCloseTo(160 * M, 3);
    expect(r.undrawn).toBeCloseTo(240 * M, 3);
    expect(r.tailDrawn).toBeCloseTo(280 * M, 3);
    expect(r.bufferRequirement).toBeCloseTo(120 * M, 3);
    expect(r.bufferRequirementShareOfFace).toBeCloseTo(0.3, 12);
  });

  it("prices the contingent leg at 120 / 240 x 20bp = 10bp, 0.24M a year on the undrawn line", () => {
    expect(r.contingentChargeBp).toBeCloseTo(10, 10);
    expect(r.contingentChargeAnnual).toBeCloseTo(0.24 * M, 3);
  });

  it("shows the reference outflow of 24M beside the internal 30-day 60M, 2.5 times and a quarter of the undrawn line", () => {
    // 0.1 x 240; 0.5 x 120; 60 / 24; 60 / 240.
    expect(r.lcrReferenceOutflow).toBeCloseTo(24 * M, 3);
    expect(r.internalThirtyDayDraw).toBeCloseTo(60 * M, 3);
    expect(r.internalOverLcr!).toBeCloseTo(2.5, 12);
    expect(r.internalShareOfUndrawn!).toBeCloseTo(0.25, 12);
    expect(r.delayedDrawTotal).toBe(80 * M);
  });

  it("refuses a tail below the expectation", () => {
    expect(commitmentDialsError({ ...dials, tailUtilization: 0.3 })).toMatch(/tailUtilization 0.3 is below the expected 0.4/);
  });
});

describe("the stress ladder does not move", () => {
  it("still computes a ladder with no book-path field anywhere in its input", () => {
    const ladder = computeLiquidityStress({
      book: { id: "b", label: "b", asOf: "2026-03-31", coa: { schemaVersion: "1.0.0", nodes: [], families: [] }, positions: [] },
      principalByPosition: new Map(),
      table: {
        bau: { hysOutflowMonthly: 0, wholesaleRenewal: 1, nibOutflowMonthly: 0, drawRate: 0 },
        moderate: { hysOutflowMonthly: 0, wholesaleRenewal: 1, nibOutflowMonthly: 0, drawRate: 0 },
        severe: { hysOutflowMonthly: 0, wholesaleRenewal: 1, nibOutflowMonthly: 0, drawRate: 0.3 },
      },
      buffer: 100,
      undrawnFace: 1200,
      horizonMonths: 12,
    });
    expect(ladder.scenarios[2]!.draws.every((d) => d === 30)).toBe(true);
  });
});
