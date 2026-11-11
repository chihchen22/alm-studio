/**
 * The survival horizon, the third built-in through the custom
 * metric slot and the first liquidity metric: how many whole months a tagged
 * liquidity buffer covers the book's cumulative net outflow as each scenario
 * projects it, per scenario.
 *
 * THE STRESS IS ENGINE INPUT. The metric applies no stress of its
 * own: it reads each scenario's projected cash flows as given. A liquidity
 * stress arrives as a stressed assumption set on the scenario (the seeded
 * `liquidity-stress-demo-v1` projects 5 and 10 percent deposit run-off through
 * the kernel's NMD decay), so NII, EVE, gap and this metric see the same
 * flows. On a scenario with a business-as-usual set the answer is
 * business-as-usual survival, which is long. Nothing rolls over in static
 * mode; the haircuts and the inflow cap below are metric conventions, like
 * the LCR's, not projections.
 *
 * THE BUFFER is every ASSET family whose positions ALL carry the same
 * `hqla-level` tag, at its as-of balance (`balance[0]`) after the haircut. Its
 * own principal and interest are not inflows, so no dollar counts twice.
 *
 * ABSENCE, never zero. A book with no buffer family, or with any family the
 * family-grain cash flows cannot separate (mixed tags, two levels, an unknown
 * level, a tagged non-asset family), carries NO keys: a book that states no buffer has
 * not stated a zero buffer. `survival-months` is left out when the buffer lasts
 * the horizon; `month1-coverage` is left out when month 1 has no net outflow.
 *
 * MONTHLY GRAIN. Bucket k is calendar month k+1; stress inside the first month
 * is invisible here.
 */
import { isCommitmentFamily } from "../commitment/offBalanceSheet";
import type { CustomMetricKey, CustomMetricResult } from "../contracts/customMetric";
import type { PortfolioSpec } from "../contracts/position";
import type { FamilyCashflows } from "../contracts/results";
import type { CustomMetricInput } from "../plugins/services";
import { classifyBufferFamilies, hasBufferFamily, type BufferClass } from "./hqlaBuffer";

export { HQLA_DIMENSION } from "./hqlaBuffer";

export interface SurvivalStressTable {
  /** Haircut per hqla-level value. A value not listed here is an unknown level. */
  haircut: Readonly<Record<string, number>>;
  /** Share of an ordinary asset's contractual principal plus interest counted as inflow. */
  assetInflowFactor: number;
}

/**
 * DEMONSTRATION metric conventions: the public LCR haircuts and the inflow cap.
 * Stated, disclosed and not calibrated. Haircuts are the public Basel LCR levels.
 * Changing a value is a code change and a new test expectation.
 */
export const SURVIVAL_STRESS_DEMO: SurvivalStressTable = {
  haircut: { l1: 0, l2a: 0.15, l2b: 0.5 },
  assetInflowFactor: 0.5,
};

/** The four declared keys, in author order. */
export const SURVIVAL_HORIZON_KEYS: CustomMetricKey[] = [
  { id: "buffer", label: "Liquidity buffer after haircuts, as-of balance", unit: "currency" },
  {
    id: "survival-months",
    label: "Whole months the buffer covers cumulative net outflow",
    unit: "months",
  },
  {
    id: "min-headroom",
    label: "Lowest buffer minus cumulative net outflow over the horizon",
    unit: "currency",
  },
  { id: "month1-coverage", label: "Buffer over the first month's net outflow", unit: "fraction" },
];

export function computeSurvivalHorizon(input: CustomMetricInput): CustomMetricResult {
  const classes = classifyBufferFamilies(input.book, SURVIVAL_STRESS_DEMO.haircut);
  const hasBuffer = classes !== undefined && hasBufferFamily(classes);
  return {
    metricId: "survival-horizon",
    label: "Survival horizon (under each scenario's own assumptions, months)",
    keys: SURVIVAL_HORIZON_KEYS,
    byScenario: input.scenarios.map(({ scenarioId, cashflows }) => ({
      scenarioId,
      values:
        classes === undefined || !hasBuffer
          ? {}
          : scenarioValues(cashflows.byFamily, classes, input.book, input.horizonMonths, SURVIVAL_STRESS_DEMO),
    })),
  };
}

function at(series: readonly number[], k: number): number {
  return series[k] ?? 0;
}

function scenarioValues(
  families: readonly FamilyCashflows[],
  classes: ReadonlyMap<string, BufferClass>,
  book: PortfolioSpec,
  horizon: number,
  table: SurvivalStressTable,
): Record<string, number> {
  const defOf = new Map(book.coa.families.map((f) => [f.id, f]));
  let buffer = 0;
  const outflow = new Array<number>(horizon).fill(0);
  for (const fam of families) {
    const def = defOf.get(fam.familyId);
    const cls = classes.get(fam.familyId);
    // A family the chart of accounts does not classify has no side; it is
    // skipped, exactly as wal-gap skips it.
    if (def === undefined || cls === undefined) continue;
    const s = fam.series;
    // A committed-line draw is an outflow at FULL value (task 8a;
    // ruling overriding spec 7.4, which held that draws reach this
    // metric "for free": true of the SIGN, false of the MAGNITUDE).
    //
    // A commitment family is declared asset-side, so it used to fall into the
    // asset branch below, where a draw's negative principal is subtracted and
    // therefore does raise outflow, but scaled by `assetInflowFactor`.
    // `assetInflowFactor` is a stress haircut on inflows the bank merely HOPES
    // will arrive; a draw is a contractual obligation to PAY OUT. Halving a
    // certain obligation understates the stress in the unconservative
    // direction, the same shape as the LCR inflow netting piece 7 already
    // corrected in lcr.ts.
    //
    // It sits before the buffer branch, not inside the asset branch, because
    // undrawn capacity is never HQLA either: an `hqla-level`-tagged commitment
    // family would otherwise add its UNDRAWN balance to the buffer.
    //
    // The discriminant is the FAMILY's instrumentType, not the position's terms
    // type, because this fold walks FamilyCashflows and holds no position.
    //
    // Only the drawdown part contributes: `-Math.min(principal, 0)` is the
    // scenario LCR arm's treatment (lcr.ts), so a stray positive principal can
    // never subtract from stressed outflow. Interest is not read at all, which
    // costs nothing, because a commitment row carries interest 0 by construction
    // (commitmentInstrument.ts), pinned by commitmentOffBalanceSheet.test.ts.
    if (isCommitmentFamily(def)) {
      for (let k = 0; k < horizon; k++) {
        outflow[k] += -Math.min(at(s.principal, k), 0);
      }
      continue;
    }
    if (cls.kind === "buffer") {
      buffer += at(s.balance, 0) * (1 - cls.haircut);
      continue;
    }
    if (def.side === "asset") {
      for (let k = 0; k < horizon; k++) {
        outflow[k] -= table.assetInflowFactor * (at(s.principal, k) + at(s.interest, k));
      }
    } else if (def.side === "liability") {
      for (let k = 0; k < horizon; k++) {
        outflow[k] += at(s.principal, k) + at(s.interest, k);
      }
    }
    // Equity carries no cash flow in this metric.
  }

  const values: Record<string, number> = { buffer };
  let cumulative = 0;
  let minHeadroom = Infinity;
  let survived: number | undefined;
  for (let k = 0; k < horizon; k++) {
    cumulative += outflow[k]!;
    minHeadroom = Math.min(minHeadroom, buffer - cumulative);
    if (survived === undefined && cumulative > buffer) survived = k;
  }
  if (horizon > 0) values["min-headroom"] = minHeadroom;
  if (survived !== undefined) values["survival-months"] = survived;
  if (horizon > 0 && outflow[0]! > 0) values["month1-coverage"] = buffer / outflow[0]!;
  return values;
}
