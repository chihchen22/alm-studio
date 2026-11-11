/**
 * One matcher: any-of within a tag, all-of across tags, and a
 * canonical spelling so two authors who wrote the same predicate two ways are
 * told they agree.
 */
import { describe, expect, it } from "vitest";
import type { DimensionTaxonomy } from "../../contracts/dimensions";
import type { BehavioralClassId } from "../../contracts/plan";
import { nmdPosition, twoSidedBook } from "../../run/__tests__/fixtures";
import {
  canonicalPredicate,
  checkPredicateAgainstTaxonomy,
  positionsMatchedBy,
  selectorMatchesBag,
  selectorMatchesFamily,
  stageSelectorMatchesPosition,
} from "../dimensions";
import { selectorMatchesFamily as reexported } from "../routingGate";

const BAG = { productFamily: "DDA", side: "liability", behavioralClasses: ["decay", "deposit-beta"], segment: "relationship" };

describe("selectorMatchesBag", () => {
  it("matches nothing-stated, a scalar, a list, and a multi-valued intersection", () => {
    expect(selectorMatchesBag(undefined, BAG)).toBe(true);
    expect(selectorMatchesBag({}, BAG)).toBe(true);
    expect(selectorMatchesBag({ segment: "relationship" }, BAG)).toBe(true);
    expect(selectorMatchesBag({ segment: ["rate-shopper", "relationship"] }, BAG)).toBe(true);
    expect(selectorMatchesBag({ behavioralClasses: "deposit-beta" }, BAG)).toBe(true);
  });
  it("fails on a wrong value, a missing tag, and all-of across tags", () => {
    expect(selectorMatchesBag({ segment: "rate-shopper" }, BAG)).toBe(false);
    expect(selectorMatchesBag({ vintage: "2021" }, BAG)).toBe(false);
    expect(selectorMatchesBag({ segment: "relationship", side: "asset" }, BAG)).toBe(false);
  });
});

const BAG_CLASSES: ReadonlySet<BehavioralClassId> = new Set(["decay", "deposit-beta"]);

describe("stageSelectorMatchesPosition", () => {
  it("reads the family facets off the derived tags and then the predicate", () => {
    expect(stageSelectorMatchesPosition({ productFamily: "DDA", side: "Liability", behavioralClasses: "decay" }, BAG, BAG_CLASSES)).toBe(true);
    expect(stageSelectorMatchesPosition({ productFamily: "MMA" }, BAG, BAG_CLASSES)).toBe(false);
    expect(stageSelectorMatchesPosition({ behavioralClasses: "decay", dimensions: { segment: "rate-shopper" } }, BAG, BAG_CLASSES)).toBe(false);
    expect(stageSelectorMatchesPosition(undefined, BAG, BAG_CLASSES)).toBe(true);
  });
  /**
   * Finding 2. The class set is the CALLER's, not the bag's: the routing gate
   * unions the family's declared classes, the position's own tag and the ones
   * the run's bindings derive. A position whose only class is binding-derived
   * carries an empty behavioralClasses tag, and reading classes off the bag
   * would have the stage miss it while R4 says it is covered.
   */
  it("takes the class set from the caller, so a binding-derived class still selects", () => {
    const untagged = { productFamily: "DDA", side: "liability", behavioralClasses: [], segment: "relationship" };
    const derivedOnly: ReadonlySet<BehavioralClassId> = new Set(["decay"]);
    expect(stageSelectorMatchesPosition({ behavioralClasses: "decay" }, untagged, derivedOnly)).toBe(true);
    expect(stageSelectorMatchesPosition({ behavioralClasses: "decay" }, untagged, new Set())).toBe(false);
  });
  it("keeps selectorMatchesFamily as the family form and re-exports it from routingGate", () => {
    expect(selectorMatchesFamily({ side: "Liability" }, "DDA", "liability", new Set())).toBe(true);
    expect(reexported).toBe(selectorMatchesFamily);
  });
});

describe("canonicalPredicate", () => {
  it("is identical across key order, value order, duplicates, and scalar vs one-element list", () => {
    const a = canonicalPredicate({ segment: ["b", "a", "a"], side: "asset" });
    const b = canonicalPredicate({ side: ["asset"], segment: ["a", "b"] });
    expect(a).toBe(b);
    expect(a).toBe('{"segment":["a","b"],"side":["asset"]}');
    expect(canonicalPredicate(undefined)).toBe("");
    expect(canonicalPredicate({})).toBe("");
  });
});

describe("checkPredicateAgainstTaxonomy", () => {
  const TAX: DimensionTaxonomy = { schemaVersion: "1.0.0", id: "T", label: "t", dimensions: [{ id: "segment", label: "s", values: ["a", "b"] }, { id: "line", label: "l" }] };
  it("allows declared tags and the reserved ones, refuses the rest", () => {
    expect(checkPredicateAgainstTaxonomy({ segment: "a", line: "x", productFamily: "DDA", side: "asset", behavioralClasses: "decay" }, TAX)).toBeUndefined();
    expect(checkPredicateAgainstTaxonomy({ vintage: "2021" }, TAX)).toEqual({ dimension: "vintage" });
    expect(checkPredicateAgainstTaxonomy({ segment: "zz" }, TAX)).toEqual({ dimension: "segment", value: "zz" });
    expect(checkPredicateAgainstTaxonomy({ behavioralClasses: "nonsense" }, TAX)).toEqual({ dimension: "behavioralClasses", value: "nonsense" });
  });
  it("with no taxonomy, only the reserved tags are known", () => {
    expect(checkPredicateAgainstTaxonomy({ side: "asset" }, undefined)).toBeUndefined();
    expect(checkPredicateAgainstTaxonomy({ segment: "a" }, undefined)).toEqual({ dimension: "segment" });
  });
});

describe("positionsMatchedBy", () => {
  it("counts the family's positions the predicate matches", () => {
    const book = twoSidedBook();
    book.taxonomy = { schemaVersion: "1.0.0", id: "T", label: "t", dimensions: [{ id: "segment", label: "s" }] };
    book.positions.push({ ...nmdPosition("D2"), dimensions: { segment: "rate-shopper" } });
    expect(positionsMatchedBy(book, "DDA", undefined)).toBe(2);
    expect(positionsMatchedBy(book, "DDA", { segment: "rate-shopper" })).toBe(1);
    expect(positionsMatchedBy(book, "MMA", { segment: "rate-shopper" })).toBe(0);
  });
});
