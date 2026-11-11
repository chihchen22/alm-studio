/**
 * FileStore.supersedeDocument: the store's one operation that is not
 * an append. It moves a document and its meta, byte for byte, into
 * superseded/<stamp>/<collection>/ and appends one manifest line. Nothing is deleted.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../store/store";
import { InvalidIdError } from "../store/paths";

function scratchStore(): FileStore {
  const store = new FileStore(mkdtempSync(join(tmpdir(), "alm-supersede-test-")));
  store.init();
  return store;
}
const STAMP = "2026-09-23T00-00-00-000Z";

describe("FileStore.supersedeDocument", () => {
  it("moves the document and its meta byte for byte and appends one manifest line", () => {
    const store = scratchStore();
    const meta = store.putDocument("coa", "c1", { families: [1, 2] }, { seeded: true });
    const docBytes = readFileSync(store.paths.documentPath("coa", "c1"));
    const metaBytes = readFileSync(store.paths.metaPath("coa", "c1"));
    const record = store.supersedeDocument("coa", "c1", STAMP, "f".repeat(64));
    const dir = join(store.paths.root, "superseded", STAMP, "coa");
    expect(readFileSync(join(dir, "c1.json")).equals(docBytes)).toBe(true);
    expect(readFileSync(join(dir, "c1.meta.json")).equals(metaBytes)).toBe(true);
    expect(store.has("coa", "c1")).toBe(false);
    expect(existsSync(store.paths.metaPath("coa", "c1"))).toBe(false);
    const lines = readFileSync(join(store.paths.root, "superseded", STAMP, "manifest.ndjson"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    expect([line.collection, line.id, line.oldHash, line.newHash]).toEqual(["coa", "c1", meta.contentHash, "f".repeat(64)]);
    expect(typeof line.supersededAt).toBe("string");
    expect(record.oldHash).toBe(meta.contentHash);
    // A second supersede under the same stamp appends, it does not rewrite.
    store.putDocument("lens", "l1", { a: 1 }, {});
    store.supersedeDocument("lens", "l1", STAMP, "e".repeat(64));
    expect(readFileSync(join(store.paths.root, "superseded", STAMP, "manifest.ndjson"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("refuses to overwrite an earlier superseded copy, and leaves the live document in place", () => {
    const store = scratchStore();
    store.putDocument("coa", "c1", { v: 1 }, {});
    store.supersedeDocument("coa", "c1", STAMP, "0".repeat(64));
    store.putDocument("coa", "c1", { v: 2 }, {});
    expect(() => store.supersedeDocument("coa", "c1", STAMP, "1".repeat(64))).toThrow(/already holds/);
    expect(store.getDocument<{ v: number }>("coa", "c1").doc.v).toBe(2);
    expect(JSON.parse(readFileSync(join(store.paths.root, "superseded", STAMP, "coa", "c1.json"), "utf8"))).toEqual({ v: 1 });
  });

  it("rolls the document back when the meta rename fails, and writes no manifest line", () => {
    const store = scratchStore();
    store.putDocument("coa", "c1", { v: 1 }, { seeded: true });
    const docPath = store.paths.documentPath("coa", "c1");
    const metaPath = store.paths.metaPath("coa", "c1");
    const docBytes = readFileSync(docPath);
    const metaBytes = readFileSync(metaPath);
    // Test seam: the meta rename fails with a retryable code on both tries.
    const failMeta = (from: string, to: string): void => {
      if (from === metaPath) throw Object.assign(new Error("injected EBUSY"), { code: "EBUSY" });
      renameSync(from, to);
    };
    expect(() => store.supersedeDocument("coa", "c1", STAMP, "f".repeat(64), failMeta)).toThrow(/injected EBUSY/);
    const dir = join(store.paths.root, "superseded", STAMP, "coa");
    const where = `doc at ${existsSync(docPath) ? "source" : "destination"}, meta at ${existsSync(metaPath) ? "source" : "destination"}`;
    expect(where).toBe("doc at source, meta at source");
    expect(readFileSync(docPath).equals(docBytes)).toBe(true);
    expect(readFileSync(metaPath).equals(metaBytes)).toBe(true);
    expect([existsSync(join(dir, "c1.json")), existsSync(join(dir, "c1.meta.json"))]).toEqual([false, false]);
    expect(existsSync(join(store.paths.root, "superseded", STAMP, "manifest.ndjson"))).toBe(false);
  });

  it("names both paths when the rollback itself fails", () => {
    const store = scratchStore();
    store.putDocument("coa", "c1", { v: 1 }, {});
    const docPath = store.paths.documentPath("coa", "c1");
    const metaPath = store.paths.metaPath("coa", "c1");
    const docDest = join(store.paths.root, "superseded", STAMP, "coa", "c1.json");
    const failMetaAndRollback = (from: string, to: string): void => {
      if (from === metaPath || from === docDest) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      renameSync(from, to);
    };
    let message = "";
    try {
      store.supersedeDocument("coa", "c1", STAMP, "f".repeat(64), failMetaAndRollback);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(docDest);
    expect(message).toContain(metaPath);
    expect(message).toContain(docPath);
  });

  it("refuses when only the superseded meta copy exists, before moving anything", () => {
    const store = scratchStore();
    store.putDocument("coa", "c1", { v: 1 }, {});
    const docBytes = readFileSync(store.paths.documentPath("coa", "c1"));
    const dir = join(store.paths.root, "superseded", STAMP, "coa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "c1.meta.json"), "planted\n");
    expect(() => store.supersedeDocument("coa", "c1", STAMP, "0".repeat(64))).toThrow(/already holds/);
    expect(readFileSync(store.paths.documentPath("coa", "c1")).equals(docBytes)).toBe(true);
    expect(existsSync(store.paths.metaPath("coa", "c1"))).toBe(true);
    expect(existsSync(join(dir, "c1.json"))).toBe(false);
    expect(readFileSync(join(dir, "c1.meta.json"), "utf8")).toBe("planted\n");
  });

  it("refuses a stamp that cannot be a directory name, before moving anything", () => {
    const store = scratchStore();
    store.putDocument("coa", "c1", { v: 1 }, {});
    expect(() => store.supersedeDocument("coa", "c1", "a/b", "0".repeat(64))).toThrow(InvalidIdError);
    expect(store.has("coa", "c1")).toBe(true);
  });
});
