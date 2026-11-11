// apps/studio/src/market/curveSetupModel.ts
/**
 * Data > Market > Curve setup. Pure functions over
 * the curve setup screen: the Excel paste parser, the editable grid rows, the menu
 * option lists and the conversion from typed text to the engine's CurveSetupBlock.
 *
 * This file converts text and nothing more. The server validates the block and
 * builds the curve; no engine rule is restated here beyond which compounding
 * choices a row offers. Types come from the engine with import type only.
 *
 * Unknown values from the server (an interpolation, day count or compounding this
 * build does not list) are rendered verbatim through labelFor; nothing here throws
 * on an unexpected string.
 */
import type {
  CurveCompounding,
  CurveDayCount,
  CurveInput,
  CurveInstrument,
  CurveInterpolation,
  CurveQuoteType,
  CurveSetupBlock,
} from "@alm/engine";

// ---------------------------------------------------------------------------
// Menu options

export interface CurveSetupOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * The exhaustiveness helper: a label table keyed by the whole engine union. Written
 * with `satisfies Record<Union, string>`, a missing member or an extra key is a
 * compile error, so each option list covers exactly the engine union.
 */
type LabelTable<T extends string> = Record<T, string>;

function optionsOf<T extends string>(labels: LabelTable<T>): readonly CurveSetupOption<T>[] {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}

const INTERPOLATION_LABELS = {
  "log-linear-df": "Log-linear on discount factor",
  "linear-zero": "Linear in zero rate (legacy)",
  "cubic-zero": "Cubic spline on zero rate",
  "monotone-convex": "Monotone convex",
} as const satisfies LabelTable<CurveInterpolation>;

const DAY_COUNT_LABELS = {
  "ACT/360": "Actual/360",
  "ACT/365": "Actual/365",
} as const satisfies LabelTable<CurveDayCount>;

const COMPOUNDING_LABELS = {
  annual: "Annual",
  "semi-annual": "Semi-annual",
  continuous: "Continuous",
} as const satisfies LabelTable<CurveCompounding>;

const QUOTE_TYPE_LABELS = {
  "par-rate": "Par rate",
  "zero-rate": "Zero rate",
  "discount-factor": "Discount factor",
} as const satisfies LabelTable<CurveQuoteType>;

const INSTRUMENT_LABELS = {
  cash: "Cash",
  "ois-swap": "OIS swap",
  futures: "Futures",
} as const satisfies LabelTable<CurveInstrument>;

/** The new setup form's default (log-linear on discount factor) comes first. */
export const INTERPOLATION_OPTIONS = optionsOf<CurveInterpolation>(INTERPOLATION_LABELS);
export const DAY_COUNT_OPTIONS = optionsOf<CurveDayCount>(DAY_COUNT_LABELS);
export const COMPOUNDING_OPTIONS = optionsOf<CurveCompounding>(COMPOUNDING_LABELS);
export const QUOTE_TYPE_OPTIONS = optionsOf<CurveQuoteType>(QUOTE_TYPE_LABELS);
export const INSTRUMENT_OPTIONS = optionsOf<CurveInstrument>(INSTRUMENT_LABELS);

/** A value the server sent that no option list holds: shown as it came, never refused (Task 9 ruling). */
export function unknownValueLabel(value: string): string {
  return value;
}

/** The plain-words label of a value, or the value verbatim when the list does not hold it. */
export function labelFor(options: readonly CurveSetupOption<string>[], value: string): string {
  const hit = options.find((o) => o.value === value);
  return hit === undefined ? unknownValueLabel(value) : hit.label;
}

/**
 * The compounding choices a row offers. A par-rate row takes annual or semi-annual,
 * a zero-rate row any of the three, a discount-factor row none (the factor is the
 * value itself), and a futures row none (compounding does not apply to it).
 */
export function compoundingOptionsFor(quoteType: CurveQuoteType, instrument?: CurveInstrument): CurveSetupOption<CurveCompounding>[] {
  if (instrument === "futures") return [];
  switch (quoteType) {
    case "par-rate":
      return COMPOUNDING_OPTIONS.filter((o) => o.value !== "continuous");
    case "zero-rate":
      return [...COMPOUNDING_OPTIONS];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Notes for the screen

export const FUTURES_NOTE = "A futures row starts at the tenor you type and covers 3 months. Type the price, for example 95.8.";
/** Restates rowDiscount.ts for the screen, spec v7 decision 71 included (the cash row under a new method). */
export const CONVENTION_NOTE =
  "Day count changes annual par rows above one year (other than cash), semi-annual par rows of one year and more, and every futures row. It also changes an annual cash row, which accrues on 365/360 under ACT/360, unless the interpolation is linear in zero rate. Other rows ignore it.";

/**
 * The two (day count, compounding) pairs the engine maps to a kernel curve convention (buildCurve.ts kernelConvention):
 * ACT/360 annual is annual_act360 and ACT/365 semi-annual is semiannual_bond. Any other pair builds its nodes under its
 * own rules and hands the kernel curve factory the convention of its compounding: semiannual_bond
 * for a semi-annual pair, annual_act360 for an annual or continuous one. That convention sets the par basis of
 * forwardSwapRate, the 10-year benchmark the mortgage refinancing rate, the client-rate benchmark and new-business
 * pricing read. This list and unmappedPairNote restate the engine's mapping for the screen and must follow it.
 */
export const NATIVE_PAIRS: readonly { readonly dayCount: CurveDayCount; readonly compounding: CurveCompounding }[] = [
  { dayCount: "ACT/360", compounding: "annual" },
  { dayCount: "ACT/365", compounding: "semi-annual" },
];

/** True when the pair is one the platform reads natively (NATIVE_PAIRS); a value this build does not list is not. */
export function isNativePair(dayCount: string, compounding: string): boolean {
  return NATIVE_PAIRS.some((p) => p.dayCount === dayCount && p.compounding === compounding);
}

/** The screen note for a pair the platform does not read natively, naming the basis its 10-year forward is quoted on; undefined for a native pair. */
export function unmappedPairNote(dayCount: string, compounding: string): string | undefined {
  if (isNativePair(dayCount, compounding)) return undefined;
  const basis = compounding === "semi-annual" ? "the semi-annual bond basis" : "the annual ACT/360 basis";
  return `${dayCount} with ${compounding} compounding has no platform convention of its own: the curve is built under your settings, and the 10-year forward that mortgages, client rates and new business read is quoted on ${basis}.`;
}

/**
 * The "Linear in zero (month grid)" preset: the fill from the snapshot, joined linear
 * in zero rate. From one month out it sits within about 1e-9 of the old default (curve default version 1, the kernel
 * bootstrap; measured 7.85e-10 on the public pack, 9.90e-10 on the constructed pack), but it is not it: a quote shorter
 * than one month cannot be a row, so the first month differs (0.565 bp, 5.65e-5 as a decimal, at one day on the constructed pack's 1D quote). The byte-equal route to version 1
 * is the market's own marker, which only a seed sets (decision 72). The id is an ordinary setup id, never the
 * reserved platform-default.
 */
export const LINEAR_ZERO_PRESET = {
  id: "linear-zero-month-grid",
  label: "Linear in zero (month grid)",
  interpolation: "linear-zero",
  note: "Built from the attached snapshot's quotes and joined linear in zero rate on the month grid. Within about 1e-9 of the old default from one month out, and not byte-equal to it: a quote shorter than one month is dropped, so the first month differs.",
} as const satisfies { id: string; label: string; interpolation: CurveInterpolation; note: string };

// ---------------------------------------------------------------------------
// Defaults

/** A new setup: no rows, SOFR, log-linear on discount factor, ACT/360, annual. The id is the lineage key the user names. */
export function defaultSetup(): CurveSetupBlock {
  return {
    id: "",
    label: "",
    baseCurve: "SOFR",
    interpolation: "log-linear-df",
    dayCount: "ACT/360",
    compounding: "annual",
    inputs: [],
  };
}

// ---------------------------------------------------------------------------
// Cell readers shared by the paste parser and the grid

type Read<T> = { ok: true; value: T } | { ok: false; why: string };

// Every pattern here runs in linear time on any cell (no two adjacent quantifiers can share a digit).
const TENOR = /^(\d+(?:\.\d*)?|\.\d+)\s*([mMyY]?)$/;
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const THOUSANDS = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/** A number text divided by 100 by shifting its exponent, so 4.35 gives the double nearest 0.0435 (4.35 / 100 need not). */
function hundredth(body: string): number {
  const [mantissa, exp] = body.split(/[eE]/);
  return Number(`${mantissa}e${Number(exp ?? "0") - 2}`);
}

/**
 * A tenor cell: 3M, 6m, 1Y, 10y, 0.25y, or a bare number of months. It must come to a whole
 * month of at least one. Whitespace is allowed only between the number and its unit (1 Y).
 */
function readTenor(cell: string): Read<number> {
  const raw = cell.trim();
  if (raw === "") return { ok: false, why: "enter a tenor" };
  const m = TENOR.exec(raw);
  if (m === null) return { ok: false, why: `${raw} is not a tenor (use 3M, 1Y or a number of months)` };
  const n = Number(m[1]);
  const months = m[2]!.toLowerCase() === "y" ? n * 12 : n;
  const whole = Math.round(months);
  if (Math.abs(months - whole) > 1e-9) return { ok: false, why: `${raw} is not a whole number of months` };
  if (whole < 1) return { ok: false, why: `${raw} is shorter than one month` };
  return { ok: true, value: whole };
}

/**
 * A number cell. A trailing % divides by 100 (see hundredth). Whitespace is allowed only
 * after the sign, before the % sign and around a comma; a space between other digits (4 3)
 * is not a number. Commas are thousands separators only when a dot or several three-digit
 * groups make that certain; a lone comma with no dot could be a decimal comma or a
 * thousands separator and is refused. Every step is a split, a slice or an anchored
 * linear-time pattern, so a huge cell costs linear time.
 */
function readNumber(cell: string): Read<{ n: number; percent: boolean; text: string }> {
  const raw = cell.trim();
  let body = raw;
  const percent = body.endsWith("%");
  if (percent) body = body.slice(0, -1).trimEnd();
  if (body.startsWith("+") || body.startsWith("-")) body = body[0]! + body.slice(1).trimStart();
  body = body
    .split(",")
    .map((part) => part.trim())
    .join(",");
  if (body.includes(",")) {
    const commas = body.split(",").length - 1;
    if (commas === 1 && !body.includes(".")) return { ok: false, why: `${raw} is ambiguous (decimal comma or thousands)` };
    if (!THOUSANDS.test(body)) return { ok: false, why: `${raw} is not a number` };
    body = body.replace(/,/g, "");
  }
  if (!PLAIN_NUMBER.test(body)) return { ok: false, why: `${raw} is not a number` };
  const n = percent ? hundredth(body) : Number(body);
  if (!Number.isFinite(n)) return { ok: false, why: `${raw} is not a number` };
  return { ok: true, value: { n, percent, text: body } };
}

// ---------------------------------------------------------------------------
// Paste parser

export interface ParsedRow {
  tenorMonths: number;
  value: number;
}

export interface ParsePasteResult {
  rows: ParsedRow[];
  /** One entry per refused line; `line` is 1-based in the pasted text and `why` starts with "line N: ". */
  skipped: { line: number; why: string }[];
  /** The unit plain values (cells without a % sign) were read in, decided once for the whole paste. */
  unitUsed: "decimal" | "percent";
}

/** The unit of plain values (cells without a % sign). A cell with a % sign is always divided by 100. */
export type PasteUnit = "decimal" | "percent" | "auto";

export interface ParsePasteOptions {
  /**
   * Replaces the boolean percentWhenAboveOne of the first cut (fix round 1, review
   * ruling): that option decided row by row, so 0.85, 1.00 and 1.25 pasted in percent
   * came out as 0.85, 1.0 and 0.0125 in one curve. The unit is now decided once per paste.
   * "decimal" (default): plain values as typed (a value above 1 is returned as typed; the
   * server refuses it later). "percent": every plain value divided by 100. "auto": percent
   * when ANY plain value in the paste is above 1 in magnitude, else decimal.
   */
  unit?: PasteUnit;
}

/**
 * Rows pasted from Excel or typed as CSV. Lines split on CRLF, LF or CR; cells split on
 * tab, else on comma when the line holds no tab. Cells are POSITIONAL: column 1 is the
 * tenor and column 2 the value, and only trailing empty cells are dropped, so a blank
 * Bid never lets the Ask slide into the value. A tab line ignores columns after 2; a
 * comma line with more than two cells is refused (a comma inside a number cannot be told
 * from the separator). Line 1 is skipped as a header when its first cell has letters and
 * no digit; a blank line is skipped silently. The unit of plain values is decided once
 * for the whole paste (see ParsePasteOptions.unit).
 */
export function parsePaste(text: string, options: ParsePasteOptions = {}): ParsePasteResult {
  const read: { tenorMonths: number; n: number; percent: boolean; body: string }[] = [];
  const skipped: ParsePasteResult["skipped"] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const skip = (why: string): void => {
      skipped.push({ line: lineNo, why: `line ${lineNo}: ${why}` });
    };
    if (line.trim() === "") continue;
    const byTab = line.includes("\t");
    const cells = line.split(byTab ? "\t" : ",").map((c) => c.trim());
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    const first = cells[0] ?? "";
    const second = cells[1] ?? "";
    if (lineNo === 1 && /[A-Za-z]/.test(first) && !/\d/.test(first)) {
      skip("header row skipped");
      continue;
    }
    if (!byTab && cells.length > 2) {
      skip("has more than two comma-separated cells; put a tab between tenor and value");
      continue;
    }
    if (first === "") {
      skip("no tenor in column 1");
      continue;
    }
    if (second === "") {
      skip(cells.length > 2 ? "no value in column 2 (columns after 2 are not read)" : "no value in column 2");
      continue;
    }
    const tenor = readTenor(first);
    if (!tenor.ok) {
      skip(tenor.why);
      continue;
    }
    const num = readNumber(second);
    if (!num.ok) {
      skip(num.why);
      continue;
    }
    read.push({ tenorMonths: tenor.value, n: num.value.n, percent: num.value.percent, body: num.value.text });
  }
  const unit = options.unit ?? "decimal";
  const unitUsed: ParsePasteResult["unitUsed"] =
    unit === "auto" ? (read.some((r) => !r.percent && Math.abs(r.n) > 1) ? "percent" : "decimal") : unit;
  const rows = read.map((r) => ({
    tenorMonths: r.tenorMonths,
    value: !r.percent && unitUsed === "percent" ? hundredth(r.body) : r.n,
  }));
  return { rows, skipped, unitUsed };
}

// ---------------------------------------------------------------------------
// Grid state and the block it builds

/** One editable grid row, every cell as typed. A futures row's tenor is the START of its 3-month period and its value is the price. */
export interface GridRow {
  instrument: CurveInstrument;
  tenorText: string;
  quoteType: CurveQuoteType;
  valueText: string;
  /** Futures only, basis points; blank leaves the field out. */
  convexityText: string;
}

export interface CurveSetupState {
  id: string;
  label: string;
  baseCurve: string;
  interpolation: CurveInterpolation;
  dayCount: CurveDayCount;
  compounding: CurveCompounding;
  rows: GridRow[];
}

/** A cell that could not be read: `row` is 1-based as the grid shows it; `field` is tenor, value or convexity. */
export interface CurveSetupProblem {
  row: number;
  field: "tenor" | "value" | "convexity";
  why: string;
}

/**
 * The block the grid describes, or the cells that cannot be read. Converts text only:
 * id, label, baseCurve and the menus pass through as they stand, rows keep grid order,
 * and every rule about what a valid setup is stays with the server. A numeric
 * convexity on a non-futures row is passed through for the server to refuse.
 */
export function blockFromState(state: CurveSetupState): { block: CurveSetupBlock | null; problems: CurveSetupProblem[] } {
  const problems: CurveSetupProblem[] = [];
  const inputs: CurveInput[] = [];
  state.rows.forEach((r, i) => {
    const rowNo = i + 1;
    const tenor = readTenor(r.tenorText);
    if (!tenor.ok) problems.push({ row: rowNo, field: "tenor", why: tenor.why });

    let value: number | null = null;
    if (r.valueText.trim() === "") problems.push({ row: rowNo, field: "value", why: "enter a value" });
    else {
      const num = readNumber(r.valueText);
      if (!num.ok) problems.push({ row: rowNo, field: "value", why: num.why });
      else if (num.value.percent && r.instrument === "futures")
        problems.push({ row: rowNo, field: "value", why: "a futures row takes the price, for example 95.8, not a percent" });
      else value = num.value.n;
    }

    let convexityBp: number | null = null;
    if (r.convexityText.trim() !== "") {
      const num = readNumber(r.convexityText);
      if (!num.ok) problems.push({ row: rowNo, field: "convexity", why: num.why });
      else if (num.value.percent) problems.push({ row: rowNo, field: "convexity", why: "convexity is in basis points, not a percent" });
      else convexityBp = num.value.n;
    }

    if (tenor.ok && value !== null) {
      const input: CurveInput = { instrument: r.instrument, tenorMonths: tenor.value, quoteType: r.quoteType, value };
      inputs.push(convexityBp === null ? input : { ...input, convexityBp });
    }
  });
  if (problems.length > 0) return { block: null, problems };
  return {
    block: {
      id: state.id,
      label: state.label,
      baseCurve: state.baseCurve,
      interpolation: state.interpolation,
      dayCount: state.dayCount,
      compounding: state.compounding,
      inputs,
    },
    problems,
  };
}

/** A month count as the grid shows it: whole years as Y (12 is 1Y), anything else as M (18M). */
export function tenorTextOf(months: number): string {
  return months % 12 === 0 ? `${months / 12}Y` : `${months}M`;
}

/**
 * Grid rows from the attached snapshot's quotes (the "fill from snapshot" button).
 * Each quote becomes a par-rate row at its tenor rounded to whole months: cash for a
 * CASH quote, OIS swap otherwise. A quote whose tenor rounds to 0 months (an
 * overnight or 1D rate) or whose years are not finite is dropped and named in `dropped` by its term, or by its
 * years when it carries none. The rate is written as typed decimal text, so it reads
 * back through blockFromState to the same number.
 */
export function rowsFromQuotes(
  quotes: readonly { tYears: number; rate: number; instrumentType: string; term?: string }[],
): { rows: GridRow[]; dropped: string[] } {
  const rows: GridRow[] = [];
  const dropped: string[] = [];
  for (const q of quotes) {
    const months = Number.isFinite(q.tYears) ? Math.round(q.tYears * 12) : 0;
    if (months < 1) {
      dropped.push(q.term ?? `${q.tYears} years`);
      continue;
    }
    rows.push({
      instrument: q.instrumentType === "CASH" ? "cash" : "ois-swap",
      tenorText: tenorTextOf(months),
      quoteType: "par-rate",
      valueText: String(q.rate),
      convexityText: "",
    });
  }
  return { rows, dropped };
}
