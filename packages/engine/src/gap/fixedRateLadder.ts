/**
 * The fixed-rate (rate-locked) gap ladder, the rate-locked half of the ALCO
 * 10.8 (capstone build, fixed_rate_gap_alco).
 *
 * The next-reset ladder (nextResetLadder.ts) asks when a position's rate next
 * changes, and books a fixed loan's whole notional at its maturity. This ladder
 * asks the other question of the same schedule: when does the money on a
 * rate-locked position come back. Each rate-locked position's principal is
 * booked in the band of the month it is paid, so a level-pay loan spreads over
 * many bands, and a prepayment overlay moves principal into the short bands.
 *
 *   fixed-loan, mortgage, cd   rate-locked: principal by payment month;
 *   nmd, flagged "excluded"    rate-locked: a regulatory-convention slice (a
 *                              core rung, or the non-interest-bearing non-core
 *                              slice) is held at a fixed paid rate;
 *   floating-loan, nmd-b, nmd  not rate-locked: left out, no reason needed;
 *   swap, commitment           uncovered, with the reason.
 *
 * A cash flow at monthOffset m of a position with seasoning offset `off` is
 * paid in month m + off; a month below 1 is elapsed and dropped, as in the gap
 * fold. A month sits in the band nextResetLadder.ts uses (month m in bucket
 * m - 1), with the last band open, so nothing is cut at the grid horizon and
 * the cumulative gap through the last band is the whole rate-locked book less
 * any elapsed principal. Assets and liabilities follow the family's side.
 *
 * Pure: the caller supplies each position's cash flows on the base path, so
 * this module reads no curve and builds no instrument.
 */
import type { Cashflow } from "@alm/kernel";
import type { BalanceSheetSide, ScenarioId } from "../contracts/ids";
import type { PortfolioSpec, Position } from "../contracts/position";
import type { FixedRateLadder, NextResetLadderRow } from "../contracts/results";
import { seasoningOffsetOf } from "../portfolio/seasoning";
import { GAP_BAND_LABELS } from "./bands";
import { bandOfMonth } from "./nextResetLadder";

/** Whether the ladder places a position, leaves it out as not rate-locked, or cannot place it (with the reason). */
export function rateLockOf(p: Position): "locked" | "not-locked" | { reason: string } {
  const type = p.terms.type as string;
  switch (type) {
    case "fixed-loan":
    case "mortgage":
    case "cd":
      return "locked";
    case "nmd":
      return p.repricingTreatment === "excluded" ? "locked" : "not-locked";
    case "floating-loan":
    case "nmd-b":
      return "not-locked";
    case "swap":
      return { reason: "a swap carries no balance-sheet principal; its fixed leg is in the engine's repricing ladder" };
    case "commitment":
      return { reason: "an off-balance-sheet commitment has no drawn balance with a locked rate" };
    default:
      return { reason: `instrument type "${type}" has no rate-lock rule` };
  }
}

/** Build the fixed-rate ladder of a book from each rate-locked position's cash flows on the base path. */
export function computeFixedRateLadder(
  book: PortfolioSpec,
  scenarioId: ScenarioId,
  cashflowsOf: (p: Position) => readonly Cashflow[],
): FixedRateLadder {
  const sideByFamily = new Map<string, BalanceSheetSide>();
  for (const fam of book.coa.families) sideByFamily.set(fam.id, fam.side);
  const assets = new Array<number>(GAP_BAND_LABELS.length).fill(0);
  const liabilities = new Array<number>(GAP_BAND_LABELS.length).fill(0);
  const uncovered: { positionId: string; reason: string }[] = [];

  for (const p of book.positions) {
    const lock = rateLockOf(p);
    if (lock === "not-locked") continue;
    if (lock !== "locked") {
      uncovered.push({ positionId: p.id, reason: lock.reason });
      continue;
    }
    const side = sideByFamily.get(p.familyId);
    if (side !== "asset" && side !== "liability") {
      uncovered.push({
        positionId: p.id,
        reason: `family "${p.familyId}" sits on the ${side ?? "undeclared"} side; the fixed-rate ladder places assets and liabilities only`,
      });
      continue;
    }
    const col = side === "asset" ? assets : liabilities;
    const off = seasoningOffsetOf(p.terms);
    for (const cf of cashflowsOf(p)) {
      const month = cf.monthOffset + off;
      if (month < 1 || cf.principalPaid === 0) continue;
      col[bandOfMonth(month)]! += cf.principalPaid;
    }
  }

  const rows: NextResetLadderRow[] = [];
  let cumulative = 0;
  for (let b = 0; b < GAP_BAND_LABELS.length; b++) {
    const gap = assets[b]! - liabilities[b]!;
    cumulative += gap;
    rows.push({ band: GAP_BAND_LABELS[b]!, assets: assets[b]!, liabilities: liabilities[b]!, gap, cumulativeGap: cumulative });
  }
  return { scenarioId, bands: [...GAP_BAND_LABELS], rows, uncovered };
}
