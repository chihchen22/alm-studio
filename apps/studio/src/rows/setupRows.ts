// apps/studio/src/rows/setupRows.ts
/**
 * Run setup screen rows, pure (spec v3.1 Sections 3.5, 5.2 and 6). Everything here is copy, a choice table
 * or a small transformation of a setup document: no balance-sheet number is computed, and no value is invented that
 * the server did not return. Reserved controls carry the piece that will honour them; a setting this release cannot
 * honour is a disabled choice with its one-line reason, never a working option.
 */
import type { LiquidityStressParams, PlanScenarioRef, RateSpec, ScenarioDefinition, ScenarioLibrary } from "@alm/engine";
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import {
  ApiError,
  type EveSettings,
  type GapSettings,
  type LaunchBatchRefusal,
  type LaunchGateRefusal,
  type LaunchReply,
  type MarketBlock,
  type NiiBasis,
  type NiiSettings,
  type ReadinessItem,
  type ReadinessReport,
  type ReadinessState,
  type RunSetup,
  type RunSetupListed,
  type SetupLiquidityStress,
  type SetupInputs,
  type SetupScenarios,
  type WorkspaceRunRow,
} from "@alm/reader";
import { errText } from "../errText";
import { plural } from "./plural";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const SETUP_TABS = [
  { id: "measures", label: "Measures" },
  { id: "scenarios", label: "Scenarios" },
  { id: "path", label: "Path" },
  { id: "batch", label: "Batch" },
  { id: "views", label: "Views" },
] as const;
export type SetupTab = (typeof SETUP_TABS)[number]["id"];

/** The tab a `?tab=` names; Measures when it names none. The old Scenario sets layer forwards with tab=scenarios. */
export function setupTabOf(value: string | undefined): SetupTab {
  return SETUP_TABS.find((t) => t.id === value)?.id ?? "measures";
}

// ---------------------------------------------------------------------------
// The balance sheet basis (rulings 18 and 20)
// ---------------------------------------------------------------------------

export const FLAT_BASIS: Extract<NiiBasis, { kind: "flat" }> = { kind: "flat", termMonths: 60, spreadOverIndexBp: 0 };

export interface BasisChoice {
  kind: NiiBasis["kind"];
  label: string;
}

/** The three choices in the spec's order, with its exact words. */
export const BASIS_CHOICES: readonly BasisChoice[] = [
  { kind: "flat", label: "Flat (default): balances held at opening, 60-month fixed bullets at the par swap rate" },
  { kind: "runoff", label: "Runoff (no new business)" },
  { kind: "custom", label: "Custom dynamic (targets per family or strategic node)" },
];

/** Ruling 20: the flat top-up is labelled honestly. */
export const FLAT_NOTE =
  "Simple top-up, not like-for-like: a maturing 5/1 ARM or a decaying deposit is replaced by a 60-month fixed bullet at the par swap rate. " +
  "A family whose setup carries a new-volume product (set on the Analysis path's New volume step) is topped up with that product instead. " +
  "Families skipped: derivative families and any family with no positive opening balance; the validation report lists them.";

export const RUNOFF_NOTE = "Runoff: balances decay as the book runs off; a 60-month NII on this basis falls mechanically.";

export const CUSTOM_NEEDS_PLAN = "Attach a balance plan under Balance Sheet, Strategy to run a custom dynamic basis.";

export function customNote(planId: string): string {
  return (
    `Custom dynamic: balances follow the targets of balance plan ${planId}, lowered per family or per strategic chart of account node. ` +
    `Balance Sheet, Strategy shows the target path and pricing. Every NII figure is labelled Custom dynamic (${planId}).`
  );
}

/** The sentence under the basis note naming the families a setup gives a new-volume product; null when none. */
export function templatesNote(templates: readonly { familyId: string; rateType: string; amortization: string; termMonths: number }[] | undefined): string | null {
  if (templates === undefined || templates.length === 0) return null;
  const list = templates.map((t) => `${t.familyId} (${t.rateType}, ${t.amortization}, ${t.termMonths} months)`).join(", ");
  return `New-volume products: ${list}. Every other family keeps the fixed bullet. The products are edited on the Analysis path's New volume step and kept when this setup is saved here.`;
}

/** The note under the basis control for the basis now chosen. */
export function basisNote(basis: NiiBasis): string {
  if (basis.kind === "flat") return FLAT_NOTE;
  if (basis.kind === "runoff") return RUNOFF_NOTE;
  return customNote(basis.balancePlanId);
}

/** NII settings with the basis switched; Custom names `planId` (the first plan when none is named). */
export function withBasis(nii: NiiSettings, kind: NiiBasis["kind"], planId: string | null): NiiSettings {
  if (kind === "flat") return { ...nii, basis: { ...FLAT_BASIS } };
  if (kind === "runoff") return { ...nii, basis: { kind: "runoff" } };
  return { ...nii, basis: { kind: "custom", balancePlanId: planId ?? (nii.basis.kind === "custom" ? nii.basis.balancePlanId : "") } };
}

/** A short basis name for the list and the batch rows: as chosen on the setup, before any compile has labelled it. */
export function basisChosenText(basis: NiiBasis): string {
  if (basis.kind === "flat") return "Flat (default)";
  if (basis.kind === "runoff") return "Runoff";
  return `Custom dynamic (${basis.balancePlanId})`;
}

export function basisValueOf(basis: NiiBasis): string {
  return basis.kind === "custom" ? `custom:${basis.balancePlanId}` : basis.kind;
}

export function basisFromValue(value: string): NiiBasis {
  if (value.startsWith("custom:")) return { kind: "custom", balancePlanId: value.slice("custom:".length) };
  return value === "runoff" ? { kind: "runoff" } : { ...FLAT_BASIS };
}

// ---------------------------------------------------------------------------
// Assumption sets
// ---------------------------------------------------------------------------

export const DEFAULT_SET_VALUE = "__default";
export const KEEP_LIST_VALUE = "__keep";

export interface SelectChoice {
  value: string;
  label: string;
  disabled: boolean;
}

/** The workspace default first, then the block's sets ("The assumption set control"). */
export function assumptionSetOptions(defaultSetId: string | null, setIds: readonly string[]): SelectChoice[] {
  const first: SelectChoice = {
    value: DEFAULT_SET_VALUE,
    label: `Workspace default (${defaultSetId ?? "none attached yet"})`,
    disabled: false,
  };
  return [first, ...setIds.map((id) => ({ value: id, label: id, disabled: false }))];
}

/** What the select shows for a setup's `assumptionSetIds`. A list of several imported sets is kept, not replaced. */
export function assumptionSelectValue(ids: SetupInputs["assumptionSetIds"]): string {
  if (!Array.isArray(ids)) return DEFAULT_SET_VALUE;
  return ids.length === 1 ? ids[0]! : KEEP_LIST_VALUE;
}

/** The "keep" option for an imported list the select cannot otherwise name; null when there is none to keep. */
export function keepListOption(ids: SetupInputs["assumptionSetIds"]): SelectChoice | null {
  if (!Array.isArray(ids) || ids.length === 1) return null;
  return { value: KEEP_LIST_VALUE, label: `Keep the imported list (${plural(ids.length, "set", "sets")})`, disabled: false };
}

export function assumptionSetIdsFrom(value: string, current: SetupInputs["assumptionSetIds"]): SetupInputs["assumptionSetIds"] {
  if (value === DEFAULT_SET_VALUE) return { kind: "block-default" };
  if (value === KEEP_LIST_VALUE) return current;
  return [value];
}

// ---------------------------------------------------------------------------
// The market input: a setup names the base snapshot or a derived market by its
// definition key, which survives a roll-forward and a re-apply (setupCompile.ts:264-279).
// ---------------------------------------------------------------------------

export const BASE_MARKET_VALUE = "base";
export const DERIVED_MARKET_PREFIX = "derived:";
/** The base choice when the editor is given no market block (older callers and tests). */
export const BASE_MARKET_CHOICE: SelectChoice = { value: BASE_MARKET_VALUE, label: "Base snapshot", disabled: false };

export function marketInputChoices(block: MarketBlock): SelectChoice[] {
  const base: SelectChoice = { value: BASE_MARKET_VALUE, label: `Base snapshot (${block.snapshot?.id ?? "none attached yet"})`, disabled: false };
  return [
    base,
    ...block.derived.map((d) => ({
      value: `${DERIVED_MARKET_PREFIX}${d.definitionKey}`,
      label: d.id === d.definitionKey ? `Derived market ${d.definitionKey}` : `Derived market ${d.definitionKey} (now ${d.id})`,
      disabled: false,
    })),
  ];
}

export function marketSelectValue(market: SetupInputs["market"]): string {
  return market.role === "base" ? BASE_MARKET_VALUE : `${DERIVED_MARKET_PREFIX}${market.definitionKey}`;
}

export function marketInputFrom(value: string): SetupInputs["market"] {
  return value.startsWith(DERIVED_MARKET_PREFIX) ? { role: "derived", definitionKey: value.slice(DERIVED_MARKET_PREFIX.length) } : { role: "base" };
}

/** A derived market the setup names that the block no longer lists: shown, named and not choosable; null otherwise. */
export function keepMarketOption(market: SetupInputs["market"], choices: readonly SelectChoice[]): SelectChoice | null {
  if (market.role === "base") return null;
  const value = marketSelectValue(market);
  if (choices.some((c) => c.value === value)) return null;
  return { value, label: `Derived market ${market.definitionKey} (not in the market block)`, disabled: true };
}

// ---------------------------------------------------------------------------
// EVE, gap and path choices; reserved entries are disabled and name their piece
// ---------------------------------------------------------------------------

export const EVE_VALUATION_CHOICES: readonly SelectChoice[] = [
  { value: "as-of", label: "As of the grid date (default)", disabled: false },
  { value: "every-nii-date", label: "At every NII date (reserved: a later release)", disabled: true },
  { value: "every-12-months", label: "Every 12 months (reserved: a later release)", disabled: true },
  { value: "custom", label: "Custom months (reserved: a later release)", disabled: true },
];

export const EVE_DISCOUNT_CHOICES: readonly SelectChoice[] = [
  { value: "all-in", label: "All-in (default)", disabled: false },
  { value: "risk-free", label: "Risk-free: benchmark curve alone", disabled: false },
  { value: "spread-consistent", label: "Spread-consistent: benchmark plus TLP plus each position's own spread", disabled: false },
];

// ---------------------------------------------------------------------------
// The schema 1.9.0 fields: NMD convention, SEG, liquidity stress, instrument-level results.
// Each optional field is LEFT OUT of the document when it is off or at its default, so a setup that never
// touched them keeps its bytes, and the server's gate sees exactly what the book's setups carry.
// ---------------------------------------------------------------------------

export const NMD_CONVENTION_CHOICES: readonly SelectChoice[] = [
  { value: "behavioral", label: "Behavioral (default): deposits run off on the bound decay and beta parameters", disabled: false },
  { value: "regulatory", label: "Regulatory: capped pass-through, core share laddered over ten rungs, core held out of the repricing gap", disabled: false },
  { value: "shocked-level", label: "Shocked level: core share read from the beta at each scenario's rate (full beta form books only)", disabled: false },
];

/** The convention a setup runs: absent means behavioral. */
export function nmdConventionOf(setup: RunSetup): "behavioral" | "regulatory" | "shocked-level" {
  return setup.nmdConvention ?? "behavioral";
}

/** Behavioral is the absent state, so choosing it removes the field. */
export function withNmdConvention(setup: RunSetup, value: "behavioral" | "regulatory" | "shocked-level"): RunSetup {
  const { nmdConvention: _drop, ...rest } = setup;
  void _drop;
  return value === "behavioral" ? rest : { ...rest, nmdConvention: value };
}

// ---------------------------------------------------------------------------
// The model convention. Absent is the original convention of a setup made before the corrections; the
// two named values are the switch. Choosing one always writes it, so a setup the learner touched is never ambiguous.
// ---------------------------------------------------------------------------

export const MODEL_CONVENTION_CHOICES: readonly SelectChoice[] = [
  { value: "corrected-v1", label: "Corrected (default): the CD book reacts to rate shocks and reads the run's market; SEG deposit vintages read the run's history", disabled: false },
  { value: "book", label: "Original convention: the behavior before the corrections", disabled: false },
];

/** The line made-before setups show, and the switch's help. */
export const MADE_BEFORE_CORRECTIONS = "Made before the corrections; re-run with corrections to update.";

/** The convention a setup runs: absent runs the original convention. */
export function modelConventionOf(setup: Pick<RunSetup, "modelConvention">): "corrected-v1" | "book" {
  return setup.modelConvention ?? "book";
}

/** The one line a setup's convention shows, or null for a setup on the corrections. */
export function modelConventionLine(setup: Pick<RunSetup, "modelConvention">): string | null {
  if (setup.modelConvention === "corrected-v1") return null;
  if (setup.modelConvention === "book") return "Original convention: this setup keeps the behavior before the corrections.";
  return MADE_BEFORE_CORRECTIONS;
}

export function withModelConvention(setup: RunSetup, value: "corrected-v1" | "book"): RunSetup {
  return { ...setup, modelConvention: value };
}

export function withSeg(setup: RunSetup, on: boolean): RunSetup {
  const { seg: _drop, ...rest } = setup;
  void _drop;
  return on ? { ...rest, seg: { enabled: true } } : rest;
}

/**
 * The SEG knobs. Each reads the engine default until the setup names a value, and typing the
 * default back removes the key, so a setup that names none keeps its bytes. The bounds restate the engine's
 * (seg/settings.ts); segKnobs.test.tsx holds the two equal.
 */
export const SEG_KNOB_DEFAULTS = { shockBp: 10, horizonMonths: 60, niiShockBp: 200 } as const;
export type SegKnob = keyof typeof SEG_KNOB_DEFAULTS;

export const SEG_KNOBS: ReadonlyArray<{ key: SegKnob; label: string; help: string; max: number; whole: boolean }> = [
  {
    key: "shockBp",
    label: "SEG shock, bp",
    help: "The SEG pair runs at plus and minus this shock. Default 10; a worked example by hand often uses 25.",
    max: 200,
    whole: false,
  },
  {
    key: "horizonMonths",
    label: "SEG horizon, months",
    help: "Months of Outstanding SEG and EBP. Default 60. A 30-year mortgage is read over months 0 to 360 of a 720-month horizon, so every new vintage keeps its full term.",
    max: 720,
    whole: true,
  },
  {
    key: "niiShockBp",
    label: "Constant-balance NII shock, bp",
    help: "The 12-month constant-balance NII runs at plus and minus this shock. Default 200; a worked example by hand often uses 25.",
    max: 500,
    whole: false,
  },
];

export function segKnobText(setup: RunSetup, key: SegKnob): string {
  return String(setup.seg?.[key] ?? SEG_KNOB_DEFAULTS[key]);
}

export function parseSegKnob(key: SegKnob, text: string): { value: number } | { problem: string } {
  const knob = SEG_KNOBS.find((k) => k.key === key)!;
  const n = text.trim() === "" ? Number.NaN : Number(text);
  if (knob.whole) {
    if (!Number.isInteger(n) || n < 1 || n > knob.max) return { problem: `Enter whole months from 1 to ${knob.max}.` };
  } else if (!Number.isFinite(n) || n <= 0 || n > knob.max) {
    return { problem: `Enter basis points above 0 and at most ${knob.max}.` };
  }
  return { value: n };
}

/** Set one knob on a setup whose SEG block is on; the engine default removes the key. */
export function withSegKnob(setup: RunSetup, key: SegKnob, value: number): RunSetup {
  if (setup.seg?.enabled !== true) return setup;
  const { [key]: _drop, ...rest } = setup.seg;
  void _drop;
  return { ...setup, seg: value === SEG_KNOB_DEFAULTS[key] ? rest : { ...rest, [key]: value } };
}

/** The cohort-0 prepayment overlay as one plain line per family, or none. The editor shows it; the seed sets it. */
export function segOverlayLines(setup: RunSetup): string[] {
  const pct = (c: number) => `${Number((c * 100).toPrecision(12))}%`;
  return (setup.seg?.cprOverlay ?? []).map(
    (r) => `${r.familyId}: cohort 0 at ${pct(r.upAnnualCpr)} CPR under the up shock and ${pct(r.downAnnualCpr)} under the down shock; new vintages keep the family's own speed.`,
  );
}

/** The next-reset ALCO ladder. Off is the absent state, so switching it off removes gap.nextReset. */
export function withNextReset(setup: RunSetup, on: boolean): RunSetup {
  const { nextReset: _drop, ...gap } = setup.gap;
  void _drop;
  return { ...setup, gap: on ? { ...gap, nextReset: true } : gap };
}

/**
 * What the stress switch starts from: an illustrative table with round starting values, for the user to edit to the
 * book at hand (the buffer and the undrawn face above all). A setup that carries its own table keeps it.
 */
export const DEFAULT_LIQUIDITY_STRESS: SetupLiquidityStress = {
  table: {
    bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0 },
    moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12 },
    severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25 },
  },
  buffer: 1_000_000_000,
  undrawnFace: 250_000_000,
};

export type StressScenarioId = "bau" | "moderate" | "severe";
export const STRESS_SCENARIOS: ReadonlyArray<{ id: StressScenarioId; label: string }> = [
  { id: "bau", label: "Business as usual" },
  { id: "moderate", label: "Moderate" },
  { id: "severe", label: "Severe" },
];
/** The four rates every row of the stress table states. */
export type StressRateKey = "hysOutflowMonthly" | "wholesaleRenewal" | "nibOutflowMonthly" | "drawRate";
export const STRESS_COLUMNS: ReadonlyArray<{ key: StressRateKey; label: string; short: string }> = [
  { key: "hysOutflowMonthly", label: "savings pool outflow per month", short: "Savings pool outflow, per month" },
  { key: "wholesaleRenewal", label: "wholesale renewal", short: "Wholesale renewal" },
  { key: "nibOutflowMonthly", label: "checking pool outflow per month", short: "Checking pool outflow, per month" },
  { key: "drawRate", label: "commitment draw rate", short: "Commitment draw rate" },
];

export function withLiquidityStress(setup: RunSetup, on: boolean): RunSetup {
  const { liquidityStress: _drop, ...rest } = setup;
  void _drop;
  return on ? { ...rest, liquidityStress: setup.liquidityStress ?? DEFAULT_LIQUIDITY_STRESS } : rest;
}

/** One rate of the table, a decimal in [0, 1]. A setup without the block is returned as it is. */
export function withStressRate(setup: RunSetup, id: StressScenarioId, key: keyof LiquidityStressParams, ratio: number): RunSetup {
  const ls = setup.liquidityStress;
  if (ls === undefined) return setup;
  return { ...setup, liquidityStress: { ...ls, table: { ...ls.table, [id]: { ...ls.table[id], [key]: ratio } } } };
}

export function withStressAmount(setup: RunSetup, key: "buffer" | "undrawnFace", dollars: number): RunSetup {
  const ls = setup.liquidityStress;
  if (ls === undefined) return setup;
  return { ...setup, liquidityStress: { ...ls, [key]: dollars } };
}

// Certificates of deposit, the buffer from the HQLA tags, the commitment dials and the
// survival path. Each is off by being absent, so a setup that never turns one on stores what it always did.

/** The renewal shares the certificate-of-deposit switch starts from: round illustrative values. */
export const DEFAULT_CD_RENEWAL: Readonly<Record<StressScenarioId, number>> = { bau: 0.9, moderate: 0.6, severe: 0.3 };

function withStress(setup: RunSetup, edit: (ls: SetupLiquidityStress) => SetupLiquidityStress): RunSetup {
  const ls = setup.liquidityStress;
  return ls === undefined ? setup : { ...setup, liquidityStress: edit(ls) };
}

/** Certificates of deposit in the ladder: on gives every row a renewal share; off takes it away, so they enter nothing. */
export function withCdRenewal(setup: RunSetup, on: boolean): RunSetup {
  return withStress(setup, (ls) => {
    const row = (id: StressScenarioId) => {
      const { cdRenewal: _cd, ...rest } = ls.table[id];
      void _cd;
      return on ? { ...rest, cdRenewal: ls.table[id].cdRenewal ?? DEFAULT_CD_RENEWAL[id] } : rest;
    };
    return { ...ls, table: { bau: row("bau"), moderate: row("moderate"), severe: row("severe") } };
  });
}

/** True when the table states a renewal share for certificates of deposit. */
export function cdRenewalOn(ls: SetupLiquidityStress): boolean {
  return STRESS_SCENARIOS.some((s) => ls.table[s.id].cdRenewal !== undefined);
}

/** The buffer from the HQLA tags (on: the stated amount is removed) or stated (off: the starting $1,000M). */
export function withBufferFromTags(setup: RunSetup, on: boolean): RunSetup {
  return withStress(setup, (ls) => {
    const { buffer: _b, ...rest } = ls;
    void _b;
    return on ? rest : { table: ls.table, buffer: ls.buffer ?? DEFAULT_LIQUIDITY_STRESS.buffer!, ...withoutTable(rest) };
  });
}

function withoutTable(ls: Omit<SetupLiquidityStress, "buffer">): Omit<SetupLiquidityStress, "buffer" | "table"> {
  const { table: _t, ...rest } = ls;
  void _t;
  return rest;
}

/**
 * The dials the switch starts from, round illustrative values. They carry no amount: the dials read the undrawn face
 * above as the amount undrawn now, and their face is it over (1 - Ubar) (ruling 2026-11-05).
 */
export function defaultDials(): NonNullable<SetupLiquidityStress["dials"]> {
  return { expectedUtilization: 0.15, tailUtilization: 0.35, fundingSpreadBp: 50, lcrFactor: 0.1, thirtyDayShare: 1 / 12 };
}

export function withDials(setup: RunSetup, on: boolean): RunSetup {
  return withStress(setup, (ls) => {
    const { dials: _d, ...rest } = ls;
    void _d;
    return on ? { ...rest, dials: ls.dials ?? defaultDials() } : rest;
  });
}

export type DialKey = "expectedUtilization" | "tailUtilization" | "fundingSpreadBp" | "lcrFactor" | "thirtyDayShare";
/** The dials read the undrawn face above as the amount undrawn now; this line says so under the switch. */
export const DIALS_AMOUNT_HELP = "The dials read the undrawn commitment face above as the amount undrawn now. The commitment face is that amount divided by (1 - Ubar); Ubar and U99 are shares of it.";
export const DIAL_FIELDS: ReadonlyArray<{ key: DialKey; label: string; unit: "pct" | "bp"; help: string }> = [
  { key: "expectedUtilization", label: "Expected utilization (Ubar), percent", unit: "pct", help: "The share of the commitment face drawn on average; the base case carries it." },
  { key: "tailUtilization", label: "Tail utilization (U99), percent", unit: "pct", help: "The share drawn in a severe year; at or above Ubar." },
  { key: "fundingSpreadBp", label: "Funding spread, bp", unit: "bp", help: "The bank's funding cost over the yield on its liquid assets." },
  { key: "lcrFactor", label: "LCR outflow factor, percent", unit: "pct", help: "The regulatory 30-day outflow on the amount undrawn now: 10 percent for a credit line to a company (12 CFR 249)." },
  { key: "thirtyDayShare", label: "Share of the tail draw in 30 days, percent", unit: "pct", help: "One twelfth when the draw is spread evenly over the year." },
];

export function withDialsField(setup: RunSetup, key: DialKey, value: number): RunSetup {
  return withStress(setup, (ls) => (ls.dials === undefined ? ls : { ...ls, dials: { ...ls.dials, [key]: value } }));
}

/** The survival path: on starts at the ladder's 12 months; off takes it away. */
export function withSurvivalPath(setup: RunSetup, on: boolean): RunSetup {
  return withStress(setup, (ls) => {
    const { survivalPath: _sp, ...rest } = ls;
    void _sp;
    return on ? { ...rest, survivalPath: ls.survivalPath ?? { horizonMonths: 12 } } : rest;
  });
}

export function withSurvivalMonths(setup: RunSetup, months: number): RunSetup {
  return withStress(setup, (ls) => (ls.survivalPath === undefined ? ls : { ...ls, survivalPath: { ...ls.survivalPath, horizonMonths: months } }));
}

/** The received facility the switch starts from: no capacity, a 20 percent haircut, for the user to state. */
export const DEFAULT_FACILITY = { label: "Borrowing capacity", capacity: 0, haircut: 0.2 };

export function withFacility(setup: RunSetup, on: boolean): RunSetup {
  return withStress(setup, (ls) => {
    const sp = ls.survivalPath;
    if (sp === undefined) return ls;
    const { facility: _f, ...rest } = sp;
    void _f;
    return { ...ls, survivalPath: on ? { ...rest, facility: sp.facility ?? { ...DEFAULT_FACILITY } } : rest };
  });
}

export function withFacilityField(setup: RunSetup, key: "capacity" | "haircut", value: number): RunSetup {
  return withStress(setup, (ls) => {
    const sp = ls.survivalPath;
    if (sp?.facility === undefined) return ls;
    return { ...ls, survivalPath: { ...sp, facility: { ...sp.facility, [key]: value } } };
  });
}

/** Survival path months as typed: a whole number from 12 to 120. */
export function parseSurvivalMonths(text: string): { value: number } | { problem: string } {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isInteger(n) && n >= 12 && n <= 120 ? { value: n } : { problem: "Enter a whole number of months from 12 to 120." };
}

/** Basis points as typed: zero or more. */
export function parseBp(text: string): { value: number } | { problem: string } {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(n) && n >= 0 ? { value: n } : { problem: "Enter basis points, zero or more." };
}

/** A decimal rate as the percent text the editor shows: 0.0235 to "2.35", with no float tail. */
export function stressRateText(ratio: number): string {
  return String(Number((ratio * 100).toPrecision(12)));
}

const RATE_PROBLEM = "Enter a percent from 0 to 100.";
const AMOUNT_PROBLEM = "Enter an amount in $M, zero or more.";

/** The percent text as a decimal rate: the text is divided by 100 and rounded to 12 significant digits, so "2.35" is 0.0235 exactly. */
export function parseStressRate(text: string): { value: number } | { problem: string } {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { problem: RATE_PROBLEM };
  return { value: Number((n / 100).toPrecision(12)) };
}

/** Dollars as $M text: 2_170_000_000 to "2170". */
export function stressAmountText(dollars: number): string {
  return String(Number((dollars / 1e6).toPrecision(12)));
}

/** $M text as dollars, to the cent. */
export function parseStressAmount(text: string): { value: number } | { problem: string } {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(n) || n < 0) return { problem: AMOUNT_PROBLEM };
  return { value: Number((n * 1e6).toFixed(2)) };
}

/**
 * Instrument-level results on: the server takes an absent node list as every position and refuses an empty list, so
 * switching on drops an empty list. Switching off keeps whatever the setup held.
 */
export function withInstrumentSave(setup: RunSetup, on: boolean): RunSetup {
  const ir = setup.instrumentResults;
  if (!on) return { ...setup, instrumentResults: { ...ir, save: false } };
  const { coaNodeIds, ...rest } = ir;
  return { ...setup, instrumentResults: coaNodeIds === undefined || coaNodeIds.length === 0 ? { ...rest, save: true } : { ...rest, save: true, coaNodeIds } };
}

/** Tick or untick one chart of account node; the last one unticked leaves the list out (every position). */
export function withInstrumentNode(setup: RunSetup, nodeId: string, on: boolean): RunSetup {
  const { coaNodeIds, ...rest } = setup.instrumentResults;
  const held = (coaNodeIds ?? []).filter((x) => x !== nodeId);
  const next = on ? [...held, nodeId] : held;
  return { ...setup, instrumentResults: next.length === 0 ? rest : { ...rest, coaNodeIds: next } };
}

export const EVE_DURATION_CHOICES: readonly SelectChoice[] = [
  { value: "base-only", label: "Base scenario only", disabled: false },
  { value: "per-scenario", label: "Every scenario", disabled: false },
];

export const GAP_BUCKET_CHOICES: readonly SelectChoice[] = [
  { value: "monthly", label: "Monthly", disabled: false },
  { value: "standard", label: "Nine standard bands", disabled: false },
  { value: "custom", label: "Custom edges", disabled: false },
  { value: "finer", label: "Finer (grid is monthly)", disabled: true },
];

export const LIQUIDITY_FLOW_CHOICES: readonly SelectChoice[] = [
  { value: "principal", label: "Principal only", disabled: false },
  { value: "principal-plus-interest", label: "Principal plus interest", disabled: false },
];

export const LIQUIDITY_INTERVAL_CHOICES: readonly SelectChoice[] = [
  { value: "monthly", label: "Monthly", disabled: false },
  { value: "standard", label: "Nine standard bands", disabled: false },
  { value: "custom-months", label: "Custom interval in months", disabled: false },
  { value: "daily", label: "Daily (reserved: needs a daily cash flow generator, a later release)", disabled: true },
];

/**
 * What principal plus interest adds, and what the liquidity card still cannot honour (the interval is
 * honoured, decision 108; slice 4a: principal plus interest is honoured as a second, interest-inclusive ladder).
 */
export const LIQUIDITY_RESERVED_NOTE =
  "Principal plus interest adds an interest-inclusive ladder in Results beside the principal one. A daily interval is not offered: the cash flow grid is monthly.";

/** The liquidity switch off (decision 109): the run stores no liquidity buckets of its own. */
export const LIQUIDITY_OFF_NOTE = "The nine standard bands still show.";

/** The server's refusal of a stochastic EVE path (apps/server setupCompile.ts STOCHASTIC_PATH_REFUSAL), restated. */
export const STOCHASTIC_PATH_REFUSAL =
  "Stochastic runs launch from the Analysis path in this release: choose one on the Simulation step and launch it on the Run step. This setup asks for the stochastic EVE path. Choose single path to launch it on the deterministic path.";

/** The first sentence: what the control says while the setup does not ask for it. */
export const STOCHASTIC_PATH_NOTE = "A stochastic run launches from the Analysis path: choose it on the Simulation step, then launch it on the Run step.";

export const PATH_CHOICES: readonly SelectChoice[] = [
  { value: "single", label: "Single path", disabled: false },
  { value: "stochastic", label: "Stochastic (launches from the Analysis path's Run step)", disabled: true },
];

export const NII_PATH_NOTE = "NII runs on a single path.";

// ---------------------------------------------------------------------------
// Bucket edges
// ---------------------------------------------------------------------------

export interface EdgesRead {
  edges: number[];
  problem: string | null;
}

const FINER_THAN_MONTH = "Bucket edges are whole months, so no bucket is finer than a month.";

/** Read "3, 6, 12, 24": whole months from 1, strictly rising, none beyond the grid. */
export function parseBucketEdges(text: string, gridHorizonMonths: number): EdgesRead {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) return { edges: [], problem: "Name at least one bucket edge, in months." };
  const edges: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return { edges, problem: FINER_THAN_MONTH };
    edges.push(n);
  }
  for (let i = 1; i < edges.length; i += 1) {
    if (edges[i]! <= edges[i - 1]!) return { edges, problem: `Bucket edges must rise: ${edges[i]} does not follow ${edges[i - 1]}.` };
  }
  const last = edges[edges.length - 1]!;
  if (last > gridHorizonMonths) return { edges, problem: `Bucket edge ${last} is beyond the ${gridHorizonMonths}-month grid.` };
  return { edges, problem: null };
}

export function edgesText(edges: readonly number[]): string {
  return edges.join(", ");
}

export function gapBucketValue(rb: GapSettings["repricingBuckets"]): string {
  return rb.kind;
}

/** The NII window (`nii.horizonMonths`): a whole number of months from 12 to the grid length, as the server parser reads it. */
export function horizonProblem(text: string, gridHorizonMonths: number): string | null {
  const n = Number(text);
  if (text.trim() === "" || !Number.isInteger(n) || n < 12 || n > gridHorizonMonths) {
    return `The NII window is a whole number of months from 12 to ${gridHorizonMonths}.`;
  }
  return null;
}

export interface HorizonsRead {
  horizons: number[];
  problem: string | null;
}

/**
 * Read the NII report horizons "12, 24, 60" with the server parser's rules (runSetupParse.ts parseNii, decision 116):
 * at least one, each a whole number of months from 1 and at most the grid, strictly rising.
 */
export function parseReportHorizons(text: string, gridHorizonMonths: number): HorizonsRead {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) return { horizons: [], problem: "Name at least one report horizon, in months." };
  const horizons: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return { horizons, problem: "Report horizons are whole months from 1." };
    if (n > gridHorizonMonths) return { horizons, problem: `Report horizon ${n} is beyond the ${gridHorizonMonths}-month grid.` };
    horizons.push(n);
  }
  for (let i = 1; i < horizons.length; i += 1) {
    if (horizons[i]! <= horizons[i - 1]!) return { horizons, problem: `Report horizons must rise: ${horizons[i]} does not follow ${horizons[i - 1]}.` };
  }
  return { horizons, problem: null };
}

/** The FTP bridge reads its own fixed horizon whatever the list says (decision 117). */
export const FTP_BRIDGE_HELP = "The FTP bridge to NII stays at 12 months whatever this list says.";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** A rate spec by kind and size, in words. */
export function rateSpecText(spec: RateSpec): string {
  switch (spec.kind) {
    case "base":
      return "Base";
    case "parallel":
      return `Parallel ${signed(spec.shockBp)} bp`;
    case "twist":
      return `Twist: ${signed(spec.shortBp)} bp short, ${signed(spec.longBp)} bp long, pivot ${spec.pivotYears}y`;
    case "custom":
      return `User-defined, ${spec.shocks.length} tenor ${spec.shocks.length === 1 ? "knot" : "knots"}`;
  }
}

/** A scenario definition as one line: the spec, and the ramp when its timing is one. */
export function scenarioText(def: Pick<ScenarioDefinition, "rateSpec" | "timing">): string {
  const base = rateSpecText(def.rateSpec);
  return def.timing !== undefined && def.timing.kind === "ramp" ? `${base}, ramp over ${def.timing.months} months` : base;
}

/** "<library id>#<scenario id>" for each scenario of a library, the form a setup's library refs take. */
export function scenarioRefsOf(lib: ScenarioLibrary): string[] {
  return lib.scenarios.map((s) => `${lib.id}#${s.id}`);
}

export function toggleRef(refs: readonly string[], ref: string, on: boolean, order: readonly string[]): string[] {
  const set = new Set(refs);
  if (on) set.add(ref);
  else set.delete(ref);
  // Library order first, then refs the libraries do not list, in the order the setup had them.
  const known = order.filter((r) => set.has(r));
  const rest = refs.filter((r) => set.has(r) && !order.includes(r));
  return [...known, ...rest];
}

/** One item of an imported plan's own list, as a row of words. */
export function planScenarioText(item: PlanScenarioRef): { id: string; text: string } {
  if ("ref" in item) return { id: item.ref, text: "Library reference" };
  return { id: item.id, text: `${item.label ?? item.id}: ${scenarioText(item)}` };
}

export type ScenarioSourceKind = SetupScenarios["kind"];

export function sameScenarios(a: SetupScenarios, b: SetupScenarios): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// The draft: save and the new setup
// ---------------------------------------------------------------------------

/**
 * The body of a save: the stored document's successor. It supersedes the stored document, has no id (the server
 * names it from its content), and drops a plan id the edit no longer matches (an edited setup
 * hashes its own plan id at compile).
 */
export function draftForSave(stored: RunSetup, draft: RunSetup): Omit<RunSetup, "id"> {
  const { id: _id, ...rest } = draft;
  void _id;
  // NII, EVE and gap always run (decision 120): a saved draft never carries one switched off. FTP keeps its switch (decision 122).
  const on = { nii: { ...rest.nii, enabled: true }, eve: { ...rest.eve, enabled: true }, gap: { ...rest.gap, enabled: true } };
  return { ...rest, ...on, supersedes: stored.id, plan: { ...draft.plan, planId: null } };
}

// ---------------------------------------------------------------------------
// Views: the setup's own dimension views, on `plan.views`
// ---------------------------------------------------------------------------

/** The lowest free view-N among the setup's views. */
export function nextSetupViewId(setup: Pick<RunSetup, "plan">): string {
  const taken = new Set((setup.plan.views ?? []).map((v) => v.id));
  for (let n = 1; ; n += 1) if (!taken.has(`view-${n}`)) return `view-${n}`;
}

/** The setup with one more view grouping by `groupBy`, in the order picked; the validate gate judges it. */
export function withSetupView<T extends Pick<RunSetup, "plan">>(setup: T, label: string, groupBy: readonly string[]): T {
  const text = label.trim();
  if (text === "") throw new Error("a view needs a label");
  if (groupBy.length === 0 || new Set(groupBy).size !== groupBy.length) throw new Error("a view groups by at least one dimension, each once");
  return { ...setup, plan: { ...setup.plan, views: [...(setup.plan.views ?? []), { id: nextSetupViewId(setup), label: text, groupBy: [...groupBy] }] } };
}

/** The setup without one view; the last one removed drops the field, so the document is the one it was before. */
export function withoutSetupView<T extends Pick<RunSetup, "plan">>(setup: T, viewId: string): T {
  const rest = (setup.plan.views ?? []).filter((v) => v.id !== viewId);
  if (rest.length > 0) return { ...setup, plan: { ...setup.plan, views: rest } };
  const { views: _drop, ...plan } = setup.plan;
  return { ...setup, plan };
}

export function isDirty(stored: RunSetup, draft: RunSetup): boolean {
  return JSON.stringify(stored) !== JSON.stringify(draft);
}

/** The shipped regulatory grid by library reference: the scenarios Standard ALCO is created with. */
export const REGULATORY_GRID_REFS: readonly string[] = [
  "regulatory-grid-v1#S0",
  "regulatory-grid-v1#S100",
  "regulatory-grid-v1#S-100",
  "regulatory-grid-v1#S200",
  "regulatory-grid-v1#S-200",
];

/** The settings a new setup starts from: Standard ALCO's measure cards (spec Section 3.6 step 7), restated. */
export function newSetupDocument(name: string, libraryRefs: readonly string[] = REGULATORY_GRID_REFS): Omit<RunSetup, "id"> {
  return {
    schemaVersion: "1.0.0",
    name,
    gridHorizonMonths: 360,
    inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: { kind: "block-default" } },
    scenarios: { kind: "library", refs: [...libraryRefs] },
    plan: {
      planId: null,
      label: name,
      authoredBy: "person",
      stages: "derived-default",
      reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
      validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
    },
    nii: { enabled: true, horizonMonths: 60, reportHorizons: [12, 24, 60], basis: { ...FLAT_BASIS }, path: "single" },
    eve: { enabled: true, discountBasis: "all-in", durationMode: "base-only", valuationDates: "as-of", keyRate: false, channels: false, path: "single" },
    gap: { enabled: true, repricingBuckets: { kind: "monthly" }, fixedRateLadder: false, liquidity: { enabled: true, flows: "principal", interval: { kind: "monthly" } } },
    ftp: { enabled: true },
    instrumentResults: { save: false, coaNodeIds: [] },
    // A new setup runs the corrections.
    modelConvention: CURRENT_MODEL_CONVENTION,
    batch: [],
    importedFrom: null,
    supersedes: null,
    note: "",
  };
}

/** A lineage id for a new slot: letters, digits, dot, underscore and hyphen, at most 70 characters. */
export function lineageIdFor(name: string, taken: readonly string[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  const base = `setup-${slug === "" ? "new" : slug}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

export function eveWith<K extends keyof EveSettings>(eve: EveSettings, key: K, value: EveSettings[K]): EveSettings {
  return { ...eve, [key]: value };
}

// ---------------------------------------------------------------------------
// Readiness words for the Launch strip and the setup list
// ---------------------------------------------------------------------------

export const RUN_SETUPS_ID = "run/setups";
export const RUN_SETUP_WARNINGS_ID = "run/setup-warnings";

function itemFor(id: string, items: readonly ReadinessItem[]): ReadinessItem | null {
  return items.find((i) => `${i.section}/${i.item}` === id || i.item === id) ?? null;
}

/** The words of one readiness id: the item's name, the section prefix dropped. */
export function itemName(id: string, items: readonly ReadinessItem[]): string {
  if (id === RUN_SETUPS_ID) return "Run setups";
  if (id === RUN_SETUP_WARNINGS_ID) return "Setup warnings";
  const hit = itemFor(id, items);
  if (hit !== null) return hit.item;
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

/** The blocking list in words, joined. */
export function blockingText(ids: readonly string[], items: readonly ReadinessItem[]): string {
  return ids.map((id) => itemName(id, items)).join(", ");
}

/** Each blocking id with the readiness item's own reason (S2a fix round 1, L14); an id with no item reads its name alone. */
export function blockingReasons(ids: readonly string[], items: readonly ReadinessItem[]): string[] {
  return ids.map((id) => {
    const hit = itemFor(id, items);
    return hit === null ? itemName(id, items) : `${itemName(id, items)}: ${hit.detail}`;
  });
}

/** The line beside one acknowledgement checkbox: what is being acknowledged. */
export function acknowledgeLabel(id: string, items: readonly ReadinessItem[]): string {
  if (id === RUN_SETUPS_ID) {
    return "Run setups: a consumed pin moved since the last validation. Validate again, or launch on the changed pins.";
  }
  if (id === RUN_SETUP_WARNINGS_ID) {
    return "Setup warnings: the compile's warnings stand; the validation report lists them.";
  }
  const hit = itemFor(id, items);
  return hit === null ? itemName(id, items) : `${hit.item}: ${hit.detail}`;
}

// ---------------------------------------------------------------------------
// The setup list
// ---------------------------------------------------------------------------

export interface SetupListRow {
  lineageId: string;
  docId: string;
  name: string;
  launchCount: number;
  basisText: string;
  lastLaunched: string | null;
  state: ReadinessState;
}

/**
 * A slot's chip. With one slot the Run setups item is the slot's own. With several, the item is the worst of all of
 * them, so the slot reads its own launch lists: a blocking Run setups id is Error, an acknowledgeable one Stale or
 * Warning by id; neither leaves it Draft or Valid as the merged item says, and Valid when the merge is worse for
 * another slot's reason.
 */
export function slotChipState(lineageId: string, report: ReadinessReport | null, slotCount: number): ReadinessState {
  if (report === null) return "draft";
  const merged = report.items.find((i) => i.section === "run" && i.item === "Run setups")?.state ?? "draft";
  if (slotCount <= 1) return merged;
  const lists = report.launchable[lineageId];
  if (lists === undefined) return "draft";
  if (lists.blocking.includes(RUN_SETUPS_ID)) return "error";
  if (lists.acknowledgeable.includes(RUN_SETUPS_ID)) return "stale";
  if (lists.acknowledgeable.includes(RUN_SETUP_WARNINGS_ID)) return "warning";
  return merged === "draft" ? "draft" : "valid";
}

export function setupListRows(
  listed: readonly RunSetupListed[],
  runs: readonly WorkspaceRunRow[],
  report: ReadinessReport | null,
): SetupListRow[] {
  return listed.map(({ slot, setup }) => {
    const own = runs.filter((r) => r.setupLineageId === slot.setupLineageId);
    const launchCount = own.reduce((n, r) => Math.max(n, r.launchNo ?? 0), 0);
    const last = own.map((r) => r.status?.submittedAt ?? r.at).sort().at(-1);
    return {
      lineageId: slot.setupLineageId,
      docId: slot.current.id,
      name: setup.name,
      launchCount,
      basisText: basisChosenText(setup.nii.basis),
      lastLaunched: last === undefined ? null : last.slice(0, 10),
      state: slotChipState(slot.setupLineageId, report, listed.length),
    };
  });
}

// ---------------------------------------------------------------------------
// Batch rows across setups (Run > Batches)
// ---------------------------------------------------------------------------

/** A scenario choice in one line: how many scenarios, and from where. */
export function scenarioSummary(s: SetupScenarios): string {
  if (s.kind === "library") return `${plural(s.refs.length, "library scenario", "library scenarios")}`;
  if (s.kind === "slate") return s.include === "all" ? `slate ${s.slateId}, all scenarios` : `slate ${s.slateId}, ${plural(s.include.length, "scenario", "scenarios")}`;
  return `imported plan list, ${plural(s.items.length, "scenario", "scenarios")}`;
}

export interface BatchOverviewRow {
  lineageId: string;
  setupName: string;
  rowNo: number;
  label: string;
  scenarios: string;
  assumptionSets: string;
  basis: string;
}

/** Every batch row of every setup, in setup order then row order: the Batch tab, listed across setups. */
export function batchOverview(listed: readonly RunSetupListed[]): BatchOverviewRow[] {
  const out: BatchOverviewRow[] = [];
  for (const { slot, setup } of listed) {
    setup.batch.forEach((row, i) => {
      out.push({
        lineageId: slot.setupLineageId,
        setupName: setup.name,
        rowNo: i + 1,
        label: row.label,
        scenarios: scenarioSummary(row.scenarios),
        assumptionSets: Array.isArray(row.assumptionSetIds) ? row.assumptionSetIds.join(", ") : "Workspace default",
        basis: basisChosenText(row.basis),
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation and launch words
// ---------------------------------------------------------------------------

export function validationOutcomeText(outcome: "pass" | "warn" | "fail"): string {
  if (outcome === "pass") return "Validated: both gates passed";
  if (outcome === "warn") return "Validated with warnings";
  return "Validation failed";
}

export type LaunchOutcome = { kind: "reply"; reply: LaunchReply } | { kind: "error"; error: unknown };

/** A launch's answer in words: the queued runs, a refused batch row, a gate refusal, or the server's own text. */
export function launchOutcomeText(outcome: LaunchOutcome, items: readonly ReadinessItem[] = []): string {
  if (outcome.kind === "reply") {
    const { reply } = outcome;
    const queued = `Launch ${reply.launchNo} queued ${plural(reply.runIds.length, "run", "runs")}${reply.runIds.length > 0 ? `: ${reply.runIds.join(", ")}` : ""}.`;
    const failed = reply.failed[0];
    if (failed === undefined) return queued;
    return `${queued} Row ${failed.row} was refused (${failed.status}): ${failed.message}. Queued runs stay queued; cancel them from the queue if the batch is not wanted.`;
  }
  const e = outcome.error;
  if (e instanceof ApiError && e.code === "launch-blocked") {
    const body = e.body as LaunchGateRefusal | undefined;
    const ids = body?.blocking ?? [];
    if (ids.length > 0) return `Launch refused: ${blockingText(ids, items)} ${ids.length === 1 ? "blocks" : "block"} it.`;
  }
  if (e instanceof ApiError && e.code === "acknowledge-required") {
    const body = e.body as LaunchGateRefusal | undefined;
    const ids = body?.acknowledgeable ?? [];
    if (ids.length > 0) return `Launch needs an acknowledgement for: ${blockingText(ids, items)}.`;
  }
  if (e instanceof ApiError && e.status === 422 && e.code === "validation") {
    const body = e.body as LaunchBatchRefusal | undefined;
    const bad = (body?.rows ?? []).filter((r) => r.outcome === "fail");
    if (bad.length > 0) {
      return `Nothing was submitted. ${bad.map((r) => (r.outcome === "fail" ? `Row ${r.label} failed: ${r.error.message}.` : "")).join(" ")}`;
    }
  }
  return errText(e);
}
