/**
 * Studio slice S2b-1, the whole run: templates on a Flat basis, through compile, the balance stage, NII and
 * FTP. The checks weld each new number to one computed another way, never to itself:
 *  - each family's net interest is its opening book's (the same plan with no template, run off with no balance
 *    stage, read family by family) plus the new-volume line the run states;
 *  - the new volume's own FTP bridge re-sums to newBusinessNet12, the residual the bridge already computed from NII;
 *  - EVE and both gap ladders stay run-off: byte-equal to the same run with no template;
 *  - a plan with no template writes none of the new fields.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { NewVolumeTemplateSpec, RunPlan } from "../../contracts/plan";
import type { RunResult } from "../../contracts/run";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy, withBalanceStage } from "../../plan/__tests__/fixtures";
import { BalancePlanUnsupported } from "../../plan/lowerBalancePlan";
import { parseRunPlan } from "../../plan/parse";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import { baseAssumptions, loadMarket, twoSidedBook } from "./fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const STAMPS = { runId: "RUN-NV", seed: "42", timestamps: { startedAt: "2026-11-02T00:00:00.000Z", finishedAt: "2026-11-02T00:00:01.000Z" } };
const resolved = () => ({ portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES });
const withFtp = (plan: RunPlan): RunPlan => ({
  ...plan,
  stages: [
    ...plan.stages,
    { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-term", "st-nii"] },
  ],
});

const TEMPLATES: NewVolumeTemplateSpec[] = [
  { familyId: "FIXED", rateType: "floating", amortization: "level-pay", indexTenorMonths: 3, termMonths: 60, spreadOverIndexBp: 150 },
  { familyId: "MORTGAGE", rateType: "fixed", amortization: "linear", indexTenorMonths: 120, termMonths: 180, spreadOverIndexBp: 175 },
];

function run(plan: RunPlan): RunResult {
  const c = compilePlan(plan, resolved(), STAMPS);
  open.push(c.harness);
  return buildRunResult(c.request, twoSidedBook(), { ...resolveDefaultContext(), harness: c.harness, plan, planRunLog: c.runLog, profileHash: c.profileHash });
}

const flatPlan = (templates?: NewVolumeTemplateSpec[]): RunPlan => ({
  ...withFtp(withBalanceStage(fixturePlan())),
  balanceBasis: { kind: "flat" },
  ...(templates !== undefined ? { newVolumeTemplates: templates } : {}),
});

describe("new-volume templates through a whole run", () => {
  it("each family's net interest is its run-off plus the new-volume line, scenario by scenario", () => {
    const tpl = run(flatPlan(TEMPLATES));
    const runoff = run(withFtp(fixturePlan()));
    for (const scn of tpl.nii.byScenario) {
      const off = runoff.nii.byScenario.find((s) => s.scenarioId === scn.scenarioId)!;
      expect(scn.newBusiness).toHaveLength(4);
      for (const nb of scn.newBusiness!) {
        const fam = scn.byFamily.find((f) => f.familyId === nb.familyId)!.netMonthly!;
        const base = off.byFamily.find((f) => f.familyId === nb.familyId)!.netMonthly!;
        expect(nb.netMonthly).toHaveLength(fam.length);
        for (let k = 0; k < fam.length; k++) {
          expect(Math.abs(fam[k]! - (base[k]! + nb.netMonthly![k]!))).toBeLessThan(1e-7 * Math.max(1, Math.abs(fam[k]!)));
        }
      }
    }
    const s0 = tpl.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    const fixed = s0.newBusiness!.find((n) => n.familyId === "FIXED")!;
    expect(fixed.product).toEqual({ source: "template", rateType: "floating", amortization: "level-pay", indexTenorMonths: 3, termMonths: 60, spreadOverIndexBp: 150 });
    const dda = s0.newBusiness!.find((n) => n.familyId === "DDA")!;
    expect(dda.product).toEqual({ source: "fixed-bullet", rateType: "fixed", amortization: "bullet", indexTenorMonths: 60, fixedIndex: "swap", termMonths: 60, spreadOverIndexBp: 0 });
    // A liability family's line is an expense: never positive.
    expect(dda.netMonthly!.every((x) => x <= 0)).toBe(true);
    expect(dda.netMonthly!.some((x) => x < 0)).toBe(true);
  });

  it("the new volume's FTP bridge re-sums to the NII residual newBusinessNet12", () => {
    const tpl = run(flatPlan(TEMPLATES));
    const b = tpl.ftp!.nimBridge;
    expect(b.newVolume).toBeDefined();
    expect(b.newBusinessNet12).toBeDefined();
    expect(Math.abs(b.newVolume!.net12 - b.newBusinessNet12!)).toBeLessThan(1e-7 * Math.max(1, Math.abs(b.newBusinessNet12!)));
    expect(Math.abs(b.newVolume!.lendingMargin12 + b.newVolume!.fundingMargin12 + b.newVolume!.mismatchCenter12 - b.newVolume!.net12)).toBeLessThan(1e-9);
    const fixed = tpl.ftp!.byFamily.find((f) => f.familyId === "FIXED")!.newVolume!;
    expect(fixed.trancheCount).toBeGreaterThan(0);
    // A floater's transfer price is a short rate plus its liquidity premium, so the margin is near the 150 bp spread.
    expect(fixed.ftpMarginRate).toBeGreaterThan(0.009);
    expect(fixed.ftpMarginRate).toBeLessThan(0.02);
    // Fix round M2: the window reading covers the tranches made in the first 60 months (the NII window), read against
    // the volume the NII block stores for the same months, and its dollars sum the stored monthly lines. Ruling 46: the
    // tranche made in month k sits at index k (index 0 is the opening bucket and holds nothing), so months 1 .. 60 are
    // indices 1 .. 60.
    const s0 = tpl.nii.byScenario.find((s) => s.scenarioId === tpl.ftp!.scenarioId)!;
    const orig = s0.newBusiness!.find((n) => n.familyId === "FIXED")!.originations;
    expect(orig[0]).toBe(0);
    const made = orig.slice(1, 61).reduce((a, b) => a + b, 0);
    expect(fixed.window.months).toBe(60);
    expect(fixed.window.notional).toBeCloseTo(made, 6);
    expect(fixed.window.notional).toBeLessThan(fixed.notional);
    const coupon60 = fixed.monthly.couponInterest.slice(0, 60).reduce((a, b) => a + b, 0);
    const ftp60 = fixed.monthly.ftpAccrual.slice(0, 60).reduce((a, b) => a + b, 0);
    expect(fixed.window.margin).toBeCloseTo(coupon60 - ftp60, 6);
  });

  it("EVE, both gap ladders and the opening book's FTP rows are the run without templates, byte for byte", () => {
    const tpl = run(flatPlan(TEMPLATES));
    const plain = run(flatPlan());
    expect(JSON.stringify(tpl.eve)).toBe(JSON.stringify(plain.eve));
    expect(JSON.stringify(tpl.gap)).toBe(JSON.stringify(plain.gap));
    const strip = (r: RunResult) => r.ftp!.byFamily.map(({ newVolume: _nv, ...row }) => row);
    expect(JSON.stringify(strip(tpl))).toBe(JSON.stringify(strip(plain)));
  });

  it("a plan with no template writes none of the new fields", () => {
    const plain = run(flatPlan());
    for (const scn of plain.nii.byScenario) for (const nb of scn.newBusiness!) expect(Object.keys(nb)).toEqual(["familyId", "originations"]);
    expect(plain.ftp!.byFamily.some((f) => f.newVolume !== undefined)).toBe(false);
    expect("newVolume" in plain.ftp!.nimBridge).toBe(false);
  });

  it("the compile refuses a template on a family the book does not carry, and the parser one the engine does not run", () => {
    expect(() => run(flatPlan([{ ...TEMPLATES[0]!, familyId: "NOPE" }]))).toThrow(BalancePlanUnsupported);
    // Fix round L6: the refusal says how to recover.
    expect(() => run(flatPlan([{ ...TEMPLATES[0]!, familyId: "NOPE" }]))).toThrow(/save them again for this one/);
    const bad = { ...flatPlan(), newVolumeTemplates: [{ ...TEMPLATES[0]!, indexTenorMonths: 2 }] };
    expect(() => parseRunPlan(JSON.parse(JSON.stringify(bad)))).toThrow(/one of 1, 3, 6, 12/);
    const good = { ...flatPlan(TEMPLATES) };
    expect(parseRunPlan(JSON.parse(JSON.stringify(good))).newVolumeTemplates).toEqual(TEMPLATES);
  });
});
