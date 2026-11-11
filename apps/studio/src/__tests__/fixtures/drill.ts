/**
 * Single-instrument drill replies as POST /api/instrument/project answers them (Studio A+E contract 8): every
 * schedule row carries two discount factors and two row PVs, and a swap carries the risk-free pair in both fields
 * with the scenario's discountBasisNote. Hand-typed, long decimals on purpose so the raw value in a cell's title can
 * be told from the rounded text beside it.
 */
import type { InstrumentDrill, InstrumentScenarioProjectionView, InstrumentScheduleRowView } from "@alm/reader";

function row(month: number, balance: number, df: number, dfRf: number, pv: number, pvRf: number): InstrumentScheduleRowView {
  return {
    month, pathRate: 0.0425, couponRate: 0.06, balance, principal: 15000, interest: 5000, payment: 20000,
    discountFactorAllIn: df, discountFactorRiskFree: dfRf, pvAllIn: pv, pvRiskFree: pvRf,
  };
}

export const S0: InstrumentScenarioProjectionView = {
  scenarioId: "S0",
  rateSpec: { kind: "base" },
  rows: [
    row(1, 985000, 0.99123456, 0.99654321, 19824.6912, 19930.8642),
    row(2, 970000, 0.98251234, 0.99012345, 19650.2468, 19802.469),
    row(3, 955000, 0.97412345, 0.98512345, 19482.469, 19702.469),
  ],
  repricingMonths: [],
  walMonths: 2.0123,
  pvAllIn: 58957.407,
  pvRiskFree: 59435.8022,
  effectiveDuration: 0.1234,
};

export const S200: InstrumentScenarioProjectionView = {
  scenarioId: "S200",
  rateSpec: { kind: "parallel", shockBp: 200 },
  rows: [
    row(1, 985000, 0.98991234, 0.99512345, 19798.2468, 19902.469),
    row(2, 970000, 0.97812345, 0.98612345, 19562.469, 19722.469),
  ],
  repricingMonths: [],
  pvAllIn: 39360.7158,
  pvRiskFree: 39624.938,
};

export const DRILL: InstrumentDrill = {
  terms: { id: "loan-7", type: "fixed-loan", notional: 1000000 },
  familyId: "cre-fixed",
  side: "asset",
  horizonMonths: 360,
  durationBumpBp: 100,
  overlayApplied: "none (contractual)",
  byScenario: [S0, S200],
  marketId: "market-public-2026-03-31",
  scenarioSource: "inline",
};

const LEG = (sign: 1 | -1): InstrumentScheduleRowView[] => [
  { month: 1, pathRate: 0.0425, couponRate: 0.045, balance: sign * 5000000, principal: 0, interest: sign * 18750, payment: sign * 18750, discountFactorAllIn: 0.99654321, discountFactorRiskFree: 0.99654321, pvAllIn: sign * 18685.1852, pvRiskFree: sign * 18685.1852 },
];

export const SWAP_DRILL: InstrumentDrill = {
  terms: { id: "swap-3", type: "swap", notional: 5000000 },
  familyId: "swaps",
  side: "derivative",
  horizonMonths: 360,
  durationBumpBp: 100,
  overlayApplied: "none (contractual)",
  marketId: "market-public-2026-03-31",
  scenarioSource: "inline",
  byScenario: [
    {
      scenarioId: "S0",
      rateSpec: { kind: "base" },
      rows: [
        { month: 1, pathRate: 0.0425, couponRate: 0, balance: 0, principal: 0, interest: 1250, payment: 1250, discountFactorAllIn: 0.99654321, discountFactorRiskFree: 0.99654321, pvAllIn: 1245.679, pvRiskFree: 1245.679 },
      ],
      repricingMonths: [],
      pvAllIn: 1245.679,
      pvRiskFree: 1245.679,
      durationBasis: "notional",
      legs: { receive: LEG(1), pay: LEG(-1) },
      discountBasisNote: "swap: risk-free on both bases",
    },
  ],
};
