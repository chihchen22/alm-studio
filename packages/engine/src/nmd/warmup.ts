/**
 * The opt-in deposit moving-average warmup.
 *
 * The kernel deposit models (NMDeposit, NMDBeta) read a 24-month moving
 * average of the one-month rate over [history ++ path] for the regime
 * amplifier 1 + alpha max(0, r - MA). Built with no history, they splice the
 * kernel's own warmup series (historical one-month SOFR to Sep 2025, MA 4.97
 * percent on the 3/31 curve), and a scenario leaves that series where it is.
 * The option instead hands every deposit a FLAT 36-month history at r0 and
 * re-levels it in each EVE scenario by the shock at tenor 0, so a parallel or
 * short-end shock moves r and MA together and the amplifier does not fire on
 * the shock itself.
 *
 * This module turns the run option into one history per scenario. Nothing
 * here touches the kernel: the history is a constructor argument the kernel
 * already takes, handed over by the instrument factory (MakeInstrumentOptions
 * nmdWarmup). A run that does not name the option builds every deposit exactly
 * as before.
 *
 * Studio slice S3a-1 adds the "history" kind: a dated monthly series (the public example bank ships the
 * published SOFR monthly averages), read up to and including the run's as-of month and handed unchanged to every
 * scenario. It also reaches dynamic scenarios, which "flat-at-r0" still refuses.
 */
import type { NmdWarmupOption, NmdWarmupRecord, NmdWarmupRequest, NmdWarmupSeries } from "../contracts/run";
import type { Scenario } from "../contracts/scenario";

/** The option resolved against one run: the record it writes and the history each scenario's deposits read. */
export interface ResolvedNmdWarmup {
  record: NmdWarmupRecord;
  /** Scenario id to its history (percent per annum, oldest first), in request order. */
  byScenario: ReadonlyMap<string, readonly number[]>;
  /** The flat history at r0 with no shift: what a block reading the base path with its own small shocks uses (SEG). */
  unshifted: readonly number[];
}

/** Resolve the shift in percent for one scenario, or refuse in a sentence naming the scenario and the field. */
function shiftOf(option: NmdWarmupOption, scenario: Scenario): number {
  const stated = option.shiftPctByScenario?.[scenario.id];
  if (stated !== undefined) return stated;
  switch (scenario.rateSpec.kind) {
    case "base":
      return 0;
    case "parallel":
      return scenario.rateSpec.shockBp / 100;
    default:
      throw new Error(
        `run: nmdWarmup cannot re-level the deposit history for scenario "${scenario.id}" (rateSpec ${scenario.rateSpec.kind}); ` +
          `state its shift at tenor 0 in percent in nmdWarmup.shiftPctByScenario`,
      );
  }
}

/** The longest history the option may ask for: 50 years, far past the 24-month moving average the deposits read. */
const NMD_WARMUP_MAX_MONTHS = 600;

/** The longest dated series a "history" option may carry: 100 years of months, of which at most 600 are read. */
const NMD_WARMUP_MAX_SERIES = 1200;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "YYYY-MM" to a month count (year x 12 + month - 1); NaN for anything else. */
function monthIndex(m: string): number {
  const x = MONTH.exec(m);
  return x === null ? Number.NaN : Number(x[1]) * 12 + Number(x[2]) - 1;
}

function monthText(i: number): string {
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** The shape problem of a "history" option's series, or undefined. */
function seriesConfigError(value: unknown, path: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${path}.series must be an object { label, firstMonth, valuesPct }, got ${JSON.stringify(value)}`;
  }
  const s = value as Record<string, unknown>;
  if (typeof s.label !== "string" || s.label.trim() === "") return `${path}.series.label must be a non-empty string naming the series and its source`;
  if (typeof s.firstMonth !== "string" || Number.isNaN(monthIndex(s.firstMonth))) {
    return `${path}.series.firstMonth must be a month "YYYY-MM", got ${JSON.stringify(s.firstMonth)}`;
  }
  if (!Array.isArray(s.valuesPct) || s.valuesPct.length === 0) return `${path}.series.valuesPct must be a non-empty array of percent values, one a month`;
  if (s.valuesPct.length > NMD_WARMUP_MAX_SERIES) return `${path}.series.valuesPct holds at most ${NMD_WARMUP_MAX_SERIES} months, got ${s.valuesPct.length}`;
  const bad = s.valuesPct.findIndex((x) => typeof x !== "number" || !Number.isFinite(x));
  if (bad >= 0) return `${path}.series.valuesPct[${bad}] must be a finite number of percent, got ${String(s.valuesPct[bad])}`;
  for (const k of Object.keys(s)) if (k !== "label" && k !== "firstMonth" && k !== "valuesPct") return `${path}.series.${k} is not a field of the series (label, firstMonth, valuesPct)`;
  return undefined;
}

/**
 * The months of a "history" series a run as of `asOf` (ISO date) reads: every month up to and including the as-of
 * month, the last NMD_WARMUP_MAX_MONTHS of them at most. Refuses, in one sentence, a series that starts after the
 * as-of month or ends before it (a gap before the projection would splice a stale level onto the path, the trap the
 * kernel's own series has).
 */
export function historyMonthsFor(series: NmdWarmupSeries, asOf: string): { values: number[]; firstMonth: string; lastMonth: string } {
  const asOfMonth = monthIndex(asOf.slice(0, 7));
  if (Number.isNaN(asOfMonth)) throw new Error(`run: nmdWarmup needs the run's as-of date to read a history, got ${JSON.stringify(asOf)}`);
  const first = monthIndex(series.firstMonth);
  const last = first + series.valuesPct.length - 1;
  if (first > asOfMonth) {
    throw new Error(`run: the nmdWarmup history "${series.label}" starts in ${series.firstMonth}, after the run's as-of month ${monthText(asOfMonth)}`);
  }
  if (last < asOfMonth) {
    throw new Error(
      `run: the nmdWarmup history "${series.label}" ends in ${monthText(last)}, before the run's as-of month ${monthText(asOfMonth)}; ` +
        `extend it to the as-of month so the deposits read no stale level`,
    );
  }
  const end = asOfMonth - first + 1;
  const start = Math.max(0, end - NMD_WARMUP_MAX_MONTHS);
  return { values: series.valuesPct.slice(start, end), firstMonth: monthText(first + start), lastMonth: monthText(asOfMonth) };
}

/**
 * The shape check every entry point runs (the run, the run route's
 * engineOptions, the run setup parser): undefined when `value` is a well-formed
 * option, else one sentence naming the field under `path`.
 */
export function nmdWarmupConfigError(value: unknown, path: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${path} must be an object { kind, months, shiftPctByScenario? }, got ${JSON.stringify(value)}`;
  }
  const v = value as Record<string, unknown>;
  if (v.kind === "history") {
    for (const k of Object.keys(v)) if (k !== "kind" && k !== "series") return `${path}.${k} is not a field of a "history" warmup (kind, series)`;
    return seriesConfigError(v.series, path);
  }
  // Fix round L1: the sentence names both kinds (the core and pack pins moved with it).
  if (v.kind !== "flat-at-r0") return `${path}.kind must be "flat-at-r0" or "history", got ${JSON.stringify(v.kind)}`;
  if (typeof v.months !== "number" || !Number.isInteger(v.months) || v.months < 1) {
    return `${path}.months must be a positive integer number of months, got ${JSON.stringify(v.months)}`;
  }
  if (v.months > NMD_WARMUP_MAX_MONTHS) {
    return `${path}.months must be at most ${NMD_WARMUP_MAX_MONTHS} months (50 years), got ${v.months}`;
  }
  const shifts = v.shiftPctByScenario;
  if (shifts !== undefined) {
    if (typeof shifts !== "object" || shifts === null || Array.isArray(shifts)) {
      return `${path}.shiftPctByScenario must be an object of scenario id to percent, got ${JSON.stringify(shifts)}`;
    }
    for (const [id, x] of Object.entries(shifts as Record<string, unknown>)) {
      if (typeof x !== "number" || !Number.isFinite(x)) {
        return `${path}.shiftPctByScenario["${id}"] must be a finite number of percent, got ${String(x)}`;
      }
    }
  }
  return undefined;
}

/** A checked option copied with its known keys only; shiftPctByScenario left out when absent or empty. */
export function nmdWarmupOf(value: NmdWarmupOption): NmdWarmupOption;
export function nmdWarmupOf(value: NmdWarmupRequest): NmdWarmupRequest;
export function nmdWarmupOf(value: NmdWarmupRequest): NmdWarmupRequest {
  if (value.kind === "history") {
    return { kind: "history", series: { label: value.series.label, firstMonth: value.series.firstMonth, valuesPct: [...value.series.valuesPct] } };
  }
  const shifts = value.shiftPctByScenario;
  return {
    kind: value.kind,
    months: value.months,
    ...(shifts !== undefined && Object.keys(shifts).length > 0 ? { shiftPctByScenario: { ...shifts } } : {}),
  };
}

/**
 * Resolve the run option. `r0Pct` is the base scenario's deterministic path at
 * step 0 in percent. Refuses, each in one sentence naming the field: a kind
 * other than "flat-at-r0", months that is not a positive integer or is above 600, a stated
 * shift that is not finite, a scenario whose new business is not static runoff
 * (the dynamic projection builds its own deposits), and a non-base,
 * non-parallel scenario with no stated shift. Keys of shiftPctByScenario that
 * name no scenario of the run are not read.
 */
export function resolveNmdWarmup(option: NmdWarmupRequest, scenarios: readonly Scenario[], r0Pct: number, asOf?: string): ResolvedNmdWarmup {
  const problem = nmdWarmupConfigError(option, "nmdWarmup");
  if (problem !== undefined) throw new Error(`run: ${problem}`);
  if (option.kind === "history") {
    // The same realized history in every scenario, static or dynamic; nothing is re-levelled.
    const read = historyMonthsFor(option.series, asOf ?? "");
    const byScenario = new Map<string, readonly number[]>();
    for (const scenario of scenarios) byScenario.set(scenario.id, read.values);
    return {
      record: { kind: "history", label: option.series.label, months: read.values.length, firstMonth: read.firstMonth, lastMonth: read.lastMonth },
      byScenario,
      unshifted: read.values,
    };
  }
  if (!Number.isFinite(r0Pct)) throw new Error(`run: nmdWarmup needs a finite r0, got ${String(r0Pct)}`);
  const byScenario = new Map<string, readonly number[]>();
  const shiftPctByScenario: Record<string, number> = {};
  for (const scenario of scenarios) {
    if (scenario.newBusiness.mode !== "static") {
      throw new Error(
        `run: nmdWarmup applies to static-runoff scenarios only; scenario "${scenario.id}" has new-business mode ` +
          `"${scenario.newBusiness.mode}", whose dynamic projection builds its own deposits`,
      );
    }
    const shift = shiftOf(option, scenario);
    shiftPctByScenario[scenario.id] = shift;
    byScenario.set(scenario.id, new Array<number>(option.months).fill(r0Pct + shift));
  }
  return {
    record: { kind: "flat-at-r0", months: option.months, levelPct: r0Pct, shiftPctByScenario },
    byScenario,
    unshifted: new Array<number>(option.months).fill(r0Pct),
  };
}
