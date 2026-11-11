import type { Plugin } from "@alm/harness";
import { getPortfolio, loadPortfolio } from "../portfolio/registry";
import { makeKeyedRegistry } from "./registry";
import type { PositionSource, PositionSourceRegistry } from "./services";

function makePositionRegistry(): PositionSourceRegistry {
  const shelf = makeKeyedRegistry<PositionSource>("positions");
  return {
    register(sourceId, source) { return shelf.register(sourceId, source); },
    get(sourceId) { return shelf.get(sourceId); },
    has(sourceId) { return shelf.has(sourceId); },
    ids() { return shelf.ids(); },
  };
}

/** The in-process portfolio registry, under source id "engine". */
export const positionsRegistryPlugin: Plugin = {
  id: "engine.positions.registry",
  declares: { kind: "panel-intake", produces: ["Position"] },
  apply(ctx) {
    const registry = makePositionRegistry();
    ctx.effect(() => registry.register("engine", { load: loadPortfolio, get: getPortfolio }));
    ctx.provide("positions", registry);
  },
};
