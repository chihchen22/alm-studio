/**
 * bindAssumptions tests. Acceptance: bind fills a content hash, is idempotent,
 * and the hash changes iff a binding param changes (not on label/id edits).
 */
import { describe, expect, it } from "vitest";
import {
  BETA_S_CURVE_DEFAULTS,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
  type NMDParams,
} from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import { bindAssumptions, AssumptionValidationError } from "../bindAssumptions";

function sampleSet(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: "as-base",
    label: "Base assumptions",
    bindings: [
      {
        familyId: "MBS",
        overlay: { kind: "prepay", model: "four-factor-cpr", params: { ...MBS_DEFAULTS } },
        modelVersion: "mbs-2026-03",
      },
      {
        familyId: "MMA",
        overlay: { kind: "deposit-beta", params: { ...BETA_S_CURVE_DEFAULTS } },
        modelVersion: "beta-2026-03",
      },
      {
        familyId: "DDA",
        overlay: { kind: "nmd-decay", params: { ...NMD_DEFAULTS } },
        modelVersion: "decay-2026-03",
      },
    ],
  };
}

describe("bindAssumptions", () => {
  it("fills a 64-char hex content hash", () => {
    const bound = bindAssumptions(sampleSet());
    expect(bound.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent: re-binding yields the same object and hash", () => {
    const once = bindAssumptions(sampleSet());
    const twice = bindAssumptions(once);
    expect(twice).toEqual(once);
    expect(twice.contentHash).toBe(once.contentHash);
  });

  it("does not mutate its input", () => {
    const input = sampleSet();
    expect(input.contentHash).toBeUndefined();
    bindAssumptions(input);
    expect(input.contentHash).toBeUndefined();
  });

  it("hash changes when a binding param changes", () => {
    const a = bindAssumptions(sampleSet());
    const mutated = sampleSet();
    (mutated.bindings[0].overlay as { params: typeof MBS_DEFAULTS }).params.maxCpr = 40;
    const b = bindAssumptions(mutated);
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("hash is stable under label and id edits (only bindings drive it)", () => {
    const a = bindAssumptions(sampleSet());
    const relabeled = sampleSet();
    relabeled.label = "Totally different label";
    relabeled.id = "as-renamed";
    const b = bindAssumptions(relabeled);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("hash changes when a binding is added", () => {
    const a = bindAssumptions(sampleSet());
    const extended = sampleSet();
    extended.bindings.push({
      familyId: "CD",
      overlay: { kind: "cd-rollover", renewalProbability: 0.6, offeredSpreadBp: 25, termMonths: 12 },
      modelVersion: "cd-2026-03",
    });
    const b = bindAssumptions(extended);
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("rejects an unrecognized overlay kind", () => {
    const bad = sampleSet();
    // deliberately corrupt the discriminant
    (bad.bindings[0].overlay as { kind: string }).kind = "made-up";
    expect(() => bindAssumptions(bad)).toThrow(AssumptionValidationError);
  });

  it("rejects a non-finite overlay param", () => {
    const bad = sampleSet();
    (bad.bindings[0].overlay as { params: typeof MBS_DEFAULTS }).params.maxCpr = Number.NaN;
    expect(() => bindAssumptions(bad)).toThrow(AssumptionValidationError);
  });

  it("rejects a missing required field", () => {
    const bad = sampleSet();
    (bad.bindings[0] as { modelVersion?: string }).modelVersion = "";
    expect(() => bindAssumptions(bad)).toThrow(AssumptionValidationError);
  });
});

describe("selector shape", () => {
  it("accepts a scalar and a list predicate and hashes it into contentHash", () => {
    const plain = sampleSet();
    const selected = sampleSet();
    selected.bindings[1] = { ...selected.bindings[1]!, selector: { segment: ["rate-shopper"], line: "consumer" } };
    expect(bindAssumptions(selected).contentHash).not.toBe(bindAssumptions(plain).contentHash);
    expect(bindAssumptions(plain).contentHash).toBe(bindAssumptions(sampleSet()).contentHash);
  });
  it("refuses a non-object selector, an empty value, and a non-string entry", () => {
    const a = sampleSet(); (a.bindings[1] as { selector?: unknown }).selector = "x";
    expect(() => bindAssumptions(a)).toThrow(/bindings\[1\]\.selector/);
    const b = sampleSet(); b.bindings[1] = { ...b.bindings[1]!, selector: { segment: "" } };
    expect(() => bindAssumptions(b)).toThrow(/bindings\[1\]\.selector\.segment/);
    const c = sampleSet(); (c.bindings[1] as { selector?: unknown }).selector = { segment: [1] };
    expect(() => bindAssumptions(c)).toThrow(/bindings\[1\]\.selector\.segment/);
    const d = sampleSet();
    expect(() => bindAssumptions({ ...d, bindings: [{ ...d.bindings[0]!, selector: { segment: [] } }] })).toThrow(/bindings\[0\]\.selector\.segment/);
  });
  /**
   * Finding 5. An empty selector says the same thing as no selector and reads
   * as an author who meant to narrow and did not. It is refused at the shape
   * check, so the provenance key rule and the assumption diff key can both
   * treat an empty canonical predicate as "no selector" by construction.
   */
  it("refuses an empty selector object, pointing at the omission", () => {
    const e = sampleSet();
    e.bindings[1] = { ...e.bindings[1]!, selector: {} };
    expect(() => bindAssumptions(e)).toThrow(AssumptionValidationError);
    expect(() => bindAssumptions(e)).toThrow(/bindings\[1\]\.selector/);
    expect(() => bindAssumptions(e)).toThrow(/at least one tag/);
  });
});

describe("the parameter schema at bind (Piece 4a)", () => {
  // sampleSet's decay params are a shallow copy of NMD_DEFAULTS, so each case replaces
  // the nested object it changes rather than mutating the kernel's own `sens` or `buckets`.
  const decayParams = (set: AssumptionSet) => set.bindings[2].overlay as { params: NMDParams };

  it("refuses a NaN two levels deep, in sens, naming the path and the label", () => {
    const bad = sampleSet();
    decayParams(bad).params = { ...NMD_DEFAULTS, sens: { ...NMD_DEFAULTS.sens, bStar: Number.NaN } };
    expect(() => bindAssumptions(bad)).toThrow(
      "invalid assumption set at bindings[2].overlay.params.sens.bStar: Sensitivity midpoint balance must be a finite number",
    );
  });

  it("refuses a bucket share above 1 inside the buckets array", () => {
    const bad = sampleSet();
    decayParams(bad).params = { ...NMD_DEFAULTS, buckets: NMD_DEFAULTS.buckets.map((b, i) => (i === 1 ? { ...b, share: 1.2 } : b)) };
    expect(() => bindAssumptions(bad)).toThrow(
      "invalid assumption set at bindings[2].overlay.params.buckets[1].share: Share, row 2 must be at most 1",
    );
  });

  it("refuses a finite value outside a hard bound, which the old finite scan let through", () => {
    const bad = sampleSet();
    (bad.bindings[0].overlay as { params: typeof MBS_DEFAULTS }).params = { ...MBS_DEFAULTS, seasoningRamp: 0 };
    let caught: unknown;
    try { bindAssumptions(bad); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AssumptionValidationError);
    expect((caught as AssumptionValidationError).field).toBe("bindings[0].overlay.params.seasoningRamp");
    expect((caught as Error).message).toBe("invalid assumption set at bindings[0].overlay.params.seasoningRamp: Seasoning ramp must be above 0");
  });

  it("leaves a registered overlay's params to its plugin", () => {
    const set = sampleSet();
    set.bindings.push({ familyId: "X", overlay: { kind: "registered", registeredKind: "acme-decay", params: { rate: -5 } }, modelVersion: "acme-1" });
    expect(() => bindAssumptions(set)).not.toThrow();
  });
});

describe("whole-family duplicates at bind (Piece 4b)", () => {
  const decay = (familyId: string, selector?: Record<string, string>) => ({
    familyId,
    overlay: { kind: "nmd-decay" as const, params: { ...NMD_DEFAULTS } },
    modelVersion: "decay-2026-03",
    ...(selector !== undefined ? { selector } : {}),
  });

  it("refuses a second whole-family binding of one kind on one family, in the resolver's own words", () => {
    const set = sampleSet();
    set.bindings.push(decay("DDA"));
    let caught: unknown;
    try { bindAssumptions(set); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AssumptionValidationError);
    expect((caught as AssumptionValidationError).field).toBe("bindings[3]");
    expect((caught as Error).message).toBe('invalid assumption set at bindings[3]: family "DDA" has two "nmd-decay" overlays; one family, one overlay per kind');
  });

  it("leaves a pair with a selector to compile, where the book's positions settle the overlap", () => {
    const one = sampleSet();
    one.bindings.push(decay("DDA", { segment: "retail" }));
    expect(() => bindAssumptions(one)).not.toThrow();
    const both = sampleSet();
    both.bindings[2] = decay("DDA", { segment: "retail" });
    both.bindings.push(decay("DDA", { segment: "retail" }));
    expect(() => bindAssumptions(both)).not.toThrow();
  });

  it("passes two kinds on one family, and one kind on two families", () => {
    const set = sampleSet();
    set.bindings.push(decay("MMA"), decay("SAV"));
    expect(() => bindAssumptions(set)).not.toThrow();
  });

  it("keys a plugin binding by its registered kind, as the resolver does", () => {
    const plugin = (registeredKind: string) => ({ familyId: "X", overlay: { kind: "registered" as const, registeredKind, params: { rate: 1 } }, modelVersion: "acme-1" });
    const two = sampleSet();
    two.bindings.push(plugin("acme-decay"), plugin("acme-beta"));
    expect(() => bindAssumptions(two)).not.toThrow();
    const same = sampleSet();
    same.bindings.push(plugin("acme-decay"), plugin("acme-decay"));
    expect(() => bindAssumptions(same)).toThrow('invalid assumption set at bindings[4]: family "X" has two "registered" overlays; one family, one overlay per kind');
  });
});
