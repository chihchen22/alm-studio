// apps/studio/src/assumptions/selectorText.ts
/**
 * A binding's selector in words, for display only (ALM Studio Polish 2 A5 and
 * M7): each tag as "<tag>: <value>", several values of one tag joined with
 * " or " (any-of), several tags with " and " (all-of), tags and values in the
 * sorted order of canonicalPredicate, which stays the key for grouping and
 * diffing rows but is not the equality of a mapping and its binding (that is
 * the engine's macroTargetIdentity). No selector, or an empty one, is "whole family", in lower case: it
 * always sits mid-line. Edit a set, By kind and Stack print selectors with it.
 */
import type { DimensionPredicate } from "@alm/engine";

/** The values a selector gives one tag, as a list (one value is stored as text); none when the tag is absent. */
export function valuesOf(selector: DimensionPredicate | undefined, tag: string): string[] {
  const v = selector?.[tag];
  return v === undefined ? [] : Array.isArray(v) ? [...v] : [v];
}

export function selectorText(selector: DimensionPredicate | undefined): string {
  const tags = Object.keys(selector ?? {}).sort();
  if (tags.length === 0) return "whole family";
  return tags.map((t) => `${t}: ${[...new Set(valuesOf(selector, t))].sort().join(" or ")}`).join(" and ");
}
