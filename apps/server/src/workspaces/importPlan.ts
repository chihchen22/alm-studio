/**
 * Import of a stored RunPlan as a run setup (Studio A+E spec v3.1 Section 5.2, the
 * import paragraph; Section 2.7 rule 10; used by the setup compile's parity test and
 * by the seed's workspace generator).
 *
 * The plan template is copied field for field (a literal stage list, never
 * "derived-default", and the plan's own planId), the inputs become roles against the
 * target workspace, the scenarios become a library list when every entry is a ref and
 * the plan's own list otherwise, the set list stays explicit (never block-default),
 * and the basis is Custom when the plan names a balance plan, else Runoff. Every other
 * settings object takes its default. Compiling the result inside the workspace yields
 * the source plan's bytes (invariant 8), so anything the setup cannot carry is refused
 * here, 422, rather than imported into a document that would compile to a different plan.
 */
import { PLAN_SCHEMA_VERSION, type RunPlan } from "@alm/engine";
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import { unprocessable } from "../http/errors";
import { SETUP_NAME_MAX } from "./runSetupParse";
import { runSetupIdOf } from "./standardAlco";
import type { NiiBasis, RunSetup, SetupInputs, SetupPlanTemplate, SetupScenarios, WorkspaceManifest } from "./types";

const DEFAULT_NII_HORIZON = 60;
const DEFAULT_REPORT_HORIZONS = [12, 24, 60];

function refuse(planId: string, detail: string): never {
  throw unprocessable(`plan "${planId}" cannot be imported as a setup: ${detail}`, { planId });
}

function bookRole(plan: RunPlan, ws: WorkspaceManifest): SetupInputs["book"] {
  const id = plan.inputs.positionBook;
  if (ws.blocks.positions.book?.id === id) return { role: "base" };
  if (ws.blocks.positions.retagged.some((r) => r.id === id)) return { role: "retagged", id };
  return refuse(plan.planId, `its position book "${id}" is neither the book of workspace "${ws.id}" nor one of its retagged books`);
}

function marketRole(plan: RunPlan, ws: WorkspaceManifest): SetupInputs["market"] {
  const id = plan.inputs.marketSnapshot;
  if (ws.blocks.market.snapshot?.id === id) return { role: "base" };
  const derived = ws.blocks.market.derived.find((d) => d.id === id);
  if (derived !== undefined) return { role: "derived", definitionKey: derived.definitionKey };
  return refuse(plan.planId, `its market "${id}" is neither the base snapshot of workspace "${ws.id}" nor one of its derived markets`);
}

function basisOf(plan: RunPlan): NiiBasis {
  if (plan.balancePlan !== undefined && plan.balanceBasis !== undefined) {
    return refuse(plan.planId, "it names both balancePlan and balanceBasis");
  }
  if (plan.balancePlan !== undefined) return { kind: "custom", balancePlanId: plan.balancePlan };
  if (plan.balanceBasis !== undefined) {
    const b = plan.balanceBasis;
    // The setup's Flat arm carries the term and spread (S2b-1 lifted ruling 20's literal 60 and 0). A plan that leaves
    // either out runs the engine's own default, 60 months at 0 bp, so the setup states it; a term past the setup's
    // 360-month range would compile differently and is refused.
    const termMonths = b.termMonths ?? 60;
    const spreadOverIndexBp = b.spreadOverIndexBp ?? 0;
    if (termMonths > 360) return refuse(plan.planId, `its balanceBasis term of ${termMonths} months is beyond the setup's 360-month range`);
    return { kind: "flat", termMonths, spreadOverIndexBp };
  }
  return { kind: "runoff" };
}

export function importPlanAsSetup(plan: RunPlan, ws: WorkspaceManifest): RunSetup {
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    refuse(plan.planId, `its schema is ${JSON.stringify(plan.schemaVersion)}; re-save it on ${PLAN_SCHEMA_VERSION} first`);
  }
  if (plan.inputs.dimensionTaxonomy !== undefined) {
    refuse(plan.planId, `it names inputs.dimensionTaxonomy "${plan.inputs.dimensionTaxonomy}", which a setup does not carry`);
  }
  const policy = ws.blocks.assumptions.routingPolicy;
  if (policy === null || policy.id !== plan.inputs.routingPolicy) {
    refuse(plan.planId, `its routing policy "${plan.inputs.routingPolicy}" is not the routing policy of workspace "${ws.id}" (${policy === null ? "none attached" : `"${policy.id}"`})`);
  }
  const setIds = plan.inputs.assumptionSets ?? [];
  if (setIds.length === 0) refuse(plan.planId, "it names no assumption set");

  const scenarios: SetupScenarios = plan.scenarios.every((s) => "ref" in s)
    ? { kind: "library", refs: plan.scenarios.map((s) => (s as { ref: string }).ref) }
    : { kind: "plan-scenarios", items: plan.scenarios };

  const template: SetupPlanTemplate = {
    planId: plan.planId,
    label: plan.label,
    authoredBy: plan.authoredBy,
    ...(plan.note !== undefined ? { note: plan.note } : {}),
    stages: plan.stages,
    reports: plan.reports,
    validationRules: plan.validationRules,
    ...(plan.profile !== undefined ? { profile: plan.profile } : {}),
    ...(plan.views !== undefined ? { views: plan.views } : {}),
    ...(plan.scenarioBalancePlans !== undefined ? { scenarioBalancePlans: plan.scenarioBalancePlans } : {}),
  };

  const grid = plan.grid.horizonMonths;
  const body: Omit<RunSetup, "id"> = {
    schemaVersion: "1.0.0",
    name: plan.label.slice(0, SETUP_NAME_MAX),
    gridHorizonMonths: grid,
    inputs: { book: bookRole(plan, ws), market: marketRole(plan, ws), assumptionSetIds: [...setIds] },
    scenarios,
    plan: template,
    nii: {
      enabled: true,
      horizonMonths: Math.min(DEFAULT_NII_HORIZON, grid),
      reportHorizons: DEFAULT_REPORT_HORIZONS.filter((m) => m <= grid),
      basis: basisOf(plan),
      path: "single",
      ...(plan.newVolumeTemplates !== undefined && plan.newVolumeTemplates.length > 0 ? { templates: plan.newVolumeTemplates.map((t) => ({ ...t })) } : {}),
    },
    eve: {
      enabled: true,
      discountBasis: "all-in",
      durationMode: "base-only",
      valuationDates: "as-of",
      keyRate: false,
      channels: false,
      path: "single",
    },
    gap: {
      enabled: true,
      repricingBuckets: { kind: "monthly" },
      fixedRateLadder: false,
      liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } },
    },
    ftp: { enabled: true },
    instrumentResults: { save: false, coaNodeIds: [] },
    // An imported plan is a new setup, so it carries the corrections.
    modelConvention: CURRENT_MODEL_CONVENTION,
    batch: [],
    importedFrom: plan.planId,
    supersedes: null,
    note: "",
  };
  return { id: runSetupIdOf(body), ...body };
}
