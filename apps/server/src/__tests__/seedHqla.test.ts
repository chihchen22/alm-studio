/**
 * The seed writes a second synthetic book whose cash and investments
 * positions are tagged hqla-level l1 and whose mbs positions are tagged l2a,
 * under a one-dimension taxonomy, and leaves the untagged synthetic book as it
 * was: the tagged book differs from it in id, label, taxonomy and tags only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDimensions } from "@alm/engine";
import type { DimensionTaxonomy, PortfolioSpec } from "@alm/engine";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { buildHqlaPortfolio, seedStore, SEED_IDS } from "../../scripts/seed-store";

let storeRoot: string;
let store: FileStore;

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-seed-hqla-"));
  store = new FileStore(storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);

afterAll(() => {
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // Windows file locking; the OS temp cleaner owns the leftovers.
  }
});

describe("seeded hqla book", () => {
  it("writes the tagged book and its taxonomy under the stated ids", () => {
    expect(SEED_IDS.hqlaPortfolio).toBe("synthetic-2500-hqla-v1");
    expect(SEED_IDS.hqlaTaxonomy).toBe("hqla-tags-v1");
    expect(store.has("portfolios", "synthetic-2500-hqla-v1")).toBe(true);
    const tax = store.getDocument<DimensionTaxonomy>("taxonomy", "hqla-tags-v1").doc;
    expect(tax.dimensions).toEqual([
      { id: "hqla-level", label: "HQLA level for the survival-horizon buffer", values: ["l1", "l2a", "l2b"] },
    ]);
  });

  it("stores exactly the document buildHqlaPortfolio builds", () => {
    const stored = store.getDocument<PortfolioSpec>("portfolios", "synthetic-2500-hqla-v1").doc;
    expect(stored).toEqual(buildHqlaPortfolio());
  });

  it("tags cash and investments l1 and mbs l2a, every position of each, and nothing else", () => {
    const book = store.getDocument<PortfolioSpec>("portfolios", "synthetic-2500-hqla-v1").doc;
    expect(book.taxonomy?.id).toBe("hqla-tags-v1");
    expect(validateDimensions(book)).toEqual([]);
    const expected: Record<string, string> = { cash: "l1", investments: "l1", mbs: "l2a" };
    let tagged = 0;
    for (const p of book.positions) {
      const want = expected[p.familyId];
      if (want === undefined) {
        expect(p.dimensions, p.id).toBeUndefined();
      } else {
        expect(p.dimensions, p.id).toEqual({ "hqla-level": want });
        tagged += 1;
      }
    }
    expect(tagged).toBeGreaterThan(0);
  });

  it("differs from the untagged synthetic book only in id, label, taxonomy and tags", () => {
    const plain = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
    const tagged = store.getDocument<PortfolioSpec>("portfolios", "synthetic-2500-hqla-v1").doc;
    expect(plain.taxonomy).toBeUndefined();
    expect(plain.positions.every((p) => p.dimensions === undefined)).toBe(true);
    const stripped = tagged.positions.map(({ dimensions: _d, ...rest }) => rest);
    expect(stripped).toEqual(plain.positions);
    expect(tagged.coa).toEqual(plain.coa);
    expect(tagged.asOf).toBe(plain.asOf);
  });

  it("is idempotent: a second seed writes nothing new", async () => {
    const second = await seedStore(store, repoRoot());
    expect(second.written).toEqual([]);
  });
});
