/**
 * The containment predicate for undrawn committed lines.
 *
 * An undrawn line is NOT AN ASSET. Counting its notional, or the running
 * undrawn balance the draw walk reports, in any asset aggregate inflates total
 * assets by money the bank does not own and breaks every asset-side ratio
 * downstream. And a draw is a CASH OUTFLOW ONLY: the engine does not book the
 * resulting earning asset, so NII, EVE, the gap ladders and FTP must not move
 * when a line draws.
 *
 * Neither rule can be expressed as a side test, which is why this file exists.
 * A commitment family is declared `side: "asset"` (a line is extended BY the
 * bank; see terms.ts), so every `side === "asset"` fold in the engine keeps it
 * by default and folds a NEGATIVE principal into an asset column. Nothing
 * throws; the number merely becomes wrong. The discriminant that does work is
 * the family's declared `instrumentType`, and it is named once, here, so the
 * guarded folds cannot drift apart from one another.
 *
 * WHAT IS DELIBERATELY NOT GUARDED, because a draw genuinely belongs there:
 * the two LCR arms (`report/lcr.ts`) and `survival-horizon`, which read the
 * FLOWS and must see the draw as an outflow. Containment means keeping the line
 * out of the aggregates that treat it as money the bank owns, not hiding it.
 *
 * WHAT REFUSES RATHER THAN EXCLUDES: the single-instrument drill
 * (`instrument/projectInstrument.ts`). A fold has other rows to answer with, so
 * dropping one is a complete answer; the drill's whole reply IS the one line,
 * and a reply with the rows but no PV and no duration would be a drill that
 * answered nothing while looking like it had. So the drill throws
 * `ProjectInstrumentError` on `terms.type === "commitment"` instead. This is
 * the third disposition alongside the three absence shapes below, and it
 * applies where the excluded thing is the entire subject of the call.
 *
 * ONE FACT, TWO DISCRIMINANTS, AND THE UNWRITTEN INVARIANT THAT JOINS THEM.
 * `gap/gapEngine.ts` keys on the POSITION's `terms.type`, because it holds an
 * Instrument and no family definition. Every other guarded fold (FTP, EVE, the
 * key-rate pass, `balanceSummary`, `walGap`, the stochastic per-path fold) keys
 * on the FAMILY's `instrumentType`, because it walks family-grain series and
 * holds no position. Reading the same fact two ways is safe ONLY while the
 * ADR-010 family/terms mapping holds: a position whose `terms.type` is
 * `commitment` sits in a family whose `instrumentType` is `commitment`, and
 * neither without the other.
 *
 * WHO ENFORCES THAT MAPPING (corrected, piece 7 final fix, item 2a). An earlier
 * version of this comment named `validatePortfolioSpec` in
 * `apps/server/src/intake/validationReport.ts:209` as the one check that does.
 * It does not, and it cannot, for THIS type. That line compares `terms.type`
 * against the family's `instrumentType`, but it is never reached by a
 * commitment: line 201 refuses `terms.type "commitment"` as "not one of the
 * kernel instrument types" and `continue`s first, and `validateCoa` refuses the
 * FAMILY separately, because its known-type set is the CSV row contract's five
 * kernel types plus the engine-side "cd" arm and nothing else. Measured: the
 * seeded `synthetic-2500-commit-v1` book posted to
 * `POST /api/portfolios/import` comes back 422 with thirteen errors, six
 * `coa.families` refusals and six `terms_type` refusals on the commitment rows
 * (plus the pre-existing `cd` row refusal). So the mapping was enforced
 * NOWHERE for a commitment, and the only producers of a commitment book are
 * exactly the in-memory callers the old comment exempted.
 *
 * `assertCommitmentMapping` below is that enforcement, and `buildCellPlan`
 * (`portfolio/cells.ts`) is its one call site: the single place in a run that
 * walks every position WITH its family definition, once per run, before any
 * scenario is projected and before any instrument is built. Without it a
 * commitment-typed position in a loan family sends its negative draw stream
 * into `lcr-scenario`'s INFLOW arm at 50 percent, into `pvAssets` and into
 * FTP par-matching, and the reverse rates a funded loan as undrawn capacity in
 * `lcr-regulatory` while dropping it from EVE and FTP. Plausible numbers, no
 * throw, which is the class of defect this piece caught three times.
 *
 * RESIDUAL, stated rather than implied: `runStochastic` does not build a cell
 * plan. It calls `aggregateScenario` directly, so a stochastic run over a
 * mismapped book still meets no assertion. One refusal was the scope; the
 * second call site, if it is ever wanted, is `portfolio/aggregate.ts` where
 * `families` and the position are both in hand.
 *
 * HOW ABSENCE IS HANDLED, three ways and not two (piece 7 final fix, item 3).
 * A fold that excludes a commitment family picks one of three, and the rule is:
 * write a ZERO where the quantity is defined and its value for an off-book line
 * genuinely is zero; LEAVE THE ROW OUT where the quantity is undefined for such
 * a line; and where the key set itself is dynamic, drop the KEY.
 *   - Row dropped: `balanceSummary`, `walGap`. A weighted average life over a
 *     line that has no booked balance is not zero, it is undefined, and an
 *     average that silently includes a zero-weight row is a wrong average.
 *   - Row kept with a written 0: `computeEve`'s `?? 0`, `computeFtp`'s
 *     zero-notional row, the gap ladder's untouched accumulators. The present
 *     value of an unbooked asset IS zero, the transfer-priced notional IS zero,
 *     and the repricing bucket IS empty, so the zero is the answer, not a
 *     placeholder for one.
 *   - Dynamic key envelope: the two LCR arms. `commitment-draws` is absent from
 *     the row AND from the declared key list when the book carries no
 *     commitment family, because the metric contract lets the envelope vary and
 *     a zero there would assert a measurement nobody made.
 * Pick by asking whether the quantity is DEFINED for an off-balance-sheet line.
 * If it is not, absence; never 0, never NaN, never null.
 */
import type { ChartOfAccounts, ProductFamilyDef } from "../contracts/chartOfAccounts";
import type { ProductFamilyId } from "../contracts/ids";
import type { Position } from "../contracts/position";
import { CommitmentFamilyMappingError } from "../run/executorErrors";

/** The family instrument type that carries an undrawn committed line. */
export const COMMITMENT_INSTRUMENT_TYPE = "commitment";

/** True when this family holds undrawn committed lines rather than booked balances. */
export function isCommitmentFamily(def: Pick<ProductFamilyDef, "instrumentType">): boolean {
  return def.instrumentType === COMMITMENT_INSTRUMENT_TYPE;
}

/**
 * Refuse a position whose `terms.type` and whose family's `instrumentType`
 * disagree about being a commitment, in EITHER direction. This is the ADR-010
 * mapping for this one type, asserted where both halves are in hand.
 *
 * It is deliberately narrow. It says nothing about the other six instrument
 * types, whose mapping the intake validator does check on the import path;
 * widening it here would duplicate that rule in a second place and the two
 * would drift. A commitment is the case intake cannot reach at all.
 */
export function assertCommitmentMapping(
  pos: Pick<Position, "id" | "familyId" | "terms">,
  fam: Pick<ProductFamilyDef, "instrumentType">,
): void {
  const termsIsCommitment = pos.terms.type === COMMITMENT_INSTRUMENT_TYPE;
  if (termsIsCommitment === isCommitmentFamily(fam)) return;
  throw new CommitmentFamilyMappingError(
    pos.id,
    pos.familyId,
    String(pos.terms.type),
    String(fam.instrumentType),
  );
}

/**
 * The commitment family ids of a book, for a fold that has a family id in hand
 * rather than the definition. Empty for every book seeded before piece 7, so a
 * guarded fold is byte-identical on a commitment-free book.
 */
export function commitmentFamilyIds(coa: ChartOfAccounts): Set<ProductFamilyId> {
  const ids = new Set<ProductFamilyId>();
  for (const f of coa.families) if (isCommitmentFamily(f)) ids.add(f.id);
  return ids;
}
