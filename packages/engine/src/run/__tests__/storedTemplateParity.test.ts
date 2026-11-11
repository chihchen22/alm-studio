/**
 * A stored S2b-1 templated setup runs byte-identical before and after the
 * slice. S2b-1 templates carry no `behavior` field, so every tranche they mint stays contractual, the deposit
 * families keep the fixed-bullet stand-in S2b-1 wrote for them, and EVE and both gap ladders stay the static run-off.
 *
 * Two dynamic runs shaped like S2b-1 guided setups: the Flat basis with a template on every family (a matched
 * level-pay mortgage product, a three-month floating linear loan, and the 60-month fixed-bullet stand-in S2b-1 wrote
 * for both deposit families), and a growth plan with templates on its two targeted families. Each whole RunResult is
 * hashed (SHA-256 of JSON.stringify, no strip, as the accept battery's stage 3 hashes). The pinned values were
 * recorded by running this same file on the unmodified code (S2b-1 merged, before any S2b-2 change), so
 * they are not read back from the code under test. Set PARITY_PRINT=1 to print them.
 */
import { createHash } from "node:crypto";
import { withSourceKernelRef } from "../../provenance/publicCopy";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { BalancePlan } from "../../contracts/balancePlan";
import type { NewVolumeTemplateSpec, RunPlan } from "../../contracts/plan";
import type { RunResult } from "../../contracts/run";
import { compilePlan } from "../../plan/compile";
import { fixturePlan, loadPolicy, withBalanceStage } from "../../plan/__tests__/fixtures";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import { baseAssumptions, loadMarket, twoSidedBook } from "./fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const STAMPS = { runId: "RUN-PARITY-T", seed: "42", timestamps: { startedAt: "2026-11-03T00:00:00.000Z", finishedAt: "2026-11-03T00:00:01.000Z" } };
const withFtp = (plan: RunPlan): RunPlan => ({
  ...plan,
  stages: [
    ...plan.stages,
    { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-term", "st-nii"] },
  ],
});

/** The guided shape: a product on every family, deposits on the fixed-bullet stand-in (S2b-1 ruling 13). */
const TEMPLATES: NewVolumeTemplateSpec[] = [
  { familyId: "FIXED", rateType: "floating", amortization: "linear", indexTenorMonths: 3, termMonths: 48, spreadOverIndexBp: 80 },
  { familyId: "MORTGAGE", rateType: "fixed", amortization: "level-pay", indexTenorMonths: 360, fixedIndex: "matched", termMonths: 360, spreadOverIndexBp: 25 },
  { familyId: "DDA", rateType: "fixed", amortization: "bullet", indexTenorMonths: 60, fixedIndex: "swap", termMonths: 60, spreadOverIndexBp: 0 },
  { familyId: "MMA", rateType: "fixed", amortization: "bullet", indexTenorMonths: 60, fixedIndex: "swap", termMonths: 60, spreadOverIndexBp: 0 },
];
const GROWTH: BalancePlan = {
  schemaVersion: "1.0.0",
  id: "bp-parity-t",
  label: "bp-parity-t",
  asOf: "2026-01-01",
  targets: [
    { familyId: "MORTGAGE", path: [{ month: 36, balance: 4_600_000 }], newBusinessPricing: { spreadOverIndexBp: 25, termMonths: 360 } },
    { familyId: "MMA", path: [{ month: 1, balance: 2_000_000 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 60 } },
  ],
  unlistedFamilies: "runoff",
};

function hashOf(plan: RunPlan, balancePlan?: BalancePlan): string {
  const resolved = { portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES, ...(balancePlan ? { balancePlan } : {}) };
  const c = compilePlan(plan, resolved, STAMPS);
  open.push(c.harness);
  const result: RunResult = buildRunResult(c.request, twoSidedBook(), { ...resolveDefaultContext(), discountBasis: "risk-free", harness: c.harness, plan, planRunLog: c.runLog, profileHash: c.profileHash });
  // withSourceKernelRef: the identity outside a release tree; in one, the kernel reference is set to the one the pins
  // were recorded with, so the pins prove every other byte.
  return createHash("sha256").update(JSON.stringify(withSourceKernelRef(result))).digest("hex");
}

/**
 * Recorded on the unmodified code (S2b-1 merged, before S2b-2): flat e806f847..., growth 7cd2eeba...; byte-identical through
 * S2b-2 and its span changes. Re-pinned for ruling 46: the FTP report's window
 * now holds the tranches made in months 1 .. N, one more tranche per templated family, so only the `ftp` block moved
 * (a whole-block comparison with the first recorded runs found every other block byte-equal). The values below are
 * the current ones.
 */
const PINNED = {
  flat: "41d227e5793b1f7883d1b0ce43cb76784b581d2755ab4730283297a98aa19112",
  growth: "9203091f6357b5df0efa48545b44b748bca8b97de3a0be8829c02d1230a79752",
};

describe("(f) stored S2b-1 templated setups run byte-identical", () => {
  it("the Flat basis with a product on every family, deposits on the S2b-1 stand-in", () => {
    const h = hashOf({ ...withFtp(withBalanceStage(fixturePlan())), balanceBasis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 }, newVolumeTemplates: TEMPLATES });
    if (process.env.PARITY_PRINT === "1") console.log(`PARITY flat ${h}`);
    expect(h).toBe(PINNED.flat);
  }, 120_000);
  it("a growth plan with products on its two targeted families", () => {
    const h = hashOf({ ...withFtp(withBalanceStage(fixturePlan())), balancePlan: GROWTH.id, newVolumeTemplates: TEMPLATES.filter((t) => t.familyId === "MORTGAGE" || t.familyId === "MMA") }, GROWTH);
    if (process.env.PARITY_PRINT === "1") console.log(`PARITY growth ${h}`);
    expect(h).toBe(PINNED.growth);
  }, 120_000);
});
