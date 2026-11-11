/**
 * The run-entry hook for the regulatory deposit convention. Kept
 * beside the transform so orchestrate.ts carries one call, and so the two
 * inputs the transform needs from a run are derived in one place:
 *
 *  - r0: the base scenario's deterministic path at step 0 (the simple one-month
 *    forward a one-month floater accrues in month 1), built through the run's
 *    own `curves` and `ratePaths` seams;
 *  - beta at r0 for each nmd-b position: its EFFECTIVE beta curve at r0 in
 *    percent, that is the base scenario set's deposit-beta overlay for the
 *    position's family when one matches the position, else the curve on the
 *    position's terms. The transform runs on the raw book before any overlay
 *    is applied, so reading the raw terms alone would split the book on a
 *    curve the run never uses.
 *
 * The behavioral overlays never reach the children afterwards
 * (projection/static/applyOverlays.ts skips a position carrying
 * parentPositionId): a rung is frozen by construction and a deposit-beta or
 * nmd-decay overlay keyed on the parent's family would otherwise unfreeze it or
 * refuse it.
 */
import { betaAtRate, type BetaSCurveParams } from "@alm/kernel";
import type { AssumptionSet } from "../contracts/assumptions";
import type { PortfolioSpec, Position } from "../contracts/position";
import type { RunRequest } from "../contracts/run";
import type { Scenario } from "../contracts/scenario";
import type { CurveService, RatePathRegistry } from "../plugins/services";
import { baseState } from "./fullBeta";
import { governingDepositBeta, hasUnslottedDeposit, markFullFormBook } from "./fullBetaRun";
import { REGULATORY_CONVENTION_DEFAULTS, applyRegulatoryConvention } from "./regulatoryConvention";

/** The effective beta curve of an nmd-b position under the base scenario's set. */
function effectiveSCurve(p: Position, book: PortfolioSpec, set: AssumptionSet | undefined): BetaSCurveParams {
  if (p.terms.type !== "nmd-b") throw new Error(`effectiveSCurve: position "${p.id}" is not nmd-b`);
  return governingDepositBeta(p, book, set)?.params ?? p.terms.sCurve;
}

/**
 * The modelled beta at r0 of an nmd-b position: the effective S-curve at r0 percent, or, for a full form (teach
 * slice C4), beta_eff at the form's own base state, which is the state its paid rate starts from.
 */
function modelledBetaAtR0(p: Position, book: PortfolioSpec, set: AssumptionSet | undefined, r0: number): number {
  const overlay = p.terms.type === "nmd-b" ? governingDepositBeta(p, book, set) : undefined;
  if (overlay?.fullForm !== undefined) return baseState(overlay.params, overlay.fullForm).betaEff;
  return betaAtRate(r0 * 100, effectiveSCurve(p, book, set));
}

/**
 * The run's r0 and its beta-at-r0 reader for the nmd-b positions of `book`: r0
 * is the base scenario's deterministic path at step 0, and the reader returns
 * each position's effective beta curve at r0 in percent. Shared by the
 * regulatory transform and the next-reset ladder, so both read one
 * beta.
 */
export function runBetaAtR0(
  book: PortfolioSpec,
  request: RunRequest,
  baseScenario: Scenario,
  setById: ReadonlyMap<string, AssumptionSet>,
  curves: CurveService,
  ratePaths: RatePathRegistry,
): { r0: number; betaAtR0: (p: Position) => number } {
  const path = ratePaths.get("deterministic")(curves.build(request.marketSnapshot), baseScenario, request.grid.horizonMonths);
  const r0 = path.rateAt(0);
  const set = setById.get(baseScenario.assumptionSetId);
  return { r0, betaAtR0: (p) => modelledBetaAtR0(p, book, set, r0) };
}

/** Apply the regulatory convention to the run's book, deriving r0 and the betas from the run. */
export function regulatoryBook(
  book: PortfolioSpec,
  request: RunRequest,
  baseScenario: Scenario,
  setById: ReadonlyMap<string, AssumptionSet>,
  curves: CurveService,
  ratePaths: RatePathRegistry,
): { book: PortfolioSpec; parentOf: Record<string, string> } {
  const { r0, betaAtR0 } = runBetaAtR0(book, request, baseScenario, setById, curves, ratePaths);
  // A full-form deposit is marked "frozen" and left whole; every other deposit splits as before.
  const marked = markFullFormBook(book, setById.get(baseScenario.assumptionSetId), "frozen");
  return applyRegulatoryConvention(marked, REGULATORY_CONVENTION_DEFAULTS, r0, betaAtR0);
}

/**
 * The shocked-level convention on a book that also holds deposits without the full form.
 * The full-form deposits are marked "shocked-level" and stay whole; every other deposit is split by the regulatory
 * transform exactly as `regulatoryBook` splits it, the same r0, the same betas and the same four parameters, so a
 * frozen and a shocked-level run of one book differ in their full-form deposits only. A book whose deposits all carry
 * the form is returned as marked, with no split and no child map, so it walks exactly as before.
 */
export function shockedLevelBook(
  book: PortfolioSpec,
  request: RunRequest,
  baseScenario: Scenario,
  setById: ReadonlyMap<string, AssumptionSet>,
  curves: CurveService,
  ratePaths: RatePathRegistry,
): { book: PortfolioSpec; parentOf: Record<string, string> } {
  const marked = markFullFormBook(book, setById.get(baseScenario.assumptionSetId), "shocked-level");
  if (!hasUnslottedDeposit(marked)) return { book: marked, parentOf: {} };
  const { r0, betaAtR0 } = runBetaAtR0(marked, request, baseScenario, setById, curves, ratePaths);
  return applyRegulatoryConvention(marked, REGULATORY_CONVENTION_DEFAULTS, r0, betaAtR0);
}
