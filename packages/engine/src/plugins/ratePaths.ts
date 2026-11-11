import type { Plugin } from "@alm/harness";
import { buildScenarioRatePath } from "../projection/static/staticRunoff";
import { makeKeyedRegistry } from "./registry";
import type { RatePathFn, RatePathRegistry } from "./services";

function makeRatePathRegistry(): RatePathRegistry {
  const shelf = makeKeyedRegistry<RatePathFn>("ratePaths");
  return {
    register(modelId, fn, ownerPluginId) { return shelf.register(modelId, fn, ownerPluginId); },
    get(modelId) { return shelf.get(modelId); },
    providerOf(modelId) { return shelf.providerOf(modelId); },
    has(modelId) { return shelf.has(modelId); },
    ids() { return shelf.ids(); },
  };
}

/** Owns the ratePaths shelf so several model plugins can register into it. */
export const ratePathRegistryPlugin: Plugin = {
  id: "engine.rate-path.registry",
  apply(ctx) {
    ctx.provide("ratePaths", makeRatePathRegistry());
  },
};

const DETERMINISTIC_ID = "engine.rate-path.deterministic";

/** The deterministic shocked path the headline grid runs on. */
export const deterministicRatePathPlugin: Plugin = {
  id: DETERMINISTIC_ID,
  inject: ["ratePaths"],
  declares: { kind: "term-structure", produces: ["RatePath", "DiscountFactorPath"], consumes: ["ZeroCurve"] },
  apply(ctx) {
    const registry = ctx.get("ratePaths");
    // Through effect, so the model leaves the shelf when this row unwinds and
    // the row can be mounted again without refusing as a duplicate.
    // The owner id is passed so the run log credits this plugin by name for
    // every path the model builds, third-party models included.
    ctx.effect(() => registry.register("deterministic", buildScenarioRatePath, DETERMINISTIC_ID));
  },
};
