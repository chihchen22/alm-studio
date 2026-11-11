/**
 * The seed writes the joint squeeze, which is a v2 taxonomy carrying the six
 * committed-facility categories, a `commit` family on its own off-balance-sheet
 * COA node, a book with commitment positions spread across the categories, the
 * squeeze assumption set whose deposit legs are copied verbatim from
 * `liquidity-stress-demo-v1`, and a static slate so wholesale funding does not
 * roll.
 *
 * The book carries ONE commitment family per run-off category, and this file
 * pins that: `commitmentRates` in report/lcr.ts rates a FAMILY and refuses the
 * whole metric when a family's positions carry more than one category. The
 * first cut of this seed put all six categories on one `commit` family, and
 * `computeLcrRegulatory` returned an empty value bag for every key, HQLA
 * included, in every scenario. The last test here is the one whose absence let
 * that ship.
 *
 * Harness note: `seed-store.ts` exports no `seedDocuments()`. This file follows
 * the pattern `seedLcr.test.ts` already uses (temp dir, FileStore, seedStore,
 * read the documents back), and the `docs`/`byId` accessors of the plan are
 * replaced by store reads. The ASSERTIONS are the plan's, unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet, DimensionTaxonomy, PortfolioSpec, Scenario } from "@alm/engine";
import { computeLcrRegulatory } from "@alm/engine/src/report/lcr";
import type { CustomMetricInput } from "@alm/engine/src/plugins/services";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { defaultDbPath, openPlatformDb, type PlatformDb } from "../db/database";

let storeRoot: string;
let store: FileStore;

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-seed-commit-"));
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

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

const SIX_CATEGORIES = [
  "facility-retail",
  "credit-nonfinancial",
  "liquidity-nonfinancial",
  "facility-depository",
  "credit-financial",
  "liquidity-financial",
];

/**
 * The commitment families of a book, found by INSTRUMENT TYPE rather than by a
 * literal family id. `commitmentRates` in report/lcr.ts selects them the same
 * way, so this reader cannot go looking at a different set than the metric does.
 */
const commitmentFamilies = (bk: PortfolioSpec) =>
  bk.coa.families.filter((f) => f.instrumentType === "commitment");

const commitmentPositions = (bk: PortfolioSpec) =>
  bk.positions.filter((p) => p.terms.type === "commitment");

const taxonomy = (id: string) => store.getDocument<DimensionTaxonomy>("taxonomy", id).doc;
const portfolio = (id: string) => store.getDocument<PortfolioSpec>("portfolios", id).doc;
const assumptionSet = (id: string) => store.getDocument<AssumptionSet>("assumption-sets", id).doc;
const slate = (id: string) => store.getDocument<SlateDoc>("scenario-slates", id).doc;

describe("piece 7 seed", () => {
  it("adds liquidity-tags-v2 with the six commitment categories", () => {
    const tax = taxonomy("liquidity-tags-v2");
    const dim = tax.dimensions.find((d) => d.id === "commitment-category")!;
    expect(new Set(dim.values)).toEqual(
      new Set([
        "facility-retail",
        "credit-nonfinancial",
        "liquidity-nonfinancial",
        "facility-depository",
        "credit-financial",
        "liquidity-financial",
      ]),
    );
  });

  it("leaves liquidity-tags-v1 byte-for-byte unchanged", () => {
    const v1 = taxonomy("liquidity-tags-v1");
    expect(v1.dimensions.map((d) => d.id)).toEqual(["hqla-level", "lcr-category"]);
  });

  it("seeds commit families that are asset-side and declare draw-utilization", () => {
    const bk = portfolio("synthetic-2500-commit-v1");
    const fams = commitmentFamilies(bk);
    expect(fams.length).toBeGreaterThan(0);
    for (const fam of fams) {
      expect(fam.side, fam.id).toBe("asset");
      expect(fam.instrumentType, fam.id).toBe("commitment");
      expect(fam.behavioralClasses, fam.id).toContain("draw-utilization");
    }
  });

  it("tags commitments across all six categories, one per family, including both extremes", () => {
    const bk = portfolio("synthetic-2500-commit-v1");
    const cats = new Set(
      commitmentPositions(bk).map((p) => p.dimensions?.["commitment-category"]),
    );
    expect(cats.size).toBeGreaterThanOrEqual(4);
    expect(cats.has("credit-nonfinancial")).toBe(true);
    expect(cats.has("liquidity-financial")).toBe(true);
    // Stronger than the plan asked for, and the reason the metric works at all:
    // all six buckets present, and each commitment FAMILY carries exactly one
    // of them. A family holding two categories makes `commitmentRates` refuse
    // and `computeLcrRegulatory` return an empty bag for every key.
    expect(cats).toEqual(new Set(SIX_CATEGORIES));
    const byFamily = new Map<string, Set<unknown>>();
    for (const p of commitmentPositions(bk)) {
      const s = byFamily.get(p.familyId) ?? new Set();
      s.add(p.dimensions?.["commitment-category"]);
      byFamily.set(p.familyId, s);
    }
    expect(byFamily.size).toBe(SIX_CATEGORIES.length);
    for (const [familyId, s] of byFamily) expect(s.size, familyId).toBe(1);
  });

  it("every seeded commitment position starts with an empty draw path", () => {
    const bk = portfolio("synthetic-2500-commit-v1");
    for (const p of commitmentPositions(bk)) {
      expect((p.terms as { draw?: unknown }).draw).toEqual({ rampRates: [], steadyRate: 0 });
    }
  });

  /**
   * The check whose absence let the defect ship. The seeded book carries the
   * metric the whole piece exists to compute, and the number is stated as a
   * literal derived by hand from the seeded notionals and the published
   * 249.32(e)(1) rates, never read back out of the code under test:
   *
   *   0.05 x  60,000,000 =   3,000,000   facility-retail
   *   0.10 x 250,000,000 =  25,000,000   credit-nonfinancial
   *   0.30 x  80,000,000 =  24,000,000   liquidity-nonfinancial
   *   0.50 x  40,000,000 =  20,000,000   facility-depository
   *   0.40 x 100,000,000 =  40,000,000   credit-financial
   *   1.00 x  20,000,000 =  20,000,000   liquidity-financial
   *                        -----------
   *                        132,000,000
   *
   * Flows are zero-filled on purpose. The REGULATORY commitment arm reads the
   * BOOK and never the flows (lcr.ts commitmentOutflow says so, and that is why
   * the figure is scenario-invariant), so zero flows cannot manufacture this
   * number; the three scenarios agreeing is the evidence.
   */
  it("produces the regulatory commitment outflow on the seeded book, 132,000,000", () => {
    const bk = portfolio("synthetic-2500-commit-v1");
    const horizonMonths = 12;
    const zeros = () => new Array<number>(horizonMonths + 1).fill(0);
    const byFamily = bk.coa.families.map((f) => ({
      familyId: f.id,
      series: { principal: zeros(), interest: zeros(), balance: zeros() },
    }));
    const input = {
      horizonMonths,
      baseScenarioId: "SQZ-S0",
      scenarios: ["SQZ-S0", "SQZ-S200", "SQZ-S-200"].map((scenarioId) => ({
        scenarioId,
        assumptionSetId: "liquidity-squeeze-demo-v1",
        cashflows: { byFamily } as never,
      })),
      book: bk as never,
    } as unknown as CustomMetricInput;

    const rows = computeLcrRegulatory(input).byScenario;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // The empty bag is exactly what the defect produced, so say so directly.
      expect(Object.keys(row.values).length, `${row.scenarioId} returned no keys`).toBeGreaterThan(0);
      expect(row.values["commitment-draws"], row.scenarioId).toBe(132_000_000);
    }
  });

  it("the squeeze set carries all three legs, deposits copied verbatim from v1", () => {
    const sq = assumptionSet("liquidity-squeeze-demo-v1");
    const v1 = assumptionSet("liquidity-stress-demo-v1");
    const bk = portfolio("synthetic-2500-commit-v1");
    // One commitment binding per commitment family, since the book carries one
    // family per run-off category. The deposit legs are unchanged.
    const commitFamilyIds = commitmentFamilies(bk).map((f) => f.id);
    expect(sq.bindings.map((b) => b.familyId).sort()).toEqual(
      [...commitFamilyIds, "dda", "mma"].sort(),
    );
    for (const fam of ["dda", "mma"]) {
      const a = sq.bindings.find((b) => b.familyId === fam);
      const b = v1.bindings.find((x) => x.familyId === fam);
      expect(a).toEqual(b);
    }
  });

  it("every commit binding carries the evidence-anchored ramp, identically", () => {
    const sq = assumptionSet("liquidity-squeeze-demo-v1");
    const bk = portfolio("synthetic-2500-commit-v1");
    const commitFamilyIds = commitmentFamilies(bk).map((f) => f.id);
    expect(commitFamilyIds.length).toBe(SIX_CATEGORIES.length);
    for (const familyId of commitFamilyIds) {
      const b = sq.bindings.find((x) => x.familyId === familyId)!;
      expect(b.overlay, familyId).toEqual({
        kind: "commitment-draw",
        rampRates: [0.35, 0.15, 0.1],
        steadyRate: 0.02,
      });
      expect(b.modelVersion, familyId).toBe("engine-commitment-draw-1");
    }
  });

  it("the squeeze label says ILLUSTRATIVE and NOT calibrated", () => {
    const sq = assumptionSet("liquidity-squeeze-demo-v1");
    expect(sq.label).toContain("ILLUSTRATIVE");
    expect(sq.label).toContain("NOT calibrated");
  });

  it("the squeeze slate runs static, the third leg: wholesale does not roll", () => {
    const sl = slate("liquidity-grid-squeeze");
    expect(sl.scenarios.map((s) => s.id)).toEqual(["SQZ-S0", "SQZ-S200", "SQZ-S-200"]);
    for (const s of sl.scenarios) {
      expect(s.assumptionSetId).toBe("liquidity-squeeze-demo-v1");
      expect(s.newBusiness).toEqual({ mode: "static", rules: [] });
    }
  });

  it("leaves liquidity-stress-demo-v1 and liquidity-grid-stress untouched", () => {
    expect(assumptionSet("liquidity-stress-demo-v1").bindings).toHaveLength(2);
    expect(slate("liquidity-grid-stress").scenarios.map((s) => s.id)).toEqual([
      "LIQ-S0",
      "LIQ-S200",
      "LIQ-S-200",
    ]);
  });

  it("is idempotent: a second seed writes nothing new", async () => {
    const second = await seedStore(store, repoRoot());
    expect(second.written).toEqual([]);
  });
});

/**
 * Task 8a, the DB mirror plane. The seed's intake metadata excludes an undrawn
 * line from `assets` and reports it on its own `commitmentsUndrawn` line. The
 * SQL mirror wrote `side` from the family, which is "asset" for the commit
 * family, so `SUM(notional) GROUP BY side` disagreed with that book's own
 * metadata by the whole undrawn book. The two planes must agree.
 */
describe("piece 7: the SQL mirror and the intake metadata agree", () => {
  let db: PlatformDb;

  beforeAll(() => {
    db = openPlatformDb(defaultDbPath(storeRoot));
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  function sidesFor(portfolioId: string): Map<string, number> {
    const rows = db.db
      .prepare(
        `SELECT side, SUM(notional) AS notional FROM positions WHERE portfolio_id = ? GROUP BY side`,
      )
      .all(portfolioId) as Array<{ side: string; notional: number }>;
    return new Map(rows.map((r) => [r.side, r.notional]));
  }

  it("the SQL asset bucket equals the commitment book's intake.assets", () => {
    const meta = store.getMeta("portfolios", "synthetic-2500-commit-v1");
    const intake = meta.intake as { assets: number; liabilities: number; commitmentsUndrawn: number };
    const bySide = sidesFor("synthetic-2500-commit-v1");
    expect(Math.abs(bySide.get("asset")! - intake.assets)).toBeLessThanOrEqual(intake.assets * 1e-12);
    expect(Math.abs(bySide.get("liability")! - intake.liabilities)).toBeLessThanOrEqual(
      intake.liabilities * 1e-12,
    );
  });

  it("undrawn lines mirror under their own side, equal to intake.commitmentsUndrawn", () => {
    const meta = store.getMeta("portfolios", "synthetic-2500-commit-v1");
    const intake = meta.intake as { commitmentsUndrawn: number };
    const bySide = sidesFor("synthetic-2500-commit-v1");
    expect(intake.commitmentsUndrawn).toBeGreaterThan(0);
    expect(Math.abs(bySide.get("off-balance-sheet")! - intake.commitmentsUndrawn)).toBeLessThanOrEqual(
      intake.commitmentsUndrawn * 1e-12,
    );
  });

  it("the rows are still PRESENT and queryable, not excluded from the mirror", () => {
    const n = db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM positions WHERE portfolio_id = ? AND instrument_type = 'commitment'`,
      )
      .get("synthetic-2500-commit-v1") as { n: number };
    expect(n.n).toBeGreaterThan(0);
  });

  it("a commitment-free book carries no off-balance-sheet row at all", () => {
    expect(sidesFor("synthetic-2500-lcr-v1").has("off-balance-sheet")).toBe(false);
  });
});
