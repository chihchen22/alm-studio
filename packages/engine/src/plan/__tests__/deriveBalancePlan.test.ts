/**
 * deriveBalancePlan. Fixture and expected values are
 * restated here; nothing is imported from the code under test beyond the
 * function itself.
 */
import { describe, expect, it } from "vitest";
import type { BalancePlan } from "../../contracts/balancePlan";
import { contentHash } from "../../runtime/contentHash";
import { BalancePlanDerivationError, BALANCE_DERIVED_ID_PREFIX, deriveBalancePlan, derivedBalancePlanId } from "../deriveBalancePlan";
import { lowerBalancePlan } from "../lowerBalancePlan";

const pos = (familyId: string, notional: number) => ({ familyId, terms: { notional } });
const BOOK = { asOf: "2026-03-31", positions: [pos("dda", 60_000_000), pos("dda", 40_000_000), pos("mma", 50_000_000)] };
const BASE: BalancePlan = {
  schemaVersion: "1.0.0",
  id: "bp-fixture-v1",
  label: "Fixture",
  asOf: "2026-03-31",
  targets: [
    { familyId: "dda", path: [{ month: 12, balance: 100_000_000 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
    {
      familyId: "mma",
      path: [{ month: 6, balance: 50_000_000 }, { month: 12, balance: 50_000_000 }],
      newBusinessPricing: { spreadOverIndexBp: -50, termMonths: 24 },
    },
  ],
  unlistedFamilies: "runoff",
};
const OPEN = new Map([["dda", 100_000_000], ["mma", 50_000_000]]);

const op = (familyId: string, kind: string, value: unknown, month?: number) => ({
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

const PRICING_MSG = "new-business pricing cannot be shocked; a balance shock changes the target balance path only";
const G_09 = -0.008741610954696721;

describe("deriveBalancePlan", () => {
  it("E1: scale dda by 0.9 with no month changes the one knot and lowers to growth", () => {
    const r = deriveBalancePlan(BASE, [op("dda", "scale", 0.9)], { book: BOOK });
    expect(r.plan.targets[0]!.path).toEqual([{ month: 12, balance: 90_000_000 }]);
    expect(r.changes).toEqual([{ targetIndex: 0, familyId: "dda", month: 12, from: 100_000_000, to: 90_000_000, ops: [0] }]);
    expect(r.rules[0]).toMatchObject({ familyId: "dda", spreadOverIndexBp: -100, termMonths: 12, reinvest: "growth" });
    expect(r.rules[0]!.monthlyGrowthRate).toBeCloseTo(G_09, 15);
    expect(r.rules[1]).toEqual({ familyId: "mma", spreadOverIndexBp: -50, termMonths: 24, reinvest: "flat" });
  });

  it("E2: add -2,500,000 at month 12", () => {
    const r = deriveBalancePlan(BASE, [op("dda", "add", -2_500_000, 12)], { book: BOOK });
    expect(r.plan.targets[0]!.path).toEqual([{ month: 12, balance: 97_500_000 }]);
    expect(r.rules[0]!.monthlyGrowthRate).toBeCloseTo(-0.002107593231860272, 12);
  });

  it("E3: set stores the value exactly", () => {
    const r = deriveBalancePlan(BASE, [op("dda", "set", 110_000_000, 12)], { book: BOOK });
    expect(r.plan.targets[0]!.path).toEqual([{ month: 12, balance: 110_000_000 }]);
    expect(r.rules[0]!.monthlyGrowthRate).toBeCloseTo(0.007974140428903764, 12);
  });

  it("E4: ops compose in order and add/scale round to 12 significant digits", () => {
    const r = deriveBalancePlan(BASE, [op("dda", "scale", 1.1), op("dda", "add", -5_000_000)], { book: BOOK });
    expect(r.plan.targets[0]!.path).toEqual([{ month: 12, balance: 105_000_000 }]);
    expect(r.changes).toEqual([{ targetIndex: 0, familyId: "dda", month: 12, from: 100_000_000, to: 105_000_000, ops: [0, 1] }]);
    expect(r.rules[0]!.monthlyGrowthRate).toBeCloseTo(0.0040741237836483535, 12);
  });

  it("E5: a multi-knot target that stops being geometric is refused, naming the first knot that misses", () => {
    const p = problemsOf(() => deriveBalancePlan(BASE, [op("mma", "scale", 0.9)], { book: BOOK }));
    expect(p).toHaveLength(1);
    expect(p[0]!.at).toBe("targets[1]");
    expect(p[0]!.message.startsWith('balance plan target for family "mma" at month 6: path is not a single geometric growth from the opening balance')).toBe(true);
  });

  it("E6: ops that change nothing are refused", () => {
    expect(problemsOf(() => deriveBalancePlan(BASE, [op("mma", "add", 0)], { book: BOOK }))).toEqual([
      { at: "ops", message: 'the ops change no target balance; the derived plan would carry what balance plan "bp-fixture-v1" carries' },
    ]);
  });

  it("E7: nine malformed ops give exactly nine problems, one each, in order", () => {
    const ops = [
      op("cash", "scale", 0.9),
      op("dda", "add", 1, 6),
      op("dda", "set", 5),
      op("dda", "scale", -1),
      op("dda", "times", 2),
      op("dda", "add", "5"),
      { target: { familyId: "dda" }, op: "add", value: 1, path: "x" },
      op("dda", "add", 1, 12.5),
      { target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9, newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 12 } },
    ];
    const p = problemsOf(() => deriveBalancePlan(BASE, ops, { book: BOOK }));
    expect(p).toEqual([
      { at: "ops[0]", message: 'ops[0]: no target for family "cash" in balance plan "bp-fixture-v1"; a balance shock changes a listed target and cannot add a family' },
      { at: "ops[1]", message: 'ops[1]: family "dda" has no knot at month 6; its knots are at months 12, and a balance shock cannot add a knot' },
      { at: "ops[2]", message: "ops[2]: set needs a knot month; set changes one knot and never a whole path" },
      { at: "ops[3]", message: "ops[3]: a scale factor must be at least 0; got -1" },
      { at: "ops[4]", message: 'ops[4]: op must be add, scale or set; got "times"' },
      { at: "ops[5]", message: "ops[5]: value must be a finite number" },
      { at: "ops[6]", message: 'ops[6]: unknown field "path"; an op carries target, op and value' },
      { at: "ops[7]", message: "ops[7]: month must be a whole number naming a knot of the path" },
      { at: "ops[8]", message: `ops[8]: ${PRICING_MSG}` },
    ]);
  });

  it("E7b: a pricing key on the target gives exactly the one pricing problem", () => {
    const p = problemsOf(() =>
      deriveBalancePlan(BASE, [{ target: { familyId: "dda", spreadOverIndexBp: 5 }, op: "add", value: 1 }], { book: BOOK }),
    );
    expect(p).toEqual([{ at: "ops[0]", message: `ops[0]: ${PRICING_MSG}` }]);
  });

  it("E7c: two pricing keys on one op still give one pricing problem; other shape errors are still listed", () => {
    const p = problemsOf(() =>
      deriveBalancePlan(
        BASE,
        [{ target: { familyId: "dda", termMonths: 3 }, op: "add", value: 1, spreadOverIndexBp: 5 }, { target: {}, op: "add", value: 1 }, 7],
        { book: BOOK },
      ),
    );
    expect(p).toEqual([
      { at: "ops[0]", message: `ops[0]: ${PRICING_MSG}` },
      { at: "ops[1]", message: "ops[1]: target must name a familyId" },
      { at: "ops[2]", message: "ops[2]: an op must be an object carrying target, op and value" },
    ]);
  });

  it("E7d: an unknown target field and an ambiguous family are named", () => {
    const dup: BalancePlan = { ...BASE, targets: [BASE.targets[0]!, BASE.targets[0]!] };
    expect(problemsOf(() => deriveBalancePlan(dup, [op("dda", "add", 1)], { book: BOOK }))).toEqual([
      { at: "ops[0]", message: 'ops[0]: 2 targets for family "dda" in balance plan "bp-fixture-v1"; a derivation cannot say which one to change' },
    ]);
    expect(
      problemsOf(() => deriveBalancePlan(BASE, [{ target: { familyId: "dda", path: 1 }, op: "add", value: 1 }], { book: BOOK })),
    ).toEqual([{ at: "ops[0]", message: 'ops[0]: unknown target field "path"; a target carries familyId and month' }]);
  });

  it("E8: a negative derived balance is refused at the knot", () => {
    expect(problemsOf(() => deriveBalancePlan(BASE, [op("dda", "add", -100_000_001)], { book: BOOK }))).toEqual([
      { at: "targets[0].path[0].balance", message: "dda month 12: the derived target balance is -1; a target balance must be finite and at least 0" },
    ]);
  });

  it("E9: a target ending at zero is refused with the engine's own text", () => {
    expect(problemsOf(() => deriveBalancePlan(BASE, [op("dda", "scale", 0)], { book: BOOK }))).toEqual([
      {
        at: "targets[0]",
        message:
          'balance plan target for family "dda" at month 12: target for family "dda" ends at zero balance at month 12; omit the family from the plan to run it off (unlistedFamilies is "runoff")',
      },
    ]);
  });

  it("E10: an overflowing balance is refused as non-finite", () => {
    expect(problemsOf(() => deriveBalancePlan(BASE, [op("dda", "scale", 1e308)], { book: BOOK }))).toEqual([
      { at: "targets[0].path[0].balance", message: "dda month 12: the derived target balance is Infinity; a target balance must be finite and at least 0" },
    ]);
  });

  it("E11: a book on another as-of date is one problem at book", () => {
    const id = derivedBalancePlanId("bp-fixture-v1", contentHash(BASE), [{ target: { familyId: "dda" }, op: "scale", value: 0.9 }]);
    const p = problemsOf(() => deriveBalancePlan(BASE, [op("dda", "scale", 0.9)], { book: { ...BOOK, asOf: "2026-06-30" } }));
    expect(p).toEqual([
      {
        at: "book",
        message: `balance plan: balance plan "${id}" is as of 2026-03-31 and the portfolio is as of 2026-06-30; a target path anchored on a different date would be lowered against the wrong opening balance`,
      },
    ]);
  });

  it("E12: a family with no opening balance in the book is refused at its target", () => {
    const book = { asOf: "2026-03-31", positions: [pos("dda", 100_000_000)] };
    expect(problemsOf(() => deriveBalancePlan(BASE, [op("dda", "scale", 0.9)], { book }))).toEqual([
      { at: "targets[1]", message: 'balance plan target for family "mma": family "mma" has no opening balance in the book' },
    ]);
  });

  it("E13: the op count is bounded", () => {
    expect(problemsOf(() => deriveBalancePlan(BASE, [], { book: BOOK }))).toEqual([{ at: "ops", message: "a derivation needs at least one op" }]);
    const many = Array.from({ length: 33 }, () => op("dda", "add", 1));
    expect(problemsOf(() => deriveBalancePlan(BASE, many, { book: BOOK }))).toEqual([{ at: "ops", message: "at most 32 ops; got 33" }]);
  });

  it("E13b: an unreadable base is refused alone; the error message lists every problem", () => {
    const bad = { ...BASE, targets: "x" } as unknown as BalancePlan;
    expect(problemsOf(() => deriveBalancePlan(bad, [op("dda", "add", 1)], { book: BOOK }))).toEqual([
      { at: "base", message: 'balance plan "bp-fixture-v1" is not a balance plan the derivation can read' },
    ]);
    try {
      deriveBalancePlan(BASE, [op("dda", "add", 1, 6), op("cash", "add", 1)], { book: BOOK });
    } catch (e) {
      expect((e as Error).name).toBe("BalancePlanDerivationError");
      expect((e as Error).message.startsWith("derived balance plan refused: 2 problem(s); every problem is listed: ops[0]: family")).toBe(true);
    }
  });

  it("E13c: a base carrying node targets is refused alone, never derived into a plan that drops them", () => {
    const withNode: BalancePlan = {
      ...BASE,
      nodeTargets: [{ coaNodeId: "deposits", path: [{ month: 12, balance: 150_000_000 }], newBusinessPricing: { spreadOverIndexBp: -75, termMonths: 12 } }],
    };
    expect(problemsOf(() => deriveBalancePlan(withNode, [op("dda", "scale", 0.9)], { book: BOOK }))).toEqual([
      {
        at: "base",
        message: 'balance plan "bp-fixture-v1" carries node targets; a balance shock addresses family targets only, so a plan with node targets cannot be derived',
      },
    ]);
    // An empty nodeTargets list carries nothing to drop: the derivation runs as on BASE.
    const empty = deriveBalancePlan({ ...BASE, nodeTargets: [] }, [op("dda", "scale", 0.9)], { book: BOOK });
    expect(empty.plan.targets[0]!.path).toEqual([{ month: 12, balance: 90_000_000 }]);
  });

  it("E14: the default id hashes base and normalized ops; the label rule", () => {
    const normalized = [{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }];
    const want = "derived-bp-" + contentHash({ baseId: "bp-fixture-v1", baseContentHash: contentHash(BASE), ops: normalized }).slice(0, 12);
    expect(BALANCE_DERIVED_ID_PREFIX).toBe("derived-bp-");
    const a = deriveBalancePlan(BASE, [op("dda", "scale", 0.9, 12)], { book: BOOK });
    expect(a.plan.id).toBe(want);
    const reordered = deriveBalancePlan(BASE, [{ value: 0.9, op: "scale", target: { month: 12, familyId: "dda" } }], { book: BOOK });
    expect(reordered.plan.id).toBe(want);
    expect(deriveBalancePlan(BASE, [op("dda", "scale", 0.9, 12)], { book: BOOK, id: "mine" }).plan.id).toBe("mine");
    expect(a.plan.label).toBe("Balance shock on bp-fixture-v1 (demonstration values)");
    const lab = (label: string) => deriveBalancePlan(BASE, [op("dda", "scale", 0.9)], { book: BOOK, label }).plan.label;
    expect(lab("  Lower dda ")).toBe("Lower dda (demonstration values)");
    expect(lab("Illustrative dda cut")).toBe("Illustrative dda cut");
    expect(lab("   ")).toBe("Balance shock on bp-fixture-v1 (demonstration values)");
  });

  it("E15: the base is untouched and the plan's shape is fixed", () => {
    const before = structuredClone(BASE);
    const r = deriveBalancePlan(BASE, [op("dda", "scale", 0.9)], { book: BOOK });
    expect(BASE).toEqual(before);
    expect(Object.keys(r.plan)).toEqual(["schemaVersion", "id", "label", "asOf", "targets", "unlistedFamilies", "derivedFrom"]);
    expect(r.plan.targets[0]!.newBusinessPricing).toEqual({ spreadOverIndexBp: -100, termMonths: 12 });
    expect(r.plan.targets[1]).toEqual(BASE.targets[1]);
    expect(r.plan.asOf).toBe("2026-03-31");
    expect(r.plan.unlistedFamilies).toBe("runoff");
    expect(r.plan.derivedFrom).toEqual({
      baseId: "bp-fixture-v1",
      baseContentHash: contentHash(BASE),
      ops: [{ target: { familyId: "dda" }, op: "scale", value: 0.9 }],
    });
  });

  it("E16: lowering ignores derivedFrom, but the hash covers it", () => {
    const r = deriveBalancePlan(BASE, [op("dda", "scale", 0.9)], { book: BOOK });
    const { derivedFrom: _drop, ...twin } = r.plan;
    expect(lowerBalancePlan(twin, OPEN, 360, "2026-03-31")).toEqual(r.rules);
    expect(contentHash(twin)).not.toBe(contentHash(r.plan));
    expect(contentHash(BASE)).toBe(contentHash({ ...BASE }));
  });

  it("negative zero is normalized in the op record and the knot", () => {
    const r = deriveBalancePlan(BASE, [op("dda", "add", -0, 12), op("dda", "add", 1)], { book: BOOK });
    expect(Object.is(r.plan.derivedFrom!.ops[0]!.value, 0)).toBe(true);
    expect(r.plan.targets[0]!.path[0]!.balance).toBe(100_000_001);
  });
});
