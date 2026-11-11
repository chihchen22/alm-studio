/**
 * The asset-and-liability WAL metric, the second built-in through
 * the fifth metric slot and the first that answers a question a practitioner
 * actually asks: how far apart are the asset and the liability books in
 * principal-weighted average life.
 *
 * It is a READ over the principal series the plan wires to it. The arithmetic
 * authority is `familyWalYears`, the same fold the family `walYears` field is
 * stamped from, so this metric and that field cannot disagree about what a WAL
 * is. It is NOT read off `fam.walYears`: that field is stamped at assemble
 * time, AFTER the custom stage runs, so a metric that read it would read an
 * absent field on the very run it is computing.
 *
 * IN-HORIZON, and disclosed as such. The fold divides by the in-horizon
 * principal total, so a book that does not fully amortize inside the horizon
 * reports the WAL of its in-horizon runoff, truncated and never extrapolated.
 *
 * The side pools are PRINCIPAL-WEIGHTED, not an average of family WALs: the
 * families on a side are summed bucket by bucket and the fold runs once over
 * the pooled series, which is the only pooling that gives the book's own WAL.
 *
 * ABSENCE, never zero. A side with no family, or whose pooled principal does
 * not run off inside the horizon, has NO WAL; the gap and the ratio need both
 * sides, and the ratio additionally needs a non-zero asset WAL. A key the
 * metric cannot observe is left out of the row rather than written as 0, NaN
 * or Infinity.
 */
import { commitmentFamilyIds } from "../commitment/offBalanceSheet";
import { isNonRateFamily } from "../nonRate";
import type { BalanceSheetSide } from "../contracts/ids";
import type { CustomMetricKey, CustomMetricResult } from "../contracts/customMetric";
import type { FamilyCashflows } from "../contracts/results";
import type { CustomMetricInput } from "../plugins/services";
import { familyWalYears } from "../portfolio/aggregate";
import { derivativeFamilyIds } from "../swap/derivatives";

/** The five declared keys, in author order. Ids are hyphenated, per CUSTOM_METRIC_ID_PATTERN. */
export const WAL_GAP_KEYS: CustomMetricKey[] = [
  {
    id: "asset-wal",
    label: "Principal-weighted average life of all asset families, in-horizon, months",
    unit: "months",
  },
  {
    id: "liability-wal",
    label: "Principal-weighted average life of all liability families, in-horizon, months",
    unit: "months",
  },
  {
    id: "wal-gap",
    label: "asset-wal minus liability-wal",
    unit: "months",
  },
  {
    id: "wal-ratio",
    label: "liability-wal over asset-wal",
    unit: "fraction",
  },
  {
    // Per-family only. A scenario row has no single family, so it leaves this
    // key out; the declaration is shared because the contract declares keys
    // once for the whole metric.
    id: "wal",
    label: "Principal-weighted average life of this family, in-horizon, months",
    unit: "months",
  },
];

export function computeWalGap(input: CustomMetricInput): CustomMetricResult {
  const sideOf = new Map<string, BalanceSheetSide>();
  for (const fam of input.book.coa.families) sideOf.set(fam.id, fam.side);
  // Off balance sheet. A commitment family is declared asset-side, so
  // it would otherwise join the ASSET pool with a negative (drawdown) principal
  // stream and make the pooled asset WAL unobservable. A weighted average life
  // measures how long a booked balance survives; an undrawn line has no booked
  // balance, so it has no WAL of its own either and drops its family row too.
  const commitments = commitmentFamilyIds(input.book.coa);
  // A swap's notional exchanges are never cash, so a WAL over them is
  // undefined. The row is dropped, as for an undrawn line.
  const derivatives = derivativeFamilyIds(input.book.coa);
  // S3a-1 follow-up: a non-rate-sensitive balance never repays, so its life is undefined; its row is dropped.
  const nonRate = new Set(input.book.coa.families.filter((f) => isNonRateFamily(f)).map((f) => f.id));

  return {
    metricId: "wal-gap",
    label: "WAL gap (asset and liability weighted average life, months)",
    keys: WAL_GAP_KEYS,
    byScenario: input.scenarios.map(({ scenarioId, cashflows }) => {
      const onBook = cashflows.byFamily.filter(
        (f) => !commitments.has(f.familyId) && !derivatives.has(f.familyId) && !nonRate.has(f.familyId),
      );
      return {
        scenarioId,
        values: scenarioValues(onBook, sideOf),
        byFamily: onBook.map((fam) => ({
          familyId: fam.familyId,
          values: familyValues(fam),
        })),
      };
    }),
  };
}

/** One family's own WAL in months, or nothing when its principal does not run off. */
function familyValues(family: FamilyCashflows): Record<string, number> {
  const years = familyWalYears(family.series.principal);
  return years === undefined ? {} : { wal: years * 12 };
}

/**
 * The scenario row: one pooled WAL per side, their difference and their ratio.
 * A family the chart of accounts does not classify belongs to no side pool; it
 * is skipped here and still reports its own row above.
 */
function scenarioValues(
  families: readonly FamilyCashflows[],
  sideOf: ReadonlyMap<string, BalanceSheetSide>,
): Record<string, number> {
  const asset = pooledWalMonths(families.filter((f) => sideOf.get(f.familyId) === "asset"));
  const liability = pooledWalMonths(families.filter((f) => sideOf.get(f.familyId) === "liability"));

  const values: Record<string, number> = {};
  if (asset !== undefined) values["asset-wal"] = asset;
  if (liability !== undefined) values["liability-wal"] = liability;
  if (asset !== undefined && liability !== undefined) {
    values["wal-gap"] = asset - liability;
    // A ratio over a zero WAL is undefined, so the key is left out rather than
    // written as Infinity. This is the honesty rule of the slot, in one line.
    if (asset > 0) values["wal-ratio"] = liability / asset;
  }
  return values;
}

/**
 * Sum the principal series of one side element-wise, then fold once. The pooled
 * length is the longest series on the side; a shorter series contributes 0 to
 * the buckets it does not reach, which is the truth about a family that has
 * already run off, not a dropped bucket.
 */
function pooledWalMonths(families: readonly FamilyCashflows[]): number | undefined {
  if (families.length === 0) return undefined;
  let length = 0;
  for (const fam of families) length = Math.max(length, fam.series.principal.length);
  const pooled = new Array<number>(length).fill(0);
  for (const fam of families) {
    const principal = fam.series.principal;
    for (let k = 0; k < principal.length; k++) pooled[k] += principal[k]!;
  }
  const years = familyWalYears(pooled);
  return years === undefined ? undefined : years * 12;
}
