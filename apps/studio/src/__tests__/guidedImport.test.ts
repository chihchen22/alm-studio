// apps/studio/src/__tests__/guidedImport.test.ts
/**
 * Loading positions without a raw refusal (S2a fix round 1, H1): the second load of the example reuses the stored copy
 * and never imports again; a file whose id is taken is stored under the first free id, and the note names both ids.
 * The reader is replaced by a hand-written store of ids; the expected calls and ids are written out here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let stored: string[] = [];

vi.mock("@alm/reader", () => ({
  listPortfolios: async () => stored.map((id) => ({ id })),
  getExampleBook: async (id: string) => { calls.push(`get ${id}`); return { id, positions: [] }; },
  importPortfolioJson: async (text: string) => {
    const id = (JSON.parse(text) as { id: string }).id;
    calls.push(`import ${id}`);
    if (stored.includes(id)) throw new Error(`409: portfolio "${id}" already exists`);
    stored.push(id);
    return { id, positionCount: 0 };
  },
}));

const { ensureExample, exampleAction, freeBookId, jsonIdOf, jsonWithId, renamedNote } = await import("../guided/importBook");

const EXAMPLE = { id: "example-book-v1", label: "Example", asOf: "2026-03-31", positionCount: 11 };

beforeEach(() => {
  calls.length = 0;
  stored = [];
});

describe("the example book, loaded twice", () => {
  it("the first load imports it; the second reuses the stored copy and imports nothing", async () => {
    expect(await ensureExample(EXAMPLE)).toEqual({ id: "example-book-v1", reused: false });
    expect(calls).toEqual(["get example-book-v1", "import example-book-v1"]);
    calls.length = 0;
    expect(await ensureExample(EXAMPLE)).toEqual({ id: "example-book-v1", reused: true });
    expect(calls).toEqual([]);
    expect(exampleAction("example-book-v1", ["example-book-v1"])).toBe("reuse");
    expect(exampleAction("example-book-v1", ["other"])).toBe("import");
  });
});

describe("a template imported under an id that is already stored", () => {
  it("takes the first free id and says so", () => {
    expect(freeBookId("example-book-v1", [])).toBe("example-book-v1");
    expect(freeBookId("example-book-v1", ["example-book-v1"])).toBe("example-book-v1-2");
    expect(freeBookId("example-book-v1", ["example-book-v1", "example-book-v1-2"])).toBe("example-book-v1-3");
    expect(freeBookId("x".repeat(64), ["x".repeat(64)])).toBe(`${"x".repeat(62)}-2`);
    expect(renamedNote("example-book-v1", "example-book-v1-2")).toBe("A positions file with the id example-book-v1 is already stored, so this one is stored as example-book-v1-2.");
    expect(renamedNote("a", "a")).toBeNull();
  });
  it("rewrites only the JSON file's top-level id", () => {
    const text = JSON.stringify({ id: "example-book-v1", label: "L", positions: [{ id: "p1" }] });
    expect(jsonIdOf(text)).toBe("example-book-v1");
    expect(JSON.parse(jsonWithId(text, "example-book-v1-2"))).toEqual({ id: "example-book-v1-2", label: "L", positions: [{ id: "p1" }] });
    expect(jsonIdOf("not json")).toBeNull();
    expect(() => jsonWithId("[1]", "x")).toThrow(/no top-level object/);
  });
});
