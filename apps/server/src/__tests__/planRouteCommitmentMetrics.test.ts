/**
 * Piece 7 follow-up, the top parked item: `lcr-regulatory` and
 * `survival-horizon` ON THE PLAN ROUTE, over the seeded commitment book.
 *
 * Why this file exists. `planRouteCommitmentDraws.test.ts` takes the plan
 * route, but names ONE custom metric stage, `lcr-scenario`. The other two
 * commitment-aware metrics were reachable and unpinned: both are registered
 * plugin ids (`packages/engine/src/plugins/metrics.ts`), a full plugin id
 * resolves on a plan stage without an alias, and a plan may name one stage per
 * custom metric, so a single plan can run all three. Nothing did.
 * Their VALUES on that route were therefore unproven, and piece 7 found three
 * defects that only running the real artifact exposed, one of them a total
 * black-out of `lcr-regulatory` on this very book.
 *
 * It pins two facts, each with a hand-derived expectation.
 *
 * 1. `lcr-regulatory` returns a FULL six-key row, and its `commitment-draws`
 *    is 132,000,000, identical in every scenario. The arm rates the UNDRAWN
 *    amount read off the BOOK by `commitment-category`, so it reads no
 *    bindings and cannot move with the rate path. A refusal inside the rating
 *    fold blacks out EVERY key, HQLA included (that is exactly what the gate
 *    caught when the seed carried six categories on one family), so the key
 *    count is part of the pin, not decoration.
 *
 * 2. `survival-horizon` counts a draw at FULL weight, 192,500,000, not the
 *    96,250,000 that the 0.5 `assetInflowFactor` produced before the piece 7
 *    fix. Spec Section 7.4 held that draws reach this metric "for free": true
 *    of the SIGN, false of the MAGNITUDE. This is the ruling that
 *    overrode it, pinned on the route a user takes.
 *
 * THE EXPECTATIONS ARE HAND-DERIVED, not read back from the seed and not
 * recomputed by the code under test. This file declares its own rate table and
 * its own notionals, from 12 CFR 249.32(e)(1) and from the seed's documented
 * capacities, and sums them here. If the seed's book changes, this test is
 * meant to fail.
 *
 *   regulatory outflow, rate x undrawn notional:
 *     0.05 x  60,000,000 =   3,000,000   facility-retail
 *     0.10 x 250,000,000 =  25,000,000   credit-nonfinancial
 *     0.30 x  80,000,000 =  24,000,000   liquidity-nonfinancial
 *     0.50 x  40,000,000 =  20,000,000   facility-depository
 *     0.40 x 100,000,000 =  40,000,000   credit-financial
 *     1.00 x  20,000,000 =  20,000,000   liquidity-financial
 *                          -----------
 *                          132,000,000
 *
 *   month-1 draw, `rampRates[0]` of what is still undrawn, which at time zero
 *   is the whole 550,000,000 book:
 *     0.35 x 550,000,000 = 192,500,000
 *
 * NO GOLDEN THAT NOBODY CAN CHECK. The buffer, the HQLA total and the ratios
 * themselves are engine outputs with no short hand derivation, so this file
 * asserts their INVARIANTS (identical across scenarios, identical across the
 * two runs) and never a magic constant copied out of a prior run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import type { PlanStage, RunPlan } from "@alm/engine/src/contracts/plan";
import type { PortfolioSpec } from "@alm/engine/src/contracts/position";
import type { AssumptionSet } from "@alm/engine/src/contracts/assumptions";
import type { Scenario } from "@alm/engine/src/contracts/scenario";
import { compilePlan } from "@alm/engine/src/plan/compile";
import { parseRoutingPolicy } from "@alm/engine/src/plan/parse";
import { BUILTIN_CATALOG } from "@alm/engine/src/plugins/catalog";
import { SHIPPED_LIBRARIES } from "@alm/engine/src/scenario/library";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { repoRoot } from "../config";
import {
  buildCommitmentPortfolio,
  buildLiquiditySqueezeAssumptions,
  buildLiquiditySqueezeScenarios,
} from "../../scripts/seed-store";

/**
 * 12 CFR 249.32(e)(1) run-off rates against the seeded undrawn capacities,
 * restated here rather than imported, so this check is independent of both the
 * seed file and the rating fold it measures.
 */
const COMMITMENT_TABLE: ReadonlyArray<{ category: string; notional: number; rate: number }> = [
  { category: "facility-retail", notional: 60_000_000, rate: 0.05 },
  { category: "credit-nonfinancial", notional: 250_000_000, rate: 0.1 },
  { category: "liquidity-nonfinancial", notional: 80_000_000, rate: 0.3 },
  { category: "facility-depository", notional: 40_000_000, rate: 0.5 },
  { category: "credit-financial", notional: 100_000_000, rate: 0.4 },
  { category: "liquidity-financial", notional: 20_000_000, rate: 1.0 },
];

/** 550,000,000 of undrawn capacity, summed from the table above. */
const UNDRAWN_TOTAL = COMMITMENT_TABLE.reduce((a, l) => a + l.notional, 0);

/** 132,000,000 of regulatory commitment outflow, summed from the table above. */
const REGULATORY_COMMITMENT_OUTFLOW = COMMITMENT_TABLE.reduce((a, l) => a + l.rate * l.notional, 0);

/** `rampRates[0]` of the squeeze set. Stated here, not read off the seed. */
const MONTH_1_RAMP = 0.35;

/** 192,500,000. The whole book is still undrawn at time zero. */
const MONTH_1_DRAW = MONTH_1_RAMP * UNDRAWN_TOTAL;

/** What a 0.5 `assetInflowFactor` on a contractual obligation would have given. */
const HALF_WEIGHT_DRAW = MONTH_1_DRAW / 2;

const SQUEEZE_SCENARIO_IDS = ["SQZ-S0", "SQZ-S200", "SQZ-S-200"];

const LCR_KEY_IDS = [
  "hqla",
  "outflows-30d",
  "inflows-30d",
  "net-outflows",
  "commitment-draws",
  "lcr",
];

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
 * The sibling file's authorable squeeze plan, plus the two metric stages it
 * does not name. The draw stage is NOT optional here: R4 demands one on any
 * plan over this book, which the sibling file pins.
 */
function metricsPlan(assumptionSetId: string): RunPlan {
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
    {
      id: "st-draw",
      component: "engine.behavioral.commitment-draw",
      kind: "behavioral",
      consumes: ["Position", "RatePath"],
      produces: ["Position"],
      dependsOn: ["st-decay", "st-term"],
      selector: { behavioralClasses: "draw-utilization" },
      disposition: "A",
      tier: "Tier 2",
      feeds: ["liq-gap"],
    },
    {
      id: "st-cashflow",
      component: "engine.contractual",
      kind: "contractual-cashflow",
      consumes: ["Position", "RatePath"],
      produces: ["Cashflow", "RepricingSchedule"],
      dependsOn: ["st-draw", "st-term"],
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
      dependsOn: ["st-cashflow", "st-curve", "st-tlp", "st-draw"],
    },
    {
      id: "st-gap",
      component: "alm-gap-analytics",
      kind: "metric",
      consumes: ["Cashflow", "RepricingSchedule", "Position"],
      produces: ["GapResult"],
      dependsOn: ["st-cashflow", "st-draw"],
    },
    {
      id: "st-lcr-reg",
      component: "engine.metric.lcr-regulatory",
      kind: "metric",
      consumes: ["Cashflow", "Position"],
      produces: ["CustomMetricResult"],
      dependsOn: ["st-cashflow", "st-draw"],
    },
    {
      id: "st-survival",
      component: "engine.metric.survival-horizon",
      kind: "metric",
      consumes: ["Cashflow", "Position"],
      produces: ["CustomMetricResult"],
      dependsOn: ["st-cashflow", "st-draw"],
    },
  ];
  return {
    schemaVersion: "1.4.0",
    planId: "PLAN-P7-METRICS",
    label: "Regulatory LCR and survival horizon over the seeded committed-line book",
    authoredBy: "person",
    asOf: book.asOf,
    grid: { horizonMonths: HORIZON },
    inputs: {
      marketSnapshot: "market-public-2026-03-31",
      positionBook: "synthetic-2500-commit-v1",
      routingPolicy: "model-map-default-v1",
      assumptionSets: [assumptionSetId],
    },
    stages,
    scenarios: scenariosOn(assumptionSetId),
    reports: [{ id: "r-liq", view: "regulatoryView", metrics: ["liq-gap"] }],
    validationRules: {
      typeGate: ["T1", "T2", "T3", "T4", "T5", "T6"],
      routingGate: ["R1", "R2", "R3", "R4"],
    },
  } as RunPlan;
}

function scenariosOn(assumptionSetId: string): Scenario[] {
  return buildLiquiditySqueezeScenarios().map((s) => ({ ...s, assumptionSetId }));
}

/**
 * The squeeze set with MONTH 1 of the draw ramp set to zero and nothing else
 * changed. Later months still draw, so the book still declares and binds
 * `draw-utilization` and R4 is still satisfied: this is not a no-commitment
 * book, it is the same book on a month-1-silent draw path. Only `outflow[0]`
 * differs, which is the one bucket `month1-coverage` reads.
 */
function noMonth1DrawAssumptions(): AssumptionSet {
  const base = buildLiquiditySqueezeAssumptions();
  return {
    ...base,
    id: "squeeze-no-month1-draw-probe",
    bindings: base.bindings.map((b) => {
      const overlay = b.overlay as { kind: string; rampRates?: number[] };
      if (overlay.kind !== "commitment-draw") return b;
      return {
        ...b,
        overlay: { ...overlay, rampRates: [0, ...(overlay.rampRates ?? []).slice(1)] },
      };
    }),
  } as AssumptionSet;
}

function run(set: AssumptionSet) {
  const plan = metricsPlan(set.id);
  const policy = parseRoutingPolicy(
    JSON.parse(readFileSync(join(repoRoot(), "docs", "harness", "model-map.json"), "utf8")),
  );
  const compiled = compilePlan(
    plan,
    {
      portfolio: book,
      marketSnapshot: market,
      assumptionSets: [set],
      policy,
      libraries: SHIPPED_LIBRARIES,
      catalog: BUILTIN_CATALOG,
    },
    { runId: "RUN-P7-METRICS", seed: "1", timestamps: { startedAt: "", finishedAt: "" } },
  );
  expect(compiled.compile.passed).toBe(true);
  // No not-implemented tag: every stage has an executor, so the numbers below
  // are produced, not tolerated.
  expect(compiled.notImplemented.map((n) => n.layer)).toEqual([]);
  try {
    return buildRunResult(compiled.request, book, {
      ...resolveDefaultContext(),
      harness: compiled.harness,
      plan,
    });
  } finally {
    compiled.harness.dispose();
  }
}

describe("lcr-regulatory and survival-horizon on the plan route", () => {
  it(
    "lcr-regulatory returns all six keys and rates the undrawn book at 132,000,000",
    () => {
      const result = run(buildLiquiditySqueezeAssumptions());
      const reg = result.custom?.["lcr-regulatory"];
      expect(reg, "the plan ran the lcr-regulatory stage").toBeDefined();
      expect(reg!.byScenario.map((r) => r.scenarioId)).toEqual(SQUEEZE_SCENARIO_IDS);

      // The hand sum, guarded against a typo in the table above.
      expect(UNDRAWN_TOTAL).toBe(550_000_000);
      expect(REGULATORY_COMMITMENT_OUTFLOW).toBe(132_000_000);

      for (const row of reg!.byScenario) {
        // A refusal inside the rating fold empties EVERY key, so the key set is
        // the first thing to check, before any number.
        expect(Object.keys(row.values).sort(), row.scenarioId).toEqual([...LCR_KEY_IDS].sort());
        expect(row.values["commitment-draws"], row.scenarioId).toBe(REGULATORY_COMMITMENT_OUTFLOW);
      }

      // Scenario invariance, OBSERVED not assumed: the arm reads notional off
      // the book, so neither the commitment outflow nor the whole outflow leg
      // may move with the rate path. The ratio itself may, through inflows.
      const first = reg!.byScenario[0]!.values;
      for (const row of reg!.byScenario) {
        expect(row.values["outflows-30d"], row.scenarioId).toBe(first["outflows-30d"]);
        expect(row.values["hqla"], row.scenarioId).toBe(first["hqla"]);
      }

      // The commitment leg is a real part of the outflow, not a stray key.
      expect(first["outflows-30d"]!).toBeGreaterThan(REGULATORY_COMMITMENT_OUTFLOW);
    },
    180_000,
  );

  it(
    "survival-horizon counts the month-1 draw at its full 192,500,000",
    () => {
      const withDraw = run(buildLiquiditySqueezeAssumptions());
      const noDraw = run(noMonth1DrawAssumptions());

      const rows = (r: typeof withDraw) => {
        const sh = r.custom?.["survival-horizon"];
        expect(sh, "the plan ran the survival-horizon stage").toBeDefined();
        return sh!.byScenario;
      };
      const a = rows(withDraw);
      const b = rows(noDraw);
      expect(a.map((r) => r.scenarioId)).toEqual(SQUEEZE_SCENARIO_IDS);
      expect(MONTH_1_DRAW).toBe(192_500_000);

      for (let i = 0; i < a.length; i++) {
        const id = a[i]!.scenarioId;
        expect(b[i]!.scenarioId).toBe(id);
        const va = a[i]!.values;
        const vb = b[i]!.values;
        for (const key of ["buffer", "min-headroom", "month1-coverage"]) {
          expect(va[key], `${id} ${key}`).toBeDefined();
          expect(vb[key], `${id} ${key}`).toBeDefined();
        }
        // The buffer is an as-of balance and cannot move with the draw path.
        // Identical on both sides is what makes the delta below the draw ALONE.
        expect(vb["buffer"], id).toBe(va["buffer"]);

        // Recover month 1's net outflow: the metric reports buffer over it.
        const outflowWith = va["buffer"]! / va["month1-coverage"]!;
        const outflowWithout = vb["buffer"]! / vb["month1-coverage"]!;
        const drawn = outflowWith - outflowWithout;
        // Tolerance is float residue on a 2e8 quantity recovered by division,
        // not slack in the expectation: the gate measured 1e-8 of drift.
        expect(drawn, id).toBeCloseTo(MONTH_1_DRAW, 3);
        // The pre-fix half-weight value is 96,250,000 away; no tolerance that
        // admits the correct answer could admit it.
        expect(Math.abs(drawn - HALF_WEIGHT_DRAW), id).toBeGreaterThan(1_000_000);
      }
    },
    240_000,
  );
});
