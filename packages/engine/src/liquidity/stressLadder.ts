/**
 * The liquidity stress ladder:
 * a monthly net funding ladder under three stress scenarios and the survival
 * horizon against a stated buffer.
 *
 * What enters, read from each position's `liquidityRole` dimension and nothing
 * else:
 *
 *   inflow-asset   principal received in months 1..H on the base path
 *   wholesale      principal maturing in months 1..H, each maturing once;
 *                  outflow = maturity x (1 - renewal)
 *   hys-pool       notional summed into the pooled HYS base (which deposits
 *                  sit in a pool is the book's own tag)
 *   nib-pool       notional summed into the non-interest-bearing base
 *   term-deposit Studio slice S3d-1: principal paid out in months
 *                  1..H on the base path; outflow = maturity x (1 - cdRenewal)
 *                  + early withdrawals (S3d fix round: the renewal share rolls
 *                  contractual maturities only), on a row that states
 *                  cdRenewal; a row without it reads none
 *
 * Any other role (hqla-stock, undrawn-commitment) or none enters nothing: the
 * buffer and the undrawn face are stated constants of the setup.
 *
 * When the setup states no buffer, the buffer is read from the
 * hqla-stock positions instead: each position's face times one less its
 * `hqla-level` haircut (level 1 none, 2A 15 percent, 2B 50 percent), summed
 * in book order; a position with no known level is listed and not counted.
 * When the setup sets the commitment dials, the severe row draws their
 * requirement, (U99 - Ubar) x face, spread evenly over the horizon as before;
 * the undrawn face is the amount undrawn now, U, and face = U / (1 - Ubar)
 * (S3d fix round, ruling 2026-11-05), so the rate on U is
 * (U99 - Ubar) / (1 - Ubar).
 *
 * Two inflow lines. The
 * bau row reads the base-path principal. The moderate and severe rows read
 * the stress line: an inflow-asset position with an entry in
 * `stressPrincipalByPosition` (a constant-CPR fixed loan whose binding names a
 * stress speed) contributes that series, every other position its base one.
 * With no stress entries the two lines are the same sums in the same order,
 * so the ladder is the one-line ladder exactly.
 *
 * Per scenario and month m = 1..H, in this order:
 *   hysOut = H x hysOutflowMonthly, H -= hysOut; nibOut the same on the NIB pool
 *   wholesaleOut = maturing(m) x (1 - wholesaleRenewal)
 *   cdOut = maturity(m) x (1 - cdRenewal) + early(m), 0 on a row without cdRenewal
 *   draws = undrawnFace x drawRate / H
 *   net = inflow(m) - hysOut - nibOut - wholesaleOut - cdOut - draws; cumulative = running sum
 * survival: `survivalMonths` on months 1..H; peak shortfall: the minimum of the
 * cumulative series and its first month (a min and an argmin, so a ladder
 * that never goes negative reports its smallest positive month).
 *
 * Units: dollars and decimals. Deterministic: positions in book order, plain
 * ordered sums, no clock, no RNG; every series is an ordinary number array.
 */
import type { PortfolioSpec, Position } from "../contracts/position";
import type {
  LiquidityBufferDerivation,
  LiquidityLadderDials,
  LiquidityStressOptions,
  LiquidityStressParams,
  LiquidityStressResult,
  LiquidityStressScenario,
  LiquidityStressTable,
} from "../contracts/results";
import { HQLA_DIMENSION, HQLA_HAIRCUT } from "../report/hqlaBuffer";
import { commitmentDialsError, computeCommitmentDials, type CommitmentDials } from "./commitmentDials";

/** S3d fix round: the dials a ladder ran, its undrawn face read as the amount undrawn now. */
export function ladderDialsOf(dials: LiquidityLadderDials, undrawnFace: number): CommitmentDials {
  return {
    undrawn: undrawnFace,
    expectedUtilization: dials.expectedUtilization,
    tailUtilization: dials.tailUtilization,
    fundingSpreadBp: dials.fundingSpreadBp,
    lcrFactor: dials.lcrFactor,
    thirtyDayShare: dials.thirtyDayShare,
    ...(dials.delayedDraws !== undefined ? { delayedDraws: dials.delayedDraws.map((x) => ({ month: x.month, amount: x.amount })) } : {}),
  };
}

/** The six roles the ladder reads, as a book's liquidityRole dimension declares them. */
export const LIQUIDITY_ROLES = ["inflow-asset", "hqla-stock", "hys-pool", "nib-pool", "wholesale", "term-deposit"] as const;
export type LiquidityRole = (typeof LIQUIDITY_ROLES)[number];

/** The ladder's horizon in months. */
export const LIQUIDITY_STRESS_HORIZON_MONTHS = 12;

/** The survival path's length in months, from the ladder's 12 to ten years. */
export const SURVIVAL_PATH_MIN_MONTHS = 12;
export const SURVIVAL_PATH_MAX_MONTHS = 120;

export interface LiquidityStressInput {
  /** The overlaid base book. */
  book: PortfolioSpec;
  /**
   * Principal paid per position on the base path, entry i = month i + 1.
   * Read only for inflow-asset, wholesale and term-deposit positions; a missing
   * entry or a series shorter than the horizon reads zero beyond its end.
   */
  principalByPosition: Map<string, number[]>;
  /**
   * S3d fix round: a term-deposit position's early withdrawals by month; its entry in `principalByPosition` is then
   * its maturities only. Absent, or no entry, reads none.
   */
  earlyByPosition?: Map<string, number[]>;
  /**
   * Principal per inflow-asset position at its liquidity stress
   * speed, read by the moderate and severe rows. Absent, or no entry for a
   * position, reads that position's base series.
   */
  stressPrincipalByPosition?: Map<string, number[]>;
  table: LiquidityStressTable;
  /** Absent, the buffer is read from the hqla-stock positions. */
  buffer?: number;
  undrawnFace: number;
  /** Set, the severe row draws the dials' requirement (S3d fix round: the undrawn face is U). */
  dials?: LiquidityLadderDials;
  horizonMonths: number;
}

const SCENARIO_IDS = ["bau", "moderate", "severe"] as const;
/** The rows that read the stress inflow line. */
export const LIQUIDITY_STRESS_ROWS: ReadonlyArray<LiquidityStressScenario["id"]> = ["moderate", "severe"];
const PARAM_KEYS = ["hysOutflowMonthly", "wholesaleRenewal", "nibOutflowMonthly", "drawRate"] as const;

function shown(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const finiteAtLeastZero = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The first problem with a `{ table, buffer, undrawnFace }` opt-in, as a plain
 * sentence naming the field under `path`; undefined when it is well formed.
 * Rates are decimals in [0, 1]; the buffer and the undrawn face are finite
 * dollar amounts >= 0. The buffer may be left out; `dials` and
 * `survivalPath` are checked when present.
 */
export function liquidityStressConfigError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object { table, buffer, undrawnFace }, got ${shown(value)}`;
  const tableError = liquidityStressTableError(value.table, `${path}.table`);
  if (tableError !== undefined) return tableError;
  for (const key of ["buffer", "undrawnFace"] as const) {
    const v = value[key];
    if (key === "buffer" && v === undefined) continue;
    if (!finiteAtLeastZero(v)) {
      return `${path}.${key} must be a finite number >= 0, got ${shown(v)}`;
    }
  }
  if (value.dials !== undefined) {
    const d = value.dials;
    if (isRecord(d) && (d.face !== undefined || d.undrawn !== undefined)) {
      return `${path}.dials read the undrawn face as the amount undrawn now, so they take no face and no undrawn of their own; leave both out`;
    }
    if ((value.undrawnFace as number) <= 0) return `${path}.undrawnFace must be above 0 when the dials are set: the dials read it as the amount undrawn now`;
    const problem = commitmentDialsError(isRecord(d) ? { ...d, undrawn: value.undrawnFace } : d, `${path}.dials`);
    if (problem !== undefined) return problem;
  }
  if (value.survivalPath !== undefined) return survivalPathOptionsError(value.survivalPath, `${path}.survivalPath`);
  return undefined;
}

function survivalPathOptionsError(sp: unknown, path: string): string | undefined {
  if (!isRecord(sp)) return `${path} must be an object { horizonMonths, facility? }, got ${shown(sp)}`;
  const h = sp.horizonMonths;
  if (!Number.isInteger(h) || (h as number) < SURVIVAL_PATH_MIN_MONTHS || (h as number) > SURVIVAL_PATH_MAX_MONTHS) {
    return `${path}.horizonMonths must be a whole number of months from ${SURVIVAL_PATH_MIN_MONTHS} to ${SURVIVAL_PATH_MAX_MONTHS}, got ${shown(h)}`;
  }
  if (sp.facility === undefined) return undefined;
  const f = sp.facility;
  if (!isRecord(f)) return `${path}.facility must be an object { label?, capacity, haircut }, got ${shown(f)}`;
  if (f.label !== undefined && (typeof f.label !== "string" || f.label.trim() === "")) return `${path}.facility.label must be a non-empty string when given, got ${shown(f.label)}`;
  if (!finiteAtLeastZero(f.capacity)) return `${path}.facility.capacity must be a finite number of dollars >= 0, got ${shown(f.capacity)}`;
  if (typeof f.haircut !== "number" || !Number.isFinite(f.haircut) || f.haircut < 0 || f.haircut > 1) {
    return `${path}.facility.haircut must be a decimal in [0, 1], got ${shown(f.haircut)}`;
  }
  return undefined;
}

function liquidityStressTableError(table: unknown, path: string): string | undefined {
  if (!isRecord(table)) return `${path} must be an object { bau, moderate, severe }, got ${shown(table)}`;
  for (const id of SCENARIO_IDS) {
    const row = table[id];
    if (!isRecord(row)) {
      return `${path}.${id} must be an object { ${PARAM_KEYS.join(", ")} }, got ${shown(row)}`;
    }
    for (const key of PARAM_KEYS) {
      const v = row[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        return `${path}.${id}.${key} must be a decimal in [0, 1], got ${shown(v)}`;
      }
    }
    const cd = row.cdRenewal;
    if (cd !== undefined && (typeof cd !== "number" || !Number.isFinite(cd) || cd < 0 || cd > 1)) {
      return `${path}.${id}.cdRenewal must be a decimal in [0, 1] when given, got ${shown(cd)}`;
    }
  }
  return undefined;
}

/**
 * The stored copy of a well-formed opt-in: the known fields only, in a fixed order, so an extra key never
 * reaches a stored request or setup and two equal submissions store equal bytes. A 1.9.0 opt-in comes back with the
 * keys it had, in the order it had them.
 */
export function liquidityStressOptionsOf(raw: unknown): LiquidityStressOptions {
  const v = raw as LiquidityStressOptions;
  const row = (p: LiquidityStressParams): LiquidityStressParams => ({
    hysOutflowMonthly: p.hysOutflowMonthly,
    wholesaleRenewal: p.wholesaleRenewal,
    nibOutflowMonthly: p.nibOutflowMonthly,
    drawRate: p.drawRate,
    ...(p.cdRenewal !== undefined ? { cdRenewal: p.cdRenewal } : {}),
  });
  const d = v.dials;
  const sp = v.survivalPath;
  return {
    table: { bau: row(v.table.bau), moderate: row(v.table.moderate), severe: row(v.table.severe) },
    ...(v.buffer !== undefined ? { buffer: v.buffer } : {}),
    undrawnFace: v.undrawnFace,
    ...(d !== undefined
      ? {
          dials: {
            expectedUtilization: d.expectedUtilization,
            tailUtilization: d.tailUtilization,
            fundingSpreadBp: d.fundingSpreadBp,
            lcrFactor: d.lcrFactor,
            thirtyDayShare: d.thirtyDayShare,
            ...(d.delayedDraws !== undefined ? { delayedDraws: d.delayedDraws.map((x) => ({ month: x.month, amount: x.amount })) } : {}),
          },
        }
      : {}),
    ...(sp !== undefined
      ? {
          survivalPath: {
            horizonMonths: sp.horizonMonths,
            ...(sp.facility !== undefined
              ? { facility: { ...(sp.facility.label !== undefined ? { label: sp.facility.label } : {}), capacity: sp.facility.capacity, haircut: sp.facility.haircut } }
              : {}),
          },
        }
      : {}),
  };
}

/** The position's liquidity role: a string tag, or the first known role in a list; undefined otherwise. */
export function liquidityRoleOf(p: Position): LiquidityRole | undefined {
  const raw = p.dimensions?.liquidityRole;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  for (const v of values) {
    if ((LIQUIDITY_ROLES as readonly string[]).includes(v)) return v as LiquidityRole;
  }
  return undefined;
}

/**
 * The buffer read from the book's hqla-stock positions. Each counts its face times one less the haircut of its
 * `hqla-level` tag (l1, l2a or l2b; HQLA_HAIRCUT), in book order. A position with no tag, a list or an unknown level
 * is listed under notCounted with the reason, and adds nothing. The face is the as-of notional: no market value.
 */
export function deriveLiquidityBuffer(book: PortfolioSpec): LiquidityBufferDerivation {
  const out: LiquidityBufferDerivation = { positions: [], notCounted: [], byLevel: { l1: 0, l2a: 0, l2b: 0 }, total: 0 };
  for (const p of book.positions) {
    if (liquidityRoleOf(p) !== "hqla-stock") continue;
    const raw = p.dimensions?.[HQLA_DIMENSION];
    const level = typeof raw === "string" && Object.hasOwn(HQLA_HAIRCUT, raw) ? (raw as "l1" | "l2a" | "l2b") : undefined;
    if (level === undefined) {
      out.notCounted.push({
        positionId: p.id,
        familyId: p.familyId,
        notional: p.terms.notional,
        reason: raw === undefined ? `no ${HQLA_DIMENSION} tag` : `${HQLA_DIMENSION} ${shown(raw)} is not l1, l2a or l2b`,
      });
      continue;
    }
    const haircut = HQLA_HAIRCUT[level]!;
    const counted = p.terms.notional * (1 - haircut);
    out.positions.push({ positionId: p.id, familyId: p.familyId, notional: p.terms.notional, level, haircut, counted });
    out.byLevel[level] += counted;
    out.total += counted;
  }
  return out;
}

/**
 * Survival horizon: start at month 0 with running = buffer; at the
 * first listed month i where buffer + cumulative_i < 0 return
 * prevMonth + prev / (prev - running) x (i - prevMonth), interpolated between
 * the listed months only (no fill between sparse months). Null when the buffer
 * is never pierced, which a reader shows as "beyond the horizon".
 */
export function survivalMonths(months: number[], cumulative: number[], buffer: number): number | null {
  if (months.length !== cumulative.length) {
    throw new Error(
      `survivalMonths: ${months.length} months but ${cumulative.length} cumulative values; give one value per month`,
    );
  }
  let prevMonth = 0;
  let prev = buffer;
  for (let i = 0; i < months.length; i++) {
    const month = months[i]!;
    const running = buffer + cumulative[i]!;
    if (running < 0) {
      const span = prev - running;
      const frac = span !== 0 ? prev / span : 0;
      return prevMonth + frac * (month - prevMonth);
    }
    prevMonth = month;
    prev = running;
  }
  return null;
}

function principalAt(series: number[] | undefined, m: number): number {
  if (series === undefined || m >= series.length) return 0;
  return series[m]!;
}

function scenario(
  id: LiquidityStressScenario["id"],
  params: LiquidityStressParams,
  inflow: number[],
  wholesale: number[],
  cd: number[],
  early: number[],
  pools: { hys: number; nib: number },
  input: LiquidityStressInput,
  buffer: number,
  months: number[],
): LiquidityStressScenario {
  const h = input.horizonMonths;
  let hys = pools.hys;
  let nib = pools.nib;
  let cum = 0;
  const cdRenewal = params.cdRenewal;
  const out: LiquidityStressScenario = {
    id,
    params: { ...params },
    inflow: [...inflow],
    hysOut: [],
    nibOut: [],
    wholesaleOut: [],
    ...(cdRenewal !== undefined ? { cdOut: [] } : {}),
    draws: [],
    net: [],
    cumulative: [],
    survivalMonths: null,
    peakShortfall: 0,
    peakMonth: 1,
  };
  for (let m = 0; m < h; m++) {
    const hysOut = hys * params.hysOutflowMonthly;
    const nibOut = nib * params.nibOutflowMonthly;
    hys -= hysOut;
    nib -= nibOut;
    const wholesaleOut = wholesale[m]! * (1 - params.wholesaleRenewal);
    // x - 0 is x exactly, so a row without cdRenewal nets as it did before the role existed.
    const cdOut = cdRenewal !== undefined ? cd[m]! * (1 - cdRenewal) + early[m]! : 0;
    const draws = (input.undrawnFace * params.drawRate) / h;
    const net = inflow[m]! - hysOut - nibOut - wholesaleOut - cdOut - draws;
    cum += net;
    out.hysOut.push(hysOut);
    out.nibOut.push(nibOut);
    out.wholesaleOut.push(wholesaleOut);
    out.cdOut?.push(cdOut);
    out.draws.push(draws);
    out.net.push(net);
    out.cumulative.push(cum);
  }
  out.survivalMonths = survivalMonths(months, out.cumulative, buffer);
  let peak = out.cumulative[0]!;
  let peakIndex = 0;
  for (let m = 1; m < h; m++) {
    if (out.cumulative[m]! < peak) {
      peak = out.cumulative[m]!;
      peakIndex = m;
    }
  }
  out.peakShortfall = peak;
  out.peakMonth = peakIndex + 1;
  return out;
}

/** The ladder's inputs read off the book: the pools, and the inflow, stress inflow, wholesale and term-deposit series to `h` months. */
export function ladderLegs(
  book: PortfolioSpec,
  principalByPosition: Map<string, number[]>,
  stressPrincipalByPosition: Map<string, number[]> | undefined,
  h: number,
  earlyByPosition?: Map<string, number[]>,
): { pools: { hys: number; nib: number }; inflow: number[]; inflowStress: number[]; wholesale: number[]; cd: number[]; early: number[] } {
  const inflow = new Array<number>(h).fill(0);
  const inflowStress = new Array<number>(h).fill(0);
  const wholesale = new Array<number>(h).fill(0);
  const cd = new Array<number>(h).fill(0);
  const early = new Array<number>(h).fill(0);
  const pools = { hys: 0, nib: 0 };
  for (const p of book.positions) {
    const role = liquidityRoleOf(p);
    if (role === "hys-pool") pools.hys += p.terms.notional;
    else if (role === "nib-pool") pools.nib += p.terms.notional;
    else if (role === "inflow-asset" || role === "wholesale" || role === "term-deposit") {
      const series = principalByPosition.get(p.id);
      const target = role === "inflow-asset" ? inflow : role === "wholesale" ? wholesale : cd;
      for (let m = 0; m < h; m++) target[m]! += principalAt(series, m);
      if (role === "term-deposit") {
        const e = earlyByPosition?.get(p.id);
        for (let m = 0; m < h; m++) early[m]! += principalAt(e, m);
      }
      if (role === "inflow-asset") {
        const stressed = stressPrincipalByPosition?.get(p.id) ?? series;
        for (let m = 0; m < h; m++) inflowStress[m]! += principalAt(stressed, m);
      }
    }
  }
  return { pools, inflow, inflowStress, wholesale, cd, early };
}

/** The ladder for bau, moderate and severe, in that order. */
export function computeLiquidityStress(input: LiquidityStressInput): LiquidityStressResult {
  const h = input.horizonMonths;
  if (!Number.isInteger(h) || h < 1) {
    throw new Error(`liquidity stress: horizonMonths must be a positive integer, got ${shown(h)}`);
  }
  const problem = liquidityStressConfigError(
    {
      table: input.table,
      ...(input.buffer !== undefined ? { buffer: input.buffer } : {}),
      undrawnFace: input.undrawnFace,
      ...(input.dials !== undefined ? { dials: input.dials } : {}),
    },
    "liquidity stress",
  );
  if (problem !== undefined) throw new Error(problem.replace(/^liquidity stress\./, "liquidity stress: "));

  const { pools, inflow, inflowStress, wholesale, cd, early } = ladderLegs(input.book, input.principalByPosition, input.stressPrincipalByPosition, h, input.earlyByPosition);
  const derivation = input.buffer === undefined ? deriveLiquidityBuffer(input.book) : undefined;
  const buffer = input.buffer ?? derivation!.total;
  // The dials set the severe row's draw; every other rate is the table's. S3d fix round (ruling
  // 2026-11-05): the undrawn face is U, the dials' face U / (1 - Ubar), and the severe draw their requirement.
  const dials = input.dials !== undefined ? ladderDialsOf(input.dials, input.undrawnFace) : undefined;
  const dialsResult = dials !== undefined ? computeCommitmentDials(dials) : undefined;
  const severeDrawRate = dialsResult !== undefined ? dialsResult.bufferRequirement / input.undrawnFace : undefined;
  const table: LiquidityStressTable =
    severeDrawRate !== undefined ? { ...input.table, severe: { ...input.table.severe, drawRate: severeDrawRate } } : input.table;
  const anyCd = SCENARIO_IDS.some((id) => table[id].cdRenewal !== undefined);
  const months = Array.from({ length: h }, (_, i) => i + 1);
  const result: LiquidityStressResult = {
    horizonMonths: h,
    buffer,
    undrawnFace: input.undrawnFace,
    pools,
    wholesaleMaturities: wholesale,
    ...(anyCd ? { cdMaturities: cd, cdEarlyWithdrawals: early } : {}),
    scenarios: SCENARIO_IDS.map((id) =>
      scenario(id, table[id], LIQUIDITY_STRESS_ROWS.includes(id) ? inflowStress : inflow, wholesale, cd, early, pools, input, buffer, months),
    ),
  };
  if (derivation !== undefined) result.bufferDerivation = derivation;
  if (dials !== undefined && dialsResult !== undefined) {
    result.commitmentDials = {
      dials,
      result: dialsResult,
      statedSevereDrawRate: input.table.severe.drawRate,
      severeDrawRate: severeDrawRate!,
    };
  }
  return result;
}
