// apps/studio/src/__tests__/hierarchyModel.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiError, type Hierarchy } from "@alm/reader";
import {
  addLevel, addNode, applyText, checkDraft, defaultSaveId, draftFrom, editLevel, emptyDraft, isStored, leafIds, parentChoices,
  problemsFrom, removeLastLevel, removeNode, renameNode, saveText, setMapEntry, setNodeParent, tagIdsOf, toHierarchy, unmappedValues, withSourceDimension,
} from "../balance/hierarchyModel";

/** The seeded demonstration hierarchy, restated as a literal (canonical form). */
const DEMO: Hierarchy = {
  schemaVersion: "1.0.0",
  id: "liquidity-funding-demo-v1",
  label: "Liquidity funding hierarchy over the LCR category tag (demonstration values)",
  kind: "liquidity",
  sourceDimension: "lcr-category",
  levels: [{ id: "funding", label: "Funding source" }, { id: "bucket", label: "Run-off bucket" }],
  nodes: [
    { id: "retail", parentId: null, level: "funding" },
    { id: "unsecured-wholesale", parentId: null, level: "funding" },
    { id: "secured", parentId: null, level: "funding" },
    { id: "retail-stable", parentId: "retail", level: "bucket" },
    { id: "retail-less-stable", parentId: "retail", level: "bucket" },
    { id: "operational", parentId: "unsecured-wholesale", level: "bucket" },
    { id: "nonfinancial-wholesale", parentId: "unsecured-wholesale", level: "bucket" },
    { id: "financial-wholesale", parentId: "unsecured-wholesale", level: "bucket" },
    { id: "gse-secured", parentId: "secured", level: "bucket" },
  ],
  map: {
    operational: "operational",
    "retail-other": "retail-less-stable",
    "retail-stable": "retail-stable",
    "secured-gse": "gse-secured",
    "wholesale-financial": "financial-wholesale",
    "wholesale-nonfinancial": "nonfinancial-wholesale",
  },
};

describe("emptyDraft and draftFrom", () => {
  it("opens one level, no nodes, an empty map", () => {
    expect(emptyDraft("lcr-category")).toEqual({
      id: "", label: "", kind: "risk", sourceDimension: "lcr-category", levels: [{ id: "level-1", label: "Level 1" }], nodes: [], map: {},
    });
  });
  it("draftFrom copies, so editing the draft never touches the stored document", () => {
    const d = draftFrom(DEMO);
    d.levels[0]!.label = "changed";
    d.nodes[0]!.id = "changed";
    d.map["operational"] = "changed";
    expect(DEMO.levels[0]!.label).toBe("Funding source");
    expect(DEMO.nodes[0]!.id).toBe("retail");
    expect(DEMO.map["operational"]).toBe("operational");
  });
});

describe("toHierarchy", () => {
  it("emits the server's key order, schemaVersion 1.0.0, and drops empty map entries", () => {
    const d = { ...emptyDraft("segment"), id: "h", label: "L", map: { b: "x", a: "", c: "y" } };
    const h = toHierarchy(d);
    expect(Object.keys(h)).toEqual(["schemaVersion", "id", "label", "kind", "sourceDimension", "levels", "nodes", "map"]);
    expect(h.schemaVersion).toBe("1.0.0");
    expect(Object.keys(h.map)).toEqual(["b", "c"]);
  });
  it("sorts map keys by UTF-16 code unit, never by locale", () => {
    const d = { ...emptyDraft("segment"), map: { b: "1", B: "2", a_x: "3", "a-x": "4" } };
    expect(Object.keys(toHierarchy(d).map)).toEqual(["B", "a-x", "a_x", "b"]);
  });
  it("trims the hierarchy label and each level label", () => {
    const d = { ...draftFrom(DEMO), label: "  Demo  " };
    d.levels = [{ id: "funding", label: " Funding source " }, d.levels[1]!];
    const h = toHierarchy(d);
    expect(h.label).toBe("Demo");
    expect(h.levels[0]!.label).toBe("Funding source");
  });
});

describe("isStored", () => {
  it("is true for the draft of a canonical stored document", () => {
    expect(isStored(draftFrom(DEMO), DEMO)).toBe(true);
  });
  it("is true when the draft differs only by label padding", () => {
    const d = draftFrom(DEMO);
    d.levels[1] = { id: "bucket", label: "Run-off bucket " };
    expect(isStored(d, DEMO)).toBe(true);
  });
  it("is false after an edit", () => {
    expect(isStored({ ...draftFrom(DEMO), kind: "risk" }, DEMO)).toBe(false);
  });
});

describe("tree helpers", () => {
  it("unmappedValues keeps the values order and treats an empty entry as unmapped", () => {
    expect(unmappedValues(["retail-stable", "retail-other", "operational"], { "retail-stable": "retail-stable" })).toEqual(["retail-other", "operational"]);
    expect(unmappedValues(["a", "b"], { a: "", b: "x" })).toEqual(["a"]);
  });
  it("leafIds are the last level's nodes in node order", () => {
    expect(leafIds(draftFrom(DEMO))).toEqual(["retail-stable", "retail-less-stable", "operational", "nonfinancial-wholesale", "financial-wholesale", "gse-secured"]);
  });
  it("parentChoices are the nodes one level up, none at the first level", () => {
    expect(parentChoices(draftFrom(DEMO), "bucket")).toEqual(["retail", "unsecured-wholesale", "secured"]);
    expect(parentChoices(draftFrom(DEMO), "funding")).toEqual([]);
  });
  it("addLevel appends the next numbered level", () => {
    const d = addLevel(emptyDraft("x"));
    expect(d.levels).toEqual([{ id: "level-1", label: "Level 1" }, { id: "level-2", label: "Level 2" }]);
  });
  it("removeLastLevel drops its nodes and the map entries to them, and does nothing with one level", () => {
    const d = removeLastLevel(draftFrom(DEMO));
    expect(d.levels).toEqual([{ id: "funding", label: "Funding source" }]);
    expect(d.nodes.map((n) => n.id)).toEqual(["retail", "unsecured-wholesale", "secured"]);
    expect(d.map).toEqual({});
    const one = emptyDraft("x");
    expect(removeLastLevel(one)).toEqual(one);
  });
  it("addNode takes the first parent choice, or null at the first level", () => {
    expect(addNode(draftFrom(DEMO), "bucket").nodes.at(-1)).toEqual({ id: "", parentId: "retail", level: "bucket" });
    expect(addNode(draftFrom(DEMO), "funding").nodes.at(-1)).toEqual({ id: "", parentId: null, level: "funding" });
  });
  it("renameNode rewrites its children's parent and the map values", () => {
    const d = renameNode(draftFrom(DEMO), 0, "retail-funding");
    expect(d.nodes[0]!.id).toBe("retail-funding");
    expect(d.nodes[3]!.parentId).toBe("retail-funding");
    expect(d.nodes[4]!.parentId).toBe("retail-funding");
    expect(d.nodes[5]!.parentId).toBe("unsecured-wholesale");
    const leaf = renameNode(draftFrom(DEMO), 3, "retail-core");
    expect(leaf.map["retail-stable"]).toBe("retail-core");
  });
  it("removeNode orphans its children and drops the map entries to it", () => {
    const leaf = removeNode(draftFrom(DEMO), 8);
    expect(leaf.nodes.map((n) => n.id)).not.toContain("gse-secured");
    expect(Object.keys(leaf.map)).not.toContain("secured-gse");
    expect(Object.keys(leaf.map)).toHaveLength(5);
    const parent = removeNode(draftFrom(DEMO), 0);
    expect(parent.nodes.find((n) => n.id === "retail-stable")!.parentId).toBeNull();
    expect(parent.nodes.find((n) => n.id === "retail-less-stable")!.parentId).toBeNull();
  });
  it("setNodeParent, editLevel, setMapEntry and withSourceDimension are small pure edits", () => {
    expect(setNodeParent(draftFrom(DEMO), 3, "secured").nodes[3]!.parentId).toBe("secured");
    expect(setNodeParent(draftFrom(DEMO), 3, "").nodes[3]!.parentId).toBeNull();
    const renamed = editLevel(draftFrom(DEMO), 1, { id: "tier" });
    expect(renamed.levels[1]).toEqual({ id: "tier", label: "Run-off bucket" });
    expect(renamed.nodes.filter((n) => n.level === "tier")).toHaveLength(6);
    expect(editLevel(draftFrom(DEMO), 0, { label: "Source" }).levels[0]).toEqual({ id: "funding", label: "Source" });
    expect(setMapEntry({ ...emptyDraft("x") }, "v", "n").map).toEqual({ v: "n" });
    expect(setMapEntry({ ...emptyDraft("x"), map: { v: "n" } }, "v", "").map).toEqual({});
    expect(withSourceDimension(draftFrom(DEMO), "other").map).toEqual({});
    expect(withSourceDimension(draftFrom(DEMO), "other").nodes).toHaveLength(9);
  });
});

describe("checkDraft", () => {
  it("lists the empty draft's problems in order", () => {
    expect(checkDraft(emptyDraft("segment"), ["a"])).toEqual([
      "Give the hierarchy an id.", "Give the hierarchy a label.", 'Add at least one node at level "level-1".', "Unmapped source values: a.",
    ]);
  });
  it("refuses an id the server would refuse", () => {
    const d = { ...emptyDraft("segment"), id: "a--b", label: "L" };
    expect(checkDraft(d, [])[0]).toBe('Hierarchy id "a--b" must use letters, digits, "_" and "-", at most 32 characters, must not start with "-" and must not contain "--".');
    expect(checkDraft({ ...d, id: "-a" }, [])[0]).toContain('Hierarchy id "-a" must use');
    expect(checkDraft({ ...d, id: "a.b" }, [])[0]).toContain('Hierarchy id "a.b" must use');
    expect(checkDraft({ ...d, id: "a".repeat(33) }, [])[0]).toContain("must use letters");
    expect(checkDraft({ ...d, id: "a-" }, [])[0]).toBe('Add at least one node at level "level-1".');
  });
  it("reports a node with no id and a node id used twice", () => {
    const d = { ...draftFrom(DEMO), nodes: [...DEMO.nodes, { id: "", parentId: null, level: "funding" }, { id: "retail", parentId: null, level: "funding" }] };
    expect(checkDraft(d, Object.keys(DEMO.map))).toEqual(["Node 10 has no id.", 'Node id "retail" is used twice.']);
  });
  it("is clean for the demonstration hierarchy over its six values", () => {
    expect(checkDraft(draftFrom(DEMO), ["operational", "retail-other", "retail-stable", "secured-gse", "wholesale-financial", "wholesale-nonfinancial"])).toEqual([]);
  });
  it("an empty label after trimming is refused", () => {
    expect(checkDraft({ ...draftFrom(DEMO), label: "   " }, [])).toEqual(["Give the hierarchy a label."]);
  });
});

describe("defaultSaveId", () => {
  it("a new draft takes <tag>-hierarchy-v1, then the first free edit id", () => {
    expect(defaultSaveId(null, "lcr-category", new Set())).toBe("lcr-category-hierarchy-v1");
    expect(defaultSaveId(null, "lcr-category", new Set(["lcr-category-hierarchy-v1"]))).toBe("lcr-category-hierarchy-v1-edit-1");
  });
  it("a selected hierarchy takes its base plus the next free edit number", () => {
    const it = "liquidity-funding-demo-v1";
    expect(defaultSaveId(it, "lcr-category", new Set([it]))).toBe("liquidity-funding-demo-v1-edit-1");
    expect(defaultSaveId("liquidity-funding-demo-v1-edit-1", "lcr-category", new Set([it, "liquidity-funding-demo-v1-edit-1"]))).toBe("liquidity-funding-demo-v1-edit-2");
  });
  it("sanitises a dotted source tag and stays valid", () => {
    const dotted = "liquidity-funding-demo-v1.bucket";
    expect(defaultSaveId(null, dotted, new Set())).toBe("liquidity-funding-demo-v1-bucket");
    expect(defaultSaveId(null, dotted, new Set(["liquidity-funding-demo-v1-bucket"]))).toBe("liquidity-funding-demo-v1-edit-1");
  });
  it("never holds a double hyphen or a leading hyphen", () => {
    expect(defaultSaveId(null, "a..b", new Set())).toBe("a-b-hierarchy-v1");
    expect(defaultSaveId(null, ".a", new Set())).toBe("a-hierarchy-v1");
    expect(defaultSaveId(null, "a.", new Set())).toBe("a-hierarchy-v1");
  });
});

describe("texts", () => {
  it("tagIdsOf names each level tag hierarchy id, dot, level id", () => {
    expect(tagIdsOf("liquidity-funding-demo-v1", DEMO.levels)).toEqual(["liquidity-funding-demo-v1.funding", "liquidity-funding-demo-v1.bucket"]);
  });
  it("saveText", () => {
    expect(saveText("created", "h1")).toBe("Saved h1");
    expect(saveText("unchanged", "h1")).toBe("h1 is already stored with this content");
  });
  it("applyText", () => {
    expect(applyText({ outcome: "created", id: "b--h", tags: ["h.a", "h.b"], untaggedPositionIds: [] })).toBe(
      "Wrote book b--h with tags h.a, h.b. It is in the file store and, best effort, in the catalog database now, where the Book pill reads it; if that sync failed, the pill lists it after the next server start.",
    );
    expect(applyText({ outcome: "unchanged", id: "b--h", tags: ["h.a", "h.b"], untaggedPositionIds: [] })).toBe("Book b--h already holds this tagging; nothing was written.");
  });
  it("applyText names the count of untagged positions and the P3 refusal, from the array length only", () => {
    const tail = "carry no value for the source tag and got no hierarchy tag; a view over the new tags will be refused until every position carries a value (P3).";
    expect(applyText({ outcome: "unchanged", id: "b--h", tags: ["h.a"], untaggedPositionIds: ["x", "y", "z"] })).toBe(
      `Book b--h already holds this tagging; nothing was written. 3 positions ${tail}`,
    );
    expect(applyText({ outcome: "created", id: "b--h", tags: ["h.a"], untaggedPositionIds: ["x"] })).toContain(
      " 1 position carries no value for the source tag and got no hierarchy tag; a view over the new tags will be refused until every position carries a value (P3).",
    );
  });
  it("problemsFrom reads a 422's problems, else the reason", () => {
    expect(problemsFrom(new ApiError(422, "validation", "m", { problems: ["p1"], unmapped: [] }))).toEqual(["p1"]);
    expect(problemsFrom(new ApiError(409, "conflict", "already exists"))).toEqual(["already exists"]);
    expect(problemsFrom(new ApiError(422, "validation", "m", { problems: [1] }))).toEqual(["m"]);
    expect(problemsFrom(new Error("boom"))).toEqual(["boom"]);
  });
});

describe("source text", () => {
  it("the model never sorts by locale", () => {
    const src = readFileSync(fileURLToPath(new URL("../balance/hierarchyModel.ts", import.meta.url)), "utf8");
    expect(src).not.toContain("localeCompare");
  });
});
