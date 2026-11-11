import { describe, expect, it } from "vitest";
import type { InstrumentScenarioProjectionView } from "../api/client";
import { legTables } from "../drillLegs";

const r = (month: number, interest: number) => ({ month, pathRate: 0.04, couponRate: 0.04, balance: 0, principal: 0, interest, payment: interest });
const base = { scenarioId: "S0", rateSpec: { kind: "base" }, rows: [r(1, 1)], repricingMonths: [], pvAllIn: 0, pvRiskFree: 0 } as unknown as InstrumentScenarioProjectionView;

describe("legTables", () => {
  it("is empty for an instrument with no legs", () => {
    expect(legTables(base)).toEqual([]);
  });
  it("returns receive then pay, exactly as served", () => {
    const p = { ...base, legs: { receive: [r(1, 5)], pay: [r(1, -4)] } } as InstrumentScenarioProjectionView;
    expect(legTables(p)).toEqual([
      { leg: "receive", rows: [r(1, 5)] },
      { leg: "pay", rows: [r(1, -4)] },
    ]);
  });
});
