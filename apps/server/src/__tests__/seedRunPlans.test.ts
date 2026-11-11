// apps/server/src/__tests__/seedRunPlans.test.ts
/**
 * Studio S2: the seed writes one runnable plan per demo book, and each one
 * validates clean against the seeded store (type gate, routing gate, compile).
 * Piece 9 adds a fourth plan on the synthetic book, bound to the loan repricing set.
 * Studio Piece 5b adds a fifth, the contractual graph on the liability book.
 * Studio Piece 7a adds a sixth, the behavioral chain on the indexed book and the rate indices market.
 * OSS slice S1 re-pinned the demo run-plan literals once: the demo routing policy's id is now
 * model-map-default-v1; with that id read back as the old one every re-pinned document hashes to its measured
 * literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateDocument, RunPlan, RunResult } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { buildSeedRunPlans } from "../../scripts/seedRunPlans";
import { repoRoot } from "../config";
import { FileStore, serializeDocument, sha256Hex } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

describe("seeded run plans", () => {
  it("builds the plans in SEED_IDS.runPlans order, so the two lists cannot drift", () => {
    const plans = buildSeedRunPlans({
      market: SEED_IDS.market,
      routingPolicy: SEED_IDS.routingPolicy,
      syntheticPortfolio: SEED_IDS.syntheticPortfolio,
      hedgedPortfolio: SEED_IDS.hedgedPortfolio,
      vanillaPortfolio: SEED_IDS.vanillaPortfolio,
      demoAssumptions: SEED_IDS.demoAssumptions,
      vanillaAssumptions: SEED_IDS.vanillaAssumptions,
      loanRepricingAssumptions: SEED_IDS.loanRepricingAssumptions,
      lcrLiabilityPortfolio: SEED_IDS.lcrLiabilityPortfolio,
      indexedPortfolio: SEED_IDS.indexedPortfolio,
      rateIndexMarket: SEED_IDS.rateIndexMarket,
      macroMarket: SEED_IDS.macroMarket,
      housingAssumptions: SEED_IDS.housingAssumptions,
      housingFlatAssumptions: SEED_IDS.housingFlatAssumptions,
    });
    expect(plans.map((p) => p.planId)).toEqual([...SEED_IDS.runPlans]);
    // Restated literally: the fifth plan is appended last, and the sixth
    // (Re-expectation: five to six) after it.
    expect([...SEED_IDS.runPlans]).toEqual([
      "plan-synthetic-2500-v1",
      "plan-synthetic-2500-hedged-v1",
      "plan-vanilla-book-v1",
      "plan-synthetic-2500-loan-repricing-v1",
      "plan-synthetic-lcr-liabilities-v1",
      "plan-synthetic-2500-indexed-v1",
      // Re-expectation (Studio Piece 7b slice 4): six to nine, the three macro plans appended last.
      "plan-synthetic-2500-macro-unmapped-v1",
      "plan-synthetic-2500-housing-v1",
      "plan-synthetic-2500-housing-flat-v1",
    ]);
  });

  it("the existing seeded plans serialize to their pre-change bytes", () => {
    // Measured on the unmodified code before the refactor; never re-pin.
    const plans = buildSeedRunPlans({
      market: SEED_IDS.market,
      routingPolicy: SEED_IDS.routingPolicy,
      syntheticPortfolio: SEED_IDS.syntheticPortfolio,
      hedgedPortfolio: SEED_IDS.hedgedPortfolio,
      vanillaPortfolio: SEED_IDS.vanillaPortfolio,
      demoAssumptions: SEED_IDS.demoAssumptions,
      vanillaAssumptions: SEED_IDS.vanillaAssumptions,
      loanRepricingAssumptions: SEED_IDS.loanRepricingAssumptions,
      lcrLiabilityPortfolio: SEED_IDS.lcrLiabilityPortfolio,
      indexedPortfolio: SEED_IDS.indexedPortfolio,
      rateIndexMarket: SEED_IDS.rateIndexMarket,
      macroMarket: SEED_IDS.macroMarket,
      housingAssumptions: SEED_IDS.housingAssumptions,
      housingFlatAssumptions: SEED_IDS.housingFlatAssumptions,
    });
    expect(plans.slice(0, 4).map((p) => [p.planId, sha256Hex(serializeDocument(p))])).toEqual([
      ["plan-synthetic-2500-v1", "5e2826755621ffc6d9123bc567fded1cbfa09d14d4870cf55a9443c99feafbee"],
      ["plan-synthetic-2500-hedged-v1", "7c652b11735b6880fe79edea963732e4f15a1ea79a21fa088a6eff3d953abab1"],
      ["plan-vanilla-book-v1", "ba2f810982cb33e6f70383fe9de2c1c5b485a430ee4f1b22aaade38968b632d3"],
      ["plan-synthetic-2500-loan-repricing-v1", "199b5e6db5a5892ff6be654db7931a3339f45300111741d39359537a20a45f3d"],
    ]);
  });

  it("lists the six demo plans as seeded, five books and the loan repricing twin of the synthetic one", async () => {
    const r = await api<Array<{ id: string; positionBook: string; seeded: boolean }>>(t.base, "GET", "/api/run-plans");
    const seeded = r.body.filter((m) => m.seeded === true);
    expect(seeded.map((m) => m.id).sort()).toEqual([...SEED_IDS.runPlans].sort());
    expect(seeded.map((m) => m.positionBook).sort()).toEqual(
      // Re-expectation: was five; +1 for the indexed book.
      // Re-expectation (Studio Piece 7b slice 4): was six; +3, the three macro plans on the synthetic book.
      ["synthetic-2500-indexed-v1", "synthetic-lcr-liabilities-v1", SEED_IDS.hedgedPortfolio, SEED_IDS.syntheticPortfolio, SEED_IDS.syntheticPortfolio, SEED_IDS.vanillaPortfolio,
        SEED_IDS.syntheticPortfolio, SEED_IDS.syntheticPortfolio, SEED_IDS.syntheticPortfolio].sort(),
    );
  });

  for (const id of SEED_IDS.runPlans) {
    it(`${id} validates clean`, async () => {
      const plan = (await api(t.base, "GET", `/api/run-plans/${id}`)).body;
      const r = await api<{
        type: { passed: boolean; failures: unknown[] };
        routing: { passed: boolean; failures: unknown[] };
        compile: { passed: boolean; detail?: string };
      }>(t.base, "POST", "/api/plans/validate", { plan });
      expect(r.status).toBe(200);
      expect(r.body.compile).toEqual({ passed: true });
      expect(r.body.type.failures).toEqual([]);
      expect(r.body.routing.failures).toEqual([]);
    });
  }

  it("reports every seeded plan current on a second seed pass in check mode", async () => {
    const report = await seedStore(new FileStore(t.storeRoot), repoRoot(), { mode: "check" });
    // SeedReport.stale holds StaleDocument objects (collection field);
    // SeedReport.missing holds "collection/id" strings.
    expect(report.stale.filter((s) => s.collection === "run-plans")).toEqual([]);
    expect((report.missing ?? []).filter((s) => s.startsWith("run-plans/"))).toEqual([]);
  });
});

describe("plan-synthetic-2500-loan-repricing-v1", () => {
  const ID = "plan-synthetic-2500-loan-repricing-v1";
  const TERMINAL = ["done", "error", "cancelled", "interrupted"];

  const finished = (runId: string, ms: number) =>
    waitFor(
      () => api<{ state: string }>(t.base, "GET", "/api/runs/" + runId).then((x) => x.body),
      (st) => TERMINAL.includes(st.state),
      ms,
    );

  const baseOnly = (p: RunPlan): RunPlan => ({
    ...p,
    scenarios: p.scenarios.filter((sc) => "ref" in sc && sc.ref === "regulatory-grid-v1#S0"),
  });

  async function run(plan: RunPlan, label: string): Promise<{ result: RunResult; rates: RateDocument }> {
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan, label });
    expect(r.status).toBe(202);
    expect((await finished(r.body.runId, 600_000)).state).toBe("done");
    const result = (await api<RunResult>(t.base, "GET", "/api/runs/" + r.body.runId + "/result")).body;
    const rates = (await api<RateDocument>(t.base, "GET", "/api/runs/" + r.body.runId + "/rates")).body;
    return { result, rates };
  }

  it("is the synthetic book on the new set, with a client-rate stage that feeds no metric", async () => {
    const plan = (await api<RunPlan>(t.base, "GET", "/api/run-plans/" + ID)).body;
    expect(plan.label).toBe("Synthetic book, loan repricing (demonstration)");
    expect(plan.inputs.positionBook).toBe("synthetic-2500-v1");
    expect(plan.inputs.assumptionSets).toEqual(["loan-repricing-demo-v1"]);
    const stage = plan.stages.find((x) => x.id === "st-client-rate");
    expect(stage).toEqual({
      id: "st-client-rate",
      component: "engine.loan-client-rate",
      kind: "behavioral",
      consumes: ["Position", "RatePath"],
      produces: ["Position"],
      dependsOn: ["st-beta", "st-term"],
      selector: { productFamily: "mortgages", behavioralClasses: "client-rate-asset" },
      disposition: "M",
      tier: "Tier 2",
      feeds: [],
    });
    // The four stages that named st-beta name st-client-rate in its place.
    const deps = (id: string) => plan.stages.find((x) => x.id === id)?.dependsOn;
    expect(deps("st-cashflow")).toEqual(["st-client-rate", "st-term"]);
    expect(deps("st-eve")).toEqual(["st-cashflow", "st-curve", "st-tlp", "st-client-rate"]);
    expect(deps("st-gap")).toEqual(["st-cashflow", "st-client-rate"]);
    expect(deps("st-ftp")).toEqual(["st-curve", "st-tlp", "st-term", "st-cashflow", "st-nii", "st-client-rate"]);
    // The demo plan is untouched: it still has no client-rate stage.
    const demo = (await api<RunPlan>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
    expect(demo.stages.some((x) => x.id === "st-client-rate")).toBe(false);
    expect(demo.stages.find((x) => x.id === "st-cashflow")?.dependsOn).toEqual(["st-beta", "st-term"]);
  });

  it("carries one client-rate row on S0 and moves no NII or EVE number", async () => {
    const seededNew = (await api<RunPlan>(t.base, "GET", "/api/run-plans/" + ID)).body;
    const seededDemo = (await api<RunPlan>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
    const withBinding = await run(baseOnly(seededNew), "loan repricing plan, base");
    const without = await run(baseOnly(seededDemo), "demo plan, base");
    expect(withBinding.result.provenance.planId).toBe(ID);
    expect(without.result.provenance.planId).toBe("plan-synthetic-2500-v1");

    expect(withBinding.rates.schemaVersion).toBe("1.2.0");
    const s0 = withBinding.rates.scenarios.find((sc) => sc.scenarioId === "S0")!;
    expect(s0.clientRates).toHaveLength(1);
    const row = s0.clientRates![0]!;
    expect(row.familyId).toBe("mortgages");
    expect(row.assumptionSetId).toBe("loan-repricing-demo-v1");
    expect(row.model).toBe("flat-carry");
    expect(row.totalSpreadBp).toBe(250);
    expect(row.benchmarkTenorYears).toBe(10);
    expect(row.curveConvention).toBe("semiannual_bond");
    expect(row.clientRate).toHaveLength(withBinding.rates.grid.horizonMonths);
    expect(Math.abs(row.clientRate[0]! - (row.benchmark[0]! + 0.025))).toBeLessThan(1e-12);

    // The demo plan's S0 document carries no clientRates arm.
    const demoS0 = without.rates.scenarios.find((sc) => sc.scenarioId === "S0")!;
    expect("clientRates" in demoS0).toBe(false);

    expect(withBinding.result.nii.byScenario.length).toBe(1);
    expect(withBinding.result.nii).toEqual(without.result.nii);
    expect(withBinding.result.eve).toEqual(without.result.eve);
  }, 1_300_000);
});
