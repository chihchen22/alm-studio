import type { Plugin } from "@alm/harness";
import { buildBaseCurve } from "../scenario/rateEnvironment";

/**
 * The curve seam. Wraps buildBaseCurve: a market's curveSetup block, curve default version 1 (the
 * kernel bootstrap, for a market marked curveDefault: 1 or a fallback) or curve default version 2 (the
 * engine curve builder, log-linear on discount factor, for every other market). The kernel is untouched.
 */
export const curveBootstrapPlugin: Plugin = {
  id: "engine.curve.bootstrap",
  declares: { kind: "curve", produces: ["ZeroCurve"], consumes: ["MarketSnapshot"] },
  apply(ctx) {
    ctx.provide("curves", { build: buildBaseCurve });
  },
};
