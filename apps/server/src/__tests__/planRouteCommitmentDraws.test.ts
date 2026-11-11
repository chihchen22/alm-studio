/**
 * Piece 7 final fix, item 1. The PLAN ROUTE over the seeded commitment book.
 *
 * Why this file exists. `lcr-scenario`, `lcr-regulatory` and `survival-horizon`
 * are custom metrics, and the plan route is the ONLY route that computes one:
 * the workbench run route names no custom metric stage, and this piece's own
 * gate harness called `engine.run` directly, which bypasses the routing gate
 * and L1 licensing entirely. Every number piece 7 measured therefore came from
 * a path no user takes. This file takes that path.
 *
 * It pins three facts, in the order a plan author meets them.
 *
 * 1. R4. Every seeded commitment family DECLARES `draw-utilization`, so the
 *    routing gate demands a draw stage on ANY plan over this book, a
 *    deposits-only one included. The book cannot be run contractual-only.
 * 2. L1. A draw stage naming `alm-draw-rate-model`, the component the shipped
 *    `docs/harness/example-plan.json` names on its `st-draw` row, licenses
 *    nothing: that name resolves to no plugin, so the squeeze set's six
 *    `commitment-draw` bindings are unlicensed and the compile refuses. The
 *    component that licenses is the plugin id, `engine.behavioral.commitment-draw`,
 *    or its short-form alias `engine.commitment-draw`. There is deliberately no
 *    `alm-draw-rate-model` alias; see the note in `plan/componentAliases.ts`.
 * 3. The number. `commitment-draws` on the plan route, in every scenario of the
 *    seeded squeeze slate.
 *
 * THE EXPECTATION IS A HAND-DERIVED LITERAL, not a quantity read back from the
 * seed or recomputed by the code under test. Month 1 of the seeded squeeze
 * draws `rampRates[0]` of what is still undrawn, which at time zero is the
 * whole book:
 *
 *   0.35 x 550,000,000 = 192,500,000
 *
 * and 550,000,000 is the sum of the six seeded undrawn capacities,
 *   60,000,000 + 250,000,000 + 80,000,000 + 40,000,000 + 100,000,000 + 20,000,000.
 *
 * Scenario-invariant on purpose: the draw path is authored and does not read the
 * rate path (the commitment bullet), so the three rate scenarios
 * agreeing is evidence the arm read the draw and not the shock.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { PlanStage, RunPlan } from "@alm/engine/src/contracts/plan";
import type { PortfolioSpec } from "@alm/engine/src/contracts/position";
import type { AssumptionSet } from "@alm/engine/src/contracts/assumptions";
import { compilePlan } from "@alm/engine/src/plan/compile";
import { parseRoutingPolicy } from "@alm/engine/src/plan/parse";
import { PlanRejected } from "@alm/engine/src/plan/compile";
import { UnlicensedBindingError } from "@alm/engine/src/run/executorErrors";
import { BUILTIN_CATALOG } from "@alm/engine/src/plugins/catalog";
import { SHIPPED_LIBRARIES } from "@alm/engine/src/scenario/library";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { repoRoot } from "../config";
import {
  buildCommitmentPortfolio,
  buildLiquiditySqueezeAssumptions,
  buildLiquiditySqueezeScenarios,
} from "../../scripts/seed-store";

/** Hand-derived: 0.35 of the six seeded undrawn capacities summed. */
const MONTH_1_DRAW = 192_500_000;

const SQUEEZE_SCENARIO_IDS = ["SQZ-S0", "SQZ-S200", "SQZ-S-200"];

const HORIZON = 12;

let market: MarketSnapshot;
let book: PortfolioSpec;

beforeAll(async () => {
  market = await loadMarketSnapshot(
    join(repoRoot(), "packages", "kernel", "public", "market_public.json"),
  );
  book = buildCommitmentPortfolio();
}, 120_000);

/**
 * A plan a person could author over this book: curve, funding curve, rate path,
 * the decay chain link, the draw chain link, the contractual pass, the three
 * built-in metrics the envelope requires, and the `lcr-scenario` custom stage.
 *
 * `drawComponent` is the only variable. `withDraw: false` drops the draw stage
 * entirely, which is the deposits-only plan R4 refuses.
 */
function squeezePlan(drawComponent: string, withDraw = true): RunPlan {
  const afterBehavioral = withDraw ? "st-draw" : "st-decay";
  const stages: PlanStage[] = [
    {
      id: "st-curve",
      component: "alm-yield-curve",
      kind: "curve",
      consumes: ["MarketSnapshot"],
      produces: ["ZeroCurve"],
      params: { dayCount: "ACT/360" },
    },
    {
      id: "st-tlp",
      component: "alm-tlp-overlay",
      kind: "curve",
      consumes: ["ZeroCurve", "MarketSnapshot"],
      produces: ["FundingCurve"],
      params: { dayCount: "ACT/360" },
      dependsOn: ["st-curve"],
    },
    {
      id: "st-term",
      component: "engine.rate-path",
      kind: "term-structure",
      consumes: ["ZeroCurve"],
      produces: ["RatePath", "DiscountFactorPath"],
      dependsOn: ["st-curve"],
    },
    {
      id: "st-decay",
      component: "alm-deposit-decay",
      kind: "behavioral",
      consumes: ["Position", "RatePath"],
      produces: ["Position"],
      dependsOn: ["st-term"],
      selector: { behavioralClasses: "decay" },
      disposition: "M",
      tier: "Tier 1",
      feeds: ["eve", "ir-gap", "liq-gap"],
    },
    ...(withDraw
      ? [
          {
            id: "st-draw",
            component: drawComponent,
            kind: "behavioral",
            consumes: ["Position", "RatePath"],
            produces: ["Position"],
            dependsOn: ["st-decay", "st-term"],
            selector: { behavioralClasses: "draw-utilization" },
            disposition: "A",
            tier: "Tier 2",
            feeds: ["liq-gap"],
          } as PlanStage,
        ]
      : []),
    {
      id: "st-cashflow",
      component: "engine.contractual",
      kind: "contractual-cashflow",
      consumes: ["Position", "RatePath"],
      produces: ["Cashflow", "RepricingSchedule"],
      dependsOn: [afterBehavioral, "st-term"],
    },
    {
      id: "st-nii",
      component: "alm-nii",
      kind: "metric",
      consumes: ["Cashflow"],
      produces: ["NiiResult"],
      dependsOn: ["st-cashflow"],
    },
    {
      id: "st-eve",
      component: "alm-eve",
      kind: "metric",
      consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"],
      produces: ["EveResult"],
      dependsOn: ["st-cashflow", "st-curve", "st-tlp", afterBehavioral],
    },
    {
      id: "st-gap",
      component: "alm-gap-analytics",
      kind: "metric",
      consumes: ["Cashflow", "RepricingSchedule", "Position"],
      produces: ["GapResult"],
      dependsOn: ["st-cashflow", afterBehavioral],
    },
    {
      id: "st-lcr",
      component: "engine.metric.lcr-scenario",
      kind: "metric",
      consumes: ["Cashflow", "Position"],
      produces: ["CustomMetricResult"],
      dependsOn: ["st-cashflow", afterBehavioral],
    },
  ];
  return {
    schemaVersion: "1.4.0",
    planId: "PLAN-P7-SQUEEZE",
    label: "Joint liquidity squeeze over the seeded committed-line book",
    authoredBy: "person",
    asOf: book.asOf,
    grid: { horizonMonths: HORIZON },
    inputs: {
      marketSnapshot: "market-public-2026-03-31",
      positionBook: "synthetic-2500-commit-v1",
      routingPolicy: "model-map-default-v1",
      assumptionSets: ["liquidity-squeeze-demo-v1"],
    },
    stages,
    scenarios: buildLiquiditySqueezeScenarios(),
    reports: [{ id: "r-liq", view: "regulatoryView", metrics: ["liq-gap"] }],
    validationRules: {
      typeGate: ["T1", "T2", "T3", "T4", "T5", "T6"],
      routingGate: ["R1", "R2", "R3", "R4"],
    },
  } as RunPlan;
}

function compile(plan: RunPlan, assumptionSets: AssumptionSet[]) {
  const policy = parseRoutingPolicy(
    JSON.parse(readFileSync(join(repoRoot(), "docs", "harness", "model-map.json"), "utf8")),
  );
  return compilePlan(
    plan,
    {
      portfolio: book,
      marketSnapshot: market,
      assumptionSets,
      policy,
      libraries: SHIPPED_LIBRARIES,
      catalog: BUILTIN_CATALOG,
    },
    { runId: "RUN-P7-PLAN", seed: "1", timestamps: { startedAt: "", finishedAt: "" } },
  );
}

describe("the plan route over synthetic-2500-commit-v1", () => {
  it("R4 refuses a deposits-only plan: the book cannot run contractual-only", () => {
    const depositsOnly: AssumptionSet = {
      ...buildLiquiditySqueezeAssumptions(),
      id: "deposits-only-probe",
      bindings: buildLiquiditySqueezeAssumptions().bindings.filter(
        (b) => (b.overlay as { kind: string }).kind !== "commitment-draw",
      ),
    };
    const plan = squeezePlan("engine.behavioral.commitment-draw", false);
    const scenarios = buildLiquiditySqueezeScenarios().map((s) => ({
      ...s,
      assumptionSetId: depositsOnly.id,
    }));
    let thrown: unknown;
    try {
      compile({ ...plan, scenarios } as RunPlan, [depositsOnly]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanRejected);
    const rejected = thrown as PlanRejected;
    const r4 = rejected.routing.failures.filter((f) => f.rule === "R4");
    expect(r4.length, JSON.stringify(rejected.routing.failures)).toBe(1);
    expect(r4[0]!.detail).toContain("draw-utilization");
    expect(r4[0]!.detail).toContain("commit-credit-nonfinancial");
  });

  it("refuses the squeeze when the draw stage names alm-draw-rate-model", () => {
    let thrown: unknown;
    try {
      compile(squeezePlan("alm-draw-rate-model"), [buildLiquiditySqueezeAssumptions()]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnlicensedBindingError);
    const err = thrown as UnlicensedBindingError;
    expect(err.kind).toBe("commitment-draw");
    expect(err.familyId).toContain("commit-");
    expect(err.candidateStageIds).toEqual([]);
    // The refusal must name the component that WOULD license the binding, not
    // only the kind that is unlicensed. This is the message a plan author who
    // copied the shipped `docs/harness/example-plan.json` `st-draw` row reads,
    // and it is the only thing in front of them: that row names
    // `alm-draw-rate-model` correctly, for the revolving-facility utilization
    // rows of the book it targets, so nothing in the example is wrong and the
    // author has no other pointer to the right component.
    //
    // The literal below is HAND-WRITTEN from the plugin declaration in
    // `packages/engine/src/plugins/behavioral.ts`, not read out of
    // COMPONENT_ALIASES, out of the registry, or out of the error itself.
    expect(err.licensingComponent).toBe("engine.behavioral.commitment-draw");
    expect(err.message).toContain('"engine.behavioral.commitment-draw"');
  });

  it.each(["engine.behavioral.commitment-draw", "engine.commitment-draw"])(
    "computes commitment-draws = 192,500,000 on the plan route with component %s",
    (component) => {
      const compiled = compile(squeezePlan(component), [buildLiquiditySqueezeAssumptions()]);
      expect(compiled.compile.passed).toBe(true);
      // No not-implemented tag: every stage of this plan has an executor, so
      // the number below is produced, not tolerated.
      expect(compiled.notImplemented.map((n) => n.layer)).toEqual([]);
      let result;
      try {
        result = buildRunResult(compiled.request, book, {
          ...resolveDefaultContext(),
          harness: compiled.harness,
          plan: squeezePlan(component),
        });
      } finally {
        compiled.harness.dispose();
      }
      const lcr = result.custom?.["lcr-scenario"];
      expect(lcr, "the plan ran the lcr-scenario stage").toBeDefined();
      expect(lcr!.byScenario.map((r) => r.scenarioId)).toEqual(SQUEEZE_SCENARIO_IDS);
      for (const row of lcr!.byScenario) {
        expect(row.values["commitment-draws"], row.scenarioId).toBe(MONTH_1_DRAW);
      }
    },
    180_000,
  );
});
