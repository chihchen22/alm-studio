/**
 * The hierarchy document contract and its pure rules.
 *
 * Every expected value below is restated from the approved design, never read
 * back from the code under test. The fixture book is the engine's segmented
 * NMD book: closed tag `segment` [rate-shopper, relationship], D1 and D2
 * rate-shopper, D3 relationship, F1, M1 and B1 untagged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { validateDimensions } from "@alm/engine";
import { segmentedNmdBook } from "@alm/engine/src/run/__tests__/fixtures";
import {
  HIERARCHY_KINDS,
  HIERARCHY_SCHEMA_VERSION,
  checkAgainstBook,
  isHierarchyId,
  parseHierarchy,
  retagBook,
  retaggedBookId,
  sourceDimensionsOf,
  tagId,
  validateHierarchy,
  type Hierarchy,
} from "../hierarchies/hierarchy";

const BOOK = (): PortfolioSpec => segmentedNmdBook("PF-HIER");

function H(): Hierarchy {
  return {
    schemaVersion: "1.0.0",
    id: "seg-risk",
    label: "Segment risk tree",
    kind: "risk",
    sourceDimension: "segment",
    levels: [
      { id: "group", label: "Group" },
      { id: "leaf", label: "Leaf" },
    ],
    nodes: [
      { id: "deposits", parentId: null, level: "group" },
      { id: "rate-sensitive", parentId: "deposits", level: "leaf" },
      { id: "sticky", parentId: "deposits", level: "leaf" },
    ],
    map: { relationship: "sticky", "rate-shopper": "rate-sensitive" },
  };
}

const DEPOSITS = { id: "deposits", parentId: null, level: "group" };
const RATE = { id: "rate-sensitive", parentId: "deposits", level: "leaf" };
const STICKY = { id: "sticky", parentId: "deposits", level: "leaf" };

const ID_TEXT = (id: string): string =>
  'hierarchy id must match /^[A-Za-z0-9_-]{1,32}$/, must not start with "-" and must not contain "--" ' +
  `(it becomes part of tag ids and of the re-tagged book id <book>--<hierarchy>); got "${id}"`;

describe("constants", () => {
  it("restates the schema version and the three kinds", () => {
    expect(HIERARCHY_SCHEMA_VERSION).toBe("1.0.0");
    expect([...HIERARCHY_KINDS]).toEqual(["risk", "liquidity", "regulatory"]);
  });
});

describe("parseHierarchy: canonical form", () => {
  it("returns keys in the decided order and map keys in code-unit order", () => {
    const h = H();
    const shuffled = {
      map: h.map,
      nodes: h.nodes,
      levels: h.levels,
      sourceDimension: h.sourceDimension,
      kind: h.kind,
      label: h.label,
      id: h.id,
      schemaVersion: h.schemaVersion,
    };
    const out = parseHierarchy(shuffled);
    expect(Object.keys(out)).toEqual([
      "schemaVersion",
      "id",
      "label",
      "kind",
      "sourceDimension",
      "levels",
      "nodes",
      "map",
    ]);
    expect(Object.keys(out.map)).toEqual(["rate-shopper", "relationship"]);
    expect(out).toEqual(H());
  });

  it("sorts map keys by UTF-16 code unit, never by locale", () => {
    const raw = {
      ...H(),
      nodes: [DEPOSITS, RATE, STICKY],
      map: { b: "sticky", B: "sticky", a_x: "rate-sensitive", "a-x": "rate-sensitive" },
    };
    expect(Object.keys(parseHierarchy(raw).map)).toEqual(["B", "a-x", "a_x", "b"]);
  });

  it("stores trimmed labels, so padded and plain input have identical bytes", () => {
    const padded = {
      ...H(),
      label: " Segment risk tree ",
      levels: [
        { id: "group", label: " Group " },
        { id: "leaf", label: "Leaf" },
      ],
    };
    const out = parseHierarchy(padded);
    expect(out.label).toBe("Segment risk tree");
    expect(out.levels[0]!.label).toBe("Group");
    expect(JSON.stringify(out)).toBe(JSON.stringify(parseHierarchy(H())));
  });

  it("checks label lengths after trimming", () => {
    expect(() => parseHierarchy({ ...H(), label: "   " })).toThrow(
      "hierarchy label must be a string of 1 to 120 characters after trimming",
    );
    expect(() =>
      parseHierarchy({
        ...H(),
        levels: [
          { id: "group", label: "  " },
          { id: "leaf", label: "Leaf" },
        ],
      }),
    ).toThrow(
      "level 0 must be { id, label }: an id matching /^[A-Za-z0-9_-]{1,32}$/ and a label of 1 to 80 characters after trimming",
    );
    // 120 characters is fine, 121 is not; the padding does not count.
    expect(parseHierarchy({ ...H(), label: ` ${"x".repeat(120)} ` }).label).toBe("x".repeat(120));
    expect(() => parseHierarchy({ ...H(), label: "x".repeat(121) })).toThrow(
      "hierarchy label must be a string of 1 to 120 characters after trimming",
    );
  });

  it("does not trim ids, so whitespace in one fails its pattern", () => {
    expect(() => parseHierarchy({ ...H(), id: " seg-risk" })).toThrow(ID_TEXT(" seg-risk"));
  });
});

describe("parseHierarchy: shape refusals", () => {
  it("refuses a non-object", () => {
    expect(() => parseHierarchy(null)).toThrow("hierarchy must be an object");
    expect(() => parseHierarchy([])).toThrow("hierarchy must be an object");
    expect(() => parseHierarchy("x")).toThrow("hierarchy must be an object");
  });

  it("refuses an unknown key at the top level", () => {
    expect(() => parseHierarchy({ ...H(), note: "x" })).toThrow(
      'hierarchy has unknown field "note"; the fields are schemaVersion, id, label, kind, sourceDimension, levels, nodes, map',
    );
  });

  it("refuses another schema version", () => {
    expect(() => parseHierarchy({ ...H(), schemaVersion: "2.0.0" })).toThrow(
      'hierarchy schemaVersion must be "1.0.0"; got "2.0.0"',
    );
  });

  it("refuses an id outside the injective shape", () => {
    for (const id of ["a.b", "x".repeat(33), "a--b", "-a"]) {
      expect(() => parseHierarchy({ ...H(), id }), id).toThrow(ID_TEXT(id));
    }
    expect(parseHierarchy({ ...H(), id: "a-" }).id).toBe("a-");
    expect(parseHierarchy({ ...H(), id: "x".repeat(32) }).id).toBe("x".repeat(32));
  });

  it("refuses a kind the build does not support", () => {
    expect(() => parseHierarchy({ ...H(), kind: "capital" })).toThrow(
      'hierarchy kind must be one of risk, liquidity, regulatory; got "capital" (capital, ledger and planning hierarchies are not built)',
    );
  });

  it("refuses an empty source dimension", () => {
    expect(() => parseHierarchy({ ...H(), sourceDimension: "" })).toThrow(
      "hierarchy sourceDimension must be a non-empty string",
    );
  });

  it("refuses 0 or 7 levels and a malformed level", () => {
    const levelsText = "hierarchy levels must be a list of 1 to 6 { id, label } entries";
    expect(() => parseHierarchy({ ...H(), levels: [] })).toThrow(levelsText);
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `l${i}`, label: `L${i}` }));
    expect(() => parseHierarchy({ ...H(), levels: seven })).toThrow(levelsText);
    const six = seven.slice(0, 6);
    expect(parseHierarchy({ ...H(), levels: six }).levels).toHaveLength(6);
    const levelText = (i: number): string =>
      `level ${i} must be { id, label }: an id matching /^[A-Za-z0-9_-]{1,32}$/ and a label of 1 to 80 characters after trimming`;
    expect(() =>
      parseHierarchy({ ...H(), levels: [{ id: "g.1", label: "G" }, { id: "leaf", label: "Leaf" }] }),
    ).toThrow(levelText(0));
    expect(() =>
      parseHierarchy({ ...H(), levels: [{ id: "g", label: "G" }, { id: "leaf", label: "Leaf", x: 1 }] }),
    ).toThrow(levelText(1));
  });

  it("refuses 0 or 201 nodes and a malformed node", () => {
    const nodesText = "hierarchy nodes must be a list of 1 to 200 { id, parentId, level } entries";
    expect(() => parseHierarchy({ ...H(), nodes: [] })).toThrow(nodesText);
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, parentId: null, level: "group" }));
    expect(() => parseHierarchy({ ...H(), nodes: many })).toThrow(nodesText);
    const nodeText = (i: number): string =>
      `node ${i} must be { id, parentId, level }: an id matching /^[A-Za-z0-9._-]{1,64}$/, parentId a node id or null, level a level id string`;
    expect(() => parseHierarchy({ ...H(), nodes: [{ id: "a b", parentId: null, level: "group" }] })).toThrow(
      nodeText(0),
    );
    expect(() =>
      parseHierarchy({ ...H(), nodes: [DEPOSITS, { id: "x", parentId: 3, level: "leaf" }] }),
    ).toThrow(nodeText(1));
    expect(() =>
      parseHierarchy({ ...H(), nodes: [DEPOSITS, { id: "x", parentId: "deposits", level: 4 }] }),
    ).toThrow(nodeText(1));
    expect(() =>
      parseHierarchy({ ...H(), nodes: [DEPOSITS, { id: "x", parentId: "deposits", level: "leaf", z: 1 }] }),
    ).toThrow(nodeText(1));
  });

  it("refuses a map that is not an object, and a bad map entry", () => {
    expect(() => parseHierarchy({ ...H(), map: [] })).toThrow(
      "hierarchy map must be an object of source value to leaf node id",
    );
    expect(() => parseHierarchy({ ...H(), map: null })).toThrow(
      "hierarchy map must be an object of source value to leaf node id",
    );
    expect(() => parseHierarchy({ ...H(), map: { "": "sticky" } })).toThrow(
      'map key "" must be a non-empty string naming a node id string',
    );
    expect(() => parseHierarchy({ ...H(), map: { a: 3 } })).toThrow(
      'map key "a" must be a non-empty string naming a node id string',
    );
  });

  it("isHierarchyId states the rule", () => {
    expect(isHierarchyId("liquidity-funding-demo-v1")).toBe(true);
    expect(isHierarchyId("a-")).toBe(true);
    expect(isHierarchyId("")).toBe(false);
    expect(isHierarchyId("-a")).toBe(false);
    expect(isHierarchyId("a--b")).toBe(false);
    expect(isHierarchyId("a.b")).toBe(false);
    expect(isHierarchyId("x".repeat(33))).toBe(false);
  });
});

describe("validateHierarchy", () => {
  const withNodes = (nodes: unknown[]): Hierarchy => ({ ...H(), nodes: nodes as Hierarchy["nodes"] });

  it("accepts the fixture", () => {
    expect(validateHierarchy(H())).toEqual([]);
  });

  it("reports a parent cycle, its level breaks and the childless root together", () => {
    const h = {
      ...withNodes([
        DEPOSITS,
        { id: "a", parentId: "b", level: "leaf" },
        { id: "b", parentId: "a", level: "leaf" },
      ]),
      map: { "rate-shopper": "a", relationship: "b" },
    };
    expect(validateHierarchy(h)).toEqual([
      'node "a" is in or under a parent cycle',
      'node "b" is in or under a parent cycle',
      'node "a" is at level "leaf" but its parent "b" is at "leaf"; a child sits one level below its parent',
      'node "b" is at level "leaf" but its parent "a" is at "leaf"; a child sits one level below its parent',
      'node "deposits" at level "group" has no child; every node above the last level "leaf" needs at least one',
    ]);
  });

  it("reports a parent that is not a node", () => {
    const h = withNodes([DEPOSITS, { id: "rate-sensitive", parentId: "ghost", level: "leaf" }, STICKY]);
    expect(validateHierarchy(h)).toEqual(['node "rate-sensitive" names parent "ghost", which is not a node']);
  });

  it("reports a level that is not declared", () => {
    const h = withNodes([DEPOSITS, { id: "rate-sensitive", parentId: "deposits", level: "middle" }, STICKY]);
    expect(validateHierarchy(h)).toEqual(['node "rate-sensitive" names level "middle", which is not declared']);
  });

  it("reports a node declared twice and walks only its first declaration", () => {
    const h = withNodes([DEPOSITS, RATE, STICKY, { id: "sticky", parentId: "deposits", level: "nowhere" }]);
    expect(validateHierarchy(h)).toEqual(['node "sticky" is declared twice']);
  });

  it("duplicate last level: the last level is levels[last].id by id", () => {
    // LAST is "leaf" by id. Leaf nodes are at the last level, so R8 and R12 do not
    // fire. index(leaf) = 1 = index(group) + 1, so R7 does not fire. R9 walks the
    // unique ids group and leaf, and both hold nodes.
    const h: Hierarchy = {
      ...H(),
      levels: [
        { id: "group", label: "Group" },
        { id: "leaf", label: "Leaf" },
        { id: "leaf", label: "Leaf again" },
      ],
    };
    expect(validateHierarchy(h)).toEqual(['level "leaf" is declared twice']);
  });

  it("duplicate first level reused as last: positions are by array position", () => {
    // LAST = levels[2].id = "group". deposits is at the last level so no R8. R7 uses
    // the first-declaration index 0 for group and 1 for leaf, so it is satisfied.
    const h: Hierarchy = {
      ...H(),
      levels: [
        { id: "group", label: "Group" },
        { id: "leaf", label: "Leaf" },
        { id: "group", label: "Group again" },
      ],
    };
    expect(validateHierarchy(h)).toEqual([
      'level "group" is declared twice',
      'node "rate-sensitive" at level "leaf" has no child; every node above the last level "group" needs at least one',
      'node "sticky" at level "leaf" has no child; every node above the last level "group" needs at least one',
      'map value "rate-shopper" names "rate-sensitive", which is at level "leaf", not the last level "group"; a value maps to a leaf',
      'map value "relationship" names "sticky", which is at level "leaf", not the last level "group"; a value maps to a leaf',
    ]);
  });

  it("reports a root that is not at the first level", () => {
    const h = withNodes([DEPOSITS, { id: "rate-sensitive", parentId: null, level: "leaf" }, STICKY]);
    expect(validateHierarchy(h)).toEqual([
      'node "rate-sensitive" has no parent, so it must be at the first level "group"; it is at "leaf"',
    ]);
  });

  it("reports a child two levels down and the childless middle node", () => {
    const h: Hierarchy = {
      ...H(),
      levels: [
        { id: "top", label: "Top" },
        { id: "mid", label: "Mid" },
        { id: "leaf", label: "Leaf" },
      ],
      nodes: [
        { id: "t", parentId: null, level: "top" },
        { id: "m", parentId: "t", level: "mid" },
        { id: "x", parentId: "t", level: "leaf" },
      ],
      map: { "rate-shopper": "x", relationship: "x" },
    };
    expect(validateHierarchy(h)).toEqual([
      'node "x" is at level "leaf" but its parent "t" is at "top"; a child sits one level below its parent',
      'node "m" at level "mid" has no child; every node above the last level "leaf" needs at least one',
    ]);
  });

  it("reports a childless node above the last level", () => {
    const h = withNodes([DEPOSITS, RATE, STICKY, { id: "orphan", parentId: null, level: "group" }]);
    expect(validateHierarchy(h)).toEqual([
      'node "orphan" at level "group" has no child; every node above the last level "leaf" needs at least one',
    ]);
  });

  it("reports a level that holds no node", () => {
    const h: Hierarchy = {
      ...H(),
      levels: [
        { id: "group", label: "Group" },
        { id: "mid", label: "Mid" },
        { id: "leaf", label: "Leaf" },
      ],
    };
    expect(validateHierarchy(h)).toEqual([
      'node "rate-sensitive" is at level "leaf" but its parent "deposits" is at "group"; a child sits one level below its parent',
      'node "sticky" is at level "leaf" but its parent "deposits" is at "group"; a child sits one level below its parent',
      'level "mid" holds no node',
    ]);
  });

  it("reports an empty map", () => {
    expect(validateHierarchy({ ...H(), map: {} })).toEqual([
      "the map is empty; map at least one source value to a leaf",
    ]);
  });

  it("reports a map value that is not a node, and does not also call it a non-leaf", () => {
    const h = { ...H(), map: { relationship: "ghost", "rate-shopper": "rate-sensitive" } };
    expect(validateHierarchy(h)).toEqual(['map value "relationship" names "ghost", which is not a node']);
  });

  it("reports a map value that names a group node", () => {
    const h = { ...H(), map: { relationship: "sticky", "rate-shopper": "deposits" } };
    expect(validateHierarchy(h)).toEqual([
      'map value "rate-shopper" names "deposits", which is at level "group", not the last level "leaf"; a value maps to a leaf',
    ]);
  });

  it("walks map keys in code-unit order", () => {
    const h = { ...H(), map: { b: "deposits", B: "deposits" } };
    expect(validateHierarchy(h)).toEqual([
      'map value "B" names "deposits", which is at level "group", not the last level "leaf"; a value maps to a leaf',
      'map value "b" names "deposits", which is at level "group", not the last level "leaf"; a value maps to a leaf',
    ]);
  });

  it("refuses a derived source dimension", () => {
    expect(validateHierarchy({ ...H(), sourceDimension: "productFamily" })).toEqual([
      'sourceDimension "productFamily" is derived by the engine and is not an authored tag; a hierarchy maps a tag the book declares',
    ]);
  });

  it("does not mutate its input", () => {
    const h = H();
    const before = JSON.stringify(h);
    validateHierarchy(h);
    expect(JSON.stringify(h)).toBe(before);
  });
});

describe("sourceDimensionsOf", () => {
  it("serves the closed tag with its declared values", () => {
    expect(sourceDimensionsOf(BOOK())).toEqual({
      bookId: "PF-HIER",
      taxonomyId: "TAX-SEGMENT",
      dimensions: [
        {
          id: "segment",
          label: "Calibration segment",
          eligible: true,
          reason: null,
          values: ["rate-shopper", "relationship"],
          carried: true,
        },
      ],
    });
  });

  it("serves an open tag with its carried values in code-unit order", () => {
    const book = BOOK();
    book.taxonomy = {
      schemaVersion: "1.0.0",
      id: "TAX-OPEN",
      label: "Open",
      dimensions: [{ id: "segment", label: "Segment" }],
    };
    const tags: Record<string, string> = { D1: "b", D2: "B", D3: "a" };
    book.positions = book.positions.map((p) =>
      tags[p.id] !== undefined ? { ...p, dimensions: { segment: tags[p.id]! } } : p,
    );
    const out = sourceDimensionsOf(book);
    expect(out.dimensions[0]!.values).toEqual(["B", "a", "b"]);
    expect(out.dimensions[0]!.carried).toBe(true);
    expect(out.dimensions[0]!.eligible).toBe(true);
  });

  it("marks a declared tag no position carries as not carried", () => {
    const book = BOOK();
    book.taxonomy = {
      schemaVersion: "1.0.0",
      id: "TAX-TIER",
      label: "Tier",
      dimensions: [{ id: "tier", label: "Tier", values: ["a"] }],
    };
    expect(sourceDimensionsOf(book).dimensions[0]).toEqual({
      id: "tier",
      label: "Tier",
      eligible: true,
      reason: null,
      values: ["a"],
      carried: false,
    });
  });

  it("refuses a multi-valued tag", () => {
    const book = BOOK();
    book.taxonomy = {
      schemaVersion: "1.0.0",
      id: "TAX-MULTI",
      label: "Multi",
      dimensions: [
        { id: "segment", label: "Segment", values: ["rate-shopper", "relationship"], multiValued: true },
      ],
    };
    const d = sourceDimensionsOf(book).dimensions[0]!;
    expect(d.eligible).toBe(false);
    expect(d.reason).toBe(
      "multi-valued: a position can carry several values, so it would land on several leaves",
    );
  });

  it("refuses a derived id first, even when it is also multi-valued", () => {
    const book = BOOK();
    book.taxonomy = {
      schemaVersion: "1.0.0",
      id: "TAX-DERIVED",
      label: "Derived",
      dimensions: [{ id: "productFamily", label: "Family", multiValued: true }],
    };
    const d = sourceDimensionsOf(book).dimensions[0]!;
    expect(d.eligible).toBe(false);
    expect(d.reason).toBe("derived from the family by the engine, not an authored tag");
  });

  it("serves a book with no taxonomy as taxonomyId null and no dimensions", () => {
    const book = BOOK();
    delete book.taxonomy;
    expect(sourceDimensionsOf(book)).toEqual({ bookId: "PF-HIER", taxonomyId: null, dimensions: [] });
  });
});

describe("checkAgainstBook", () => {
  it("passes the fixture against its book", () => {
    expect(checkAgainstBook(H(), BOOK())).toEqual({ problems: [], unmapped: [] });
  });

  it("lists a closed value that maps to no leaf", () => {
    const h = { ...H(), map: { "rate-shopper": "rate-sensitive" } };
    expect(checkAgainstBook(h, BOOK())).toEqual({
      problems: ['1 value(s) of tag "segment" on book "PF-HIER" map to no leaf: relationship'],
      unmapped: ["relationship"],
    });
  });

  it("lists a map key that is not a declared value of a closed tag", () => {
    const h = { ...H(), map: { ...H().map, whale: "sticky" } };
    expect(checkAgainstBook(h, BOOK())).toEqual({
      problems: [
        'map key "whale" is not a value of tag "segment" on book "PF-HIER" (values: rate-shopper, relationship)',
      ],
      unmapped: [],
    });
  });

  it("puts the unmapped problem before the stray-key problems", () => {
    const h = { ...H(), map: { zebra: "sticky", ant: "sticky" } };
    expect(checkAgainstBook(h, BOOK())).toEqual({
      problems: [
        '2 value(s) of tag "segment" on book "PF-HIER" map to no leaf: rate-shopper, relationship',
        'map key "ant" is not a value of tag "segment" on book "PF-HIER" (values: rate-shopper, relationship)',
        'map key "zebra" is not a value of tag "segment" on book "PF-HIER" (values: rate-shopper, relationship)',
      ],
      unmapped: ["rate-shopper", "relationship"],
    });
  });

  it("does not flag a stray map key on an open tag, and covers the carried set", () => {
    const book = BOOK();
    book.taxonomy = {
      schemaVersion: "1.0.0",
      id: "TAX-OPEN",
      label: "Open",
      dimensions: [{ id: "segment", label: "Segment" }],
    };
    // D1, D2 carry "rate-shopper", D3 carries "relationship": the carried set.
    const h = { ...H(), map: { "rate-shopper": "rate-sensitive", elsewhere: "sticky" } };
    expect(checkAgainstBook(h, book)).toEqual({
      problems: ['1 value(s) of tag "segment" on book "PF-HIER" map to no leaf: relationship'],
      unmapped: ["relationship"],
    });
  });

  it("refuses a tag the book does not declare", () => {
    expect(checkAgainstBook({ ...H(), sourceDimension: "tier" }, BOOK())).toEqual({
      problems: ['book "PF-HIER" does not declare tag "tier"; its tags are segment'],
      unmapped: [],
    });
    const book = BOOK();
    book.taxonomy = { schemaVersion: "1.0.0", id: "T", label: "T", dimensions: [] };
    expect(checkAgainstBook(H(), book)).toEqual({
      problems: ['book "PF-HIER" does not declare tag "segment"; its tags are none'],
      unmapped: [],
    });
  });

  it("refuses a multi-valued tag without computing coverage", () => {
    const book = BOOK();
    book.taxonomy = {
      schemaVersion: "1.0.0",
      id: "TAX-MULTI",
      label: "Multi",
      dimensions: [
        { id: "segment", label: "Segment", values: ["rate-shopper", "relationship"], multiValued: true },
      ],
    };
    const h = { ...H(), map: { "rate-shopper": "rate-sensitive" } };
    expect(checkAgainstBook(h, book)).toEqual({
      problems: [
        'tag "segment" on book "PF-HIER" is multi-valued; a hierarchy maps a single-valued tag, so each position lands on exactly one leaf',
      ],
      unmapped: [],
    });
  });

  it("refuses a book with no taxonomy", () => {
    const book = BOOK();
    delete book.taxonomy;
    expect(checkAgainstBook(H(), book)).toEqual({
      problems: [
        'book "PF-HIER" declares no taxonomy, so it carries no authored tag for hierarchy "seg-risk" to map',
      ],
      unmapped: [],
    });
  });
});

describe("retagBook", () => {
  it("writes one tag per level on tagged positions and extends the taxonomy", () => {
    const book = BOOK();
    const snapshot = structuredClone(book);
    const out = retagBook(H(), book);

    expect(out.id).toBe("PF-HIER--seg-risk");
    expect(out.label).toBe("Run test book; tagged by hierarchy seg-risk");
    expect(out.taxonomy).toEqual({
      schemaVersion: "1.0.0",
      id: "TAX-SEGMENT--seg-risk",
      label: "One calibration segment tag; plus hierarchy seg-risk",
      dimensions: [
        { id: "segment", label: "Calibration segment", values: ["rate-shopper", "relationship"] },
        { id: "seg-risk.group", label: "Segment risk tree: Group", values: ["deposits"] },
        { id: "seg-risk.leaf", label: "Segment risk tree: Leaf", values: ["rate-sensitive", "sticky"] },
      ],
    });

    const byId = (spec: PortfolioSpec, id: string) => spec.positions.find((p) => p.id === id)!;
    expect(byId(out, "D1").dimensions).toEqual({
      segment: "rate-shopper",
      "seg-risk.group": "deposits",
      "seg-risk.leaf": "rate-sensitive",
    });
    expect(byId(out, "D2").dimensions).toEqual({
      segment: "rate-shopper",
      "seg-risk.group": "deposits",
      "seg-risk.leaf": "rate-sensitive",
    });
    expect(byId(out, "D3").dimensions).toEqual({
      segment: "relationship",
      "seg-risk.group": "deposits",
      "seg-risk.leaf": "sticky",
    });
    // The new tags come after the existing ones, in level order.
    expect(Object.keys(byId(out, "D1").dimensions!)).toEqual(["segment", "seg-risk.group", "seg-risk.leaf"]);

    // An untagged position is the very same object.
    for (const id of ["F1", "M1", "B1"]) expect(byId(out, id)).toBe(byId(book, id));

    // Order, family, coa node and terms are untouched.
    expect(out.positions.map((p) => p.id)).toEqual(book.positions.map((p) => p.id));
    for (const p of out.positions) {
      const src = byId(book, p.id);
      expect(p.terms).toEqual(src.terms);
      expect(p.familyId).toBe(src.familyId);
      expect(p.coaNodeId).toBe(src.coaNodeId);
    }
    expect(out.asOf).toBe(book.asOf);
    expect(out.coa).toBe(book.coa);

    expect(validateDimensions(out)).toEqual([]);
    // The source book is not mutated.
    expect(book).toEqual(snapshot);
  });

  it("refuses to run on a book with no taxonomy", () => {
    const book = BOOK();
    delete book.taxonomy;
    expect(() => retagBook(H(), book)).toThrow('book "PF-HIER" declares no taxonomy');
  });
});

describe("tag and book ids", () => {
  it("composes the level tag id and the re-tagged book id", () => {
    expect(tagId("seg-risk", "leaf")).toBe("seg-risk.leaf");
    expect(retaggedBookId("PF-HIER", "seg-risk")).toBe("PF-HIER--seg-risk");
  });

  it("is injective: the colliding pair cannot both compose", () => {
    // ("A--b", "c") and ("A", "b--c") would both give "A--b--c"; the second hierarchy id is refused.
    expect(isHierarchyId("c")).toBe(true);
    expect(isHierarchyId("b--c")).toBe(false);
    expect(retaggedBookId("A--b", "c")).toBe("A--b--c");
  });
});

describe("source text", () => {
  it("has no locale sort, no running sum and no notional arithmetic", () => {
    const src = readFileSync(fileURLToPath(new URL("../hierarchies/hierarchy.ts", import.meta.url)), "utf8");
    expect(src).not.toContain("localeCompare");
    expect(src).not.toContain("+=");
    expect(src).not.toContain(".reduce(");
    expect(src).not.toContain("terms.notional");
  });
});
