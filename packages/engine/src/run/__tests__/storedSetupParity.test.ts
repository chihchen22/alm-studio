/**
 * A stored setup's run is byte-identical before and after the slice.
 *
 * Two dynamic runs shaped like stored setups (no template anywhere): the Flat basis at its defaults, as Standard ALCO
 * and every S2a guided setup on Flat compile, and a custom balance plan with a growth target. Each whole RunResult is
 * hashed (SHA-256 of JSON.stringify, no strip, as the accept battery's stage 3 hashes). The pinned values were
 * recorded by running this same file on the unmodified code, before any S2b-1 change, so they
 * are not read back from the code under test. Set PARITY_PRINT=1 to print them.
 */
import { createHash } from "node:crypto";
import { withSourceKernelRef } from "../../provenance/publicCopy";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { BalancePlan } from "../../contracts/balancePlan";
import type { RunPlan } from "../../contracts/plan";
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
const STAMPS = { runId: "RUN-PARITY", seed: "42", timestamps: { startedAt: "2026-11-02T00:00:00.000Z", finishedAt: "2026-11-02T00:00:01.000Z" } };
const withFtp = (plan: RunPlan): RunPlan => ({
  ...plan,
  stages: [
    ...plan.stages,
    { id: "st-ftp", component: "engine.metric.ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"], produces: ["FtpResult"], dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-term", "st-nii"] },
  ],
});
const GROWTH: BalancePlan = {
  schemaVersion: "1.0.0",
  id: "bp-parity",
  label: "bp-parity",
  asOf: "2026-01-01",
  targets: [
    { familyId: "FIXED", path: [{ month: 24, balance: 6_050_000 }], newBusinessPricing: { spreadOverIndexBp: 125, termMonths: 36 } },
    { familyId: "DDA", path: [{ month: 1, balance: 3_000_000 }], newBusinessPricing: { spreadOverIndexBp: -40, termMonths: 12 } },
  ],
  unlistedFamilies: "runoff",
};

function hashOf(plan: RunPlan, balancePlan?: BalancePlan): string {
  const resolved = { portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES, ...(balancePlan ? { balancePlan } : {}) };
  const c = compilePlan(plan, resolved, STAMPS);
  open.push(c.harness);
  const result: RunResult = buildRunResult(c.request, twoSidedBook(), { ...resolveDefaultContext(), harness: c.harness, plan, planRunLog: c.runLog, profileHash: c.profileHash });
  // withSourceKernelRef: the identity outside a release tree; in one, the kernel reference is set to the one the pins
  // were recorded with, so the pins prove every other byte.
  return createHash("sha256").update(JSON.stringify(withSourceKernelRef(result))).digest("hex");
}

/** The pinned digests of these two runs. */
const PINNED = {
  flat: "ea34507dfd207067e213604ba6f7637f6761e4dc691bb97411b11d7d2b93a54b",
  growth: "4b547e426260ba14cf5283406f412e6a6bcd894513fb06e42046929000a963c1",
};

describe("(e) stored setups run byte-identical", () => {
  it("the Flat basis at its defaults, no template", () => {
    const h = hashOf({ ...withFtp(withBalanceStage(fixturePlan())), balanceBasis: { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 } });
    if (process.env.PARITY_PRINT === "1") console.log(`PARITY flat ${h}`);
    expect(h).toBe(PINNED.flat);
  });
  it("a custom balance plan with a growth target and a flat one, no template", () => {
    const h = hashOf({ ...withFtp(withBalanceStage(fixturePlan())), balancePlan: GROWTH.id }, GROWTH);
    if (process.env.PARITY_PRINT === "1") console.log(`PARITY growth ${h}`);
    expect(h).toBe(PINNED.growth);
  });
});
