/**
 * Commitments in both LCR readings.
 *
 * The three things pinned here are the three that can go silently wrong:
 * a draw must never enter the INFLOW arm (it is asset-side, and a draw is a
 * negative principal, so the ratio would come out roughly right by accident);
 * the scenario arm reads the FLOWS; the regulatory arm reads the BOOK, which
 * makes its commitment outflow scenario-invariant.
 */
import { describe, expect, it } from "vitest";
import { computeLcrRegulatory, computeLcrScenario, LCR_KEYS } from "../lcr";
import type { CustomMetricInput } from "../../plugins/services";

// Minimal book: one L1 buffer family, one deposit family, one commitment family.
function makeInput(opts: {
  withCommitments: boolean;
  drawMonth1: number;
  commitNotional: number;
  category?: string;
}): CustomMetricInput {
  const families = [
    { id: "ust", label: "Treasuries", side: "asset", instrumentType: "fixed-loan", coaNodeId: "a.sec" },
    { id: "dda", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "l.dep" },
    ...(opts.withCommitments
      ? [{ id: "commit", label: "Committed lines", side: "asset", instrumentType: "commitment", coaNodeId: "a.obs" }]
      : []),
  ];
  const positions = [
    { id: "ust-1", familyId: "ust", coaNodeId: "a.sec", terms: { id: "ust-1", type: "fixed-loan", notional: 1_000_000, maturityMonths: 60, originationOffsetMonths: 0, amortType: "bullet", side: "asset", couponRate: 0.03 }, dimensions: { "hqla-level": "l1" } },
    { id: "dda-1", familyId: "dda", coaNodeId: "l.dep", terms: { id: "dda-1", type: "nmd", notional: 500_000, maturityMonths: 360, originationOffsetMonths: 0, amortType: "bullet", side: "liability" }, dimensions: { "lcr-category": "retail-stable" } },
    ...(opts.withCommitments
      ? [{ id: "commit-1", familyId: "commit", coaNodeId: "a.obs", terms: { id: "commit-1", type: "commitment", notional: opts.commitNotional, maturityMonths: 36, originationOffsetMonths: 0, amortType: "bullet", side: "asset", draw: { rampRates: [], steadyRate: 0 } }, dimensions: { "commitment-category": opts.category ?? "credit-nonfinancial" } }]
      : []),
  ];
  const byFamily = [
    { familyId: "ust", series: { principal: [0, 0], interest: [2_500, 2_500], balance: [1_000_000, 1_000_000] } },
    { familyId: "dda", series: { principal: [10_000, 10_000], interest: [200, 200], balance: [500_000, 490_000] } },
    ...(opts.withCommitments
      ? [{ familyId: "commit", series: { principal: [-opts.drawMonth1, 0], interest: [0, 0], balance: [opts.commitNotional, opts.commitNotional - opts.drawMonth1] } }]
      : []),
  ];
  return {
    horizonMonths: 12,
    baseScenarioId: "S0",
    scenarios: [{ scenarioId: "S0", assumptionSetId: "a1", cashflows: { byFamily } as never }],
    book: { id: "bk", label: "bk", asOf: "2026-01-31", coa: { families }, positions } as never,
  } as unknown as CustomMetricInput;
}

describe("LCR with commitments", () => {
  it("declares the commitment-draws key", () => {
    expect(LCR_KEYS.map((k) => k.id)).toContain("commitment-draws");
  });

  it("omits commitment-draws entirely for a book with no commitments", () => {
    const row = computeLcrScenario(makeInput({ withCommitments: false, drawMonth1: 0, commitNotional: 0 }))
      .byScenario[0]!;
    expect(row.values).not.toHaveProperty("commitment-draws");
  });

  it("scenario: a draw RAISES outflows", () => {
    const none = computeLcrScenario(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000 })).byScenario[0]!.values;
    const drawn = computeLcrScenario(makeInput({ withCommitments: true, drawMonth1: 1_400_000, commitNotional: 4_000_000 })).byScenario[0]!.values;
    expect(drawn["outflows-30d"]!).toBeGreaterThan(none["outflows-30d"]!);
    expect(drawn["commitment-draws"]).toBeCloseTo(1_400_000, 6);
  });

  it("scenario: a draw LOWERS the LCR, and the direction is the whole point", () => {
    const none = computeLcrScenario(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000 })).byScenario[0]!.values;
    const drawn = computeLcrScenario(makeInput({ withCommitments: true, drawMonth1: 1_400_000, commitNotional: 4_000_000 })).byScenario[0]!.values;
    expect(drawn.lcr!).toBeLessThan(none.lcr!);
  });

  it("a draw NEVER enters the inflow arm", () => {
    const none = computeLcrScenario(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000 })).byScenario[0]!.values;
    const drawn = computeLcrScenario(makeInput({ withCommitments: true, drawMonth1: 1_400_000, commitNotional: 4_000_000 })).byScenario[0]!.values;
    expect(drawn["inflows-30d"]).toBeCloseTo(none["inflows-30d"]!, 6);
  });

  it("regulatory: rate times undrawn, read from the BOOK", () => {
    const v = computeLcrRegulatory(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000, category: "credit-nonfinancial" })).byScenario[0]!.values;
    expect(v["commitment-draws"]).toBeCloseTo(400_000, 6); // 0.10 * 4,000,000
  });

  it("regulatory: nonzero even when NO draw is projected", () => {
    const v = computeLcrRegulatory(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000 })).byScenario[0]!.values;
    expect(v["commitment-draws"]!).toBeGreaterThan(0);
  });

  it("regulatory: the heaviest bucket rates the whole line", () => {
    const v = computeLcrRegulatory(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000, category: "liquidity-financial" })).byScenario[0]!.values;
    expect(v["commitment-draws"]).toBeCloseTo(4_000_000, 6); // 1.00 * 4,000,000
  });

  it("regulatory: an unknown commitment category yields NO keys, never a zero", () => {
    const r = computeLcrRegulatory(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000, category: "not-a-category" })).byScenario[0]!;
    expect(r.values).toEqual({});
  });

  it("regulatory: the commitment outflow is scenario-invariant for a given book", () => {
    const a = computeLcrRegulatory(makeInput({ withCommitments: true, drawMonth1: 0, commitNotional: 4_000_000 })).byScenario[0]!.values;
    const b = computeLcrRegulatory(makeInput({ withCommitments: true, drawMonth1: 1_400_000, commitNotional: 4_000_000 })).byScenario[0]!.values;
    expect(b["commitment-draws"]).toBeCloseTo(a["commitment-draws"]!, 6);
  });
});

/**
 * The DECLARED ENVELOPE, which varies with the book.
 *
 * Both id lists are restated BY HAND rather than mapped off `LCR_KEYS`: a check
 * that took its expected value from the constant it checks could not fail on a
 * reorder or an extra key, which is the whole point of pinning an envelope.
 * Exact equality, never `toContain`, for the same reason.
 *
 * The five-key case is covered here and not only by `lcr.test.ts:102`, because
 * that assertion predates the dynamic envelope and the envelope was built to
 * satisfy it; it cannot independently falsify it.
 */
const FIVE = ["hqla", "outflows-30d", "inflows-30d", "net-outflows", "lcr"];
const SIX = ["hqla", "outflows-30d", "inflows-30d", "net-outflows", "commitment-draws", "lcr"];

const WITH = { withCommitments: true, drawMonth1: 1_400_000, commitNotional: 4_000_000 };
const WITHOUT = { withCommitments: false, drawMonth1: 0, commitNotional: 0 };

describe("the declared key envelope", () => {
  it("declares all six ids, in order, for a book WITH a commitment family", () => {
    for (const fn of [computeLcrScenario, computeLcrRegulatory]) {
      expect(fn(makeInput(WITH)).keys.map((k) => k.id)).toEqual(SIX);
    }
  });

  it("declares exactly the five pre-commitment ids for a book WITHOUT one", () => {
    for (const fn of [computeLcrScenario, computeLcrRegulatory]) {
      const ids = fn(makeInput(WITHOUT)).keys.map((k) => k.id);
      expect(ids).toEqual(FIVE);
      expect(ids).not.toContain("commitment-draws");
    }
  });

  it("emits no key it does not declare, on either book and either arm", () => {
    for (const fn of [computeLcrScenario, computeLcrRegulatory]) {
      for (const opts of [WITH, WITHOUT]) {
        const r = fn(makeInput(opts));
        const declared = r.keys.map((k) => k.id);
        const emitted = Object.keys(r.byScenario[0]!.values);
        // A row that emitted nothing would pass this vacuously, so pin that it did emit.
        expect(emitted.length).toBeGreaterThan(0);
        for (const id of emitted) expect(declared).toContain(id);
      }
    }
  });
});
