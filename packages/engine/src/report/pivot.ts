/**
 * The pivot: roll a stored run's cells up along a declared
 * view, on read, without recomputing anything.
 *
 * PURE. It reads a RunResult and returns rows. It never touches an engine, a
 * portfolio or a market snapshot, and it never falls back to the family rows:
 * answering a cell question with a family number would be a wrong answer
 * dressed as a right one. Every refusal is typed and says which of the three
 * things the envelope does not hold.
 *
 * Group order is the view's group order, which is ascending by canonical group
 * key; within a row, cellIds are ascending. Two runs of one query on one
 * envelope are byte-identical.
 */
import type { DimensionId, DimensionValue } from "../contracts/dimensions";
import type { GapBand } from "../contracts/results";
import type { RunResult } from "../contracts/run";

export type PivotMetric =
  | "balance"
  | "principal"
  | "interest" // cashflow series
  | "repricing" // the repricing ladder, at BAND grain
  | "gapPrincipal" // the LIQUIDITY ladder, banded off principal cash flows, at BAND grain
  | "nii" // the additive NII row fields
  /**
   * EVE pv, and the name is narrower than the number. A stored cell pv carries
   * no side (eve/computeEve.ts stores pvBucketedSeries with no sign applied),
   * and a RunResult carries no chart of accounts, so this function has nothing
   * to sign a row with. An `evePv` row's `value` and the result's `total` are
   * the UNSIGNED sum of present values over the group's cells, added across
   * whichever balance-sheet sides the group spans: a group holding both asset
   * and liability cells adds them together. That is not EVE and not a net
   * position. EVE is already on the envelope, as result.eve.byScenario[].eve.
   */
  | "evePv";

export const PIVOT_METRICS: readonly PivotMetric[] = [
  "balance",
  "principal",
  "interest",
  "repricing",
  "gapPrincipal",
  "nii",
  "evePv",
];

export interface PivotQuery {
  viewId: string;
  metric: PivotMetric;
  /**
   * Spec Section 7 types this `ScenarioId`. It is a plain `string` here so the
   * module imports nothing from contracts/ids for one alias that is
   * `export type ScenarioId = string` today; the two are interchangeable and
   * the HTTP route hands over a raw query parameter either way.
   */
  scenarioId: string;
}

export interface PivotRow {
  key: Record<DimensionId, DimensionValue>;
  cellIds: string[];
  positionCount: number;
  /**
   * Bucketed metrics: one number per bucket. Gap metrics: one number per BAND,
   * which is the grain the stored ladder carries and what spec Section 7 states; the
   * result's `bands` says what the positions mean. Absent for scalar metrics.
   */
  series?: number[];
  /**
   * Scalar metrics (evePv): the group's single number, which is the unsigned
   * sum of the group's cell present values and crosses balance-sheet sides
   * wherever the group does. Not EVE, and not a net: EVE is
   * result.eve.byScenario[].eve on the envelope.
   */
  value?: number;
  /** NII only: the additive row fields, summed over the group's cells. */
  nii?: { net12: number; net24: number; interestIncome12: number; interestExpense12: number };
}

export interface PivotResult {
  viewId: string;
  metric: PivotMetric;
  scenarioId: string;
  groupBy: DimensionId[];
  rows: PivotRow[];
  /**
   * The sum over rows, for the reader who wants the reconciliation in hand. For
   * `evePv` that sum is unsigned and runs across both sides of the balance
   * sheet, so it is a gross present value rather than EVE; the envelope's own
   * result.eve.byScenario[].eve is the EVE number.
   */
  total?: number[] | number;
  /** Gap metrics only: the bands the series positions index. */
  bands?: GapBand[];
}

/** The envelope does not carry what was asked. Never a softened or partial answer. */
export class PivotUnavailableError extends Error {
  readonly viewId: string;
  readonly metric: string;
  readonly scenarioId: string;
  readonly detail: string;
  constructor(query: { viewId: string; metric: string; scenarioId: string }, detail: string) {
    super(
      `pivot on view "${query.viewId}", metric "${query.metric}", scenario ` +
        `"${query.scenarioId}" cannot be answered from this run: ${detail}`,
    );
    this.name = "PivotUnavailableError";
    this.viewId = query.viewId;
    this.metric = query.metric;
    this.scenarioId = query.scenarioId;
    this.detail = detail;
  }
}

/** Element-wise add of `src` into `acc`, growing `acc` to the longer length. */
function addInto(acc: number[], src: readonly number[]): void {
  for (let k = 0; k < src.length; k++) acc[k] = (acc[k] ?? 0) + src[k]!;
}

export function pivot(result: RunResult, query: PivotQuery): PivotResult {
  const { viewId, metric, scenarioId } = query;

  if (!PIVOT_METRICS.includes(metric)) {
    throw new PivotUnavailableError(
      query,
      `"${metric}" is not a pivot metric; this run answers ${PIVOT_METRICS.map((m) => `"${m}"`).join(", ")}. ` +
        `FTP rows carry notional-weighted rates and attribution decomposes a headline into drivers, ` +
        `so neither has a cell arm in this piece.`,
    );
  }

  const views = result.views ?? [];
  const view = views.find((v) => v.viewId === viewId);
  if (view === undefined) {
    throw new PivotUnavailableError(
      query,
      views.length === 0
        ? "the run declared no views, so it accumulated at family grain and carries no cells"
        : `the run declares views [${views.map((v) => `"${v.viewId}"`).join(", ")}]`,
    );
  }

  const base = {
    viewId,
    metric,
    scenarioId,
    groupBy: [...view.groupBy],
  };
  const shell = (
    row: Omit<PivotRow, "key" | "cellIds" | "positionCount">,
    g: (typeof view.groups)[number],
  ): PivotRow => ({
    key: { ...g.key },
    cellIds: [...g.cellIds],
    positionCount: g.positionCount,
    ...row,
  });

  // --- Cashflow series -------------------------------------------------------
  if (metric === "balance" || metric === "principal" || metric === "interest") {
    const scn = result.cashflows.byScenario.find((s) => s.scenarioId === scenarioId);
    if (scn === undefined) {
      throw new PivotUnavailableError(
        query,
        scenarioMissing(result.cashflows.byScenario.map((s) => s.scenarioId)),
      );
    }
    if (scn.byCell === undefined) {
      throw new PivotUnavailableError(query, cellArmMissing("cashflows", DYNAMIC_CELL_ABSENCE));
    }
    const byId = new Map(scn.byCell.map((c) => [c.cellId, c]));
    const total: number[] = [];
    const rows = view.groups.map((g) => {
      const acc: number[] = [];
      for (const id of g.cellIds) addInto(acc, cellOr(byId, id, query).series[metric]);
      addInto(total, acc);
      return shell({ series: acc }, g);
    });
    return { ...base, rows, total };
  }

  // --- Gap ladders, at BAND grain -------------------------------------------
  if (metric === "repricing" || metric === "gapPrincipal") {
    const ladders = metric === "repricing" ? result.gap.repricing : result.gap.liquidity;
    const ladder = ladders.find((l) => l.scenarioId === scenarioId);
    if (ladder === undefined) {
      throw new PivotUnavailableError(query, scenarioMissing(ladders.map((l) => l.scenarioId)));
    }
    if (ladder.byCell === undefined) {
      throw new PivotUnavailableError(query, cellArmMissing("gap", STATIC_CARRIER_ABSENCE));
    }
    const byId = new Map(ladder.byCell.map((c) => [c.cellId, c]));
    const total: number[] = [];
    const rows = view.groups.map((g) => {
      const acc: number[] = [];
      for (const id of g.cellIds) {
        const cell = cellOr(byId, id, query);
        for (let b = 0; b < cell.rows.length; b++) acc[b] = (acc[b] ?? 0) + cell.rows[b]!.gap;
      }
      addInto(total, acc);
      return shell({ series: acc }, g);
    });
    return { ...base, rows, total, bands: ladder.rows.map((r) => r.band) };
  }

  // --- NII row fields --------------------------------------------------------
  if (metric === "nii") {
    const scn = result.nii.byScenario.find((s) => s.scenarioId === scenarioId);
    if (scn === undefined) {
      throw new PivotUnavailableError(
        query,
        scenarioMissing(result.nii.byScenario.map((s) => s.scenarioId)),
      );
    }
    if (scn.byCell === undefined) {
      throw new PivotUnavailableError(query, cellArmMissing("nii", DYNAMIC_CELL_ABSENCE));
    }
    const byId = new Map(scn.byCell.map((c) => [c.cellId, c]));
    let total = 0;
    const rows = view.groups.map((g) => {
      const acc = { net12: 0, net24: 0, interestIncome12: 0, interestExpense12: 0 };
      for (const id of g.cellIds) {
        const cell = cellOr(byId, id, query);
        acc.net12 += cell.net12;
        acc.net24 += cell.net24;
        acc.interestIncome12 += cell.interestIncome12;
        acc.interestExpense12 += cell.interestExpense12;
      }
      total += acc.net12;
      return shell({ nii: acc }, g);
    });
    return { ...base, rows, total };
  }

  // --- EVE pv ----------------------------------------------------------------
  const scn = result.eve.byScenario.find((s) => s.scenarioId === scenarioId);
  if (scn === undefined) {
    throw new PivotUnavailableError(
      query,
      scenarioMissing(result.eve.byScenario.map((s) => s.scenarioId)),
    );
  }
  if (scn.byCell === undefined) {
    throw new PivotUnavailableError(query, cellArmMissing("eve", STATIC_CARRIER_ABSENCE));
  }
  const byId = new Map(scn.byCell.map((c) => [c.cellId, c]));
  let total = 0;
  const rows = view.groups.map((g) => {
    let acc = 0;
    for (const id of g.cellIds) acc += cellOr(byId, id, query).pv;
    total += acc;
    return shell({ value: acc }, g);
  });
  return { ...base, rows, total };
}

function scenarioMissing(have: readonly string[]): string {
  return `the envelope carries scenarios [${have.map((s) => `"${s}"`).join(", ")}]`;
}

function cellArmMissing(block: string, reason: string): string {
  return (
    `the ${block} block carries no per-cell rows for this scenario. ${reason} ` +
    `The pivot answers with nothing rather than with a family number.`
  );
}

/**
 * Why the cashflow and NII blocks can lack a cell arm on a scenario the
 * envelope otherwise carries. The balance stage replaces a dynamic scenario's
 * contractual envelope with the dynamic projection's own, which has no cell
 * index (run/stages/balance.ts, stated at run/stages/contractual.ts), and the
 * NII stage reads that replaced envelope: in the default plan st-nii depends on
 * st-balance whenever any scenario is dynamic (run/defaultPlan.ts).
 */
const DYNAMIC_CELL_ABSENCE =
  "A dynamic scenario's cash flows are replaced by its own projection, which carries no cell " +
  "index, so the cashflow and NII blocks carry no cells for it.";

/**
 * The gap and EVE blocks do NOT share that reason, and the asymmetry is pinned
 * by a test. Both read the static contractual series: st-gap and st-eve depend
 * on st-cashflow even when a balance stage exists (run/defaultPlan.ts), and the
 * gap ladders ride the RepricingSchedule carrier, which the balance stage never
 * produces at all. So a dynamic scenario's gap ladder and EVE row carry the
 * same cell arm a static scenario's do. One of these blocks without cells means
 * the run declared no grouping dimension, which the view lookup has refused
 * already.
 */
const STATIC_CARRIER_ABSENCE =
  "This block reads the static contractual series, which carries cells whenever the run declared " +
  "a view, dynamic scenarios included, so its absence means this run accumulated at family grain.";

/** A group naming a cell the metric block does not carry is a defect in the envelope, not a caller error. */
function cellOr<T>(byId: ReadonlyMap<string, T>, id: string, query: PivotQuery): T {
  const cell = byId.get(id);
  if (cell === undefined) {
    throw new PivotUnavailableError(
      query,
      `the view names cell "${id}" and the metric block does not carry it; the envelope is inconsistent`,
    );
  }
  return cell;
}
