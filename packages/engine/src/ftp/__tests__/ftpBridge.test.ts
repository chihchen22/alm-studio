/**
 * Studio A+E contract 19 (ae1-A4): the FTP NIM bridge names the new-business
 * residual. On a static base scenario the bridge already re-sums to niiNet12 and
 * the field is absent. On a base scenario that ran dynamic new business through
 * the balance stage, niiNet12 carries the top-up tranches' interest, which no
 * FTP margin on the opening book explains; newBusinessNet12 is that residual,
 * and it is checked here against the side-signed interest the balance stage
 * added, restated from the envelope by hand.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { BalancePlan } from "../../contracts/balancePlan";
import type { RunPlan } from "../../contracts/plan";
import type { RunResult } from "../../contracts/run";
import { compilePlan, type CompiledPlan } from "../../plan/compile";
import { fixturePlan, loadPolicy, withBalanceStage } from "../../plan/__tests__/fixtures";
import { resolveDefaultContext } from "../../run/engine";
import { buildRunResult } from "../../run/orchestrate";
import { baseAssumptions, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const STAMPS = { runId: "RUN-FTP", seed: "42", timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" } };
const resolved = () => ({ portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES });
const withFtp = (plan: RunPlan): RunPlan => ({
  ...plan,
  stages: [
    ...plan.stages,
    { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-term", "st-nii"] },
  ],
});

/** FIXED held flat at its fixture opening balance, 5,000,000, topped up at 60 months, 0 bp. */
const FLAT_FIXED: BalancePlan = {
  schemaVersion: "1.0.0",
  id: "bp-flat-fixed",
  label: "bp-flat-fixed",
  asOf: "2026-01-01",
  targets: [{ familyId: "FIXED", path: [{ month: 1, balance: 5_000_000 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 60 } }],
  unlistedFamilies: "runoff",
};

function compiled(plan: RunPlan, balancePlan?: BalancePlan): { c: CompiledPlan; plan: RunPlan } {
  const c = compilePlan(plan, { ...resolved(), ...(balancePlan ? { balancePlan } : {}) }, STAMPS);
  open.push(c.harness);
  return { c, plan };
}
function runCompiled({ c, plan }: { c: CompiledPlan; plan: RunPlan }): RunResult {
  return buildRunResult(c.request, twoSidedBook(), { ...resolveDefaultContext(), harness: c.harness, plan, planRunLog: c.runLog, profileHash: c.profileHash });
}

/** Side-signed 12-month interest of the base scenario, restated from the envelope by hand. */
function sideSigned12(result: RunResult): number {
  const coa = twoSidedBook().coa;
  const row = result.cashflows.byScenario.find((s) => s.scenarioId === "S0")!;
  let s = 0;
  for (const f of row.byFamily) {
    const side = coa.families.find((c) => c.id === f.familyId)!.side;
    const sign = side === "asset" ? 1 : side === "liability" ? -1 : 0;
    for (let k = 0; k < 12; k++) s += sign * f.series.interest[k]!;
  }
  return s;
}

describe("FtpNimBridge.newBusinessNet12", () => {
  it("is absent on a static base scenario and the existing identity holds", () => {
    const result = runCompiled(compiled(withFtp(fixturePlan())));
    const b = result.ftp!.nimBridge;
    expect("newBusinessNet12" in b).toBe(false);
    expect(Math.abs(b.bridgeNet12 - b.niiNet12)).toBeLessThan(1e-9 * Math.max(1, Math.abs(b.niiNet12)));
  });

  it("on a Flat base scenario it closes the bridge and equals the new-business interest the balance stage added", () => {
    const flatPlan = { ...withFtp(withBalanceStage(fixturePlan())), balancePlan: FLAT_FIXED.id };
    const rf = runCompiled(compiled(flatPlan, FLAT_FIXED));
    const rr = runCompiled(compiled(withFtp(fixturePlan())));
    expect(rf.ftp!.scenarioId).toBe("S0");
    const b = rf.ftp!.nimBridge;
    expect(b.newBusinessNet12).toBeDefined();
    expect(Math.abs(b.bridgeNet12 + b.newBusinessNet12! - b.niiNet12)).toBeLessThan(1e-9 * Math.abs(b.niiNet12));
    // Substantive: the residual is the interest the top-ups earned or cost in the first twelve months.
    const expected = sideSigned12(rf) - sideSigned12(rr);
    expect(expected).not.toBe(0);
    expect(Math.abs(b.newBusinessNet12! - expected)).toBeLessThan(1e-9 * Math.max(1, Math.abs(expected)));
    // The opening book's margins do not move when the balance stage is added.
    expect(Math.abs(b.bridgeNet12 - rr.ftp!.nimBridge.bridgeNet12)).toBeLessThan(1e-9 * Math.max(1, Math.abs(b.bridgeNet12)));
  });
});
