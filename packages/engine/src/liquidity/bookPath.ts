/**
 * The book-path liquidity stress: a stated or built severe path, read against a buffer.
 * It is a second, separate question from the stress ladder (stressLadder.ts). The ladder
 * builds its path from the book's positions and the stress table; this module takes the path as given, or builds it
 * from a few stated legs, and reads no book, market or run.
 *
 * Two sources:
 *
 *   stated   a cumulative net funding path at stated points (a day count or a month), a shortfall negative.
 *   built    the path from its legs, month by month: a deposit book running off at one
 *            constant monthly rate, a wholesale book leaving on a stated cumulative timing, and a cumulative
 *            counterbalancing inflow. The deposit rate is the stable-share split,
 *            rate = s x stableRate + (1 - s) x nonStableRate, formed on the initial shares and compounded on the
 *            whole book: deposit outflow by month m = balance x (1 - (1 - rate)^m). The shares are not updated as
 *            balances leave.
 *
 * Two optional overlays, each off when absent:
 *
 *   draw     a stressed commitment draw: amount x cumulativeShare[i] is added to the
 *            shortfall at point i. The share vector is the phasing rule, one cumulative share per point.
 *   haircut  on the received facilities only (`buffer.receivedHaircut`); HQLA is never haircut here, because the
 *            HQLA figure is already a liquidity value.
 *
 * What it reports, per point: the cumulative net funding after the draw, the net position (buffer plus the
 * cumulative, which is negative in a shortfall) and the coverage ratio CR(h) = buffer / net cumulative outflow
 * (null where the cumulative is not an outflow). Over the path: the first crossing of the
 * buffer by linear interpolation between the points, starting at month 0 with nothing used (`survivalMonths`,
 * the stress ladder's rule), the full months survived (the crossing floored), the peak
 * shortfall and its point, the term-funding need (peak shortfall less buffer, never below zero) and the first-week
 * point (a day 1-7 bucket), when the path has one.
 *
 * Units: dollars and decimals; a month is 365/12 days when a point is given in days. Pure and deterministic.
 */
import { survivalMonths } from "./stressLadder";

/** Days in a month when a point is stated in days. */
export const DAYS_PER_MONTH = 365 / 12;

export interface BookPathPoint {
  label: string;
  /** Months after the as-of date. Give this or `days`, not both. */
  month?: number;
  /** Days after the as-of date. Give this or `month`, not both. */
  days?: number;
  /** Cumulative net funding at the point, dollars; a shortfall is negative. */
  cumulative: number;
}

export interface BookPathBuffer {
  hqla: number;
  /** Committed facilities the bank has received (its own borrowing capacity), dollars. */
  receivedFacilities: number;
  /** The share of the received facilities not counted in the stress, a decimal in [0, 1]. */
  receivedHaircut: number;
}

export interface BookPathBuilt {
  kind: "built";
  /** Months 1..H. */
  horizonMonths: number;
  /** Cumulative counterbalancing inflow at the end of each month 1..H, dollars. */
  inflowCumulative: number[];
  deposits: {
    balance: number;
    stableShare: number;
    /** Monthly runoff of the stable share, a decimal. */
    stableRateMonthly: number;
    /** Monthly runoff of the non-stable share, a decimal. */
    nonStableRateMonthly: number;
  };
  wholesale: {
    balance: number;
    /** Cumulative share of the wholesale book gone by the end of each month 1..H, decimals. */
    cumulativeShare: number[];
  };
}

export type BookPathSource = { kind: "stated"; points: BookPathPoint[] } | BookPathBuilt;

export interface BookPathDraw {
  /** The stressed draw, dollars (the unexpected component, (U99 - Ubar) x face). */
  amount: number;
  /** Cumulative share of the draw taken by each point of the path (each month of a built path). */
  cumulativeShare: number[];
}

export interface BookPathInput {
  source: BookPathSource;
  buffer: BookPathBuffer;
  draw?: BookPathDraw;
}

export interface BookPathRow {
  label: string;
  /** The point's time in months (a day count divided by 365/12). */
  month: number;
  /** The stated day count, when the point was given in days. */
  days?: number;
  /** The path before the draw. */
  pathCumulative: number;
  /** Cumulative draw by this point; 0 without a draw. */
  draw: number;
  /** The path after the draw: pathCumulative - draw. */
  cumulative: number;
  /** buffer + cumulative. */
  netPosition: number;
  /** buffer / -cumulative; null when the cumulative is not an outflow. */
  coverageRatio: number | null;
}

export interface BookPathBuiltLegs {
  /** The constant whole-book deposit rate the split forms, monthly. */
  depositRateMonthly: number;
  /** Cumulative outflow by month, dollars, positive. */
  depositOutflow: number[];
  wholesaleOutflow: number[];
  grossOutflow: number[];
  inflow: number[];
}

export interface BookPathResult {
  /** The buffer the stress reads: hqla + receivedFacilities x (1 - receivedHaircut). */
  buffer: number;
  /** The received facilities after the haircut. */
  receivedCounted: number;
  rows: BookPathRow[];
  /** First crossing of the buffer, months, interpolated; null when the buffer is never used up on the path. */
  crossingMonth: number | null;
  /** floor(crossingMonth); null with it. */
  fullMonthsSurvived: number | null;
  /** The most negative cumulative on the path (0 when nothing flows out). */
  peakShortfall: number;
  /** The point of the peak; null when nothing flows out. */
  peakLabel: string | null;
  peakMonth: number | null;
  /** max(0, -peakShortfall - buffer): what the buffer does not cover at the peak. */
  termFundingNeed: number;
  /** The day 1-7 bucket: the first point stated at seven days or fewer; null when the path has none. */
  firstWeek: BookPathRow | null;
  /** A built path's legs. */
  built?: BookPathBuiltLegs;
}

function shown(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : typeof v === "string" ? JSON.stringify(v) : String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const decimal = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;

function decimalsError(v: unknown, path: string, length: number, what: string): string | undefined {
  if (!Array.isArray(v) || v.length !== length) {
    return `${path} must list ${length} ${what}, one per ${what === "shares" ? "point" : "month"}, got ${shown(v)}`;
  }
  for (let i = 0; i < v.length; i++) {
    if (!decimal(v[i])) return `${path}[${i}] must be a decimal in [0, 1], got ${shown(v[i])}`;
    if (i > 0 && (v[i] as number) < (v[i - 1] as number)) {
      return `${path}[${i}] is ${shown(v[i])}, below the ${shown(v[i - 1])} before it; a cumulative share never falls`;
    }
  }
  return undefined;
}

/** The first problem with a book-path input, as a plain sentence naming the field; undefined when it is well formed. */
export function bookPathConfigError(value: unknown, path = "book path"): string | undefined {
  if (!isRecord(value)) return `${path} must be an object { source, buffer, draw? }, got ${shown(value)}`;
  const buffer = value.buffer;
  if (!isRecord(buffer)) return `${path}.buffer must be an object { hqla, receivedFacilities, receivedHaircut }, got ${shown(buffer)}`;
  for (const key of ["hqla", "receivedFacilities"] as const) {
    if (!finite(buffer[key]) || (buffer[key] as number) < 0) return `${path}.buffer.${key} must be a finite number >= 0, got ${shown(buffer[key])}`;
  }
  if (!decimal(buffer.receivedHaircut)) return `${path}.buffer.receivedHaircut must be a decimal in [0, 1], got ${shown(buffer.receivedHaircut)}`;

  const source = value.source;
  if (!isRecord(source)) return `${path}.source must be an object with kind "stated" or "built", got ${shown(source)}`;
  let steps: number;
  if (source.kind === "stated") {
    const points = source.points;
    if (!Array.isArray(points) || points.length === 0) return `${path}.source.points must list at least one point, got ${shown(points)}`;
    let prev = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as unknown;
      const at = `${path}.source.points[${i}]`;
      if (!isRecord(p)) return `${at} must be an object { label, month or days, cumulative }, got ${shown(p)}`;
      if (typeof p.label !== "string" || p.label === "") return `${at}.label must be a non-empty string, got ${shown(p.label)}`;
      if ((p.month === undefined) === (p.days === undefined)) return `${at} must give month or days, exactly one`;
      const t = p.month !== undefined ? p.month : p.days;
      if (!finite(t) || t <= 0) return `${at}.${p.month !== undefined ? "month" : "days"} must be a number above 0, got ${shown(t)}`;
      const month = p.month !== undefined ? (p.month as number) : (p.days as number) / DAYS_PER_MONTH;
      if (month <= prev) return `${at} comes at month ${shown(month)}, not after the point before it; list the points in time order`;
      prev = month;
      if (!finite(p.cumulative)) return `${at}.cumulative must be a finite number of dollars, got ${shown(p.cumulative)}`;
    }
    steps = points.length;
  } else if (source.kind === "built") {
    const h = source.horizonMonths;
    if (!Number.isInteger(h) || (h as number) < 1 || (h as number) > 360) {
      return `${path}.source.horizonMonths must be a whole number of months from 1 to 360, got ${shown(h)}`;
    }
    steps = h as number;
    const inflow = source.inflowCumulative;
    if (!Array.isArray(inflow) || inflow.length !== steps) {
      return `${path}.source.inflowCumulative must list ${steps} cumulative inflows, one per month, got ${shown(inflow)}`;
    }
    for (let i = 0; i < inflow.length; i++) {
      if (!finite(inflow[i])) return `${path}.source.inflowCumulative[${i}] must be a finite number of dollars, got ${shown(inflow[i])}`;
    }
    const d = source.deposits;
    if (!isRecord(d)) return `${path}.source.deposits must be an object { balance, stableShare, stableRateMonthly, nonStableRateMonthly }, got ${shown(d)}`;
    if (!finite(d.balance) || (d.balance as number) < 0) return `${path}.source.deposits.balance must be a finite number >= 0, got ${shown(d.balance)}`;
    for (const key of ["stableShare", "stableRateMonthly", "nonStableRateMonthly"] as const) {
      if (!decimal(d[key])) return `${path}.source.deposits.${key} must be a decimal in [0, 1], got ${shown(d[key])}`;
    }
    const w = source.wholesale;
    if (!isRecord(w)) return `${path}.source.wholesale must be an object { balance, cumulativeShare }, got ${shown(w)}`;
    if (!finite(w.balance) || (w.balance as number) < 0) return `${path}.source.wholesale.balance must be a finite number >= 0, got ${shown(w.balance)}`;
    const shareError = decimalsError(w.cumulativeShare, `${path}.source.wholesale.cumulativeShare`, steps, "months");
    if (shareError !== undefined) return shareError;
  } else {
    return `${path}.source.kind must be "stated" or "built", got ${shown(source.kind)}`;
  }

  if (value.draw !== undefined) {
    const draw = value.draw;
    if (!isRecord(draw)) return `${path}.draw must be an object { amount, cumulativeShare }, got ${shown(draw)}`;
    if (!finite(draw.amount) || (draw.amount as number) < 0) return `${path}.draw.amount must be a finite number >= 0, got ${shown(draw.amount)}`;
    const shareError = decimalsError(draw.cumulativeShare, `${path}.draw.cumulativeShare`, steps, "shares");
    if (shareError !== undefined) return shareError;
  }
  return undefined;
}

/** The constant whole-book monthly rate a stable-share split forms. */
export function blendedDepositRate(stableShare: number, stableRateMonthly: number, nonStableRateMonthly: number): number {
  return stableShare * stableRateMonthly + (1 - stableShare) * nonStableRateMonthly;
}

function builtPath(source: BookPathBuilt): { points: BookPathPoint[]; legs: BookPathBuiltLegs } {
  const d = source.deposits;
  const rate = blendedDepositRate(d.stableShare, d.stableRateMonthly, d.nonStableRateMonthly);
  const legs: BookPathBuiltLegs = { depositRateMonthly: rate, depositOutflow: [], wholesaleOutflow: [], grossOutflow: [], inflow: [] };
  const points: BookPathPoint[] = [];
  for (let m = 1; m <= source.horizonMonths; m++) {
    const deposit = d.balance * (1 - Math.pow(1 - rate, m));
    const wholesale = source.wholesale.balance * source.wholesale.cumulativeShare[m - 1]!;
    const gross = deposit + wholesale;
    const inflow = source.inflowCumulative[m - 1]!;
    legs.depositOutflow.push(deposit);
    legs.wholesaleOutflow.push(wholesale);
    legs.grossOutflow.push(gross);
    legs.inflow.push(inflow);
    points.push({ label: `Month ${m}`, month: m, cumulative: inflow - gross });
  }
  return { points, legs };
}

/** The book-path stress: rows, crossing, peak, term-funding need and the first week. Throws on an ill-formed input. */
export function computeBookPathLiquidity(input: BookPathInput): BookPathResult {
  const problem = bookPathConfigError(input);
  if (problem !== undefined) throw new Error(problem.replace(/^book path\./, "book path: "));

  const received = input.buffer.receivedFacilities * (1 - input.buffer.receivedHaircut);
  const buffer = input.buffer.hqla + received;
  const built = input.source.kind === "built" ? builtPath(input.source) : undefined;
  const points = built !== undefined ? built.points : (input.source as { points: BookPathPoint[] }).points;

  const rows: BookPathRow[] = points.map((p, i) => {
    const month = p.month !== undefined ? p.month : p.days! / DAYS_PER_MONTH;
    const draw = input.draw === undefined ? 0 : input.draw.amount * input.draw.cumulativeShare[i]!;
    const cumulative = p.cumulative - draw;
    const row: BookPathRow = {
      label: p.label,
      month,
      pathCumulative: p.cumulative,
      draw,
      cumulative,
      netPosition: buffer + cumulative,
      coverageRatio: cumulative < 0 ? buffer / -cumulative : null,
    };
    if (p.days !== undefined) row.days = p.days;
    return row;
  });

  const crossingMonth = survivalMonths(rows.map((r) => r.month), rows.map((r) => r.cumulative), buffer);
  let peak: BookPathRow | null = null;
  for (const r of rows) if (r.cumulative < 0 && (peak === null || r.cumulative < peak.cumulative)) peak = r;
  const peakShortfall = peak === null ? 0 : peak.cumulative;
  const result: BookPathResult = {
    buffer,
    receivedCounted: received,
    rows,
    crossingMonth,
    fullMonthsSurvived: crossingMonth === null ? null : Math.floor(crossingMonth),
    peakShortfall,
    peakLabel: peak === null ? null : peak.label,
    peakMonth: peak === null ? null : peak.month,
    termFundingNeed: Math.max(0, -peakShortfall - buffer),
    firstWeek: rows.find((r) => r.days !== undefined && r.days <= 7) ?? null,
  };
  if (built !== undefined) result.built = built.legs;
  return result;
}
