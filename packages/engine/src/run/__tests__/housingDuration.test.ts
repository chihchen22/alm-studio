// packages/engine/src/run/__tests__/housingDuration.test.ts
/**
 * A6 (C4, F10): durations on the three shipped projections
 * and on constant H at 0.25 and at 4. The base scenario's duration sanity gate
 * passes and both mortgage families carry a finite positive effective duration
 * on every mapped path; the mortgages duration is at least the unmapped value
 * under hpi-down-30 and at most it under hpi-up-15. The minimum family duration
 * and the surviving month-13 CPR of an in-the-money position at H = 0.25 are
 * printed, not asserted. Monitoring trigger (Section 13): a market or seed refresh.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Mortgage, type MarketSnapshot, type MortgageTerms } from "@alm/kernel";
import { HousingMortgage } from "../../macro/housingMortgage";
import { buildBaseCurve, buildRatePath } from "../../scenario/rateEnvironment";
import { H, housingSet, macroMarket, runOn, syntheticBook } from "./macroFixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await macroMarket(); }, 120_000);
const dur = (r: ReturnType<typeof runOn>, f: string) => r.eve.byScenario.find((s) => s.scenarioId === "S0")!.byFamily.find((x) => x.familyId === f)!.effectiveDuration;
// The emitted CPR, recovered from the rows (Task 2.3, copied): smm = pp / max(0, bal - sp), cpr = 1 - (1 - smm)^12.
function emittedCpr(terms: MortgageTerms, rows: Array<{ balance: number; principalPaid: number }>): number[] {
  const i = terms.noteRate / 12, n = terms.maturityMonths;
  return rows.slice(0, -1).map((r, k) => {
    const rem = n - k; const sp = i > 1e-12 ? r.balance * (i / (Math.pow(1 + i, rem) - 1)) : r.balance / rem;
    const smm = (r.principalPaid - sp) / Math.max(0, r.balance - sp);
    return 1 - Math.pow(1 - smm, 12);
  });
}

describe("A6 durations (C4)", () => {
  const runs = () => Object.fromEntries((["hpi-down-30", "hpi-up-15", "hpi-flat", "hpi-c025", "hpi-c4"] as const).map((s) => [s, runOn(market, housingSet(`h-${s}`, s))]));
  it("sanity passes and both families carry a finite positive duration on every mapped path", () => {
    const all = runs(), base = runOn(market, housingSet("u", null));
    expect(Object.keys(all).length).toBe(5);
    for (const [id, r] of Object.entries(all)) {
      const s0 = r.eve.byScenario.find((s) => s.scenarioId === "S0")!;
      expect(s0.durationSanityPassed, id).toBe(true);
      for (const f of ["mortgages", "mbs"]) { const d = dur(r, f); expect(Number.isFinite(d) && d! > 0, `${id} ${f}`).toBe(true); }
    }
    expect(dur(all["hpi-down-30"]!, "mortgages")!).toBeGreaterThanOrEqual(dur(base, "mortgages")!);
    expect(dur(all["hpi-up-15"]!, "mortgages")!).toBeLessThanOrEqual(dur(base, "mortgages")!);
    for (const [id, r] of [["unmapped", base] as const, ...Object.entries(all)]) {
      console.info(`A6 duration ${id} mortgages ${dur(r, "mortgages")} mbs ${dur(r, "mbs")}`);
    }
    console.info("A6 minimum family duration", Math.min(...Object.values(all).flatMap((r) => ["mortgages", "mbs"].map((f) => dur(r, f)!))));
    // The surviving CPR in month 13 of the first in-the-money mortgage (note rate above 0.068) at constant H = 0.25.
    const t = syntheticBook().positions.find((p) => p.familyId === "mortgages" && p.terms.type === "mortgage" && (p.terms as MortgageTerms).noteRate > 0.068)!.terms as MortgageTerms;
    const path = buildRatePath(buildBaseCurve(market), 360);
    const c025 = emittedCpr(t, new HousingMortgage(t, H, new Array(360).fill(0.25)).generateCashflows(path));
    const kernel = emittedCpr(t, new Mortgage(t).generateCashflows(path));
    console.info(`A6 month-13 CPR at H = 0.25, note rate ${t.noteRate}: ${c025[12]} (kernel ${kernel[12]})`);
  }, 900_000);
});
