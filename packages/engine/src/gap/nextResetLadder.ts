/**
 * The next-reset repricing ladder, the ALCO convention.
 *
 * The engine's own repricing ladder (gapEngine.ts) books principal by the
 * month it is received, so a level-pay loan or a mortgage spreads over many
 * bands. The book's ALCO ladder books each position ONCE, at the month its rate
 * next changes:
 *
 *   floating-loan            full current notional at its first reset month
 *                            (the kernel FloatingLoan's repricing schedule
 *                            starts at month 1 for every reset cadence);
 *   fixed-loan, mortgage     full current notional at the contractual maturity
 *                            month, no amortisation (a seasoned fixed loan at its
 *                            remaining maturity, maturityMonths plus the negative
 *                            origination offset);
 *   cd                       each cohort's share of the notional (its balance
 *                            over the book's) at that cohort's months to maturity;
 *   nmd-b                    beta0 x notional in band 0-1M, (1 - beta0) x
 *                            notional held out as core;
 *   nmd                      the whole notional held out as core;
 *   repricingTreatment       any position flagged "excluded" (the regulatory
 *     "excluded"             transform's core rungs and its non-interest-bearing
 *                            non-core slice) held out as core at full notional;
 *   swap, commitment         uncovered, with the reason.
 *
 * A month m sits in bucket m - 1 and so in the band the engine's other ladders
 * use (bands.ts); a month past the last edge sits in 10Y+. Assets and
 * liabilities follow the family's side in the chart of accounts. Pure: the
 * caller supplies beta0, the beta at r0 the run's effective deposit-beta
 * binding gives (nmd/runEntry.ts), so this module reads no curve.
 */
import { FloatingLoan } from "@alm/kernel";
import type { BalanceSheetSide } from "../contracts/ids";
import type { PortfolioSpec, Position } from "../contracts/position";
import type { NextResetLadder, NextResetLadderRow } from "../contracts/results";
import { GAP_BAND_LABELS, bandForBucket, buildBands } from "./bands";

/** The nine bands with the last one open: every month from 1 upward maps. */
const OPEN_BANDS = buildBands(Number.MAX_SAFE_INTEGER);

/** The band index of month m (1-based), on the open nine bands. Shared with the fixed-rate ladder. */
export function bandOfMonth(month: number): number {
  return bandForBucket(Math.max(0, month - 1), OPEN_BANDS);
}

/** Why the ladder leaves a position out, or undefined when it places it. */
function sideReason(side: BalanceSheetSide | undefined, familyId: string): string | undefined {
  if (side === "asset" || side === "liability") return undefined;
  return `family "${familyId}" sits on the ${side ?? "undeclared"} side; the next-reset ladder places assets and liabilities only`;
}

/**
 * Build the next-reset ladder of a book. `betaAtR0` is called once per nmd-b
 * position that is not flagged excluded and must return a decimal in [0, 1].
 */
export function computeNextResetLadder(book: PortfolioSpec, betaAtR0: (p: Position) => number): NextResetLadder {
  const sideByFamily = new Map<string, BalanceSheetSide>();
  for (const fam of book.coa.families) sideByFamily.set(fam.id, fam.side);
  const assets = new Array<number>(GAP_BAND_LABELS.length).fill(0);
  const liabilities = new Array<number>(GAP_BAND_LABELS.length).fill(0);
  let coreExcluded = 0;
  const uncovered: { positionId: string; reason: string }[] = [];

  for (const p of book.positions) {
    const terms = p.terms;
    const type = terms.type as string;
    if (type === "swap") {
      uncovered.push({ positionId: p.id, reason: "a swap carries no balance-sheet notional in the next-reset ladder; its legs are in the engine's repricing ladder" });
      continue;
    }
    if (type === "commitment") {
      uncovered.push({ positionId: p.id, reason: "an off-balance-sheet commitment has no drawn balance to reprice in the next-reset ladder" });
      continue;
    }
    const side = sideByFamily.get(p.familyId);
    const noSide = sideReason(side, p.familyId);
    if (noSide !== undefined) {
      uncovered.push({ positionId: p.id, reason: noSide });
      continue;
    }
    const col = side === "asset" ? assets : liabilities;
    const book1 = (month: number, amount: number): void => {
      col[bandOfMonth(month)]! += amount;
    };

    if (p.repricingTreatment === "excluded") {
      coreExcluded += terms.notional;
      continue;
    }
    switch (terms.type) {
      case "nmd":
        coreExcluded += terms.notional;
        break;
      case "nmd-b": {
        const beta = betaAtR0(p);
        if (!Number.isFinite(beta) || beta < 0 || beta > 1) {
          throw new Error(`computeNextResetLadder: position "${p.id}" has a beta at r0 of ${String(beta)}; the repricing slice needs a beta in [0, 1]`);
        }
        book1(1, beta * terms.notional);
        coreExcluded += (1 - beta) * terms.notional;
        break;
      }
      case "floating-loan": {
        const first = new FloatingLoan(terms).repricingSchedule()[0];
        book1(first ?? terms.maturityMonths, terms.notional);
        break;
      }
      case "fixed-loan": {
        const offset = terms.originationOffsetMonths;
        if (offset < 0 && terms.amortType !== "bullet") {
          uncovered.push({
            positionId: p.id,
            reason: `a seasoned ${terms.amortType} fixed loan carries its original notional; its current balance needs the amortisation schedule, which the next-reset ladder does not run`,
          });
          break;
        }
        book1(terms.maturityMonths + Math.min(0, offset), terms.notional);
        break;
      }
      case "mortgage":
        book1(terms.maturityMonths, terms.notional);
        break;
      case "cd": {
        const total = terms.cohorts.reduce((s, c) => s + c.balance, 0);
        if (!(total > 0)) {
          uncovered.push({ positionId: p.id, reason: "a cd cohort book with no positive cohort balance has no share to place" });
          break;
        }
        for (const c of terms.cohorts) book1(c.monthsToMaturity, (terms.notional * c.balance) / total);
        break;
      }
      default:
        uncovered.push({ positionId: p.id, reason: `instrument type "${type}" has no next-reset rule` });
    }
  }

  const rows: NextResetLadderRow[] = [];
  let cumulative = 0;
  for (let b = 0; b < GAP_BAND_LABELS.length; b++) {
    const gap = assets[b]! - liabilities[b]!;
    cumulative += gap;
    rows.push({ band: GAP_BAND_LABELS[b]!, assets: assets[b]!, liabilities: liabilities[b]!, gap, cumulativeGap: cumulative });
  }
  return { bands: [...GAP_BAND_LABELS], rows, coreExcluded, uncovered };
}
