/**
 * deriveBalancePlan against the real seeded books.
 * The plans come from the seed's own builders. The seed does not write them yet.
 * Counts and values are restated.
 */
import { describe, expect, it } from "vitest";
import { BalancePlanDerivationError, deriveBalancePlan, lowerBalancePlan } from "@alm/engine";
import type { BalancePlan, PortfolioSpec } from "@alm/engine";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { buildVanillaPortfolio } from "@alm/data";
import {
  BALANCE_SHOCK_OPS,
  buildBalanceShockPlan,
  buildDemoBalancePlan,
  buildHedgedPortfolio,
  buildLcrPortfolio,
  buildSyntheticPortfolio,
  SEED_IDS,
} from "../../scripts/seed-store";

const openingsOf = (book: PortfolioSpec): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of book.positions) m.set(p.familyId, (m.get(p.familyId) ?? 0) + p.terms.notional);
  return m;
};

const op = (familyId: string, kind: string, value: number, month?: number) => ({
  target: month === undefined ? { familyId } : { familyId, month },
  op: kind,
  value,
});

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BalancePlanDerivationError);
    return (e as BalancePlanDerivationError).problems;
  }
  throw new Error("expected a refusal");
}

describe("balance derivation on the seeded books", () => {
  it("S1: the demo base plan is the restated literal and lowers flat on every seeded book", () => {
    expect(buildDemoBalancePlan()).toEqual({
      schemaVersion: "1.0.0",
      id: "balance-targets-demo-v1",
      label: "Deposit targets held flat at month 12 on the synthetic book (demonstration values)",
      asOf: "2026-03-31",
      targets: [
        { familyId: "dda", path: [{ month: 12, balance: 97_178_194 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
        { familyId: "mma", path: [{ month: 12, balance: 156_318_023 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
      ],
      unlistedFamilies: "runoff",
    });
    expect(SEED_IDS.demoBalancePlan).toBe("balance-targets-demo-v1");
    expect(SEED_IDS.balanceShockPlan).toBe("balance-shock-demo-v1");
    for (const book of [buildSyntheticPortfolio(), buildLcrPortfolio(), buildHedgedPortfolio()]) {
      const rules = lowerBalancePlan(buildDemoBalancePlan(), openingsOf(book), 360, book.asOf);
      expect(rules).toEqual([
        { familyId: "dda", reinvest: "flat", spreadOverIndexBp: -100, termMonths: 12 },
        { familyId: "mma", reinvest: "flat", spreadOverIndexBp: -100, termMonths: 12 },
      ]);
    }
  });

  it("S2: the seeded shock plan scales dda by 0.9 at month 12 and leaves mma alone", () => {
    const plan = buildBalanceShockPlan();
    const base = buildDemoBalancePlan();
    expect(plan.id).toBe("balance-shock-demo-v1");
    expect(plan.label).toBe("dda target 10% lower at month 12 on the deposit targets (demonstration values, NOT calibrated)");
    expect(plan.targets[0]!.path).toEqual([{ month: 12, balance: 87_460_374.6 }]);
    expect(plan.targets[1]).toEqual(base.targets[1]);
    expect(plan.derivedFrom).toEqual({
      baseId: "balance-targets-demo-v1",
      baseContentHash: contentHash(base),
      ops: [{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }],
    });
    expect(BALANCE_SHOCK_OPS).toEqual([{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }]);
    const book = buildSyntheticPortfolio();
    const rules = lowerBalancePlan(plan, openingsOf(book), 360, book.asOf);
    expect(rules[0]!.reinvest).toBe("growth");
    expect(rules[0]!.monthlyGrowthRate).toBeCloseTo(-0.008741610954696721, 15);
    expect(rules[1]).toEqual({ familyId: "mma", reinvest: "flat", spreadOverIndexBp: -100, termMonths: 12 });
  });

  it("S3: on a book without dda and mma the derivation is refused for both targets", () => {
    const p = problemsOf(() => deriveBalancePlan(buildDemoBalancePlan(), BALANCE_SHOCK_OPS, { book: buildVanillaPortfolio() }));
    expect(p).toEqual([
      { at: "targets[0]", message: 'balance plan target for family "dda": family "dda" has no opening balance in the book' },
      { at: "targets[1]", message: 'balance plan target for family "mma": family "mma" has no opening balance in the book' },
    ]);
  });

  it("S4: mma scale 1.1 then add -5,000,000 composes through the 12-digit rounding", () => {
    const r = deriveBalancePlan(buildDemoBalancePlan(), [op("mma", "scale", 1.1), op("mma", "add", -5_000_000)], {
      book: buildSyntheticPortfolio(),
    });
    expect(r.plan.targets[1]!.path).toEqual([{ month: 12, balance: 166_949_825.3 }]);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ familyId: "mma", month: 12, from: 156_318_023, to: 166_949_825.3, ops: [0, 1] });
  });

  it("S5: lowering dda to zero is refused as a zero-ending target", () => {
    const p = problemsOf(() =>
      deriveBalancePlan(buildDemoBalancePlan(), [op("dda", "add", -97_178_194)], { book: buildSyntheticPortfolio() }),
    );
    expect(p).toHaveLength(1);
    expect(p[0]!.at).toBe("targets[0]");
    expect(p[0]!.message).toContain("ends at zero balance at month 12");
  });

  it("S6: a multi-knot stored path lowers while geometric, and any effective op is refused", () => {
    const base = buildDemoBalancePlan();
    const multi: BalancePlan = {
      ...base,
      targets: [
        { ...base.targets[0]!, path: [{ month: 12, balance: 109_502_821.382 }, { month: 24, balance: 123_390_520.004 }] },
        base.targets[1]!,
      ],
    };
    const book = buildSyntheticPortfolio();
    const rules = lowerBalancePlan(multi, openingsOf(book), 360, book.asOf);
    expect(rules[0]!.reinvest).toBe("growth");
    expect(rules[0]!.monthlyGrowthRate).toBeCloseTo(0.01, 9);
    const refusal = 'balance plan target for family "dda" at month 12: path is not a single geometric growth';
    for (const ops of [[op("dda", "scale", 1.1)], [op("dda", "set", 120_000_000, 24)]]) {
      const p = problemsOf(() => deriveBalancePlan(multi, ops, { book }));
      expect(p).toHaveLength(1);
      expect(p[0]!.at).toBe("targets[0]");
      expect(p[0]!.message.startsWith(refusal)).toBe(true);
    }
  });

  it("S7: the default id restates the formula", () => {
    const base = buildDemoBalancePlan();
    const r = deriveBalancePlan(base, BALANCE_SHOCK_OPS, { book: buildSyntheticPortfolio() });
    const want =
      "derived-bp-" +
      contentHash({
        baseId: "balance-targets-demo-v1",
        baseContentHash: contentHash(base),
        ops: [{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }],
      }).slice(0, 12);
    expect(r.plan.id).toBe(want);
  });
});
