// apps/studio/src/guided/setup.ts
/**
 * The one run setup the guided Analysis path builds, and the pure edits each step
 * makes to it. The setup is an ordinary run setup document in the slot `setup-guided`: plans and the plan composer stay
 * under Advanced, and the Advanced Run setups screen opens this setup like any other.
 *
 * It is created by the New volume step's answer to "What happens to maturing balances?", so no basis is ever chosen
 * for the user. Its other fields start where Standard ALCO starts (the regulatory parallel grid, NII over 60 months on
 * 12, 24 and 60 month horizons, monthly gap buckets, FTP on, per-position results off) and change only through the
 * steps. Two starts differ from Standard ALCO: EVE is discounted on the risk-free curve
 * with no product spread (the regulatory reading; all-in is one choice away on the Simulation step), and each family's
 * new volume starts as the product its own positions suggest (`nii.templates`). A setup saved before S2b-1 keeps its
 * discount basis and its fixed bullet: nothing here rewrites a stored document.
 */
import type { NiiBasis, RunSetup, SetupScenarios } from "@alm/reader";
import type { NewVolumeTemplateSpec, PlanScenarioRef, ScenarioDefinition, ViewDef } from "@alm/engine";
import { SRP31_USD } from "@alm/engine/src/scenario/library";
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import { GUIDED_SETUP_NAME } from "./steps";

/** The answer to "What happens to maturing balances?". */
export type MaturingAnswer = { kind: "runoff" } | { kind: "flat" } | { kind: "custom"; balancePlanId: string };

export function basisOf(answer: MaturingAnswer): NiiBasis {
  if (answer.kind === "flat") return { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 };
  if (answer.kind === "runoff") return { kind: "runoff" };
  return { kind: "custom", balancePlanId: answer.balancePlanId };
}

export function answerOf(basis: NiiBasis): MaturingAnswer {
  if (basis.kind === "custom") return { kind: "custom", balancePlanId: basis.balancePlanId };
  return { kind: basis.kind };
}

export const PARALLEL_REFS: readonly string[] = [
  "regulatory-grid-v1#S0",
  "regulatory-grid-v1#S100",
  "regulatory-grid-v1#S-100",
  "regulatory-grid-v1#S200",
  "regulatory-grid-v1#S-200",
];
export const BASE_REF = "regulatory-grid-v1#S0";
export const TWIST_REFS: readonly string[] = ["steepener-v1#STEEP100", "flattener-v1#FLAT100"];

/** The new guided setup, without its id (the server hashes one); `templates` are the families' starting products. */
export function guidedSetupBody(answer: MaturingAnswer, templates: readonly NewVolumeTemplateSpec[] = []): Omit<RunSetup, "id"> {
  return {
    schemaVersion: "1.0.0",
    name: GUIDED_SETUP_NAME,
    gridHorizonMonths: 360,
    inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } },
    scenarios: { kind: "library", refs: [...PARALLEL_REFS] },
    plan: {
      planId: null,
      label: GUIDED_SETUP_NAME,
      authoredBy: "person",
      stages: "derived-default",
      reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
      validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
    },
    nii: { enabled: true, horizonMonths: 60, reportHorizons: [12, 24, 60], basis: basisOf(answer), path: "single", ...(templates.length > 0 ? { templates: templates.map((t) => ({ ...t })) } : {}) },
    eve: { enabled: true, discountBasis: NEW_GUIDED_DISCOUNT, durationMode: "base-only", valuationDates: "as-of", keyRate: false, channels: false, path: "single" },
    gap: { enabled: true, repricingBuckets: { kind: "monthly" }, fixedRateLadder: false, liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } } },
    ftp: { enabled: true },
    instrumentResults: { save: false, coaNodeIds: [] },
    // A new analysis runs the corrections.
    modelConvention: CURRENT_MODEL_CONVENTION,
    batch: [],
    importedFrom: null,
    supersedes: null,
    note: "",
  };
}

/** A setup document as the save body carries it: no id, and `supersedes` naming the document it replaces. */
export function nextVersion(current: RunSetup, edit: (s: Omit<RunSetup, "id">) => Omit<RunSetup, "id">): Omit<RunSetup, "id"> {
  const { id, ...body } = current;
  return { ...edit(body), supersedes: id };
}

export function withBasis(s: Omit<RunSetup, "id">, answer: MaturingAnswer): Omit<RunSetup, "id"> {
  return { ...s, nii: { ...s.nii, basis: basisOf(answer) } };
}

/** The setup with the families' new-volume products; an empty list removes the field, back to today's rule. */
export function withTemplates(s: Omit<RunSetup, "id">, templates: readonly NewVolumeTemplateSpec[]): Omit<RunSetup, "id"> {
  const { templates: _drop, ...nii } = s.nii;
  return { ...s, nii: templates.length === 0 ? nii : { ...nii, templates: templates.map((t) => ({ ...t })) } };
}

// ---------------------------------------------------------------------------
// Horizon and discounting (S2b-1 spec points 5 and 6)
// ---------------------------------------------------------------------------

/** EVE's discount basis on a new guided setup: the risk-free curve, no product spread. */
export const NEW_GUIDED_DISCOUNT = "risk-free" as const;

/** The two discount bases the Simulation step offers; the third the engine knows stays under Advanced. */
export type GuidedDiscount = "risk-free" | "all-in";

export const DISCOUNT_LABEL: Record<GuidedDiscount, string> = { "risk-free": "Risk-free curve, no product spread", "all-in": "All-in: the risk-free curve plus the funding spread" };

/** The earnings horizon a learner sets: the NII window and the report horizons, each from 12 to 360 months. */
export const HORIZON_MIN = 12;
export const HORIZON_MAX = 360;

/**
 * The setup with the NII window and report horizons the Simulation step sets. The projection grid (gridHorizonMonths)
 * is not touched: it stays where the setup has it (360 on a guided setup), so value (EVE) always counts every cash
 * flow to the end of each position's life whatever the earnings horizon is.
 */
export function withHorizon(s: Omit<RunSetup, "id">, windowMonths: number, reportHorizons: readonly number[]): Omit<RunSetup, "id"> {
  const next = { ...s, nii: { ...s.nii, horizonMonths: windowMonths, reportHorizons: [...reportHorizons] } };
  // Ruling 2026-11-03: a going-concern span that reads "the whole earnings horizon" follows the new horizon, so it
  // is never past it; at or under the default 12 months the default applies and the field goes.
  if (s.eve.goingConcernSpan === undefined) return next;
  const { goingConcernSpan: _s, ...eve } = s.eve;
  return { ...next, eve: windowMonths > GOING_CONCERN_DEFAULT_MONTHS ? { ...eve, goingConcernSpan: windowMonths } : eve };
}

/**
 * The problems with a typed earnings horizon and report horizons, in words; empty when they are fine. Each is a whole
 * number of months from 12 to 360 (and within the setup's grid); the report horizons rise strictly.
 */
export function horizonProblems(windowText: string, horizonsText: string, gridHorizonMonths: number): string[] {
  const max = Math.min(HORIZON_MAX, gridHorizonMonths);
  const out: string[] = [];
  const w = /^\d+$/.test(windowText.trim()) ? Number(windowText.trim()) : NaN;
  if (!(w >= HORIZON_MIN && w <= max)) out.push(`Type the earnings horizon as a whole number of months from ${HORIZON_MIN} to ${max}.`);
  const parts = horizonsText.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) out.push("Name at least one report horizon, in months.");
  const hs = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (hs.some((h) => !(h >= HORIZON_MIN && h <= max))) out.push(`Each report horizon is a whole number of months from ${HORIZON_MIN} to ${max}.`);
  else if (hs.some((h, i) => i > 0 && h <= hs[i - 1]!)) out.push("List the report horizons from the shortest to the longest, each once.");
  else if (w >= HORIZON_MIN && hs.some((h) => h > w)) out.push(`Each report horizon is at most the earnings horizon (${w} months): the results show and sum ${w} months.`);
  return out;
}

/** The report horizons typed as "12, 24, 60". Call on text with no problem. */
export function readHorizons(text: string): number[] {
  return text.split(/[\s,]+/).filter((p) => p !== "").map(Number);
}

/** The setup with EVE discounted on one of the two guided bases. */
export function withDiscount(s: Omit<RunSetup, "id">, basis: GuidedDiscount): Omit<RunSetup, "id"> {
  return { ...s, eve: { ...s.eve, discountBasis: basis } };
}

// ---------------------------------------------------------------------------
// New volume in value and the gap (S2b-2 spec points 2 and 3): two opt-ins, off by default
// ---------------------------------------------------------------------------

/** The two opt-ins: going-concern EVE beside run-off EVE, and the forecast gap arm beside the contractual ladders. */
export interface NewVolumeViews {
  goingConcern: boolean;
  forecastGap: boolean;
  /**
   * Which new volume going-concern value counts (ruling 2026-11-03): "default", the first 12 months (or the
   * earnings horizon when it is shorter), or "horizon", the whole earnings horizon, never past it.
   */
  span: "default" | "horizon";
}

/** The default going-concern span (ruling 2026-11-03): 12 months, or the earnings horizon when it is shorter. */
export const GOING_CONCERN_DEFAULT_MONTHS = 12;

export function newVolumeViewsOf(s: Pick<RunSetup, "eve" | "gap">): NewVolumeViews {
  return { goingConcern: s.eve.goingConcern === true, forecastGap: s.gap.forecast === true, span: s.eve.goingConcernSpan !== undefined ? "horizon" : "default" };
}

/**
 * The setup with the two opt-ins. A choice that is off removes its field, so a setup that never asked for either is
 * the document it was; run-off EVE and the contractual ladders are computed either way. The span is written
 * only beside going-concern value, and only when it is the whole earnings horizon and that horizon is longer than the
 * default 12 months.
 */
export function withNewVolumeViews(s: Omit<RunSetup, "id">, v: NewVolumeViews): Omit<RunSetup, "id"> {
  const { goingConcern: _g, goingConcernSpan: _s, ...eve } = s.eve;
  const { forecast: _f, ...gap } = s.gap;
  const horizon = s.nii.horizonMonths;
  const extend = v.span === "horizon" && horizon > GOING_CONCERN_DEFAULT_MONTHS;
  const gc = v.goingConcern ? { ...eve, goingConcern: true, ...(extend ? { goingConcernSpan: horizon } : {}) } : eve;
  return { ...s, eve: gc, gap: v.forecastGap ? { ...gap, forecast: true } : gap };
}

// ---------------------------------------------------------------------------
// Scenarios (spec point 8): presets, custom tenor shocks, saved into the setup. Ramps are not offered.
// ---------------------------------------------------------------------------

export type ScenarioPreset = "parallel" | "regulatory-six" | "twists";

export const PRESETS: ReadonlyArray<{ id: ScenarioPreset; label: string; sentence: string }> = [
  { id: "parallel", label: "Parallel grid", sentence: "Every rate up or down by the same amount: +100, -100, +200 and -200 bp, immediate." },
  {
    id: "regulatory-six",
    label: "The six standardized shocks",
    sentence: "The six prescribed interest rate risk shocks of the international standard: parallel up and down 200 bp, short rate up and down, steepener and flattener. A US bank reads them as an international reference.",
  },
  { id: "twists", label: "Twists", sentence: "The front end held, the long end up 100 bp (steepener) or down 100 bp (flattener), pivot at five years." },
];

/** One custom tenor shock: an id, a label and the shock in basis points at each tenor in years. */
export interface CustomShock {
  id: string;
  label: string;
  knots: Array<{ tenorYears: number; shockBp: number }>;
}

export interface ScenarioChoice {
  presets: ScenarioPreset[];
  custom: CustomShock[];
}

/** The six standardized shocks as the engine defines them: custom tenor knots, no assumption set (the setup's applies). */
export function regulatorySix(): ScenarioDefinition[] {
  return SRP31_USD.scenarios.map((s) => ({ id: s.id, label: s.label!, rateSpec: s.rateSpec }));
}

const SIX_IDS = new Set(["SRP-PUP", "SRP-PDN", "SRP-SUP", "SRP-SDN", "SRP-STEEP", "SRP-FLAT"]);

/**
 * The setup's scenarios for a choice. The base scenario always comes first, once. Presets of library scenarios only
 * stay a library list; any inline definition (the six standardized shocks, a custom shock) makes the list the setup's
 * own scenarios, refs and definitions mixed, which the compile reads verbatim.
 */
export function scenariosOf(choice: ScenarioChoice): SetupScenarios {
  const refs: string[] = [BASE_REF];
  if (choice.presets.includes("parallel")) for (const r of PARALLEL_REFS) if (!refs.includes(r)) refs.push(r);
  if (choice.presets.includes("twists")) refs.push(...TWIST_REFS);
  const inline: ScenarioDefinition[] = [];
  if (choice.presets.includes("regulatory-six")) inline.push(...regulatorySix());
  for (const c of choice.custom) inline.push({ id: c.id, label: c.label, rateSpec: { kind: "custom", shocks: c.knots.map((k) => ({ tenorYears: k.tenorYears, shockBp: k.shockBp })) } });
  if (inline.length === 0) return { kind: "library", refs };
  const items: PlanScenarioRef[] = [...refs.map((ref) => ({ ref })), ...inline];
  return { kind: "plan-scenarios", items };
}

/** The choice a setup's scenarios hold, read back for the builder; null when they were written some other way (a slate). */
export function choiceOf(sc: SetupScenarios): ScenarioChoice | null {
  if (sc.kind === "slate") return null;
  const refs = sc.kind === "library" ? sc.refs : sc.items.flatMap((i) => ("ref" in i ? [i.ref] : []));
  const inline = sc.kind === "library" ? [] : sc.items.filter((i): i is ScenarioDefinition => !("ref" in i));
  const presets: ScenarioPreset[] = [];
  if (PARALLEL_REFS.slice(1).every((r) => refs.includes(r))) presets.push("parallel");
  const six = inline.filter((d) => SIX_IDS.has(d.id));
  if (six.length === SIX_IDS.size) presets.push("regulatory-six");
  if (TWIST_REFS.every((r) => refs.includes(r))) presets.push("twists");
  const custom: CustomShock[] = [];
  for (const d of inline) {
    if (SIX_IDS.has(d.id)) continue;
    if (d.rateSpec.kind !== "custom") return null;
    custom.push({ id: d.id, label: d.label ?? d.id, knots: d.rateSpec.shocks.map((k) => ({ tenorYears: k.tenorYears, shockBp: k.shockBp })) });
  }
  const known = new Set([BASE_REF, ...PARALLEL_REFS, ...TWIST_REFS]);
  if (refs.some((r) => !known.has(r))) return null;
  return { presets, custom };
}

export function withScenarios(s: Omit<RunSetup, "id">, choice: ScenarioChoice): Omit<RunSetup, "id"> {
  return { ...s, scenarios: scenariosOf(choice) };
}

/** How many scenarios a choice runs, the base included. */
export function scenarioCount(choice: ScenarioChoice): number {
  const sc = scenariosOf(choice);
  return sc.kind === "library" ? sc.refs.length : sc.kind === "plan-scenarios" ? sc.items.length : 0;
}

// ---------------------------------------------------------------------------
// Simulation (spec point 7)
// ---------------------------------------------------------------------------

export type SimulationModel = "hull-white-1f" | "bgm-lmm-2f";

export type SimulationChoice = { kind: "deterministic" } | { kind: "stochastic"; model: SimulationModel; nPaths: number; seed: string };

export const DEFAULT_PATHS = 256;
export const MIN_PATHS = 20;
export const DEFAULT_SEED = "42";

export const MODEL_LABEL: Record<SimulationModel, string> = { "hull-white-1f": "Hull-White one factor", "bgm-lmm-2f": "BGM (LIBOR market model), two factor" };

export function simulationOf(s: Pick<RunSetup, "eve">): SimulationChoice {
  const st = s.eve.stochastic;
  if (st === undefined) return { kind: "deterministic" };
  return { kind: "stochastic", model: st.model ?? "hull-white-1f", nPaths: st.nPaths, seed: st.seed ?? DEFAULT_SEED };
}

/** The setup with the choice: a stochastic choice is stored beside the one-path EVE settings, which the launch compile ignores. */
export function withSimulation(s: Omit<RunSetup, "id">, choice: SimulationChoice): Omit<RunSetup, "id"> {
  const { stochastic: prev, ...eve } = s.eve;
  if (choice.kind === "deterministic") return { ...s, eve };
  // A saved calibration chosen on the Calibration step stays while the model is the same; another model drops it.
  const keep = prev?.calibrationId !== undefined && (prev.model ?? "hull-white-1f") === choice.model ? { calibrationId: prev.calibrationId } : {};
  return { ...s, eve: { ...eve, stochastic: { nPaths: choice.nPaths, seed: choice.seed, model: choice.model, ...keep } } };
}

/**
 * The setup's stochastic choice with a saved calibration (`id`), or fitting at run time (null).
 * Only the calibration changes: paths, seed and model stay as the Simulation step saved them.
 */
export function withCalibration(s: Omit<RunSetup, "id">, id: string | null): Omit<RunSetup, "id"> {
  const st = s.eve.stochastic;
  if (st === undefined) throw new Error("Choose a stochastic run on the Simulation step first: a saved fit is used by a stochastic run.");
  const { calibrationId: _drop, ...rest } = st;
  return { ...s, eve: { ...s.eve, stochastic: id === null ? rest : { ...rest, calibrationId: id } } };
}

/** The problems with a typed path count and seed, in words; empty when they are fine. Paths: even, MIN_PATHS to DEFAULT_PATHS. */
export function simulationProblems(nPathsText: string, seedText: string): string[] {
  const out: string[] = [];
  const n = /^\d+$/.test(nPathsText.trim()) ? Number(nPathsText.trim()) : NaN;
  if (!Number.isInteger(n)) out.push("Type the number of paths as a whole number.");
  else if (n < MIN_PATHS || n > DEFAULT_PATHS) out.push(`Use from ${MIN_PATHS} to ${DEFAULT_PATHS} paths.`);
  else if (n % 2 !== 0) out.push("Use an even number of paths: they run in mirrored pairs.");
  if (!/^\d+$/.test(seedText.trim())) out.push("Type the seed as a whole number.");
  return out;
}

/**
 * The POST /api/runs body for the guided setup's stochastic choice: the workspace's book, its base snapshot, a base
 * slate and the workspace's default assumption set. The engine runs the base scenario only and projects static
 * run-off on every path; the body says nothing it does not run.
 */
export function stochasticRunBody(p: { portfolioId: string; marketId: string; slateId: string; assumptionSetId: string; choice: Extract<SimulationChoice, { kind: "stochastic" }>; label: string }) {
  return {
    portfolioId: p.portfolioId,
    marketId: p.marketId,
    scenarioSlateId: p.slateId,
    assumptionSetIds: [p.assumptionSetId],
    seed: p.choice.seed,
    mode: "stochastic",
    stochastic: { nPaths: p.choice.nPaths, model: p.choice.model },
    label: p.label,
  };
}

/** The base-only slate the stochastic launch reads: one scenario, no rate shock, static run-off. */
export function baseSlate(id: string, assumptionSetId: string) {
  return {
    id,
    label: "Base scenario for a stochastic run (guided path)",
    scenarios: [{ id: "S0", label: "Base", rateSpec: { kind: "base" as const }, assumptionSetId, newBusiness: { mode: "static" as const, rules: [] } }],
  };
}

// ---------------------------------------------------------------------------
// Report extras (spec point 9): what a re-run adds
// ---------------------------------------------------------------------------

/**
 * The setup with per-position results saved for every position: the platform asks for at least one chart-of-accounts
 * node when saving is on, and a summation node reaches its leaves, so the book's top-level nodes cover every position.
 */
export function withInstrumentResults(s: Omit<RunSetup, "id">, rootNodeIds: readonly string[]): Omit<RunSetup, "id"> {
  return { ...s, instrumentResults: { save: true, coaNodeIds: [...rootNodeIds] } };
}

/** The setup with a view grouping by one dimension added (kept once). */
export function withView(s: Omit<RunSetup, "id">, dimension: string, label: string): Omit<RunSetup, "id"> {
  const id = `by-${dimension}`;
  const views: ViewDef[] = [...(s.plan.views ?? []).filter((v) => v.id !== id), { id, label, groupBy: [dimension] }];
  return { ...s, plan: { ...s.plan, views } };
}

// ---------------------------------------------------------------------------
// The deposit history (point 6)
// ---------------------------------------------------------------------------

/** The months a deposit's moving average reads before the as-of month counts: the kernel deposits' 24-month window. */
export const DEPOSIT_HISTORY_MIN_MONTHS = 24;

function monthIndexOf(yyyyMm: string): number {
  const m = /^(\d{4})-(\d{2})/.exec(yyyyMm);
  return m === null ? Number.NaN : Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** True when a dated history reaches the as-of month and holds at least the moving average's 24 months up to it. */
export function historyCovers(h: { firstMonth: string; lastMonth: string }, asOfDate: string): boolean {
  const asOf = monthIndexOf(asOfDate);
  const first = monthIndexOf(h.firstMonth);
  const last = monthIndexOf(h.lastMonth);
  if (Number.isNaN(asOf) || Number.isNaN(first) || Number.isNaN(last)) return false;
  return asOf <= last && asOf - first + 1 >= DEPOSIT_HISTORY_MIN_MONTHS;
}

/**
 * A new analysis's deposits read the shipped public SOFR monthly history when it covers the workspace's date (slice
 * K1); otherwise the setup is left as it is and its deposits read the kernel's built-in series, which the
 * Market step says in one line. A setup that already names a history keeps it.
 */
export function withDepositHistory(
  s: Omit<RunSetup, "id">,
  h: { firstMonth: string; lastMonth: string; nmdWarmup: NonNullable<RunSetup["nmdWarmup"]> },
  asOfDate: string,
): Omit<RunSetup, "id"> {
  if (s.nmdWarmup !== undefined || !historyCovers(h, asOfDate)) return s;
  return { ...s, nmdWarmup: JSON.parse(JSON.stringify(h.nmdWarmup)) as NonNullable<RunSetup["nmdWarmup"]> };
}

/** Which rate history a setup's deposits read, in one plain line (the Market step). */
/** The most months of a history a run reads: the engine reads at most the last 600 up to the as-of month. */
const HISTORY_READ_MAX_MONTHS = 600;

const monthTextOf = (i: number): string => `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

/**
 * Which rate history a setup's deposits read, in one plain line (the Market step). For a dated history it names the
 * window a run as of `asOfDate` reads (fix round L7): from the series' start, or 600 months before the as-of month,
 * to the as-of month; without a date, the series' whole span.
 */
export function depositHistoryLine(s: Pick<RunSetup, "nmdWarmup"> | null, asOfDate?: string): string {
  const w = s?.nmdWarmup;
  if (w === undefined) {
    return s === null
      ? "Deposits will read the published SOFR monthly history when it covers your workspace date; otherwise the engine's built-in rate series."
      : "Deposits read the engine's built-in rate series: hand-set rate levels from January 2001, not a published history.";
  }
  if (w.kind === "history") {
    const firstIdx = monthIndexOf(w.series.firstMonth);
    let lastIdx = firstIdx + w.series.valuesPct.length - 1;
    let startIdx = firstIdx;
    const asOf = asOfDate === undefined ? Number.NaN : monthIndexOf(asOfDate);
    if (!Number.isNaN(asOf) && asOf >= firstIdx && asOf <= lastIdx) {
      lastIdx = asOf;
      startIdx = Math.max(firstIdx, asOf - HISTORY_READ_MAX_MONTHS + 1);
    }
    const first = monthTextOf(startIdx);
    const last = monthTextOf(lastIdx);
    // The series label carries its source in parentheses; the line names the series, the Details name the source.
    const name = w.series.label.split(" (")[0]!;
    return `Deposits read the rate history "${name}", ${first} to ${last}.`;
  }
  return `Deposits read a flat ${w.months}-month history at the base rate, moved by each scenario's shock.`;
}
