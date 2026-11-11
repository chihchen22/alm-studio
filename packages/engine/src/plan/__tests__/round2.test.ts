/**
 * The round-2 rulings and the final-review must-fixes, one case each. Each
 * assertion is the ruling's own words turned into a check; nothing here is a
 * regression test for code written alongside it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { mountProfile } from "@alm/harness";
import type { NotImplemented } from "../../contracts/errors";
import type { RunResult } from "../../contracts/run";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { AS_OF, baseAssumptions, loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { resolveDefaultContext } from "../../run/engine";
import { buildRunResult } from "../../run/orchestrate";
import { compilePlan, PlanNotExecutableError, registryProducers, ScenarioNotExecutableError } from "../compile";
import { BalancePlanUnsupported, lowerBalancePlan } from "../lowerBalancePlan";
import { mergePlanTags } from "../mergePlanTags";
import { parseRunPlan, PlanShapeError } from "../parse";
import { resolveScenarios } from "../resolveScenarios";
import { typeGate } from "../typeGate";
import { fixturePlan, loadPolicy, withBalanceStage } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

const STAMPS = { runId: "R", seed: "1", timestamps: { startedAt: "", finishedAt: "" } };
const producers = () => registryProducers(mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG));
const resolved = () => ({
  portfolio: twoSidedBook(),
  marketSnapshot: market,
  assumptionSets: [baseAssumptions()],
  policy: loadPolicy(),
  libraries: SHIPPED_LIBRARIES,
  catalog: BUILTIN_CATALOG,
});

describe("ruling 4: the checked lines state the result", () => {
  it("says whether asOf matched, not that it matched", () => {
    const plan = fixturePlan();
    plan.asOf = "1999-01-01";
    const report = typeGate(plan, "2026-01-01", producers());
    const line = report.checked.find((l) => l.startsWith("T3"))!;
    expect(line).toContain("differs from");
    expect(line).not.toContain("matches portfolio");
  });

  /**
   * T1 stopped skipping in piece 1c: it reads the DIRECT dependsOn, one hop, so
   * a cycle is T4's to report and T1 still answers for every edge. T5 walks the
   * closure and still says when it could not.
   */
  it("appends T5 skipped when the graph has a cycle, and still checks T1", () => {
    const plan = fixturePlan();
    plan.stages[0]!.dependsOn = [plan.stages[plan.stages.length - 1]!.id];
    plan.stages[plan.stages.length - 1]!.dependsOn = [plan.stages[0]!.id];
    const report = typeGate(plan, plan.asOf, producers());
    expect(report.checked).toContain("T5 skipped: the dependency graph has a cycle");
    expect(report.checked.some((l) => l.startsWith("T1 every consumed type resolved"))).toBe(true);
    expect(report.checked.some((l) => l.includes("skipped: the dependency graph has a cycle") && l.startsWith("T1"))).toBe(false);
  });
});

describe("ruling 6: T2 accepts only the day count the engine executes", () => {
  it("passes ACT/360", () => {
    const plan = fixturePlan();
    const curve = plan.stages.find((s) => s.kind === "curve")!;
    curve.params = { ...curve.params, dayCount: "ACT/360" };
    expect(typeGate(plan, plan.asOf, producers()).failures.filter((f) => f.rule === "T2")).toEqual([]);
  });

  it("fails 30/360 naming both the declared and the executed convention", () => {
    const plan = fixturePlan();
    const curve = plan.stages.find((s) => s.kind === "curve")!;
    curve.params = { ...curve.params, dayCount: "30/360" };
    const failure = typeGate(plan, plan.asOf, producers()).failures.find((f) => f.rule === "T2")!;
    expect(failure.detail).toContain("30/360");
    expect(failure.detail).toContain("ACT/360");
  });
});

describe("ruling 7: environment arrays carry units and must cover the horizon", () => {
  it("refuses an environment array shorter than the horizon, naming the scenario and the length", () => {
    try {
      resolveScenarios(
        [{ id: "S0", label: "S0", rateSpec: { kind: "base" }, environment: { unemploymentPath: [0.04, 0.041] } }],
        SHIPPED_LIBRARIES,
        () => ({ mode: "static", rules: [] }),
        "AS-BASE",
        360,
      );
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioNotExecutableError);
      expect((err as ScenarioNotExecutableError).reason).toContain("2");
      expect((err as ScenarioNotExecutableError).reason).toContain("360");
    }
  });
});

describe("ruling 11: a balance target ending at zero is refused", () => {
  it("says to omit the family instead", () => {
    const opening = new Map([["FIXED", 5_000_000]]);
    try {
      lowerBalancePlan(
        {
          schemaVersion: "1.0.0",
          id: "bp-zero",
          label: "runs to zero",
          asOf: "2026-01-01",
          targets: [{ familyId: "FIXED", path: [{ month: 360, balance: 0 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 12 } }],
          unlistedFamilies: "runoff",
        },
        opening,
        360,
        "2026-01-01",
      );
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(BalancePlanUnsupported);
      expect((err as Error).message).toContain("omit the family");
    }
  });
});

describe("ruling 12: a scenario that cannot run as declared produces no numbers", () => {
  it("refuses ramp timing, naming the scenario", () => {
    const plan = fixturePlan();
    plan.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      { id: "R200", label: "R200", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 12 } },
    ];
    try {
      compilePlan(plan, resolved(), STAMPS);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioNotExecutableError);
      expect((err as ScenarioNotExecutableError).scenarioId).toBe("R200");
      expect((err as ScenarioNotExecutableError).reason).toContain("ramp");
    }
  });

  it("keeps the typed ramp entry in the shipped library", () => {
    const ramp = SHIPPED_LIBRARIES.find((l) => l.id === "ramp-200-12m-v1")!;
    expect(ramp.scenarios[0]!.timing).toEqual({ kind: "ramp", months: 12 });
  });

  it("refuses environment paths, naming the scenario", () => {
    const plan = fixturePlan();
    const path = Array.from({ length: plan.grid.horizonMonths }, () => 1);
    plan.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" }, environment: { housePriceIndexPath: path } },
    ];
    expect(() => compilePlan(plan, resolved(), STAMPS)).toThrow(ScenarioNotExecutableError);
    // Re-expectation: environment text names the mapping.
    expect(() => compilePlan(plan, resolved(), STAMPS)).toThrow(
      "environment paths on a scenario are refused; a macro path is market data, mapped in the assumption set's macroBindings, and every scenario in a run shares the base's path",
    );
  });
});

describe("ruling 14: the plan reference carries the policy and balance-plan hashes", () => {
  /** A flat target on the fixture book's FIXED family, as of the same date. */
  const balancePlan = () => ({
    schemaVersion: "1.0.0" as const,
    id: "bp-fixture",
    label: "FIXED held flat",
    asOf: AS_OF,
    targets: [{
      familyId: "FIXED",
      path: [{ month: 360, balance: 6_000_000 }],
      newBusinessPricing: { spreadOverIndexBp: 100, termMonths: 60 },
    }],
    unlistedFamilies: "runoff" as const,
  });

  it("stamps policyHash on the request and copies it into provenance", () => {
    const compiled = compilePlan(fixturePlan(), resolved(), STAMPS);
    expect(compiled.request.plan!.policyHash).toMatch(/^[0-9a-f]{64}$/);
    const result = buildRunResult(compiled.request, twoSidedBook(), resolveDefaultContext());
    expect(result.provenance.policyHash).toBe(compiled.request.plan!.policyHash);
    compiled.harness.dispose();
  });

  it("stamps balancePlanHash when the plan declares one, and carries it to provenance", () => {
    // The balance plan makes every scenario dynamic, which needs the balance stage.
    const compiled = compilePlan(withBalanceStage(fixturePlan()), { ...resolved(), balancePlan: balancePlan() }, STAMPS);
    const hash = compiled.request.plan!.balancePlanHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const result = buildRunResult(compiled.request, twoSidedBook(), resolveDefaultContext());
    expect(result.provenance.balancePlanHash).toBe(hash);
    compiled.harness.dispose();
  });

  it("writes no balancePlanHash key at all when the plan declares none", () => {
    const compiled = compilePlan(fixturePlan(), resolved(), STAMPS);
    expect(Object.hasOwn(compiled.request.plan!, "balancePlanHash")).toBe(false);
    const result = buildRunResult(compiled.request, twoSidedBook(), resolveDefaultContext());
    expect(Object.hasOwn(result.provenance, "balancePlanHash")).toBe(false);
    compiled.harness.dispose();
  });
});

describe("a compile refusal carries the run log it had written", () => {
  it("hands a ramp refusal its refuse entry, naming the scenario", () => {
    const plan = fixturePlan();
    plan.scenarios = [
      { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      { id: "R200", label: "R200", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 12 } },
    ];
    try {
      compilePlan(plan, resolved(), STAMPS);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioNotExecutableError);
      const log = (err as ScenarioNotExecutableError).runLog!;
      const refusal = log.find((e) => e.t === "refuse")!;
      expect(refusal).toBeDefined();
      expect(refusal.error).toContain("ramp timing over 12 months");
      expect(refusal.ids.scenarioId).toBe("R200");
    }
  });

  it("hands a sole-producer refusal its log too", () => {
    const plan = fixturePlan();
    // A stage nothing executes whose output another stage reads: ruling 13's
    // refusal arm, raised inside the same guard as the scenario refusals. No
    // mounted plugin declares the component, and nothing else in the profile
    // produces the ClientRatePath the metric now reads.
    plan.stages.push({ id: "st-hw", component: "alm-hull-white", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["ClientRatePath"], dependsOn: ["st-curve"] });
    const nii = plan.stages.find((s) => s.id === "st-nii")!;
    nii.consumes = [...nii.consumes, "ClientRatePath"];
    nii.dependsOn = [...(nii.dependsOn ?? []), "st-hw"];
    try {
      compilePlan(plan, resolved(), STAMPS);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanNotExecutableError);
      const log = (err as PlanNotExecutableError).runLog!;
      const refusal = log.find((e) => e.t === "refuse")!;
      expect(refusal).toBeDefined();
      expect(refusal.error).toContain("alm-hull-white");
      expect(refusal.ids.stageId).toBe("st-hw");
    }
  });
});

describe("must-fix 3: the balance plan must be as of the portfolio", () => {
  it("refuses a balance plan whose asOf differs, naming both dates", () => {
    const opening = new Map([["FIXED", 5_000_000]]);
    try {
      lowerBalancePlan(
        {
          schemaVersion: "1.0.0",
          id: "bp-1",
          label: "flat",
          asOf: "2025-12-31",
          targets: [{ familyId: "FIXED", path: [{ month: 360, balance: 5_000_000 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 12 } }],
          unlistedFamilies: "runoff",
        },
        opening,
        360,
        "2026-01-01",
      );
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(BalancePlanUnsupported);
      expect((err as Error).message).toContain("2025-12-31");
      expect((err as Error).message).toContain("2026-01-01");
    }
  });
});

describe("must-fix 4: newBusiness rules are validated, not cast", () => {
  const planWithRule = (rule: unknown) => {
    const plan = JSON.parse(JSON.stringify(fixturePlan())) as Record<string, unknown>;
    plan.scenarios = [{ id: "S0", label: "S0", rateSpec: { kind: "base" }, newBusiness: { mode: "dynamic", rules: [rule] } }];
    return plan;
  };

  it("names the field when familyId is missing", () => {
    expect(() => parseRunPlan(planWithRule({ reinvest: "flat" }))).toThrow(PlanShapeError);
    expect(() => parseRunPlan(planWithRule({ reinvest: "flat" }))).toThrow("newBusiness.rules[0].familyId");
  });

  it("names the field on a reinvest outside the enum", () => {
    expect(() => parseRunPlan(planWithRule({ familyId: "FIXED", reinvest: "hold" }))).toThrow(
      "newBusiness.rules[0].reinvest",
    );
  });

  it("refuses a non-finite monthlyGrowthRate", () => {
    expect(() => parseRunPlan(planWithRule({ familyId: "FIXED", reinvest: "growth", monthlyGrowthRate: "fast" }))).toThrow(
      "newBusiness.rules[0].monthlyGrowthRate",
    );
  });

  it("accepts a well-formed growth rule", () => {
    const plan = parseRunPlan(planWithRule({ familyId: "FIXED", reinvest: "growth", monthlyGrowthRate: 0.001 }));
    expect(plan.scenarios.length).toBe(1);
  });
});

describe("scenario label is optional and defaults to the id", () => {
  it("parses a definition with no label", () => {
    const plan = JSON.parse(JSON.stringify(fixturePlan())) as Record<string, unknown>;
    plan.scenarios = [{ id: "S0", rateSpec: { kind: "base" } }];
    expect(parseRunPlan(plan).scenarios.length).toBe(1);
  });

  it("gives the compiled scenario the id as its label", () => {
    const { scenarios } = resolveScenarios(
      [{ id: "S0", rateSpec: { kind: "base" } }],
      SHIPPED_LIBRARIES,
      () => ({ mode: "static", rules: [] }),
      "AS-BASE",
      360,
    );
    expect(scenarios[0]!.label).toBe("S0");
  });
});

describe("must-fix 1: per-item tag layers survive the merge", () => {
  const result = (): RunResult => ({
    schemaVersion: "1.4.0",
    provenance: {} as RunResult["provenance"],
    cashflows: {} as RunResult["cashflows"],
    nii: {} as RunResult["nii"],
    eve: {} as RunResult["eve"],
    gap: {} as RunResult["gap"],
    attribution: {} as RunResult["attribution"],
    notImplemented: [],
  });
  const tag = (layer: string): NotImplemented => ({ _tag: "not-implemented", layer, reason: layer });

  it("keeps two tags whose layers carry different item ids", () => {
    const merged = mergePlanTags(result(), [tag("plan.stage.st-a"), tag("plan.stage.st-b")]);
    expect(merged.notImplemented.map((t) => t.layer)).toEqual(["plan.stage.st-a", "plan.stage.st-b"]);
  });

  it("drops a genuine duplicate layer once", () => {
    const merged = mergePlanTags(result(), [tag("plan.stage.st-a"), tag("plan.stage.st-a")]);
    expect(merged.notImplemented.length).toBe(1);
  });

  it("does not append a plan tag the run already carries", () => {
    const base = { ...result(), notImplemented: [tag("plan.stage.st-a")] };
    expect(mergePlanTags(base, [tag("plan.stage.st-a")]).notImplemented.length).toBe(1);
  });
});
