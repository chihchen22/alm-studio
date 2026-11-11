/**
 * The SEG block's knobs: the shock size, the horizon, the NII shock and a cohort-0
 * prepayment overlay, each optional. A run that names none of them runs the block on SEG_DEFAULTS, byte for byte as
 * before. Worked examples by hand often run at +/-25bp, and a 30-year mortgage is read on a 720-month
 * horizon over months 0 to 360, so every replacement vintage written inside the read window keeps its full
 * 360-month schedule (the kernel cuts a vintage to the months left in the run).
 *
 *   shockBp       the SEG pair's half-shock, bp: (0, 200]. A 50bp divisor is 2 x 25.
 *   horizonMonths the SEG and EBP horizon, whole months: 1 to 720.
 *   niiShockBp    the 12-month constant-balance NII shock, bp: (0, 500].
 *   cprOverlay    per mortgage family: cohort 0 prepays at a flat `upAnnualCpr` under the up shock and a flat
 *                 `downAnnualCpr` under the down shock, while every replacement vintage keeps the family's own
 *                 prepayment model (new vintages prepay at the base speed in every scenario). It moves the SEG pair and the EBP only; the 12-month NII block keeps the family model.
 */
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import { SEG_DEFAULTS } from "./computeSeg";

export interface SegCprOverlay {
  familyId: string;
  /** Cohort 0's flat annual CPR under the up shock, decimal in [0, 1]. */
  upAnnualCpr: number;
  /** Cohort 0's flat annual CPR under the down shock, decimal in [0, 1]. */
  downAnnualCpr: number;
}

export interface SegSettings {
  shockBp?: number;
  horizonMonths?: number;
  niiShockBp?: number;
  cprOverlay?: SegCprOverlay[];
}

export const SEG_MAX_SHOCK_BP = 200;
export const SEG_MAX_HORIZON_MONTHS = 720;
export const SEG_MAX_NII_SHOCK_BP = 500;

function shown(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function boundedBp(v: unknown, path: string, max: number): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) {
    return `${path} must be a number of basis points above 0 and at most ${max}, got ${shown(v)}`;
  }
  return undefined;
}

/** The first problem with a SEG settings value, or undefined. The run route and the engine run the same check. */
export function segSettingsConfigError(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object { shockBp?, horizonMonths?, niiShockBp?, cprOverlay? }, got ${shown(value)}`;
  for (const key of Object.keys(value)) {
    if (key !== "shockBp" && key !== "horizonMonths" && key !== "niiShockBp" && key !== "cprOverlay") {
      return `${path}.${key} is not a SEG setting; the settings are shockBp, horizonMonths, niiShockBp and cprOverlay`;
    }
  }
  if (value.shockBp !== undefined) {
    const p = boundedBp(value.shockBp, `${path}.shockBp`, SEG_MAX_SHOCK_BP);
    if (p !== undefined) return p;
  }
  if (value.niiShockBp !== undefined) {
    const p = boundedBp(value.niiShockBp, `${path}.niiShockBp`, SEG_MAX_NII_SHOCK_BP);
    if (p !== undefined) return p;
  }
  const h = value.horizonMonths;
  if (h !== undefined && (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > SEG_MAX_HORIZON_MONTHS)) {
    return `${path}.horizonMonths must be a whole number of months from 1 to ${SEG_MAX_HORIZON_MONTHS}, got ${shown(h)}`;
  }
  const o = value.cprOverlay;
  if (o !== undefined) {
    if (!Array.isArray(o) || o.length === 0) return `${path}.cprOverlay must be a non-empty array of { familyId, upAnnualCpr, downAnnualCpr }`;
    const seen = new Set<string>();
    for (let i = 0; i < o.length; i++) {
      const row = o[i] as unknown;
      const at = `${path}.cprOverlay[${i}]`;
      if (!isRecord(row)) return `${at} must be an object { familyId, upAnnualCpr, downAnnualCpr }, got ${shown(row)}`;
      if (typeof row.familyId !== "string" || row.familyId.length === 0) return `${at}.familyId must be a family id, got ${shown(row.familyId)}`;
      if (seen.has(row.familyId)) return `${at}.familyId "${row.familyId}" appears twice`;
      seen.add(row.familyId);
      for (const key of ["upAnnualCpr", "downAnnualCpr"] as const) {
        const c = row[key];
        if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) return `${at}.${key} must be a decimal in [0, 1], got ${shown(c)}`;
      }
    }
  }
  return undefined;
}

/** The stored copy of a checked value: the known keys only, so an extra key never reaches a stored request. */
export function segSettingsOf(v: SegSettings): SegSettings {
  return {
    ...(v.shockBp !== undefined ? { shockBp: v.shockBp } : {}),
    ...(v.horizonMonths !== undefined ? { horizonMonths: v.horizonMonths } : {}),
    ...(v.niiShockBp !== undefined ? { niiShockBp: v.niiShockBp } : {}),
    ...(v.cprOverlay !== undefined
      ? { cprOverlay: v.cprOverlay.map((r) => ({ familyId: r.familyId, upAnnualCpr: r.upAnnualCpr, downAnnualCpr: r.downAnnualCpr })) }
      : {}),
  };
}

/** The block's four constants under the settings: SEG_DEFAULTS where a setting is absent. */
export function segConstants(s: SegSettings | undefined): { horizonMonths: number; niiHorizonMonths: number; shockBp: number; niiShockBp: number } {
  return {
    horizonMonths: s?.horizonMonths ?? SEG_DEFAULTS.horizonMonths,
    niiHorizonMonths: SEG_DEFAULTS.niiHorizonMonths,
    shockBp: s?.shockBp ?? SEG_DEFAULTS.shockBp,
    niiShockBp: s?.niiShockBp ?? SEG_DEFAULTS.niiShockBp,
  };
}

/** A cprOverlay family the book's chart does not declare, or declares on an instrument type other than mortgage. */
export function segCprOverlayBookError(settings: SegSettings, coa: ChartOfAccounts, path: string): string | undefined {
  for (const row of settings.cprOverlay ?? []) {
    const fam = coa.families.find((f) => f.id === row.familyId);
    if (fam === undefined) return `${path}.cprOverlay names family "${row.familyId}", which the book's chart of accounts does not declare`;
    if (fam.instrumentType !== "mortgage") {
      return `${path}.cprOverlay names family "${row.familyId}", a ${fam.instrumentType} family; the cohort-0 overlay applies to a mortgage family only`;
    }
  }
  return undefined;
}
