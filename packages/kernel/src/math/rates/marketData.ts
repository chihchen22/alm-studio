/**
 * Market-data loader: TypeScript port of the Lab's Python reference.
 *
 * Mirrors the Python dataclasses with strict TS types. Loads a market
 * snapshot (discount curve, optional term-funding curve + Term LP nodes, and
 * the two volatility surfaces) from JSON produced by
 * the Lab's Python reference or the in-browser xlsx importer; both share
 * one contract.
 *
 * VOLATILITY NAMING. The `CapQuote` / `SwaptionATMQuote` types and the
 * `capQuotes` / `swaptionATMQuotes` fields are the INTERNAL contract and keep
 * their names for continuity with the Python reference and the calibrators.
 * They do NOT assert that the loaded values are cap or swaption market quotes.
 * On the shipped Treasury-only public pack they are synthetic bond-yield
 * volatilities carried for education: `capQuotes` holds a synthetic cap ANALOG
 * on the short rate (strike x expiry), `swaptionATMQuotes` holds a synthetic
 * at-the-money bond-yield grid (expiry x tenor). Both are normal (Bachelier)
 * bp vols built from realized historical yield vol times a stated parameterized
 * premium; the pack's own `disclosure` fields carry the recipe. Anything a user
 * reads must use the synthetic framing, never the market-quote framing.
 */

import type { TLPNode } from "./tlpCurve";

/**
 * Par-instrument convention of the discount-curve block.
 *
 * "semiannual_bond": the U.S. Treasury CMT treatment carried by the shipped
 *   public pack, applied to the WHOLE curve. Every node is a par yield quoted
 *   bond-equivalent semiannual (exact 0.5-year periods stand in for ACT/ACT):
 *   tenors >= 1Y are semi-annual coupon bonds priced at par, the 6M node is a
 *   par bond with its single coupon at maturity, and tenors < 0.5Y are pure
 *   discount at their coupon-equivalent yield. The instrument `type` label is
 *   descriptive under this convention; the bootstrapper keys off the tenor.
 * "annual_act360": tenors > 1Y are annual ACT/360 par swaps; tenors <= 1Y are
 *   simple-compounded cash. The retired constructed snapshot's convention, kept
 *   as the default for any pack that does not declare a semi-annual fixed leg.
 */
export type CurveConvention = "semiannual_bond" | "annual_act360";

/** Verbatim convention fields carried by the snapshot's curve block. */
export interface CurveConventionFields {
  readonly dayCount: string | null;
  readonly fixedPaymentFreq: string | null;
  readonly label: string | null;
  readonly basisDisclosure: string | null;
}

/**
 * Instrument label carried by a curve node.
 *
 * Labels of record (Treasury/CMT packs, 2026-08-31):
 * - "BILL_BEY": a sub-1Y Treasury bill point carried at its bond-equivalent
 *   (coupon-equivalent) yield.
 * - "CMT_PAR": a 1Y-and-beyond constant-maturity par yield, i.e. a semi-annual
 *   coupon bond priced at par.
 *
 * Retired labels, still parsed for the constructed fixture and for imported
 * workbooks: "CASH" (simple-compounded money-market node) and "SWAP" (annual
 * ACT/360 par swap). Under the Treasury convention the bootstrapper ignores this
 * field entirely and keys off the tenor, so old and new packs bootstrap
 * identically; under "annual_act360" the CASH label still forces the cash leg.
 */
export type CurveInstrumentType = "BILL_BEY" | "CMT_PAR" | "CASH" | "SWAP";

export interface CurveQuote {
  readonly term: string;
  readonly tYears: number;
  readonly instrumentType: CurveInstrumentType;
  readonly rate: number;
}

export interface SwaptionATMQuote {
  readonly expiryYears: number;
  readonly tenorYears: number;
  readonly normalVol: number;
}

/**
 * Default BGM calibration subset: standard expiries x core tenors (28 points).
 * The 2026-03-31 surface carries 21 expiries x 15 tenors = 315 points with
 * tenors out to 30Y; the Rebonato pricer's cost is quadratic in swap length,
 * so calibrating to the full grid takes tens of minutes in TS. The default
 * selection keeps calibration interactive; every quote remains individually
 * selectable on the SABR tab. The Python reference (the Lab's Python reference)
 * applies the same subset.
 */
export const DEFAULT_SWAPTION_CALIB_EXPIRIES: ReadonlyArray<number> = [
  1 / 12, 3 / 12, 6 / 12, 1, 2, 5, 10,
];
export const DEFAULT_SWAPTION_CALIB_TENORS: ReadonlyArray<number> = [1, 2, 5, 10];

export function isDefaultCalibrationSwaption(q: SwaptionATMQuote): boolean {
  const near = (x: number, set: ReadonlyArray<number>) =>
    set.some((v) => Math.abs(x - v) < 1e-9);
  return (
    near(q.expiryYears, DEFAULT_SWAPTION_CALIB_EXPIRIES) &&
    near(q.tenorYears, DEFAULT_SWAPTION_CALIB_TENORS)
  );
}

/**
 * Curated display grid for the short-rate (cap-analog) surface on the SABR tab
 * (the pre-2026-03-31 vintage granularity): standard expiries x whole-percent
 * strikes plus ATM. Display-only: every point in the snapshot stays selectable
 * behind the "full surface" toggle, and the default selection is unaffected.
 */
export const DEFAULT_CAP_DISPLAY_EXPIRIES: ReadonlyArray<number> = [1, 2, 3, 5, 10, 15];
export const DEFAULT_CAP_DISPLAY_STRIKES: ReadonlyArray<number> = [
  -0.02, -0.01, 0.01, 0.02, 0.03, 0.04, 0.05,
];

export function isDefaultDisplayCap(q: CapQuote): boolean {
  const near = (x: number, set: ReadonlyArray<number>) =>
    set.some((v) => Math.abs(x - v) < 1e-9);
  if (!near(q.expiryYears, DEFAULT_CAP_DISPLAY_EXPIRIES)) return false;
  return q.isAtm || (q.strike !== null && near(q.strike, DEFAULT_CAP_DISPLAY_STRIKES));
}

/**
 * One short-rate volatility point on the cap-analog surface (synthetic on the
 * shipped public pack; a genuine cap quote only if the user imports a licensed
 * surface). Strikes are ABSOLUTE rates (decimal); the matrix columns
 * -2.00%..7.00% are strike levels (negative strikes are a negative-rate-era
 * convention), and the ATM value is a separate explicit column, not the 0.00%
 * strike.
 */
export interface CapQuote {
  readonly expiryYears: number;
  readonly strike: number | null; // null for ATM
  readonly normalVol: number;
  readonly isAtm: boolean;
}

export interface TermFundingQuote {
  readonly term: string;
  readonly tYears: number;
  readonly rate: number;
}

export interface MarketSnapshot {
  readonly calibrationDate: string;
  readonly currency: string;
  /**
   * Benchmark index label: "RFR" for the constructed illustrative pack,
   * "SOFR_OIS" for a terminal-converted or workbook-imported pack.
   * Derived from the snapshot's `benchmark.index_label`, falling back to the
   * retired `discounting_index` field for older files (both stay parseable).
   */
  readonly discountingIndex: string;
  /** Optional free-text note carried by the benchmark block, if present. */
  readonly benchmarkNote: string | null;
  readonly curveQuotes: ReadonlyArray<CurveQuote>;
  /**
   * Par-instrument convention the bootstrapper must apply, derived from the
   * curve block's `day_count` / `fixed_payment_freq`. Defaults to the retired
   * annual ACT/360 treatment when the block declares nothing semi-annual, so
   * older packs and the constructed fixture keep their bootstrapped numbers.
   */
  readonly curveConvention: CurveConvention;
  /** The curve block's convention fields as written, for display and disclosure. */
  readonly curveConventionFields: CurveConventionFields;
  readonly capQuotes: ReadonlyArray<CapQuote>;
  readonly swaptionATMQuotes: ReadonlyArray<SwaptionATMQuote>;
  /** Term funding curve (institution's wholesale term-funding curve, e.g.
   *  FHLB advances at a U.S. bank); empty for snapshots without the block. */
  readonly termFundingCurveQuotes: ReadonlyArray<TermFundingQuote>;
  /** Term LP nodes (term funding - benchmark, 1D pinned to 0 at t=0); empty if absent. */
  readonly tlpNodes: ReadonlyArray<TLPNode>;
}

const TENOR_TO_YEARS: Record<string, number> = {
  "1D": 1 / 360,
  "1M": 1 / 12,
  "2M": 2 / 12,
  "3M": 3 / 12,
  "6M": 6 / 12,
  "9M": 9 / 12,
  "1Y": 1.0,
  "18M": 1.5,
  "2Y": 2.0,
  "3Y": 3.0,
  "4Y": 4.0,
  "5Y": 5.0,
  "6Y": 6.0,
  "7Y": 7.0,
  "8Y": 8.0,
  "9Y": 9.0,
  "10Y": 10.0,
  "12Y": 12.0,
  "15Y": 15.0,
  "20Y": 20.0,
  "25Y": 25.0,
  "30Y": 30.0,
};

function toYears(label: string): number {
  const v = TENOR_TO_YEARS[label];
  if (v === undefined) {
    throw new Error(`Unknown tenor label: ${label}`);
  }
  return v;
}

/**
 * Discount-curve block as written in the pack JSON. The convention fields were
 * previously ignored by this loader; they are now parsed and drive the
 * bootstrapper's par-instrument treatment.
 */
export interface RawCurveBlock {
  day_count?: string;
  fixed_payment_freq?: string;
  label?: string;
  basis_disclosure?: string;
  instruments: Array<{
    term: string;
    t_years: number;
    type: CurveInstrumentType;
    rate: number;
  }>;
}

export interface RawSnapshot {
  calibration_date: string;
  currency: string;
  /** Retired label field; superseded by `benchmark` but still parsed. */
  discounting_index?: string;
  /** Generic benchmark block (constructed packs carry index_label "RFR"). */
  benchmark?: { index_label: string; note?: string };
  /**
   * Discount-curve block. Public packs carry `curve_rfr` (key of record, Stage 0
   * relabel 2026-08-19); the constructed snapshot still carries the
   * retired `curve_sofr_ois`. Exactly one of the two must be present.
   */
  curve_rfr?: RawCurveBlock;
  /** Stage 0 alias: retired name for `curve_rfr`. */
  curve_sofr_ois?: RawCurveBlock;
  /** Generic term-funding curve block (constructed packs use this key). */
  term_funding_curve?: {
    instruments: Array<{ term: string; t_years: number; rate: number }>;
  };
  /** Retired key for the same block (older advance-curve exports); still parsed. */
  fhlb_curve?: {
    instruments: Array<{ term: string; t_years: number; rate: number }>;
  };
  tlp_nodes?: Array<{ term: string; t_years: number; spread: number }>;
  /** Short-end volatilities (key of record). Retired name: `cap_vol_surface`. */
  short_rate_vol_surface?: {
    rows: Array<{ expiry: string; vols: Record<string, number> }>;
  };
  /** Stage 0 alias: retired name for `short_rate_vol_surface`. */
  cap_vol_surface?: {
    rows: Array<{ expiry: string; vols: Record<string, number> }>;
  };
  /** Long-end volatilities (key of record). Retired name: `swaption_atm_vol_surface`. */
  long_yield_option_vol_surface?: {
    rows: Array<{ expiry: string; vols: Record<string, number> }>;
  };
  /** Stage 0 alias: retired name for `long_yield_option_vol_surface`. */
  swaption_atm_vol_surface?: {
    rows: Array<{ expiry: string; vols: Record<string, number> }>;
  };
}

/**
 * Stage 0 alias (2026-08-19): resolve a pack block that may carry either the key
 * of record or its retired name. One cycle only. To retire: delete this helper,
 * make the three `*_of_record` fields required on RawSnapshot, drop the three
 * retired optional fields, and read them directly again.
 */
function pickBlock<T>(current: T | undefined, retired: T | undefined, label: string): T {
  const block = current ?? retired;
  if (!block) {
    throw new Error(`Market snapshot has no ${label} block (nor its retired alias).`);
  }
  return block;
}

/**
 * Map the curve block's declared fixed-leg convention onto the bootstrapper's
 * instrument treatment. A semi-annual fixed leg (or an explicitly
 * bond-equivalent day count) selects the par-bond treatment; anything else,
 * including a block that declares nothing at all, keeps the retired annual
 * ACT/360 par-swap treatment so existing packs bootstrap unchanged.
 */
function resolveCurveConvention(fields: CurveConventionFields): CurveConvention {
  const freq = (fields.fixedPaymentFreq ?? "").toLowerCase();
  const dayCount = (fields.dayCount ?? "").toLowerCase();
  if (freq.includes("semiannual") || freq.includes("semi-annual")) return "semiannual_bond";
  if (dayCount.includes("bond-equivalent") || dayCount.includes("bond equivalent")) {
    return "semiannual_bond";
  }
  return "annual_act360";
}

export function parseMarketSnapshot(raw: RawSnapshot): MarketSnapshot {
  const curveBlock = pickBlock(raw.curve_rfr, raw.curve_sofr_ois, "curve_rfr");
  const shortRateVolBlock = pickBlock(
    raw.short_rate_vol_surface, raw.cap_vol_surface, "short_rate_vol_surface",
  );
  const longYieldVolBlock = pickBlock(
    raw.long_yield_option_vol_surface, raw.swaption_atm_vol_surface,
    "long_yield_option_vol_surface",
  );

  const curveConventionFields: CurveConventionFields = {
    dayCount: curveBlock.day_count ?? null,
    fixedPaymentFreq: curveBlock.fixed_payment_freq ?? null,
    label: curveBlock.label ?? null,
    basisDisclosure: curveBlock.basis_disclosure ?? null,
  };
  const curveConvention = resolveCurveConvention(curveConventionFields);

  const curveQuotes: CurveQuote[] = curveBlock.instruments.map((q) => ({
    term: q.term,
    tYears: q.t_years,
    instrumentType: q.type,
    rate: q.rate,
  }));

  const capQuotes: CapQuote[] = [];
  for (const row of shortRateVolBlock.rows) {
    const expiry = toYears(row.expiry);
    for (const [strikeLabel, vol] of Object.entries(row.vols)) {
      const isAtm = strikeLabel === "ATM";
      capQuotes.push({
        expiryYears: expiry,
        strike: isAtm ? null : Number(strikeLabel),
        normalVol: vol,
        isAtm,
      });
    }
  }

  const termFundingCurveQuotes: TermFundingQuote[] = (
    raw.term_funding_curve?.instruments ?? raw.fhlb_curve?.instruments ?? []
  ).map((q) => ({
    term: q.term,
    tYears: q.t_years,
    rate: q.rate,
  }));

  const tlpNodes: TLPNode[] = (raw.tlp_nodes ?? []).map((n) => ({
    tYears: n.t_years,
    spread: n.spread,
  }));

  const swaptionATMQuotes: SwaptionATMQuote[] = [];
  for (const row of longYieldVolBlock.rows) {
    const expiry = toYears(row.expiry);
    for (const [tenorLabel, vol] of Object.entries(row.vols)) {
      swaptionATMQuotes.push({
        expiryYears: expiry,
        tenorYears: toYears(tenorLabel),
        normalVol: vol,
      });
    }
  }

  return {
    calibrationDate: raw.calibration_date,
    currency: raw.currency,
    discountingIndex: raw.benchmark?.index_label ?? raw.discounting_index ?? "RFR",
    benchmarkNote: raw.benchmark?.note ?? null,
    curveQuotes,
    curveConvention,
    curveConventionFields,
    capQuotes,
    swaptionATMQuotes,
    termFundingCurveQuotes,
    tlpNodes,
  };
}

/**
 * Human-facing benchmark label for chart series and tab copy: neutral
 * "Benchmark" wording for the public path, the generic "RFR" for the
 * constructed illustrative default. The SOFR_OIS branch is a legacy
 * discounting-index tag; it is never surfaced as "SOFR" in the UI (two-track
 * spec Section 5).
 */
export function benchmarkDisplayLabel(snapshot: MarketSnapshot | null): string {
  if (!snapshot) return "RFR";
  return snapshot.discountingIndex === "SOFR_OIS" ? "Benchmark" : snapshot.discountingIndex;
}

/**
 * Shipped default snapshot: the public market pack (curve bootstrapped from
 * published U.S. Treasury CMT par yields, vols anchored on realized Treasury
 * yield volatility), built by the Lab's public pack script. The retired constructed
 * snapshot is now a test fixture under `__tests__/fixtures/`.
 */
export const MARKET_SNAPSHOT_FILENAME = "market_public.json";

/** Load a market snapshot from a JSON URL (browser) or path (Node tests). */
export async function loadMarketSnapshot(source: string | URL): Promise<MarketSnapshot> {
  if (typeof window !== "undefined") {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to load market data: ${res.status} ${res.statusText}`);
    }
    return parseMarketSnapshot((await res.json()) as RawSnapshot);
  }
  // Node fallback for tests: dynamic import of fs.
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(source as string, "utf-8");
  return parseMarketSnapshot(JSON.parse(text) as RawSnapshot);
}
