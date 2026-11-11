/**
 * Piece 2a, spec acceptance (d) at the front door: the JSON intake keeps the
 * book's taxonomy and its per-position bags, and reports a bag that breaks the
 * taxonomy as a row error naming the position, the tag and the rule.
 */
import { describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { validateDimensions } from "@alm/engine";
import { buildChartOfAccounts } from "@alm/data";
import { segmentedNmdBook } from "@alm/engine/src/run/__tests__/fixtures";
import { buildDemoTaxonomy } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { parsePositionsJson } from "../intake/positionsJson";
import { TEST_COA, TEST_TAXONOMY } from "../intake/__tests__/fixtures";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

describe("JSON intake carries the taxonomy and the bags", () => {
  it("accepts the segmented book and keeps its taxonomy", () => {
    const r = parsePositionsJson(JSON.parse(JSON.stringify(segmentedNmdBook())));
    expect("portfolio" in r).toBe(true);
    if ("portfolio" in r) {
      expect(r.portfolio.taxonomy?.id).toBe("TAX-SEGMENT");
      expect(r.portfolio.positions.at(-1)!.dimensions).toEqual({ segment: "relationship" });
    }
  });

  it("reports a closed-set violation as a row error naming the position and the tag", () => {
    const book = segmentedNmdBook();
    book.positions[book.positions.length - 1] = {
      ...book.positions.at(-1)!,
      dimensions: { segment: "whale" },
    };
    const r = parsePositionsJson(JSON.parse(JSON.stringify(book)));
    expect("errors" in r).toBe(true);
    if ("errors" in r) {
      expect(r.errors).toEqual([
        expect.objectContaining({
          positionId: "D3",
          column: "dimensions.segment",
          message: expect.stringContaining("D3:"),
        }),
      ]);
    }
  });

  it("reports a tag the taxonomy does not declare, and one that is derived", () => {
    const book = segmentedNmdBook();
    book.positions[book.positions.length - 1] = {
      ...book.positions.at(-1)!,
      dimensions: { vintage: "2019", side: "asset" },
    };
    const r = parsePositionsJson(JSON.parse(JSON.stringify(book)));
    expect("errors" in r).toBe(true);
    if ("errors" in r) {
      expect(r.errors.map((e) => e.column)).toEqual(["dimensions.vintage", "dimensions.side"]);
      expect(r.errors.every((e) => e.message.startsWith("D2:"))).toBe(true);
    }
  });
});

/**
 * The seeded taxonomy is the DimensionTaxonomy
 * PROJECTION of docs/harness/demo-dimensions.json: anything beyond the four
 * taxonomy keys is not part of a taxonomy and would be dropped rather than
 * stored and ignored. The seed validates the
 * projection through the engine before writing it, so a fixture drift refuses
 * at seed time; this test is that same check, run in the suite.
 */
describe("the seeded demo taxonomy", () => {
  it("projects demo-dimensions.json to a taxonomy the engine's D1 rules accept", () => {
    const taxonomy = buildDemoTaxonomy(repoRoot());
    expect(Object.keys(taxonomy).sort()).toEqual(["dimensions", "id", "label", "schemaVersion"]);
    expect(taxonomy.id).toBe("demo-dimensions-v1");
    expect(taxonomy.dimensions.map((d) => d.id)).toContain("behavioralClasses");
    expect(
      validateDimensions({
        id: "probe",
        label: "taxonomy probe",
        asOf: "2026-03-31",
        coa: buildChartOfAccounts(),
        positions: [],
        taxonomy,
      }),
    ).toEqual([]);
  });
});

/**
 * Piece 2d at the front door: POST /api/portfolios/import?format=csv takes an
 * optional taxonomyId, resolves it against the store exactly as it resolves
 * coaId, and the stored book carries the taxonomy. The store has no route that
 * writes a taxonomy, so the test writes one with the file store the server
 * reads (every read is a fresh readFileSync). A file with no dim.<id> column is
 * accepted by spec Section 3.2, the book carrying the taxonomy and the positions
 * no bag; a file that does carry them lands the bag on the stored position.
 */
describe("CSV intake resolves a stored taxonomy through the route", () => {
  const HEADER =
    "position_id,family_id,coa_node_id,terms_type,label,notional,maturityMonths," +
    "originationOffsetMonths,amortType,side,coupon,indexTenorMonths,margin," +
    "resetFrequencyMonths,depositRate,beta";
  const ROW_ONE = "p1,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,";
  const ROW_TWO = "p2,loans,n-loans,fixed-loan,,2000000,36,0,level-pay,,0.04,,,,,";
  const BODY = [HEADER, ROW_ONE, ROW_TWO].join("\r\n");

  async function boot(): Promise<TestPlatform> {
    const platform = await bootTestPlatform();
    const store = new FileStore(platform.storeRoot);
    store.putDocument("coa", "test-coa", TEST_COA, { label: "intake test COA" });
    store.putDocument("taxonomy", "test-taxonomy", TEST_TAXONOMY, { label: "intake test taxonomy" });
    return platform;
  }

  it("stores an untagged CSV book with the taxonomy it named, bagless", async () => {
    const platform = await boot();
    try {
      const posted = await api(
        platform.base,
        "POST",
        "/api/portfolios/import?format=csv&coaId=test-coa&taxonomyId=test-taxonomy" +
          "&label=Tagged%20CSV%20book&portfolioId=csv-tagged&asOf=2026-03-31",
        BODY,
      );
      expect(posted.status).toBe(201);
      const stored = await api<PortfolioSpec>(platform.base, "GET", "/api/portfolios/csv-tagged");
      expect(stored.status).toBe(200);
      expect(stored.body.taxonomy?.id).toBe("test-taxonomy");
      expect(stored.body.taxonomy?.dimensions.map((d) => d.id)).toEqual([
        "vintage",
        "segment",
        "behavioralClasses",
      ]);
      expect(stored.body.positions).toHaveLength(2);
      expect(stored.body.positions.every((p) => p.dimensions === undefined)).toBe(true);
    } finally {
      await platform.close();
    }
  });

  it("refuses an unknown taxonomyId with the same shape as an unknown coaId", async () => {
    const platform = await boot();
    try {
      const posted = await api<{ error: { detail: Array<{ column?: string; message: string }> } }>(
        platform.base,
        "POST",
        "/api/portfolios/import?format=csv&coaId=test-coa&taxonomyId=no-such-taxonomy" +
          "&label=Tagged%20CSV%20book&portfolioId=csv-refused&asOf=2026-03-31",
        BODY,
      );
      expect(posted.status).toBe(422);
      expect(posted.body.error.detail[0].column).toBe("taxonomyId");
      expect(posted.body.error.detail[0].message).toContain(
        'no stored dimension taxonomy with id "no-such-taxonomy"',
      );
    } finally {
      await platform.close();
    }
  });

  it("stores a tagged CSV book with the bag its dim. columns carry", async () => {
    const platform = await boot();
    try {
      const body = [
        `${HEADER},dim.vintage,dim.segment,dim.behavioralClasses`,
        `${ROW_ONE},2019,relationship,decay | deposit-beta`,
        `${ROW_TWO},,,`,
      ].join("\r\n");
      const posted = await api(
        platform.base,
        "POST",
        "/api/portfolios/import?format=csv&coaId=test-coa&taxonomyId=test-taxonomy" +
          "&label=Tagged%20CSV%20book&portfolioId=csv-bagged&asOf=2026-03-31",
        body,
      );
      expect(posted.status).toBe(201);
      const stored = await api<PortfolioSpec>(platform.base, "GET", "/api/portfolios/csv-bagged");
      expect(stored.status).toBe(200);
      expect(stored.body.taxonomy?.id).toBe("test-taxonomy");
      expect(stored.body.positions[0].dimensions).toEqual({
        vintage: "2019",
        segment: "relationship",
        behavioralClasses: ["decay", "deposit-beta"],
      });
      expect(stored.body.positions[1].dimensions).toBeUndefined();
    } finally {
      await platform.close();
    }
  });
});
