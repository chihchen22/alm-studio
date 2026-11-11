/**
 * Stochastic Compare. This reader works over two stored
 * StochasticRunResult envelopes and nothing else: it aligns them,
 * derives every B - A and one standard-error figure, and computes no
 * simulation number. A distribution here is a statistic of the Monte Carlo
 * path set, never an EVE or an NII.
 *
 * Draw order, which motivates the shared-seed-unaligned-paths basis: the
 * kernel simulator (simulateHw.ts) draws its normals step by step across all
 * antithetic pairs, so pair j at step k is draw number k * nPairs + j. One seed
 * therefore shares random numbers path by path only when nPaths is equal. The
 * BGM simulator (simulateBgm.ts) follows the same alignment rule with two
 * normals per pair per step, so a BGM pair on one seed and one nPaths also
 * shares random numbers and keeps the shared-seed bases.
 *
 * A pair of different rate models shares no
 * draws under any seed, so it reads the basis `different-models` (checked after
 * `same-run`, before the seed test) and gains one note naming both models. A
 * pair of one model is unchanged byte for byte.
 */
import type {
  StochasticDistribution,
  StochasticModel,
  StochasticRunResult,
} from "../contracts/stochastic";
import {
  contextValues,
  statRows,
  type StochasticContextValue,
  type StochasticStat,
} from "./stochasticFields";

export type { StochasticContextValue, StochasticStat } from "./stochasticFields";

/** One side of a stochastic compare: the stored envelope plus platform metadata. */
export interface StochasticCompareSide {
  envelope: StochasticRunResult;
  /** Platform metadata read from the run's submission, not a result number. */
  portfolioId?: string;
  marketId?: string;
}

/** One statistic of the two runs; delta = b - a, derived. */
export interface StochasticStatRow {
  stat: StochasticStat;
  /** Cumulative probability for a quantile row, otherwise null. */
  p: number | null;
  a: number;
  b: number;
  /** b - a, derived from the two stored values. */
  delta: number;
}

/** How the standard-error figure for the B - A of the means was obtained. */
export type MeanDeltaBasis =
  | "same-run"
  | "independent-seeds"
  | "shared-seed-bound"
  | "shared-seed-unaligned-paths"
  /** The runs use different rate models, so they share no draws. */
  | "different-models";

export interface StochasticDistributionCompare {
  rows: StochasticStatRow[];
  meanDeltaStandardError: {
    value: number | null;
    basis: MeanDeltaBasis;
    text: string;
  };
}

/** One like-for-like field; `same` is strict equality, no tolerance. */
export interface StochasticContextRow {
  field: string;
  a: StochasticContextValue;
  b: StochasticContextValue;
  same: boolean;
}

export interface StochasticCompare {
  kind: "stochastic-compare";
  runA: string;
  runB: string;
  sameRun: boolean;
  context: StochasticContextRow[];
  eveDistribution: StochasticDistributionCompare;
  nii12mDistribution: StochasticDistributionCompare;
  notes: string[];
}

/** A pair that fails a semantic check; the message is shown verbatim. */
export class StochasticCompareError extends Error {
  readonly field: string;
  readonly a: string | number;
  readonly b: string | number;
  constructor(message: string, field: string, a: string | number, b: string | number) {
    super(message);
    this.name = "StochasticCompareError";
    this.field = field;
    this.a = a;
    this.b = b;
  }
}

const FIGURE_HEAD =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors.";
const FIGURE_TAIL = "It is a precision figure, not a test.";

const TEXT_INDEPENDENT = `${FIGURE_HEAD} The runs use different seeds, so their path sets are treated as independent and the figure is the standard error of the difference. ${FIGURE_TAIL}`;
const TEXT_BOUND = `${FIGURE_HEAD} Both runs use the same seed and the same path count, so their paths share random numbers. The figure is an upper bound on the standard error of the difference only if the two runs' path outcomes are non-negatively correlated; that is typical when paths share random numbers, but the stored statistics cannot confirm it, because per-path values are not stored. ${FIGURE_TAIL}`;
const TEXT_UNALIGNED = `${FIGURE_HEAD} Both runs use the same seed but different path counts. The simulation draws its random numbers step by step across all paths, so with different path counts the two path sets do not line up path by path. The figure is therefore neither the exact standard error of the difference nor a proven bound on it; it holds only under an independence assumption that the stored statistics cannot confirm, because per-path values are not stored. ${FIGURE_TAIL}`;
const TEXT_SAME_RUN =
  "Run A and run B are the same run, so every B - A is zero by construction and no standard-error figure applies.";
/** Spec v2 decision 94, verbatim. */
const TEXT_DIFFERENT_MODELS =
  "The two runs use different rate models whose simulators draw their random numbers differently (Hull-White one normal per antithetic pair per step, BGM two), so their path sets share no draws even under one seed and one path count. The figure sqrt(SE A^2 + SE B^2) is the standard error of the difference under independence, which the stored statistics cannot confirm, because per-path values are not stored. It is a precision figure, not a test.";

const NOTES: readonly string[] = [
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every B - A is derived by the server from the two stored envelopes, displayed beside both originals.",
  "The B - A of a quantile is the difference of the two runs' quantiles. It is not a quantile of the path-by-path difference: per-path values are not stored, so no distribution of B - A exists and none is shown.",
  "The B - A of the standard deviation, the standard error, the minimum and the maximum is a difference of two estimates, each from its own path set; it carries sampling error of its own that the envelopes do not report.",
];
const NOTE_NPATHS =
  "The two runs use different path counts, so each statistic is estimated at its own precision; the B - A of a quantile, and most of all of the minimum and the maximum, which widen with the path count, mixes the change between the runs with the change in sample size.";

const MODEL_NAMES: Record<StochasticModel, string> = {
  "hull-white-1f": "the Hull-White one-factor rate model",
  "bgm-lmm-2f": "the BGM rate model",
};
/** The one note a pair of different models gains, naming both models. */
const noteModels = (a: StochasticModel, b: StochasticModel): string =>
  `Run A uses ${MODEL_NAMES[a]} (${a}) and run B ${MODEL_NAMES[b]} (${b}), so every B - A carries the change of model as well as any other change between the runs.`;

function pList(d: StochasticDistribution): number[] {
  return d.quantiles.map((q) => q.p);
}

function sameList(x: number[], y: number[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function checkKind(a: StochasticRunResult, b: StochasticRunResult): void {
  for (const e of [a, b]) {
    if (e.kind !== "stochastic-distribution") {
      throw new StochasticCompareError(
        `stochastic compare: run "${e.runId}" is not a stochastic distribution envelope (kind ${String(e.kind)})`,
        "kind",
        String(a.kind),
        String(b.kind),
      );
    }
  }
}

function checkQuantiles(
  a: StochasticRunResult,
  b: StochasticRunResult,
  pick: (e: StochasticRunResult) => StochasticDistribution,
): void {
  const pa = pList(pick(a));
  const pb = pList(pick(b));
  if (!sameList(pa, pb)) {
    throw new StochasticCompareError(
      `stochastic compare: runs "${a.runId}" and "${b.runId}" report different quantile sets (${pa.join(", ")} and ${pb.join(", ")}); a quantile compares only with the quantile at the same p.`,
      "quantiles",
      pa.join(", "),
      pb.join(", "),
    );
  }
}

function ctx(
  field: string,
  a: StochasticContextValue,
  b: StochasticContextValue,
): StochasticContextRow {
  return { field, a, b, same: a === b };
}

function buildContext(sa: StochasticCompareSide, sb: StochasticCompareSide): StochasticContextRow[] {
  const va = contextValues(sa.envelope, sa);
  const vb = contextValues(sb.envelope, sb);
  return va.map((x, i) => ctx(x.field, x.value, vb[i]!.value));
}

function row(stat: StochasticStat, p: number | null, a: number, b: number): StochasticStatRow {
  return { stat, p, a, b, delta: b - a };
}

function buildRows(da: StochasticDistribution, db: StochasticDistribution): StochasticStatRow[] {
  const ra = statRows(da);
  const rb = statRows(db);
  return ra.map((x, i) => row(x.stat, x.p, x.value, rb[i]!.value));
}

function buildDistribution(
  a: StochasticRunResult,
  b: StochasticRunResult,
  da: StochasticDistribution,
  db: StochasticDistribution,
): StochasticDistributionCompare {
  let basis: MeanDeltaBasis;
  let text: string;
  if (a.runId === b.runId) {
    basis = "same-run";
    text = TEXT_SAME_RUN;
  } else if (a.model !== b.model) {
    basis = "different-models";
    text = TEXT_DIFFERENT_MODELS;
  } else if (a.seed !== b.seed) {
    basis = "independent-seeds";
    text = TEXT_INDEPENDENT;
  } else if (a.nPaths === b.nPaths) {
    basis = "shared-seed-bound";
    text = TEXT_BOUND;
  } else {
    basis = "shared-seed-unaligned-paths";
    text = TEXT_UNALIGNED;
  }
  const value =
    basis === "same-run"
      ? null
      : Math.sqrt(da.standardError * da.standardError + db.standardError * db.standardError);
  return { rows: buildRows(da, db), meanDeltaStandardError: { value, basis, text } };
}

/**
 * Aligns two stored stochastic envelopes. Refuses (StochasticCompareError) a
 * side that is not a stochastic envelope, a horizon or discount-basis mismatch,
 * and differing quantile sets; shows, never refuses, every other difference.
 */
export function compareStochastic(
  a: StochasticCompareSide,
  b: StochasticCompareSide,
): StochasticCompare {
  const ea = a.envelope;
  const eb = b.envelope;
  checkKind(ea, eb);
  if (ea.horizonMonths !== eb.horizonMonths) {
    throw new StochasticCompareError(
      `stochastic compare: runs "${ea.runId}" and "${eb.runId}" differ in horizonMonths (${ea.horizonMonths} and ${eb.horizonMonths}). The horizon bounds the cash flows each path's EVE discounts, so the two distributions measure different quantities and no B - A is defined; run both on one horizon.`,
      "horizonMonths",
      ea.horizonMonths,
      eb.horizonMonths,
    );
  }
  if (ea.discountBasis !== eb.discountBasis) {
    throw new StochasticCompareError(
      `stochastic compare: runs "${ea.runId}" and "${eb.runId}" differ in discountBasis ("${ea.discountBasis}" and "${eb.discountBasis}"). The basis sets the discount curve of every path's EVE, so the two distributions measure different quantities and no B - A is defined; run both on one basis.`,
      "discountBasis",
      ea.discountBasis,
      eb.discountBasis,
    );
  }
  checkQuantiles(ea, eb, (e) => e.eveDistribution);
  checkQuantiles(ea, eb, (e) => e.nii12mDistribution);

  const notes = [...NOTES];
  if (ea.nPaths !== eb.nPaths) notes.push(NOTE_NPATHS);
  if (ea.model !== eb.model) notes.push(noteModels(ea.model, eb.model));

  return {
    kind: "stochastic-compare",
    runA: ea.runId,
    runB: eb.runId,
    sameRun: ea.runId === eb.runId,
    context: buildContext(a, b),
    eveDistribution: buildDistribution(ea, eb, ea.eveDistribution, eb.eveDistribution),
    nii12mDistribution: buildDistribution(ea, eb, ea.nii12mDistribution, eb.nii12mDistribution),
    notes,
  };
}
