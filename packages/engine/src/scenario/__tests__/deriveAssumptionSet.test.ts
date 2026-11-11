/**
 * deriveAssumptionSet tests. The base is the seeded demo
 * set built from kernel defaults; every expected value and refusal text is
 * restated here, never imported from the code under test.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, MBS_DEFAULTS, NMD_DEFAULTS } from "@alm/kernel";
import type { AssumptionSet, OverlayBinding } from "../../contracts/assumptions";
import { bindAssumptions, AssumptionValidationError } from "../bindAssumptions";
import {
  AssumptionDerivationError,
  DEMONSTRATION_SUFFIX,
  DERIVED_ID_PREFIX,
  MAX_DERIVATION_OPS,
  deriveAssumptionSet,
  derivedSetId,
} from "../deriveAssumptionSet";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function baseSet(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: "demo-behavioral-v1",
    label: "Demo base behavioral set",
    bindings: clone([
      {
        familyId: "mortgages",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "kernel-four-factor-cpr-1",
      },
      {
        familyId: "mbs",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS },
        modelVersion: "kernel-four-factor-cpr-1",
      },
      {
        familyId: "dda",
        overlay: { kind: "nmd-decay", params: NMD_DEFAULTS },
        modelVersion: "kernel-nmd-decay-1",
      },
      {
        familyId: "mma",
        overlay: { kind: "deposit-beta", params: BETA_S_CURVE_DEFAULTS },
        modelVersion: "kernel-deposit-beta-1",
      },
    ] as OverlayBinding[]),
  };
}

function loanSet(): AssumptionSet {
  const s = baseSet();
  s.bindings.push({
    familyId: "mortgages",
    overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 250 },
    modelVersion: "illustrative-flat-carry-1",
  });
  return s;
}

function op(familyId: string, kind: string, path: string, opKind: string, value: unknown, selector?: unknown) {
  return { target: selector === undefined ? { familyId, kind } : { familyId, kind, selector }, path, op: opKind, value };
}

const ddaOp = (path: string, opKind: string, value: unknown) => op("dda", "nmd-decay", path, opKind, value);

function problemsOf(fn: () => unknown): Array<{ at: string; message: string }> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AssumptionDerivationError);
    return (e as AssumptionDerivationError).problems;
  }
  throw new Error("expected a refusal");
}

function paramsOf(set: AssumptionSet, i: number): Record<string, unknown> {
  return (set.bindings[i]!.overlay as unknown as { params: Record<string, unknown> }).params;
}

describe("constants", () => {
  it("are restated", () => {
    expect(MAX_DERIVATION_OPS).toBe(32);
    expect(DERIVED_ID_PREFIX).toBe("derived-");
    expect(DEMONSTRATION_SUFFIX).toBe(" (demonstration values)");
  });
});

describe("deriveAssumptionSet: values", () => {
  it("(1) scale dda closureSteady by 1.25 gives 0.9375 and touches nothing else", () => {
    const base = baseSet();
    const before = clone(base);
    const r = deriveAssumptionSet(base, [ddaOp("params.closureSteady", "scale", 1.25)]);
    expect(paramsOf(r.set, 2).closureSteady).toBe(0.9375);
    expect(paramsOf(r.set, 2).closureInitial).toBe(2);
    expect(r.set.bindings[0]).toEqual(base.bindings[0]);
    expect(r.set.bindings[1]).toEqual(base.bindings[1]);
    expect(r.set.bindings[3]).toEqual(base.bindings[3]);
    expect(r.set.bindings[2]!.modelVersion).toBe("kernel-nmd-decay-1");
    expect(paramsOf(r.set, 2).buckets).toEqual(paramsOf(base, 2).buckets);
    expect(r.changes).toEqual([
      {
        bindingIndex: 2,
        familyId: "dda",
        kind: "nmd-decay",
        path: "params.closureSteady",
        label: "Steady closure rate",
        unit: "% per month",
        from: 0.75,
        to: 0.9375,
        ops: [0],
      },
    ]);
    expect(base).toEqual(before);
    expect(r.set.derivedFrom).toEqual({
      baseId: "demo-behavioral-v1",
      baseContentHash: bindAssumptions(base).contentHash,
      ops: [ddaOp("params.closureSteady", "scale", 1.25)],
    });
    expect(Object.keys(r.set)).toEqual(["schemaVersion", "id", "label", "bindings", "derivedFrom", "contentHash"]);
  });

  it("(2) add mortgages prepay minCpr 3 gives 5; mbs stays 2", () => {
    const r = deriveAssumptionSet(baseSet(), [op("mortgages", "prepay", "params.minCpr", "add", 3)]);
    expect(paramsOf(r.set, 0).minCpr).toBe(5);
    expect(paramsOf(r.set, 1).minCpr).toBe(2);
  });

  it("(3) scale betaMax by 1.1 stores exactly 0.88, not 0.8800000000000001", () => {
    expect(0.8 * 1.1).not.toBe(0.88);
    const r = deriveAssumptionSet(baseSet(), [op("mma", "deposit-beta", "params.betaMax", "scale", 1.1)]);
    expect(paramsOf(r.set, 3).betaMax).toBe(0.88);
  });

  it("(4) set mbs inflection 25 stores 25 (from 50)", () => {
    const r = deriveAssumptionSet(baseSet(), [op("mbs", "prepay", "params.inflection", "set", 25)]);
    expect(paramsOf(r.set, 1).inflection).toBe(25);
    expect(r.changes[0]!.from).toBe(50);
    expect(r.changes[0]!.to).toBe(25);
    expect(paramsOf(r.set, 0).inflection).toBe(50);
  });

  it("(5) ops apply in order and compose; the ids differ", () => {
    const a = [op("mortgages", "prepay", "params.minCpr", "add", 1), op("mortgages", "prepay", "params.minCpr", "scale", 2)];
    const b = [op("mortgages", "prepay", "params.minCpr", "scale", 2), op("mortgages", "prepay", "params.minCpr", "add", 1)];
    const ra = deriveAssumptionSet(baseSet(), a);
    const rb = deriveAssumptionSet(baseSet(), b);
    expect(paramsOf(ra.set, 0).minCpr).toBe(6);
    expect(paramsOf(rb.set, 0).minCpr).toBe(5);
    expect(ra.set.id).not.toBe(rb.set.id);
    expect(ra.changes).toHaveLength(1);
    expect(ra.changes[0]!.ops).toEqual([0, 1]);
    expect(ra.changes[0]!.from).toBe(2);
    expect(ra.changes[0]!.to).toBe(6);
  });

  it("add to a sens path and a table-free nested field", () => {
    const r = deriveAssumptionSet(baseSet(), [ddaOp("params.sens.gMax", "add", 0.5)]);
    const g = (paramsOf(baseSet(), 2).sens as { gMax: number }).gMax;
    expect((paramsOf(r.set, 2).sens as { gMax: number }).gMax).toBe(Number((g + 0.5).toPrecision(12)));
    expect(r.changes[0]!.path).toBe("params.sens.gMax");
  });

  it("(8) scale maPeriod 1.5 gives 36; 1.1 is refused as not whole", () => {
    expect(paramsOf(deriveAssumptionSet(baseSet(), [ddaOp("params.maPeriod", "scale", 1.5)]).set, 2).maPeriod).toBe(36);
    expect(problemsOf(() => deriveAssumptionSet(baseSet(), [ddaOp("params.maPeriod", "scale", 1.1)]))).toEqual([
      { at: "bindings[2].overlay.params.maPeriod", message: "dda nmd-decay: Regime window must be a whole number" },
    ]);
  });

  it("changes keep first-touch order across bindings", () => {
    const r = deriveAssumptionSet(baseSet(), [
      op("mma", "deposit-beta", "params.k", "add", 0.1),
      ddaOp("params.closureSteady", "add", 0.25),
      op("mma", "deposit-beta", "params.betaMin", "set", 0.5),
      op("mma", "deposit-beta", "params.k", "scale", 2),
    ]);
    expect(r.changes.map((c) => [c.bindingIndex, c.path, c.ops])).toEqual([
      [3, "params.k", [0, 3]],
      [2, "params.closureSteady", [1]],
      [3, "params.betaMin", [2]],
    ]);
  });
});

describe("deriveAssumptionSet: refusals", () => {
  it("(6) every bound problem is listed, in binding order", () => {
    expect(
      problemsOf(() =>
        deriveAssumptionSet(baseSet(), [
          op("mortgages", "prepay", "params.maxCpr", "scale", 2),
          op("mma", "deposit-beta", "params.lambda", "add", 0.5),
        ]),
      ),
    ).toEqual([
      { at: "bindings[0].overlay.params.maxCpr", message: "mortgages prepay: Maximum CPR must be at most 100" },
      { at: "bindings[3].overlay.params.lambda", message: "mma deposit-beta: Adjustment speed must be at most 1" },
    ]);
  });

  it("(7) a cross rule breach is one problem at the rule's field", () => {
    expect(problemsOf(() => deriveAssumptionSet(baseSet(), [op("mortgages", "prepay", "params.minCpr", "scale", 40)]))).toEqual([
      { at: "bindings[0].overlay.params.maxCpr", message: "mortgages prepay: Maximum CPR must be above the minimum CPR" },
    ]);
  });

  it("(9) the spread rule is refused, not auto-moved; both ops pass", () => {
    const base = loanSet();
    const baseHash = bindAssumptions(base).contentHash!;
    const secOp = op("mortgages", "prepay", "params.secSpread", "add", 25);
    const id = derivedSetId("demo-behavioral-v1", baseHash, [secOp as never]);
    const suffix = ". Move the total spread and the securitization or primary spread by the same bp in one derivation.";
    expect(problemsOf(() => deriveAssumptionSet(base, [secOp]))).toEqual([
      {
        at: "bindings[4].overlay.totalSpreadBp",
        message:
          `assumption set ${id} family mortgages: loan client-rate total spread 250 bp vs prepay 275 (145 + 130) bp; the two must be equal` +
          suffix,
      },
    ]);
    const mine = problemsOf(() => deriveAssumptionSet(base, [secOp], { id: "my-loan-shock" }));
    expect(mine[0]!.message).toContain("my-loan-shock");
    expect(mine[0]!.message.endsWith("by the same bp in one derivation.")).toBe(true);

    const both = deriveAssumptionSet(base, [secOp, op("mortgages", "loan-client-rate", "totalSpreadBp", "add", 25)]);
    expect(paramsOf(both.set, 0).secSpread).toBe(145);
    expect(paramsOf(both.set, 0).primSpread).toBe(130);
    expect((both.set.bindings[4]!.overlay as { totalSpreadBp: number }).totalSpreadBp).toBe(275);
    expect((both.set.bindings[4]!.overlay as { model: string }).model).toBe("flat-carry");
  });

  it("(10) five bad ops list five problems in order", () => {
    const ps = problemsOf(() =>
      deriveAssumptionSet(baseSet(), [
        op("cards", "nmd-decay", "params.closureSteady", "scale", 1.1),
        ddaOp("params.buckets", "scale", 1.1),
        ddaOp("params.closureSteady", "multiply", 1.1),
        ddaOp("params.closureSteady", "scale", "2"),
        ddaOp("params.closureSteady", "scale", -1),
      ]),
    );
    expect(ps).toEqual([
      { at: "ops[0]", message: 'ops[0]: no binding of kind "nmd-decay" on family "cards" in set "demo-behavioral-v1"' },
      { at: "ops[1]", message: 'ops[1]: "params.buckets" is not a number parameter of Deposit decay' },
      { at: "ops[2]", message: 'ops[2]: op must be add, scale or set; got "multiply"' },
      { at: "ops[3]", message: "ops[3]: value must be a finite number" },
      { at: "ops[4]", message: "ops[4]: a scale factor must be at least 0; got -1" },
    ]);
  });

  it("an empty list and an over-long list", () => {
    expect(problemsOf(() => deriveAssumptionSet(baseSet(), []))).toEqual([{ at: "ops", message: "a derivation needs at least one op" }]);
    const many = Array.from({ length: 33 }, () => ddaOp("params.closureSteady", "add", 0.01));
    expect(problemsOf(() => deriveAssumptionSet(baseSet(), many))).toEqual([{ at: "ops", message: "at most 32 ops; got 33" }]);
    const thirtyTwo = Array.from({ length: 32 }, () => ddaOp("params.closureSteady", "add", 0.01));
    expect(() => deriveAssumptionSet(baseSet(), thirtyTwo)).not.toThrow();
  });

  it("an unknown op key, a malformed op and a malformed target", () => {
    expect(
      problemsOf(() => deriveAssumptionSet(baseSet(), [{ ...ddaOp("params.closureSteady", "scale", 2), factor: 2 }])),
    ).toEqual([{ at: "ops[0]", message: 'ops[0]: unknown field "factor"; an op carries target, path, op and value' }]);
    expect(problemsOf(() => deriveAssumptionSet(baseSet(), [7]))).toEqual([
      { at: "ops[0]", message: "ops[0]: an op must be an object carrying target, path, op and value" },
    ]);
    expect(
      problemsOf(() =>
        deriveAssumptionSet(baseSet(), [{ target: { familyId: "dda" }, path: "params.closureSteady", op: "scale", value: 2 }]),
      ),
    ).toEqual([{ at: "ops[0]", message: "ops[0]: target must name a familyId and a kind" }]);
  });

  it("a registered binding cannot be derived", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "reg-v1",
      label: "reg",
      bindings: [{ familyId: "x", overlay: { kind: "registered", registeredKind: "plug", params: { a: 1 } }, modelVersion: "v1" }],
    };
    expect(problemsOf(() => deriveAssumptionSet(set, [op("x", "plug", "a", "set", 2)]))).toEqual([
      {
        at: "ops[0]",
        message:
          'ops[0]: family "x" binds registered kind "plug"; a registered overlay\'s params belong to its plugin and cannot be derived',
      },
    ]);
  });

  it("two bindings with one identical selector are ambiguous", () => {
    const retail = { segment: "retail" };
    const mk = (): OverlayBinding => ({
      familyId: "dda",
      overlay: { kind: "nmd-decay", params: clone(NMD_DEFAULTS) },
      modelVersion: "v",
      selector: retail,
    });
    const set: AssumptionSet = { schemaVersion: "1.0.0", id: "amb-v1", label: "amb", bindings: [mk(), mk()] };
    expect(problemsOf(() => deriveAssumptionSet(set, [op("dda", "nmd-decay", "params.closureSteady", "scale", 2, retail)]))).toEqual([
      {
        at: "ops[0]",
        message:
          'ops[0]: 2 bindings of kind "nmd-decay" on family "dda" with selector {"segment":["retail"]} match; a derivation cannot say which one to change',
      },
    ]);
    // Without the selector the target names no binding at all.
    expect(problemsOf(() => deriveAssumptionSet(set, [ddaOp("params.closureSteady", "scale", 2)]))).toEqual([
      { at: "ops[0]", message: 'ops[0]: no binding of kind "nmd-decay" on family "dda" in set "amb-v1"' },
    ]);
  });

  it("an op that changes nothing is refused", () => {
    expect(problemsOf(() => deriveAssumptionSet(baseSet(), [ddaOp("params.closureSteady", "scale", 1)]))).toEqual([
      { at: "ops", message: "the ops change no value; the derived set would bind what demo-behavioral-v1 binds" },
    ]);
    expect(
      problemsOf(() =>
        deriveAssumptionSet(baseSet(), [ddaOp("params.closureSteady", "add", 1), ddaOp("params.closureSteady", "add", -1)]),
      ),
    ).toEqual([{ at: "ops", message: "the ops change no value; the derived set would bind what demo-behavioral-v1 binds" }]);
  });

  it("the error message counts and lists every problem", () => {
    try {
      deriveAssumptionSet(baseSet(), [ddaOp("params.buckets", "scale", 1.1), ddaOp("params.closureSteady", "scale", -1)]);
      throw new Error("expected a refusal");
    } catch (e) {
      const err = e as AssumptionDerivationError;
      expect(err.name).toBe("AssumptionDerivationError");
      expect(err.message).toBe(
        'derived set refused: 2 problem(s); every problem is listed: ops[0]: "params.buckets" is not a number parameter of Deposit decay; ops[1]: a scale factor must be at least 0; got -1',
      );
    }
  });

  it("a base that does not bind rethrows the validation error unchanged", () => {
    const bad = baseSet();
    bad.id = "";
    expect(() => deriveAssumptionSet(bad, [ddaOp("params.closureSteady", "scale", 2)])).toThrow(AssumptionValidationError);
  });

  it("an unusable caller id surfaces as one problem at set", () => {
    expect(problemsOf(() => deriveAssumptionSet(baseSet(), [ddaOp("params.closureSteady", "scale", 2)], { id: "" }))).toEqual([
      { at: "set", message: "invalid assumption set at id: must be a non-empty string" },
    ]);
  });
});

describe("deriveAssumptionSet: identity", () => {
  it("(11) is deterministic; the id hashes base and normalized ops", () => {
    const ops = [ddaOp("params.closureSteady", "scale", 1.25)];
    const a = deriveAssumptionSet(baseSet(), ops);
    const b = deriveAssumptionSet(baseSet(), ops);
    expect(a).toEqual(b);
    expect(a.set.id).toMatch(/^derived-[0-9a-f]{12}$/);
    const baseHash = bindAssumptions(baseSet()).contentHash!;
    const canonical =
      `{"baseContentHash":"${baseHash}","baseId":"demo-behavioral-v1","ops":[` +
      `{"op":"scale","path":"params.closureSteady","target":{"familyId":"dda","kind":"nmd-decay"},"value":1.25}]}`;
    expect(a.set.id).toBe("derived-" + createHash("sha256").update(canonical).digest("hex").slice(0, 12));
    expect(a.set.derivedFrom!.baseContentHash).toBe(baseHash);
    expect(a.set.contentHash).toBe(bindAssumptions({ ...a.set, derivedFrom: undefined }).contentHash);
    expect(a.set.contentHash).toBe(bindAssumptions({ schemaVersion: "1.0.0", id: "z", label: "z", bindings: a.set.bindings }).contentHash);
  });

  it("(11) labels: default, suffix, kept; a label change moves neither id nor hash; caller id verbatim", () => {
    const ops = [ddaOp("params.closureSteady", "scale", 1.25)];
    const dflt = deriveAssumptionSet(baseSet(), ops);
    expect(dflt.set.label).toBe("Behavioral shock on demo-behavioral-v1 (demonstration values)");
    const up = deriveAssumptionSet(baseSet(), ops, { label: "Decay up" });
    expect(up.set.label).toBe("Decay up (demonstration values)");
    expect(deriveAssumptionSet(baseSet(), ops, { label: "ILLUSTRATIVE decay" }).set.label).toBe("ILLUSTRATIVE decay");
    expect(deriveAssumptionSet(baseSet(), ops, { label: "A demonstration run" }).set.label).toBe("A demonstration run");
    expect(deriveAssumptionSet(baseSet(), ops, { label: "   " }).set.label).toBe(dflt.set.label);
    expect(deriveAssumptionSet(baseSet(), ops, { label: "  Decay up  " }).set.label).toBe("Decay up (demonstration values)");
    expect(up.set.id).toBe(dflt.set.id);
    expect(up.set.contentHash).toBe(dflt.set.contentHash);
    const mine = deriveAssumptionSet(baseSet(), ops, { id: "my-shock" });
    expect(mine.set.id).toBe("my-shock");
    expect(mine.set.contentHash).toBe(dflt.set.contentHash);
  });

  it("op key order does not move the id", () => {
    const swapped = { value: 1.25, op: "scale", path: "params.closureSteady", target: { kind: "nmd-decay", familyId: "dda" } };
    expect(deriveAssumptionSet(baseSet(), [swapped]).set.id).toBe(
      deriveAssumptionSet(baseSet(), [ddaOp("params.closureSteady", "scale", 1.25)]).set.id,
    );
  });

  it("(12) a selector matches regardless of value order; the recorded selector is the stored one", () => {
    const set: AssumptionSet = {
      schemaVersion: "1.0.0",
      id: "sel-v1",
      label: "sel",
      bindings: [
        { familyId: "dda", overlay: { kind: "nmd-decay", params: clone(NMD_DEFAULTS) }, modelVersion: "v", selector: { segment: ["b", "a"] } },
      ],
    };
    const r = deriveAssumptionSet(set, [op("dda", "nmd-decay", "params.closureSteady", "scale", 2, { segment: ["a", "b"] })]);
    expect(r.set.derivedFrom!.ops[0]!.target).toEqual({
      familyId: "dda",
      kind: "nmd-decay",
      selector: { segment: ["b", "a"] },
    });
    expect(r.set.bindings[0]!.selector).toEqual({ segment: ["b", "a"] });
    expect(r.changes[0]!.selector).toEqual({ segment: ["b", "a"] });
    expect(paramsOf(r.set, 0).closureSteady).toBe(1.5);
  });

  it("(13) deriving from a derived set records the immediate base only", () => {
    const first = deriveAssumptionSet(baseSet(), [ddaOp("params.closureSteady", "scale", 1.25)]).set;
    const second = deriveAssumptionSet(first, [op("mma", "deposit-beta", "params.betaMin", "set", 0.5)]);
    expect(second.set.derivedFrom!.baseId).toBe(first.id);
    expect(second.set.derivedFrom!.baseContentHash).toBe(first.contentHash);
    expect(second.set.derivedFrom!.ops).toHaveLength(1);
    expect(paramsOf(second.set, 2).closureSteady).toBe(0.9375);
  });
});
