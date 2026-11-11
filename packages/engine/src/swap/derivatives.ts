/**
 * The containment module for interest rate swaps: the one file that
 * names the discriminant and states what every fold does with a swap, so the
 * guarded folds cannot drift apart. It is to swaps what
 * ../commitment/offBalanceSheet.ts is to commitments.
 *
 * THE DISCRIMINANT IS THE FAMILY SIDE, "derivative". Piece 7 declared
 * commitment families asset-side, so every `side === "asset"` fold kept them
 * by default and each needed a guard; a missed guard printed a plausible wrong
 * number. A swap family declares side "derivative" instead, so every existing
 * `side === "asset"` or `side === "liability"` fold EXCLUDES it by default,
 * and a missed fold loses the hedge rather than corrupting an asset figure.
 * The hedged-versus-unhedged cross-check catches a lost hedge.
 *
 * ONE FACT, TWO READINGS. The gap fold (../gap/gapEngine.ts) and the drill
 * (../instrument/projectInstrument.ts) hold an instrument and no family, so
 * they read the POSITION's `terms.type`. Every other fold reads the FAMILY's
 * side. `assertSwapMapping` below keeps the two readings in agreement, at its
 * one call site, `buildCellPlan` (../portfolio/cells.ts). RESIDUAL, carried
 * from piece 7 rather than fixed: `runStochastic` builds no cell plan, so a
 * stochastic run over a mismapped book meets no assertion.
 *
 * SIGNS. A swap's rows are signed at emission (./swapInstrument.ts): receive
 * leg positive, pay leg negative. A swap family's series is therefore the NET
 * swap, and every fold that opts in adds it with sign +1.
 *
 * FOLD DISPOSITIONS (Ledger L1 of the plan is the full enumeration):
 *   IN, on SOFR: EVE `pvDerivatives` (eve/computeEve.ts), equity
 *                           effective duration (eve/effectiveDuration.ts), the
 *                           key-rate pass and the channels
 *                           (eve/keyRate.ts, eve/channels.ts), the stochastic
 *                           per-path EVE (run/stochastic.ts).
 *   IN, net:                NII, as the derivatives line (nii/computeNII.ts),
 *                           and the FTP NIM bridge's derivatives term.
 *   IN, both legs:          the repricing gap ladder, in the assets column,
 *                           signed (gap/gapEngine.ts).
 *   OUT, row kept at 0:     FTP family row (ftp/computeFtp.ts).
 *   OUT, row dropped:       balance-summary, wal-gap (report/).
 *   OUT, by side, no edit:  both LCR arms, survival-horizon, the HQLA buffer,
 *                           the liquidity gap ladder (notional exchanges are
 *                           never cash).
 *   REFUSED:                a behavioral overlay bound to a swap family
 *                           (scenario/resolveAssumptions.ts), a dynamic
 *                           new-business rule on a swap family
 *                           (projection/dynamic/dynamicNewBusiness.ts), a swap
 *                           at import (apps/server intake).
 *   ANSWERS:                the drill: PV on SOFR, duration per unit of
 *                           notional, both leg schedules.
 *
 * EXACTNESS. Every fold that opts in accumulates derivative families into
 * their OWN subtotal and adds it to the book figure once, at the end. Two
 * consequences: a book with no derivative family is byte-identical to before;
 * and a pay-fixed and a receive-fixed swap on identical terms, in two
 * families, net to exactly 0.0 in every fold (their per-family series are
 * exact IEEE negations, so the subtotal is exactly 0 and the book figure plus
 * 0 is the book figure). Inside ONE family the per-bucket sum of the two swaps
 * is exact only to rounding.
 */
import type { ChartOfAccounts, ProductFamilyDef } from "../contracts/chartOfAccounts";
import type { ProductFamilyId } from "../contracts/ids";
import type { Position } from "../contracts/position";
import { SwapFamilyMappingError } from "../run/executorErrors";

/** The position terms type and family instrument type of a swap. */
export const SWAP_INSTRUMENT_TYPE = "swap";

/** The family side a swap family declares. A const literal, so `side === DERIVATIVE_SIDE` narrows. */
export const DERIVATIVE_SIDE = "derivative" as const;

/** True when the family holds derivatives rather than booked balances. */
export function isDerivativeFamily(def: Pick<ProductFamilyDef, "side">): boolean {
  return def.side === DERIVATIVE_SIDE;
}

/** The derivative family ids of a book. Empty for every book seeded before piece 8. */
export function derivativeFamilyIds(coa: ChartOfAccounts): Set<ProductFamilyId> {
  const ids = new Set<ProductFamilyId>();
  for (const f of coa.families) if (isDerivativeFamily(f)) ids.add(f.id);
  return ids;
}

/** True when the book carries at least one derivative family: the gate on every additive key. */
export function hasDerivativeFamily(coa: ChartOfAccounts): boolean {
  return coa.families.some(isDerivativeFamily);
}

/**
 * Refuse a position unless its `terms.type`, its family's `instrumentType`
 * and its family's side agree about being a swap: all three say so, or none
 * does. Four ways to break that, and each one computes silently without this:
 * swap terms in a loan family, loan terms in a swap family, a swap family on
 * the asset side, a loan family on the derivative side.
 */
export function assertSwapMapping(
  pos: Pick<Position, "id" | "familyId" | "terms">,
  fam: Pick<ProductFamilyDef, "instrumentType" | "side">,
): void {
  const termsIsSwap = pos.terms.type === SWAP_INSTRUMENT_TYPE;
  const familyIsSwap = fam.instrumentType === SWAP_INSTRUMENT_TYPE;
  const familyIsDerivative = fam.side === DERIVATIVE_SIDE;
  if (termsIsSwap === familyIsSwap && familyIsSwap === familyIsDerivative) return;
  throw new SwapFamilyMappingError(
    pos.id,
    pos.familyId,
    String(pos.terms.type),
    String(fam.instrumentType),
    String(fam.side),
  );
}
