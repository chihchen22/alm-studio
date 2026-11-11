/**
 * The loan-client-rate overlay kind (flat carry, mortgage
 * only) wired end to end. The applier is a static no-op, so adding the binding
 * moves no number; the client-rate path itself is produced in a later slice.
 * Expected values are restated here, never read from the code under test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mountProfile } from "@alm/harness";
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet, BehavioralOverlay, OverlayBinding } from "../../contracts/assumptions";
import { OVERLAY_KIND_TO_CLASS, derivedClassesByFamily } from "../../plan/behavioralClasses";
import { resolveComponent } from "../../plan/componentAliases";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { applyOverlayToTerms, StaticOverlayError } from "../../projection/static/applyOverlays";
import { clearPortfolios } from "../../portfolio/registry";
import { createEngine } from "../../run";
import { defaultPlanFor } from "../../run/defaultPlan";
import { runStochastic } from "../../run/stochastic";
import {
  baseAssumptions,
  fixedPosition,
  loadMarket,
  makeCoa,
  makeRunRequest,
  mortgagePosition,
  regulatoryScenarios,
  twoSidedBook,
} from "../../run/__tests__/fixtures";
import { AssumptionValidationError, bindAssumptions } from "../bindAssumptions";
import { IncompatibleOverlayError, OverlayParamError, resolveAssumptions } from "../resolveAssumptions";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const clientRate = (over: Record<string, unknown> = {}): BehavioralOverlay =>
  ({ kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 250, ...over }) as unknown as BehavioralOverlay;

const binding = (familyId: string, overlay: BehavioralOverlay): OverlayBinding => ({
  familyId,
  overlay,
  modelVersion: "illustrative-flat-carry-1",
});

/** The fixture base set plus a loan-client-rate binding on the mortgage family. */
function withClientRate(overlay: BehavioralOverlay = clientRate(), id = "AS-BASE"): AssumptionSet {
  const set = baseAssumptions(id);
  set.bindings.push(binding("MORTGAGE", overlay));
  return set;
}

const setOf = (b: OverlayBinding): AssumptionSet => ({ schemaVersion: "1.0.0", id: "as-cr", label: "cr", bindings: [b] });

describe("bindAssumptions: the model literal and the spread bounds", () => {
  it("refuses model reverting at bindings[0].overlay.model, the model issue first", () => {
    const set = setOf(binding("MORTGAGE", clientRate({ model: "reverting", totalSpreadBp: -1 })));
    let err: unknown;
    try {
      bindAssumptions(set);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AssumptionValidationError);
    expect((err as AssumptionValidationError).field).toBe("bindings[0].overlay.model");
    expect((err as Error).message).toBe('invalid assumption set at bindings[0].overlay.model: Model must be "flat-carry"');
  });
  it("names an absent model", () => {
    const o = clientRate() as unknown as Record<string, unknown>;
    delete o.model;
    expect(() => bindAssumptions(setOf(binding("MORTGAGE", o as unknown as BehavioralOverlay)))).toThrow(
      "invalid assumption set at bindings[0].overlay.model: Model is missing",
    );
  });
  it("refuses an out-of-range spread at bindings[0].overlay.totalSpreadBp", () => {
    expect(() => bindAssumptions(setOf(binding("MORTGAGE", clientRate({ totalSpreadBp: 1000.5 }))))).toThrow(
      "invalid assumption set at bindings[0].overlay.totalSpreadBp: Total spread must be at most 1000",
    );
  });
  it("binds a good set and fills the content hash", () => {
    const bound = bindAssumptions(setOf(binding("MORTGAGE", clientRate())));
    expect(typeof bound.contentHash).toBe("string");
  });
});

describe("resolveAssumptions: loan-client-rate", () => {
  it("resolves flat carry with its spread", () => {
    const r = resolveAssumptions(withClientRate(), makeCoa().families);
    const ov = r.overlays.find((o) => o.kind === ("loan-client-rate" as string));
    expect(ov).toMatchObject({ kind: "loan-client-rate", familyId: "MORTGAGE", model: "flat-carry", totalSpreadBp: 250 });
  });
  it.each([-1, 1001, Number.NaN, Number.POSITIVE_INFINITY])("throws OverlayParamError on totalSpreadBp %s", (v) => {
    expect(() => resolveAssumptions(withClientRate(clientRate({ totalSpreadBp: v })), makeCoa().families)).toThrow(OverlayParamError);
  });
  it("accepts the bounds 0 and 1000", () => {
    // Alone on the family: with a four-factor prepay binding present the spread
    // must equal sec + prim, so the domain bounds are tested without one.
    for (const v of [0, 1000]) {
      expect(() => resolveAssumptions(setOf(binding("MORTGAGE", clientRate({ totalSpreadBp: v }))), makeCoa().families)).not.toThrow();
    }
  });
  it("throws OverlayParamError on model reverting and on an absent model", () => {
    expect(() => resolveAssumptions(withClientRate(clientRate({ model: "reverting" })), makeCoa().families)).toThrow(OverlayParamError);
    const o = clientRate() as unknown as Record<string, unknown>;
    delete o.model;
    expect(() => resolveAssumptions(withClientRate(o as unknown as BehavioralOverlay), makeCoa().families)).toThrow(OverlayParamError);
  });
});

describe("compatibility: mortgage only", () => {
  it("refuses a binding on the fixed-loan family", () => {
    const set = setOf(binding("FIXED", clientRate()));
    expect(() => resolveAssumptions(set, makeCoa().families)).toThrow(IncompatibleOverlayError);
  });
  it("accepts a binding on the mortgage family", () => {
    expect(() => resolveAssumptions(setOf(binding("MORTGAGE", clientRate())), makeCoa().families)).not.toThrow();
  });
});

describe("plan classes and component names", () => {
  it("derives client-rate-asset for the mortgage family", () => {
    expect(OVERLAY_KIND_TO_CLASS["loan-client-rate"]).toBe("client-rate-asset");
    const m = derivedClassesByFamily([withClientRate()]);
    expect([...m.get("MORTGAGE")!].sort()).toEqual(["client-rate-asset", "prepayment"]);
  });
  it("aliases the short form only", () => {
    expect(resolveComponent("engine.loan-client-rate")).toBe("engine.behavioral.loan-client-rate");
    expect(resolveComponent("alm-loan-client-rate")).toBe("alm-loan-client-rate");
  });
});

describe("the static applier is a no-op", () => {
  it("returns a mortgage's terms deep-equal", () => {
    const terms = mortgagePosition("M1").terms;
    expect(applyOverlayToTerms(terms, clientRate(), "M1")).toEqual(terms);
  });
  it("throws StaticOverlayError on a fixed-loan's terms", () => {
    expect(() => applyOverlayToTerms(fixedPosition("F1").terms, clientRate(), "F1")).toThrow(StaticOverlayError);
  });
});

describe("no number moves", () => {
  function runBoth(): { base: ReturnType<ReturnType<typeof createEngine>["run"]>; bound: ReturnType<ReturnType<typeof createEngine>["run"]> } {
    clearPortfolios();
    const engine = createEngine();
    engine.loadPortfolio(twoSidedBook());
    const base = engine.run(makeRunRequest(market));
    clearPortfolios();
    const engine2 = createEngine();
    engine2.loadPortfolio(twoSidedBook());
    const bound = engine2.run(makeRunRequest(market, { assumptionSets: [withClientRate()] }));
    return { base, bound };
  }

  it("every RunResult key except provenance is deep-equal with and without the binding, on the base and +200 scenarios", () => {
    const { base, bound } = runBoth();
    expect(bound.notImplemented).toEqual([]);
    const keys = Object.keys(base).filter((k) => k !== "provenance");
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) {
      expect((bound as unknown as Record<string, unknown>)[k], k).toEqual((base as unknown as Record<string, unknown>)[k]);
    }
    const ids = bound.eve.byScenario.map((s) => s.scenarioId);
    expect(ids).toContain("S0");
    expect(ids).toContain("S200");
    // The binding is visible in provenance only.
    expect(JSON.stringify(bound.provenance)).not.toBe(JSON.stringify(base.provenance));
  });

  it("a plan-less run licenses the binding and derives a stage naming the plugin", () => {
    const request = makeRunRequest(market, { assumptionSets: [withClientRate()] });
    const ctx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    try {
      const { plan, licensedBindings } = defaultPlanFor(request, twoSidedBook(), ctx.get("behavioral"));
      const stage = plan.stages.find((s) => s.id === "st-behavioral-loan-client-rate");
      expect(stage?.component).toBe("engine.behavioral.loan-client-rate");
      expect(licensedBindings.some((b) => b.kind === "loan-client-rate" && b.familyId === "MORTGAGE")).toBe(true);
    } finally {
      ctx.dispose();
    }
  });

  it("a stochastic run with the binding completes", () => {
    const req = makeRunRequest(market, { scenarios: regulatoryScenarios().slice(0, 1), assumptionSets: [withClientRate()] });
    const sto = runStochastic(req, twoSidedBook(), { nPaths: 32 });
    expect(Number.isFinite(sto.eveDistribution.mean)).toBe(true);
  });
});
