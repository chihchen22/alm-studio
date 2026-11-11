/**
 * `repricingTreatment: "excluded"` keeps a
 * position out of the REPRICING ladder only. The liquidity ladder still carries
 * its principal at the month it is paid.
 */
import { describe, expect, it } from "vitest";
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { makeInstrument } from "../../runtime/instrumentFactory";
import type { PortfolioSpec } from "../../contracts/position";
import { fixedPosition, nmdBetaPosition, twoSidedBook } from "../../run/__tests__/fixtures";
import { accumulateGapPosition, buildScenarioGap, type BucketSeriesPair } from "../index";

const HORIZON = 60;
const path = new ConstantRatePath(0.04, HORIZON);

function pair(): BucketSeriesPair {
  return { repricing: [new Float64Array(HORIZON)], principal: [new Float64Array(HORIZON)] };
}
const sum = (a: Float64Array): number => a.reduce((s, v) => s + v, 0);

describe("repricingTreatment excluded", () => {
  it("accumulateGapPosition books the principal and no repricing volume when the flag is set", () => {
    const pos = fixedPosition("F1", { notional: 1_000_000, coupon: 0.05, maturityMonths: 24 });
    const inst = makeInstrument(pos.terms);
    const cfs = inst.generateCashflows(path);
    const plain = pair();
    accumulateGapPosition(plain, 0, inst, cfs, HORIZON, path);
    const excluded = pair();
    accumulateGapPosition(excluded, 0, inst, cfs, HORIZON, path, true);
    expect([...excluded.principal[0]!]).toEqual([...plain.principal[0]!]);
    expect(sum(plain.repricing[0]!)).toBeCloseTo(1_000_000, 6);
    expect([...excluded.repricing[0]!].every((v) => v === 0)).toBe(true);
  });

  it("an excluded NMD-B books no beta slice either", () => {
    const pos = nmdBetaPosition("B1", { notional: 2_000_000 });
    const inst = makeInstrument(pos.terms);
    const cfs = inst.generateCashflows(path);
    const plain = pair();
    accumulateGapPosition(plain, 0, inst, cfs, HORIZON, path);
    expect(plain.repricing[0]![0]).toBeGreaterThan(0);
    const excluded = pair();
    accumulateGapPosition(excluded, 0, inst, cfs, HORIZON, path, true);
    expect([...excluded.repricing[0]!].every((v) => v === 0)).toBe(true);
    expect([...excluded.principal[0]!]).toEqual([...plain.principal[0]!]);
  });

  it("the ladders of a book with one excluded position: repricing drops it, liquidity is unchanged", () => {
    const base = twoSidedBook();
    const flagged: PortfolioSpec = {
      ...base,
      positions: base.positions.map((p) => (p.id === "F1" ? { ...p, repricingTreatment: "excluded" as const } : p)),
    };
    const sp = { scenarioId: "S0", path };
    const a = buildScenarioGap(base, sp, HORIZON);
    const b = buildScenarioGap(flagged, sp, HORIZON);
    expect(JSON.stringify(b.liquidity)).toBe(JSON.stringify(a.liquidity));
    const fixedNode = (l: typeof a.repricing) => l.byCoaNode.find((n) => n.coaNodeId === "fixed-loans")!.rows;
    expect(fixedNode(a.repricing).reduce((s, r) => s + r.assets, 0)).toBeCloseTo(5_000_000, 4);
    expect(fixedNode(b.repricing).every((r) => r.assets === 0)).toBe(true);
    // The other families' repricing rows are untouched.
    const mortgages = (l: typeof a.repricing) => JSON.stringify(l.byCoaNode.find((n) => n.coaNodeId === "mortgages")!.rows);
    expect(mortgages(b.repricing)).toBe(mortgages(a.repricing));
  });
});
