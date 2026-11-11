/**
 * The corrections on the CD book (ruling 2026-11-04: a model change, the book behavior kept
 * as the labelled original convention).
 *
 * Under the original convention the kernel's competing-risk walk prices its offers, its moneyness and its own discounting
 * off the vendored 2026-03-31 grid inside its parameters, and takes a scenario only as a parallel `shockBp` that no run
 * caller ever set; it also drops a cohort once its walk balance falls to $1,000, where the kernel header documents $1.
 * So the CD book's behavior ignored both the scenario and the run's market.
 *
 * Under the corrections the run writes a mark on each CD book at run entry (`markCdBook`), so every block that builds
 * the book sees one walk:
 *
 *  - `minLiveBalance` 1: the documented $1 minimum, in walk dollars;
 *  - `tlpSpreadByMonth`: the run's funding spread at 1 to 60 months. The walk then reads its zero curve off the rate
 *    path it is projected on (`cdCurveFromPath`) and adds that spread: the scenario's curve plus the run's TLP, held
 *    static as the kernel holds its own TLP leg. A parallel shock, a twist, a custom knot shock, an EVE duration bump
 *    and a key-rate bump all reach the walk the way they reach every other instrument, through the path.
 *
 * Nothing here touches the kernel: the walk takes its parameters as an argument, and this module only builds them.
 */
import type { CdCurve, RatePath, TLPCurve } from "@alm/kernel";
import type { PortfolioSpec } from "../contracts/position";
import type { ModelCorrections } from "../corrections";
import { CD_MINIMUM_LIVE_BALANCE_CORRECTED } from "../corrections";
import { CdAdapterError, cdCurveMonths, cdMaturityMonths, type CdTerms, type CdWalkMark } from "./terms";

/** The months of funding spread a mark carries: the kernel's longest CD term bucket (60 months). */
export const CD_TLP_SAMPLE_MONTHS = 60;

/** The month length the walk's curve grid assumes, in years. */
const MONTH_YEARS = 1 / 12;

/**
 * The book with every CD position marked for the corrections the run applies; the same object when none applies or
 * the book holds no CD. Positions keep their order, so an index into one book is an index into the other.
 */
export function markCdBook(book: PortfolioSpec, corrections: ModelCorrections, tlp?: TLPCurve): PortfolioSpec {
  const applies = corrections.cdScenarioCurve || corrections.cdMinimumBalance;
  // A `walk` the book file itself carries is never read (fix round M2): only this function writes the mark, so any
  // incoming one is dropped, on every convention. A book with neither is returned as it is.
  const authored = book.positions.some((p) => p.terms.type === "cd" && (p.terms as CdTerms).walk !== undefined);
  if (!book.positions.some((p) => p.terms.type === "cd") || (!applies && !authored)) return book;
  const mark = applies ? cdWalkMarkOf(corrections, tlp) : undefined;
  return {
    ...book,
    positions: book.positions.map((p) => (p.terms.type === "cd" ? { ...p, terms: markCdTerms(p.terms as CdTerms, mark) } : p)),
  };
}

/** The book with every CD's `walk` dropped: the original convention's view, for an entry that applies no correction. */
export function stripCdMarks(book: PortfolioSpec): PortfolioSpec {
  return markCdBook(book, { cdScenarioCurve: false, cdMinimumBalance: false, segVintageHistory: false });
}

/** The mark the corrections write; `tlp` is required when the scenario curve is on. */
export function cdWalkMarkOf(corrections: ModelCorrections, tlp?: TLPCurve): CdWalkMark | undefined {
  if (!corrections.cdScenarioCurve && !corrections.cdMinimumBalance) return undefined;
  let spread: number[] | undefined;
  if (corrections.cdScenarioCurve) {
    if (tlp === undefined) throw new Error("markCdBook: the scenario-curve correction needs the run's funding curve");
    spread = new Array<number>(CD_TLP_SAMPLE_MONTHS);
    for (let k = 1; k <= CD_TLP_SAMPLE_MONTHS; k++) spread[k - 1] = tlp.tlp(k / 12);
  }
  return {
    ...(corrections.cdMinimumBalance ? { minLiveBalance: CD_MINIMUM_LIVE_BALANCE_CORRECTED } : {}),
    ...(spread !== undefined ? { tlpSpreadByMonth: spread } : {}),
  };
}

/** One CD's terms with any incoming `walk` dropped and, when given, the run's mark written in its place. */
export function markCdTerms(terms: CdTerms, mark: CdWalkMark | undefined): CdTerms {
  const { walk: _authored, ...rest } = terms;
  void _authored;
  return mark === undefined ? rest : { ...rest, walk: mark };
}

/**
 * The walk's all-in curve read off a rate path: at each month k = 1..n the continuously compounded zero rate the path
 * implies, z_k = (1 / t_k) sum over j < k of ln(1 + r_j dt_j), with r_j the path's one-month accrual rate (the simple
 * forward its discount factors imply, so the sum telescopes to -ln P(t_k)), and the funding spread at k months. The
 * grid sits on t_k = k / 12, the tenors the walk reads (remaining whole months over 12), so no read interpolates.
 * `renewals` says which tenors the walk reads: in run-off only each cohort's remaining term, at most its months to
 * maturity; with renewals also each original term, where a renewal is offered (fix round L4). The walk reads one curve,
 * fixed at time 0: in month m a cohort's moneyness reads this curve at its remaining term, not a forward curve from m,
 * the kernel's static-curve design, right for the instant shocks the engine runs. Refuses a path that is not monthly
 * or does not reach the longest tenor the walk reads.
 */
export function cdCurveFromPath(terms: CdTerms, path: RatePath, tlpSpreadByMonth: readonly number[], renewals = false): CdCurve {
  const n = renewals ? cdCurveMonths(terms.cohorts) : cdMaturityMonths(terms.cohorts);
  const what = renewals ? "the book's longest term" : "the book's longest remaining term";
  if (path.nSteps < n) {
    throw new CdAdapterError(
      "cd-path-short",
      `CD terms "${terms.id}": the corrected walk reads the scenario's curve to ${n} months (${what}), ` +
        `but the rate path holds ${path.nSteps} months; lengthen the run's grid to at least ${n} months, or run the original convention`,
    );
  }
  if (tlpSpreadByMonth.length < n) {
    throw new CdAdapterError("cd-terms-walk", `CD terms "${terms.id}": the funding spread covers ${tlpSpreadByMonth.length} months, the walk reads ${n}`);
  }
  const t = new Array<number>(n);
  const z = new Array<number>(n);
  const tlpSpread = new Array<number>(n);
  let logGrowth = 0;
  for (let k = 1; k <= n; k++) {
    const dt = path.times[k]! - path.times[k - 1]!;
    if (Math.abs(dt - MONTH_YEARS) > 1e-12) {
      throw new CdAdapterError("cd-path-step", `CD terms "${terms.id}": the corrected walk reads a monthly rate path, got a step of ${dt} years at month ${k}`);
    }
    logGrowth += Math.log1p(path.rateAt(k - 1) * dt);
    t[k - 1] = k / 12;
    z[k - 1] = logGrowth / (k / 12);
    tlpSpread[k - 1] = tlpSpreadByMonth[k - 1]!;
  }
  return { t, z, tlpSpread };
}
