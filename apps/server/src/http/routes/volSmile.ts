/**
 * SABR smile preview.
 *
 *   GET /api/market/:id/vol-smile?expiryYears=<y>[&alpha=&rho=&nu=]
 *
 * A read-only surface preview of one expiry row of the stored market's short-rate volatility surface: the
 * row's stored points (the strike points and the at-the-money column, the latter placed at the row's
 * forward), the kernel's surface-wide `sabrHeuristic` parameters, the Hagan beta = 0 normal-vol curve on a
 * 5 bp strike grid from the row's lowest to highest strike, and the residual per stored point in bp (model
 * minus stored). The forward is the base curve's forward over the kernel's `DEFAULT_UNDERLYING_TAU` at the
 * expiry, the base curve built by the engine's `buildBaseCurve`, the function every run uses.
 *
 * Nothing is stored, nothing is hashed, no derive op writes a SABR value and no run reads the result. Every
 * refusal is a 422 in words (a builder refusal in the builder's own words), never a 500 and never a NaN in
 * a reply. Vols and strikes are decimals, as stored; residuals are bp.
 */
import { DEFAULT_UNDERLYING_TAU, sabrHeuristic, sabrNormalVol, type CapQuote, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import type { PlatformContext } from "../../context";
import { unprocessable } from "../errors";
import type { Router } from "../router";

/** The fixed note of spec decision 82, plus the decision 82 v2 sentence on the heuristic. */
export const VOL_SMILE_NOTE =
  "Constructed illustrative short-rate volatility surface. Nothing is stored, nothing is hashed, " +
  "no derive op writes a SABR value, and no run reads the result: the HW calibration reads the at-the-money " +
  "column as before and the wings stay unread. The heuristic is one surface-wide parameter set, so the " +
  "residuals show how far one smile sits from each row.";

/** The curve's strike step: 5 bp. */
const STRIKE_STEP = 0.0005;
/** An expiry within this many years of a stored row reads that row. */
const EXPIRY_TOL = 1e-9;

type ParamName = "alpha" | "rho" | "nu";
const RANGE_WORDS: Record<ParamName, string> = {
  alpha: "greater than 0",
  rho: "greater than -1 and less than 1",
  nu: "greater than 0",
};
const inRange = (name: ParamName, v: number): boolean => (name === "rho" ? v > -1 && v < 1 : v > 0);

/** A query value as a finite number, or undefined when it does not read as one. */
function numberOf(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

/** "got 0" for a number that reads, "got \"abc\"" for one that does not. */
const gotWords = (raw: string): string => (numberOf(raw) !== undefined ? `got ${raw}` : `got ${JSON.stringify(raw)}`);

/** One optional override, or the 422 naming the field and its range. */
function overrideOf(query: URLSearchParams, name: ParamName): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const v = numberOf(raw);
  if (v === undefined || !inRange(name, v)) {
    throw unprocessable(`${name} must be a number ${RANGE_WORDS[name]}; ${gotWords(raw)}`);
  }
  return v;
}

/** The stored strike quotes, or the 422 when the document carries no short-rate volatility surface. */
function quotesOf(doc: unknown): CapQuote[] {
  const quotes = typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as { capQuotes?: unknown }).capQuotes : undefined;
  const ok =
    Array.isArray(quotes) &&
    quotes.length > 0 &&
    quotes.every(
      (q) =>
        typeof q === "object" && q !== null &&
        Number.isFinite((q as CapQuote).expiryYears) &&
        Number.isFinite((q as CapQuote).normalVol) &&
        typeof (q as CapQuote).isAtm === "boolean" &&
        ((q as CapQuote).isAtm || Number.isFinite((q as CapQuote).strike)),
    );
  if (!ok) throw unprocessable("the stored market document carries no short-rate volatility surface");
  return quotes as CapQuote[];
}

/** A finite number, or the 422 naming what came out non-finite. */
function finite(v: number, what: string): number {
  if (!Number.isFinite(v)) throw unprocessable(`the preview cannot be computed: ${what} is not a finite number`);
  return v;
}

export function registerVolSmileRoutes(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/market/:id/vol-smile", (req) => {
    const id = req.params.id ?? "";
    const rawExpiry = req.query.get("expiryYears");
    if (rawExpiry === null) {
      throw unprocessable("expiryYears is required: the expiry row, in years, of the short-rate volatility surface");
    }
    const asked = numberOf(rawExpiry);
    if (asked === undefined) throw unprocessable(`expiryYears must be a number of years; got ${JSON.stringify(rawExpiry)}`);
    const overrides = { alpha: overrideOf(req.query, "alpha"), rho: overrideOf(req.query, "rho"), nu: overrideOf(req.query, "nu") };

    // Read only: the document is read, never written. An unknown id is the store's typed 404.
    const doc: unknown = ctx.store.getDocument<unknown>("market", id).doc;
    const quotes = quotesOf(doc);
    const expiries = [...new Set(quotes.map((q) => q.expiryYears))].sort((a, b) => a - b);
    const expiry = expiries.find((e) => Math.abs(e - asked) <= EXPIRY_TOL);
    if (expiry === undefined) {
      throw unprocessable(
        `expiryYears ${rawExpiry} is not an expiry row of the short-rate volatility surface; the rows are ${expiries.join(", ")} years`,
        { expiries },
      );
    }
    const row = quotes.filter((q) => q.expiryYears === expiry);
    const strikes = row.filter((q) => !q.isAtm).map((q) => q.strike as number);
    if (strikes.length === 0) {
      throw unprocessable(`the ${expiry} year row carries no strike points, only the at-the-money column; there is no smile to preview`);
    }

    let curve: ZeroCurve;
    try {
      curve = buildBaseCurve(doc as MarketSnapshot);
    } catch (e) {
      throw unprocessable(e instanceof Error ? e.message : String(e));
    }
    let forward: number;
    try {
      forward = curve.forwardRate(expiry, expiry + DEFAULT_UNDERLYING_TAU);
    } catch (e) {
      throw unprocessable(e instanceof Error ? e.message : String(e));
    }
    finite(forward, "the forward");

    const h = sabrHeuristic(doc as MarketSnapshot);
    const heuristic = { alpha: h.alpha, beta: h.beta, rho: h.rho, nu: h.nu };
    const params = {
      alpha: overrides.alpha ?? heuristic.alpha,
      beta: heuristic.beta,
      rho: overrides.rho ?? heuristic.rho,
      nu: overrides.nu ?? heuristic.nu,
    };
    // The heuristic on a stored surface can still fall outside the ranges (a non-positive mean vol).
    for (const name of ["alpha", "rho", "nu"] as const) {
      if (!Number.isFinite(params[name]) || !inRange(name, params[name])) {
        throw unprocessable(`the heuristic ${name} ${params[name]} is outside its range (${RANGE_WORDS[name]}); pass ${name} to override it`);
      }
    }
    const model = (k: number): number =>
      finite(sabrNormalVol(forward, k, expiry, params.alpha, params.rho, params.nu), `the model volatility at strike ${k}`);

    const points = row
      .map((q) => {
        const strike = q.isAtm ? forward : (q.strike as number);
        const modelVol = model(strike);
        return { strike, isAtm: q.isAtm, normalVol: q.normalVol, modelVol, residualBp: finite((modelVol - q.normalVol) * 1e4, `the residual at strike ${strike}`) };
      })
      .sort((a, b) => a.strike - b.strike);

    const lo = Math.min(...strikes);
    const hi = Math.max(...strikes);
    const steps = Math.floor((hi - lo) / STRIKE_STEP + 1e-9);
    const grid: number[] = [];
    for (let i = 0; i <= steps; i++) grid.push(Math.round((lo + i * STRIKE_STEP) * 1e10) / 1e10);
    if (hi - grid[grid.length - 1]! > 1e-12) grid.push(hi);

    return {
      kind: "json",
      value: {
        marketId: id,
        expiryYears: expiry,
        underlyingTau: DEFAULT_UNDERLYING_TAU,
        forward,
        heuristic,
        params,
        points,
        curve: grid.map((strike) => ({ strike, modelVol: model(strike) })),
        note: VOL_SMILE_NOTE,
      },
    };
  });
}
