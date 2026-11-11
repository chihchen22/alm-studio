/**
 * The liquidity stress is engine input, and the kernel projects it
 * EXACTLY. With closureSteady equal to closureInitial the closure rate is
 * constant, and with maxRateDecay and maxRateGrowth both 0 the rate incentive
 * is 0, so every balance bucket decays by closureSteady percent a month and
 * principal in month m is notional * (1 - s)^(m-1) * s. The params are
 * RESTATED here, not imported from the seed, so a drift in either is caught.
 * The rate shock must not move principal: the incentive that would carry it
 * is switched off.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadMarketSnapshot,
  NMD_B_TERMS_DEFAULTS,
  NMD_DEFAULTS,
  NMD_TERMS_DEFAULTS,
  type MarketSnapshot,
} from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { RateSpec, Scenario } from "../../contracts/scenario";
import { projectInstrument } from "../projectInstrument";

const FIXTURE = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);

let snapshot: MarketSnapshot;
beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
});

const H = 24;

function stressed(percentPerMonth: number) {
  return {
    ...NMD_DEFAULTS,
    closureSteady: percentPerMonth,
    closureInitial: percentPerMonth,
    maxRateDecay: 0,
    maxRateGrowth: 0,
  };
}

const SET: AssumptionSet = {
  schemaVersion: "1.0.0",
  id: "liquidity-stress-test",
  label: "test",
  bindings: [
    { familyId: "dda", overlay: { kind: "nmd-decay", params: stressed(5) }, modelVersion: "kernel-nmd-decay-1" },
    { familyId: "mma", overlay: { kind: "nmd-decay", params: stressed(10) }, modelVersion: "kernel-nmd-decay-1" },
  ],
};

function scenario(id: string, rateSpec: RateSpec): Scenario {
  return {
    id,
    label: id,
    rateSpec,
    assumptionSetId: SET.id,
    newBusiness: { mode: "static", rules: [] },
  };
}

const SCENARIOS = [
  scenario("LIQ-S0", { kind: "base" }),
  scenario("LIQ-S200", { kind: "parallel", shockBp: 200 }),
  scenario("LIQ-S-200", { kind: "parallel", shockBp: -200 }),
];

function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe("the liquidity stress set projects exact geometric run-off", () => {
  it.each([
    { label: "nmd at 5% a month", terms: { ...NMD_TERMS_DEFAULTS, id: "dda-1" }, familyId: "dda", s: 0.05 },
    { label: "nmd-b at 10% a month", terms: { ...NMD_B_TERMS_DEFAULTS, id: "mma-1" }, familyId: "mma", s: 0.1 },
  ])("$label, under every rate scenario", ({ terms, familyId, s }) => {
    const result = projectInstrument({
      terms,
      familyId,
      side: "liability",
      marketSnapshot: snapshot,
      scenarios: SCENARIOS,
      assumptions: SET,
      horizonMonths: H,
    });
    expect(result.byScenario.map((p) => p.scenarioId)).toEqual(["LIQ-S0", "LIQ-S200", "LIQ-S-200"]);
    const n = terms.notional;
    for (const p of result.byScenario) {
      expect(p.rows).toHaveLength(H);
      for (const row of p.rows) {
        const opening = n * (1 - s) ** (row.month - 1);
        expect(relErr(row.balance, opening), `${p.scenarioId} m${row.month} balance`).toBeLessThan(1e-9);
        expect(relErr(row.principal, opening * s), `${p.scenarioId} m${row.month} principal`).toBeLessThan(1e-9);
      }
    }
  });
});
