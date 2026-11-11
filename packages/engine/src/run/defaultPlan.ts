/**
 * The default plan. A plan-less request still walks a graph:
 * this one, derived deterministically from the request, which replays the call
 * order the pre-1c pipeline ran. It is LOGGED, never stored: it carries no
 * planId and it is not persisted.
 *
 * The behavioral chain is one stage per DISTINCT overlay kind, ordered by first
 * appearance across the request's assumption sets, each stage licensing every
 * binding of its kind. The one-pass form applied a family's bindings in
 * assumption-set order; the chain applies them in chain order. The four built-in
 * appliers write disjoint fields of the terms object (cprParams, nmdParams,
 * sCurve), so a family that binds two kinds gets the same merged terms either
 * way, and the goldens are what prove it. The residual case is registered in
 * Composition is chain order, and the run log states it.
 *
 * Studio A+E contract 23: a caller that has not yet resolved its scenarios can
 * force or suppress the balance stage through `DefaultPlanOptions.balanceStage`.
 */
import { overlayKindOf } from "../contracts/assumptions";
import type { LicensedBinding, PlanStage, RunPlan } from "../contracts/plan";
import { PLAN_SCHEMA_VERSION } from "../contracts/plan";
import type { PortfolioSpec } from "../contracts/position";
import type { RunRequest } from "../contracts/run";
import type { BehavioralRegistry } from "../plugins/services";

/**
 * The component a behavioral stage of one kind names (Ruling P10): the plugin
 * that REGISTERED the kind, asked of the registry, so a third-party model
 * resolves to its author's own plugin id and the derived licensing agrees with
 * `licenseBindings`, which reads the same registry. The `engine.behavioral.*`
 * fallback covers a kind no mounted plugin owns, which is a binding the
 * assumption resolver refuses anyway: it keeps the plan well-formed so the
 * refusal comes from the resolver naming the kind, not from a blank component.
 */
function componentForKind(kind: string, behavioral?: BehavioralRegistry): string {
  return behavioral?.providerOf(kind) ?? `engine.behavioral.${kind}`;
}

/**
 * Studio A+E contract 23: a caller that has not yet resolved its scenarios can
 * force (`true`) or suppress (`false`) the balance stage. Absent, the stage is
 * derived from the request exactly as before.
 */
export interface DefaultPlanOptions {
  balanceStage?: boolean;
}

export function defaultPlanFor(
  request: RunRequest,
  portfolio: PortfolioSpec,
  behavioral?: BehavioralRegistry,
  options?: DefaultPlanOptions,
): { plan: RunPlan; licensedBindings: LicensedBinding[] } {
  const kinds: string[] = [];
  const licensedBindings: LicensedBinding[] = [];
  for (const set of request.assumptionSets) {
    for (const [bindingIndex, binding] of set.bindings.entries()) {
      const kind = overlayKindOf(binding.overlay);
      if (!kinds.includes(kind)) kinds.push(kind);
      licensedBindings.push({
        stageId: `st-behavioral-${kind}`,
        assumptionSetId: set.id,
        familyId: binding.familyId,
        kind,
        bindingIndex,
      });
    }
  }
  const dynamic = options?.balanceStage ?? request.scenarios.some((s) => s.newBusiness.mode === "dynamic");

  const stages: PlanStage[] = [
    {
      id: "st-curve",
      component: "engine.curve.bootstrap",
      kind: "curve",
      consumes: ["MarketSnapshot"],
      produces: ["ZeroCurve"],
      params: { dayCount: "ACT/360" },
    },
    {
      id: "st-tlp",
      component: "engine.tlp-overlay",
      kind: "curve",
      consumes: ["ZeroCurve", "MarketSnapshot"],
      produces: ["FundingCurve"],
      dependsOn: ["st-curve"],
      params: { dayCount: "ACT/360" },
    },
    {
      id: "st-term",
      component: "engine.rate-path.deterministic",
      kind: "term-structure",
      consumes: ["ZeroCurve"],
      produces: ["RatePath", "DiscountFactorPath"],
      dependsOn: ["st-curve"],
    },
  ];

  let previous: string | undefined;
  for (const kind of kinds) {
    const id = `st-behavioral-${kind}`;
    stages.push({
      id,
      component: componentForKind(kind, behavioral),
      kind: "behavioral",
      consumes: ["Position", "RatePath"],
      produces: ["Position"],
      dependsOn: previous === undefined ? ["st-term"] : [previous, "st-term"],
    });
    previous = id;
  }
  const lastLink = previous;
  const withLink = (ids: string[]): string[] => (lastLink === undefined ? ids : [...ids, lastLink]);

  stages.push({
    id: "st-cashflow",
    component: "engine.contractual",
    kind: "contractual-cashflow",
    consumes: ["Position", "RatePath"],
    produces: ["Cashflow", "RepricingSchedule"],
    dependsOn: withLink(["st-term"]),
  });
  if (dynamic) {
    stages.push({
      id: "st-balance",
      component: "engine.balance-plan",
      kind: "balance-new-business",
      consumes: ["Position", "RatePath", "Cashflow"],
      produces: ["Cashflow"],
      dependsOn: withLink(["st-cashflow", "st-term"]),
    });
  }
  // NII reads the PRIMARY series: the balance stage's when there is one, the
  // contractual stage's when there is not. Exactly one Cashflow producer sits in
  // its dependsOn, which is what makes the edge resolvable; the last behavioral
  // link rides along per spec Section 3.3, and produces no type this stage
  // consumes, so it cannot make the Cashflow edge ambiguous.
  stages.push({
    id: "st-nii",
    component: "engine.metric.nii",
    kind: "metric",
    consumes: ["Cashflow"],
    produces: ["NiiResult"],
    dependsOn: withLink([dynamic ? "st-balance" : "st-cashflow"]),
  });
  // Two legs, two edges: the risk-free curve from st-curve and the all-in
  // funding curve from st-tlp. Both producers are named, and neither produces
  // the other's type, so each edge resolves to exactly one stage.
  stages.push({
    id: "st-eve",
    component: "engine.metric.eve",
    kind: "metric",
    consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"],
    produces: ["EveResult"],
    dependsOn: withLink(["st-cashflow", "st-curve", "st-tlp"]),
  });
  // Gap reads the STATIC series and the static repricing ladder, never the
  // dynamic merge, which is why it points at the contractual stage even when a
  // balance stage exists.
  stages.push({
    id: "st-gap",
    component: "engine.metric.gap",
    kind: "metric",
    consumes: ["Cashflow", "RepricingSchedule", "Position"],
    produces: ["GapResult"],
    dependsOn: withLink(["st-cashflow"]),
  });
  stages.push({
    id: "st-ftp",
    component: "engine.metric.ftp",
    kind: "metric",
    consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"],
    produces: ["FtpResult"],
    dependsOn: withLink(["st-cashflow", "st-curve", "st-tlp", "st-term", "st-nii"]),
  });

  const plan: RunPlan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: "",
    label: "derived default plan",
    authoredBy: "orchestrator",
    asOf: request.grid.asOf,
    grid: { horizonMonths: request.grid.horizonMonths },
    inputs: {
      marketSnapshot: "<request>",
      positionBook: portfolio.id,
      routingPolicy: "<none>",
      assumptionSets: request.assumptionSets.map((s) => s.id),
    },
    stages,
    scenarios: [],
    reports: [],
    validationRules: { typeGate: [], routingGate: [] },
  };
  return { plan, licensedBindings };
}
