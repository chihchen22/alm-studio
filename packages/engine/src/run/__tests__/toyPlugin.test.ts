/**
 * Spec Section 8.4, first half. One profile row, authored by nobody on this
 * team, changes the NII number; disposing the row takes the kind off the shelf
 * and a run still binding it refuses. This is the acceptance that the seams are
 * real rather than decorative.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot, MortgageTerms } from "@alm/kernel";
import { composeProfile, mountProfile, type Plugin } from "@alm/harness";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { Scenario } from "../../contracts/scenario";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { IncompatibleOverlayError } from "../../scenario/resolveAssumptions";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import { baseAssumptions, loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

/**
 * A user plugin. It registers a second prepay kind whose applier sets the
 * mortgage terminal CPR from its own params, which moves mortgage runoff and
 * therefore NII. Two different params must give two different numbers, or the
 * applier is not actually driving the projection.
 */
const constantCpr2: Plugin = {
  id: "test.behavioral.constant-cpr-2",
  inject: ["behavioral"],
  declares: { kind: "behavioral", produces: ["Cashflow"], consumes: ["Position"] },
  apply(ctx) {
    const registry = ctx.get("behavioral");
    // Through effect, so the registration unwinds with this row's fiber.
    ctx.effect(() =>
      registry.register("constant-cpr-2", (terms, overlay, positionId) => {
        if (terms.type !== "mortgage") {
          throw new Error(`constant-cpr-2 cannot drive position "${positionId}" of type "${terms.type}"`);
        }
        if (overlay.kind !== "registered") throw new Error("constant-cpr-2 expects a registered overlay");
        const params = overlay.params as { maxCpr: number };
        const mortgage = terms as MortgageTerms;
        return { ...mortgage, cprParams: { ...mortgage.cprParams, maxCpr: params.maxCpr } };
      }),
    );
  },
};

const TOY_CATALOG = new Map(BUILTIN_CATALOG).set(constantCpr2.id, constantCpr2);
const TOY_PROFILE = composeProfile(DEFAULT_PROFILE, [
  {
    label: "toy",
    patches: [{ insert: { id: "toy-cpr2", plugin: "test.behavioral.constant-cpr-2" } }],
  },
]);

/** The fixture set with the built-in MORTGAGE prepay binding swapped for the toy kind. */
function toyAssumptions(maxCpr: number): AssumptionSet {
  const set = baseAssumptions();
  return {
    ...set,
    bindings: [
      ...set.bindings.filter((b) => !(b.familyId === "MORTGAGE" && b.overlay.kind === "prepay")),
      {
        familyId: "MORTGAGE",
        modelVersion: "toy-1",
        overlay: { kind: "registered" as const, registeredKind: "constant-cpr-2", params: { maxCpr } },
      },
    ],
  };
}

/** The fixture grid with the +100bp leg turned into a dynamic reinvestment leg. */
function dynamicScenarios(): Scenario[] {
  return [
    {
      id: "S0",
      label: "S0",
      rateSpec: { kind: "base" },
      assumptionSetId: "AS-BASE",
      newBusiness: { mode: "static", rules: [] },
    },
    {
      id: "SDYN",
      label: "dynamic, flat target",
      rateSpec: { kind: "parallel", shockBp: 100 },
      assumptionSetId: "AS-BASE",
      newBusiness: { mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "flat" }] },
    },
  ];
}

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

describe("a user plugin mounted by one row", () => {
  it("drives the NII number from its own params, and two params give two numbers", () => {
    const base = resolveDefaultContext();
    const baseline = buildRunResult(makeRunRequest(market), twoSidedBook(), base);
    const baselineNet = baseline.nii.byScenario[0].totalNetByHorizon;

    const toyHarness = mountProfile(TOY_PROFILE, TOY_CATALOG);
    const runAt = (maxCpr: number) =>
      buildRunResult(
        makeRunRequest(market, { assumptionSets: [toyAssumptions(maxCpr)] }),
        twoSidedBook(),
        { ...base, harness: toyHarness },
      ).nii.byScenario[0].totalNetByHorizon;

    const slow = runAt(0.1);
    const fast = runAt(0.3);
    // The applier is what separates these two: same book, same grid, same
    // everything else. A no-op applier would make them equal.
    expect(fast).not.toEqual(slow);
    expect(slow).not.toEqual(baselineNet);
    toyHarness.dispose();
  });

  it("reaches the dynamic projection too, not only the static runoff", () => {
    const base = resolveDefaultContext();
    const toyHarness = mountProfile(TOY_PROFILE, TOY_CATALOG);
    const scenarios = dynamicScenarios();

    const builtIn = buildRunResult(
      makeRunRequest(market, { scenarios }),
      twoSidedBook(),
      { ...base, harness: toyHarness },
    );
    const withToy = buildRunResult(
      makeRunRequest(market, { scenarios, assumptionSets: [toyAssumptions(0.3)] }),
      twoSidedBook(),
      { ...base, harness: toyHarness },
    );

    const dynRow = (r: typeof builtIn) =>
      r.nii.byScenario.find((s) => s.scenarioId === "SDYN")!.totalNetByHorizon;
    // The dynamic leg reprojects the book through projectDynamicScenario, which
    // applies the overlays a second time. Before the seam reached it, this run
    // threw IncompatibleOverlayError even with the plugin mounted.
    expect(dynRow(withToy)).not.toEqual(dynRow(builtIn));
    toyHarness.dispose();
  });

  it("takes the kind off the shelf when the row's fiber is disposed", () => {
    const base = resolveDefaultContext();
    const toyHarness = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const fiber = toyHarness.mount(constantCpr2, undefined, "toy-cpr2");
    const request = makeRunRequest(market, { assumptionSets: [toyAssumptions(0.3)] });

    expect(toyHarness.get("behavioral").has("constant-cpr-2")).toBe(true);
    expect(() => buildRunResult(request, twoSidedBook(), { ...base, harness: toyHarness })).not.toThrow();

    fiber.dispose();

    expect(toyHarness.get("behavioral").has("constant-cpr-2")).toBe(false);
    // The kind is gone, so the binding that names it is refused rather than
    // silently falling back to a built-in applier.
    expect(() =>
      buildRunResult(request, twoSidedBook(), { ...base, harness: toyHarness }),
    ).toThrow(IncompatibleOverlayError);
    toyHarness.dispose();
  });

  it("refuses the toy binding on a context where the row is not mounted", () => {
    const base = resolveDefaultContext();
    const toyRequest = makeRunRequest(market, { assumptionSets: [toyAssumptions(0.3)] });
    expect(() => buildRunResult(toyRequest, twoSidedBook(), base)).toThrow(IncompatibleOverlayError);
    expect(() => buildRunResult(toyRequest, twoSidedBook(), base)).toThrow(/constant-cpr-2/);
  });
});
