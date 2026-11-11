/**
 * Attribution engine acceptance tests.
 *
 * The decomposition is a fixed-order cumulative peel over a caller-supplied
 * metric evaluator (see computeAttribution.ts). These tests exercise the four
 * acceptance properties:
 *   - the residual identity holds exactly (===, never a tolerance);
 *   - a single-driver stress lands the whole delta on that driver;
 *   - the peel is order-fixed and re-running is byte-identical;
 *   - the residual is carried explicitly, not forced to zero.
 *
 * The evaluators here are synthetic additive/interaction models standing in for
 * the engine's per-config re-run: the peel logic under test is agnostic to how a
 * metric value is produced, so a deterministic closed form is the honest way to
 * probe it in isolation.
 */
import { describe, expect, it } from "vitest";
import type { AttributionDriver } from "../../contracts/results";
import {
  computeAttribution,
  PEEL_ORDER,
  type AttributionInput,
  type FamilyMetricEvaluator,
  type HeadlineTarget,
} from "../computeAttribution";

/** Left-fold sum in array order: the exact "sum(contributions)" the contract means. */
function foldSum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/**
 * Additive evaluator: family value is its base plus the sum of the applied
 * drivers' per-driver effects. With additive effects the cumulative peel returns
 * each driver's own effect regardless of order (no interaction).
 */
function additiveEvaluator(
  familyBase: Record<string, number>,
  effects: Record<string, Partial<Record<AttributionDriver, number>>>,
): FamilyMetricEvaluator {
  return (familyId, applied) => {
    let v = familyBase[familyId] ?? 0;
    for (const d of applied) v += effects[familyId]?.[d] ?? 0;
    return v;
  };
}

describe("computeAttribution", () => {
  it("exposes the frozen driver enum as the fixed peel order", () => {
    expect([...PEEL_ORDER]).toEqual([
      "rate",
      "volume",
      "mix",
      "prepay",
      "deposit-beta",
      "decay",
      "new-business",
    ]);
  });

  it("holds the residual identity exactly, even when the residual is nonzero", () => {
    // Two families, several nonzero driver effects, and a deliberate unmodeled
    // gap at the scenario end so the residual is nonzero.
    const familyBase = { A: 1000, B: -400 };
    const effects = {
      A: { rate: 120, prepay: -15, "deposit-beta": 30 },
      B: { rate: -60, decay: 8, "new-business": 12 },
    } as Record<string, Partial<Record<AttributionDriver, number>>>;
    const evaluate = additiveEvaluator(familyBase, effects);

    const baseValue = familyBase.A + familyBase.B;
    // The peel reconstructs base + all effects; the actual scenario is 250 higher
    // (an effect no enumerated driver captures).
    const reconstructed =
      baseValue + (120 - 15 + 30) + (-60 + 8 + 12);
    const unmodeled = 250;
    const scenarioValue = reconstructed + unmodeled;

    const target: HeadlineTarget = {
      metric: "eve",
      scenarioId: "up200",
      baseValue,
      scenarioValue,
      families: ["A", "B"],
      evaluate,
    };
    const input: AttributionInput = { headlines: [target] };

    const [h] = computeAttribution(input).headlines;
    const sum = foldSum(h.contributions.map((c) => c.amount));
    const totalDelta = h.scenarioValue - h.baseValue;

    // Contract identity: residual === sum(contributions) - totalDelta, exact.
    expect(h.totalDelta).toBe(totalDelta);
    expect(h.residual).toBe(sum - totalDelta);
    // And the residual is genuinely nonzero: it carries the unmodeled 250.
    expect(h.residual).toBe(-unmodeled);
  });

  it("attributes a single-driver (beta-only) stress entirely to deposit-beta", () => {
    // Nothing differs between base and scenario except the deposit betas.
    const familyBase = { MMA: 500, SAV: 220 };
    const effects = {
      MMA: { "deposit-beta": -140 },
      SAV: { "deposit-beta": -35 },
    } as Record<string, Partial<Record<AttributionDriver, number>>>;
    const evaluate = additiveEvaluator(familyBase, effects);

    const baseValue = familyBase.MMA + familyBase.SAV;
    const scenarioValue = baseValue + (-140) + (-35);

    const [h] = computeAttribution({
      headlines: [
        {
          metric: "nii-12m",
          scenarioId: "up200",
          baseValue,
          scenarioValue,
          families: ["MMA", "SAV"],
          evaluate,
        },
      ],
    }).headlines;

    const beta = h.contributions.filter((c) => c.driver === "deposit-beta");
    const other = h.contributions.filter((c) => c.driver !== "deposit-beta");

    // Every non-beta driver contributes exactly zero.
    for (const c of other) expect(c.amount).toBe(0);
    // The beta rows carry the whole delta.
    expect(foldSum(beta.map((c) => c.amount))).toBe(h.totalDelta);
    // With nothing unmodeled, the residual is exactly zero (not chased, just is).
    expect(h.residual).toBe(0);
  });

  it("absorbs a driver interaction into the later driver under the fixed order, residual zero", () => {
    // rate and deposit-beta interact: turning both on adds 30 beyond their sum.
    // The fixed order peels rate before deposit-beta, so the interaction lands on
    // deposit-beta (the driver active when the cross term switches on). Had the
    // order been reversed, rate would carry the 30 instead; that is exactly the
    // order dependence the fixed peel order pins down.
    const base = 1000;
    const evaluate: FamilyMetricEvaluator = (_familyId, applied) => {
      const hasRate = applied.includes("rate");
      const hasBeta = applied.includes("deposit-beta");
      let v = base;
      if (hasRate) v += 100;
      if (hasBeta) v += 50;
      if (hasRate && hasBeta) v += 30;
      return v;
    };

    const scenarioValue = base + 100 + 50 + 30; // evaluate(ALL) for the one family
    const [h] = computeAttribution({
      headlines: [
        {
          metric: "eve",
          scenarioId: "up100",
          baseValue: base,
          scenarioValue,
          families: ["X"],
          evaluate,
        },
      ],
    }).headlines;

    const amt = (d: AttributionDriver) =>
      h.contributions.find((c) => c.driver === d)?.amount;
    expect(amt("rate")).toBe(100);
    expect(amt("deposit-beta")).toBe(80); // 50 own + 30 interaction
    expect(h.residual).toBe(0);
  });

  it("emits one row per (family, driver) in family order then fixed peel order", () => {
    const evaluate = additiveEvaluator({ A: 10, B: 20 }, {});
    const [h] = computeAttribution({
      headlines: [
        {
          metric: "eve",
          scenarioId: "up100",
          baseValue: 30,
          scenarioValue: 30,
          families: ["A", "B"],
          evaluate,
        },
      ],
    }).headlines;

    expect(h.contributions).toHaveLength(2 * PEEL_ORDER.length);
    // Family A's seven drivers first, in peel order, then family B's.
    const famA = h.contributions.slice(0, PEEL_ORDER.length);
    const famB = h.contributions.slice(PEEL_ORDER.length);
    expect(famA.every((c) => c.familyId === "A")).toBe(true);
    expect(famB.every((c) => c.familyId === "B")).toBe(true);
    expect(famA.map((c) => c.driver)).toEqual([...PEEL_ORDER]);
    expect(famB.map((c) => c.driver)).toEqual([...PEEL_ORDER]);
  });

  it("preserves metric and scenarioId per headline and decomposes each independently", () => {
    const evaluate = additiveEvaluator(
      { A: 100 },
      { A: { rate: 10 } } as Record<string, Partial<Record<AttributionDriver, number>>>,
    );
    const mk = (metric: HeadlineTarget["metric"], scenarioId: string): HeadlineTarget => ({
      metric,
      scenarioId,
      baseValue: 100,
      scenarioValue: 110,
      families: ["A"],
      evaluate,
    });
    const result = computeAttribution({
      headlines: [mk("nii-12m", "up200"), mk("nii-24m", "up200"), mk("eve", "down200")],
    });
    expect(result.headlines.map((h) => [h.metric, h.scenarioId])).toEqual([
      ["nii-12m", "up200"],
      ["nii-24m", "up200"],
      ["eve", "down200"],
    ]);
    for (const h of result.headlines) {
      expect(h.contributions.find((c) => c.driver === "rate")?.amount).toBe(10);
      expect(h.residual).toBe(0);
    }
  });

  it("is deterministic: re-running the same input is byte-identical", () => {
    const evaluate = additiveEvaluator(
      { A: 1000, B: 500 },
      {
        A: { rate: 40, mix: -5, "deposit-beta": 12 },
        B: { rate: -20, decay: 7 },
      } as Record<string, Partial<Record<AttributionDriver, number>>>,
    );
    const input: AttributionInput = {
      headlines: [
        {
          metric: "eve",
          scenarioId: "up200",
          baseValue: 1500,
          scenarioValue: 1500 + 40 - 5 + 12 - 20 + 7,
          families: ["A", "B"],
          evaluate,
        },
      ],
    };
    const a = computeAttribution(input);
    const b = computeAttribution(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("throws on a non-finite evaluator output rather than emitting NaN", () => {
    const evaluate: FamilyMetricEvaluator = () => Number.NaN;
    expect(() =>
      computeAttribution({
        headlines: [
          {
            metric: "eve",
            scenarioId: "up100",
            baseValue: 0,
            scenarioValue: 0,
            families: ["A"],
            evaluate,
          },
        ],
      }),
    ).toThrow(/non-finite/i);
  });
});
