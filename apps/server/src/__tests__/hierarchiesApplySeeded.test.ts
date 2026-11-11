/**
 * Studio Piece 5 fix: apply validates the dimension rules only, so the seeded
 * demonstration hierarchy re-tags the seeded books (which carry seed-only
 * instrument types the import intake refuses). Expected values are restated
 * here, never read back from the code under test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { buildDemoHierarchy, buildLcrPortfolio } from "../../scripts/seed-store";
import { retagBook } from "../hierarchies/hierarchy";
import { putBook } from "../http/routes/portfolios";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

const HID = "liquidity-funding-demo-v1";
const SRC = "synthetic-2500-lcr-v1";
const NEW = "synthetic-2500-lcr-v1--liquidity-funding-demo-v1";
const INTAKE = { positionCount: 2351, assets: 111, liabilities: 222, marker: "copied-verbatim" };

let t: TestPlatform;

interface Err {
  error: { code: string; message: string; detail?: { problems?: string[]; unmapped?: string[] } };
}

function seedBook(spec: PortfolioSpec): void {
  putBook(t.platform.context.store, spec, INTAKE);
}

const stripDims = (spec: PortfolioSpec) =>
  JSON.stringify(spec.positions.map((p) => {
    const { dimensions: _d, ...rest } = p;
    return rest;
  }));

/** Position ids that carry no lcr-category value, sorted ascending by UTF-16 code unit, restated. */
function untaggedOf(spec: PortfolioSpec): string[] {
  const out: string[] = [];
  for (const p of spec.positions) if (p.dimensions?.["lcr-category"] === undefined) out.push(p.id);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

beforeAll(async () => {
  t = await bootTestPlatform();
  seedBook(buildLcrPortfolio());
  t.platform.context.store.putDocument("hierarchies", HID, buildDemoHierarchy(), { label: "demo", kind: "liquidity", sourceDimension: "lcr-category" });
});
afterAll(() => t.close());

describe("apply of the seeded hierarchy over the seeded lcr book", () => {
  const source = buildLcrPortfolio();

  it("answers 201 with the composed id, then 200 unchanged", async () => {
    const r = await api<Record<string, unknown>>(t.base, "POST", `/api/hierarchies/${HID}/apply`, { bookId: SRC });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      outcome: "created",
      id: NEW,
      positionCount: 2351,
      sourceBookId: SRC,
      hierarchyId: HID,
      tags: [`${HID}.funding`, `${HID}.bucket`],
    });
    const again = await api<Record<string, unknown>>(t.base, "POST", `/api/hierarchies/${HID}/apply`, { bookId: SRC });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("unchanged");
    expect(again.body.contentHash).toBe(r.body.contentHash);
    expect(again.body.untaggedPositionIds).toEqual(untaggedOf(source));
  });

  it("reports the untagged position ids, sorted by code unit", async () => {
    const r = await api<{ untaggedPositionIds: string[] }>(t.base, "POST", `/api/hierarchies/${HID}/apply`, { bookId: SRC });
    const want = untaggedOf(source);
    expect(want.length).toBeGreaterThan(0);
    expect(r.body.untaggedPositionIds).toEqual(want);
  });

  it("changes only the dimension bags: terms, coa and the intake block are byte-equal", async () => {
    const stored = await api<PortfolioSpec>(t.base, "GET", `/api/portfolios/${NEW}`);
    const applied = stored.body;
    expect(stripDims(applied)).toBe(stripDims(source));
    expect(JSON.stringify(applied.coa)).toBe(JSON.stringify(source.coa));
    const meta = JSON.parse(readFileSync(join(t.storeRoot, "portfolios", `${NEW}.meta.json`), "utf8")) as Record<string, unknown>;
    expect(meta.intake).toEqual(INTAKE);
    for (let i = 0; i < source.positions.length; i++) {
      const before = source.positions[i]!.dimensions ?? {};
      const after = applied.positions[i]!.dimensions ?? {};
      const added = Object.keys(after).filter((k) => !(k in before)).sort();
      if (before["lcr-category"] === undefined) {
        expect(added).toEqual([]);
      } else {
        expect(added).toEqual([`${HID}.bucket`, `${HID}.funding`]);
      }
      for (const k of Object.keys(before)) expect(after[k]).toEqual(before[k]);
    }
  });
});

describe("composed taxonomy schema version", () => {
  it("copies the source taxonomy schemaVersion", () => {
    const src = buildLcrPortfolio();
    src.taxonomy = { ...src.taxonomy!, schemaVersion: "2.3.4" };
    expect(retagBook(buildDemoHierarchy(), src).taxonomy!.schemaVersion).toBe("2.3.4");
  });
});

describe("a re-tag that breaks a dimension rule", () => {
  it("answers 422 and lists every problem", async () => {
    const bad = buildLcrPortfolio();
    bad.id = "bad-lcr";
    const i = bad.positions.findIndex((p) => p.dimensions?.["lcr-category"] !== undefined);
    bad.positions[i] = { ...bad.positions[i]!, dimensions: { ...bad.positions[i]!.dimensions, "lcr-category": "not-a-category" } };
    seedBook(bad);
    const id = bad.positions[i]!.id;
    const r = await api<Err>(t.base, "POST", `/api/hierarchies/${HID}/apply`, { bookId: "bad-lcr" });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe("re-tagged book failed the dimension rules: 1 problem(s); every problem is listed");
    expect(r.body.error.detail?.problems).toHaveLength(1);
    expect(r.body.error.detail?.problems?.[0]).toContain(id);
    expect(r.body.error.detail?.problems?.[0]).toContain("D3");
    expect(r.body.error.detail?.problems?.[0]).toContain("not-a-category");
    expect(t.platform.context.store.has("portfolios", "bad-lcr--liquidity-funding-demo-v1")).toBe(false);
  });
});

describe("a stored hierarchy that is no longer valid", () => {
  it("is refused at the start of apply with the problems listed", async () => {
    const h = buildDemoHierarchy();
    // "retail" is a first-level node, not a leaf.
    const broken = { ...h, id: "broken-h", map: { ...h.map, operational: "retail" } };
    t.platform.context.store.putDocument("hierarchies", "broken-h", broken, { label: "broken" });
    const r = await api<Err>(t.base, "POST", "/api/hierarchies/broken-h/apply", { bookId: SRC });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('stored hierarchy "broken-h" is invalid: 1 problem(s); every problem is listed');
    expect(r.body.error.detail?.problems).toEqual([
      'map value "operational" names "retail", which is at level "funding", not the last level "bucket"; a value maps to a leaf',
    ]);
    expect(t.platform.context.store.has("portfolios", "synthetic-2500-lcr-v1--broken-h")).toBe(false);
  });
});
