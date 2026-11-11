/**
 * Gap engines: the repricing ladder and the liquidity ladder.
 *
 * Both ladders are built from one position pass per scenario, reducing each
 * instrument's Cashflow[] (under the scenario rate path) into per-family
 * monthly series, rolling those up the COA tree, and aggregating the monthly
 * buckets into the standard time bands (bands.ts). Determinism mirrors the m03
 * aggregator: positions reduce in array order, families in declared order, COA
 * children sum in ascending sibling `order`, nodes emit in declared node order.
 *
 * Repricing ladder (off Instrument.repricingSchedule(), principal + reset
 * volumes). Each position's rate-sensitive volume enters the band where its
 * rate is next free to move:
 *   - A fixed-rate instrument (repricingSchedule() empty) reprices only as
 *     principal runs off. Its repricing series is its principal runoff by
 *     bucket, so a pure fixed-rate book carries no reset-driven volume at all.
 *   - A floater reprices its whole outstanding balance at its next ACTUAL
 *     reset. The kernel schedule's month-1 entry is the origination reset (the
 *     coupon is set at the as-of instant, kernel reads rateAt(0)), so it is not
 *     a future repricing event; the next reset is the first schedule entry
 *     strictly after month 1. A reset at schedule month m happens at time
 *     m - 1 months from as-of (the kernel reads rateAt(m - 1)), which is
 *     bucket m - 2. So a monthly floater (next reset month 2) lands in band
 *     0-1M, a quarterly floater (month 4) in 1-3M, an annual floater
 *     (month 13) in 6-12M. Principal that runs off strictly before the reset
 *     bucket reprices at runoff; the balance still outstanding at the reset
 *     bucket reprices there. The two pieces sum to the notional, counted once.
 *     A floater whose schedule has no entry after month 1 (reset frequency at
 *     or past maturity) never resets again and reprices by runoff, like fixed.
 *   - An interest-bearing NMD (kernel NMDBeta) splits by its initial beta at
 *     the scenario's t=0 rate (kernel initialBeta(), outside the frozen
 *     Instrument interface): the beta slice of every principal dollar is
 *     rate-sensitive now and books in bucket 0, the rate-locked (1 - beta)
 *     slice reprices at its decay-profile runoff bucket, exactly as before.
 *     The split conserves principal per dollar (beta + (1 - beta) = 1), so the
 *     repricing band total still equals the liquidity band total. Computing
 *     the split needs the scenario rate path; a caller that does not supply
 *     one gets the previous all-runoff treatment.
 *     Non-interest-bearing NMD stays pure runoff.
 *
 * Liquidity ladder (off principal cash flows). Each position's principal runoff
 * by bucket, rolled up and banded. Per band, assets - liabilities is the gap;
 * the cumulative gap through the final band is total asset principal runoff
 * minus total liability principal runoff over the horizon.
 *
 * Seasoning re-anchor (D3a). A position whose terms carry a negative
 * `originationOffsetMonths` is origination-anchored: every bucket index above
 * shifts by the offset (bucket = monthOffset - 1 + offset), entries shifted
 * below zero are elapsed and dropped, and a floater's next actual reset
 * generalizes to the first schedule entry m with m > 1 - offset, banded at
 * bucket m - 2 + offset (the reset at portfolio time m - 1 + offset; the
 * offset-0 case reduces exactly to the rule). Validation and the
 * per-type support matrix live in ../portfolio/seasoning.ts: the shift is
 * honored for fixed-loan terms (path-independent, exact) and refuses typed on
 * the other types, so the generalized reset arithmetic is currently exercised
 * only at offset 0. Band totals still conserve: both ladders drop the same
 * elapsed entries and shift the surviving ones identically.
 */
import { NMDBeta } from "@alm/kernel";
import type { Cashflow, Instrument, RatePath } from "@alm/kernel";
import { COMMITMENT_INSTRUMENT_TYPE } from "../commitment/offBalanceSheet";
import { NON_RATE_INSTRUMENT_TYPE } from "../nonRate";
import type { ChartOfAccounts, CoaNode } from "../contracts/chartOfAccounts";
import type { CoaNodeId, ProductFamilyId } from "../contracts/ids";
import type { PortfolioSpec } from "../contracts/position";
import type {
  GapBand,
  GapBucketRow,
  GapLadder,
  GapResult,
} from "../contracts/results";
import type { RateIndexTable } from "../contracts/rateIndex";
import type { RunMacro } from "../macro/runMacro";
import type { CellRef } from "../contracts/views";
import type { ScenarioRatePath } from "../portfolio/aggregate";
import { seasoningOffsetOf } from "../portfolio/seasoning";
import { makeInstrument } from "../runtime/instrumentFactory";
import { DERIVATIVE_SIDE, SWAP_INSTRUMENT_TYPE } from "../swap/derivatives";

/**
 * The CD cohort-book arm's terms.type. The kernel InstrumentType union does not
 * carry it (the factory widens it, runtime/instrumentFactory), so the compare
 * widens to string, as the commitment and swap guards do.
 */
const CD_INSTRUMENT_TYPE = "cd";
import type { SwapCashflow, SwapInstrument } from "../swap/swapInstrument";
import type { GapBucketsOption, LiquidityFlowsOption } from "../contracts/run";
import { bandForBucket, buildBands, buildUserBands } from "./bands";
import { wantsLiquidityInterest, type GapLadderBuckets } from "./bucketOptions";

/**
 * The two bucketed series the gap fold writes, indexed by WHATEVER grain the
 * caller chose. accumulateGapPosition writes through the index it is handed and
 * never reads a lookup map, so a cell-indexed pair and a family-indexed one are
 * the same target.
 */
export interface BucketSeriesPair {
  /** Repricing volume by bucket, one Float64Array per index. */
  repricing: Float64Array[];
  /** Principal runoff by bucket, one Float64Array per index. */
  principal: Float64Array[];
  /**
   * The contractual interest cash flow by bucket, one
   * Float64Array per index, folded beside `principal` from the same cash flows
   * (`cf.interestPaid`). PRESENT only when the run asked for
   * `liquidityFlows: "principal-plus-interest"`; absent, the fold writes
   * nothing here and the principal and repricing arithmetic is unchanged.
   * Interest lands on its payment date (Amendment A1): deposits on their
   * monthly credit, a CD when the principal it accrued on leaves, a swap its
   * signed net settlement; commitments add nothing.
   */
  interest?: Float64Array[];
}

/**
 * The cell-grain twin of a FamilySeries, carried as a side-car
 * rather than by re-indexing FamilySeries itself: buildLadder signs by family
 * side and rolls the COA up over families, and both must keep reading families
 * (plan deviation 2). Self-contained, so the ladder needs no second argument.
 */
export interface CellSeriesView {
  cells: readonly CellRef[];
  repricing: Float64Array[];
  principal: Float64Array[];
}

/** Per-family monthly series for one scenario, aligned to declared family order. */
export interface FamilySeries extends BucketSeriesPair {
  famIndex: Map<ProductFamilyId, number>;
  /** The same two series at cell grain. Present only when a view is declared. */
  byCell?: CellSeriesView;
}

/**
 * Fresh zeroed per-family series, aligned to the COA's declared family order.
 * `withInterest` adds the zeroed `interest` carrier; absent, the key
 * is absent.
 */
export function createFamilySeries(portfolio: PortfolioSpec, horizon: number, withInterest?: boolean): FamilySeries {
  const families = portfolio.coa.families;
  const repricing = families.map(() => new Float64Array(horizon));
  const principal = families.map(() => new Float64Array(horizon));
  const famIndex = new Map<ProductFamilyId, number>();
  for (let i = 0; i < families.length; i++) famIndex.set(families[i].id, i);
  if (withInterest === true) {
    return { famIndex, repricing, principal, interest: families.map(() => new Float64Array(horizon)) };
  }
  return { famIndex, repricing, principal };
}

/**
 * Fold one position's already-generated cash flows into its family's repricing
 * and principal series. Split out so the run pipeline can feed the gap ladders
 * from the SAME generation pass as the static projection (Package D)
 * instead of regenerating the whole book a second time per scenario. The
 * accumulation order is unchanged: positions fold in array order.
 *
 * `path` (the scenario rate path) is needed only for the NMD-B beta split; it
 * is optional so the shared-generation callers keep compiling. When it is
 * absent an NMD-B position falls back to the previous all-runoff repricing
 * treatment (the disclosed pre-fix behavior), never to a fabricated split.
 *
 * The target is a BucketSeriesPair, not a FamilySeries: the fold writes through
 * `familyIndex` and reads no lookup map, so the caller owns the grain. Both of
 * today's callers still hand it a family index.
 *
 * `repricingExcluded` (schema 1.9.0) is the position's `repricingTreatment:
 * "excluded"`: the principal still lands in the liquidity series, and nothing
 * enters the repricing series. The regulatory deposit convention sets it on
 * core rungs and on the non-interest-bearing non-core slice (the ALCO
 * rule: core deposits are not rate-sensitive). Absent or false is the
 * unchanged fold.
 *
 * Slice 4a, Amendment A1: when the target carries the interest carrier, each
 * position books its interest on its payment date. A deposit (nmd, nmd-b, a
 * regulatory-convention child) is credited monthly and counts as paid monthly,
 * like every other monthly coupon; a CD pays its accrued interest with the
 * principal it accrued on (foldCdInterestWithPrincipal).
 */
export function accumulateGapPosition(
  series: BucketSeriesPair,
  familyIndex: number,
  inst: Instrument,
  cfs: Cashflow[],
  horizon: number,
  path?: RatePath,
  repricingExcluded?: boolean,
): void {
  // Off balance sheet. A commitment family is declared asset-side, so
  // both ladders would otherwise band its drawdown stream into the ASSET column:
  // negative principal in the liquidity ladder, and the same negative volume in
  // the repricing ladder (an undrawn line has an empty reset schedule, so it
  // falls through to the runoff branch). An undrawn line is not a booked balance
  // and has no rate to reprice; a draw is a cash outflow and nothing else. The
  // guard is here rather than at the two call sites so the family-grain fold and
  // the cell-grain fold in run/shard/chunk.ts cannot drift apart. It keys on the
  // instrument type, not the family side, because the side is "asset" by design.
  // The comparison is widened to `string` on purpose: the kernel
  // `InstrumentType` union is frozen and does not carry the engine-side
  // "commitment" arm, so the narrow compare is a type error rather than a
  // reachable branch. The instrument IS a CommitmentInstrument at runtime; the
  // factory casts through `unknown` to hand it over (runtime/instrumentFactory).
  if ((inst.terms.type as string) === COMMITMENT_INSTRUMENT_TYPE) return;
  // S3a-1 follow-up: a non-rate-sensitive balance repays nothing and never reprices, so it sits in neither ladder.
  if ((inst.terms.type as string) === NON_RATE_INSTRUMENT_TYPE) return;
  // A swap is two legs with two repricing dates. The fixed leg
  // reprices at its bullet maturity, the floating leg at its next actual
  // reset, each signed as emitted (receive positive, pay negative). The
  // notional exchanges are never cash, so the liquidity series gets nothing.
  // The discriminant is the position's terms.type, which this fold holds;
  // swap/derivatives.ts states the mapping that keeps it in step with the
  // family side every other fold reads.
  if ((inst.terms.type as string) === SWAP_INSTRUMENT_TYPE) {
    const swap = inst as unknown as SwapInstrument;
    const rows = cfs as SwapCashflow[];
    // The interest-inclusive ladder carries the swap's
    // signed net settlement (rows are signed at emission, receive positive, pay
    // negative), in emitted row order and on the same bucket shift as the
    // static triple, so it is the number NII reads. The principal series still
    // gets nothing: the notional exchanges are never cash.
    if (series.interest !== undefined) {
      foldInterest(series.interest[familyIndex]!, rows, horizon, seasoningOffsetOf(inst.terms));
    }
    const reprAccSwap = series.repricing[familyIndex];
    repriceRunoffOrReset(reprAccSwap, 0, rows.filter((cf) => cf.leg === swap.fixedLeg), horizon, 0);
    const floatResets = swap.floating.repricingSchedule();
    repriceRunoffOrReset(
      reprAccSwap,
      floatResets.length === 0 ? 0 : nextResetMonth(floatResets, 0),
      rows.filter((cf) => cf.leg === swap.floatingLeg),
      horizon,
      0,
    );
    return;
  }
  const resets = inst.repricingSchedule();
  const prinAcc = series.principal[familyIndex];
  const reprAcc = series.repricing[familyIndex];
  // Seasoning re-anchor (D3a): 0 for origination-aligned positions; negative
  // shifts a seasoned fixed-loan stream (validated, typed refusal otherwise;
  // ../portfolio/seasoning.ts). Adding 0 is bitwise-identical arithmetic.
  const off = seasoningOffsetOf(inst.terms);

  // Liquidity: principal runoff lands in the bucket it is returned; shifted
  // buckets below zero are elapsed (before as-of) and dropped.
  for (const cf of cfs) {
    const k = cf.monthOffset - 1 + off;
    if (k < 0 || k >= horizon) continue;
    prinAcc[k] += cf.principalPaid;
  }
  // The interest cash flow beside the principal, same shift and same
  // elapsed-month drop (ruling 7), only when the run asked for it, on its
  // payment date (Amendment A1). Deposits pay monthly like every coupon; a CD
  // pays with its principal. An excluded position books it as it books its
  // liquidity (ruling 8), before the repricing exit below.
  if (series.interest !== undefined) {
    if ((inst.terms.type as string) === CD_INSTRUMENT_TYPE) {
      foldCdInterestWithPrincipal(series.interest[familyIndex]!, cfs, horizon, off);
    } else {
      foldInterest(series.interest[familyIndex]!, cfs, horizon, off);
    }
  }
  // Schema 1.9.0: a position out of the repricing ladder stops here, after its
  // liquidity is booked.
  if (repricingExcluded === true) return;

  // Repricing: NMD-B splits by initial beta; a floater reprices at its next
  // actual reset; everything else (fixed, mortgage, non-IB NMD, and NMD-B
  // without a rate path) reprices by principal runoff.
  const beta =
    inst instanceof NMDBeta && path !== undefined ? inst.initialBeta(path) : 0;
  const nextReset = resets.length === 0 ? 0 : nextResetMonth(resets, off);
  if (beta !== 0) {
    // The beta slice of each principal dollar is repricing-sensitive
    // immediately (bucket 0); the rate-locked (1 - beta) slice reprices at
    // its runoff bucket. beta + (1 - beta) = 1 per dollar, so the repricing
    // total still equals the principal total. beta === 0 takes the plain
    // runoff branch below, which keeps that case byte-identical to the
    // pre-split arithmetic. (NMD-B refuses nonzero offsets, so off is 0 here;
    // the elapsed guard still runs before both adds by construction.)
    const locked = 1 - beta;
    for (const cf of cfs) {
      const k = cf.monthOffset - 1 + off;
      if (k < 0 || k >= horizon) continue;
      reprAcc[0] += beta * cf.principalPaid;
      reprAcc[k] += locked * cf.principalPaid;
    }
  } else {
    repriceRunoffOrReset(reprAcc, nextReset, cfs, horizon, off);
  }
}

/** Interest cash flow by bucket, shifted by `off`, elapsed and truncated months dropped. */
function foldInterest(intAcc: Float64Array, cfs: readonly Cashflow[], horizon: number, off: number): void {
  for (const cf of cfs) {
    const k = cf.monthOffset - 1 + off;
    if (k < 0 || k >= horizon) continue;
    intAcc[k] += cf.interestPaid;
  }
}

/**
 * Slice 4a, Amendment A1 item 3 (interim rule, no new field): a CD pays its
 * accrued interest when the principal it accrued on leaves, at maturity for a
 * held CD and pro rata at an early exit. The CD row (`cdInstrument.ts`) is a
 * cohort book: `interestPaid` is the coupon ACCRUED that month on the opening
 * `balance`, and `principalPaid` is the early withdrawals plus maturities of
 * that month. The fold keeps one accrued pool for the position: each row adds
 * its accrual, then pays the share of the pool that the leaving principal is
 * of the opening balance (all of it when the whole balance leaves), and the
 * last row pays whatever is left, so the total over the stream equals the sum
 * of the accruals exactly and only the timing moves. Accrual runs over every
 * row; a payment in an elapsed or truncated month drops like principal.
 *
 * Exact for a single cohort: every live dollar has accrued the same amount
 * since as-of. On a multi-cohort book the pool spreads accrued interest evenly
 * over the live dollars, so a leaving cohort takes the book's average accrual
 * per dollar rather than its own; the timing of a mixed book is approximate,
 * its total is not. Interest accrued before as-of on a seasoned cohort is not
 * in the stream and is not paid. A pay-frequency field on CD positions is the
 * named follow-up.
 */
function foldCdInterestWithPrincipal(intAcc: Float64Array, cfs: readonly Cashflow[], horizon: number, off: number): void {
  let accrued = 0;
  const last = cfs.length - 1;
  for (let i = 0; i <= last; i++) {
    const cf = cfs[i]!;
    accrued += cf.interestPaid;
    const leaving = cf.balance > 0 ? Math.min(1, cf.principalPaid / cf.balance) : 1;
    const paid = i === last || leaving === 1 ? accrued : accrued * leaving;
    accrued -= paid;
    const k = cf.monthOffset - 1 + off;
    if (k < 0 || k >= horizon) continue;
    intAcc[k] += paid;
  }
}

/**
 * The two non-beta repricing branches, unchanged in arithmetic and order:
 * with no next reset the principal reprices at runoff; with one, runoff
 * before the reset bucket reprices at runoff and the balance outstanding at
 * the reset bucket reprices there. Shared by a plain instrument and by each
 * leg of a swap.
 */
function repriceRunoffOrReset(
  reprAcc: Float64Array,
  nextReset: number,
  cfs: readonly Cashflow[],
  horizon: number,
  off: number,
): void {
  if (nextReset === 0) {
    for (const cf of cfs) {
      const k = cf.monthOffset - 1 + off;
      if (k < 0 || k >= horizon) continue;
      reprAcc[k] += cf.principalPaid;
    }
    return;
  }
  // The kernel reads rateAt(m - 1) for a reset at schedule month m, so the
  // reset instant sits m - 1 + off months from as-of: bucket m - 2 + off.
  // At off 0, month 1 is the origination reset (rate set at as-of), not a
  // future repricing event. (Floaters refuse nonzero offsets today, so this
  // generalization is exercised only at off 0; nextResetMonth guarantees
  // resetBucket >= 0 for any off it would accept.)
  const resetBucket = nextReset - 2 + off;
  for (const cf of cfs) {
    const k = cf.monthOffset - 1 + off;
    if (k < 0 || k >= horizon) continue;
    if (k < resetBucket) {
      // Runoff before the next reset reprices at runoff.
      reprAcc[k] += cf.principalPaid;
    } else if (k === resetBucket) {
      // The balance still outstanding reprices here; everything downstream
      // of this reset is captured by that repriced balance.
      reprAcc[k] += cf.balance;
      break;
    }
  }
}

/**
 * The next actual reset month: the first schedule entry whose reset instant
 * falls strictly after the as-of date. A reset at schedule month m happens at
 * portfolio time m - 1 + off, so the condition is m > 1 - off; at off 0 that
 * is the rule (strictly after the month-1 origination reset), byte for
 * byte. 0 when there is none (a floater that never resets again inside its
 * life is fixed-rate for the remaining term).
 */
function nextResetMonth(resets: number[], off: number): number {
  for (const m of resets) {
    if (m > 1 - off) return m;
  }
  return 0;
}

/**
 * Reduce the book into per-family repricing and principal series under one path.
 * One instrument is built, generated, and dropped per position (no per-position
 * result object survives), matching the hot-loop discipline of aggregate.ts.
 */
function buildFamilySeries(
  portfolio: PortfolioSpec,
  path: RatePath,
  horizon: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): FamilySeries {
  const series = createFamilySeries(portfolio, horizon);

  for (const pos of portfolio.positions) {
    const fi = series.famIndex.get(pos.familyId);
    if (fi === undefined) {
      throw new Error(
        `buildFamilySeries: position "${pos.id}" references unknown family "${pos.familyId}"`,
      );
    }
    const inst = makeInstrument(pos.terms, { rateIndices, macro });
    const cfs = inst.generateCashflows(path);
    accumulateGapPosition(
      series,
      fi,
      inst,
      cfs,
      horizon,
      path,
      pos.repricingTreatment === "excluded",
    );
  }

  return series;
}

/**
 * Sum per-family series up the COA tree. A leaf node's series is its family's
 * series; a summation node's series is the sum of its children, taken in
 * ascending sibling `order`. Returns one Float64Array per node id.
 */
function rollUp(
  coa: ChartOfAccounts,
  famIndex: Map<ProductFamilyId, number>,
  famSeries: Float64Array[],
  horizon: number,
): Map<CoaNodeId, Float64Array> {
  const childrenByParent = new Map<CoaNodeId | null, CoaNode[]>();
  for (const node of coa.nodes) {
    const group = childrenByParent.get(node.parentId);
    if (group) group.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  for (const group of childrenByParent.values()) {
    group.sort((a, b) => a.order - b.order);
  }

  const computed = new Map<CoaNodeId, Float64Array>();
  const compute = (node: CoaNode): Float64Array => {
    const memo = computed.get(node.id);
    if (memo) return memo;
    const out = new Float64Array(horizon);
    if (node.isLeaf) {
      if (node.familyId !== undefined) {
        const fi = famIndex.get(node.familyId);
        if (fi !== undefined) out.set(famSeries[fi]);
      }
    } else {
      const kids = childrenByParent.get(node.id) ?? [];
      for (const kid of kids) {
        const ks = compute(kid);
        for (let k = 0; k < horizon; k++) out[k] += ks[k];
      }
    }
    computed.set(node.id, out);
    return out;
  };
  for (const node of coa.nodes) compute(node);
  return computed;
}

/** Assemble band rows from banded asset and liability totals, carrying the cumulative gap. */
function assembleRows(
  assetsBand: Float64Array,
  liabBand: Float64Array,
  bands: GapBand[],
): GapBucketRow[] {
  const rows: GapBucketRow[] = [];
  let cumulative = 0;
  for (let b = 0; b < bands.length; b++) {
    const assets = assetsBand[b];
    const liabilities = liabBand[b];
    const gap = assets - liabilities;
    cumulative += gap;
    rows.push({ band: bands[b], assets, liabilities, gap, cumulativeGap: cumulative });
  }
  return rows;
}

/** Band a single node's monthly series into one side's column and build its rows. */
function nodeBandRows(
  series: Float64Array,
  side: CoaNode["side"],
  bands: GapBand[],
  horizon: number,
): GapBucketRow[] {
  const assetsBand = new Float64Array(bands.length);
  const liabBand = new Float64Array(bands.length);
  // A derivative node's series is the net, signed swap series; it
  // bands into the ASSETS column (a receive leg is a synthetic asset, a pay
  // leg a negative one), so gap and cumulativeGap are exact. See GapBucketRow.
  const target =
    side === "asset" || side === DERIVATIVE_SIDE ? assetsBand : side === "liability" ? liabBand : null;
  if (target) {
    for (let k = 0; k < horizon; k++) {
      const v = series[k];
      if (v === 0) continue;
      target[bandForBucket(k, bands)] += v;
    }
  }
  return assembleRows(assetsBand, liabBand, bands);
}

/**
 * Top-level ladder rows: the whole book per band, assets and liabilities
 * together. Built from the roll-up's root nodes so the headline rows are exactly
 * the combination of the root asset and root liability node rows.
 */
function topLevelRows(
  coa: ChartOfAccounts,
  nodeSeries: Map<CoaNodeId, Float64Array>,
  bands: GapBand[],
  horizon: number,
): GapBucketRow[] {
  const assetsBand = new Float64Array(bands.length);
  const liabBand = new Float64Array(bands.length);
  for (const node of coa.nodes) {
    if (node.parentId !== null) continue;
    const target =
      node.side === "asset" || node.side === DERIVATIVE_SIDE ? assetsBand : node.side === "liability" ? liabBand : null;
    if (!target) continue;
    const series = nodeSeries.get(node.id);
    if (!series) continue;
    for (let k = 0; k < horizon; k++) {
      const v = series[k];
      if (v === 0) continue;
      target[bandForBucket(k, bands)] += v;
    }
  }
  return assembleRows(assetsBand, liabBand, bands);
}

/**
 * One banded row set per cell, signed by the cell's family side.
 *
 * No second banding rule: this is nodeBandRows, the call the COA drill-down
 * already makes, aimed at a cell index instead of a node id. A cell is a family
 * pinned to one value of each grouping dimension, so its side IS its family's
 * declared side. The lookup THROWS on a family outside the chart of accounts:
 * a cell plan built from another book is the one failure that can reach here,
 * and runStaticPass already refuses it at the top of the pass.
 */
function cellBandRows(
  portfolio: PortfolioSpec,
  view: CellSeriesView,
  cellSeries: Float64Array[],
  bands: GapBand[],
  horizon: number,
): Array<{ cellId: string; rows: GapBucketRow[] }> {
  const sideByFamily = new Map<ProductFamilyId, CoaNode["side"]>();
  for (const f of portfolio.coa.families) sideByFamily.set(f.id, f.side);
  return view.cells.map((cell, i) => {
    const side = sideByFamily.get(cell.familyId);
    if (side === undefined) {
      throw new Error(
        `gapEngine: cell "${cell.id}" names family "${cell.familyId}", which is not in the chart of accounts`,
      );
    }
    return { cellId: cell.id, rows: nodeBandRows(cellSeries[i]!, side, bands, horizon) };
  });
}

/**
 * Build one ladder (rows plus COA drill-down) from a per-family series.
 *
 * `cellArm` is a side-car and nothing more. The headline `rows` and the
 * `byCoaNode` roll-up keep folding over FAMILIES whether it is present or not.
 * A family holding one cell reports exactly the number it reported before a
 * view was declared; a family holding two or more cells sums them in cell
 * order, which can differ from a direct position fold in the last bits (the
 * contract note at ScenarioCashflows.byCell). When the arm is absent the key
 * is absent too, not present and undefined: an empty byCell would read as a
 * computed answer.
 *
 * `user` (spec decisions 107 and 108) is the run's
 * own bucket setting for this ladder. When present, the ladder gains
 * `userBuckets` after `byCell`: the SAME top-level fold as `rows`, over the same
 * root-node series, aimed at the user bands instead of the nine standard ones.
 * Top-level rows only, no node or cell arm. `rows`, `byCoaNode` and `byCell`
 * are built exactly as without it. Absent, the key is absent.
 */
function buildLadder(
  kind: GapLadder["kind"],
  scenarioId: string,
  portfolio: PortfolioSpec,
  famIndex: Map<ProductFamilyId, number>,
  famSeries: Float64Array[],
  bands: GapBand[],
  horizon: number,
  cellArm?: { view: CellSeriesView; series: Float64Array[] },
  user?: GapBucketsOption,
): GapLadder {
  const nodeSeries = rollUp(portfolio.coa, famIndex, famSeries, horizon);
  const byCoaNode = portfolio.coa.nodes.map((node) => ({
    coaNodeId: node.id,
    rows: nodeBandRows(nodeSeries.get(node.id)!, node.side, bands, horizon),
  }));
  return {
    kind,
    scenarioId,
    rows: topLevelRows(portfolio.coa, nodeSeries, bands, horizon),
    byCoaNode,
    ...(cellArm !== undefined
      ? { byCell: cellBandRows(portfolio, cellArm.view, cellArm.series, bands, horizon) }
      : {}),
    ...(user !== undefined
      ? {
          userBuckets: {
            kind: user.kind,
            ...(user.kind === "custom" ? { edgesMonths: [...user.edgesMonths] } : {}),
            rows: topLevelRows(portfolio.coa, nodeSeries, buildUserBands(user, horizon), horizon),
          },
        }
      : {}),
  };
}

/**
 * Assemble both ladders from an already-accumulated per-family series (the
 * shared-generation path: the run pipeline fills the series during the static
 * projection's position loop and hands it here).
 *
 * `buckets` is the trailing optional argument
 * carrying each ladder's user bucket setting, present only when the run asked
 * for one; a gap metric registered with four parameters stays assignable to the
 * seam. The repricing ladder follows `buckets.repricing` and the liquidity
 * ladder `buckets.liquidity`, each on its own series and independently; a
 * ladder with no setting carries no `userBuckets` key.
 *
 * `liquidityFlows` is the trailing optional argument
 * after `buckets`. "principal-plus-interest" adds `withInterest` to the
 * liquidity ladder, built from the series' `interest` carrier, which the run
 * filled only because it asked; a series without the carrier is refused rather
 * than read as zero interest. "principal" or absent builds exactly what it
 * always did.
 */
export function buildGapFromSeries(
  portfolio: PortfolioSpec,
  scenarioId: string,
  series: FamilySeries,
  horizon: number,
  buckets?: GapLadderBuckets,
  liquidityFlows?: LiquidityFlowsOption,
): { repricing: GapLadder; liquidity: GapLadder } {
  const bands = buildBands(horizon);
  const { famIndex, repricing, principal, byCell } = series;
  if (wantsLiquidityInterest(liquidityFlows)) {
    if (series.interest === undefined) {
      throw new Error(
        `buildGapFromSeries: scenario "${scenarioId}" asked for the interest-inclusive liquidity ladder, ` +
          `but its series carries no interest; the contractual pass was not asked to fold it`,
      );
    }
    const liquidity = buildLadder(
      "liquidity",
      scenarioId,
      portfolio,
      famIndex,
      principal,
      bands,
      horizon,
      byCell !== undefined ? { view: byCell, series: byCell.principal } : undefined,
      buckets?.liquidity,
    );
    // Last key of the ladder, after userBuckets: the principal keys keep their order and bytes.
    liquidity.withInterest = interestInclusive(
      portfolio,
      famIndex,
      principal,
      series.interest,
      bands,
      horizon,
      buckets?.liquidity,
    );
    return {
      repricing: buildLadder(
        "repricing",
        scenarioId,
        portfolio,
        famIndex,
        repricing,
        bands,
        horizon,
        byCell !== undefined ? { view: byCell, series: byCell.repricing } : undefined,
        buckets?.repricing,
      ),
      liquidity,
    };
  }
  return {
    repricing: buildLadder(
      "repricing",
      scenarioId,
      portfolio,
      famIndex,
      repricing,
      bands,
      horizon,
      byCell !== undefined ? { view: byCell, series: byCell.repricing } : undefined,
      buckets?.repricing,
    ),
    liquidity: buildLadder(
      "liquidity",
      scenarioId,
      portfolio,
      famIndex,
      principal,
      bands,
      horizon,
      byCell !== undefined ? { view: byCell, series: byCell.principal } : undefined,
      buckets?.liquidity,
    ),
  };
}

/**
 * Top-level rows of one per-family series on the nine standard bands and, when
 * the ladder has a bucket setting, on the user bands: the SAME roll-up and the
 * SAME top-level fold as the principal `rows` and `userBuckets`.
 */
function topLevelLadder(
  portfolio: PortfolioSpec,
  famIndex: Map<ProductFamilyId, number>,
  famSeries: Float64Array[],
  bands: GapBand[],
  horizon: number,
  user?: GapBucketsOption,
): { rows: GapBucketRow[]; userBuckets?: NonNullable<GapLadder["userBuckets"]> } {
  const nodeSeries = rollUp(portfolio.coa, famIndex, famSeries, horizon);
  return {
    rows: topLevelRows(portfolio.coa, nodeSeries, bands, horizon),
    ...(user !== undefined
      ? {
          userBuckets: {
            kind: user.kind,
            ...(user.kind === "custom" ? { edgesMonths: [...user.edgesMonths] } : {}),
            rows: topLevelRows(portfolio.coa, nodeSeries, buildUserBands(user, horizon), horizon),
          },
        }
      : {}),
  };
}

/**
 * The interest-inclusive liquidity ladder: per family, the principal
 * series plus the interest series, month by month, then the SAME roll-up and
 * the SAME top-level fold as the principal `rows`, on the nine standard bands
 * and, when the ladder has a bucket setting, on the user bands.
 *
 * Amendment A2: `interest`, the last key, is the interest on its own, folded
 * the same way from the interest carrier itself, never as the combined rows
 * less the principal ones.
 */
function interestInclusive(
  portfolio: PortfolioSpec,
  famIndex: Map<ProductFamilyId, number>,
  principal: Float64Array[],
  interest: Float64Array[],
  bands: GapBand[],
  horizon: number,
  user?: GapBucketsOption,
): NonNullable<GapLadder["withInterest"]> {
  const combined = principal.map((p, f) => {
    const i = interest[f]!;
    const out = new Float64Array(horizon);
    for (let k = 0; k < horizon; k++) out[k] = p[k]! + i[k]!;
    return out;
  });
  return {
    ...topLevelLadder(portfolio, famIndex, combined, bands, horizon, user),
    interest: topLevelLadder(portfolio, famIndex, interest, bands, horizon, user),
  };
}

/**
 * Both gap ladders for one scenario, with its own generation pass.
 *
 * No cell arm, and that is honest rather than a gap: buildFamilySeries builds no
 * side-car because this entry point was never handed a cell plan. It reduces the
 * book by family and has nothing finer to report.
 */
export function buildScenarioGap(
  portfolio: PortfolioSpec,
  sp: ScenarioRatePath,
  horizon: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): { repricing: GapLadder; liquidity: GapLadder } {
  const series = buildFamilySeries(portfolio, sp.path, horizon, rateIndices, macro);
  return buildGapFromSeries(portfolio, sp.scenarioId, series, horizon);
}

/**
 * The full GapResult: a repricing ladder and a liquidity ladder per scenario,
 * scenarios emitted in input order.
 */
export function buildGapResult(
  portfolio: PortfolioSpec,
  scenarioPaths: ScenarioRatePath[],
  horizon: number,
  rateIndices?: RateIndexTable,
  macro?: RunMacro,
): GapResult {
  const repricing: GapLadder[] = [];
  const liquidity: GapLadder[] = [];
  for (const sp of scenarioPaths) {
    const both = buildScenarioGap(portfolio, sp, horizon, rateIndices, macro);
    repricing.push(both.repricing);
    liquidity.push(both.liquidity);
  }
  return { repricing, liquidity };
}
