/**
 * The curve setup validator.
 *
 * validateCurveSetup is the one authority on the shape of a curveSetup block.
 * It takes an untyped value, collects every refusal (none thrown, none skipped
 * after the first), and builds the typed block with its rows sorted ascending
 * by node tenor only when there are no refusals. Rows are named 1-based in
 * the order the caller sent them. Studio shows the refusal sentences verbatim.
 *
 * A row's node tenor is its tenorMonths, except a futures row: its tenorMonths
 * is the START of a 3-month period and its node sits at start + 3 months.
 * Repeats are judged on node tenors (a cash 3M row and a futures row starting
 * at month 3 are the classic strip, nodes 3 and 6), and a futures start above
 * 357 is refused, since its node would pass 360. Each row keeps its own
 * tenorMonths in the output; only the order follows the node.
 *
 * Compounding rules read the block-level compounding. They bind par-rate rows
 * of the cash and ois-swap instruments: a futures row carries a price for a
 * 3-month period, a zero-rate row may use any compounding, and a
 * discount-factor row ignores compounding.
 */
import type {
  CurveCompounding,
  CurveDayCount,
  CurveInput,
  CurveInstrument,
  CurveInterpolation,
  CurveQuoteType,
  CurveSetupBlock,
} from "../contracts/curveSetup";
import { FUTURES_PERIOD_MONTHS, nodeTenorMonths } from "./rowDiscount";

export const MAX_CURVE_INPUTS = 60;
export const MAX_TENOR_MONTHS = 360;
/** The latest futures start: its 3-month period must end by MAX_TENOR_MONTHS. */
export const MAX_FUTURES_START_MONTHS = MAX_TENOR_MONTHS - FUTURES_PERIOD_MONTHS;
/** The largest par-rate or zero-rate magnitude, as a decimal. */
export const MAX_ABS_RATE = 1.0;
/** A discount factor lies in (0, MAX_DISCOUNT_FACTOR]. */
export const MAX_DISCOUNT_FACTOR = 1.5;
/** A futures price lies in the open interval (MIN_FUTURES_PRICE, MAX_FUTURES_PRICE). */
export const MIN_FUTURES_PRICE = 50;
export const MAX_FUTURES_PRICE = 150;
/** The largest futures convexity adjustment magnitude, in basis points. */
export const MAX_ABS_CONVEXITY_BP = 100;

export const CURVE_INTERPOLATIONS: readonly CurveInterpolation[] = [
  "linear-zero",
  "log-linear-df",
  "cubic-zero",
  "monotone-convex",
];
export const CURVE_DAY_COUNTS: readonly CurveDayCount[] = ["ACT/360", "ACT/365"];
export const CURVE_COMPOUNDINGS: readonly CurveCompounding[] = ["annual", "semi-annual", "continuous"];
export const CURVE_QUOTE_TYPES: readonly CurveQuoteType[] = ["par-rate", "zero-rate", "discount-factor"];
export const CURVE_INSTRUMENTS: readonly CurveInstrument[] = ["cash", "ois-swap", "futures"];

const BLOCK_KEYS = ["id", "label", "baseCurve", "interpolation", "dayCount", "compounding", "inputs"] as const;
const ROW_KEYS = ["instrument", "tenorMonths", "quoteType", "value", "convexityBp"] as const;

export type CurveSetupValidation = { ok: true; block: CurveSetupBlock } | { ok: false; refusals: string[] };

/**
 * Describe a value for a refusal without ever throwing. Primitives read as
 * before (a string quoted, a number as written); a list or an object is named,
 * never converted, since JSON can carry an object whose toString is not callable.
 */
const show = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "a list";
  if (v !== null && (typeof v === "object" || typeof v === "function")) return "an object";
  try {
    return String(v);
  } catch {
    return "an unreadable value";
  }
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isMenu = <T extends string>(menu: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (menu as readonly string[]).includes(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Check a curveSetup block. Returns the typed, tenor-sorted block, or every refusal in words. */
export function validateCurveSetup(block: unknown): CurveSetupValidation {
  const refusals: string[] = [];
  const add = (message: string): void => void refusals.push(message);

  if (!isRecord(block)) {
    add("curve setup must be an object with id, label, baseCurve, interpolation, dayCount, compounding and inputs");
    return { ok: false, refusals };
  }

  for (const k of Object.keys(block)) {
    if (!(BLOCK_KEYS as readonly string[]).includes(k)) {
      add(`unknown field ${JSON.stringify(k)}; a curve setup carries id, label, baseCurve, interpolation, dayCount, compounding and inputs`);
    }
  }
  for (const k of ["id", "label", "baseCurve"] as const) {
    if (!isNonEmptyString(block[k])) add(`${k} must be a non-empty string`);
  }
  const menu = <T extends string>(field: string, allowed: readonly T[], v: unknown): void => {
    if (!isMenu(allowed, v)) add(`${field} must be one of ${allowed.join(", ")}; got ${show(v)}`);
  };
  menu("interpolation", CURVE_INTERPOLATIONS, block.interpolation);
  menu("dayCount", CURVE_DAY_COUNTS, block.dayCount);
  menu("compounding", CURVE_COMPOUNDINGS, block.compounding);
  const compounding = isMenu(CURVE_COMPOUNDINGS, block.compounding) ? block.compounding : undefined;

  const rows = block.inputs;
  if (!Array.isArray(rows)) {
    add("inputs must be a list of rows");
    return { ok: false, refusals };
  }
  if (rows.length === 0) add("setup holds 0 rows; at least one is needed");
  if (rows.length > MAX_CURVE_INPUTS) add(`setup holds ${rows.length} rows; the limit is ${MAX_CURVE_INPUTS}`);

  /** Node tenor to the first row that set it: its 1-based number, own tenorMonths and instrument. */
  const seenNodes = new Map<number, { n: number; tenor: number; futures: boolean }>();
  const describe = (tenor: number, futures: boolean): string =>
    futures ? `futures starting at ${tenor} months` : `tenor ${tenor} months`;
  rows.forEach((row: unknown, i) => {
    const n = i + 1;
    if (!isRecord(row)) {
      add(`row ${n} is not a row; expected instrument, tenorMonths, quoteType and value`);
      return;
    }
    for (const k of Object.keys(row)) {
      if (!(ROW_KEYS as readonly string[]).includes(k)) {
        add(`row ${n} unknown field ${JSON.stringify(k)}; a row carries instrument, tenorMonths, quoteType, value and convexityBp`);
      }
    }

    const instrumentOk = isMenu(CURVE_INSTRUMENTS, row.instrument);
    if (!instrumentOk) add(`row ${n} instrument must be one of ${CURVE_INSTRUMENTS.join(", ")}; got ${show(row.instrument)}`);
    const isFutures = row.instrument === "futures";

    const t = row.tenorMonths;
    const tenorOk = typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= MAX_TENOR_MONTHS;
    if (!tenorOk) add(`row ${n} tenor must be a whole number of months from 1 to ${MAX_TENOR_MONTHS}`);

    const quoteTypeOk = isMenu(CURVE_QUOTE_TYPES, row.quoteType);
    if (!quoteTypeOk) {
      add(`row ${n} quoteType must be one of ${CURVE_QUOTE_TYPES.join(", ")}; got ${show(row.quoteType)}`);
    } else if (isFutures && row.quoteType !== "par-rate") {
      add(`row ${n} quoteType must read par-rate on a futures row; got ${show(row.quoteType)}`);
    }

    const v = row.value;
    if (!isFiniteNumber(v)) {
      add(`row ${n} value is not a finite number`);
    } else if (isFutures) {
      if (!(v > MIN_FUTURES_PRICE && v < MAX_FUTURES_PRICE)) {
        add(`row ${n} value ${v} is outside (${MIN_FUTURES_PRICE}, ${MAX_FUTURES_PRICE}); a futures row carries the price, for example 95.8`);
      }
    } else if (instrumentOk && quoteTypeOk) {
      if (row.quoteType === "discount-factor") {
        if (!(v > 0 && v <= MAX_DISCOUNT_FACTOR)) {
          add(`row ${n} value ${v} is outside (0, ${MAX_DISCOUNT_FACTOR}]; a discount-factor row carries the factor itself`);
        }
      } else if (Math.abs(v) > MAX_ABS_RATE) {
        add(`row ${n} value ${v} is above 1.0 in magnitude; a rate is a decimal, so 0.04 is 4 percent`);
      }
    }

    if (row.convexityBp !== undefined) {
      if (instrumentOk && !isFutures) {
        add(`row ${n} convexityBp applies to futures rows only`);
      } else if (!isFiniteNumber(row.convexityBp) || Math.abs(row.convexityBp) > MAX_ABS_CONVEXITY_BP) {
        add(`row ${n} convexityBp must be a finite number of basis points within ${MAX_ABS_CONVEXITY_BP} either way; got ${show(row.convexityBp)}`);
      }
    }

    const parRow = instrumentOk && !isFutures && row.quoteType === "par-rate";
    if (parRow && compounding === "continuous") {
      add(`row ${n} is a par rate; continuous compounding has no coupon schedule. Use annual or semi-annual.`);
    }
    if (parRow && tenorOk && t > 12) {
      if (compounding === "annual" && t % 12 !== 0) {
        add(`row ${n} tenor ${t} months is not a whole number of years; an annual par row above 12 months needs one`);
      }
      if (compounding === "semi-annual" && t % 6 !== 0) {
        add(`row ${n} tenor ${t} months is not a multiple of 6 months; a semi-annual par row above 12 months needs one`);
      }
    }

    if (tenorOk && isFutures && t > MAX_FUTURES_START_MONTHS) {
      add(
        `row ${n} futures start ${t} months leaves no room for a ${FUTURES_PERIOD_MONTHS}-month period; the latest start is ${MAX_FUTURES_START_MONTHS}`,
      );
    } else if (tenorOk) {
      const node = isFutures ? t + FUTURES_PERIOD_MONTHS : t;
      const prior = seenNodes.get(node);
      if (prior === undefined) {
        seenNodes.set(node, { n, tenor: t, futures: isFutures });
      } else if (!isFutures && !prior.futures) {
        add(`row ${n} repeats tenor ${t} months`);
      } else {
        add(
          `row ${n} (${describe(t, isFutures)}) ends at ${node} months, the same node as row ${prior.n} (${describe(prior.tenor, prior.futures)})`,
        );
      }
    }
  });

  if (refusals.length > 0) return { ok: false, refusals };

  const inputs: CurveInput[] = (rows as Record<string, unknown>[])
    .map((r): CurveInput => ({
      instrument: r.instrument as CurveInstrument,
      tenorMonths: r.tenorMonths as number,
      quoteType: r.quoteType as CurveQuoteType,
      value: r.value as number,
      ...(r.convexityBp !== undefined ? { convexityBp: r.convexityBp as number } : {}),
    }))
    .sort((a, b) => nodeTenorMonths(a) - nodeTenorMonths(b));

  return {
    ok: true,
    block: {
      id: block.id as string,
      label: block.label as string,
      baseCurve: block.baseCurve as string,
      interpolation: block.interpolation as CurveInterpolation,
      dayCount: block.dayCount as CurveDayCount,
      compounding: block.compounding as CurveCompounding,
      inputs,
    },
  };
}
