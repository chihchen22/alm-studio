/**
 * The one selector semantics. The family form is what R1, R2
 * and the 1c license rule read; the position form is the family form over the
 * derived tags plus the predicate over the authored ones. Every reader calls
 * one of these two; there is no third matcher.
 */
import type { ProductFamilyDef } from "../contracts/chartOfAccounts";
import {
  DERIVED_DIMENSION_IDS,
  type DimensionBag,
  type DimensionPredicate,
  type DimensionTaxonomy,
} from "../contracts/dimensions";
import type { ProductFamilyId } from "../contracts/ids";
import { BEHAVIORAL_CLASS_IDS, type BehavioralClassId, type StageSelector } from "../contracts/plan";
import type { PortfolioSpec } from "../contracts/position";
import { dimensionsOf } from "../portfolio/dimensions";

function list<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** The family form, moved from routingGate.ts in 2a. Body unchanged. */
export function selectorMatchesFamily(
  selector: StageSelector | undefined,
  familyId: ProductFamilyId,
  side: string,
  classes: ReadonlySet<BehavioralClassId>,
): boolean {
  if (!selector) return true;
  const fams = list(selector.productFamily);
  if (fams.length > 0 && !fams.includes(familyId)) return false;
  if (selector.side !== undefined && selector.side.toLowerCase() !== side.toLowerCase()) return false;
  const want = list(selector.behavioralClasses);
  if (want.length > 0 && !want.some((c) => classes.has(c))) return false;
  return true;
}

/** Any-of within a tag, all-of across tags. Nothing stated matches everything. */
export function selectorMatchesBag(predicate: DimensionPredicate | undefined, bag: DimensionBag): boolean {
  if (predicate === undefined) return true;
  for (const [dim, want] of Object.entries(predicate)) {
    const have = bag[dim];
    if (have === undefined) return false;
    const wants = list(want);
    const haves = list(have);
    if (!wants.some((w) => haves.includes(w))) return false;
  }
  return true;
}

/**
 * The position form: family facets off the derived tags, then the predicate.
 *
 * The class set is the CALLER's, not the bag's. A position's classes are the
 * union of what its family declares, what the position itself tags and what the
 * run's bindings derive, and only the first two reach the bag. Reading them off
 * the bag would give R3 and R4 a second, narrower answer than the one the
 * routing gate computes, which is the divergence this parameter removes.
 */
export function stageSelectorMatchesPosition(
  selector: StageSelector | undefined,
  bag: DimensionBag,
  classes: ReadonlySet<BehavioralClassId>,
): boolean {
  if (!selector) return true;
  const familyId = String(bag.productFamily ?? "");
  const side = String(bag.side ?? "");
  if (!selectorMatchesFamily(selector, familyId, side, classes)) return false;
  return selectorMatchesBag(selector.dimensions, bag);
}

/** Keys sorted, values sorted and de-duplicated, scalar and one-element list identical. */
export function canonicalPredicate(predicate: DimensionPredicate | undefined): string {
  if (predicate === undefined) return "";
  const keys = Object.keys(predicate).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((k) => {
    const vals = [...new Set(list(predicate[k]))].sort();
    return `${JSON.stringify(k)}:${JSON.stringify(vals)}`;
  });
  return `{${parts.join(",")}}`;
}

const RESERVED: ReadonlySet<string> = new Set(DERIVED_DIMENSION_IDS);
const CLASS_IDS: ReadonlySet<string> = new Set(BEHAVIORAL_CLASS_IDS);

/**
 * A predicate naming a tag nobody declared, or a value a closed tag refuses, is
 * a refusal rather than a non-match: a misspelt tag that silently matched
 * nothing would look like an empty segment. Returns the first offence.
 */
export function checkPredicateAgainstTaxonomy(
  predicate: DimensionPredicate,
  taxonomy: DimensionTaxonomy | undefined,
): { dimension: string; value?: string } | undefined {
  const defs = new Map((taxonomy?.dimensions ?? []).map((d) => [d.id, d]));
  for (const [dim, want] of Object.entries(predicate)) {
    const def = defs.get(dim);
    if (def === undefined && !RESERVED.has(dim)) return { dimension: dim };
    for (const v of list(want)) {
      if (dim === "behavioralClasses" && !CLASS_IDS.has(v)) return { dimension: dim, value: v };
      if (def?.values !== undefined && !def.values.includes(v)) return { dimension: dim, value: v };
    }
  }
  return undefined;
}

/** How many positions of one family a binding's predicate matches. */
export function positionsMatchedBy(
  portfolio: PortfolioSpec,
  familyId: ProductFamilyId,
  predicate: DimensionPredicate | undefined,
): number {
  const family: ProductFamilyDef | undefined = portfolio.coa.families.find((f) => f.id === familyId);
  if (family === undefined) return 0;
  let n = 0;
  for (const pos of portfolio.positions) {
    if (pos.familyId !== familyId) continue;
    if (predicate === undefined || selectorMatchesBag(predicate, dimensionsOf(pos, family, portfolio.taxonomy))) n++;
  }
  return n;
}
