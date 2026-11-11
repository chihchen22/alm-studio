/**
 * The dimension bag (harness Plane 1).
 *
 * A position carries a bag of tags drawn from a declared taxonomy. Three tags
 * are DERIVED and never authored on a position: productFamily (the family id),
 * side (the family's side), and behavioralClasses (the family's declared
 * classes plus the position's own list, where the taxonomy declares one). The
 * plural is deliberate: it is the name ProductFamilyDef already uses and the
 * name docs/harness/demo-dimensions.json ships (plan deviation 1).
 *
 * A predicate is any-of within a tag and all-of across tags; no negation, no
 * ranges. A taxonomy is part of the PortfolioSpec so it hashes with the book.
 */
export type DimensionId = string;
export type DimensionValue = string;

export interface DimensionDef {
  id: DimensionId;
  label: string;
  /** Allowed values. Absent means open: any non-empty string. */
  values?: DimensionValue[];
  /** true: a position may carry several values. Absent means false. */
  multiValued?: boolean;
}

export interface DimensionTaxonomy {
  schemaVersion: string;
  id: string;
  label: string;
  dimensions: DimensionDef[];
}

/** What a position carries: one value, or several where the taxonomy allows it. */
export type DimensionBag = Record<DimensionId, DimensionValue | DimensionValue[]>;

/** What a selector states: per named tag, any of the listed values. */
export type DimensionPredicate = Record<DimensionId, DimensionValue | DimensionValue[]>;

export const DERIVED_DIMENSION_IDS = ["productFamily", "side", "behavioralClasses"] as const;
export type DerivedDimensionId = (typeof DERIVED_DIMENSION_IDS)[number];
