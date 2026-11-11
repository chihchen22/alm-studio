/**
 * The seed ships one ILLUSTRATIVE hierarchy over lcr-category.
 * Values are restated here, never read from SEED_IDS.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDimensions } from "@alm/engine";
import type { PortfolioSpec } from "@alm/engine";
import { repoRoot } from "../config";
import { buildCommitmentPortfolio, buildDemoHierarchy, buildLcrPortfolio, planSeedDocuments } from "../../scripts/seed-store";
import { checkAgainstBook, parseHierarchy, retagBook, validateHierarchy } from "../hierarchies/hierarchy";

const ID = "liquidity-funding-demo-v1";

describe("seeded demonstration hierarchy", () => {
  it("is the decided literal, in canonical key order", () => {
    const h = buildDemoHierarchy();
    expect(Object.keys(h)).toEqual(["schemaVersion", "id", "label", "kind", "sourceDimension", "levels", "nodes", "map"]);
    expect(Object.keys(h.map)).toEqual([
      "operational",
      "retail-other",
      "retail-stable",
      "secured-gse",
      "wholesale-financial",
      "wholesale-nonfinancial",
    ]);
    expect(h).toEqual({
      schemaVersion: "1.0.0",
      id: ID,
      label: "Liquidity funding hierarchy over the LCR category tag (demonstration values)",
      kind: "liquidity",
      sourceDimension: "lcr-category",
      levels: [
        { id: "funding", label: "Funding source" },
        { id: "bucket", label: "Run-off bucket" },
      ],
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
    });
  });

  it("is already canonical and valid", () => {
    const h = buildDemoHierarchy();
    expect(JSON.stringify(parseHierarchy(h))).toBe(JSON.stringify(h));
    expect(validateHierarchy(h)).toEqual([]);
  });

  it("fits the lcr book and the commitment book", () => {
    const h = buildDemoHierarchy();
    expect(checkAgainstBook(h, buildLcrPortfolio())).toEqual({ problems: [], unmapped: [] });
    expect(checkAgainstBook(h, buildCommitmentPortfolio())).toEqual({ problems: [], unmapped: [] });
  });

  describe("retagged lcr book", () => {
    const source = buildLcrPortfolio();
    const book: PortfolioSpec = retagBook(buildDemoHierarchy(), source);
    const firstOf = (family: string) => book.positions.find((p) => p.familyId === family)!;
    const sourceFirstOf = (family: string) => source.positions.find((p) => p.familyId === family)!;

    it("names the book and taxonomy and declares the two level tags", () => {
      expect(book.id).toBe("synthetic-2500-lcr-v1--liquidity-funding-demo-v1");
      expect(book.taxonomy!.id).toBe("liquidity-tags-v1--liquidity-funding-demo-v1");
      expect(book.positions).toHaveLength(2351);
      const defs = book.taxonomy!.dimensions;
      expect(defs.slice(-2)).toEqual([
        {
          id: "liquidity-funding-demo-v1.funding",
          label: "Liquidity funding hierarchy over the LCR category tag (demonstration values): Funding source",
          values: ["retail", "unsecured-wholesale", "secured"],
        },
        {
          id: "liquidity-funding-demo-v1.bucket",
          label: "Liquidity funding hierarchy over the LCR category tag (demonstration values): Run-off bucket",
          values: [
            "retail-stable",
            "retail-less-stable",
            "operational",
            "nonfinancial-wholesale",
            "financial-wholesale",
            "gse-secured",
          ],
        },
      ]);
      expect(validateDimensions(book)).toEqual([]);
    });

    it("tags liability positions with their ancestors after their existing tags", () => {
      const dda = firstOf("dda");
      expect(dda.dimensions).toEqual({
        ...sourceFirstOf("dda").dimensions,
        "lcr-category": "retail-stable",
        "liquidity-funding-demo-v1.funding": "retail",
        "liquidity-funding-demo-v1.bucket": "retail-stable",
      });
      expect(firstOf("fhlb").dimensions).toMatchObject({
        "liquidity-funding-demo-v1.funding": "secured",
        "liquidity-funding-demo-v1.bucket": "gse-secured",
      });
      expect(firstOf("borrowings").dimensions).toMatchObject({
        "liquidity-funding-demo-v1.funding": "unsecured-wholesale",
        "liquidity-funding-demo-v1.bucket": "financial-wholesale",
      });
      expect(firstOf("mma").dimensions).toMatchObject({
        "liquidity-funding-demo-v1.funding": "retail",
        "liquidity-funding-demo-v1.bucket": "retail-less-stable",
      });
    });

    it("leaves every position without the source tag as the same object", () => {
      let untouched = 0;
      book.positions.forEach((p, i) => {
        const s = source.positions[i]!;
        if (s.dimensions?.["lcr-category"] === undefined) {
          expect(p).toBe(s);
          untouched += 1;
        }
      });
      expect(untouched).toBeGreaterThan(0);
    });
  });

  it("is planned last, with the decided meta, and the applied book is not planned", async () => {
    const docs = await planSeedDocuments(repoRoot());
    const last = docs[docs.length - 1]!;
    expect(`${last.collection}/${last.id}`).toBe(`hierarchies/${ID}`);
    expect(last.meta).toEqual({
      label: "Liquidity funding hierarchy over the LCR category tag (demonstration values)",
      kind: "liquidity",
      sourceDimension: "lcr-category",
      checkedBookId: "synthetic-2500-lcr-v1",
      seeded: true,
    });
    expect(docs.some((d) => d.id === `synthetic-2500-lcr-v1--${ID}`)).toBe(false);
    // The liability book is seeded, its applied copy is not.
    expect(docs.some((d) => d.id === `synthetic-lcr-liabilities-v1--${ID}`)).toBe(false);
  }, 60_000);
});

const LIMITATIONS = join(repoRoot(), "docs", "LIMITATIONS.md");
// The limitations file is optional: absent, the doc-sync check skips and says why.
describe.skipIf(!existsSync(LIMITATIONS))(`LIMITATIONS for Hierarchies and mapping${existsSync(LIMITATIONS) ? "" : " [skipped: no docs/LIMITATIONS.md; the limitations page is docs/guide/limitations.md]"}`, () => {
  const text = existsSync(LIMITATIONS) ? readFileSync(LIMITATIONS, "utf8") : "";
  const start = text.indexOf("### Hierarchies and mapping (Piece 5)");
  const end = text.indexOf("### ALM Studio P2 (targets and new business)");
  const section = text.slice(start, end);

  it("has the subsection, between Loan repricing and Studio P2", () => {
    expect(start).toBeGreaterThan(text.indexOf("### Loan repricing (Piece 9)"));
    expect(end).toBeGreaterThan(start);
    expect(section).toContain("hand-written RunPlan");
    expect(section).toContain("must not start with");
    expect(section).toContain("liquidity-funding-demo-v1");
  });

  it("holds no em-dash and no section sign, and the Soon bullet names no layer", () => {
    expect(section).not.toContain(String.fromCharCode(0x2014));
    expect(section).not.toContain(String.fromCharCode(0x00a7));
    // Re-expectation: rate indices went live, so the Soon bullet names
    // one layer (macro factors) and the sentence reads singular.
    // Re-expectation: Macro factors is live; no layer is Soon.
    expect(text).toContain("- No layer is Soon. Macro factors went live in Piece 7b");
    expect(text).not.toContain("hierarchies and mapping (Piece 5)");
  });
});
