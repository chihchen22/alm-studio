/**
 * Shock preview route.
 *
 *   POST /api/scenarios/preview   { marketSnapshot, rateSpec } -> 200 ShockPreview | 400 | 404 | 422
 *
 * Applies one rate spec to a stored market snapshot's base zero curve with the
 * engine's own functions, the ones a run and its rate document use
 * (buildBaseCurve, shockedCurve, curveNodesOf), so the preview is the curve a
 * run on that snapshot runs on. It writes nothing. The checks here are the
 * body's shape only; every value rule is the engine's, and its refusal is a 422
 * with the engine's text unchanged. An unknown snapshot is the store's 404. A snapshot
 * carrying a curveSetup block the engine refuses is a 422 whose text is
 * "The curve setup on this market: " and then the engine's refusals, never a 500. A snapshot
 * with no block builds the platform default curve (version 2, log-linear on discount factor;
 * version 1, the kernel bootstrap, for a market marked curveDefault: 1 or one version 2 cannot
 * take). A refusal of that build is a 422 whose text names what refused, then the engine's text,
 * never a 500 (curveSetupSlot.ts buildBaseCurveNamed): "The curveDefault marker on this market: "
 * for a marker other than 1, "Curve default version 1 (the kernel bootstrap) on this market: " for
 * a marked market, and "The platform default curve on this market: " for an unmarked one.
 */
import { curveNodesOf, type RateSpec } from "@alm/engine";
import { defineScenario, shockedCurve } from "@alm/engine/src/scenario";
import type { MarketSnapshot } from "@alm/kernel";
import type { PlatformContext } from "../../context";
import { buildBaseCurveNamed } from "../../workspaces/curveSetupSlot";
import { badRequest } from "../errors";
import { validated, type Router } from "../router";

/** The throwaway scenario the engine's structural gate checks; only its rate spec is the caller's. */
const GATE = "preview";

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function registerScenarioPreviewRoutes(router: Router, ctx: PlatformContext): void {
  router.add("POST", "/api/scenarios/preview", (req) => {
    const body = req.json<unknown>();
    if (!isObject(body)) throw badRequest("preview requires an object { marketSnapshot, rateSpec }");
    const { marketSnapshot, rateSpec } = body;
    if (typeof marketSnapshot !== "string" || marketSnapshot === "") {
      throw badRequest("preview requires marketSnapshot, a non-empty string");
    }
    if (!isObject(rateSpec)) throw badRequest("preview requires rateSpec, an object { kind, ... }");
    const snapshot = ctx.store.getDocument<MarketSnapshot>("market", marketSnapshot).doc;
    const spec = rateSpec as unknown as RateSpec;
    validated(() =>
      defineScenario({ id: GATE, label: GATE, rateSpec: spec, assumptionSetId: GATE, newBusiness: { mode: "static", rules: [] } }),
    );
    const baseCurve = buildBaseCurveNamed(snapshot);
    const base = curveNodesOf(baseCurve);
    const shocked = curveNodesOf(validated(() => shockedCurve(baseCurve, spec)));
    return {
      kind: "json",
      value: {
        marketSnapshot,
        calibrationDate: snapshot.calibrationDate,
        base,
        shocked,
        shiftBp: shocked.z.map((z, i) => (z - base.z[i]!) * 10_000),
      },
    };
  });
}
