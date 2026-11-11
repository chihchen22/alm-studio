/**
 * Behavioral parameter schemas.
 *
 * One entry per built-in model: each parameter's path, label, unit, help line
 * and hard bounds, in display order. bindAssumptions refuses a value outside
 * them when a set is bound; Studio reads the same entries for its labels and
 * runs the same check on a draft. A hard bound is declared only where the model
 * math breaks or the value is meaningless by definition;
 * every other field is finite only. There are no typical-range warnings.
 *
 * `unit` is a display string and is never used to convert a value. Values are
 * stored and edited exactly as the kernel reads them: four-factor CPR bounds in
 * percent CPR (65 means 65%), constant CPR as a fraction (0.06), beta and draw
 * rates as fractions, spreads in basis points.
 *
 * Browser-safe on purpose: this module imports types only, so Studio imports
 * it by path without the engine barrel (which pulls node:crypto into a bundle).
 */
import type { BehavioralOverlay } from "./assumptions";

/** Hard bounds on one number. Absent keys mean no bound on that side. */
export interface NumberBounds {
  min?: number;
  max?: number;
  /** True when the value must lie strictly above `min`. */
  minExclusive?: boolean;
  /** True when the value must lie strictly below `max`. */
  maxExclusive?: boolean;
  /** True when the value must be a whole number. */
  integer?: boolean;
}

/** One number, at `path` relative to the overlay (`params.sens.kappaB`, `renewalProbability`). */
export interface NumberField extends NumberBounds {
  shape: "number";
  path: string;
  label: string;
  unit: string;
  help: string;
}

/** A number column of a table: `key` is the property of each row object. */
export interface NumberColumn extends NumberBounds {
  key: string;
  label: string;
  unit: string;
  help: string;
}

/** A text column of a table: the value must be non-empty text. */
export interface TextColumn {
  key: string;
  label: string;
  text: true;
}

export type TableColumn = NumberColumn | TextColumn;

/** An array of row objects (decay buckets). */
export interface TableField {
  shape: "table";
  path: string;
  label: string;
  help: string;
  minRows: number;
  columns: TableColumn[];
  /** The table rule: this column's values must sum to more than 0. */
  positiveSum?: { key: string; message: string };
}

/** An array of numbers (the commitment draw ramp); row n is "Month n". */
export interface ListField {
  shape: "list";
  path: string;
  label: string;
  unit: string;
  help: string;
  minRows: 0;
  item: NumberBounds;
}

export type ParamField = NumberField | TableField | ListField;

/** A cross-field rule: the value at `a` must be above (`gt`) or at least (`ge`) the value at `b`. */
export interface CrossRule {
  a: string;
  b: string;
  rule: "gt" | "ge";
  message: string;
  /** Where the issue sits; `a` when absent. */
  at?: string;
}

/**
 * An optional, all-or-none group of number fields under one root key (ALM
 * Studio Piece 7b). A group whose root is absent is not
 * checked and adds no field; a present root must carry every field. Field
 * paths are full paths from the overlay (`housing.asOfLtv`).
 */
export interface ParamGroup {
  key: string;
  label: string;
  fields: NumberField[];
  rules: CrossRule[];
  optional: true;
}

export type SchemaKey =
  | "prepay/four-factor-cpr"
  | "prepay/constant-cpr"
  | "nmd-decay"
  | "deposit-beta"
  | "cd-rollover"
  | "commitment-draw"
  | "loan-client-rate";

export interface ParamSchema {
  key: SchemaKey;
  /** The model's name, for a binding card's heading. */
  label: string;
  fields: ParamField[];
  rules: CrossRule[];
  /** Optional groups, checked after the fields and rules. */
  groups?: ParamGroup[];
}

/** One refused value: where it sits (relative to the overlay), the field's label, and why. */
export interface ParamIssue {
  path: string;
  label: string;
  message: string;
}

const num = (path: string, label: string, unit: string, help: string, bounds: NumberBounds = {}): NumberField => ({
  shape: "number",
  path,
  label,
  unit,
  help,
  ...bounds,
});

const FRACTION: NumberBounds = { min: 0, max: 1 };
/** The optional stress speed of a constant CPR; checked outside the field list, since it may be absent. */
export const STRESS_CPR_LABEL = "Liquidity stress CPR";
const AT_LEAST_0: NumberBounds = { min: 0 };
const ABOVE_0: NumberBounds = { min: 0, minExclusive: true };
const WHOLE_FROM_1: NumberBounds = { min: 1, integer: true };
/** A closure rate in percent per month: above 100 the kernel's closure factor `1 - closureT / 100` turns negative (added at 4b). */
const PERCENT_0_100: NumberBounds = { min: 0, max: 100 };
/**
 * The months of rate history the engine holds before the first path month:
 * the kernel's `buildWarmupSOFR1M()` (Jan 2001 to Sep 2025) is 297 long. A
 * literal, so this module keeps its types-only imports; paramSchema.test.ts
 * checks it against the kernel, so a change to the history breaks a test.
 */
const WARMUP_MONTHS = 297;

/** The label of the four-factor house-price group: every value in it is illustrative. */
export const HOUSING_GROUP_LABEL = "House-price response (illustrative)";
const LTV: NumberBounds = { min: 0, minExclusive: true, max: 2 };
const SLOPE: NumberBounds = { min: 0, max: 50 };

/** The house-price response of the four-factor CPR (spec v4 Sections 3 and 6). */
const HOUSING_GROUP: ParamGroup = {
  key: "housing",
  label: HOUSING_GROUP_LABEL,
  optional: true,
  fields: [
    num("housing.asOfLtv", "As-of LTV", "ratio", "Family-level loan-to-value at the as-of house price, an illustrative ratio (0.7 means 70 percent).", LTV),
    num("housing.refiLtvMid", "Refinance LTV midpoint", "ratio", "Current LTV at the midpoint of the refinance eligibility cliff, an illustrative ratio.", LTV),
    num("housing.refiLtvSlope", "Refinance LTV steepness", "per unit LTV", "How sharply refinancing falls away as current LTV passes its midpoint, an illustrative steepness.", SLOPE),
    num("housing.turnoverLtvMid", "Turnover LTV midpoint", "ratio", "Current LTV at the midpoint of the negative-equity lock-in on turnover, an illustrative ratio.", LTV),
    num("housing.turnoverLtvSlope", "Turnover LTV steepness", "per unit LTV", "How sharply turnover falls as current LTV passes its midpoint, an illustrative steepness.", SLOPE),
    num("housing.turnoverFloorShare", "Turnover floor share", "fraction", "Share of as-of turnover that remains however deep the negative equity, an illustrative fraction.", FRACTION),
    num("housing.turnoverCprFloor", "Turnover CPR floor", "% CPR", "Absolute turnover speed the house-price response never cuts below, an illustrative percent CPR at most the minimum CPR.", PERCENT_0_100),
  ],
  rules: [{ a: "params.minCpr", b: "housing.turnoverCprFloor", rule: "ge", at: "housing.turnoverCprFloor", message: "must be at most the minimum CPR" }],
};

export const PARAM_SCHEMAS: Readonly<Record<SchemaKey, ParamSchema>> = {
  "prepay/four-factor-cpr": {
    key: "prepay/four-factor-cpr",
    label: "Four-factor CPR",
    fields: [
      num("params.secSpread", "Securitization spread", "bp", "Added with the primary spread to the 10-year benchmark rate to give the mortgage rate the refinance incentive reads."),
      num("params.primSpread", "Primary spread", "bp", "The gap between the secondary market rate and the rate a borrower is offered."),
      num("params.wac", "Pool coupon", "%", "Weighted average coupon in percent (6 means 6%). A run prepays each position from its own note rate, so this value does not reach a position.", AT_LEAST_0),
      num("params.minCpr", "Minimum CPR", "% CPR", "Prepayment speed with no refinance incentive, in percent CPR (5 means 5%).", { min: 0, max: 100 }),
      num("params.maxCpr", "Maximum CPR", "% CPR", "Prepayment speed deep in the money, in percent CPR; above the minimum.", { max: 100 }),
      num("params.steepness", "Refinance steepness", "per point", "How sharply the refinance S-curve rises as the incentive passes its midpoint, per percentage point of incentive."),
      num("params.inflection", "Refinance midpoint", "bp", "The incentive, coupon less mortgage rate, at the midpoint of the refinance S-curve."),
      num("params.seasoningRamp", "Seasoning ramp", "months", "Months for a new loan to reach full speed; speed rises in a straight line until then.", ABOVE_0),
      num("params.seasonalityAmp", "Seasonality amplitude", "%", "Amplitude of the loan-age pattern, in percent of speed (10 means plus or minus 10%). The pattern follows each loan's age in months, not the calendar month.", { min: 0, max: 100 }),
      num("params.burnoutDecay", "Burnout decay", "% per point", "How fast speed decays as in-the-money months accumulate; 0 switches burnout off.", AT_LEAST_0),
    ],
    rules: [{ a: "params.maxCpr", b: "params.minCpr", rule: "gt", message: "must be above the minimum CPR" }],
    groups: [HOUSING_GROUP],
  },
  "prepay/constant-cpr": {
    key: "prepay/constant-cpr",
    label: "Constant CPR",
    fields: [num("annualCpr", "Annual CPR", "fraction", "Constant annual prepayment rate as a fraction (0.06 means 6%).", FRACTION)],
    rules: [],
  },
  "nmd-decay": {
    key: "nmd-decay",
    label: "Deposit decay",
    fields: [
      num("params.closureSteady", "Steady closure rate", "% per month", "Account closure rate once the age ramp settles, in percent per month (1 means 1%).", PERCENT_0_100),
      num("params.closureInitial", "Initial closure rate", "% per month", "Closure rate at the start; equal to the steady rate, the ramp is off.", PERCENT_0_100),
      num("params.closureTauMonths", "Closure ramp time", "months", "Months for the closure rate to move from its starting to its steady value; the ramp settles by about three times this.", ABOVE_0),
      num("params.burnoutLambda", "Burnout rate", "per point", "How fast the rate-driven outflow wears off as incentive accumulates; 0 switches burnout off.", AT_LEAST_0),
      num("params.maxRateDecay", "Maximum rate outflow", "% per month", "Rate-driven outflow at high rates, in percent per month, before the balance multiplier."),
      num("params.maxRateGrowth", "Maximum rate inflow", "% per month", "Rate-driven change at low rates, in percent per month; a negative value is an inflow."),
      num("params.logisticK", "Rate response steepness", "per point", "How sharply the rate response moves between its low-rate and high-rate levels, per percentage point."),
      num("params.logisticMidpoint", "Rate response midpoint", "%", "The rate, or for an interest-bearing book the market rate less the deposit rate, at the midpoint of the rate response."),
      num("params.maPeriod", "Regime window", "months", `Months in the trailing average rate that sets the regime, at most the ${WARMUP_MONTHS} months of rate history the engine holds before the first path month.`, { ...WHOLE_FROM_1, max: WARMUP_MONTHS }),
      num("params.regimeAlpha", "Regime amplifier", "per point", "Extra outflow per percentage point the rate sits above its trailing average; 0 switches it off.", AT_LEAST_0),
      num("params.balanceSize", "Book size", "USD", "Total book balance the buckets share out, in dollars.", ABOVE_0),
      num("params.sens.gMin", "Sensitivity floor", "multiplier", "Rate-sensitivity multiplier for the smallest accounts.", AT_LEAST_0),
      num("params.sens.gMax", "Sensitivity ceiling", "multiplier", "Rate-sensitivity multiplier for the largest accounts; at least the floor."),
      num("params.sens.bStar", "Sensitivity midpoint balance", "USD", "Account balance, in dollars, where rate sensitivity rises fastest.", ABOVE_0),
      num("params.sens.kappaB", "Sensitivity steepness", "per log dollar", "How sharply rate sensitivity rises with the log of account balance."),
      {
        shape: "table",
        path: "params.buckets",
        label: "Account-size buckets",
        help: "The book split by account size. Shares need not sum to 1; the model scales them to 1.",
        minRows: 1,
        columns: [
          { key: "label", label: "Bucket", text: true },
          { key: "repBalance", label: "Representative balance", unit: "USD", help: "A typical account balance in the bucket, in dollars.", ...ABOVE_0 },
          { key: "share", label: "Share", unit: "fraction", help: "The bucket's share of the book balance.", ...FRACTION },
        ],
        positiveSum: { key: "share", message: "shares must sum to more than 0" },
      },
    ],
    rules: [{ a: "params.sens.gMax", b: "params.sens.gMin", rule: "ge", message: "must be at least the sensitivity floor" }],
  },
  "deposit-beta": {
    key: "deposit-beta",
    label: "Deposit repricing",
    fields: [
      num("params.betaMin", "Beta floor", "fraction", "Pass-through of market rates at low rate levels (0.5 means 50%).", AT_LEAST_0),
      num("params.betaMax", "Beta ceiling", "fraction", "Pass-through at high rate levels; above the floor."),
      num("params.k", "Beta steepness", "per point", "How sharply beta moves from floor to ceiling as the market rate passes the midpoint."),
      num("params.m", "Beta midpoint rate", "%", "Market rate, in percent, where beta sits halfway between floor and ceiling."),
      num("params.lambda", "Adjustment speed", "fraction", "Share of the gap to the target deposit rate closed each month; 1 closes it at once.", { min: 0, max: 1, minExclusive: true }),
    ],
    rules: [{ a: "params.betaMax", b: "params.betaMin", rule: "gt", message: "must be above the beta floor" }],
  },
  "cd-rollover": {
    key: "cd-rollover",
    label: "CD rollover",
    fields: [
      num("renewalProbability", "Renewal probability", "fraction", "Share of maturing balance that renews rather than running off.", FRACTION),
      num("offeredSpreadBp", "Offered spread", "bp", "Spread over the reinvestment index on the renewed CD."),
      num("termMonths", "Renewal term", "months", "Term of the renewed CD, in whole months.", WHOLE_FROM_1),
    ],
    rules: [],
  },
  "commitment-draw": {
    key: "commitment-draw",
    label: "Commitment draws",
    fields: [
      {
        shape: "list",
        path: "rampRates",
        label: "Draw ramp",
        unit: "fraction",
        help: "Month n draws this fraction of what is still undrawn, month 1 first. The ramp may be empty.",
        minRows: 0,
        item: FRACTION,
      },
      num("steadyRate", "Steady draw rate", "fraction", "Fraction of what is still undrawn drawn each month after the ramp.", FRACTION),
    ],
    rules: [],
  },
  "loan-client-rate": {
    key: "loan-client-rate",
    label: "Loan client rate, flat carry",
    fields: [
      num("totalSpreadBp", "Total spread", "bp", "Added to the 10-year forward par yield on the run's curve to give the client rate.", { min: 0, max: 1000 }),
    ],
    rules: [],
  },
};

/**
 * The schema key of a built-in overlay; undefined for a registered overlay.
 * A prepay overlay whose model is not four-factor-cpr reads as constant CPR,
 * as resolveAssumptions' resolvePrepay reads it, so the check judges the
 * fields a run would read.
 */
export function schemaKeyOf(overlay: BehavioralOverlay): SchemaKey | undefined {
  switch (overlay.kind) {
    case "prepay":
      return overlay.model === "four-factor-cpr" ? "prepay/four-factor-cpr" : "prepay/constant-cpr";
    case "nmd-decay":
    case "deposit-beta":
    case "cd-rollover":
    case "commitment-draw":
    case "loan-client-rate":
      return overlay.kind;
    default:
      return undefined;
  }
}

/**
 * The number fields of a built-in overlay's schema, in schema order: the
 * parameters a behavioral-shock op can address. Tables
 * and lists are not number fields; a registered overlay has none.
 */
export function numberFieldsOf(overlay: BehavioralOverlay): NumberField[] {
  const key = schemaKeyOf(overlay);
  if (key === undefined) return [];
  const own = PARAM_SCHEMAS[key].fields.filter((f): f is NumberField => f.shape === "number");
  // An optional group's fields are addressable only when the overlay carries its root.
  const grouped = groupsOf(overlay).filter((g) => valueAt(overlay, g.key) !== undefined).flatMap((g) => g.fields);
  return [...own, ...grouped];
}

/** The optional parameter groups of a built-in overlay's schema; [] for none and for a registered overlay. */
export function groupsOf(overlay: BehavioralOverlay): ParamGroup[] {
  const key = schemaKeyOf(overlay);
  if (key === undefined) return [];
  return PARAM_SCHEMAS[key].groups ?? [];
}

/** The value at a dotted path (no array indices), or undefined when any step is missing. */
export function valueAt(root: unknown, path: string): unknown {
  let at: unknown = root;
  for (const step of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[step];
  }
  return at;
}

/** Why `v` fails `bounds`, or null when it passes. JSON carries NaN as null, so a null reads "must be a number". */
export function numberProblem(v: unknown, bounds: NumberBounds): string | null {
  if (v === undefined) return "is missing";
  if (typeof v !== "number") return "must be a number";
  if (!Number.isFinite(v)) return "must be a finite number";
  if (bounds.integer === true && !Number.isInteger(v)) return "must be a whole number";
  if (bounds.min !== undefined) {
    if (bounds.minExclusive === true ? !(v > bounds.min) : !(v >= bounds.min)) {
      return bounds.minExclusive === true ? `must be above ${bounds.min}` : `must be at least ${bounds.min}`;
    }
  }
  if (bounds.max !== undefined) {
    if (bounds.maxExclusive === true ? !(v < bounds.max) : !(v <= bounds.max)) {
      return bounds.maxExclusive === true ? `must be below ${bounds.max}` : `must be at most ${bounds.max}`;
    }
  }
  return null;
}

/**
 * The sum of one number column of a table, or null when a row's value is not a
 * finite number. The table rule reads it, and Studio prints it under the
 * bucket table, so the figure shown is the figure the rule judged.
 */
export function columnSum(rows: unknown, key: string): number | null {
  if (!Array.isArray(rows)) return null;
  let sum = 0;
  for (const row of rows) {
    const v = row !== null && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

function fieldLabel(schema: ParamSchema, path: string): string {
  const all: Array<{ path: string; label: string }> = [...schema.fields, ...(schema.groups ?? []).flatMap((g) => g.fields)];
  return all.find((f) => f.path === path)?.label ?? path;
}

/** Every refused value of one cross rule, at `r.at ?? r.a`. */
function ruleIssues(schema: ParamSchema, overlay: BehavioralOverlay, rules: CrossRule[]): ParamIssue[] {
  const out: ParamIssue[] = [];
  for (const r of rules) {
    const a = valueAt(overlay, r.a);
    const b = valueAt(overlay, r.b);
    // A missing or non-finite side is already an issue above; the rule judges two finite numbers only.
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const at = r.at ?? r.a;
    if (r.rule === "gt" ? !(a > b) : !(a >= b)) out.push({ path: at, label: fieldLabel(schema, at), message: r.message });
  }
  return out;
}

/**
 * The issues of one optional group: none when its root is absent;
 * otherwise the shape, one issue per unknown key, ONE issue listing every
 * missing field (which stops the group), each field's bounds, then the
 * group's rules at paths whose field passed its bounds. The shape and partial texts name the one group 7b declares.
 */
function groupIssues(schema: ParamSchema, overlay: BehavioralOverlay, g: ParamGroup): ParamIssue[] {
  const root = valueAt(overlay, g.key);
  if (root === undefined) return [];
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return [{ path: g.key, label: g.label, message: "must be an object of the seven house-price parameters" }];
  }
  const out: ParamIssue[] = [];
  const names = g.fields.map((f) => f.path.slice(g.key.length + 1));
  for (const k of Object.keys(root)) if (!names.includes(k)) out.push({ path: g.key, label: g.label, message: `unknown field ${JSON.stringify(k)}` });
  const missing = names.filter((n) => (root as Record<string, unknown>)[n] === undefined);
  if (missing.length > 0) {
    out.push({ path: g.key, label: g.label, message: `is partial: missing ${missing.join(", ")}; give all seven or none` });
    return out;
  }
  for (const f of g.fields) {
    const m = numberProblem(valueAt(overlay, f.path), f);
    if (m !== null) out.push({ path: f.path, label: f.label, message: m });
  }
  // A field that already breaks its own bound gets that one issue, not also a rule issue at the same path.
  const flagged = new Set(out.map((i) => i.path));
  out.push(...ruleIssues(schema, overlay, g.rules).filter((i) => !flagged.has(i.path)));
  return out;
}

/**
 * Every refused value of one overlay, in schema order: presence, type (a
 * number where a number is declared, an array where a table or list is),
 * finiteness, each bound, each table rule, then each cross rule. It walks every
 * level, so it covers `sens` and `buckets`. A registered overlay returns []:
 * its params belong to its plugin.
 */
export function checkOverlayParams(overlay: BehavioralOverlay): ParamIssue[] {
  const key = schemaKeyOf(overlay);
  // A registered overlay (and a kind bindAssumptions has already refused) has no schema here.
  if (key === undefined) return [];
  const schema = PARAM_SCHEMAS[key];
  const out: ParamIssue[] = [];
  // The only public client-rate model is flat carry (ruling 2026-08-22).
  // The schema walk below has no literal check, so the model is judged here,
  // before the fields, and its issue comes first.
  if (key === "loan-client-rate") {
    const model = (overlay as { model?: unknown }).model;
    if (model === undefined) out.push({ path: "model", label: "Model", message: "is missing" });
    else if (model !== "flat-carry") out.push({ path: "model", label: "Model", message: 'must be "flat-carry"' });
  }
  for (const f of schema.fields) {
    const v = valueAt(overlay, f.path);
    if (f.shape === "number") {
      const m = numberProblem(v, f);
      if (m !== null) out.push({ path: f.path, label: f.label, message: m });
      continue;
    }
    if (!Array.isArray(v)) {
      out.push({ path: f.path, label: f.label, message: v === undefined ? "is missing" : "must be a list" });
      continue;
    }
    if (v.length < f.minRows) {
      out.push({ path: f.path, label: f.label, message: `needs at least ${f.minRows} ${f.minRows === 1 ? "row" : "rows"}` });
    }
    if (f.shape === "list") {
      v.forEach((x, i) => {
        const m = numberProblem(x, f.item);
        if (m !== null) out.push({ path: `${f.path}[${i}]`, label: `${f.label}, month ${i + 1}`, message: m });
      });
      continue;
    }
    v.forEach((row, i) => {
      const cells = row !== null && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
      for (const c of f.columns) {
        const x = cells[c.key];
        const m = "text" in c
          ? (typeof x === "string" && x.trim() !== "" ? null : x === undefined ? "is missing" : "must be non-empty text")
          : numberProblem(x, c);
        if (m !== null) out.push({ path: `${f.path}[${i}].${c.key}`, label: `${c.label}, row ${i + 1}`, message: m });
      }
    });
    if (f.positiveSum !== undefined && v.length > 0) {
      const sum = columnSum(v, f.positiveSum.key);
      if (sum !== null && !(sum > 0)) out.push({ path: f.path, label: f.label, message: f.positiveSum.message });
    }
  }
  out.push(...ruleIssues(schema, overlay, schema.rules));
  for (const g of schema.groups ?? []) out.push(...groupIssues(schema, overlay, g));
  // The house-price group belongs to the four-factor CPR; constant CPR carries no such group.
  if (key === "prepay/constant-cpr" && valueAt(overlay, "housing") !== undefined) {
    out.push({ path: "housing", label: HOUSING_GROUP_LABEL, message: "applies to the four-factor CPR only" });
  }
  // The optional full beta form of a deposit-beta overlay.
  if (key === "deposit-beta" && valueAt(overlay, "fullForm") !== undefined) out.push(...fullFormIssues(valueAt(overlay, "fullForm")));
  // The optional component decay form of an nmd-decay overlay.
  if (key === "nmd-decay" && valueAt(overlay, "componentDecay") !== undefined) out.push(...componentDecayIssues(valueAt(overlay, "componentDecay")));
  // The optional replicating-portfolio credit construction of an nmd-decay overlay; teach
  // slice E3 of a deposit-beta overlay too.
  if ((key === "nmd-decay" || key === "deposit-beta") && valueAt(overlay, "replicatingPortfolio") !== undefined) out.push(...replicatingPortfolioIssues(valueAt(overlay, "replicatingPortfolio")));
  // The optional liquidity stress speed of a constant CPR, a fraction when present.
  if (key === "prepay/constant-cpr") {
    const stress = valueAt(overlay, "stressAnnualCpr");
    const m = stress === undefined ? null : numberProblem(stress, FRACTION);
    if (m !== null) out.push({ path: "stressAnnualCpr", label: STRESS_CPR_LABEL, message: m });
  }
  return out;
}

/** The full beta form's label on screen and in refusals. */
export const FULL_FORM_LABEL = "Full beta form";

/** The numbers of the full beta form: key, label, bounds, and whether the number may be absent. */
const FULL_FORM_NUMBERS: readonly { key: string; label: string; bounds: NumberBounds; optional: boolean }[] = [
  { key: "alphaPct", label: "Intercept", bounds: {}, optional: false },
  { key: "deltaUp", label: "Dampening after a rise", bounds: FRACTION, optional: false },
  { key: "deltaDown", label: "Dampening after a fall", bounds: FRACTION, optional: false },
  { key: "volRatio", label: "Volatility ratio", bounds: AT_LEAST_0, optional: false },
  { key: "baseShortRatePct", label: "Base short rate", bounds: AT_LEAST_0, optional: false },
  { key: "staticBeta", label: "Static beta", bounds: FRACTION, optional: true },
  { key: "startPaidRatePct", label: "Starting paid rate", bounds: {}, optional: true },
  { key: "coreLifeYears", label: "Core life", bounds: ABOVE_0, optional: true },
];

/** Every refused value of a full beta form, in field order; [] when it is well formed. */
export function fullFormIssues(form: unknown): ParamIssue[] {
  if (form === null || typeof form !== "object" || Array.isArray(form)) {
    return [{ path: "fullForm", label: FULL_FORM_LABEL, message: "must be an object" }];
  }
  const out: ParamIssue[] = [];
  const known = new Set([...FULL_FORM_NUMBERS.map((f) => f.key), "baseLastMove", "balances"]);
  for (const k of Object.keys(form)) {
    if (!known.has(k)) out.push({ path: "fullForm." + k, label: FULL_FORM_LABEL, message: "is not a field of the full beta form" });
  }
  for (const f of FULL_FORM_NUMBERS) {
    const v = valueAt(form, f.key);
    if (v === undefined && f.optional) continue;
    const m = numberProblem(v, f.bounds);
    if (m !== null) out.push({ path: "fullForm." + f.key, label: f.label, message: m });
  }
  const move = valueAt(form, "baseLastMove");
  if (move !== "rise" && move !== "fall") {
    out.push({
      path: "fullForm.baseLastMove",
      label: "Last move at the base state",
      message: move === undefined ? "is missing" : 'must be "rise" or "fall"',
    });
  }
  const balances = valueAt(form, "balances");
  if (balances !== "flat") {
    out.push({
      path: "fullForm.balances",
      label: "Balances",
      message: balances === undefined ? "is missing" : 'must be "flat", the only setting built',
    });
  }
  return out;
}

/** The component decay form's label on screen and in refusals. */
export const COMPONENT_DECAY_LABEL = "Component decay form";

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Months from `from` to `to` ("YYYY-MM"), so the same month is 0. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/** The numbers of the component decay form: key, label, bounds, and whether the number may be absent. */
const COMPONENT_DECAY_NUMBERS: readonly { key: string; label: string; bounds: NumberBounds; optional: boolean }[] = [
  { key: "retention", label: "Monthly retention", bounds: { min: 0, minExclusive: true, max: 1 }, optional: false },
  { key: "drift", label: "Survivor drift", bounds: { min: -1, minExclusive: true, max: 1 }, optional: false },
  { key: "coefficientPerPp", label: "Rate coefficient per percentage point", bounds: { min: -1, max: 1 }, optional: false },
  { key: "lookbackMonths", label: "Benchmark lookback", bounds: WHOLE_FROM_1, optional: false },
  { key: "staticShare", label: "Static stable share", bounds: FRACTION, optional: true },
];

/**
 * Every refused value of a component decay form, in field order; [] when it is well formed. The
 * series must hold the lookback months before the window and every window month, each a finite percent.
 */
export function componentDecayIssues(form: unknown): ParamIssue[] {
  if (form === null || typeof form !== "object" || Array.isArray(form)) {
    return [{ path: "componentDecay", label: COMPONENT_DECAY_LABEL, message: "must be an object" }];
  }
  const out: ParamIssue[] = [];
  const known = new Set([...COMPONENT_DECAY_NUMBERS.map((f) => f.key), "series", "window", "beyondWindow"]);
  for (const k of Object.keys(form)) {
    if (!known.has(k)) out.push({ path: "componentDecay." + k, label: COMPONENT_DECAY_LABEL, message: "is not a field of the component decay form" });
  }
  for (const f of COMPONENT_DECAY_NUMBERS) {
    const v = valueAt(form, f.key);
    if (v === undefined && f.optional) continue;
    const m = numberProblem(v, f.bounds);
    if (m !== null) out.push({ path: "componentDecay." + f.key, label: f.label, message: m });
  }
  if (valueAt(form, "beyondWindow") !== "hold-last") {
    out.push({
      path: "componentDecay.beyondWindow",
      label: "Driver past the window",
      message: valueAt(form, "beyondWindow") === undefined ? "is missing" : 'must be "hold-last", the only setting built',
    });
  }
  const first = valueAt(form, "series.firstMonth");
  const values = valueAt(form, "series.valuesPct");
  const wFirst = valueAt(form, "window.firstMonth");
  const wLast = valueAt(form, "window.lastMonth");
  if (typeof valueAt(form, "series.label") !== "string" || (valueAt(form, "series.label") as string).trim() === "") {
    out.push({ path: "componentDecay.series.label", label: "Rate series", message: "must name the series in non-empty text" });
  }
  for (const [path, v] of [["series.firstMonth", first], ["window.firstMonth", wFirst], ["window.lastMonth", wLast]] as const) {
    if (typeof v !== "string" || !YEAR_MONTH.test(v)) out.push({ path: "componentDecay." + path, label: "Month", message: 'must be a month "YYYY-MM"' });
  }
  if (!Array.isArray(values) || values.length === 0) {
    out.push({ path: "componentDecay.series.valuesPct", label: "Rate series", message: "must be a non-empty list of monthly values in percent" });
    return out;
  }
  values.forEach((x, i) => {
    const m = numberProblem(x, {});
    if (m !== null) out.push({ path: `componentDecay.series.valuesPct[${i}]`, label: `Rate series, month ${i + 1}`, message: m });
  });
  const lookback = valueAt(form, "lookbackMonths");
  if (out.length > 0 || typeof first !== "string" || typeof wFirst !== "string" || typeof wLast !== "string" || typeof lookback !== "number") return out;
  const start = monthsBetween(first, wFirst);
  const end = monthsBetween(first, wLast);
  if (end < start) out.push({ path: "componentDecay.window", label: "Window", message: "its last month is before its first" });
  else if (start < lookback) {
    out.push({ path: "componentDecay.window.firstMonth", label: "Window", message: `needs ${lookback} months of the series before it; the series starts ${start} months earlier` });
  } else if (end > values.length - 1) {
    out.push({ path: "componentDecay.window.lastMonth", label: "Window", message: `ends after the series, whose last month is ${values.length - 1} months after ${first}` });
  }
  return out;
}

/** The replicating-portfolio construction's label on screen and in refusals. */
export const REPLICATING_PORTFOLIO_LABEL = "Replicating-portfolio credit";

const RP_CONSTRUCTIONS: readonly string[] = ["life-target", "pillar", "strip", "static-share"];

/**
 * Every refused value of a replicating-portfolio construction, in field order; [] when it is well
 * formed. A life-target construction needs an ascending grid of whole months from 1; a pillar construction one whole
 * month; a strip neither. The haircut is a whole number of months; the steepener a finite shift at a tenor above 0.
 */
export function replicatingPortfolioIssues(form: unknown): ParamIssue[] {
  if (form === null || typeof form !== "object" || Array.isArray(form)) {
    return [{ path: "replicatingPortfolio", label: REPLICATING_PORTFOLIO_LABEL, message: "must be an object" }];
  }
  const out: ParamIssue[] = [];
  const known = new Set(["construction", "pillarGridMonths", "pillarMonths", "haircutMonths", "steepener", "life", "beta", "scenarioCurve"]);
  for (const k of Object.keys(form)) {
    if (!known.has(k)) out.push({ path: "replicatingPortfolio." + k, label: REPLICATING_PORTFOLIO_LABEL, message: "is not a field of the replicating-portfolio construction" });
  }
  const construction = valueAt(form, "construction");
  if (typeof construction !== "string" || !RP_CONSTRUCTIONS.includes(construction)) {
    out.push({
      path: "replicatingPortfolio.construction",
      label: "Construction",
      message: construction === undefined ? "is missing" : `must be one of ${RP_CONSTRUCTIONS.map((c) => `"${c}"`).join(", ")}`,
    });
  }
  const grid = valueAt(form, "pillarGridMonths");
  const pillar = valueAt(form, "pillarMonths");
  if (construction === "life-target" || construction === "static-share") {
    if (!Array.isArray(grid) || grid.length === 0) {
      out.push({ path: "replicatingPortfolio.pillarGridMonths", label: "Pillar grid", message: "must be a non-empty list of pillar tenors in months" });
    } else {
      grid.forEach((k, i) => {
        const m = numberProblem(k, WHOLE_FROM_1);
        if (m !== null) out.push({ path: `replicatingPortfolio.pillarGridMonths[${i}]`, label: `Pillar ${i + 1}`, message: m });
        else if (i > 0 && !((k as number) > (grid[i - 1] as number))) out.push({ path: `replicatingPortfolio.pillarGridMonths[${i}]`, label: `Pillar ${i + 1}`, message: "must be longer than the pillar before it" });
      });
    }
  } else if (grid !== undefined) {
    out.push({ path: "replicatingPortfolio.pillarGridMonths", label: "Pillar grid", message: 'applies to the "life-target" and "static-share" constructions only' });
  }
  if (construction === "pillar") {
    const m = numberProblem(pillar, WHOLE_FROM_1);
    if (m !== null) out.push({ path: "replicatingPortfolio.pillarMonths", label: "Pillar", message: m });
  } else if (pillar !== undefined) {
    out.push({ path: "replicatingPortfolio.pillarMonths", label: "Pillar", message: 'applies to the "pillar" construction only' });
  }
  const haircut = valueAt(form, "haircutMonths");
  if (haircut !== undefined) {
    const m = numberProblem(haircut, WHOLE_FROM_1);
    if (m !== null) out.push({ path: "replicatingPortfolio.haircutMonths", label: "Haircut runoff", message: m });
  }
  if (valueAt(form, "steepener") !== undefined) {
    const bp = numberProblem(valueAt(form, "steepener.topBp"), {});
    if (bp !== null) out.push({ path: "replicatingPortfolio.steepener.topBp", label: "Steepener shift", message: bp });
    const t = numberProblem(valueAt(form, "steepener.topYears"), { min: 0, minExclusive: true });
    if (t !== null) out.push({ path: "replicatingPortfolio.steepener.topYears", label: "Steepener tenor", message: t });
  }
  // The life source, the beta source and the shocked-scenario reading.
  const life = valueAt(form, "life");
  const lifeSource = valueAt(form, "life.source");
  if (life !== undefined) {
    if (lifeSource === "capped") {
      const m = numberProblem(valueAt(form, "life.months"), WHOLE_FROM_1);
      if (m !== null) out.push({ path: "replicatingPortfolio.life.months", label: "Capped life", message: m });
    } else if (lifeSource !== "balance-path") {
      out.push({ path: "replicatingPortfolio.life.source", label: "Life", message: 'must be "balance-path" or "capped"' });
    }
  }
  if (construction === "static-share" && lifeSource !== "balance-path") {
    out.push({ path: "replicatingPortfolio.life", label: "Life", message: 'the "static-share" construction reads the balance path\'s frozen base life: set life.source "balance-path"' });
  }
  if (life !== undefined && (construction === "strip" || valueAt(form, "haircutMonths") !== undefined || valueAt(form, "steepener") !== undefined)) {
    out.push({ path: "replicatingPortfolio.life", label: "Life", message: "the strip, the haircut and the steepener read a straight-line runoff; leave life out" });
  }
  const beta = valueAt(form, "beta");
  if (beta !== undefined) {
    const src = valueAt(form, "beta.source");
    if (src === "fixed") {
      const m = numberProblem(valueAt(form, "beta.value"), FRACTION);
      if (m !== null) out.push({ path: "replicatingPortfolio.beta.value", label: "Beta", message: m });
    } else if (src !== "s-curve-ceiling") {
      out.push({ path: "replicatingPortfolio.beta.source", label: "Beta", message: 'must be "s-curve-ceiling" or "fixed"' });
    }
  }
  const curve = valueAt(form, "scenarioCurve");
  if (curve !== undefined) {
    if (curve !== "hold-base" && curve !== "shift") out.push({ path: "replicatingPortfolio.scenarioCurve", label: "Shocked scenarios", message: 'must be "hold-base" or "shift"' });
    else if (life === undefined) out.push({ path: "replicatingPortfolio.scenarioCurve", label: "Shocked scenarios", message: "a straight-line runoff's credit runs on the base scenario only; leave scenarioCurve out" });
  }
  return out;
}

/** Every refused value of a linear decay against its deposit's maturity; [] when it is well formed. */
export function linearDecayIssues(form: unknown, maturityMonths: number): ParamIssue[] {
  if (form === null || typeof form !== "object" || Array.isArray(form)) {
    return [{ path: "linearDecay", label: "Linear decay", message: "must be an object" }];
  }
  const out: ParamIssue[] = [];
  for (const k of Object.keys(form)) {
    if (k !== "horizonMonths") out.push({ path: "linearDecay." + k, label: "Linear decay", message: "is not a field of the linear decay" });
  }
  const n = valueAt(form, "horizonMonths");
  const m = numberProblem(n, WHOLE_FROM_1);
  if (m !== null) out.push({ path: "linearDecay.horizonMonths", label: "Runoff months", message: m });
  else if (n !== maturityMonths) out.push({ path: "linearDecay.horizonMonths", label: "Runoff months", message: `must equal the deposit's maturityMonths, ${maturityMonths}` });
  return out;
}

// ---------------------------------------------------------------------------
// The optional forms as editor field shapes.
// ---------------------------------------------------------------------------

/** Show and write a form field only while the choice at `path` holds one of `in` (an absent choice holds ""). */
export interface FieldWhen {
  path: string;
  in: readonly string[];
}

/** A choice among fixed text values. `optional` adds an empty choice, which writes no key. One option is a fixed value, shown. */
export interface ChoiceField {
  shape: "choice";
  path: string;
  label: string;
  help: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  optional?: true;
  when?: FieldWhen;
}

/** A text value: a month "YYYY-MM" (`format: "year-month"`) or a name. Written as typed; the form's validator judges it. */
export interface TextField {
  shape: "text";
  path: string;
  label: string;
  help: string;
  format?: "year-month";
  when?: FieldWhen;
}

/** A number of a form: `optional` writes no key while its text is empty. */
export type FormNumberField = NumberField & { optional?: true; when?: FieldWhen };

/** A list of numbers in a form; written whenever it is shown, so an empty list meets the validator's own words. */
export type FormListField = Omit<ListField, "minRows"> & { minRows: 0; when?: FieldWhen };

export type FormField = FormNumberField | ChoiceField | TextField | FormListField;

/**
 * An optional form under one root key of an overlay: the full beta form, the component decay form, the replicating-
 * portfolio credit. Off, the overlay carries no root key; on, every shown field is written under it. Each form is
 * checked by its own validator (fullFormIssues, componentDecayIssues, replicatingPortfolioIssues), the one intake and
 * the bind check run, so the editor refuses what they refuse in their words. Paths are full paths from the overlay.
 */
export interface FormGroup {
  key: "fullForm" | "componentDecay" | "replicatingPortfolio";
  label: string;
  help: string;
  fields: FormField[];
  /** The form this one rides beside on the same overlay (the credit of a deposit-beta overlay needs the full form). */
  needs?: "fullForm";
  /** The series this form's list can be filled from: the shipped deposit history, by the Studio's picker. */
  fill?: { kind: "deposit-history"; labelPath: string; firstMonthPath: string; valuesPath: string };
}

const fnum = (path: string, label: string, unit: string, help: string, bounds: NumberBounds = {}, extra: { optional?: true; when?: FieldWhen } = {}): FormNumberField => ({
  ...num(path, label, unit, help, bounds),
  ...extra,
});

const FULL_FORM_GROUP: FormGroup = {
  key: "fullForm",
  label: FULL_FORM_LABEL,
  help: "The paid rate set from the short rate: the intercept plus beta times the rate, the beta damped after each move, closing part of the gap each month at the adjustment speed. Balances are held flat.",
  fields: [
    fnum("fullForm.alphaPct", "Intercept", "%", "Added to the damped beta times the short rate, in percent (0.1 means 0.10 percent)."),
    fnum("fullForm.deltaUp", "Dampening after a rise", "fraction", "How much of the beta a rise in the short rate holds back, times the volatility ratio.", FRACTION),
    fnum("fullForm.deltaDown", "Dampening after a fall", "fraction", "How much of the beta a fall in the short rate holds back, times the volatility ratio.", FRACTION),
    fnum("fullForm.volRatio", "Volatility ratio", "ratio", "Realized short-rate volatility over its long-run mean, held for the whole horizon.", AT_LEAST_0),
    fnum("fullForm.baseShortRatePct", "Base short rate", "%", "The short rate, in percent, the scenarios shift from.", AT_LEAST_0),
    {
      shape: "choice",
      path: "fullForm.baseLastMove",
      label: "Last move at the base state",
      help: "Whether rates last rose or fell at the base state; it picks the damper the base scenario reads.",
      options: [{ value: "rise", label: "Rise" }, { value: "fall", label: "Fall" }],
    },
    fnum("fullForm.staticBeta", "Static beta", "fraction", "A constant beta in place of the S-curve, a comparator. Leave empty to read the S-curve.", FRACTION, { optional: true }),
    fnum("fullForm.startPaidRatePct", "Starting paid rate", "%", "The paid rate the adjustment starts from. Leave empty to start at the form's own rate at the base state.", {}, { optional: true }),
    {
      shape: "choice",
      path: "fullForm.balances",
      label: "Balances",
      help: "Balances are held flat: the only setting built.",
      options: [{ value: "flat", label: "Flat" }],
    },
    fnum("fullForm.coreLifeYears", "Core life", "years", "The core life the shocked-level slotting lays the core over. Leave empty for five years.", ABOVE_0, { optional: true }),
  ],
};

const COMPONENT_DECAY_GROUP: FormGroup = {
  key: "componentDecay",
  label: COMPONENT_DECAY_LABEL,
  help: "The balance on a dated monthly rate path: each month it keeps the retention, survivors grow by the drift, and each point the rate sits above its trailing mean moves it by the coefficient. Past the window the driver holds its last value.",
  fields: [
    fnum("componentDecay.retention", "Monthly retention", "fraction", "The share of balances kept each month (0.98 keeps 98 percent).", { min: 0, minExclusive: true, max: 1 }),
    fnum("componentDecay.drift", "Survivor drift", "fraction per month", "How much the kept balances grow each month (0.0025 is 0.25 percent).", { min: -1, minExclusive: true, max: 1 }),
    fnum("componentDecay.coefficientPerPp", "Rate coefficient per percentage point", "fraction per month", "The monthly change per point the rate sits above its trailing mean; negative shrinks the book.", { min: -1, max: 1 }),
    fnum("componentDecay.lookbackMonths", "Benchmark lookback", "months", "How many realized months the trailing mean reads before each window month.", WHOLE_FROM_1),
    { shape: "text", path: "componentDecay.series.label", label: "Rate series", help: "What the series is, in words." },
    { shape: "text", path: "componentDecay.series.firstMonth", label: "Series first month", help: "The month of the series' first value, YYYY-MM.", format: "year-month" },
    { shape: "list", path: "componentDecay.series.valuesPct", label: "Rate series values", unit: "%", help: "Monthly values in percent, the first month first (the shipped SOFR file holds monthly averages of daily values).", minRows: 0, item: {} },
    { shape: "text", path: "componentDecay.window.firstMonth", label: "Window first month", help: "The month projection month 1 reads, YYYY-MM.", format: "year-month" },
    { shape: "text", path: "componentDecay.window.lastMonth", label: "Window last month", help: "The last month of the path, YYYY-MM.", format: "year-month" },
    {
      shape: "choice",
      path: "componentDecay.beyondWindow",
      label: "Driver past the window",
      help: "Past the window the driver holds its last window value: the only setting built.",
      options: [{ value: "hold-last", label: "Hold the last value" }],
    },
    fnum("componentDecay.staticShare", "Static stable share", "fraction", "The static split instead: this share runs off on the base schedule and the rest leaves overnight. Leave empty for the dynamic form.", FRACTION, { optional: true }),
  ],
  fill: { kind: "deposit-history", labelPath: "componentDecay.series.label", firstMonthPath: "componentDecay.series.firstMonth", valuesPath: "componentDecay.series.valuesPct" },
};

const LIFE_LIST = ["life-target", "static-share"] as const;

const replicatingPortfolioGroup = (needs?: "fullForm"): FormGroup => ({
  key: "replicatingPortfolio",
  label: REPLICATING_PORTFOLIO_LABEL,
  help: "The transfer credit of the deposit: its balance laid down as fixed-rate bullets whose life matches the deposit's, plus the term liquidity premium at that life; the repricing share rolls overnight.",
  ...(needs !== undefined ? { needs } : {}),
  fields: [
    {
      shape: "choice",
      path: "replicatingPortfolio.construction",
      label: "Construction",
      help: "Life target blends the two pillars around the deposit's life; pillar puts it all on one; strip strikes it on the runoff itself; static share credits a static split.",
      options: [
        { value: "life-target", label: "Life target" },
        { value: "pillar", label: "One pillar" },
        { value: "strip", label: "Strip on the runoff" },
        { value: "static-share", label: "Static share" },
      ],
    },
    { shape: "list", path: "replicatingPortfolio.pillarGridMonths", label: "Pillar grid", unit: "months", help: "The pillar tenors in whole months, shortest first.", minRows: 0, item: WHOLE_FROM_1, when: { path: "replicatingPortfolio.construction", in: LIFE_LIST } },
    fnum("replicatingPortfolio.pillarMonths", "Pillar", "months", "The one pillar's tenor in whole months.", WHOLE_FROM_1, { when: { path: "replicatingPortfolio.construction", in: ["pillar"] } }),
    fnum("replicatingPortfolio.haircutMonths", "Haircut runoff", "months", "A shorter runoff read beside the credit, as information. Leave empty for none.", WHOLE_FROM_1, { optional: true }),
    fnum("replicatingPortfolio.steepener.topBp", "Steepener shift", "bp", "The rate leg re-read on a curve steepened by this much at the tenor below. Leave both empty for none.", {}, { optional: true }),
    fnum("replicatingPortfolio.steepener.topYears", "Steepener tenor", "years", "Where the steepener reaches its full shift.", { min: 0, minExclusive: true }, { optional: true }),
    {
      shape: "choice",
      path: "replicatingPortfolio.life.source",
      label: "Life",
      help: "Where the deposit's life comes from. Empty: its straight-line runoff. Balance path: the projected balance run off in full. Capped: a fixed life.",
      options: [{ value: "balance-path", label: "Balance path" }, { value: "capped", label: "Capped" }],
      optional: true,
    },
    fnum("replicatingPortfolio.life.months", "Capped life", "months", "The capped life in whole months.", WHOLE_FROM_1, { when: { path: "replicatingPortfolio.life.source", in: ["capped"] } }),
    {
      shape: "choice",
      path: "replicatingPortfolio.beta.source",
      label: "Beta",
      help: "The repricing share the credit reads. Empty: the deposit's own. S-curve ceiling: the top of the S-curve. Fixed: a stated value.",
      options: [{ value: "s-curve-ceiling", label: "S-curve ceiling" }, { value: "fixed", label: "Fixed" }],
      optional: true,
    },
    fnum("replicatingPortfolio.beta.value", "Fixed beta", "fraction", "The stated repricing share.", FRACTION, { when: { path: "replicatingPortfolio.beta.source", in: ["fixed"] } }),
    {
      shape: "choice",
      path: "replicatingPortfolio.scenarioCurve",
      label: "Shocked scenarios",
      help: "How a parallel shock is read. Empty: the base scenario only. Hold base: the curve held, only the deposit moving. Shift: re-priced on the shocked curve.",
      options: [{ value: "hold-base", label: "Hold base" }, { value: "shift", label: "Shift" }],
      optional: true,
    },
  ],
});

/** The optional forms of each built-in schema, in page order; [] for a schema with none. */
export const FORM_GROUPS: Readonly<Record<SchemaKey, readonly FormGroup[]>> = {
  "prepay/four-factor-cpr": [],
  "prepay/constant-cpr": [],
  "nmd-decay": [COMPONENT_DECAY_GROUP, replicatingPortfolioGroup()],
  "deposit-beta": [FULL_FORM_GROUP, replicatingPortfolioGroup("fullForm")],
  "cd-rollover": [],
  "commitment-draw": [],
  "loan-client-rate": [],
};

/** The optional forms of a schema. */
export function formGroupsOf(key: SchemaKey): readonly FormGroup[] {
  return FORM_GROUPS[key];
}

/**
 * The combinations of forms an overlay cannot carry, whatever the book: the run's overlay merge refuses each of them
 * (projection/static/applyOverlays.ts), here in the merge's own words, so the editor refuses them before a run does.
 * Rules that read the position (a linear decay on the deposit, the instrument type) stay the merge's.
 */
export function formCombinationIssues(overlay: BehavioralOverlay): ParamIssue[] {
  const o = overlay as { kind: string; fullForm?: unknown; componentDecay?: { staticShare?: unknown }; replicatingPortfolio?: { construction?: unknown; life?: { source?: unknown } } };
  const rp = o.replicatingPortfolio;
  if (rp === undefined || rp === null || typeof rp !== "object") return [];
  const at = (message: string, path = "replicatingPortfolio"): ParamIssue[] => [{ path, label: REPLICATING_PORTFOLIO_LABEL, message }];
  if (o.kind === "deposit-beta") {
    if (o.fullForm === undefined) return at("the replicating-portfolio credit of a deposit-beta overlay needs the full beta form beside it");
    if (rp.life?.source !== "capped") return at('a full-form deposit\'s balances are flat, so its replicating-portfolio credit reads a capped life: set life.source "capped"', "replicatingPortfolio.life.source");
    return [];
  }
  if (o.kind !== "nmd-decay") return [];
  if (rp.life !== undefined) {
    if (rp.life.source !== "balance-path") return at("an nmd-decay overlay's credit reads the deposit's balance path or its straight-line runoff; a capped life rides a full-form deposit", "replicatingPortfolio.life.source");
    if (o.componentDecay === undefined) return at("the credit reads the balance path of a component decay form, and the overlay carries none");
    if (rp.construction === "static-share" && o.componentDecay.staticShare === undefined) return at('the "static-share" construction reads the component form\'s static share, and the form carries none');
    return [];
  }
  if (o.componentDecay !== undefined) return at("the overlay carries both a component decay form and a replicating-portfolio credit; the credit reads a linear decay only");
  return [];
}
