/**
 * The plan compiler: a plan compiles to exactly the request the run tests build
 * by hand, the compiled request runs to the same numbers as the direct one, a
 * gate failure is refused with both reports, a stage the mounted profile cannot
 * execute is tagged while nothing reads it and refused once something does, and
 * a duplicate scenario id is refused.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { buildRunResult } from "../../run/orchestrate";
import { resolveDefaultContext } from "../../run/engine";
import { ViewDefinitionError } from "../../run/executorErrors";
import {
  baseAssumptions,
  BY_SEGMENT_VIEW,
  loadMarket,
  makeRunRequest,
  segmentedNmdBook,
  twoSidedBook,
  viewSegmentedBook,
} from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { BalancePlanUnsupported } from "../lowerBalancePlan";
import { compilePlan, DuplicateScenarioIdError, PlanNotExecutableError, PlanRejected } from "../compile";
import { fixturePlan, loadPolicy, withBalanceStage } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

/** Every context a test compiles is unwound: no test leaves a mounted tree behind. */
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const compiled = (...args: Parameters<typeof compilePlan>) => {
  const c = compilePlan(...args);
  open.push(c.harness);
  return c;
};

const STAMPS = { runId: "RUN-1", seed: "42", timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" } };
const resolved = () => ({ portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES });

/** The fixture plan with inline scenarios that all carry their own newBusiness. */
function shadowingPlan() {
  // SB100 runs dynamic new business, which needs the balance stage.
  const p = withBalanceStage(fixturePlan());
  p.balancePlan = "bp-1";
  p.scenarios = [
    { id: "SB0", label: "SB0", rateSpec: { kind: "base" }, newBusiness: { mode: "static", rules: [] } },
    { id: "SB100", label: "SB100", rateSpec: { kind: "parallel", shockBp: 100 }, newBusiness: { mode: "dynamic", rules: [{ familyId: "MORTGAGE", reinvest: "flat", spreadOverIndexBp: 25, termMonths: 120 }] } },
  ];
  return p;
}

/** A flat FIXED target matching the fixture book's opening balance. */
function flatBalancePlan() {
  return { schemaVersion: "1.0.0" as const, id: "bp-1", label: "flat fixed", asOf: "2026-01-01", targets: [{ familyId: "FIXED", path: [{ month: 360, balance: 5_000_000 }], newBusinessPricing: { spreadOverIndexBp: 100, termMonths: 60 } }], unlistedFamilies: "runoff" as const };
}

describe("compilePlan", () => {
  it("compiles the fixture plan to exactly the request the run tests build today", () => {
    const c = compiled(fixturePlan(), resolved(), STAMPS);
    const { plan: _plan, ...request } = c.request;
    expect(request).toEqual(makeRunRequest(market));
    expect(c.request.plan!.planId).toBe("PLAN-FIXTURE-1");
    expect(c.request.plan!.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.gates.type.passed && c.gates.routing.passed).toBe(true);
  });
  it("is number-neutral: the compiled request runs to the same result as the direct request", () => {
    const ctx = resolveDefaultContext();
    const direct = buildRunResult(makeRunRequest(market), twoSidedBook(), ctx);
    const viaPlan = buildRunResult(compiled(fixturePlan(), resolved(), STAMPS).request, twoSidedBook(), ctx);
    // Plan identity is the only difference the front door may make: the id, the
    // plan hash, and the policy and balance-plan hashes ruling 14 added beside
    // them. Every number is outside this set.
    const strip = (r: typeof direct) => {
      const { provenance, ...rest } = r;
      const { planId: _a, planHash: _b, policyHash: _c, balancePlanHash: _d, ...prov } = provenance;
      return { ...rest, provenance: prov };
    };
    expect(JSON.stringify(strip(viaPlan))).toBe(JSON.stringify(strip(direct)));
    expect(viaPlan.provenance.planId).toBe("PLAN-FIXTURE-1");
    expect(direct.provenance.planId).toBeUndefined();
  });
  it("refuses a plan that fails a gate and carries both reports", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-decay")!.feeds = ["nii"];
    try { compilePlan(p, resolved(), STAMPS); throw new Error("expected PlanRejected"); }
    catch (e) { expect(e).toBeInstanceOf(PlanRejected); expect((e as PlanRejected).routing.failures[0]!.rule).toBe("R1"); expect((e as PlanRejected).type.passed).toBe(true); }
  });
  it("tags a stage no mounted plugin executes while nothing the plan computes reads it (ruling 13)", () => {
    const p = fixturePlan();
    // It produces the DiscountFactorPath nothing reads rather than a second
    // RatePath: after the tightened T1 two producers of one consumed type in a
    // stage's own dependsOn is itself a refusal, and this case is about the
    // stage the profile cannot execute, not about an ambiguous edge.
    p.stages.splice(2, 0, { id: "st-hw", component: "alm-hull-white", kind: "term-structure", consumes: ["ZeroCurve", "CapVolSurface"], produces: ["DiscountFactorPath"], dependsOn: ["st-curve"] });
    p.stages.find((s) => s.id === "st-cashflow")!.dependsOn = ["st-beta", "st-term", "st-hw"];
    const c = compiled(p, resolved(), STAMPS);
    const tag = c.notImplemented.find((n) => n.layer === "plan.stage.st-hw");
    expect(tag).toBeDefined();
    expect(tag!.reason).toContain("alm-hull-white");
    // st-term still produces the RatePath the cash-flow stage reads, so no
    // number depends on the stage that did not run.
    expect(c.gates.type.passed).toBe(true);
  });
  it("refuses the same stage once a metric depends on a type only it produces", () => {
    const p = fixturePlan();
    p.stages.splice(2, 0, { id: "st-hw", component: "alm-hull-white", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["ClientRatePath"], dependsOn: ["st-curve"] });
    const nii = p.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = [...nii.consumes, "ClientRatePath"];
    nii.dependsOn = [...(nii.dependsOn ?? []), "st-hw"];
    try { compilePlan(p, resolved(), STAMPS); throw new Error("expected PlanNotExecutableError"); }
    catch (e) {
      expect(e).toBeInstanceOf(PlanNotExecutableError);
      expect((e as PlanNotExecutableError).stageId).toBe("st-hw");
      expect((e as PlanNotExecutableError).missing).toEqual({ kind: "component", component: "alm-hull-white" });
    }
  });
  it("uses the balance plan as the default new business for a scenario that omits it", () => {
    // Dynamic new business needs the balance stage.
    const p = withBalanceStage(fixturePlan());
    p.balancePlan = "bp-1";
    const bp = { schemaVersion: "1.0.0" as const, id: "bp-1", label: "flat fixed", asOf: "2026-01-01", targets: [{ familyId: "FIXED", path: [{ month: 360, balance: 5_000_000 }], newBusinessPricing: { spreadOverIndexBp: 100, termMonths: 60 } }], unlistedFamilies: "runoff" as const };
    const c = compiled(p, { ...resolved(), balancePlan: bp }, STAMPS);
    expect(c.request.scenarios[0]!.newBusiness).toEqual({ mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "flat", spreadOverIndexBp: 100, termMonths: 60 }] });
  });
  it("refuses duplicate scenario ids across refs and inline definitions", () => {
    const p = fixturePlan();
    p.scenarios.push({ ref: "regulatory-grid-v1#S100" });
    try { compilePlan(p, resolved(), STAMPS); throw new Error("expected DuplicateScenarioIdError"); }
    catch (e) {
      expect(e).toBeInstanceOf(DuplicateScenarioIdError);
      expect((e as DuplicateScenarioIdError).name).toBe("DuplicateScenarioIdError");
      expect((e as DuplicateScenarioIdError).scenarioId).toBe("S100");
      expect((e as Error).message).toContain("S100");
    }
  });
  it("tags a declared balance plan no scenario consumed, and leaves each scenario's own newBusiness alone", () => {
    const p = shadowingPlan();
    const c = compiled(p, { ...resolved(), balancePlan: flatBalancePlan() }, STAMPS);
    const tag = c.notImplemented.find((n) => n.layer === "plan.balance-plan.unused");
    expect(tag).toBeDefined();
    expect(tag!.reason).toContain('balance plan "bp-1"');
    expect(tag!.reason).toContain("SB0, SB100");
    expect(c.request.scenarios.map((s) => s.newBusiness)).toEqual([
      { mode: "static", rules: [] },
      { mode: "dynamic", rules: [{ familyId: "MORTGAGE", reinvest: "flat", spreadOverIndexBp: 25, termMonths: 120 }] },
    ]);
  });
  it("refuses a malformed balance plan even when no scenario would consume it", () => {
    const bad = flatBalancePlan();
    bad.targets[0]!.path = [{ month: 12, balance: 6_000_000 }, { month: 24, balance: 9_000_000 }];
    expect(() => compilePlan(shadowingPlan(), { ...resolved(), balancePlan: bad }, STAMPS)).toThrow(BalancePlanUnsupported);
  });
});

describe("piece 2b: a plan's views reach the request, and a bad one is refused at compile", () => {
  // resolved() returns twoSidedBook(), which carries no taxonomy at all, so a
  // view on "segment" would be refused by P1 rather than reaching the copy.
  // Both view cases therefore resolve against the tagged book.
  const taggedInputs = () => ({ ...resolved(), portfolio: viewSegmentedBook() });

  it("copies a declared view list onto the request, verbatim", () => {
    const plan = { ...fixturePlan(), views: [BY_SEGMENT_VIEW] };
    const c = compiled(plan, taggedInputs(), STAMPS);
    expect(c.request.views).toEqual([BY_SEGMENT_VIEW]);
  });

  it("leaves views absent on the request when the plan declares none", () => {
    const c = compiled(fixturePlan(), taggedInputs(), STAMPS);
    expect(c.request.views).toBeUndefined();
    expect(Object.hasOwn(c.request, "views")).toBe(false);
  });

  it("refuses a view the book cannot partition, naming the rule and the position", () => {
    // segmentedNmdBook leaves F1, M1 and B1 untagged, so P3 fires on F1.
    const plan = { ...fixturePlan(), views: [BY_SEGMENT_VIEW] };
    let err: unknown;
    try {
      compiled(plan, { ...resolved(), portfolio: segmentedNmdBook() }, STAMPS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ViewDefinitionError);
    expect((err as ViewDefinitionError).rule).toBe("P3");
    expect((err as ViewDefinitionError).viewId).toBe("by-segment");
    expect((err as ViewDefinitionError).positionId).toBe("F1");
  });
});
