/**
 * Studio A+E contract 8: every drill row carries the two discount factors the
 * scenario PVs are evaluated with at month/12, and its own row PVs, so a reader
 * multiplies nothing. A swap carries the risk-free factor on both bases
 * and says so. Expected factors are rebuilt here from the curve
 * seams, never read back from the drill.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, DEFAULT_TLP_CURVE, type MarketSnapshot, type TLPCurve } from "@alm/kernel";
import type { PositionTerms } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { discountFunction } from "../../eve/discount";
import { loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { buildBaseCurve, shockedCurve } from "../../scenario/rateEnvironment";
import { swapTerms, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import { projectInstrument } from "../projectInstrument";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const scenarios: Scenario[] = [
  { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "none", newBusiness: { mode: "static", rules: [] } },
  { id: "S200", label: "+200", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: "none", newBusiness: { mode: "static", rules: [] } },
];

/** The all-in funding overlay, restated: the snapshot's nodes, or the kernel default. */
function tlpOf(snapshot: MarketSnapshot): TLPCurve {
  return snapshot.tlpNodes.length > 0 ? buildTLPCurve(snapshot.tlpNodes) : DEFAULT_TLP_CURVE;
}

const relClose = (a: number, b: number) =>
  expect(Math.abs(a - b), `${a} versus ${b}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));

describe("InstrumentScheduleRow discount factors and PVs", () => {
  it("each row's factors equal discountFunction at month/12 on the scenario curve, and the row PVs sum to the scenario PVs", () => {
    const book = twoSidedBook();
    const pos = book.positions.find((p) => p.familyId === "FIXED")!;
    const r = projectInstrument({ terms: pos.terms, familyId: pos.familyId, side: "asset", marketSnapshot: market, scenarios, horizonMonths: 120, durationBumpBp: 100 });
    const base = buildBaseCurve(market);
    const tlp = tlpOf(market);
    expect(r.byScenario.length).toBe(2);
    for (const sc of r.byScenario) {
      expect(sc.rows.length).toBeGreaterThan(0);
      const curve = shockedCurve(base, sc.rateSpec);
      const dfA = discountFunction(curve, tlp, 0, "all-in");
      const dfR = discountFunction(curve, tlp, 0, "risk-free");
      let sumA = 0;
      let sumR = 0;
      for (const row of sc.rows) {
        expect(row.discountFactorAllIn).toBe(dfA(row.month / 12));
        expect(row.discountFactorRiskFree).toBe(dfR(row.month / 12));
        expect(row.pvAllIn).toBe(row.discountFactorAllIn * (row.principal + row.interest));
        expect(row.pvRiskFree).toBe(row.discountFactorRiskFree * (row.principal + row.interest));
        sumA += row.pvAllIn;
        sumR += row.pvRiskFree;
      }
      relClose(sumA, sc.pvAllIn);
      relClose(sumR, sc.pvRiskFree);
      expect("discountBasisNote" in sc).toBe(false);
    }
  });

  it("a swap carries the risk-free factor and PV in both fields and says so", () => {
    const sw = swapTerms("A6-SW");
    const r = projectInstrument({ terms: sw as unknown as PositionTerms, familyId: SWAP_FAMILY_ID, side: "derivative", marketSnapshot: market, scenarios, horizonMonths: 120, durationBumpBp: 100 });
    const base = buildBaseCurve(market);
    const tlp = tlpOf(market);
    for (const sc of r.byScenario) {
      expect(sc.discountBasisNote).toBe("swap: risk-free on both bases");
      const dfR = discountFunction(shockedCurve(base, sc.rateSpec), tlp, 0, "risk-free");
      let sum = 0;
      for (const row of sc.rows) {
        expect(row.discountFactorRiskFree).toBe(dfR(row.month / 12));
        expect(row.discountFactorAllIn).toBe(row.discountFactorRiskFree);
        expect(row.pvAllIn).toBe(row.pvRiskFree);
        sum += row.pvRiskFree;
      }
      relClose(sum, sc.pvRiskFree);
      for (const leg of [sc.legs!.receive, sc.legs!.pay]) {
        expect(leg.length).toBe(60);
        for (const row of leg) {
          expect(row.discountFactorRiskFree).toBe(dfR(row.month / 12));
          expect(row.discountFactorAllIn).toBe(row.discountFactorRiskFree);
          expect(row.pvRiskFree).toBe(row.discountFactorRiskFree * (row.principal + row.interest));
        }
      }
    }
  });
});
