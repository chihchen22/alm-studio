/**
 * The derived default plan. It is deterministic in the
 * request: the behavioral chain is one stage per distinct overlay kind in
 * first-appearance order, the balance stage exists only when a scenario is
 * dynamic, and the metric stages name exactly the producers each one reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountProfile } from "@alm/harness";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { PlanStage } from "../../contracts/plan";
import type { Scenario } from "../../contracts/scenario";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import type { BehavioralApplier, BehavioralRegistry } from "../../plugins/services";
import { defaultPlanFor } from "../defaultPlan";
import {
  BETA_DEFAULT_PARAMS,
  MORTGAGE_DEFAULT_PARAMS,
  NMD_DEFAULT_PARAMS,
  baseAssumptions,
  loadMarket,
  makeRunRequest,
  twoSidedBook,
} from "./fixtures";

const ctx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
const REGISTRY = ctx.get("behavioral");
afterAll(() => ctx.dispose());

const BOOK = twoSidedBook();
let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const stageOf = (stages: PlanStage[], id: string): PlanStage | undefined => stages.find((s) => s.id === id);

/** A registry stub: only the two methods defaultPlanFor reads are exercised. */
function registryOwning(owners: Record<string, string | undefined>): BehavioralRegistry {
  return {
    register: () => () => {},
    get: (() => {
      throw new Error("not used");
    }) as unknown as (kind: string) => BehavioralApplier,
    providerOf: (kind: string) => owners[kind],
    has: (kind: string) => kind in owners,
    kinds: () => Object.keys(owners),
  };
}

/** A one-binding set of the given kind, so kind ORDER is what a case controls. */
function setOfKinds(id: string, kinds: readonly string[]): AssumptionSet {
  const binding = (kind: string): AssumptionSet["bindings"][number] => {
    if (kind === "prepay") {
      return {
        familyId: "MORTGAGE",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MORTGAGE_DEFAULT_PARAMS },
        modelVersion: "mbs-fixture-1",
      };
    }
    if (kind === "nmd-decay") {
      return { familyId: "DDA", overlay: { kind: "nmd-decay", params: NMD_DEFAULT_PARAMS }, modelVersion: "nmd-fixture-1" };
    }
    return { familyId: "MMA", overlay: { kind: "deposit-beta", params: BETA_DEFAULT_PARAMS }, modelVersion: "beta-fixture-1" };
  };
  return { schemaVersion: "1.0.0", id, label: id, bindings: kinds.map(binding) };
}

describe("defaultPlanFor", () => {
  it("chains one behavioral stage per DISTINCT kind, in first-appearance order", () => {
    const request = makeRunRequest(market, {
      assumptionSets: [setOfKinds("AS-1", ["deposit-beta", "prepay"]), setOfKinds("AS-2", ["prepay", "nmd-decay"])],
      scenarios: makeRunRequest(market).scenarios.map((s) => ({ ...s, assumptionSetId: "AS-1" })),
    });
    const { plan } = defaultPlanFor(request, BOOK, REGISTRY);
    expect(plan.stages.filter((s) => s.kind === "behavioral").map((s) => s.id)).toEqual([
      "st-behavioral-deposit-beta",
      "st-behavioral-prepay",
      "st-behavioral-nmd-decay",
    ]);
    // Each link depends on its predecessor, so the chain is a chain.
    expect(stageOf(plan.stages, "st-behavioral-deposit-beta")?.dependsOn).toEqual(["st-term"]);
    expect(stageOf(plan.stages, "st-behavioral-prepay")?.dependsOn).toEqual([
      "st-behavioral-deposit-beta",
      "st-term",
    ]);
    expect(stageOf(plan.stages, "st-behavioral-nmd-decay")?.dependsOn).toEqual([
      "st-behavioral-prepay",
      "st-term",
    ]);
  });

  it("licenses every binding to the stage of its own kind, set by set", () => {
    const request = makeRunRequest(market, {
      assumptionSets: [baseAssumptions("AS-BASE"), baseAssumptions("AS-ALT")],
    });
    const { licensedBindings } = defaultPlanFor(request, BOOK, REGISTRY);
    expect(licensedBindings).toEqual([
      { stageId: "st-behavioral-prepay", assumptionSetId: "AS-BASE", familyId: "MORTGAGE", kind: "prepay", bindingIndex: 0 },
      { stageId: "st-behavioral-nmd-decay", assumptionSetId: "AS-BASE", familyId: "DDA", kind: "nmd-decay", bindingIndex: 1 },
      { stageId: "st-behavioral-deposit-beta", assumptionSetId: "AS-BASE", familyId: "MMA", kind: "deposit-beta", bindingIndex: 2 },
      { stageId: "st-behavioral-prepay", assumptionSetId: "AS-ALT", familyId: "MORTGAGE", kind: "prepay", bindingIndex: 0 },
      { stageId: "st-behavioral-nmd-decay", assumptionSetId: "AS-ALT", familyId: "DDA", kind: "nmd-decay", bindingIndex: 1 },
      { stageId: "st-behavioral-deposit-beta", assumptionSetId: "AS-ALT", familyId: "MMA", kind: "deposit-beta", bindingIndex: 2 },
    ]);
  });

  it("omits the balance stage on a wholly static grid", () => {
    const { plan } = defaultPlanFor(makeRunRequest(market), BOOK, REGISTRY);
    expect(stageOf(plan.stages, "st-balance")).toBeUndefined();
    expect(stageOf(plan.stages, "st-nii")?.dependsOn).toContain("st-cashflow");
  });

  it("adds the balance stage when a scenario is dynamic: NII reads it, gap never does", () => {
    const base = makeRunRequest(market);
    const dynamicScenarios: Scenario[] = base.scenarios.map((s, i) =>
      i === 0 ? { ...s, newBusiness: { mode: "dynamic", rules: [] } } : s,
    );
    const { plan } = defaultPlanFor(makeRunRequest(market, { scenarios: dynamicScenarios }), BOOK, REGISTRY);
    const balance = stageOf(plan.stages, "st-balance");
    expect(balance?.produces).toEqual(["Cashflow"]);
    // NII reads the PRIMARY series, which is the balance stage's.
    expect(stageOf(plan.stages, "st-nii")?.dependsOn).toContain("st-balance");
    expect(stageOf(plan.stages, "st-nii")?.dependsOn).not.toContain("st-cashflow");
    // EVE and gap read the STATIC series, never the dynamic merge.
    expect(stageOf(plan.stages, "st-gap")?.dependsOn).not.toContain("st-balance");
    expect(stageOf(plan.stages, "st-gap")?.dependsOn).toContain("st-cashflow");
    expect(stageOf(plan.stages, "st-eve")?.dependsOn).not.toContain("st-balance");
  });

  it("hangs every metric stage off the LAST behavioral link", () => {
    const { plan } = defaultPlanFor(makeRunRequest(market), BOOK, REGISTRY);
    const last = "st-behavioral-deposit-beta";
    for (const id of ["st-cashflow", "st-nii", "st-eve", "st-gap", "st-ftp"]) {
      expect(stageOf(plan.stages, id)?.dependsOn, `${id} must read the chain's output`).toContain(last);
    }
  });

  it("names a behavioral stage's component from the registry's providerOf (Ruling P10)", () => {
    const request = makeRunRequest(market, { assumptionSets: [setOfKinds("AS-1", ["prepay"])] });
    const { plan } = defaultPlanFor(request, BOOK, registryOwning({ prepay: "acme.models.prepay" }));
    expect(stageOf(plan.stages, "st-behavioral-prepay")?.component).toBe("acme.models.prepay");
  });

  it("falls back to engine.behavioral.<kind> when the registry has no owner", () => {
    const request = makeRunRequest(market, { assumptionSets: [setOfKinds("AS-1", ["prepay"])] });
    expect(
      stageOf(defaultPlanFor(request, BOOK, registryOwning({})).plan.stages, "st-behavioral-prepay")?.component,
    ).toBe("engine.behavioral.prepay");
    // And with no registry at all, which is what a caller outside the run has.
    expect(stageOf(defaultPlanFor(request, BOOK).plan.stages, "st-behavioral-prepay")?.component).toBe(
      "engine.behavioral.prepay",
    );
  });

  it("carries no planId: a derived plan is logged, never stored", () => {
    const { plan } = defaultPlanFor(makeRunRequest(market), BOOK, REGISTRY);
    expect(plan.planId).toBe("");
    expect(plan.authoredBy).toBe("orchestrator");
    expect(plan.inputs.assumptionSets).toEqual(["AS-BASE"]);
  });
});
