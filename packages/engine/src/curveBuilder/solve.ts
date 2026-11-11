/**
 * The curve setup solver.
 *
 * solveNodes turns a validated curveSetup block into continuously compounded
 * zero rates at the node tenors, t in years = node tenor months / 12. A row's
 * node tenor is its tenorMonths, except a futures row, whose node sits at its
 * start plus 3 months.
 *
 * (1) Sequential pass in node order. A direct row (zero rate, discount
 *     factor, cash, bill) writes its node; a par swap row or a futures row
 *     solves its node's z with brentq over [-0.20, 1.00], the interpolator
 *     built over the prior nodes plus the candidate. A futures row reads
 *     DF(start) off that interpolator, so its start must lie at or after the
 *     first node.
 * (2) Polish. With the interpolator over ALL nodes, every par and futures
 *     node is re-solved holding the others (Gauss-Seidel) until the largest
 *     change is below 1e-13, at most 50 passes. Linear-zero and log-linear-df
 *     are local and settle in one pass; cubic-zero and monotone-convex read
 *     neighbours to the right and need the sweep.
 * (3) Warnings. Monthly continuous forwards off the final interpolator, up to
 *     the last node tenor; any below zero give one aggregated warning.
 *
 * Every refusal is a CurveBuildError in words. Only a BrentBracketError from
 * the root find is read as "no zero rate prices this row"; any other throw is
 * a defect and propagates unchanged.
 */
import { brentq, BrentBracketError } from "@alm/kernel";
import type { CurveSetupBlock } from "../contracts/curveSetup";
import { makeZeroInterpolator } from "./interpolators";
import {
  futuresResidual,
  nodeTenorMonths,
  parResidual,
  rowEquation,
  rowName,
  RowRefusal,
  type RowEquation,
} from "./rowDiscount";
import { CURVE_INSTRUMENTS, CURVE_INTERPOLATIONS, CURVE_QUOTE_TYPES } from "./validate";

export class CurveBuildError extends Error {
  readonly refusals: string[];
  constructor(refusals: readonly string[]) {
    super(refusals.join("; "));
    this.name = "CurveBuildError";
    this.refusals = [...refusals];
  }
}

export const MAX_POLISH_SWEEPS = 50;
export const POLISH_TOLERANCE = 1e-13;
export const Z_BRACKET: readonly [number, number] = [-0.2, 1.0];
/** brentq tolerances well below the polish tolerance, so the sweep can settle. */
const ROOT_OPTIONS = { xtol: 1e-15, rtol: 1e-15, maxIter: 500 } as const;
/** A monthly forward counts as negative below this, so roundoff on a zero curve stays quiet. */
const NEGATIVE_FORWARD_FLOOR = -1e-12;

export interface SolveOptions {
  /**
   * Test hook: the polish pass limit. Left out, it is MAX_POLISH_SWEEPS (50);
   * a test passes a lower limit to reach the refusal. Production callers omit it.
   * Clamped to a whole number of at least 1 (0, a negative or a fraction below 1
   * reads as 1; 1.9 as 1); NaN or an infinite value reads as left out.
   */
  readonly maxSweeps?: number;
}

/** The polish pass limit a SolveOptions value gives (see SolveOptions.maxSweeps). */
const sweepLimit = (raw: number | undefined): number =>
  raw === undefined || !Number.isFinite(raw) ? MAX_POLISH_SWEEPS : Math.max(1, Math.floor(raw));

/** Refuse an interpolation off the menu in words, before any interpolator is built. */
function checkInterpolation(block: CurveSetupBlock): void {
  if (!(CURVE_INTERPOLATIONS as readonly string[]).includes(block.interpolation)) {
    throw new CurveBuildError([
      `interpolation must be one of ${CURVE_INTERPOLATIONS.join(", ")}; got ${JSON.stringify(String(block.interpolation))}`,
    ]);
  }
}

export interface SolvedNodes {
  t: number[];
  z: number[];
  warnings: string[];
}

function guard(block: CurveSetupBlock): void {
  checkInterpolation(block);
  const rows = block.inputs;
  if (rows.length === 0) throw new CurveBuildError(["setup holds 0 rows; at least one is needed"]);
  const refusals: string[] = [];
  rows.forEach((row, i) => {
    const n = i + 1;
    // A block that skipped the validator: an instrument or quote type off the menu is refused in words,
    // never solved as a par row.
    if (!(CURVE_INSTRUMENTS as readonly string[]).includes(row.instrument)) {
      refusals.push(`row ${n} instrument must be one of ${CURVE_INSTRUMENTS.join(", ")}; got ${JSON.stringify(String(row.instrument))}`);
    }
    if (!(CURVE_QUOTE_TYPES as readonly string[]).includes(row.quoteType)) {
      refusals.push(`row ${n} quoteType must be one of ${CURVE_QUOTE_TYPES.join(", ")}; got ${JSON.stringify(String(row.quoteType))}`);
    }
    if (!Number.isFinite(row.value)) refusals.push(`row ${n} value is not a finite number`);
    if (row.convexityBp !== undefined && !Number.isFinite(row.convexityBp)) {
      refusals.push(`row ${n} convexityBp is not a finite number`);
    }
    const node = nodeTenorMonths(row);
    if (!(Number.isFinite(row.tenorMonths) && row.tenorMonths > 0)) {
      refusals.push(`row ${n} tenor must be a positive number of months; got ${row.tenorMonths}`);
    } else if (i > 0 && !(node > nodeTenorMonths(rows[i - 1]))) {
      refusals.push(
        `rows must be strictly ascending by tenor; row ${n} at ${node} months follows ${nodeTenorMonths(rows[i - 1])} months`,
      );
    }
  });
  if (refusals.length > 0) throw new CurveBuildError(refusals);
}

/**
 * A futures row reads DF(start) off the nodes, so some other node must sit at
 * or before its start; and 1 + F accrual must be positive, or DF(end) is not.
 */
function checkFutures(rows: CurveSetupBlock["inputs"], eqs: readonly RowEquation[]): void {
  const refusals: string[] = [];
  eqs.forEach((eq, i) => {
    if (eq.kind !== "futures") return;
    const n = i + 1;
    // Rows ascend by node and this row's node is past its start, so only an earlier row can qualify.
    if (i === 0 || nodeTenorMonths(rows[0]) > rows[i].tenorMonths) {
      refusals.push(`row ${n} futures start precedes the first quote`);
    }
    if (!(1 + eq.forward * eq.accrual > 0)) {
      refusals.push(`row ${n} futures price gives a non-positive discount factor`);
    }
  });
  if (refusals.length > 0) throw new CurveBuildError(refusals);
}

export function solveNodes(block: CurveSetupBlock, options: SolveOptions = {}): SolvedNodes {
  guard(block);
  const maxSweeps = sweepLimit(options.maxSweeps);
  const rows = block.inputs;
  const n = rows.length;
  const t = rows.map((r) => nodeTenorMonths(r) / 12);

  let eqs: RowEquation[];
  try {
    eqs = rows.map((r) => rowEquation(r, block));
  } catch (e) {
    if (e instanceof RowRefusal) throw new CurveBuildError([e.message]);
    throw e;
  }
  checkFutures(rows, eqs);

  const z = new Array<number>(n).fill(0);

  /** Solve node i's z (a par or futures row) with the interpolator over nodes 0..last (candidate at i). */
  const solveNode = (i: number, last: number): number => {
    const eq = eqs[i] as Exclude<RowEquation, { kind: "direct" }>;
    const tt = t.slice(0, last + 1);
    const zz = z.slice(0, last + 1);
    const residual = (zc: number): number => {
      zz[i] = zc;
      const zf = makeZeroInterpolator(block.interpolation, tt, zz);
      const df = (u: number): number => Math.exp(-zf(u) * u);
      return eq.kind === "futures" ? futuresResidual(eq, t[i], df) : parResidual(eq, rows[i].value, t[i], df);
    };
    let zi: number;
    try {
      zi = brentq(residual, Z_BRACKET[0], Z_BRACKET[1], ROOT_OPTIONS);
    } catch (e) {
      if (!(e instanceof BrentBracketError)) throw e;
      throw new CurveBuildError([
        eq.kind === "futures"
          ? `row ${i + 1} futures price has no zero rate between -20 and 100 percent that fits its forward`
          : `${rowName(rows[i])} has no zero rate between -20 and 100 percent that prices it at par`,
      ]);
    }
    // brentq does not detect a NaN residual; a non-finite root is refused, never returned.
    if (!Number.isFinite(zi)) {
      throw new CurveBuildError([
        eq.kind === "futures"
          ? `row ${i + 1} futures price gives a non-positive discount factor`
          : `${rowName(rows[i])} solves to a zero rate that is not a finite number`,
      ]);
    }
    return zi;
  };

  // (1) Sequential pass.
  for (let i = 0; i < n; i++) {
    const eq = eqs[i];
    if (eq.kind === "direct") {
      const zi = -Math.log(eq.df) / t[i];
      if (!Number.isFinite(zi)) {
        throw new CurveBuildError([`${rowName(rows[i])} gives a discount factor of ${eq.df}, which has no zero rate`]);
      }
      z[i] = zi;
    } else {
      z[i] = solveNode(i, i);
    }
  }

  // (2) Polish sweep, Gauss-Seidel over all nodes. Direct nodes do not depend on the others.
  let settled = false;
  for (let sweep = 1; sweep <= maxSweeps; sweep++) {
    let maxDz = 0;
    for (let i = 0; i < n; i++) {
      if (eqs[i].kind === "direct") continue;
      const zi = solveNode(i, n - 1);
      maxDz = Math.max(maxDz, Math.abs(zi - z[i]));
      z[i] = zi;
    }
    if (maxDz < POLISH_TOLERANCE) {
      settled = true;
      break;
    }
  }
  if (!settled) {
    throw new CurveBuildError([
      `the curve did not settle after ${maxSweeps} passes; the quotes may be inconsistent`,
    ]);
  }

  return { t, z, warnings: negativeForwardWarnings(block, t, z) };
}

/**
 * One aggregated warning for monthly continuous forwards below zero, up to the last node tenor
 * (a futures row's node is its start plus 3 months).
 * Exported for buildCurveFromSetup, whose legacy delegate skips solveNodes but warns alike.
 */
export function negativeForwardWarnings(block: CurveSetupBlock, t: number[], z: number[]): string[] {
  checkInterpolation(block);
  const zf = makeZeroInterpolator(block.interpolation, t, z);
  const lastMonth = Math.ceil(Math.max(...block.inputs.map(nodeTenorMonths)));
  let count = 0;
  let first: { k: number; bp: number } | undefined;
  for (let k = 0; k < lastMonth; k++) {
    const t1 = k / 12;
    const t2 = (k + 1) / 12;
    const fwd = (zf(t2) * t2 - zf(t1) * t1) / (t2 - t1);
    if (fwd < NEGATIVE_FORWARD_FLOOR) {
      count++;
      if (first === undefined) first = { k, bp: fwd * 1e4 };
    }
  }
  if (first === undefined) return [];
  return [
    `negative forward of ${first.bp.toFixed(1)} bp between month ${first.k} and month ${first.k + 1} (${count} ${count === 1 ? "interval" : "intervals"})`,
  ];
}
