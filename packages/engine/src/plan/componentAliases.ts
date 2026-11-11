/**
 * NAMING SYNONYMS ONLY. A plan authored against the component catalog says
 * "alm-nii"; the plugin that executes exactly that thing is
 * "engine.metric.nii". Every entry below is two names for one executed
 * behavior, checked against what the plugin on the left actually runs.
 *
 * This table is not a capability list and must never wave a stage through: a
 * component whose work no plugin performs belongs in neither column, and meets
 * ruling 13 in stageExecutability instead. Pipeline-intrinsic work the run
 * performs outside every seam (the contractual pass, the TLP overlay, the
 * balance-plan lowering) has its own declare-only rows in
 * plugins/pipelineStages.ts, so it is declared rather than aliased onto a
 * plugin that does something else.
 *
 * It lives in its own module because the compiler and the executor
 * both resolve a stage's component through it, and two copies of one table are
 * two tables that can drift.
 */
export const COMPONENT_ALIASES: Readonly<Record<string, string[]>> = {
  "engine.curve.bootstrap": ["alm-yield-curve", "engine.curve"],
  "engine.tlp-overlay": ["alm-tlp-overlay"],
  "engine.rate-path.deterministic": ["engine.rate-path"],
  "engine.behavioral.prepay": ["alm-mortgage-prepayment", "engine.prepay"],
  "engine.behavioral.nmd-decay": ["alm-deposit-decay", "engine.nmd-decay"],
  "engine.behavioral.deposit-beta": ["alm-deposit-beta", "engine.deposit-beta"],
  "engine.behavioral.cd-rollover": ["engine.cd-rollover"],
  // Piece 7 final fix. The short form ONLY, the cd-rollover row's shape and for
  // the same reason: no catalog component runs what this plugin runs.
  // `alm-draw-rate-model`, the catalog's draw component and the one
  // docs/harness/example-plan.json's st-draw names, is a rate-responsive
  // utilization S-curve with partial adjustment and a mean-reverting stochastic
  // arm. This plugin applies an AUTHORED monthly draw path that does not read
  // the rate path at all (commitment/terms.ts, and the limitations page says so). Those
  // are two different executed behaviors, so aliasing one onto the other would
  // be exactly the wave-through this table's header forbids: the plan would
  // compile and the bank would get a draw model it did not ask for. A plan
  // licenses a commitment-draw binding by naming this plugin, or this alias.
  "engine.behavioral.commitment-draw": ["engine.commitment-draw"],
  // The short form ONLY, the commitment-draw row's shape and for the
  // same reason: `alm-loan-client-rate` promises a specification ladder and a
  // validation battery that this plugin does not run (it carries one authored
  // flat-carry spread), so aliasing the component onto it would wave a plan through
  // that asked for a different executed behavior.
  "engine.behavioral.loan-client-rate": ["engine.loan-client-rate"],
  "engine.metric.nii": ["alm-nii", "engine.nii"],
  "engine.metric.eve": ["alm-eve", "engine.eve"],
  "engine.metric.gap": ["alm-gap-analytics", "engine.gap"],
};

const BY_ALIAS: ReadonlyMap<string, string> = new Map(
  Object.entries(COMPONENT_ALIASES).flatMap(([pluginId, aliases]) =>
    aliases.map((alias) => [alias, pluginId] as const),
  ),
);

/**
 * The plugin id a plan's component names. A component that is already a plugin
 * id, including a third-party one, returns unchanged: the table holds synonyms,
 * not a whitelist.
 */
export function resolveComponent(component: string): string {
  return BY_ALIAS.get(component) ?? component;
}
