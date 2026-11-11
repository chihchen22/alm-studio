/**
 * The seed writes an LCR-tagged copy of the hqla book under a
 * two-dimension taxonomy, and leaves the hqla book and its taxonomy byte for
 * byte as piece 5b wrote them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDimensions } from "@alm/engine";
import type { DimensionTaxonomy, PortfolioSpec } from "@alm/engine";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { buildHqlaPortfolio, buildLcrPortfolio, seedStore, SEED_IDS } from "../../scripts/seed-store";

let storeRoot: string;
let store: FileStore;

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-seed-lcr-"));
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

describe("seeded lcr book", () => {
  it("writes the book and its taxonomy under the stated ids", () => {
    expect(SEED_IDS.lcrPortfolio).toBe("synthetic-2500-lcr-v1");
    expect(SEED_IDS.liquidityTaxonomy).toBe("liquidity-tags-v1");
    expect(store.has("portfolios", "synthetic-2500-lcr-v1")).toBe(true);
    const tax = store.getDocument<DimensionTaxonomy>("taxonomy", "liquidity-tags-v1").doc;
    expect(tax.dimensions).toEqual([
      { id: "hqla-level", label: "HQLA level for the liquidity buffer", values: ["l1", "l2a", "l2b"] },
      {
        id: "lcr-category",
        label: "LCR run-off category for a liability family",
        values: [
          "retail-stable",
          "retail-other",
          "operational",
          "secured-gse",
          "wholesale-nonfinancial",
          "wholesale-financial",
        ],
      },
    ]);
  });

  it("stores exactly the document buildLcrPortfolio builds, valid against its taxonomy", () => {
    const stored = store.getDocument<PortfolioSpec>("portfolios", "synthetic-2500-lcr-v1").doc;
    expect(stored).toEqual(buildLcrPortfolio());
    expect(stored.taxonomy?.id).toBe("liquidity-tags-v1");
    expect(validateDimensions(stored)).toEqual([]);
  });

  it("adds the stated lcr-category to every liability position and nothing else", () => {
    const hqla = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.hqlaPortfolio).doc;
    const lcr = store.getDocument<PortfolioSpec>("portfolios", "synthetic-2500-lcr-v1").doc;
    const want: Record<string, string> = {
      dda: "retail-stable",
      mma: "retail-other",
      cds: "retail-stable",
      fhlb: "secured-gse",
      borrowings: "wholesale-financial",
    };
    expect(lcr.positions.length).toBe(hqla.positions.length);
    lcr.positions.forEach((p, i) => {
      const before = hqla.positions[i]!;
      const cat = want[p.familyId];
      const expected = cat === undefined ? before.dimensions : { ...before.dimensions, "lcr-category": cat };
      expect(p.dimensions, p.id).toEqual(expected);
      const { dimensions: _a, ...restAfter } = p;
      const { dimensions: _b, ...restBefore } = before;
      expect(restAfter).toEqual(restBefore);
    });
    expect(lcr.coa).toEqual(hqla.coa);
    expect(lcr.asOf).toBe(hqla.asOf);
  });

  it("leaves the hqla book and its taxonomy exactly as piece 5b wrote them", () => {
    expect(store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.hqlaPortfolio).doc).toEqual(buildHqlaPortfolio());
    const tax = store.getDocument<DimensionTaxonomy>("taxonomy", SEED_IDS.hqlaTaxonomy).doc;
    expect(tax.id).toBe("hqla-tags-v1");
    expect(tax.label).toBe("HQLA levels (survival-horizon buffer)");
    expect(tax.dimensions).toEqual([
      { id: "hqla-level", label: "HQLA level for the survival-horizon buffer", values: ["l1", "l2a", "l2b"] },
    ]);
  });

  it("is idempotent: a second seed writes nothing new", async () => {
    const second = await seedStore(store, repoRoot());
    expect(second.written).toEqual([]);
  });
});
