/**
 * A family's behavioral classes: the union of what the chart of accounts
 * DECLARES on the family (round-2 ruling 1) and what the run's overlay
 * bindings DERIVE. The declared half carries the classes no overlay kind
 * produces; the derived
 * half is the piece-1 bridge, which piece 2 replaces with the position's own
 * dimension bag. Piece 7 moves draw-utilization across that line: the
 * commitment-draw overlay now DERIVES it, so a family carrying the overlay no
 * longer has to declare the class as well. Piece 9 does the same for
 * client-rate-asset: the loan-client-rate overlay derives it. The table is
 * exported so tests pin it.
 */
import type { AssumptionSet, BuiltinOverlayKind } from "../contracts/assumptions";
import type { ProductFamilyDef } from "../contracts/chartOfAccounts";
import type { DimensionTaxonomy } from "../contracts/dimensions";
import type { ProductFamilyId } from "../contracts/ids";
import type { BehavioralClassId } from "../contracts/plan";
import type { Position } from "../contracts/position";
import { dimensionsOf } from "../portfolio/dimensions";

export const OVERLAY_KIND_TO_CLASS: Record<BuiltinOverlayKind, BehavioralClassId> = {
  prepay: "prepayment",
  "nmd-decay": "decay",
  "deposit-beta": "deposit-beta",
  "cd-rollover": "early-withdrawal",
  "commitment-draw": "draw-utilization",
  "loan-client-rate": "client-rate-asset",
};

export function derivedClassesByFamily(
  sets: AssumptionSet[],
  families: ProductFamilyDef[] = [],
): Map<ProductFamilyId, Set<BehavioralClassId>> {
  const out = new Map<ProductFamilyId, Set<BehavioralClassId>>();
  const add = (familyId: ProductFamilyId, cls: BehavioralClassId): void => {
    const bag = out.get(familyId) ?? new Set<BehavioralClassId>();
    bag.add(cls);
    out.set(familyId, bag);
  };
  for (const family of families) for (const cls of family.behavioralClasses ?? []) add(family.id, cls);
  for (const set of sets) {
    for (const b of set.bindings) {
      // A registered kind maps to no plan behavioral class in 1b: the class a
      // user plugin belongs to is the dimension bag's job, and
      // inventing one here would put a class into R4 coverage that no policy
      // row governs.
      if (b.overlay.kind === "registered") continue;
      add(b.familyId, OVERLAY_KIND_TO_CLASS[b.overlay.kind]);
    }
  }
  return out;
}

/**
 * The classes ONE position carries: its family's declared classes and its own
 * behavioralClasses tag (both through dimensionsOf) plus the classes the run's
 * bindings derive for its family. R4 reads this per position.
 */
export function classesOfPosition(
  position: Position,
  family: ProductFamilyDef,
  derivedForFamily: ReadonlySet<BehavioralClassId> | undefined,
  taxonomy: DimensionTaxonomy | undefined,
): Set<BehavioralClassId> {
  const bag = dimensionsOf(position, family, taxonomy);
  const own = bag.behavioralClasses;
  const list = own === undefined ? [] : Array.isArray(own) ? own : [own];
  const out = new Set<BehavioralClassId>(list as BehavioralClassId[]);
  for (const c of derivedForFamily ?? []) out.add(c);
  return out;
}
