/**
 * The pipeline-intrinsic stages: work the run DOES execute that no seam owns.
 * The contractual cash-flow pass, the TLP overlay and the balance-plan lowering
 * live inside the orchestrator and the plan compiler, not behind a registry, so
 * there is nothing for a plugin to register and each of these rows declares
 * rather than provides.
 *
 * They are here so the producer set stays honest in both directions: a plan
 * naming one of these components is executable and must not be tagged, and the
 * alias table stays a list of naming synonyms rather than a waiver that maps a
 * stage onto a plugin that does something else.
 *
 * A row here is a promise the run keeps elsewhere. When one of these stages
 * moves behind a seam, its plugin registers the executor and this comment goes
 * with it.
 */
import type { Plugin } from "@alm/harness";

/** The static contractual pass in projection/static: every position's own stream. */
export const contractualPlugin: Plugin = {
  id: "engine.contractual",
  declares: {
    kind: "contractual-cashflow",
    produces: ["Cashflow", "RepricingSchedule"],
    consumes: ["Position", "RatePath"],
  },
  apply() {
    // Nothing to register: buildRunResult's static pass is the executor.
  },
};

/**
 * The all-in funding curve built by the curve stage in run/stages (buildTLPCurve
 * / DEFAULT_TLP_CURVE). It produces FundingCurve, not ZeroCurve: the risk-free
 * leg and the all-in leg are two contract types because EVE and FTP need both
 * and an edge names one producer per consumed type.
 */
export const tlpOverlayPlugin: Plugin = {
  id: "engine.tlp-overlay",
  declares: {
    kind: "curve",
    produces: ["FundingCurve"],
    consumes: ["ZeroCurve", "MarketSnapshot"],
  },
  apply() {
    // Nothing to register: runTlpStage in run/stages is the executor.
  },
};

/** The balance plan lowered by lowerBalancePlan into each scenario's new business. */
export const balancePlanPlugin: Plugin = {
  id: "engine.balance-plan",
  declares: {
    kind: "balance-new-business",
    produces: ["Cashflow"],
    // Cashflow among the consumes: a static scenario's primary series IS the
    // contractual series, passed through unchanged, and a dynamic scenario's is
    // the reinvestment projection. Either way the stage reads the contractual
    // stage's output and answers for the primary series of every scenario.
    consumes: ["Position", "RatePath", "Cashflow"],
  },
  apply() {
    // Nothing to register: the balance stage function in run/stages is the executor.
  },
};
