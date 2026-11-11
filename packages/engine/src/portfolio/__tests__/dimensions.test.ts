/**
 * D1 to D4 at the door, and the effective bag every reader
 * computes through one function.
 */
import { describe, expect, it } from "vitest";
import type { DimensionTaxonomy } from "../../contracts/dimensions";
import type { PortfolioSpec } from "../../contracts/position";
import { nmdPosition, twoSidedBook } from "../../run/__tests__/fixtures";
import { dimensionsOf, validateDimensions } from "../dimensions";

const TAX: DimensionTaxonomy = {
  schemaVersion: "1.0.0", id: "T-1", label: "test",
  dimensions: [
    { id: "segment", label: "Segment", values: ["rate-shopper", "relationship"] },
    { id: "businessLine", label: "Line" },
    { id: "behavioralClasses", label: "Classes", multiValued: true },
    { id: "productFamily", label: "Family" },
  ],
};
function book(mut: (b: PortfolioSpec) => void): PortfolioSpec {
  const b = { ...twoSidedBook(), taxonomy: TAX };
  mut(b);
  return b;
}
const rules = (p: ReturnType<typeof validateDimensions>) => p.map((x) => `${x.rule}:${x.positionId ?? "-"}:${x.dimension}`);

describe("validateDimensions", () => {
  it("accepts a book with a taxonomy and no bags, and a book with neither", () => {
    expect(validateDimensions(book(() => {}))).toEqual([]);
    expect(validateDimensions(twoSidedBook())).toEqual([]);
  });
  it("D1: duplicate dimension ids and a badly declared behavioralClasses", () => {
    const dup = book((b) => { b.taxonomy = { ...TAX, dimensions: [...TAX.dimensions, { id: "segment", label: "again" }] }; });
    expect(rules(validateDimensions(dup))).toContain("D1:-:segment");
    const single = book((b) => { b.taxonomy = { ...TAX, dimensions: [{ id: "behavioralClasses", label: "x" }] }; });
    expect(rules(validateDimensions(single))).toContain("D1:-:behavioralClasses");
    const badClass = book((b) => { b.taxonomy = { ...TAX, dimensions: [{ id: "behavioralClasses", label: "x", multiValued: true, values: ["decay", "nonsense"] }] }; });
    expect(validateDimensions(badClass).find((p) => p.rule === "D1")?.value).toBe("nonsense");
  });
  it("D2: an undeclared tag, an authored derived tag, and a bag with no taxonomy", () => {
    const undeclared = book((b) => { b.positions[2] = { ...nmdPosition("D1"), dimensions: { vintage: "2021" } }; });
    expect(rules(validateDimensions(undeclared))).toEqual(["D2:D1:vintage"]);
    const authoredSide = book((b) => { b.positions[2] = { ...nmdPosition("D1"), dimensions: { side: "asset" } }; });
    expect(rules(validateDimensions(authoredSide))).toEqual(["D2:D1:side"]);
    const noTax = { ...twoSidedBook(), positions: [{ ...nmdPosition("D1"), dimensions: { segment: "relationship" } }] };
    expect(rules(validateDimensions(noTax))).toEqual(["D2:D1:segment"]);
  });
  it("D3: a value outside a closed set, and an empty string", () => {
    const outside = book((b) => { b.positions[2] = { ...nmdPosition("D1"), dimensions: { segment: "whale" } }; });
    const p = validateDimensions(outside);
    expect(rules(p)).toEqual(["D3:D1:segment"]);
    expect(p[0]!.value).toBe("whale");
    expect(p[0]!.positionIndex).toBe(2);
    const empty = book((b) => { b.positions[2] = { ...nmdPosition("D1"), dimensions: { businessLine: "" } }; });
    expect(rules(validateDimensions(empty))).toEqual(["D3:D1:businessLine"]);
  });
  it("D4: a list on a single-valued tag; a list on a multi-valued one is fine", () => {
    const list = book((b) => { b.positions[2] = { ...nmdPosition("D1"), dimensions: { segment: ["rate-shopper", "relationship"] } }; });
    expect(rules(validateDimensions(list))).toEqual(["D4:D1:segment"]);
    const classes = book((b) => { b.positions[2] = { ...nmdPosition("D1"), dimensions: { behavioralClasses: ["decay", "deposit-beta"] } }; });
    expect(validateDimensions(classes)).toEqual([]);
  });
  it("reports every problem, not the first", () => {
    const two = book((b) => {
      b.positions[2] = { ...nmdPosition("D1"), dimensions: { segment: "whale" } };
      b.positions[3] = { ...b.positions[3]!, dimensions: { vintage: "x" } };
    });
    expect(validateDimensions(two)).toHaveLength(2);
  });
});

describe("dimensionsOf", () => {
  const b = book(() => {});
  const family = b.coa.families.find((f) => f.id === "DDA")!;
  it("derives productFamily, side and behavioralClasses on a position with no bag", () => {
    expect(dimensionsOf(b.positions[2]!, family, TAX)).toEqual({ productFamily: "DDA", side: "liability", behavioralClasses: [] });
  });
  it("merges authored tags under the derived ones and unions the class lists", () => {
    const fam = { ...family, behavioralClasses: ["decay" as const] };
    const pos = { ...nmdPosition("D1"), dimensions: { segment: "relationship", behavioralClasses: ["deposit-beta"] } };
    expect(dimensionsOf(pos, fam, TAX)).toEqual({
      segment: "relationship", productFamily: "DDA", side: "liability", behavioralClasses: ["decay", "deposit-beta"],
    });
  });
  it("is the same with no taxonomy", () => {
    expect(dimensionsOf(b.positions[2]!, family, undefined)).toEqual({ productFamily: "DDA", side: "liability", behavioralClasses: [] });
  });
});
