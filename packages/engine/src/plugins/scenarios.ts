import type { Plugin } from "@alm/harness";
import type { ScenarioLibrary } from "../contracts/scenario";
import { SHIPPED_LIBRARIES } from "../scenario/library";
import { makeKeyedRegistry } from "./registry";
import type { ScenarioLibraryRegistry } from "./services";

function makeScenarioRegistry(): ScenarioLibraryRegistry {
  const shelf = makeKeyedRegistry<ScenarioLibrary>("scenarios");
  return {
    register(libraryId, library) { return shelf.register(libraryId, library); },
    get(libraryId) { return shelf.get(libraryId); },
    list() { return shelf.values(); },
  };
}

export const scenarioRegistryPlugin: Plugin = {
  id: "engine.scenarios.registry",
  apply(ctx) {
    ctx.provide("scenarios", makeScenarioRegistry());
  },
};

/** The four shipped libraries, in SHIPPED_LIBRARIES order. */
export const shippedScenariosPlugin: Plugin = {
  id: "engine.scenarios.shipped",
  inject: ["scenarios"],
  apply(ctx) {
    const registry = ctx.get("scenarios");
    for (const library of SHIPPED_LIBRARIES) {
      ctx.effect(() => registry.register(library.id, library));
    }
  },
};
