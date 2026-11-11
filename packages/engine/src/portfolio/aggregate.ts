/**
 * Portfolio cash-flow aggregation: the hot loop.
 *
 * For one scenario (one RatePath), iterate the book position by position in
 * fixed array order, build the concrete kernel Instrument via the m01 factory,
 * generate its Cashflow[] under the path, and reduce those legs straight into
 * per-family typed-array bucket accumulators. No per-position result object
 * survives the loop (architecture Section 8). Then roll the family buckets up
 * the COA tree by summing children in fixed sibling order.
 *
 * Bucketing: the kernel emits 1-based Cashflow.monthOffset (month m's
 * activity, with cf.balance the balance AT START of month m). Bucket k covers
 * [asOf + k, asOf + k + 1), so month m maps to bucket k = m - 1. This makes
 * series.balance[k] the balance at the start of bucket k, exactly the contract's
 * definition, and lets a full 360-month instrument fill buckets 0..359 without
 * overflowing a 360-month horizon. (ADR-004's "monthOffset is the bucket index
 * directly" is off by one against the kernel's 1-based offset; the subtraction
 * is a fixed index shift, not date arithmetic.)
 *
 * Seasoning re-anchor (D3a): a position whose terms carry a negative
 * `originationOffsetMonths` is origination-anchored, so month m maps to bucket
 * k = m - 1 + offset instead; shifted buckets below zero fell before the as-of
 * date (elapsed) and are dropped by the same range guard that truncates the
 * horizon. Offset 0 (the default and the generator's stance) is byte-identical
 * to the pre-existing arithmetic. Validation and the per-type support matrix
 * live in ./seasoning.ts (fixed-loan only; everything else refuses typed).
 *
 * Determinism: positions reduce in array order, families emit in declared
 * order, COA children sum in ascending sibling `order`, and nodes emit in
 * declared node-array order. No map-iteration order feeds any number. Cash flows
 * past the horizon are truncated explicitly here (the accumulator throws on an
 * out-of-range bucket by design; the horizon decision belongs to this layer).
 */
import { walFromCashflows, type Cashflow, type RatePath } from "@alm/kernel";
import type { ChartOfAccounts, CoaNode } from "../contracts/chartOfAccounts";
import type { CoaNodeId, ProductFamilyId, ScenarioId } from "../contracts/ids";
import type { PortfolioSpec } from "../contracts/position";
import type {
  BucketedCashflowResult,
  BucketedSeries,
  BucketGrid,
  CoaNodeCashflows,
  FamilyCashflows,
  ScenarioCashflows,
} from "../contracts/results";
import { BucketAccumulator } from "../runtime/bucketAccumulator";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { RunMacro } from "../macro/runMacro";
import { makeInstrument } from "../runtime/instrumentFactory";
import { seasoningOffsetOf } from "./seasoning";

/** One scenario's resolved rate path. Path construction is owned upstream; this
 * module consumes a ready RatePath so it stays decoupled from curve machinery. */
export interface ScenarioRatePath {
  scenarioId: ScenarioId;
  path: RatePath;
}

/** Raw typed-array triple for a family or node (BucketAccumulator satisfies it). */
export interface SeriesArrays {
  balance: Float64Array;
  principal: Float64Array;
  interest: Float64Array;
}

function toSeries(a: SeriesArrays): BucketedSeries {
  return {
    balance: Array.from(a.balance),
    principal: Array.from(a.principal),
    interest: Array.from(a.interest),
  };
}

/**
 * Aggregate one scenario into per-family and COA-rolled-up bucketed cash flows.
 * (The run pipeline itself computes these series through the chunked static
 * pass, run/shard, which shares this loop's per-position arithmetic; the
 * per-position observer seam of Package D was absorbed into that pass.)
 *
 * `rateIndices` is the run's resolved rate index table. A
 * floater that names an index needs it; one that does not never reads it. A
 * caller that holds an indexed book and passes none gets the factory's
 * RateIndexUnresolvedError, never a base-rate number. `macro` is the
 * run's resolved RunMacro, forwarded the same way; a mortgage carrying a
 * housing group without it gets MacroUnresolvedError.
 *
 * `nmdWarmup`: the deposit history a dynamic scenario's opening book reads when the run
 * named a "history" warmup; absent, every deposit is built exactly as before.
 */
export function aggregateScenario(
  portfolio: PortfolioSpec,
  scenario: ScenarioRatePath,
  grid: BucketGrid,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
  nmdWarmup?: readonly number[],
): ScenarioCashflows {
  const families = portfolio.coa.families;
  const horizon = grid.horizonMonths;

  // Accumulators aligned to declared family order. The lookup Map is get-only;
  // the reduce order (positions in array order) is what fixes the arithmetic.
  const famIndex = new Map<ProductFamilyId, number>();
  const accs: BucketAccumulator[] = new Array(families.length);
  for (let i = 0; i < families.length; i++) {
    famIndex.set(families[i].id, i);
    accs[i] = new BucketAccumulator(horizon);
  }

  const positions = portfolio.positions;
  for (let p = 0; p < positions.length; p++) {
    const pos = positions[p];
    const fi = famIndex.get(pos.familyId);
    if (fi === undefined) {
      throw new Error(
        `aggregateScenario: position "${pos.id}" references unknown family "${pos.familyId}"`,
      );
    }
    const acc = accs[fi];
    // 0 for every origination-aligned position; negative re-anchors a seasoned
    // fixed-loan stream (validated, typed refusal otherwise; ./seasoning.ts).
    const off = seasoningOffsetOf(pos.terms);
    const inst = makeInstrument(pos.terms, nmdWarmup === undefined ? { rateIndices, macro } : { rateIndices, macro, nmdWarmup });
    const cfs = inst.generateCashflows(scenario.path);
    for (let c = 0; c < cfs.length; c++) {
      const cf = cfs[c];
      const bucket = cf.monthOffset - 1 + off;
      // Below zero = elapsed before as-of (seasoned); at/above horizon = truncated.
      if (bucket < 0 || bucket >= horizon) continue;
      acc.add(bucket, cf.balance, cf.principalPaid, cf.interestPaid);
    }
    // The instrument and its Cashflow[] fall out of scope here: nothing retained.
  }

  const byFamily: FamilyCashflows[] = families.map((f, i) => ({
    familyId: f.id,
    series: {
      balance: Array.from(accs[i].balance),
      principal: Array.from(accs[i].principal),
      interest: Array.from(accs[i].interest),
    },
  }));

  const byCoaNode = rollUpCoa(portfolio.coa, famIndex, accs, horizon);

  return { scenarioId: scenario.scenarioId, byFamily, byCoaNode };
}

/**
 * Assemble a ScenarioCashflows from already-accumulated per-family series
 * (one array per family in declared family order). Used by the run pipeline's
 * chunked static pass (run/shard), which owns the accumulation; the family
 * emission and COA roll-up here are identical to aggregateScenario's.
 */
export function assembleScenarioCashflows(
  portfolio: PortfolioSpec,
  scenarioId: ScenarioId,
  fam: { balance: Float64Array[]; principal: Float64Array[]; interest: Float64Array[] },
  horizon: number,
): ScenarioCashflows {
  const families = portfolio.coa.families;
  const famIndex = new Map<ProductFamilyId, number>();
  const series: SeriesArrays[] = new Array(families.length);
  for (let i = 0; i < families.length; i++) {
    famIndex.set(families[i].id, i);
    series[i] = { balance: fam.balance[i], principal: fam.principal[i], interest: fam.interest[i] };
  }
  const byFamily: FamilyCashflows[] = families.map((f, i) => ({
    familyId: f.id,
    series: toSeries(series[i]),
  }));
  const byCoaNode = rollUpCoa(portfolio.coa, famIndex, series, horizon);
  return { scenarioId, byFamily, byCoaNode };
}

/**
 * Family WAL fold: principal-runoff weighted average life, in years
 * from the as-of date, of a family's bucketed principal series. The arithmetic
 * authority is the kernel's `walFromCashflows` — the series is wrapped as a
 * cashflow stream (bucket k is calendar month k+1, ADR-004; only monthOffset
 * and principalPaid are read by the kernel) and the denominator is the
 * in-horizon principal total, so a fully-amortizing family reports the
 * standard WAL and a horizon-truncated one reports the WAL of its in-horizon
 * runoff (disclosed on the contract field, never extrapolated). Returns
 * undefined when the principal total is not positive: an empty family has no
 * WAL, and the engine does not print 0 where "undefined" is the truth.
 */
export function familyWalYears(principal: ArrayLike<number>): number | undefined {
  let total = 0;
  for (let k = 0; k < principal.length; k++) total += principal[k];
  if (!(total > 0)) return undefined;
  const rows: Cashflow[] = [];
  for (let k = 0; k < principal.length; k++) {
    if (principal[k] === 0) continue; // a zero term adds exactly 0 to the fold
    rows.push({
      monthOffset: k + 1,
      balance: 0,
      principalPaid: principal[k],
      interestPaid: 0,
      couponRate: 0,
    });
  }
  return walFromCashflows(rows, total);
}

/**
 * Stamp `walYears` onto each family row of an assembled ScenarioCashflows from
 * its FINAL principal series. Called by the run pipeline after any dynamic
 * new-business merge (the series are mutated in place by the dynamic module, so
 * stamping earlier would freeze a pre-merge WAL); module-level aggregation does
 * not stamp. Families with no positive in-horizon principal keep the field
 * absent.
 */
export function stampFamilyWal(scenario: ScenarioCashflows): void {
  for (const fam of scenario.byFamily) {
    const wal = familyWalYears(fam.series.principal);
    if (wal !== undefined) fam.walYears = wal;
  }
}

/**
 * Aggregate a portfolio across every scenario. Scenarios emit in input order;
 * each is an independent reduction over the same book under its own path.
 */
export function aggregatePortfolio(
  portfolio: PortfolioSpec,
  scenarioPaths: ScenarioRatePath[],
  grid: BucketGrid,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): BucketedCashflowResult {
  const byScenario = scenarioPaths.map((sp) => aggregateScenario(portfolio, sp, grid, rateIndices, macro));
  return { grid, byScenario };
}

/**
 * Sum family buckets up the COA tree. A leaf node's series is its family's
 * accumulator (one family per leaf; architecture Section 2). A summation node's
 * series is the sum of its children, taken in ascending sibling `order`. Output
 * follows the declared node-array order.
 */
function rollUpCoa(
  coa: ChartOfAccounts,
  famIndex: Map<ProductFamilyId, number>,
  accs: SeriesArrays[],
  horizon: number,
): CoaNodeCashflows[] {
  const nodes = coa.nodes;

  // Children grouped by parent, each group ordered by ascending sibling order so
  // the summation sequence is fixed and reproducible.
  const childrenByParent = new Map<CoaNodeId | null, CoaNode[]>();
  for (const node of nodes) {
    const group = childrenByParent.get(node.parentId);
    if (group) group.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  for (const group of childrenByParent.values()) {
    group.sort((a, b) => a.order - b.order);
  }

  const computed = new Map<CoaNodeId, SeriesArrays>();

  const compute = (node: CoaNode): SeriesArrays => {
    const memo = computed.get(node.id);
    if (memo) return memo;

    const out: SeriesArrays = {
      balance: new Float64Array(horizon),
      principal: new Float64Array(horizon),
      interest: new Float64Array(horizon),
    };

    if (node.isLeaf) {
      if (node.familyId !== undefined) {
        const fi = famIndex.get(node.familyId);
        if (fi !== undefined) {
          const acc = accs[fi];
          out.balance.set(acc.balance);
          out.principal.set(acc.principal);
          out.interest.set(acc.interest);
        }
      }
    } else {
      const kids = childrenByParent.get(node.id) ?? [];
      for (const kid of kids) {
        const ks = compute(kid);
        for (let k = 0; k < horizon; k++) {
          out.balance[k] += ks.balance[k];
          out.principal[k] += ks.principal[k];
          out.interest[k] += ks.interest[k];
        }
      }
    }

    computed.set(node.id, out);
    return out;
  };

  return nodes.map((node) => ({ coaNodeId: node.id, series: toSeries(compute(node)) }));
}
