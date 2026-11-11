/**
 * Piece 2 (spec 2026-09-26-alm-studio-p2-targets-design.md Section 4): the
 * per-scenario balance plan map. Task 1 holds the parse; Task 2 adds compile.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { baseAssumptions, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { contentHash } from "../../runtime/contentHash";
import { BalancePlanUnsupported } from "../lowerBalancePlan";
import { compilePlan, readsCashflowThroughBalance, ScenarioNotExecutableError } from "../compile";
import type { PlanStage } from "../../contracts/plan";
import { parseRunPlan, PlanShapeError } from "../parse";
import { fixturePlan, loadPolicy, withBalanceStage } from "./fixtures";

// planHash of fixturePlan() on the unmodified code, printed once and pinned; re-pinned once in OSS slice S1 for the
// fixture's neutral routing policy id (model-map-default-v1): with the old id read back it hashes to the earlier literal
// 677785b7bb27bd39c71e8044a5fe2aaf0d172b30e6298425cd93ef3de8e0240b.
const PLAN_HASH_PINNED = "6daa3ffeddd1685d34d308ab20d591f4e9b22f6f381eb9fdf9ed1f8358f2a063";

describe("parseRunPlan: scenarioBalancePlans", () => {
  it("passes the map through", () => {
    const p = { ...fixturePlan(), scenarioBalancePlans: { S0: "bp-a", S100: "bp-b" } };
    expect(parseRunPlan(JSON.parse(JSON.stringify(p))).scenarioBalancePlans).toEqual({ S0: "bp-a", S100: "bp-b" });
  });
  it("leaves the field absent when the plan omits it", () => {
    expect("scenarioBalancePlans" in parseRunPlan(JSON.parse(JSON.stringify(fixturePlan())))).toBe(false);
  });
  it("refuses a non-object with the field path", () => {
    const p = { ...fixturePlan(), scenarioBalancePlans: ["bp-a"] };
    expect(() => parseRunPlan(p)).toThrow(PlanShapeError);
    expect(() => parseRunPlan(p)).toThrow(/scenarioBalancePlans/);
  });
  it("refuses an empty or non-string value naming the scenario key", () => {
    expect(() => parseRunPlan({ ...fixturePlan(), scenarioBalancePlans: { S0: "" } })).toThrow(/scenarioBalancePlans\.S0/);
    expect(() => parseRunPlan({ ...fixturePlan(), scenarioBalancePlans: { S0: 7 } })).toThrow(/scenarioBalancePlans\.S0/);
  });
});


let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });
const open: Array<{ dispose(): void }> = [];
afterEach(() => { while (open.length > 0) open.pop()!.dispose(); });
const compiled = (...args: Parameters<typeof compilePlan>) => { const c = compilePlan(...args); open.push(c.harness); return c; };
const STAMPS = { runId: "RUN-1", seed: "42", timestamps: { startedAt: "2026-07-16T00:00:00.000Z", finishedAt: "2026-07-16T00:00:01.000Z" } };
const resolved = () => ({ portfolio: twoSidedBook(), marketSnapshot: market, assumptionSets: [baseAssumptions()], policy: loadPolicy(), libraries: SHIPPED_LIBRARIES });

/** FIXED at its fixture opening balance, 5,000,000: lowers to "flat". */
const flatFixed = (id: string) => ({ schemaVersion: "1.0.0" as const, id, label: id, asOf: "2026-01-01", targets: [{ familyId: "FIXED", path: [{ month: 1, balance: 5_000_000 }], newBusinessPricing: { spreadOverIndexBp: 100, termMonths: 60 } }], unlistedFamilies: "runoff" as const });

/** Two inline scenarios, S0 and S100, with no newBusiness of their own. */
function twoScenarioPlan() {
  const p = withBalanceStage(fixturePlan());
  p.scenarios = [
    { id: "S0", label: "S0", rateSpec: { kind: "base" } },
    { id: "S100", label: "S100", rateSpec: { kind: "parallel", shockBp: 100 } },
  ];
  return p;
}
const FLAT_RULE = { familyId: "FIXED", reinvest: "flat", spreadOverIndexBp: 100, termMonths: 60 };

describe("compilePlan: order of use", () => {
  it("1. a scenario's own newBusiness wins over its map entry, and the entry is noted as shadowed", () => {
    const p = twoScenarioPlan();
    p.scenarios[0] = { id: "S0", label: "S0", rateSpec: { kind: "base" }, newBusiness: { mode: "static", rules: [] } };
    p.scenarioBalancePlans = { S0: "bp-a" };
    const c = compiled(p, { ...resolved(), scenarioBalancePlans: [flatFixed("bp-a")] }, STAMPS);
    expect(c.request.scenarios[0]!.newBusiness).toEqual({ mode: "static", rules: [] });
    const note = c.notImplemented.find((n) => n.layer === "plan.balance-plan.shadowed");
    expect(note?.reason).toContain('"S0"');
    expect(note?.reason).toContain('"bp-a"');
    expect(c.request.plan!.scenarioBalancePlanHashes).toBeUndefined();
  });
  it("2. a map entry wins over the plan-level balance plan", () => {
    const p = twoScenarioPlan();
    p.balancePlan = "bp-plan";
    p.scenarioBalancePlans = { S100: "bp-a" };
    const planLevel = { ...flatFixed("bp-plan"), targets: [{ ...flatFixed("bp-plan").targets[0]!, newBusinessPricing: { spreadOverIndexBp: 250, termMonths: 12 } }] };
    const c = compiled(p, { ...resolved(), balancePlan: planLevel, scenarioBalancePlans: [flatFixed("bp-a")] }, STAMPS);
    expect(c.request.scenarios[0]!.newBusiness).toEqual({ mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "flat", spreadOverIndexBp: 250, termMonths: 12 }] });
    expect(c.request.scenarios[1]!.newBusiness).toEqual({ mode: "dynamic", rules: [FLAT_RULE] });
  });
  it("3. the plan-level balance plan applies where there is no entry", () => {
    const p = twoScenarioPlan();
    p.balancePlan = "bp-plan";
    const c = compiled(p, { ...resolved(), balancePlan: flatFixed("bp-plan") }, STAMPS);
    expect(c.request.scenarios.map((s) => s.newBusiness)).toEqual([{ mode: "dynamic", rules: [FLAT_RULE] }, { mode: "dynamic", rules: [FLAT_RULE] }]);
  });
  it("4. with neither, a scenario runs off statically", () => {
    const p = twoScenarioPlan();
    p.scenarioBalancePlans = { S100: "bp-a" };
    const c = compiled(p, { ...resolved(), scenarioBalancePlans: [flatFixed("bp-a")] }, STAMPS);
    expect(c.request.scenarios[0]!.newBusiness).toEqual({ mode: "static", rules: [] });
  });
});

describe("compilePlan: per-scenario hashes (spec Section 4.3 item 4)", () => {
  it("records the consumed balance plan's content hash for mapped consumers only", () => {
    const p = twoScenarioPlan();
    p.scenarioBalancePlans = { S100: "bp-a" };
    const bp = flatFixed("bp-a");
    const c = compiled(p, { ...resolved(), scenarioBalancePlans: [bp] }, STAMPS);
    // contentHash is the engine's identity hash, not the code under test: an accepted exception to "restate, never import".
    expect(c.request.plan!.scenarioBalancePlanHashes).toEqual({ S100: contentHash(bp) });
    expect(c.request.plan!.balancePlanHash).toBeUndefined();
  });
  it("leaves the plan hash and the plan block unchanged when the map is absent", () => {
    // The plan hash of fixturePlan(), restated: a plan without the
    // map must hash exactly as it did before Piece 2 (additive).
    const c = compiled(fixturePlan(), resolved(), STAMPS);
    expect(c.request.plan!.planHash).toBe(PLAN_HASH_PINNED);
    expect("scenarioBalancePlanHashes" in c.request.plan!).toBe(false);
  });
});

describe("compilePlan: refusals", () => {
  it("refuses a map key naming no scenario of the plan", () => {
    const p = twoScenarioPlan();
    p.scenarioBalancePlans = { NOPE: "bp-a" };
    expect(() => compilePlan(p, { ...resolved(), scenarioBalancePlans: [flatFixed("bp-a")] }, STAMPS)).toThrow(BalancePlanUnsupported);
    expect(() => compilePlan(p, { ...resolved(), scenarioBalancePlans: [flatFixed("bp-a")] }, STAMPS)).toThrow(/"NOPE"/);
  });
  it("refuses a map value whose balance plan was not supplied", () => {
    const p = twoScenarioPlan();
    p.scenarioBalancePlans = { S0: "bp-missing" };
    expect(() => compilePlan(p, resolved(), STAMPS)).toThrow(/"bp-missing"/);
  });
  it("lowers a mapped balance plan eagerly: a malformed one is refused even if its scenario is shadowed", () => {
    const p = twoScenarioPlan();
    p.scenarios[0] = { id: "S0", label: "S0", rateSpec: { kind: "base" }, newBusiness: { mode: "static", rules: [] } };
    p.scenarioBalancePlans = { S0: "bp-bad" };
    const bad = { ...flatFixed("bp-bad"), targets: [{ ...flatFixed("bp-bad").targets[0]!, path: [{ month: 12, balance: 6_000_000 }, { month: 24, balance: 9_000_000 }] }] };
    expect(() => compilePlan(p, { ...resolved(), scenarioBalancePlans: [bad] }, STAMPS)).toThrow(BalancePlanUnsupported);
  });
  it("refuses dynamic new business when no stage has kind balance-new-business", () => {
    const p = fixturePlan();
    p.scenarios = [{ id: "S0", label: "S0", rateSpec: { kind: "base" } }];
    p.balancePlan = "bp-plan";
    try { compilePlan(p, { ...resolved(), balancePlan: flatFixed("bp-plan") }, STAMPS); throw new Error("expected ScenarioNotExecutableError"); }
    catch (e) {
      expect(e).toBeInstanceOf(ScenarioNotExecutableError);
      expect((e as ScenarioNotExecutableError).scenarioId).toBe("S0");
      expect((e as Error).message).toContain("balance-new-business");
    }
  });
  it("refuses dynamic new business when the NII stage does not read its Cashflow through the balance stage (Polish 1 E1)", () => {
    const p = twoScenarioPlan();
    p.balancePlan = "bp-plan";
    // Hand-wired: EVE reads the balance stage, NII reads the contractual stage.
    p.stages = p.stages.map((s) => {
      if (s.id === "st-nii") return { ...s, dependsOn: ["st-cashflow"] };
      if (s.id === "st-eve") return { ...s, dependsOn: (s.dependsOn ?? []).map((d) => (d === "st-cashflow" ? "st-balance" : d)) };
      return s;
    });
    try {
      compilePlan(p, { ...resolved(), balancePlan: flatFixed("bp-plan") }, STAMPS);
      throw new Error("expected ScenarioNotExecutableError");
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioNotExecutableError);
      expect((e as ScenarioNotExecutableError).scenarioId).toBe("S0");
      expect((e as Error).message).toContain('the NII stage "st-nii"');
      expect((e as Error).message).toContain("balance-new-business");
    }
  });
  it("compiles when the NII stage reads the balance stage, the wiring Studio's Add balance stage writes", () => {
    const p = twoScenarioPlan();
    p.balancePlan = "bp-plan";
    expect(() => compiled(p, { ...resolved(), balancePlan: flatFixed("bp-plan") }, STAMPS)).not.toThrow();
  });
});

describe("readsCashflowThroughBalance (Polish 1 E1)", () => {
  const st = (id: string, kind: PlanStage["kind"], consumes: string[], produces: string[], dependsOn: string[]) =>
    ({ id, component: "c", kind, consumes, produces, dependsOn }) as unknown as PlanStage;
  it("follows Cashflow edges back through a stage that reads and writes Cashflow", () => {
    const stages = [
      st("cf", "contractual-cashflow", [], ["Cashflow"], []),
      st("bal", "balance-new-business", ["Cashflow"], ["Cashflow"], ["cf"]),
      st("tap", "behavioral", ["Cashflow"], ["Cashflow"], ["bal"]),
      st("nii", "metric", ["Cashflow"], ["NiiResult"], ["tap"]),
    ];
    expect(readsCashflowThroughBalance({ stages }, stages[3]!)).toBe(true);
  });
  it("is false when the chain starts at the contractual stage without passing the balance stage", () => {
    const stages = [
      st("cf", "contractual-cashflow", [], ["Cashflow"], []),
      st("bal", "balance-new-business", ["Cashflow"], ["Cashflow"], ["cf"]),
      st("nii", "metric", ["Cashflow"], ["NiiResult"], ["cf"]),
    ];
    expect(readsCashflowThroughBalance({ stages }, stages[2]!)).toBe(false);
  });
  it("stops on a cycle", () => {
    const stages = [
      st("a", "behavioral", ["Cashflow"], ["Cashflow"], ["b"]),
      st("b", "behavioral", ["Cashflow"], ["Cashflow"], ["a"]),
      st("nii", "metric", ["Cashflow"], ["NiiResult"], ["a"]),
    ];
    expect(readsCashflowThroughBalance({ stages }, stages[2]!)).toBe(false);
  });
});
