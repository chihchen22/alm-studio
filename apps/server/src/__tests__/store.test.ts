/**
 * File store discipline: atomic document writes with meta and
 * content hash, append-only refusal on overwrite, strict id validation, and
 * restart survival (a second store instance over the same root sees everything
 * the first wrote).
 */
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LENS_ID_PATTERN } from "@alm/engine";
import { AlreadyExistsError, FileStore, sha256Hex } from "../store/store";
import { COLLECTIONS, ID_PATTERN, InvalidIdError, type Collection } from "../store/paths";

function scratchStore(): FileStore {
  const store = new FileStore(mkdtempSync(join(tmpdir(), "alm-store-test-")));
  store.init();
  return store;
}

describe("FileStore", () => {
  it("writes a document with meta whose contentHash matches the stored bytes", () => {
    const store = scratchStore();
    const meta = store.putDocument("portfolios", "book-1", { id: "book-1", positions: [] }, { label: "b" });
    const bytes = readFileSync(store.paths.documentPath("portfolios", "book-1"));
    expect(meta.contentHash).toBe(sha256Hex(bytes));
    expect(store.getDocument("portfolios", "book-1").doc).toEqual({ id: "book-1", positions: [] });
  });

  it("refuses to overwrite an existing document (append-only)", () => {
    const store = scratchStore();
    store.putDocument("market", "m1", { a: 1 }, {});
    expect(() => store.putDocument("market", "m1", { a: 2 }, {})).toThrow(AlreadyExistsError);
    // The original bytes are untouched.
    expect(store.getDocument<{ a: number }>("market", "m1").doc.a).toBe(1);
  });

  it("rejects ids unusable as filenames, echoing the offending id", () => {
    const store = scratchStore();
    for (const bad of ["", "a/b", "a\\b", "a b", "x".repeat(65), "café"]) {
      expect(() => store.putDocument("portfolios", bad, {}, {})).toThrow(InvalidIdError);
    }
    // Path traversal cannot pass the pattern (slashes are rejected).
    expect(() => store.getDocument("portfolios", "../escape")).toThrow(InvalidIdError);
  });

  it("survives a restart: a second instance over the same root reads everything", () => {
    const root = mkdtempSync(join(tmpdir(), "alm-store-test-"));
    const first = new FileStore(root);
    first.init();
    first.putDocument("assumption-sets", "set-1", { id: "set-1", bindings: [] }, { label: "s" });
    first.writeRunJson("run-x", "status.json", { runId: "run-x", state: "queued" });
    first.appendRunLog("run-x", { t: "status", state: "queued" });

    const second = new FileStore(root);
    expect(second.listMeta("assumption-sets").map((m) => m.id)).toEqual(["set-1"]);
    expect(second.listRunIds()).toEqual(["run-x"]);
    expect(second.readRunJson<{ state: string }>("run-x", "status.json").state).toBe("queued");
    expect(second.readRunLog("run-x")).toHaveLength(1);
  });

  it("a missing document's refusal names market, taxonomy and portfolio by their own noun", () => {
    const store = scratchStore();
    expect(() => store.getDocument("market", "m-nope")).toThrow(/^market "m-nope" not found$/);
    expect(() => store.getDocument("taxonomy", "t-nope")).toThrow(/^taxonomy "t-nope" not found$/);
    expect(() => store.getDocument("portfolios", "p-nope")).toThrow(/^portfolio "p-nope" not found$/);
  });

  it("the overwrite refusal reads as plain words, with no em-dash (Polish 1 V1)", () => {
    const store = scratchStore();
    store.putDocument("market", "m1", { a: 1 }, {});
    let message = "";
    try { store.putDocument("market", "m1", { a: 2 }, {}); } catch (e) { message = (e as Error).message; }
    expect(message).toBe('market "m1" already exists; the store is append-only; import under a new id instead of overwriting');
    expect(message).not.toMatch(/\u2014/);
  });

  it("names every collection by its own noun (Polish 1 V2)", () => {
    const store = scratchStore();
    // Restated from the spec: plans holds balance plans; hyphenated collections read as two words.
    const NOUNS: Array<[Collection, string]> = [
      ["portfolios", "portfolio"],
      ["market", "market"],
      ["assumption-sets", "assumption set"],
      ["scenario-slates", "scenario slate"],
      ["coa", "chart of accounts"],
      ["taxonomy", "taxonomy"],
      ["lens", "lens"],
      ["plans", "balance plan"],
      ["routing-policies", "routing policy"],
      ["run-plans", "run plan"],
      ["approvals", "approval"],
      ["hierarchies", "hierarchy"],
      ["run-setups", "run setup"],
      ["curve-setups", "curve setup"],
      ["derived-curves", "derived curve"],
      ["index-histories", "index history"],
      ["reference", "reference document"],
      ["calibrations", "saved calibration"],
    ];
    for (const [collection, noun] of NOUNS) {
      expect(() => store.getDocument(collection, "x"), collection).toThrow(new RegExp(`^${noun} "x" not found$`));
    }
    // Every collection the store knows is named above.
    expect(NOUNS.map(([c]) => c).sort()).toEqual([...COLLECTIONS].sort());
  });

  it("run log tolerates a torn trailing line without inventing an event", () => {
    const store = scratchStore();
    store.appendRunLog("run-y", { t: "status", state: "queued" });
    // Simulate a crash mid-append: a torn, unterminated JSON fragment.
    appendFileSync(store.paths.runFile("run-y", "log.ndjson"), '{"t":"stat', "utf8");
    expect(store.readRunLog("run-y")).toHaveLength(1);
  });
});

/**
 * Piece 3a, spec Section 2 rule V1. A lens id doubles as a store filename, so
 * the engine's LENS_ID_PATTERN must be the store's ID_PATTERN. The engine
 * cannot import the server, so the literal is restated there; this is the pin
 * that keeps the two copies from drifting apart unnoticed.
 */
describe("the lens id pattern and the store id pattern", () => {
  it("are the same literal, so a valid lens id is always a valid store id", () => {
    expect(LENS_ID_PATTERN.source).toBe(ID_PATTERN.source);
    expect(LENS_ID_PATTERN.flags).toBe(ID_PATTERN.flags);
  });
});
