/**
 * What one curve setup row says about discount factors.
 *
 * t = tenorMonths / 12 years, r = value, fix(dc) = 365/360 for ACT/360 and 1
 * for ACT/365. Day count reaches the fixed-leg accrual only; zero-rate and
 * discount-factor rows ignore it.
 *
 *   zero-rate, annual        DF(t) = (1 + r)^(-t)
 *   zero-rate, semi-annual   DF(t) = (1 + r/2)^(-2t)
 *   zero-rate, continuous    DF(t) = exp(-r t)
 *   discount-factor          DF(t) = r
 *   par, annual, cash, new method   DF(t) = 1 / (1 + r t fix(dc))
 *   par, annual, cash, linear-zero  DF(t) = 1 / (1 + r t)   (accrues on t years)
 *   par, annual, t <= 1, not cash   DF(t) = 1 / (1 + r t)
 *   par, annual, t > 1, not cash    1 - DF(t) = r fix(dc) sum_{k=1..t} DF(k)
 *   par, semi-annual, t < 0.5       DF(t) = (1 + r/2)^(-2t)
 *   par, semi-annual, 0.5 <= t < 1  DF(t) = 1 / (1 + r/2)
 *   par, semi-annual, t >= 1        1 - DF(t) = (r/2) fix(dc) sum_{k=1..2t} DF(k/2)
 *   futures, start s = tenorMonths / 12, price P, convexity c bp
 *                                   F = (100 - P)/100 - c/1e4
 *                                   DF(s + 0.25) = DF(s) / (1 + F 0.25 fix(dc))
 *
 * A new method is log-linear-df, cubic-zero or monotone-convex (spec v7
 * decisions 60 and 71): only the annual direct cash row reads the day count
 * under one. Linear-zero keeps the kernel's accrual on t years, and so does a
 * convention object that names no interpolation. Par rows of one year or less
 * that are not cash, semi-annual direct rows and futures rows are unchanged.
 *
 * Under semi-annual compounding the tenor alone selects the par treatment and
 * the instrument label is ignored, as the kernel's Treasury convention does.
 * A futures row ignores compounding; its node sits at s + 3 months (its node
 * tenor), and DF(s) is read off the interpolator, so the row is solved like a
 * par row rather than written directly.
 */
import type { CurveDayCount, CurveInput, CurveSetupBlock } from "../contracts/curveSetup";

/** Boundary slack on tenor tests, the kernel's own. */
const EPS = 1e-9;

/** A futures row prices one 3-month period from its start. */
export const FUTURES_PERIOD_MONTHS = 3;

/** The tenor, in months, of the node a row fixes: a futures row's start plus 3 months, else its tenorMonths. */
export const nodeTenorMonths = (row: Pick<CurveInput, "instrument" | "tenorMonths">): number =>
  row.instrument === "futures" ? row.tenorMonths + FUTURES_PERIOD_MONTHS : row.tenorMonths;

/** A row's conventions; interpolation, when present, selects the annual cash accrual. */
export type RowConventions = Pick<CurveSetupBlock, "dayCount" | "compounding"> &
  Partial<Pick<CurveSetupBlock, "interpolation">>;

/** How a row fixes its node: a direct discount factor, a par equation, or a futures period to solve. */
export type RowEquation =
  | { readonly kind: "direct"; readonly df: number }
  | { readonly kind: "par"; readonly couponDates: readonly number[]; readonly accrual: number }
  | { readonly kind: "futures"; readonly start: number; readonly forward: number; readonly accrual: number };

/** Thrown (by the solver) and raised here for a row that cannot be priced. */
export class RowRefusal extends Error {}

export const fixedLegFraction = (dc: CurveDayCount): number => (dc === "ACT/360" ? 365 / 360 : 1);

/** The annual direct cash row's fraction: fix(dc) under a new method, 1 under linear-zero or no interpolation. */
const annualCashFraction = (conv: RowConventions): number =>
  conv.interpolation !== undefined && conv.interpolation !== "linear-zero" ? fixedLegFraction(conv.dayCount) : 1;

export const rowName = (row: CurveInput): string =>
  `the ${row.quoteType} ${row.instrument} row at ${row.tenorMonths} months`;

function schedule(t: number, perYear: number, row: CurveInput): number[] {
  const n = Math.round(t * perYear);
  if (Math.abs(n - t * perYear) > 1e-6) {
    throw new RowRefusal(
      `${rowName(row)} is not a whole number of ${perYear === 1 ? "years" : "half-years"}; its coupon schedule cannot be laid out`,
    );
  }
  const dates: number[] = [];
  for (let k = 1; k <= n; k++) dates.push(k / perYear);
  return dates;
}

/** Classify a row by the equation table. Throws RowRefusal for a row with no equation. */
export function rowEquation(row: CurveInput, conv: RowConventions): RowEquation {
  if (row.instrument === "futures") {
    return {
      kind: "futures",
      start: row.tenorMonths / 12,
      forward: (100 - row.value) / 100 - (row.convexityBp ?? 0) / 1e4,
      accrual: (FUTURES_PERIOD_MONTHS / 12) * fixedLegFraction(conv.dayCount),
    };
  }
  const t = row.tenorMonths / 12;
  const r = row.value;
  if (row.quoteType === "discount-factor") return { kind: "direct", df: r };
  if (row.quoteType === "zero-rate") {
    if (conv.compounding === "annual") return { kind: "direct", df: (1 + r) ** -t };
    if (conv.compounding === "semi-annual") return { kind: "direct", df: (1 + r / 2) ** (-2 * t) };
    return { kind: "direct", df: Math.exp(-r * t) };
  }
  const fix = fixedLegFraction(conv.dayCount);
  if (conv.compounding === "annual") {
    if (row.instrument === "cash") return { kind: "direct", df: 1 / (1 + r * t * annualCashFraction(conv)) };
    if (t <= 1 + EPS) return { kind: "direct", df: 1 / (1 + r * t) };
    return { kind: "par", couponDates: schedule(t, 1, row), accrual: fix };
  }
  if (conv.compounding === "semi-annual") {
    if (t < 0.5 - EPS) return { kind: "direct", df: (1 + r / 2) ** (-2 * t) };
    if (t < 1 - EPS) return { kind: "direct", df: 1 / (1 + r / 2) };
    return { kind: "par", couponDates: schedule(t, 2, row), accrual: 0.5 * fix };
  }
  throw new RowRefusal(`${rowName(row)} is a par rate; continuous compounding has no coupon schedule`);
}

/** The discount factor a direct row writes at its own tenor, or null when the row needs a root find. */
export function rowTargetDf(row: CurveInput, conv: RowConventions): number | null {
  const eq = rowEquation(row, conv);
  return eq.kind === "direct" ? eq.df : null;
}

/**
 * Residual of a row against a discount function, zero at the solved node, t
 * the row's node tenor in years. A direct row: its target discount factor less
 * df(t). A par row: (1 - DF(t)) minus the fixed-leg PV. A futures row:
 * DF(t) (1 + F accrual) less DF(start).
 */
export function rowResidual(row: CurveInput, conv: RowConventions, df: (u: number) => number): number {
  const t = nodeTenorMonths(row) / 12;
  const eq = rowEquation(row, conv);
  if (eq.kind === "direct") return eq.df - df(t);
  if (eq.kind === "futures") return futuresResidual(eq, t, df);
  return parResidual(eq, row.value, t, df);
}

/** The par residual for an already classified row; the solver's inner loop. */
export function parResidual(
  eq: Extract<RowEquation, { kind: "par" }>,
  rate: number,
  t: number,
  df: (u: number) => number,
): number {
  let pvFixed = 0;
  for (const c of eq.couponDates) pvFixed += rate * eq.accrual * df(c);
  return 1 - df(t) - pvFixed;
}

/** The futures residual for an already classified row, t its node tenor: DF(t) (1 + F accrual) - DF(start). */
export function futuresResidual(
  eq: Extract<RowEquation, { kind: "futures" }>,
  t: number,
  df: (u: number) => number,
): number {
  return df(t) * (1 + eq.forward * eq.accrual) - df(eq.start);
}
