import { describe, it, expect } from "vitest";
import type { AssumptionSet } from "@alm/engine";
import { diffAssumptions } from "../diff";
import { BASE, cloneBase } from "./fixtures";

/** Narrow helper: find the MMA deposit-beta overlay params on a set. */
function betaParams(set: AssumptionSet) {
  const b = set.bindings.find(
    (x) => x.familyId === "MMA" && x.overlay.kind === "deposit-beta",
  );
  if (!b || b.overlay.kind !== "deposit-beta") throw new Error("missing beta binding");
  return b.overlay.params;
}

describe("diffAssumptions", () => {
  it("reports no deltas when nothing changed", () => {
    const diff = diffAssumptions(BASE, cloneBase());
    expect(diff.baseId).toBe("base");
    expect(diff.deltas).toEqual([]);
  });

  it("reports a single flat param change with correct from and to", () => {
    const cand = cloneBase();
    const before = betaParams(BASE).betaMax;
    betaParams(cand).betaMax = before + 0.15;

    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas).toEqual([
      {
        familyId: "MMA",
        overlayKind: "deposit-beta",
        path: "params.betaMax",
        from: before,
        to: before + 0.15,
      },
    ]);
  });

  it("touching one family leaves every other binding byte-identical", () => {
    const cand = cloneBase();
    betaParams(cand).betaMax += 0.15;

    // Every binding other than the mutated MMA deposit-beta is unchanged.
    for (let i = 0; i < BASE.bindings.length; i++) {
      const baseB = BASE.bindings[i];
      const candB = cand.bindings[i];
      const isTarget = baseB.familyId === "MMA" && baseB.overlay.kind === "deposit-beta";
      if (!isTarget) {
        expect(JSON.stringify(candB)).toBe(JSON.stringify(baseB));
      }
    }
    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas.every((d) => d.familyId === "MMA")).toBe(true);
    expect(diff.deltas).toHaveLength(1);
  });

  it("orders multiple deltas in one overlay deterministically by path", () => {
    const cand = cloneBase();
    betaParams(cand).betaMin += 0.1;
    betaParams(cand).betaMax += 0.1;

    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas.map((d) => d.path)).toEqual(["params.betaMax", "params.betaMin"]);
  });

  it("uses the bare param name for a non-`params` overlay leaf (cd-rollover)", () => {
    const cand = cloneBase();
    const cd = cand.bindings.find((b) => b.overlay.kind === "cd-rollover");
    if (!cd || cd.overlay.kind !== "cd-rollover") throw new Error("no cd binding");
    const from = cd.overlay.offeredSpreadBp;
    cd.overlay.offeredSpreadBp = from + 10;

    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas).toEqual([
      {
        familyId: "CDs",
        overlayKind: "cd-rollover",
        path: "offeredSpreadBp",
        from,
        to: from + 10,
      },
    ]);
  });

  it("handles the constant-cpr annualCpr leaf", () => {
    const cand = cloneBase();
    const inv = cand.bindings.find((b) => b.familyId === "Investments");
    if (!inv || inv.overlay.kind !== "prepay" || inv.overlay.model !== "constant-cpr") {
      throw new Error("no constant-cpr binding");
    }
    inv.overlay.annualCpr = 0.04;

    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas).toEqual([
      {
        familyId: "Investments",
        overlayKind: "prepay",
        path: "annualCpr",
        from: 0.08,
        to: 0.04,
      },
    ]);
  });

  it("recurses into nested decay params (sens and buckets)", () => {
    const cand = cloneBase();
    const decay = cand.bindings.find((b) => b.overlay.kind === "nmd-decay");
    if (!decay || decay.overlay.kind !== "nmd-decay") throw new Error("no decay binding");
    decay.overlay.params.sens.gMin = 0.25;
    decay.overlay.params.buckets[0].share = 0.6;

    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas.map((d) => d.path)).toEqual([
      "params.buckets.0.share",
      "params.sens.gMin",
    ]);
    expect(diff.deltas[1]).toMatchObject({ path: "params.sens.gMin", from: 0.15, to: 0.25 });
  });

  it("halves prepay speed to two correct deltas", () => {
    const cand = cloneBase();
    const mtg = cand.bindings.find((b) => b.familyId === "Mortgages");
    if (!mtg || mtg.overlay.kind !== "prepay" || mtg.overlay.model !== "four-factor-cpr") {
      throw new Error("no mortgage prepay binding");
    }
    const minBefore = mtg.overlay.params.minCpr;
    const maxBefore = mtg.overlay.params.maxCpr;
    mtg.overlay.params.minCpr /= 2;
    mtg.overlay.params.maxCpr /= 2;

    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas).toEqual([
      { familyId: "Mortgages", overlayKind: "prepay", path: "params.maxCpr", from: maxBefore, to: maxBefore / 2 },
      { familyId: "Mortgages", overlayKind: "prepay", path: "params.minCpr", from: minBefore, to: minBefore / 2 },
    ]);
  });

  it("emits from=null for a binding added in the candidate", () => {
    const cand = cloneBase();
    cand.bindings.push({
      familyId: "Savings",
      modelVersion: "beta-2026.1",
      overlay: { kind: "deposit-beta", params: { betaMin: 0.1, betaMax: 0.2, k: 0.5, m: 2, lambda: 1 } },
    });
    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas.length).toBeGreaterThan(0);
    expect(diff.deltas.every((d) => d.familyId === "Savings")).toBe(true);
    expect(diff.deltas.every((d) => d.from === null)).toBe(true);
  });

  it("emits to=null for a binding removed in the candidate", () => {
    const cand = cloneBase();
    cand.bindings = cand.bindings.filter((b) => b.familyId !== "CDs");
    const diff = diffAssumptions(BASE, cand);
    expect(diff.deltas.every((d) => d.familyId === "CDs")).toBe(true);
    expect(diff.deltas.every((d) => d.to === null)).toBe(true);
  });

  it("is deterministic across repeated calls", () => {
    const cand = cloneBase();
    betaParams(cand).betaMax += 0.15;
    expect(diffAssumptions(BASE, cand)).toEqual(diffAssumptions(BASE, cand));
  });
});

describe("selected bindings", () => {
  it("diffs two bindings of one kind on one family as two bindings, keyed by predicate", () => {
    const base = cloneBase();
    base.bindings[1] = { ...base.bindings[1]!, selector: { segment: "rate-shopper" } };
    base.bindings.push({
      ...base.bindings[1]!,
      overlay: structuredClone(base.bindings[1]!.overlay),
      selector: { segment: "relationship" },
      modelVersion: "rel-1",
    });
    const cand = JSON.parse(JSON.stringify(base)) as typeof base;
    (cand.bindings[5]!.overlay as { params: { closureSteady: number } }).params.closureSteady *= 2;
    const d = diffAssumptions(base, cand);
    expect(d.deltas).toHaveLength(1);
    expect(d.deltas[0]).toMatchObject({
      familyId: "MMA",
      overlayKind: "nmd-decay",
      path: "params.closureSteady",
      selector: { segment: "relationship" },
    });
  });

  it("a set without selectors diffs exactly as before, with no selector field", () => {
    const d = diffAssumptions(cloneBase(), cloneBase());
    expect(d.deltas).toEqual([]);
    const cand = cloneBase();
    (cand.bindings[1]!.overlay as { params: { closureSteady: number } }).params.closureSteady *= 2;
    const one = diffAssumptions(cloneBase(), cand).deltas[0]!;
    expect("selector" in one).toBe(false);
  });
});

describe("diffAssumptions: macroBindings (Piece 7b)", () => {
  const mb = (familyId: string) => ({ seriesId: "hpi-down-30", feeder: "prepay-housing" as const, familyId });
  it("lists a mapping the candidate adds, from null", () => {
    const d = diffAssumptions(cloneBase(), { ...cloneBase(), macroBindings: [mb("mortgages")] });
    expect(d.macroBindings).toEqual({ from: null, to: [mb("mortgages")] });
  });
  it("carries no macroBindings key when neither side maps", () => {
    expect("macroBindings" in diffAssumptions(cloneBase(), cloneBase())).toBe(false);
  });
});
