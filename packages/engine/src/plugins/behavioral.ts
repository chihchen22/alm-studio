import type { Plugin } from "@alm/harness";
import { applyOverlayToTerms } from "../projection/static/applyOverlays";
import { makeKeyedRegistry } from "./registry";
import type { BehavioralApplier, BehavioralRegistry } from "./services";

function makeBehavioralRegistry(): BehavioralRegistry {
  const shelf = makeKeyedRegistry<BehavioralApplier>("behavioral");
  return {
    register(kind, applier, ownerPluginId) { return shelf.register(kind, applier, ownerPluginId); },
    get(kind) { return shelf.get(kind); },
    providerOf(kind) { return shelf.providerOf(kind); },
    has(kind) { return shelf.has(kind); },
    kinds() { return shelf.ids(); },
  };
}

export const behavioralRegistryPlugin: Plugin = {
  id: "engine.behavioral.registry",
  apply(ctx) {
    ctx.provide("behavioral", makeBehavioralRegistry());
  },
};

/**
 * The six built-in kinds. Each holds a reference to the same
 * applyOverlayToTerms, whose switch already owns the six arms, so mounting
 * them cannot move a number. A user plugin registers a further kind with its own
 * applier and the switch never sees it.
 *
 * They declare `Position -> Position` because that is what they do: the engine's
 * overlays rewrite position TERMS (applyOverlayToTerms) and the contractual pass
 * then runs on the rewritten book. Declaring `Cashflow` said the opposite, and
 * the arrows in every plan were decorative because of it.
 */
function kindPlugin(id: string, kind: string): Plugin {
  return {
    id,
    inject: ["behavioral"],
    declares: { kind: "behavioral", produces: ["Position"], consumes: ["Position", "RatePath"] },
    apply(ctx) {
      const registry = ctx.get("behavioral");
      ctx.effect(() => registry.register(kind, applyOverlayToTerms, id));
    },
  };
}

export const prepayPlugin = kindPlugin("engine.behavioral.prepay", "prepay");
export const nmdDecayPlugin = kindPlugin("engine.behavioral.nmd-decay", "nmd-decay");
export const depositBetaPlugin = kindPlugin("engine.behavioral.deposit-beta", "deposit-beta");
export const cdRolloverPlugin = kindPlugin("engine.behavioral.cd-rollover", "cd-rollover");
export const commitmentDrawPlugin = kindPlugin("engine.behavioral.commitment-draw", "commitment-draw");
export const loanClientRatePlugin = kindPlugin("engine.behavioral.loan-client-rate", "loan-client-rate");
