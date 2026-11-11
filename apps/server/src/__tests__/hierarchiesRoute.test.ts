/**
 * The hierarchies routes, the tag-only apply that
 * writes a new book, and the putBook extraction. Every expected value is
 * restated from the approved design, never read back from the code under test.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { VIEW_SEGMENT_TAXONOMY, segmentedNmdBook } from "@alm/engine/src/run/__tests__/fixtures";
import { api, bootTestPlatform, mirrorStoreNow, warmCatalog, type TestPlatform } from "./harness";

let t: TestPlatform;

function H(): Record<string, unknown> {
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

function withId(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...H(), id, ...extra };
}

/** A book whose taxonomy declares a closed tag "tier" that no position carries. */
function tierBook(id: string): PortfolioSpec {
  const book = segmentedNmdBook(id);
  book.taxonomy = {
    schemaVersion: "1.0.0",
    id: "TAX-TIER",
    label: "One tier tag",
    dimensions: [{ id: "tier", label: "Tier", values: ["a"] }],
  };
  book.positions = book.positions.map((p) => {
    const { dimensions: _dropped, ...rest } = p;
    return rest as typeof p;
  });
  return book;
}

const importBook = (book: PortfolioSpec) => api(t.base, "POST", "/api/portfolios/import", book);
const storeFile = (collection: string, name: string): string => join(t.storeRoot, collection, name);
const readBytes = (collection: string, id: string): string => readFileSync(storeFile(collection, `${id}.json`), "utf8");
const readMeta = (collection: string, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(storeFile(collection, `${id}.meta.json`), "utf8")) as Record<string, unknown>;
const listing = (collection: string): string[] => readdirSync(join(t.storeRoot, collection)).sort();
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Err {
  error: { code: string; message: string; detail?: { problems?: string[]; unmapped?: string[] } };
}

beforeAll(async () => {
  t = await bootTestPlatform();
  expect((await importBook(segmentedNmdBook("PF-HIER"))).status).toBe(201);
  const wide = segmentedNmdBook("PF-HIER-WIDE");
  wide.taxonomy = VIEW_SEGMENT_TAXONOMY;
  expect((await importBook(wide)).status).toBe(201);
  expect((await importBook(segmentedNmdBook("PF-HIER--seg-alt"))).status).toBe(201);
});
afterAll(() => t.close());

describe("reads", () => {
  it("lists nothing before any hierarchy is saved", async () => {
    const r = await api(t.base, "GET", "/api/hierarchies");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("serves the source dimensions of a book", async () => {
    const r = await api(t.base, "GET", "/api/hierarchies/sources/PF-HIER");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
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

  it("404s sources for an unknown book", async () => {
    const r = await api<Err>(t.base, "GET", "/api/hierarchies/sources/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe('portfolio "nope" not found');
  });

  it("404s an unknown hierarchy", async () => {
    const r = await api<Err>(t.base, "GET", "/api/hierarchies/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe('hierarchy "nope" not found');
  });
});

describe("save", () => {
  it("creates, serves the canonical document, and answers identical re-saves with 200", async () => {
    const r = await api<Record<string, unknown>>(t.base, "POST", "/api/hierarchies", { hierarchy: H(), bookId: "PF-HIER" });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe("created");
    expect(r.body.id).toBe("seg-risk");
    expect(r.body.label).toBe("Segment risk tree");
    expect(r.body.kind).toBe("risk");
    expect(r.body.sourceDimension).toBe("segment");
    expect(r.body.checkedBookId).toBe("PF-HIER");
    expect(r.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.contentHash).toBe(sha(readBytes("hierarchies", "seg-risk")));

    const got = await api(t.base, "GET", "/api/hierarchies/seg-risk");
    expect(got.status).toBe(200);
    expect(Object.keys(got.body as object)).toEqual([
      "schemaVersion", "id", "label", "kind", "sourceDimension", "levels", "nodes", "map",
    ]);
    expect(got.body).toEqual({
      schemaVersion: "1.0.0",
      id: "seg-risk",
      label: "Segment risk tree",
      kind: "risk",
      sourceDimension: "segment",
      levels: [{ id: "group", label: "Group" }, { id: "leaf", label: "Leaf" }],
      nodes: [
        { id: "deposits", parentId: null, level: "group" },
        { id: "rate-sensitive", parentId: "deposits", level: "leaf" },
        { id: "sticky", parentId: "deposits", level: "leaf" },
      ],
      map: { "rate-shopper": "rate-sensitive", relationship: "sticky" },
    });
    expect(Object.keys((got.body as { map: object }).map)).toEqual(["rate-shopper", "relationship"]);

    const shuffled = {
      map: H().map, nodes: H().nodes, levels: H().levels, sourceDimension: "segment",
      kind: "risk", label: "Segment risk tree", id: "seg-risk", schemaVersion: "1.0.0",
    };
    const again = await api<Record<string, unknown>>(t.base, "POST", "/api/hierarchies", { bookId: "PF-HIER", hierarchy: shuffled });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("unchanged");
    expect(again.body.contentHash).toBe(r.body.contentHash);

    const before = listing("hierarchies");
    const padded = {
      ...H(),
      label: "  Segment risk tree  ",
      levels: [{ id: "group", label: " Group " }, { id: "leaf", label: "Leaf " }],
    };
    const trimmed = await api<Record<string, unknown>>(t.base, "POST", "/api/hierarchies", { hierarchy: padded, bookId: "PF-HIER" });
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.outcome).toBe("unchanged");
    expect(trimmed.body.contentHash).toBe(r.body.contentHash);
    expect(listing("hierarchies")).toEqual(before);

    const list = await api<Array<{ id: string }>>(t.base, "GET", "/api/hierarchies");
    expect(list.body.map((m) => m.id)).toEqual(["seg-risk"]);
  });

  it("refuses different content under an existing id with 409", async () => {
    const r = await api<Err>(t.base, "POST", "/api/hierarchies", { hierarchy: { ...H(), label: "Other" }, bookId: "PF-HIER" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe(
      'hierarchy "seg-risk" already exists with different content (the store is append-only); save it under a new id',
    );
  });

  it("refuses a map that does not cover the book with 422 and every problem", async () => {
    const map = { "rate-shopper": "rate-sensitive" };
    const r = await api<Err>(t.base, "POST", "/api/hierarchies", { hierarchy: withId("seg-risk-2", { map }), bookId: "PF-HIER" });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(
      'hierarchy "seg-risk-2" does not fit book "PF-HIER": 1 problem(s); every problem is listed',
    );
    expect(r.body.error.detail?.unmapped).toEqual(["relationship"]);
    expect(r.body.error.detail?.problems).toEqual([
      '1 value(s) of tag "segment" on book "PF-HIER" map to no leaf: relationship',
    ]);
    expect(listing("hierarchies")).toEqual(["seg-risk.json", "seg-risk.meta.json"]);
  });

  it("refuses an id with a double hyphen", async () => {
    const r = await api<Err>(t.base, "POST", "/api/hierarchies", { hierarchy: withId("seg--risk"), bookId: "PF-HIER" });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(
      'hierarchy id must match /^[A-Za-z0-9_-]{1,32}$/, must not start with "-" and must not contain "--" ' +
        '(it becomes part of tag ids and of the re-tagged book id <book>--<hierarchy>); got "seg--risk"',
    );
  });

  it("404s an unknown book", async () => {
    const r = await api<Err>(t.base, "POST", "/api/hierarchies", { hierarchy: withId("seg-risk-4"), bookId: "nope" });
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe('portfolio "nope" not found');
  });

  it("refuses a structural fault with 422 and the problems list", async () => {
    const map = { "rate-shopper": "deposits", relationship: "sticky" };
    const r = await api<Err>(t.base, "POST", "/api/hierarchies", { hierarchy: withId("seg-risk-3", { map }), bookId: "PF-HIER" });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('hierarchy "seg-risk-3" rejected: 1 problem(s); every problem is listed');
    expect(r.body.error.detail?.problems).toEqual([
      'map value "rate-shopper" names "deposits", which is at level "group", not the last level "leaf"; a value maps to a leaf',
    ]);
  });

  it("refuses a body with an unknown field and a missing book id", async () => {
    const extra = await api<Err>(t.base, "POST", "/api/hierarchies", { hierarchy: H(), bookId: "PF-HIER", note: 1 });
    expect(extra.status).toBe(422);
    expect(extra.body.error.message).toBe('unknown field "note" in the request body; send { hierarchy, bookId }');
    const bare = await api<Err>(t.base, "POST", "/api/hierarchies", { hierarchy: H() });
    expect(bare.status).toBe(422);
    expect(bare.body.error.message).toBe("POST /api/hierarchies takes { hierarchy, bookId }");
  });
});

describe("apply", () => {
  it("writes a new tagged book, copies the intake block verbatim, and is idempotent", async () => {
    const sourceBefore = readBytes("portfolios", "PF-HIER");
    const r = await api<Record<string, unknown>>(t.base, "POST", "/api/hierarchies/seg-risk/apply", { bookId: "PF-HIER" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      outcome: "created",
      id: "PF-HIER--seg-risk",
      label: "Run test book; tagged by hierarchy seg-risk",
      positionCount: 6,
      sourceBookId: "PF-HIER",
      hierarchyId: "seg-risk",
      taxonomyId: "TAX-SEGMENT--seg-risk",
      tags: ["seg-risk.group", "seg-risk.leaf"],
      untaggedPositionIds: ["B1", "F1", "M1"],
    });
    expect(r.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.contentHash).toBe(sha(readBytes("portfolios", "PF-HIER--seg-risk")));

    const book = await api<PortfolioSpec>(t.base, "GET", "/api/portfolios/PF-HIER--seg-risk");
    const dims = (id: string) => book.body.positions.find((p) => p.id === id)!.dimensions;
    expect(dims("D1")).toEqual({ segment: "rate-shopper", "seg-risk.group": "deposits", "seg-risk.leaf": "rate-sensitive" });
    expect(dims("D2")).toEqual({ segment: "rate-shopper", "seg-risk.group": "deposits", "seg-risk.leaf": "rate-sensitive" });
    expect(dims("D3")).toEqual({ segment: "relationship", "seg-risk.group": "deposits", "seg-risk.leaf": "sticky" });
    expect(dims("F1")).toBeUndefined();

    const meta = readMeta("portfolios", "PF-HIER--seg-risk");
    expect(meta.intake).toEqual(readMeta("portfolios", "PF-HIER").intake);
    expect(meta.intake).toBeDefined();
    expect(meta.sourceBookId).toBe("PF-HIER");
    expect(meta.hierarchyId).toBe("seg-risk");
    expect(readBytes("portfolios", "PF-HIER")).toBe(sourceBefore);

    const before = listing("portfolios");
    const again = await api<Record<string, unknown>>(t.base, "POST", "/api/hierarchies/seg-risk/apply", { bookId: "PF-HIER" });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("unchanged");
    expect(again.body.contentHash).toBe(r.body.contentHash);
    expect(listing("portfolios")).toEqual(before);
  });

  it("refuses when a book that this pair did not produce holds the composed id", async () => {
    const saved = await api(t.base, "POST", "/api/hierarchies", { hierarchy: withId("seg-alt"), bookId: "PF-HIER" });
    expect(saved.status).toBe(201);
    const before = readBytes("portfolios", "PF-HIER--seg-alt");
    const r = await api<Err>(t.base, "POST", "/api/hierarchies/seg-alt/apply", { bookId: "PF-HIER" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe(
      'book "PF-HIER--seg-alt" already exists and was not written by applying hierarchy "seg-alt" to book "PF-HIER"; ' +
        "save the hierarchy under another id",
    );
    expect(readBytes("portfolios", "PF-HIER--seg-alt")).toBe(before);
  });

  it("mirrors the new tagged book at once: the catalog positions and lineage reads answer with no re-sync", async () => {
    // This file never seeds, so create the database as a boot sync would; the apply route then advances it.
    mirrorStoreNow(t.storeRoot);
    await warmCatalog(t.base);
    expect((await api(t.base, "POST", "/api/hierarchies", { hierarchy: withId("seg-mirror"), bookId: "PF-HIER" })).status).toBe(201);
    const r = await api<Record<string, unknown>>(t.base, "POST", "/api/hierarchies/seg-mirror/apply", { bookId: "PF-HIER" });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe("PF-HIER--seg-mirror");
    const pos = await api<{ page: { total: number } }>(t.base, "GET", "/api/catalog/portfolios/PF-HIER--seg-mirror/positions");
    expect(pos.status).toBe(200);
    expect(pos.body.page.total).toBe(6);
    expect((await api(t.base, "GET", "/api/catalog/lineage/portfolios/PF-HIER--seg-mirror")).status).toBe(200);
  });

  it("refuses to apply twice onto an already tagged book", async () => {
    const r = await api<Err>(t.base, "POST", "/api/hierarchies/seg-risk/apply", { bookId: "PF-HIER--seg-risk" });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(
      'book "PF-HIER--seg-risk" already declares tag "seg-risk.group"; ' +
        'hierarchy "seg-risk" has been applied to it already, or another tag holds that id',
    );
  });

  it("refuses a book whose closed tag has an unmapped value", async () => {
    const r = await api<Err>(t.base, "POST", "/api/hierarchies/seg-risk/apply", { bookId: "PF-HIER-WIDE" });
    expect(r.status).toBe(422);
    expect(r.body.error.detail?.unmapped).toEqual(["whole-book"]);
    expect(r.body.error.message).toBe(
      'hierarchy "seg-risk" does not fit book "PF-HIER-WIDE": 1 problem(s); every problem is listed',
    );
  });

  it("404s an unknown hierarchy and an unknown book", async () => {
    const h = await api<Err>(t.base, "POST", "/api/hierarchies/nope/apply", { bookId: "PF-HIER" });
    expect(h.status).toBe(404);
    expect(h.body.error.message).toBe('hierarchy "nope" not found');
    const b = await api<Err>(t.base, "POST", "/api/hierarchies/seg-risk/apply", { bookId: "nope" });
    expect(b.status).toBe(404);
    expect(b.body.error.message).toBe('portfolio "nope" not found');
  });

  it("refuses an unknown body field and a missing book id", async () => {
    const x = await api<Err>(t.base, "POST", "/api/hierarchies/seg-risk/apply", { bookId: "PF-HIER", x: 1 });
    expect(x.status).toBe(422);
    expect(x.body.error.message).toBe('POST /api/hierarchies/:id/apply takes { bookId }; got unknown field "x"');
    const none = await api<Err>(t.base, "POST", "/api/hierarchies/seg-risk/apply", {});
    expect(none.status).toBe(422);
    expect(none.body.error.message).toBe("bookId must be a store id string");
  });

  it("refuses when no position carries the source tag", async () => {
    expect((await importBook(tierBook("PF-TIER"))).status).toBe(201);
    const tree = {
      schemaVersion: "1.0.0",
      id: "tier-tree",
      label: "Tier tree",
      kind: "risk",
      sourceDimension: "tier",
      levels: [{ id: "one", label: "One" }],
      nodes: [{ id: "all", parentId: null, level: "one" }],
      map: { a: "all" },
    };
    const saved = await api(t.base, "POST", "/api/hierarchies", { hierarchy: tree, bookId: "PF-TIER" });
    expect(saved.status).toBe(201);
    const r = await api<Err>(t.base, "POST", "/api/hierarchies/tier-tree/apply", { bookId: "PF-TIER" });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('no position of book "PF-TIER" carries tag "tier", so hierarchy "tier-tree" would tag nothing');
  });
});

describe("source text", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of ["../hierarchies/hierarchy.ts", "../http/routes/hierarchies.ts"]) {
    it(`${f} has no hand-rolled arithmetic or locale sort`, () => {
      const text = readFileSync(join(here, f), "utf8");
      for (const banned of ["+=", ".reduce(", "terms.notional", "localeCompare"]) {
        expect(text.includes(banned), `${f} contains ${banned}`).toBe(false);
      }
    });
  }

  it("the import route and apply share the putBook put path", () => {
    const portfolios = readFileSync(join(here, "../http/routes/portfolios.ts"), "utf8");
    expect(portfolios).toContain("export function putBook(");
    expect(portfolios).toContain("putBook(ctx.store, spec, intakeStats(spec))");
    const routes = readFileSync(join(here, "../http/routes/hierarchies.ts"), "utf8");
    expect(routes).toContain("putBook(");
  });
});
