import type { Dispose, Plugin } from "@alm/harness";
import { CUSTOM_METRIC_ID_PATTERN } from "../contracts/customMetric";
import { computeEve } from "../eve";
import { computeFtpResult } from "../ftp";
import { buildGapFromSeries } from "../gap";
import { computeNII } from "../nii";
import { computeBalanceSummary } from "../report/balanceSummary";
import { computeLcrRegulatory, computeLcrScenario } from "../report/lcr";
import { computeSurvivalHorizon } from "../report/survivalHorizon";
import { computeWalGap } from "../report/walGap";
import { CustomMetricRegistrationError } from "./errors";
import { makeKeyedRegistry } from "./registry";
import type { CustomMetricFn, EngineMetricId, MetricFns, MetricRegistry } from "./services";

/** The four built-in engine metric ids, restated so a custom id cannot shadow one. */
const BUILT_IN_METRIC_IDS: readonly string[] = ["nii", "eve", "gap", "ftp"];

interface CustomEntry {
  metricId: string;
  fn: CustomMetricFn;
  owner: string;
}

/**
 * Two shelves, not one. The four built-in ids keep the typed shelf
 * they always had, so `get`, `has`, `ids` and `providerOf` answer exactly as
 * before and the closed EngineMetricId union does not move. A custom metric
 * sits on a second shelf keyed by its own id and owned by exactly one plugin.
 */
function makeMetricRegistry(): MetricRegistry {
  const shelf = makeKeyedRegistry<MetricFns[EngineMetricId]>("metrics");
  const custom = new Map<string, CustomEntry>();
  return {
    register<K extends EngineMetricId>(metricId: K, fn: MetricFns[K], ownerPluginId?: string) {
      return shelf.register(metricId, fn as MetricFns[EngineMetricId], ownerPluginId);
    },
    get<K extends EngineMetricId>(metricId: K): MetricFns[K] {
      return shelf.get(metricId) as MetricFns[K];
    },
    providerOf(metricId) { return shelf.providerOf(metricId); },
    has(metricId) { return shelf.has(metricId); },
    ids() { return shelf.ids(); },
    registerCustom(metricId: string, fn: CustomMetricFn, ownerPluginId: string): Dispose {
      if (!CUSTOM_METRIC_ID_PATTERN.test(metricId)) {
        throw new CustomMetricRegistrationError(
          metricId,
          `the id must match ${String(CUSTOM_METRIC_ID_PATTERN)}`,
        );
      }
      if (BUILT_IN_METRIC_IDS.includes(metricId)) {
        throw new CustomMetricRegistrationError(
          metricId,
          `"${metricId}" is a built-in engine metric id; a custom metric takes an id of its own`,
        );
      }
      if (custom.has(metricId)) {
        throw new CustomMetricRegistrationError(
          metricId,
          `it is already registered by plugin "${custom.get(metricId)!.owner}"`,
        );
      }
      for (const entry of custom.values()) {
        if (entry.owner !== ownerPluginId) continue;
        throw new CustomMetricRegistrationError(
          metricId,
          `plugin "${ownerPluginId}" already registers custom metric "${entry.metricId}"; ` +
            `one custom metric per plugin`,
        );
      }
      const entry: CustomEntry = { metricId, fn, owner: ownerPluginId };
      custom.set(metricId, entry);
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        // Identity, not presence: a stale dispose must never delete the entry a
        // later plugin put here. Same rule as makeKeyedRegistry's undo.
        if (custom.get(metricId) === entry) custom.delete(metricId);
      };
    },
    customByPlugin(pluginId: string) {
      for (const entry of custom.values()) {
        if (entry.owner === pluginId) return { metricId: entry.metricId, fn: entry.fn };
      }
      return undefined;
    },
    customIds() { return [...custom.keys()]; },
  };
}

export const metricRegistryPlugin: Plugin = {
  id: "engine.metric.registry",
  apply(ctx) {
    ctx.provide("metrics", makeMetricRegistry());
  },
};

const NII_ID = "engine.metric.nii";

export const niiMetricPlugin: Plugin = {
  id: NII_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["NiiResult"], consumes: ["Cashflow"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.register("nii", computeNII, NII_ID));
  },
};

const EVE_ID = "engine.metric.eve";

export const eveMetricPlugin: Plugin = {
  id: EVE_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["EveResult"], consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.register("eve", computeEve, EVE_ID));
  },
};

const GAP_ID = "engine.metric.gap";

export const gapMetricPlugin: Plugin = {
  id: GAP_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["GapResult"], consumes: ["Cashflow", "RepricingSchedule", "Position"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.register("gap", buildGapFromSeries, GAP_ID));
  },
};

const FTP_ID = "engine.metric.ftp";

export const ftpMetricPlugin: Plugin = {
  id: FTP_ID,
  inject: ["metrics"],
  // FtpResult, not NiiResult: the ftp block is its own result slot and has been
  // since schema 1.2.0. NiiResult and RatePath are among the consumes because
  // the module bridges against the base NII row VERBATIM, never a
  // recomputation, and par-matches along the base scenario's own path.
  declares: { kind: "metric", produces: ["FtpResult"], consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.register("ftp", computeFtpResult, FTP_ID));
  },
};

const BALANCE_SUMMARY_ID = "engine.metric.balance-summary";

/**
 * The shipped demonstration custom metric. It is
 * MOUNTED by the default profile and RUN by nothing: a plan that names no stage
 * on this component behaves exactly as it did before this plugin existed, and
 * the derived default plan names none.
 *
 * Its declares are the ruling-6 pair and no more: T6 holds a metric stage's
 * consumes to equality with its plugin's, so "Cashflow" and "Position" here is
 * what makes a custom stage consuming anything else a compile refusal.
 */
export const balanceSummaryMetricPlugin: Plugin = {
  id: BALANCE_SUMMARY_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["CustomMetricResult"], consumes: ["Cashflow", "Position"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.registerCustom("balance-summary", computeBalanceSummary, BALANCE_SUMMARY_ID));
  },
};

const WAL_GAP_ID = "engine.metric.wal-gap";

/**
 * The second built-in custom metric: asset and liability WAL, their
 * gap and their ratio. Like the demonstration metric beside it, it is MOUNTED
 * by the default profile and RUN by nothing; a plan that names no stage on this
 * component behaves exactly as it did before this plugin existed.
 *
 * Since piece 5a a plan names at most one stage PER custom metric, so a plan
 * may run `balance-summary` and `wal-gap` together and may not run either
 * twice. Mounting both costs nothing: mounting is not running.
 *
 * Its declares are the ruling-6 pair and no more, for the same reason the
 * demonstration metric's are: T6 holds a metric stage's consumes to equality
 * with its plugin's.
 */
export const walGapMetricPlugin: Plugin = {
  id: WAL_GAP_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["CustomMetricResult"], consumes: ["Cashflow", "Position"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.registerCustom("wal-gap", computeWalGap, WAL_GAP_ID));
  },
};

const SURVIVAL_HORIZON_ID = "engine.metric.survival-horizon";

/**
 * The third built-in custom metric and the first liquidity metric:
 * the whole months a tagged buffer covers cumulative net outflow as each
 * scenario projects it; since piece 5c the liquidity stress is engine input,
 * not a table in the metric. MOUNTED by the default
 * profile and RUN by nothing, like the two before it; since piece 5a a plan
 * may run it beside them, each at most once.
 *
 * Its declares are the ruling-6 pair and no more: T6 holds a metric stage's
 * consumes to equality with its plugin's.
 */
export const survivalHorizonMetricPlugin: Plugin = {
  id: SURVIVAL_HORIZON_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["CustomMetricResult"], consumes: ["Cashflow", "Position"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() =>
      registry.registerCustom("survival-horizon", computeSurvivalHorizon, SURVIVAL_HORIZON_ID),
    );
  },
};

const LCR_SCENARIO_ID = "engine.metric.lcr-scenario";

/**
 * The LCR on each scenario's own projected month-1 flows, the fourth
 * built-in custom metric. Applies no stress of its own (the ruling).
 * MOUNTED by the default profile and RUN only when a plan names it. Declares
 * the ruling-6 pair and no more.
 *
 * Commitment scope. Only OPTIONAL capacity is modeled: draws that are
 * contractually destined to fund on a schedule, construction milestones and
 * committed-but-undisbursed term loans among them, are not represented at all.
 * The drawn money is NOT booked as an earning asset, so NII, EVE and gap do not
 * move when a line is drawn; the engine models the cash going out and nothing
 * else. This arm reads the projected draw out of each scenario's flows.
 */
export const lcrScenarioMetricPlugin: Plugin = {
  id: LCR_SCENARIO_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["CustomMetricResult"], consumes: ["Cashflow", "Position"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.registerCustom("lcr-scenario", computeLcrScenario, LCR_SCENARIO_ID));
  },
};

const LCR_REGULATORY_ID = "engine.metric.lcr-regulatory";

/**
 * The LCR on the US rule's run-off rates by `lcr-category`, the fifth
 * built-in custom metric. MOUNTED by the default profile and RUN only when a
 * plan names it; a plan may run it beside `lcr-scenario`.
 *
 * Commitment scope. Only OPTIONAL capacity is modeled: draws that are
 * contractually destined to fund on a schedule, construction milestones and
 * committed-but-undisbursed term loans among them, are not represented at all.
 * The drawn money is NOT booked as an earning asset, so NII, EVE and gap do not
 * move when a line is drawn; the engine models the cash going out and nothing
 * else. This arm rates the UNDRAWN amount read off the book by
 * `commitment-category`, so it is scenario-invariant.
 */
export const lcrRegulatoryMetricPlugin: Plugin = {
  id: LCR_REGULATORY_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["CustomMetricResult"], consumes: ["Cashflow", "Position"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() => registry.registerCustom("lcr-regulatory", computeLcrRegulatory, LCR_REGULATORY_ID));
  },
};
