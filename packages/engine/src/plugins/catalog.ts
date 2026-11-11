/**
 * The built-in catalog and the default profile. Every built-in is mounted the
 * same way a user plugin is: one row, one plugin id. A plan without a profile
 * compiles against DEFAULT_PROFILE, so every schema 1.1.0 plan still runs.
 *
 * Row order is mount order, not load order: the kernel resolves activation from
 * `inject`, so the registry owners could be listed last and nothing would move.
 */
import type { PluginCatalog, Plugin, Profile } from "@alm/harness";
import {
  behavioralRegistryPlugin,
  cdRolloverPlugin,
  commitmentDrawPlugin,
  depositBetaPlugin,
  loanClientRatePlugin,
  nmdDecayPlugin,
  prepayPlugin,
} from "./behavioral";
import { curveBootstrapPlugin } from "./curves";
import { routingGatePlugin, typeGatePlugin } from "./gates";
import {
  balanceSummaryMetricPlugin,
  eveMetricPlugin,
  ftpMetricPlugin,
  gapMetricPlugin,
  lcrRegulatoryMetricPlugin,
  lcrScenarioMetricPlugin,
  metricRegistryPlugin,
  niiMetricPlugin,
  survivalHorizonMetricPlugin,
  walGapMetricPlugin,
} from "./metrics";
import { balancePlanPlugin, contractualPlugin, tlpOverlayPlugin } from "./pipelineStages";
import { positionsRegistryPlugin } from "./positions";
import { deterministicRatePathPlugin, ratePathRegistryPlugin } from "./ratePaths";
import { runLogPlugin } from "./runLog";
import { scenarioRegistryPlugin, shippedScenariosPlugin } from "./scenarios";

const BUILTINS: Plugin<any>[] = [
  runLogPlugin,
  curveBootstrapPlugin,
  tlpOverlayPlugin,
  ratePathRegistryPlugin,
  deterministicRatePathPlugin,
  contractualPlugin,
  behavioralRegistryPlugin,
  prepayPlugin,
  nmdDecayPlugin,
  depositBetaPlugin,
  cdRolloverPlugin,
  commitmentDrawPlugin,
  loanClientRatePlugin,
  balancePlanPlugin,
  positionsRegistryPlugin,
  scenarioRegistryPlugin,
  shippedScenariosPlugin,
  metricRegistryPlugin,
  niiMetricPlugin,
  eveMetricPlugin,
  gapMetricPlugin,
  ftpMetricPlugin,
  balanceSummaryMetricPlugin,
  walGapMetricPlugin,
  survivalHorizonMetricPlugin,
  lcrScenarioMetricPlugin,
  lcrRegulatoryMetricPlugin,
  typeGatePlugin,
  routingGatePlugin,
];

export const BUILTIN_CATALOG: PluginCatalog = new Map(BUILTINS.map((p) => [p.id, p]));

/** One row per built-in. The row id is the plugin id with the "engine." prefix dropped. */
export const DEFAULT_PROFILE: Profile = {
  rows: BUILTINS.map((p) => ({ id: p.id.replace(/^engine\./, ""), plugin: p.id })),
};
