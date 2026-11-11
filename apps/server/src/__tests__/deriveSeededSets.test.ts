/**
 * deriveAssumptionSet against the real seeded sets.
 * The sets come from the seed's own builders. Counts and values are restated.
 */
import { describe, expect, it } from "vitest";
import { numberFieldsOf, type AssumptionSet, type OverlayBinding } from "@alm/engine";
import { AssumptionDerivationError, bindAssumptions, deriveAssumptionSet, derivedSetId } from "@alm/engine/src/scenario";
import { vanillaAssumptionSet } from "@alm/data";
import { buildDemoAssumptions, buildLoanRepricingAssumptions } from "@alm/data/src/demo/request";
import {
  buildLiquiditySqueezeAssumptions,
  buildLiquidityStressAssumptions,
  buildStressAssumptions,
} from "../../scripts/seed-store";

const op = (familyId: string, kind: string, path: string, opKind: string, value: number) => ({
  target: { familyId, kind },
  path,
  op: opKind,
  value,
});

const paramsOf = (set: AssumptionSet, i: number): Record<string, unknown> =>
  (set.bindings[i]!.overlay as unknown as { params: Record<string, unknown> }).params;

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AssumptionDerivationError);
    return (e as AssumptionDerivationError).problems;
  }
  throw new Error("expected a refusal");
}

describe("derivation on the seeded sets", () => {
  it("S1: eight set ops on the demo set reproduce the seeded stress bindings and hash", () => {
    const r = deriveAssumptionSet(buildDemoAssumptions(), [
      op("mortgages", "prepay", "params.minCpr", "set", 6),
      op("mortgages", "prepay", "params.inflection", "set", 25),
      op("mbs", "prepay", "params.minCpr", "set", 6),
      op("mbs", "prepay", "params.inflection", "set", 25),
      op("dda", "nmd-decay", "params.closureSteady", "set", 1.5),
      op("dda", "nmd-decay", "params.maxRateDecay", "set", 6),
      op("mma", "deposit-beta", "params.betaMin", "set", 0.55),
      op("mma", "deposit-beta", "params.betaMax", "set", 0.95),
    ]);
    expect(r.set.bindings).toEqual(buildStressAssumptions().bindings);
    expect(r.set.contentHash).toBe(bindAssumptions(buildStressAssumptions()).contentHash);
  });

  it("S2: the decay vector scales closure and rate outflow, leaves inflow", () => {
    const r = deriveAssumptionSet(buildDemoAssumptions(), [
      op("dda", "nmd-decay", "params.closureSteady", "scale", 1.25),
      op("dda", "nmd-decay", "params.closureInitial", "scale", 1.25),
      op("dda", "nmd-decay", "params.maxRateDecay", "scale", 1.25),
    ]);
    expect(paramsOf(r.set, 2).closureSteady).toBe(0.9375);
    expect(paramsOf(r.set, 2).closureInitial).toBe(2.5);
    expect(paramsOf(r.set, 2).maxRateDecay).toBe(3.75);
    expect(paramsOf(r.set, 2).maxRateGrowth).toBe(-1);
    expect(r.changes.map((c) => [c.path, c.from, c.to])).toEqual([
      ["params.closureSteady", 0.75, 0.9375],
      ["params.closureInitial", 2, 2.5],
      ["params.maxRateDecay", 3, 3.75],
    ]);
  });

  it("S3: the loan repricing set refuses a one-sided spread move and takes the paired move", () => {
    const base = buildLoanRepricingAssumptions();
    const secOp = op("mortgages", "prepay", "params.secSpread", "add", 25);
    const id = derivedSetId(base.id, bindAssumptions(base).contentHash!, [secOp as never]);
    expect(problemsOf(() => deriveAssumptionSet(base, [secOp]))).toEqual([
      {
        at: "bindings[4].overlay.totalSpreadBp",
        message:
          `assumption set ${id} family mortgages: loan client-rate total spread 250 bp vs prepay 275 (145 + 130) bp; the two must be equal` +
          ". Move the total spread and the securitization or primary spread by the same bp in one derivation.",
      },
    ]);
    const ok = deriveAssumptionSet(base, [secOp, op("mortgages", "loan-client-rate", "totalSpreadBp", "add", 25)]);
    expect(paramsOf(ok.set, 0).secSpread).toBe(145);
    expect(paramsOf(ok.set, 0).primSpread).toBe(130);
    expect((ok.set.bindings[4]!.overlay as { totalSpreadBp: number }).totalSpreadBp).toBe(275);
  });

  it("S4: addressing reaches every number path of every seeded binding (187 triples)", () => {
    const sets: Array<[string, AssumptionSet, number]> = [
      ["demo", buildDemoAssumptions(), 40],
      ["vanilla", vanillaAssumptionSet(), 0],
      ["stress", buildStressAssumptions(), 40],
      ["liquidity", buildLiquidityStressAssumptions(), 30],
      ["squeeze", buildLiquiditySqueezeAssumptions(), 36],
      ["loan repricing", buildLoanRepricingAssumptions(), 41],
    ];
    let total = 0;
    for (const [name, set, expected] of sets) {
      let n = 0;
      set.bindings.forEach((b: OverlayBinding) => {
        for (const f of numberFieldsOf(b.overlay)) {
          const own = f.path.split(".").reduce<unknown>((at, k) => (at as Record<string, unknown>)[k], b.overlay) as number;
          const kind = b.overlay.kind === "registered" ? b.overlay.registeredKind : b.overlay.kind;
          const got = problemsOf(() => deriveAssumptionSet(set, [op(b.familyId, kind, f.path, "set", own)]));
          expect(got, `${name} ${b.familyId} ${f.path}`).toEqual([
            { at: "ops", message: `the ops change no value; the derived set would bind what ${set.id} binds` },
          ]);
          n++;
        }
      });
      expect(n, name).toBe(expected);
      total += n;
    }
    expect(total).toBe(187);
  });
});
