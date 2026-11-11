/**
 * The survival path: the stress ladder's monthly recursion carried past its 12 months on
 * the run's own balances, read against the ladder's buffer and, as a second reading, against the buffer plus one
 * received facility (the bank's own borrowing capacity, after its haircut).
 *
 * Per month m = 1..H, in the ladder's order (stressLadder.ts):
 *   hysOut = H x hysOutflowMonthly, H -= hysOut; nibOut the same on the non-interest-bearing pool
 *   wholesaleOut = maturing(m) x (1 - wholesaleRenewal)
 *   cdOut = maturity(m) x (1 - cdRenewal) + early(m), 0 when the row states no cdRenewal
 *   draws = undrawnFace x drawRate / 12 in months 1..12 and 0 after: the draw rate is a share drawn over a year
 *   net = inflow(m) - hysOut - nibOut - wholesaleOut - cdOut - draws; cumulative = running sum
 * So months 1..12 are the ladder's row exactly. Survival is the ladder's `survivalMonths` on months 1..H, and in days
 * months x 365 / 12. The peak is the most negative cumulative (0 when nothing flows out); the term-funding need is the
 * peak shortfall less the buffer, never below zero. The facility never enters the ladder's buffer.
 *
 * Pure and deterministic: dollars and decimals, plain ordered sums.
 */
import type {
  LiquidityStressParams,
  LiquidityStressScenario,
  SurvivalPathFacility,
  SurvivalPathLegs,
  SurvivalPathReading,
  SurvivalPathResult,
  SurvivalPathRow,
} from "../contracts/results";
import { DAYS_PER_MONTH } from "./bookPath";
import { LIQUIDITY_STRESS_HORIZON_MONTHS, LIQUIDITY_STRESS_ROWS, survivalMonths } from "./stressLadder";

export interface SurvivalPathInput {
  scenarioId: LiquidityStressScenario["id"];
  /** The row's rates: the ladder's own row, the severe draw rate already linked to the dials when they are set. */
  params: LiquidityStressParams;
  legs: SurvivalPathLegs;
  /** Months 1..H read, at most legs.horizonMonths. */
  horizonMonths: number;
  /** The ladder's buffer. */
  buffer: number;
  facility?: { label?: string; capacity: number; haircut: number };
}

/** The label a facility takes when its setup names none. */
export const DEFAULT_FACILITY_LABEL = "Received facility";

function reading(buffer: number, months: number[], cumulative: number[], peakShortfall: number): SurvivalPathReading {
  const crossing = survivalMonths(months, cumulative, buffer);
  return {
    buffer,
    survivalMonths: crossing,
    survivalDays: crossing === null ? null : crossing * DAYS_PER_MONTH,
    termFundingNeed: Math.max(0, -peakShortfall - buffer),
  };
}

/** The first problem with a survival-path input, in plain words; undefined when it is well formed. */
export function survivalPathInputError(input: SurvivalPathInput): string | undefined {
  const h = input.horizonMonths;
  const legs = input.legs;
  if (!Number.isInteger(h) || h < 1) return `survival path: the path runs a whole number of months from 1, got ${h}`;
  if (h > legs.horizonMonths) return `survival path: the run's balances reach ${legs.horizonMonths} months, so the path can run at most that long, not ${h}`;
  for (const key of ["inflow", "inflowStress", "wholesaleMaturities", "cdMaturities"] as const) {
    if (legs[key].length < h) return `survival path: legs.${key} holds ${legs[key].length} months, fewer than the ${h} the path runs`;
  }
  if (legs.cdEarlyWithdrawals !== undefined && legs.cdEarlyWithdrawals.length < h) return `survival path: legs.cdEarlyWithdrawals holds ${legs.cdEarlyWithdrawals.length} months, fewer than the ${h} the path runs`;
  if (!Number.isFinite(input.buffer) || input.buffer < 0) return `survival path: the buffer must be a finite number >= 0, got ${input.buffer}`;
  const f = input.facility;
  if (f !== undefined && (!Number.isFinite(f.capacity) || f.capacity < 0 || !Number.isFinite(f.haircut) || f.haircut < 0 || f.haircut > 1)) {
    return "survival path: a facility needs a capacity of dollars >= 0 and a haircut in [0, 1]";
  }
  return undefined;
}

/** The survival path on one row of the ladder. Throws on an ill-formed input. */
export function computeSurvivalPath(input: SurvivalPathInput): SurvivalPathResult {
  const problem = survivalPathInputError(input);
  if (problem !== undefined) throw new Error(problem);
  const { legs, params } = input;
  const h = input.horizonMonths;
  const inflow = LIQUIDITY_STRESS_ROWS.includes(input.scenarioId) ? legs.inflowStress : legs.inflow;
  const year = LIQUIDITY_STRESS_HORIZON_MONTHS;
  let hys = legs.pools.hys;
  let nib = legs.pools.nib;
  let cum = 0;
  const rows: SurvivalPathRow[] = [];
  for (let m = 0; m < h; m++) {
    const hysOut = hys * params.hysOutflowMonthly;
    const nibOut = nib * params.nibOutflowMonthly;
    hys -= hysOut;
    nib -= nibOut;
    const wholesaleOut = legs.wholesaleMaturities[m]! * (1 - params.wholesaleRenewal);
    const cdOut = params.cdRenewal !== undefined ? legs.cdMaturities[m]! * (1 - params.cdRenewal) + (legs.cdEarlyWithdrawals?.[m] ?? 0) : 0;
    const draws = m < year ? (legs.undrawnFace * params.drawRate) / year : 0;
    const net = inflow[m]! - hysOut - nibOut - wholesaleOut - cdOut - draws;
    cum += net;
    rows.push({ month: m + 1, days: (m + 1) * DAYS_PER_MONTH, inflow: inflow[m]!, hysOut, nibOut, wholesaleOut, cdOut, draws, net, cumulative: cum });
  }
  let peakShortfall = 0;
  let peakMonth: number | null = null;
  for (const r of rows) {
    if (r.cumulative < 0 && r.cumulative < peakShortfall) {
      peakShortfall = r.cumulative;
      peakMonth = r.month;
    }
  }
  const months = rows.map((r) => r.month);
  const cumulative = rows.map((r) => r.cumulative);
  const result: SurvivalPathResult = {
    scenarioId: input.scenarioId,
    horizonMonths: h,
    params: { ...params },
    legs: {
      horizonMonths: legs.horizonMonths,
      pools: { ...legs.pools },
      inflow: [...legs.inflow],
      inflowStress: [...legs.inflowStress],
      wholesaleMaturities: [...legs.wholesaleMaturities],
      cdMaturities: [...legs.cdMaturities],
      ...(legs.cdEarlyWithdrawals !== undefined ? { cdEarlyWithdrawals: [...legs.cdEarlyWithdrawals] } : {}),
      undrawnFace: legs.undrawnFace,
    },
    rows,
    peakShortfall,
    peakMonth,
    ladderBuffer: reading(input.buffer, months, cumulative, peakShortfall),
  };
  if (input.facility !== undefined) {
    const f = input.facility;
    const facility: SurvivalPathFacility = { label: f.label ?? DEFAULT_FACILITY_LABEL, capacity: f.capacity, haircut: f.haircut, counted: f.capacity * (1 - f.haircut) };
    result.facility = facility;
    result.withFacility = reading(input.buffer + facility.counted, months, cumulative, peakShortfall);
  }
  return result;
}
