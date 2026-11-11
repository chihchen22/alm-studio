/**
 * NII engine: side-signed net interest income from bucketed cash flows.
 *
 * Input is the projected bucketed cash flows (one ScenarioCashflows per
 * scenario, from the dynamic or static aggregator) plus the chart of accounts.
 * Output is interest income, interest expense, and net at 12 and 24 months, per
 * scenario, decomposed to product family, with scenario totals (contract
 * results.ts NIIResult) — plus, from schemaVersion 1.2.0, a
 * horizon-keyed byHorizon map and the side-signed monthly net vector.
 *
 * Sign convention (the catalog's alm-nii component): the kernel emits interestPaid as a POSITIVE
 * magnitude on both sides (see fixedLoan / floatingLoan: interest = balance *
 * rate / 12, never negated by side). The side flip lives here: asset interest is
 * income, liability interest is expense, and net = income - expense. This module
 * classifies by the family's declared side, which is the aggregated grain's side
 * and mirrors terms.side by construction (a ProductFamilyDef carries one side and
 * all its positions instantiate it). Forgetting the flip would
 * double-count deposit interest as income.
 *
 * Horizons: the FamilyNII contract pins the net12/net24 field pairs, and those
 * are computed unconditionally exactly as before (same accumulation, same
 * order — the pre-1.2.0 numbers are byte-identical). The byHorizon map carries
 * one window per requested horizon; where a requested horizon is 12 or 24 the
 * entry COPIES the pinned pair's already-summed values, so
 * net12 === byHorizon[12].net holds as identity, not as a tolerance. A window
 * is summed over the first N buckets of the family's interest series (bucket k
 * is calendar month k+1), clamped to the series length so a horizon
 * beyond the grid does not read past the array (the defensive path the
 * The limitations page entry discloses).
 *
 * The monthly net vector is netMonthly[k] = sideSign * interest[k] (0 for an
 * equity family). IEEE-754 negation is exact and round-to-nearest is
 * sign-symmetric, so the ordered partial sums of netMonthly reproduce the
 * horizon nets EXACTLY on both sides of the balance sheet (asserted in tests).
 *
 * Determinism: pure arithmetic over the input arrays in their given order.
 * Families emit in the order the aggregate presents them (declared family order);
 * the side lookup Map is read-only and feeds no ordering. byHorizon objects are
 * built by inserting ascending integer keys, which serialize in ascending
 * numeric order under the ECMAScript integer-key rule. No clock, no RNG.
 */
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import type { BalanceSheetSide, ProductFamilyId } from "../contracts/ids";
import type {
  CellNII,
  FamilyNII,
  NIIByHorizon,
  NIIResult,
  ScenarioCashflows,
  ScenarioNII,
} from "../contracts/results";
import type { PortfolioSpec } from "../contracts/position";
import type { CellRef } from "../contracts/views";
import { DERIVATIVE_SIDE, hasDerivativeFamily } from "../swap/derivatives";

/** Default horizons, months. The FamilyNII contract pins these two as fields. */
export const NII_HORIZONS_MONTHS: readonly number[] = [12, 24];

/** Sum a family's interest over the first `months` buckets, clamped to length. */
function sumInterest(interest: number[], months: number): number {
  const n = Math.min(months, interest.length);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += interest[k];
  return sum;
}

/** rowFields always fills byHorizon and netMonthly; the contract keeps them optional for archived envelopes. */
type RowFields = Omit<FamilyNII, "familyId" | "byHorizon" | "netMonthly"> & {
  byHorizon: NIIByHorizon;
  netMonthly: number[];
};

/**
 * The additive fields of one row, off one interest series and one side. The
 * expressions and their ORDER are copied from the per-family body below, so a
 * family row and a cell row of the same series agree to the bit.
 *
 * Reads `interest` and never writes it: foldCellsToFamilies ALIASES a
 * single-cell family's array into the family slot, so the array this receives
 * can be the very same object the family row was built from.
 *
 * Equity families (none in the catalogue) contribute to neither side.
 * Horizon windows for 12 and 24 COPY the pinned pair's sums (identity by
 * construction, never a recomputation); any other horizon sums the same series
 * with the same clamped loop. The side-signed monthly net is +interest (asset),
 * -interest (liability), 0 (equity): negation is exact, so the ordered partial
 * sums of that vector reproduce the horizon nets exactly. Exact zeros are
 * normalized to +0, because negating a zero-interest bucket yields -0, which
 * JSON serializes as "0"; an in-memory value the wire erases breaks
 * deep-equality across transport layers (the MCP in-process-vs-serialized
 * comparison) while changing no sum, since a zero of either sign is additively
 * inert here.
 */
function rowFields(
  interest: number[],
  side: BalanceSheetSide,
  horizonsMonths: readonly number[],
): RowFields {
  const int12 = sumInterest(interest, 12);
  const int24 = sumInterest(interest, 24);
  const isAsset = side === "asset";
  const isLiability = side === "liability";
  // A derivative family's interest is already the net settlement
  // (signed at emission), so it books neither income nor expense and its net
  // is the signed sum. See the FamilyNII contract comment.
  const isDerivative = side === DERIVATIVE_SIDE;
  const interestIncome12 = isAsset ? int12 : 0;
  const interestExpense12 = isLiability ? int12 : 0;
  const interestIncome24 = isAsset ? int24 : 0;
  const interestExpense24 = isLiability ? int24 : 0;
  const net12 = isDerivative ? int12 : interestIncome12 - interestExpense12;
  const net24 = isDerivative ? int24 : interestIncome24 - interestExpense24;
  const byHorizon: NIIByHorizon = {};
  for (const h of horizonsMonths) {
    if (h === 12) {
      byHorizon[h] = { interestIncome: interestIncome12, interestExpense: interestExpense12, net: net12 };
    } else if (h === 24) {
      byHorizon[h] = { interestIncome: interestIncome24, interestExpense: interestExpense24, net: net24 };
    } else {
      const intH = sumInterest(interest, h);
      const interestIncome = isAsset ? intH : 0;
      const interestExpense = isLiability ? intH : 0;
      byHorizon[h] = {
        interestIncome,
        interestExpense,
        net: isDerivative ? intH : interestIncome - interestExpense,
      };
    }
  }
  const sign = isAsset || isDerivative ? 1 : isLiability ? -1 : 0;
  const netMonthly = new Array<number>(interest.length);
  for (let k = 0; k < interest.length; k++) {
    const raw = sign === 0 ? 0 : sign * interest[k]!;
    netMonthly[k] = raw === 0 ? 0 : raw; // -0 -> +0; every other value unchanged
  }
  return {
    interestIncome12,
    interestExpense12,
    net12,
    interestIncome24,
    interestExpense24,
    net24,
    byHorizon,
    netMonthly,
  };
}

/**
 * Validate a requested horizon list: positive integers, strictly ascending
 * (which enforces uniqueness). A malformed list is a caller error to fix, not
 * a shape to normalize silently — reordering or deduplicating here would make
 * the envelope disagree with what the caller asked for.
 */
function validateHorizons(horizons: readonly number[]): void {
  if (horizons.length === 0) {
    throw new Error("computeNII: horizonsMonths must name at least one horizon");
  }
  for (let i = 0; i < horizons.length; i++) {
    const h = horizons[i];
    if (!Number.isInteger(h) || h <= 0) {
      throw new Error(
        `computeNII: horizon ${String(h)} is not a positive integer number of months`,
      );
    }
    if (i > 0 && horizons[i] <= horizons[i - 1]) {
      throw new Error(
        `computeNII: horizonsMonths must be strictly ascending; got ${horizons[i - 1]} before ${horizons[i]}`,
      );
    }
  }
}

/**
 * Compute NII from bucketed cash flows and the chart of accounts.
 *
 * @param scenarioCashflows one bucketed-cash-flow set per scenario.
 * @param coa the chart of accounts, for the family -> side classification.
 * @param horizonsMonths horizons to report in byHorizon, months, strictly
 *   ascending positive integers. Defaults to [12, 24]. The pinned net12/net24
 *   fields are computed regardless of this list.
 * @param cells the run's cell dictionary. Supplied together with
 *   per-cell series on the scenario rows, it adds a `byCell` arm beside
 *   `byFamily`. The scenario TOTALS keep folding over byFamily and are never
 *   recomputed from cells. They can still differ in the last bits between a run
 *   with a view and the same book run without one, because the family series
 *   this function reads is itself the ordered fold of the family's cells and a
 *   family holding two or more cells re-associates its own sum. Stated in full
 *   at contracts/results.ts ScenarioNII.byCell and on the limitations page.
 */
export function computeNII(
  scenarioCashflows: readonly ScenarioCashflows[],
  coa: ChartOfAccounts,
  horizonsMonths: readonly number[] = NII_HORIZONS_MONTHS,
  cells?: readonly CellRef[],
): NIIResult {
  validateHorizons(horizonsMonths);
  const sideByFamily = new Map<ProductFamilyId, BalanceSheetSide>();
  for (const fam of coa.families) sideByFamily.set(fam.id, fam.side);
  const withDerivatives = hasDerivativeFamily(coa);
  const familyOfCell = new Map<string, ProductFamilyId>();
  for (const c of cells ?? []) familyOfCell.set(c.id, c.familyId);

  const byScenario: ScenarioNII[] = scenarioCashflows.map((scn) => {
    let totalNet12 = 0;
    let totalNet24 = 0;
    const totalNetByHorizon: { [months: number]: number } = {};
    for (const h of horizonsMonths) totalNetByHorizon[h] = 0;
    // Scenario monthly vector length: the longest family series in this scenario.
    let maxLen = 0;
    for (const fam of scn.byFamily) {
      if (fam.series.interest.length > maxLen) maxLen = fam.series.interest.length;
    }
    const scnNetMonthly = new Array<number>(maxLen).fill(0);

    // The derivatives line, summed apart and added once, last.
    let derivativesNet12 = 0;
    let derivativesNet24 = 0;
    const derivativesNetByHorizon: { [months: number]: number } = {};
    for (const h of horizonsMonths) derivativesNetByHorizon[h] = 0;
    const derivativesMonthly = new Array<number>(maxLen).fill(0);

    // The per-family fold. Every field expression lives in rowFields; the
    // totals accumulate here, in the order they always did.
    const byFamily: FamilyNII[] = scn.byFamily.map((fam) => {
      const side = sideByFamily.get(fam.familyId);
      if (side === undefined) {
        throw new Error(
          `computeNII: family "${fam.familyId}" is not in the chart of accounts`,
        );
      }
      const fields = rowFields(fam.series.interest, side, horizonsMonths);
      const netMonthly = fields.netMonthly;
      if (side === DERIVATIVE_SIDE) {
        derivativesNet12 += fields.net12;
        derivativesNet24 += fields.net24;
        for (const h of horizonsMonths) derivativesNetByHorizon[h] += fields.byHorizon[h]!.net;
        for (let k = 0; k < netMonthly.length; k++) derivativesMonthly[k] += netMonthly[k]!;
        return { familyId: fam.familyId, ...fields };
      }
      totalNet12 += fields.net12;
      totalNet24 += fields.net24;
      for (const h of horizonsMonths) totalNetByHorizon[h] += fields.byHorizon[h]!.net;
      for (let k = 0; k < netMonthly.length; k++) scnNetMonthly[k] += netMonthly[k]!;
      return { familyId: fam.familyId, ...fields };
    });

    if (withDerivatives) {
      totalNet12 += derivativesNet12;
      totalNet24 += derivativesNet24;
      for (const h of horizonsMonths) totalNetByHorizon[h] += derivativesNetByHorizon[h]!;
      for (let k = 0; k < maxLen; k++) scnNetMonthly[k] += derivativesMonthly[k]!;
    }

    // The same per-row fold, aimed at the cell series. Emitted only
    // when the caller supplied a dictionary AND the rows carry cell series.
    let byCell: CellNII[] | undefined;
    if (cells !== undefined && scn.byCell !== undefined) {
      byCell = scn.byCell.map((cell) => {
        const familyId = familyOfCell.get(cell.cellId);
        const side = familyId === undefined ? undefined : sideByFamily.get(familyId);
        if (side === undefined) {
          throw new Error(
            `computeNII: cell "${cell.cellId}" names no family in the chart of accounts`,
          );
        }
        return { cellId: cell.cellId, ...rowFields(cell.series.interest, side, horizonsMonths) };
      });
    }

    return {
      scenarioId: scn.scenarioId,
      byFamily,
      ...(byCell !== undefined ? { byCell } : {}),
      totalNet12,
      totalNet24,
      totalNetByHorizon,
      netMonthly: scnNetMonthly,
      ...(withDerivatives ? { derivativesNet12, derivativesNet24, derivativesNetByHorizon } : {}),
    };
  });

  return { horizonsMonths: [...horizonsMonths], byScenario };
}

// --- NIM (schema 1.9.0) ----------------------------------------------

/**
 * Total asset notional of a book, the NIM denominator: the notional of
 * every position whose family sits on the asset side, in book order. An undrawn
 * commitment and a swap are left out: the first is off-balance-sheet face, the
 * second a notional that is not a balance. A position whose family is not in the
 * chart of accounts counts as not an asset.
 */
export function totalAssetNotional(book: PortfolioSpec): number {
  const sideByFamily = new Map<ProductFamilyId, BalanceSheetSide>();
  for (const fam of book.coa.families) sideByFamily.set(fam.id, fam.side);
  let total = 0;
  for (const p of book.positions) {
    if (sideByFamily.get(p.familyId) !== "asset") continue;
    if (p.terms.type === "commitment" || p.terms.type === "swap") continue;
    total += p.terms.notional;
  }
  return total;
}

/**
 * NIM in percent on the engine's runoff convention: 100 x the base
 * scenario's totalNet12 / total asset notional. Undefined, so the caller leaves
 * the optional field out, when the base scenario has no NII row or the book holds
 * no asset notional (a ratio over zero is not a number this engine writes).
 */
export function niiNimPct(nii: NIIResult, baseScenarioId: string, assetNotional: number): number | undefined {
  const base = nii.byScenario.find((s) => s.scenarioId === baseScenarioId);
  if (base === undefined || !(assetNotional > 0)) return undefined;
  return (100 * base.totalNet12) / assetNotional;
}
