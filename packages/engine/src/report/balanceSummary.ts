/**
 * The shipped demonstration custom metric.
 *
 * It exists to prove the fifth metric slot end to end with something a user can
 * actually run, which is why it ships mounted rather than living in a test
 * (ruling 3). It is a READ over the series the plan wires to it, not a
 * projection: two sums and one ratio, and nothing else. Its label says
 * "demonstration" so nobody mistakes it for a reporting convention.
 *
 * It lives in report/ beside the pivot and the lens readers because it computes
 * no balance-sheet number: like them, it re-reads numbers the engine already
 * produced.
 *
 * ABSENCE, never zero. `runoff-share` is left OUT of a row whose opening
 * balance is 0, because a share of nothing is undefined, and both balance keys
 * are left out when the series does not reach the bucket. A lens reader turns
 * that absence into "unobservable" with a reason.
 */
import { commitmentFamilyIds } from "../commitment/offBalanceSheet";
import type { CustomMetricKey, CustomMetricResult } from "../contracts/customMetric";
import type { FamilyCashflows } from "../contracts/results";
import type { CustomMetricInput } from "../plugins/services";
import { derivativeFamilyIds } from "../swap/derivatives";

/** The three declared keys, in author order. Ids are hyphenated, per CUSTOM_METRIC_ID_PATTERN. */
export const BALANCE_SUMMARY_KEYS: CustomMetricKey[] = [
  {
    id: "opening-balance",
    label: "Sum of family balances at the start of the first bucket",
    unit: "currency",
  },
  {
    id: "final-bucket-balance",
    label: "Sum of family balances at the start of the final bucket",
    unit: "currency",
  },
  {
    id: "runoff-share",
    label: "1 minus final-bucket-balance over opening-balance",
    unit: "fraction",
  },
];

export function computeBalanceSummary(input: CustomMetricInput): CustomMetricResult {
  const last = input.horizonMonths - 1;
  // Off balance sheet. A commitment family's `balance` series is the
  // UNDRAWN capacity still available, not a balance the bank owns, so summing
  // it here would inflate the book total by the whole undrawn line. Dropped
  // from its own row as well as from the sum: a "balance" for an undrawn line
  // is not a smaller number of the same quantity, it is a different quantity.
  // Empty for every book seeded before piece 7, so those rows are unchanged.
  const commitments = commitmentFamilyIds(input.book.coa);
  // A swap has no booked balance. Its family's balance series is the
  // sum of two signed notionals, which is 0 and means nothing, so the row is
  // dropped, not written as 0 (a balance for a swap is undefined, not zero).
  const derivatives = derivativeFamilyIds(input.book.coa);
  return {
    metricId: "balance-summary",
    label: "Balance summary (demonstration metric)",
    keys: BALANCE_SUMMARY_KEYS,
    byScenario: input.scenarios.map(({ scenarioId, cashflows }) => {
      const onBook = cashflows.byFamily.filter(
        (f) => !commitments.has(f.familyId) && !derivatives.has(f.familyId),
      );
      return {
        scenarioId,
        values: rowValues(sumAt(onBook, 0), sumAt(onBook, last)),
        byFamily: onBook.map((f) => ({
          familyId: f.familyId,
          values: rowValues(at(f, 0), at(f, last)),
        })),
      };
    }),
  };
}

/** One family's balance at a bucket, or undefined when the series does not reach it. */
function at(family: FamilyCashflows, index: number): number | undefined {
  const value = family.series.balance[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The sum over families at one bucket. One family that does not reach the
 * bucket makes the SUM unobservable: a partial sum reported as a total would be
 * a wrong number, which is worse than an absent one.
 */
function sumAt(families: readonly FamilyCashflows[], index: number): number | undefined {
  let total = 0;
  for (const family of families) {
    const value = at(family, index);
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}

/** One row's map. Every key is present only when this row can observe it. */
function rowValues(opening: number | undefined, final: number | undefined): Record<string, number> {
  const values: Record<string, number> = {};
  if (opening !== undefined) values["opening-balance"] = opening;
  if (final !== undefined) values["final-bucket-balance"] = final;
  // A fraction of zero is undefined, so the key is left out rather than written
  // as 0, NaN or Infinity. This is the honesty rule of the piece, in one line.
  if (opening !== undefined && final !== undefined && opening !== 0) {
    values["runoff-share"] = 1 - final / opening;
  }
  return values;
}
