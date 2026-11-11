// packages/engine/src/run/__tests__/housingDynamicBalance.test.ts
/**
 * The dynamic balance stage on a mapped book (Piece 7b slice 4, the slice 3
 * ruling on balance.ts:46). A scenario in dynamic new-business mode is projected
 * by the balance stage, which hands env.macro to projectDynamicScenario; before
 * this test no mapped run had reached that stage. One mapped run with dynamic
 * new business on, against the same run unmapped: the mortgage cash flows must
 * differ, so a balance stage that dropped the run's macro path (a silent kernel
 * schedule, or a refusal) cannot pass.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { Scenario } from "../../contracts/scenario";
import { buildRunResult } from "../orchestrate";
import { resolveDefaultContext } from "../engine";
import { makeRunRequest } from "./fixtures";
import { housingSet, macroMarket, syntheticBook } from "./macroFixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await macroMarket(); }, 120_000);

// A mortgage-only slice of the synthetic book (the I2c slice): cheap, and every position is a mapped family.
const mortgageBook = (): PortfolioSpec => {
  const b = syntheticBook();
  const keep = (fam: string) => b.positions.filter((p) => p.familyId === fam).slice(0, 60);
  return { ...b, positions: [...keep("mortgages"), ...keep("mbs")] };
};

function runDynamic(set: AssumptionSet, mode: "dynamic" | "static" = "dynamic"): RunResult {
  const book = mortgageBook();
  const scenario: Scenario = {
    id: "S0", label: `S0 ${mode}`, rateSpec: { kind: "base" }, assumptionSetId: set.id,
    newBusiness: mode === "dynamic" ? { mode, rules: [{ familyId: "mortgages", reinvest: "flat", termMonths: 12 }] } : { mode, rules: [] },
  };
  const request = makeRunRequest(market, { runId: "MF4-DYN", portfolioId: book.id, scenarios: [scenario], assumptionSets: [set], grid: { horizonMonths: 360, asOf: book.asOf } });
  return buildRunResult(request, book, resolveDefaultContext());
}

describe("the dynamic balance stage reads the run's macro path", () => {
  it("a mapped dynamic run's mortgage cash flows differ from the same run unmapped", () => {
    const unmapped = runDynamic(housingSet("u", null)), mapped = runDynamic(housingSet("d", "hpi-down-30"));
    const series = (r: RunResult, f: string) => r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((x) => x.familyId === f)!.series;
    // Power: the dynamic projection ran; the flat rule's reinvested tranches move the mortgages series off the static run's.
    expect(JSON.stringify(series(unmapped, "mortgages").principal)).not.toBe(JSON.stringify(series(runDynamic(housingSet("u", null), "static"), "mortgages").principal));
    for (const f of ["mortgages", "mbs"]) {
      expect(JSON.stringify(series(mapped, f).principal), f).not.toBe(JSON.stringify(series(unmapped, f).principal));
    }
  }, 300_000);
});
