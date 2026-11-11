/**
 * The closed lens reader set.
 *
 * A reader is a PURE function from one scenario of a stored RunResult to one
 * number, to an unobservable reason, or to a refusal. It reads an envelope
 * field and never recomputes one, and it never infers the base scenario
 * from a zero delta: the base id is handed in.
 *
 * Three outcomes, not two. The spec's Section 3 table requires
 * cumulativeLiquidityGap to REFUSE when the scenario carries no liquidity
 * ladder, and readLens is the only thing in this piece that throws, so a reader
 * reports a refusal as data and lens.ts raises it. That also keeps this module
 * free of any import from lens.ts.
 *
 * Unobservable means the number does not exist as a concept for this run (base
 * NII of zero, a horizon the run did not compute, a band a short ladder does
 * not reach) or in this build (capital). A refusal means the envelope cannot
 * answer at all.
 */
import type { ScenarioNII } from "../contracts/results";
import type { RunResult } from "../contracts/run";
import type { LensReaderId } from "../contracts/lens";

export { LENS_READER_IDS, type LensReaderId } from "../contracts/lens";

export type ReaderOutcome =
  | { kind: "value"; value: number }
  | { kind: "unobservable"; reason: string }
  | { kind: "refusal"; missing: string };

export interface ReaderInput {
  result: RunResult;
  /** The scenario being scored. */
  scenarioId: string;
  /** The scenario a delta reader anchors to; derived from the run's request, never inferred. */
  baseScenarioId: string;
  /** The constraint's parameters, already validated against the reader's shape by rule V4. */
  params?: Record<string, string | number>;
}

export type LensReader = (input: ReaderInput) => ReaderOutcome;

/**
 * Scenario-total net NII at a horizon. The 1.2.0 map is the source; the pinned
 * totalNet12 / totalNet24 fields are the fallback for an ARCHIVED pre-1.2.0
 * envelope that carries no map, and only at those two horizons. Absent means
 * the run did not compute that horizon.
 */
function netAt(entry: ScenarioNII, horizonMonths: number): number | undefined {
  const byHorizon = entry.totalNetByHorizon;
  if (byHorizon !== undefined) {
    const v = byHorizon[horizonMonths];
    return typeof v === "number" ? v : undefined;
  }
  if (horizonMonths === 12) return entry.totalNet12;
  if (horizonMonths === 24) return entry.totalNet24;
  return undefined;
}

/**
 * One entry of a map the ENVELOPE carries, looked up by a name a lens author
 * supplied. Only an own property counts: the maps are plain objects and an
 * inherited member is not a reading.
 */
function own<T>(map: Record<string, T> | undefined, name: string): T | undefined {
  if (map === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
}

export const LENS_READERS: Readonly<Record<LensReaderId, LensReader>> = {
  /** Decimal fraction of base EVE, read verbatim off the envelope (results.ts unit pin). */
  deltaEvePct: ({ result, scenarioId }) => {
    const scn = result.eve.byScenario.find((s) => s.scenarioId === scenarioId);
    if (scn === undefined) {
      return {
        kind: "refusal",
        missing: `the eve block carries no entry for scenario "${scenarioId}"`,
      };
    }
    if (typeof scn.deltaEvePct !== "number") {
      return {
        kind: "refusal",
        missing: `the eve entry for scenario "${scenarioId}" carries no deltaEvePct`,
      };
    }
    return { kind: "value", value: scn.deltaEvePct };
  },

  /**
   * Decimal fraction of base NII at the asked horizon: (N_s - N_base) / |N_base|.
   * A horizon is observable exactly when the run reported it. The engine's own
   * list is [12, 24]; since Studio piece D slice three a run launched from a
   * setup carries the setup's report horizons (default [12, 24, 60], spec
   * decision 119), so 60 months is a value on such a run and stays unobservable
   * on a run that reports [12, 24] only. Nothing here special-cases 60: the
   * reader reads whichever horizon map the envelope carries.
   */
  deltaNiiPct: ({ result, scenarioId, baseScenarioId, params }) => {
    const horizonMonths = Number(params?.horizonMonths);
    const scn = result.nii.byScenario.find((s) => s.scenarioId === scenarioId);
    if (scn === undefined) {
      return {
        kind: "refusal",
        missing: `the nii block carries no entry for scenario "${scenarioId}"`,
      };
    }
    const base = result.nii.byScenario.find((s) => s.scenarioId === baseScenarioId);
    if (base === undefined) {
      return {
        kind: "refusal",
        missing: `the nii block carries no entry for the base scenario "${baseScenarioId}"`,
      };
    }
    const horizons = result.nii.horizonsMonths.join(", ");
    const nBase = netAt(base, horizonMonths);
    if (nBase === undefined) {
      return {
        kind: "unobservable",
        reason:
          `the base scenario "${baseScenarioId}" carries no net NII at horizon ` +
          `${horizonMonths} months; this run reports horizons [${horizons}]`,
      };
    }
    const nScn = netAt(scn, horizonMonths);
    if (nScn === undefined) {
      return {
        kind: "unobservable",
        reason:
          `scenario "${scenarioId}" carries no net NII at horizon ${horizonMonths} months; ` +
          `this run reports horizons [${horizons}]`,
      };
    }
    if (nBase === 0) {
      return {
        kind: "unobservable",
        reason:
          `base NII at horizon ${horizonMonths} months is zero, so a fractional change is ` +
          `undefined`,
      };
    }
    return { kind: "value", value: (nScn - nBase) / Math.abs(nBase) };
  },

  /** Currency: assets minus liabilities, cumulative through the named band. */
  cumulativeLiquidityGap: ({ result, scenarioId, params }) => {
    const band = String(params?.band);
    const ladder = result.gap.liquidity.find((l) => l.scenarioId === scenarioId);
    if (ladder === undefined) {
      return {
        kind: "refusal",
        missing: `the gap block carries no liquidity ladder for scenario "${scenarioId}"`,
      };
    }
    const row = ladder.rows.find((r) => r.band.label === band);
    if (row === undefined) {
      return {
        kind: "unobservable",
        reason:
          `the liquidity ladder for scenario "${scenarioId}" carries no band "${band}"; its ` +
          `bands are [${ladder.rows.map((r) => r.band.label).join(", ")}] (a horizon shorter ` +
          `than a band's start truncates the ladder)`,
      };
    }
    return { kind: "value", value: row.cumulativeGap };
  },

  /** Count. An absent arm means none, by the envelope's own contract (results.ts, shortfalls). */
  shortfallCount: ({ result, scenarioId }) => {
    const scn = result.nii.byScenario.find((s) => s.scenarioId === scenarioId);
    if (scn === undefined) {
      return {
        kind: "refusal",
        missing: `the nii block carries no entry for scenario "${scenarioId}"`,
      };
    }
    return { kind: "value", value: scn.shortfalls?.length ?? 0 };
  },

  /**
   * Always unobservable. It exists to prove the unobservable path end to end and
   * nothing else, until a capital component exists (non-goals).
   */
  capitalRatio: () => ({
    kind: "unobservable",
    reason: "no capital metric on the envelope; a capital component is a later release",
  }),

  /**
   * One named value of one custom metric. The unit is the key's own
   * declared unit, which the envelope carries beside the number.
   *
   * UNOBSERVABLE versus REFUSAL. An arm the run never produced, a metric the
   * envelope does not carry, and a key this scenario's row leaves out are all
   * FACTS ABOUT THE RUN, so they are unobservable with a reason, exactly as
   * capitalRatio is in this build. A key the metric does not DECLARE, or a
   * scenario the metric carries no row for, is an AUTHOR ERROR or a broken
   * result, and the reading must not hide it behind a soft answer.
   */
  customValue: ({ result, scenarioId, params }) => {
    const metricId = String(params?.metricId);
    const key = String(params?.key);
    // OWN PROPERTY, not a plain index. Both maps are plain objects, so a
    // metricId or a key of "constructor" or "toString" would resolve to an
    // inherited member rather than to undefined, and the absent guard below
    // would not fire. Those names match CUSTOM_METRIC_ID_PATTERN, so V4 cannot
    // block them and a reader, which is contracted never to throw, would.
    const metric = own(result.custom, metricId);
    if (metric === undefined) {
      return {
        kind: "unobservable",
        reason:
          `no custom metric "${metricId}" on the envelope; the run named no stage producing it`,
      };
    }
    if (!metric.keys.some((k) => k.id === key)) {
      return {
        kind: "refusal",
        missing:
          `custom metric "${metricId}" declares no key "${key}"; its keys are ` +
          `[${metric.keys.map((k) => k.id).join(", ")}]`,
      };
    }
    const row = metric.byScenario.find((s) => s.scenarioId === scenarioId);
    if (row === undefined) {
      return {
        kind: "refusal",
        missing: `custom metric "${metricId}" carries no row for scenario "${scenarioId}"`,
      };
    }
    const value = own(row.values, key);
    if (typeof value !== "number") {
      return {
        kind: "unobservable",
        reason: `metric "${metricId}" reports no "${key}" for this scenario`,
      };
    }
    return { kind: "value", value };
  },
};
