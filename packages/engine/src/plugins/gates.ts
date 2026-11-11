/**
 * The two gates as waterfall listeners. The rules are
 * unchanged; what changes is who runs them and who says so. Every checked line
 * carries the listener's plugin id, so an audit reads which plugin performed
 * which check, and a bank's policy plugin can append a failure or veto by
 * returning without calling next.
 */
import type { Plugin, WaterfallListener } from "@alm/harness";
import type { AssumptionSet } from "../contracts/assumptions";
import type { GateReport, RoutingPolicy, RunPlan } from "../contracts/plan";
import type { PortfolioSpec } from "../contracts/position";
import { routingGate } from "../plan/routingGate";
import { typeGate, type StageProducers } from "../plan/typeGate";

export interface TypeCheckPayload {
  plan: RunPlan;
  portfolioAsOf: string;
  producers: StageProducers;
}

export interface RoutePayload {
  plan: RunPlan;
  policy: RoutingPolicy;
  portfolio: PortfolioSpec;
  assumptionSets: AssumptionSet[];
}

declare module "@alm/harness" {
  interface Events {
    "plan/type-check": WaterfallListener<TypeCheckPayload, GateReport>;
    "plan/route": WaterfallListener<RoutePayload, GateReport>;
  }
}

/** Fold one gate's own report into the value the chain carries, stamping the id. */
function fold(pluginId: string, value: GateReport, report: GateReport): GateReport {
  return {
    passed: value.passed && report.passed,
    failures: [...value.failures, ...report.failures],
    checked: [...value.checked, ...report.checked.map((line) => `[${pluginId}] ${line}`)],
  };
}

export const typeGatePlugin: Plugin = {
  id: "engine.gate.type",
  apply(ctx) {
    ctx.on("plan/type-check", (payload, value, next) =>
      next(fold("engine.gate.type", value, typeGate(payload.plan, payload.portfolioAsOf, payload.producers))),
    );
  },
};

export const routingGatePlugin: Plugin = {
  id: "engine.gate.routing",
  apply(ctx) {
    ctx.on("plan/route", (payload, value, next) =>
      next(
        fold(
          "engine.gate.routing",
          value,
          routingGate(payload.plan, payload.policy, payload.portfolio, payload.assumptionSets),
        ),
      ),
    );
  },
};
