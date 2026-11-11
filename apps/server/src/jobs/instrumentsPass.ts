/**
 * The per-position results pass (F6).
 *
 * A run keeps no per-position output: the static pass folds every position into
 * a cell series and forgets it (position.ts, run/shard/chunk.ts). When the
 * submission asked for instrument results, the runner calls this pass AFTER
 * result.json (and rates.json) are on disk. It recomputes each position on the
 * very books, rate paths and curve legs the run walked (the engine's
 * onInstrumentEnvironment seam hands them over) and writes one more run file,
 * instruments.json, of scalar rows per position per scenario.
 *
 * The arithmetic is the run's own, copied at the seams rather than reinvented:
 *
 *   cash flows   makeInstrument(terms).generateCashflows(path)
 *   bucketing    bucket = monthOffset - 1 + seasoning offset, truncated at the
 *                horizon (run/shard/chunk.ts), so positions sum to the family
 *                rows of cashflows.byFamily within float summation order
 *   PV           sum over buckets of df((k + 1) / 12) x (principal + interest),
 *                on the scenario's shocked curve and the run's discount basis
 *                (eve/pv.ts), a swap on the risk-free curve, an
 *                off-balance-sheet commitment at 0 (it has no PV), and a
 *                balance held at book (non-rate-sensitive) at par, its opening
 *                balance, in every scenario: the value EVE gives the family
 *                (eve/computeEve.ts), so the rows sum to EVE family by family
 *                (ruling 2026-11-04, Spec P1; file schema 1.1.0)
 *   NII          side-signed interest over the first 12 buckets (nii/computeNII.ts)
 *   first reset  the first nonzero bucket of the repricing ladder the gap fold
 *                builds for the position (gap/gapEngine.ts), so a position kept
 *                off the ladder by repricingTreatment "excluded" has none
 *
 * Two things the rows are NOT. They are the existing book's runoff under each
 * scenario: a dynamic scenario's new business belongs to no existing position,
 * so for such a scenario the rows sum to the contractual series, not to the
 * published NII family rows. And they carry the SEG scalars of the base
 * scenario only, from the block the run already computed.
 *
 * The file's schema is 1.1.0 since the par value for a balance held at book. A file of schema 1.0.0, written before,
 * keeps its rows as they are: a balance held at book reads pv 0 there, and the Studio says so in one line. The
 * engine's contract type still names "1.0.0" (the engine is not changed in this slice), so the server's constant
 * INSTRUMENTS_FILE_SCHEMA_VERSION is what a written file carries.
 *
 * A failure here never fails the run: landInstrumentsFile catches it, writes the
 * line `instruments-pass-failed` to the run log and returns false, and the child
 * goes on to report done. result.json is not touched by this module.
 */
import { join } from "node:path";
import type {
  InstrumentEnvironment,
  InstrumentRow,
  InstrumentScenarioRow,
  InstrumentsFile,
  PortfolioSpec,
  Position,
  ProductFamilyDef,
  RunRequest,
  RunResult,
} from "@alm/engine";
import type { PositionSegRow } from "@alm/engine";
import { INSTRUMENTS_SCHEMA_VERSION } from "@alm/engine";
import { isCommitmentFamily } from "@alm/engine/src/commitment/offBalanceSheet";
import { discountFunction, spreadDiscountCache } from "@alm/engine/src/eve/discount";
import { accumulateGapPosition } from "@alm/engine/src/gap";
import { seasoningOffsetOf } from "@alm/engine/src/portfolio/seasoning";
import { makeInstrument } from "@alm/engine/src/runtime/instrumentFactory";
import { shockedCurve } from "@alm/engine/src/scenario/rateEnvironment";
import { isDerivativeFamily } from "@alm/engine/src/swap/derivatives";
import { isNonRateFamily } from "@alm/engine/src/nonRate";
import { writeFileAtomic } from "../store/store";
import type { RunEvent } from "./types";

/** F6: the 60-month SEG and EBP arrays ride on a row only when the book is at most this large. */
export const INSTRUMENT_SERIES_MAX_POSITIONS = 100;

/** The months the scalar columns cover: nii12, balance12 and principal12 read months 1 to 12. */
const SCALAR_MONTHS = 12;

export interface InstrumentsPassOptions {
  /** Chart of accounts node ids; a position is kept when its node is one of them or lies beneath one. Absent or empty keeps every position. */
  coaNodeIds?: readonly string[];
}

/** The ids of the named nodes and every node beneath them, refusing a name the chart does not carry. */
function coaNodeClosure(book: PortfolioSpec, coaNodeIds: readonly string[]): Set<string> {
  const known = new Set(book.coa.nodes.map((n) => n.id));
  for (const id of coaNodeIds) {
    if (!known.has(id)) {
      throw new Error(
        `instrumentResults.coaNodeIds names "${id}", which is not a node of the chart of accounts of portfolio "${book.id}"`,
      );
    }
  }
  const childrenOf = new Map<string, string[]>();
  for (const n of book.coa.nodes) {
    if (n.parentId === null) continue;
    const list = childrenOf.get(n.parentId);
    if (list === undefined) childrenOf.set(n.parentId, [n.id]);
    else list.push(n.id);
  }
  const out = new Set<string>();
  const stack = [...coaNodeIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return out;
}

/**
 * The schema of the file this pass writes: the engine's INSTRUMENTS_SCHEMA_VERSION, 1.1.0 (Spec P1): a balance held
 * at book is valued at par. A 1.0.0 file, written before, reads 0 for it. Slice K1 widened the engine's type to both,
 * so no cast is needed.
 */
export const INSTRUMENTS_FILE_SCHEMA_VERSION = INSTRUMENTS_SCHEMA_VERSION;

function assertFinite(value: number, positionId: string, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `instruments pass: position "${positionId}" produced a non-finite ${field} (${String(value)}); ` +
        `no file is written rather than one carrying a number that is not a number`,
    );
  }
  return value;
}

/** Side-signed NII sign by family side, as nii/computeNII.ts rowFields: asset +, derivative +, liability -, equity 0. */
function niiSign(family: ProductFamilyDef): number {
  if (family.side === "liability") return -1;
  if (family.side === "asset" || (family.side as string) === "derivative") return 1;
  return 0;
}

function notionalOf(pos: Position): number {
  const n = (pos.terms as { notional?: number }).notional;
  return typeof n === "number" ? n : 0;
}

/**
 * Build the per-position results file.
 *
 * `book` is the effective base-scenario book (it fixes the row order and the
 * row metadata); `environment` supplies each scenario's own effective book, rate
 * path and the curve legs. `perPositionSeg` is the SEG block's per-position rows
 * and defaults to the environment's. Pure over its inputs: no clock, no I/O.
 */
export function buildInstrumentsFile(
  request: RunRequest,
  book: PortfolioSpec,
  result: RunResult,
  perPositionSeg: ReadonlyMap<string, PositionSegRow> | undefined,
  environment: InstrumentEnvironment,
  options: InstrumentsPassOptions = {},
): InstrumentsFile {
  const seg = perPositionSeg ?? environment.perPositionSeg;
  if (result.seg !== undefined && seg === undefined) {
    throw new Error("instruments pass: the run carries a seg block but no per-position SEG rows were handed over");
  }
  const horizon = result.cashflows.grid.horizonMonths;
  const scalarMonths = Math.min(SCALAR_MONTHS, horizon);
  const basis = environment.discountBasis;
  const factoryOptions =
    environment.rateIndices === undefined && environment.macro === undefined
      ? undefined
      : { rateIndices: environment.rateIndices, macro: environment.macro };
  // On a run that named nmdWarmup, each scenario's deposits are rebuilt on that scenario's history, the one
  // the projection used, so a deposit row sums to its family. Absent, every scenario uses factoryOptions as before.
  const warmups = environment.nmdWarmupByScenario;
  // On a run whose sets bind a full beta form, each scenario's deposits also read its shift.
  const shifts = environment.depositShiftByScenario;
  const optionsByScenario = request.scenarios.map((s) => {
    const nmdWarmup = warmups?.get(s.id);
    const depositShiftPct = shifts?.get(s.id);
    if (depositShiftPct !== undefined) return { rateIndices: environment.rateIndices, macro: environment.macro, nmdWarmup, depositShiftPct };
    return nmdWarmup === undefined ? factoryOptions : { rateIndices: environment.rateIndices, macro: environment.macro, nmdWarmup };
  });
  const familyOf = new Map<string, ProductFamilyDef>(book.coa.families.map((f) => [f.id, f]));
  const keep =
    options.coaNodeIds !== undefined && options.coaNodeIds.length > 0
      ? coaNodeClosure(book, options.coaNodeIds)
      : undefined;
  const withSeries = book.positions.length <= INSTRUMENT_SERIES_MAX_POSITIONS;

  // One discount function per scenario per distinct spread, built on first use.
  const scenarioDf = request.scenarios.map((scenario) => {
    const curve = shockedCurve(environment.baseCurve, scenario.rateSpec);
    return {
      scenarioId: scenario.id,
      forPosition: spreadDiscountCache(curve, environment.tlp, 0, basis),
      riskFree: discountFunction(curve, environment.tlp, 0, "risk-free"),
    };
  });
  const booksByScenario = request.scenarios.map((scenario) => {
    const scoped = environment.booksBySet.get(scenario.assumptionSetId);
    if (scoped === undefined) {
      throw new Error(
        `instruments pass: scenario "${scenario.id}" references assumption set "${scenario.assumptionSetId}", ` +
          `which the run did not overlay`,
      );
    }
    return scoped;
  });
  const pathsByScenario = request.scenarios.map((scenario) => {
    const path = environment.ratePaths.get(scenario.id);
    if (path === undefined) {
      throw new Error(`instruments pass: the run kept no rate path for scenario "${scenario.id}"`);
    }
    return path;
  });
  const baseIndex = Math.max(
    0,
    request.scenarios.findIndex((s) => s.id === environment.baseScenarioId),
  );

  const positions: InstrumentRow[] = [];
  for (let pi = 0; pi < book.positions.length; pi++) {
    const pos = book.positions[pi]!;
    if (keep !== undefined && !keep.has(pos.coaNodeId)) continue;
    const family = familyOf.get(pos.familyId);
    if (family === undefined) {
      throw new Error(`instruments pass: position "${pos.id}" names family "${pos.familyId}", which the chart of accounts does not declare`);
    }
    const sign = niiSign(family);
    const offBalance = isCommitmentFamily(family);
    const derivative = isDerivativeFamily(family);
    const heldAtBook = isNonRateFamily(family);

    const byScenario: InstrumentScenarioRow[] = [];
    let walMonths: number | undefined;
    let firstRepricingMonth: number | null = null;
    for (let si = 0; si < request.scenarios.length; si++) {
      const scoped = booksByScenario[si]!.positions[pi];
      if (scoped === undefined || scoped.id !== pos.id) {
        throw new Error(
          `instruments pass: the effective book of scenario "${request.scenarios[si]!.id}" does not hold position "${pos.id}" at index ${pi}`,
        );
      }
      const path = pathsByScenario[si]!;
      // This scenario's options: the run's factoryOptions, plus its deposit history when the run named nmdWarmup.
      const scenarioOptions = optionsByScenario[si];
      const inst = makeInstrument(scoped.terms, scenarioOptions);
      const cfs = inst.generateCashflows(path);
      const off = seasoningOffsetOf(scoped.terms);
      const balance = new Float64Array(horizon);
      const principal = new Float64Array(horizon);
      const interest = new Float64Array(horizon);
      for (const cf of cfs) {
        const k = cf.monthOffset - 1 + off;
        if (k < 0 || k >= horizon) continue;
        balance[k]! += cf.balance;
        principal[k]! += cf.principalPaid;
        interest[k]! += cf.interestPaid;
      }

      let pv = 0;
      if (heldAtBook) {
        // Spec P1: at par, the opening balance, as EVE values the family (computeEve.ts reads series.balance[0]).
        pv = balance[0]!;
      } else if (!offBalance) {
        const df = derivative ? scenarioDf[si]!.riskFree : scenarioDf[si]!.forPosition(scoped);
        for (let k = 0; k < horizon; k++) pv += df((k + 1) / 12) * (principal[k]! + interest[k]!);
      }
      let nii12 = 0;
      let principal12 = 0;
      for (let k = 0; k < scalarMonths; k++) {
        nii12 += interest[k]!;
        principal12 += principal[k]!;
      }
      byScenario.push({
        scenarioId: request.scenarios[si]!.id,
        pv: assertFinite(pv, pos.id, "pv"),
        nii12: assertFinite(sign * nii12 + 0, pos.id, "nii12"),
        balance12: assertFinite(balance[scalarMonths - 1]!, pos.id, "balance12"),
        principal12: assertFinite(principal12, pos.id, "principal12"),
      });

      if (si === baseIndex) {
        let total = 0;
        let weighted = 0;
        for (let k = 0; k < horizon; k++) {
          total += principal[k]!;
          weighted += (k + 1) * principal[k]!;
        }
        if (total > 0) walMonths = assertFinite(weighted / total, pos.id, "walMonths");
        const ladder = { repricing: [new Float64Array(horizon)], principal: [new Float64Array(horizon)] };
        accumulateGapPosition(ladder, 0, inst, cfs, horizon, path, scoped.repricingTreatment === "excluded");
        for (let k = 0; k < horizon; k++) {
          if (ladder.repricing[0]![k] !== 0) {
            firstRepricingMonth = k + 1;
            break;
          }
        }
      }
    }

    const segRow = seg?.get(pos.id);
    const row: InstrumentRow = {
      positionId: pos.id,
      ...(pos.parentPositionId !== undefined ? { parentPositionId: pos.parentPositionId } : {}),
      familyId: pos.familyId,
      coaNodeId: pos.coaNodeId,
      side: derivative ? "derivative" : family.side === "liability" ? "liability" : "asset",
      type: String(pos.terms.type),
      notional: notionalOf(pos),
      dimensions: { ...(pos.dimensions ?? {}) },
      ...(pos.discountSpreadBp !== undefined ? { discountSpreadBp: pos.discountSpreadBp } : {}),
      ...(walMonths !== undefined ? { walMonths } : {}),
      firstRepricingMonth,
      byScenario,
      ...(segRow !== undefined
        ? {
            seg: {
              niiBase12: assertFinite(segRow.niiBase12, pos.id, "seg.niiBase12"),
              niiUp12: assertFinite(segRow.niiUp12, pos.id, "seg.niiUp12"),
              niiDown12: assertFinite(segRow.niiDown12, pos.id, "seg.niiDown12"),
              segPeak: assertFinite(segRow.segPeak, pos.id, "seg.segPeak"),
              ...(withSeries ? { segOutstanding: [...segRow.segOutstanding], ebp: [...segRow.ebp] } : {}),
            },
          }
        : {}),
    };
    positions.push(row);
  }

  return {
    // The engine's contract type names "1.0.0"; the file carries the server's 1.1.0 (see the header).
    schemaVersion: INSTRUMENTS_FILE_SCHEMA_VERSION,
    runId: request.runId,
    asOf: request.grid.asOf,
    horizonMonths: horizon,
    discountBasis: basis,
    scenarios: request.scenarios.map((s) => s.id),
    positions,
  };
}

export interface LandInstrumentsArgs {
  runDir: string;
  request: RunRequest;
  result: RunResult;
  /** What the engine seam handed over; undefined when the seam never fired. */
  environment: InstrumentEnvironment | undefined;
  /** The engine's own error when it could not build the environment (a plan with no RatePath for a scenario). */
  environmentError?: Error;
  settings: InstrumentsPassOptions;
  emit: (event: RunEvent) => void;
  /** Injection point for tests; the runner uses the real builder. */
  build?: typeof buildInstrumentsFile;
}

/**
 * Build and write instruments.json beside result.json. Returns true when the
 * file landed. Any failure is caught, reported as a run-log line starting
 * `instruments-pass-failed`, and returned as false: the run is not failed by it
 * and result.json is never touched.
 */
export function landInstrumentsFile(args: LandInstrumentsArgs): boolean {
  try {
    const { environment } = args;
    if (environment === undefined) {
      if (args.environmentError !== undefined) throw args.environmentError;
      throw new Error("the engine never handed over the run environment, so there is nothing to project the positions on");
    }
    const baseSet = args.request.scenarios.find((s) => s.id === environment.baseScenarioId)?.assumptionSetId;
    const book = baseSet === undefined ? undefined : environment.booksBySet.get(baseSet);
    if (book === undefined) {
      throw new Error(`the run did not overlay the base scenario's assumption set "${String(baseSet)}"`);
    }
    const build = args.build ?? buildInstrumentsFile;
    const file = build(args.request, book, args.result, environment.perPositionSeg, environment, args.settings);
    writeFileAtomic(join(args.runDir, "instruments.json"), `${JSON.stringify(file)}\n`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    args.emit({ t: "log", line: `instruments-pass-failed: ${message}` });
    return false;
  }
}
