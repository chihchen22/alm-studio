/**
 * W3-P9 catalog query-surface tests. The anchors, per the module mandate:
 *
 *  1. RECONCILIATION — SQL aggregates (count, total notional, weighted average
 *     rate and maturity) reconcile to an independent JS fold over the stored
 *     portfolio DOCUMENT within 1e-12 relative (counts exact), per family and
 *     in total. The fold reads the document, never the database.
 *  2. PAGINATION — a paginated full walk of a 2,500-position portfolio
 *     returns exactly 2,500 distinct rows, no duplicates, no gaps: the walked
 *     id set equals the document's id set exactly.
 *  3. LINEAGE — lineage for a known run names exactly the inputs its
 *     inputsHash was computed over: the four content-hash pins equal the file
 *     store's own metadata pins, and the run row carries the result's
 *     provenance.inputsHash verbatim.
 *  4. READ-ONLY — the catalog connection cannot write (PRAGMA query_only), on
 *     top of D1's schema triggers; absence is typed, never an empty success.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet, PortfolioSpec, RunRequest, Scenario } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { repoRoot } from "../../config";
import { FileStore, sha256Hex, writeFileAtomic } from "../../store/store";
import type { StoredRunRequest, RunStatus } from "../../jobs/types";
import { seedStore, SEED_IDS } from "../../../scripts/seed-store";
import { defaultDbPath, openPlatformDb } from "../database";
import { syncStoreToDb } from "../ingest";
import {
  Catalog,
  CatalogNotFoundError,
  CatalogUnavailableError,
  CatalogValidationError,
} from "../queries";

const FIXED_STAMP = "2026-08-02T00:00:00.000Z";
const WALK_BOOK_ID = "walk-2500-v1";
const WALK_POSITIONS = 2_500;
const RUN_ID = "run-20260802-000000-p9catalog";

let storeRoot: string;
let store: FileStore;
let catalog: Catalog;
let runResultInputsHash: string;

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

/** A literal 2,500-position book (the mandate's pagination-walk scale). */
function buildWalkBook(): Record<string, unknown> {
  const positions = [];
  for (let i = 0; i < WALK_POSITIONS; i++) {
    positions.push({
      id: `walk-${String(i).padStart(5, "0")}`,
      familyId: i % 3 === 0 ? "walk-a" : "walk-b",
      coaNodeId: i % 3 === 0 ? "assets.walk-a" : "assets.walk-b",
      terms: {
        type: "fixed-loan",
        notional: 100_000 + i,
        coupon: 0.03 + (i % 7) * 0.001,
        maturityMonths: 12 + (i % 60),
        amortType: i % 2 === 0 ? "bullet" : "level-payment",
      },
    });
  }
  return {
    id: WALK_BOOK_ID,
    label: "walk book",
    asOf: "2026-03-31",
    coa: {
      id: "walk-coa",
      families: [
        { id: "walk-a", side: "asset", label: "Walk A" },
        { id: "walk-b", side: "asset", label: "Walk B" },
      ],
    },
    positions,
  };
}

/** Compose the run request from the FILE store (the D1 test's proven shape). */
function composeFromFileStore(runId: string): { request: RunRequest; portfolio: PortfolioSpec } {
  const portfolioMeta = store.getMeta("portfolios", SEED_IDS.vanillaPortfolio);
  const market = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
  const slate = store.getDocument<SlateDoc>("scenario-slates", SEED_IDS.vanillaSlate).doc;
  const set = store.getDocument<AssumptionSet>("assumption-sets", SEED_IDS.vanillaAssumptions).doc;
  const portfolio = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.vanillaPortfolio).doc;
  const request: RunRequest = {
    runId,
    portfolioId: SEED_IDS.vanillaPortfolio,
    marketSnapshot: market,
    scenarios: slate.scenarios,
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: portfolioMeta.asOf as string },
    seed: "platform-0",
    timestamps: { startedAt: FIXED_STAMP, finishedAt: FIXED_STAMP },
  };
  return { request, portfolio };
}

/** Write a completed run into the file store the way the platform lays it out. */
function writeCompletedRun(runId: string): void {
  const { request, portfolio } = composeFromFileStore(runId);
  const stored: StoredRunRequest = {
    engineContext: { durationMode: "base-only", shards: "auto" },
    request,
    portfolioRef: {
      id: SEED_IDS.vanillaPortfolio,
      contentHash: store.getMeta("portfolios", SEED_IDS.vanillaPortfolio).contentHash,
    },
    submission: {
      portfolioId: SEED_IDS.vanillaPortfolio,
      marketId: SEED_IDS.market,
      scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
      scenarios: request.scenarios.map((s) => ({ id: s.id, label: s.label, rateSpec: s.rateSpec })),
    },
  };
  store.writeRunJson(runId, "request.json", stored);
  const result = buildRunResult(request, portfolio, {
    ...resolveDefaultContext(),
    durationMode: "base-only" as const,
    shards: "auto" as const,
  });
  runResultInputsHash = result.provenance.inputsHash;
  writeFileAtomic(join(storeRoot, "runs", runId, "result.json"), `${JSON.stringify(result)}\n`);
  const status: RunStatus = {
    runId,
    state: "done",
    phase: "done",
    submittedAt: FIXED_STAMP,
    startedAt: FIXED_STAMP,
    endedAt: FIXED_STAMP,
    elapsedMs: 1234,
    platformRequestHash: sha256Hex(store.readRunBytes(runId, "request.json")),
    summary: {
      portfolioId: SEED_IDS.vanillaPortfolio,
      marketId: SEED_IDS.market,
      scenarioSlateId: SEED_IDS.vanillaSlate,
      scenarioCount: request.scenarios.length,
    },
  };
  store.writeRunJson(runId, "status.json", status);
}

/** The scalar-rate convention D1's ingest documents (rateOf), re-derived
 * independently here from the DOCUMENT terms for the reconciliation fold. */
function docRateOf(terms: Record<string, unknown> & { type: string }): number | null {
  switch (terms.type) {
    case "fixed-loan":
      return terms.coupon as number;
    case "floating-loan":
      return terms.margin as number;
    case "mortgage":
      return terms.noteRate as number;
    case "nmd":
      return terms.depositRate as number;
    default:
      return null; // nmd-b (beta S-curve) and cd (cohort book): model-implied
  }
}

interface Fold {
  count: number;
  notional: number;
  rateNotional: number; // sum(rate * notional) over rate-bearing rows
  ratedNotional: number; // sum(notional) over rate-bearing rows
  maturityNotional: number; // sum(maturity * notional)
  remainingNotional: number; // sum((maturity + offset) * notional)
}

function foldPositions(positions: PortfolioSpec["positions"]): Map<string, Fold> {
  const out = new Map<string, Fold>();
  for (const p of positions) {
    const t = p.terms as unknown as Record<string, unknown> & {
      type: string;
      notional: number;
      maturityMonths: number;
      originationOffsetMonths?: number;
    };
    const f = out.get(p.familyId) ?? {
      count: 0,
      notional: 0,
      rateNotional: 0,
      ratedNotional: 0,
      maturityNotional: 0,
      remainingNotional: 0,
    };
    const rate = docRateOf(t);
    f.count += 1;
    f.notional += t.notional;
    if (rate !== null) {
      f.rateNotional += rate * t.notional;
      f.ratedNotional += t.notional;
    }
    f.maturityNotional += t.maturityMonths * t.notional;
    f.remainingNotional += (t.maturityMonths + (t.originationOffsetMonths ?? 0)) * t.notional;
    out.set(p.familyId, f);
  }
  return out;
}

function expectRel(actual: number | null, expected: number | null, label: string): void {
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  expect(actual, label).not.toBeNull();
  const scale = Math.max(Math.abs(expected), 1);
  expect(Math.abs((actual as number) - expected), label).toBeLessThanOrEqual(scale * 1e-12);
}

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-p9-queries-"));
  store = new FileStore(storeRoot);
  await seedStore(store, repoRoot()); // seeds AND mirrors into platform.db
  // Add the walk book and a completed run, then advance the mirror once more
  // (the catalog reads only what the mirror carries — same rule as boot).
  store.putDocument("portfolios", WALK_BOOK_ID, buildWalkBook(), {
    label: "walk book",
    asOf: "2026-03-31",
    positionCount: WALK_POSITIONS,
  });
  writeCompletedRun(RUN_ID);
  const db = openPlatformDb(defaultDbPath(storeRoot));
  try {
    syncStoreToDb(store, db);
  } finally {
    db.close();
  }
  catalog = Catalog.open(defaultDbPath(storeRoot));
}, 120_000);

afterAll(() => {
  try {
    catalog.close();
  } catch {
    // already closed
  }
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // Windows file locking (McAfee); the OS temp cleaner owns the leftovers.
  }
});

describe("aggregates reconcile to an independent document-side fold (anchor 1)", () => {
  it("per-family SQL aggregates equal the JS fold over the synthetic book within 1e-12", () => {
    const doc = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
    const fold = foldPositions(doc.positions);
    const t0 = performance.now();
    const groups = catalog.positionsAggregateGrouped(SEED_IDS.syntheticPortfolio, {}, "family");
    const queryMs = performance.now() - t0;
    expect(new Set(groups.map((g) => g.key))).toEqual(new Set(fold.keys()));
    for (const g of groups) {
      const e = fold.get(g.key as string)!;
      expect(g.positionCount, `${g.key} count`).toBe(e.count);
      expectRel(g.totalNotional, e.notional, `${g.key} notional`);
      expectRel(
        g.weightedAvgRate,
        e.ratedNotional > 0 ? e.rateNotional / e.ratedNotional : null,
        `${g.key} weightedAvgRate`,
      );
      expectRel(g.ratedNotional, e.ratedNotional > 0 ? e.ratedNotional : null, `${g.key} ratedNotional`);
      expectRel(
        g.weightedAvgMaturityMonths,
        e.notional !== 0 ? e.maturityNotional / e.notional : null,
        `${g.key} weightedAvgMaturityMonths`,
      );
      expectRel(
        g.weightedAvgRemainingMaturityMonths,
        e.notional !== 0 ? e.remainingNotional / e.notional : null,
        `${g.key} weightedAvgRemainingMaturityMonths`,
      );
    }
    console.log(
      `[W3-P9 timing] grouped aggregate over ${doc.positions.length} positions: ${queryMs.toFixed(2)} ms`,
    );
  });

  it("the ungrouped total aggregate equals the whole-book fold within 1e-12", () => {
    const doc = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
    const fold = foldPositions(doc.positions);
    let e: Fold = {
      count: 0,
      notional: 0,
      rateNotional: 0,
      ratedNotional: 0,
      maturityNotional: 0,
      remainingNotional: 0,
    };
    for (const f of fold.values()) {
      e = {
        count: e.count + f.count,
        notional: e.notional + f.notional,
        rateNotional: e.rateNotional + f.rateNotional,
        ratedNotional: e.ratedNotional + f.ratedNotional,
        maturityNotional: e.maturityNotional + f.maturityNotional,
        remainingNotional: e.remainingNotional + f.remainingNotional,
      };
    }
    const a = catalog.positionsAggregate(SEED_IDS.syntheticPortfolio, {});
    expect(a.positionCount).toBe(e.count);
    expectRel(a.totalNotional, e.notional, "total notional");
    expectRel(a.weightedAvgRate, e.rateNotional / e.ratedNotional, "total weightedAvgRate");
    expectRel(a.weightedAvgMaturityMonths, e.maturityNotional / e.notional, "total wam");
  });

  it("a filtered aggregate matches the fold restricted to the same filter", () => {
    const doc = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
    const familyId = doc.positions[0].familyId;
    const subset = doc.positions.filter((p) => p.familyId === familyId);
    const fold = foldPositions(subset).get(familyId)!;
    const a = catalog.positionsAggregate(SEED_IDS.syntheticPortfolio, { familyId });
    expect(a.positionCount).toBe(fold.count);
    expectRel(a.totalNotional, fold.notional, "filtered notional");
  });

  it("weightedAvgRate is NULL (never 0) when no position carries a scalar rate", () => {
    // The synthetic book's nmd-b family: rate is model-implied (beta S-curve).
    const doc = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
    const betaFamily = doc.positions.find(
      (p) => (p.terms as { type: string }).type === "nmd-b",
    )?.familyId;
    expect(betaFamily).toBeDefined();
    const a = catalog.positionsAggregate(SEED_IDS.syntheticPortfolio, {
      familyId: betaFamily!,
      instrumentType: "nmd-b",
    });
    expect(a.weightedAvgRate).toBeNull();
    expect(a.ratedNotional).toBeNull();
    expect(a.totalNotional).not.toBeNull();
  });
});

describe("pagination walk (anchor 2)", () => {
  it("a full walk of the 2,500-position book returns exactly 2,500 distinct rows, no gaps", () => {
    const doc = store.getDocument<{ positions: Array<{ id: string }> }>(
      "portfolios",
      WALK_BOOK_ID,
    ).doc;
    expect(doc.positions.length).toBe(WALK_POSITIONS);
    const seen = new Set<string>();
    let fetched = 0;
    let offset = 0;
    const limit = 137; // deliberately not a divisor of 2,500
    let total = -1;
    const t0 = performance.now();
    for (;;) {
      const page = catalog.positionsPage(WALK_BOOK_ID, {}, limit, offset);
      total = page.page.total;
      for (const row of page.positions) seen.add(row.positionId);
      fetched += page.positions.length;
      if (page.positions.length < limit) break;
      offset += limit;
    }
    const walkMs = performance.now() - t0;
    expect(total).toBe(WALK_POSITIONS);
    expect(fetched).toBe(WALK_POSITIONS); // no gaps: every page full until the last
    expect(seen.size).toBe(WALK_POSITIONS); // no duplicates
    expect(seen).toEqual(new Set(doc.positions.map((p) => p.id))); // exactly the document's rows
    console.log(
      `[W3-P9 timing] full paginated walk of ${WALK_POSITIONS} positions ` +
        `(${Math.ceil(WALK_POSITIONS / limit)} pages of ${limit}): ${walkMs.toFixed(1)} ms`,
    );
  });

  it("walks the seeded synthetic book to its exact mirrored row count", () => {
    const doc = store.getDocument<{ positions: Array<{ id: string }> }>(
      "portfolios",
      SEED_IDS.syntheticPortfolio,
    ).doc;
    const seen = new Set<string>();
    let offset = 0;
    for (;;) {
      const page = catalog.positionsPage(SEED_IDS.syntheticPortfolio, {}, 500, offset);
      for (const row of page.positions) seen.add(row.positionId);
      if (page.positions.length < 500) break;
      offset += 500;
    }
    expect(seen.size).toBe(doc.positions.length);
    expect(seen).toEqual(new Set(doc.positions.map((p) => p.id)));
  });

  it("refuses malformed pagination (typed, never clamped)", () => {
    expect(() => catalog.positionsPage(WALK_BOOK_ID, {}, 0, 0)).toThrow(CatalogValidationError);
    expect(() => catalog.positionsPage(WALK_BOOK_ID, {}, 5_001, 0)).toThrow(CatalogValidationError);
    expect(() => catalog.positionsPage(WALK_BOOK_ID, {}, 2.5, 0)).toThrow(CatalogValidationError);
    expect(() => catalog.positionsPage(WALK_BOOK_ID, {}, 100, -1)).toThrow(CatalogValidationError);
  });
});

describe("lineage and the complete run input set (anchor 3)", () => {
  it("runInputs names exactly the four consumed artifacts with the store's own pins", () => {
    const r = catalog.runInputs(RUN_ID);
    expect(r.state).toBe("done");
    expect(r.seed).toBe("platform-0");
    expect(r.grid).toEqual({ horizonMonths: 360, asOf: "2026-03-31" });
    expect(r.engineContext).toEqual({ durationMode: "base-only", shards: "auto" });
    // The pins: exactly {portfolio, market, scenario-slate, assumption-set}.
    expect(r.inputs.length).toBe(4);
    expect(new Set(r.inputs.map((i) => i.role))).toEqual(
      new Set(["portfolio", "market", "scenario-slate", "assumption-set"]),
    );
    for (const pin of r.inputs) {
      const meta = store.getMeta(pin.collection as "portfolios", pin.id);
      expect(pin.contentHash, `${pin.role} pin`).toBe(meta.contentHash);
    }
    // The run row carries the result's own provenance hash, verbatim.
    expect(r.engineInputsHash).toBe(runResultInputsHash);
    expect(r.platformRequestHash).toBe(sha256Hex(store.readRunBytes(RUN_ID, "request.json")));
    expect(r.resultContentHash).toBe(sha256Hex(store.readRunBytes(RUN_ID, "result.json")));
  });

  it("lineage of the consumed portfolio and market names the run; an unconsumed book is honestly empty", () => {
    const p = catalog.lineage("portfolios", SEED_IDS.vanillaPortfolio);
    expect(p.consumedBy.map((c) => c.runId)).toContain(RUN_ID);
    const hit = p.consumedBy.find((c) => c.runId === RUN_ID)!;
    expect(hit.role).toBe("portfolio");
    expect(hit.state).toBe("done");
    expect(hit.pinnedContentHash).toBe(
      store.getMeta("portfolios", SEED_IDS.vanillaPortfolio).contentHash,
    );
    const m = catalog.lineage("market", SEED_IDS.market);
    expect(m.consumedBy.map((c) => c.runId)).toContain(RUN_ID);
    // Mirrored but never consumed: exists, with an honest empty consumer list.
    const w = catalog.lineage("portfolios", WALK_BOOK_ID);
    expect(w.consumedBy).toEqual([]);
  });

  it("lineage refuses non-consumable collections and unmirrored documents, typed", () => {
    expect(() => catalog.lineage("coa", SEED_IDS.demoCoa)).toThrow(CatalogValidationError);
    expect(() => catalog.lineage("portfolios", "no-such-book")).toThrow(CatalogNotFoundError);
  });

  it("run listing carries the mirrored run with its hashes", () => {
    const runs = catalog.listRuns();
    const r = runs.find((x) => x.runId === RUN_ID);
    expect(r).toBeDefined();
    expect(r!.engineInputsHash).toBe(runResultInputsHash);
  });
});

describe("market read surface", () => {
  it("serves the snapshot's three curves and both vol surfaces with the as-of date", () => {
    const snap = catalog.marketSnapshot(SEED_IDS.market);
    const doc = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    expect(snap.asOf).toBe(doc.calibrationDate);
    expect(snap.curves["risk-free"].length).toBe(doc.curveQuotes.length);
    expect(snap.curves["term-funding"].length).toBe(doc.termFundingCurveQuotes.length);
    expect(snap.curves.tlp.length).toBe(doc.tlpNodes.length);
    expect(snap.capVolSurface.length).toBe(doc.capQuotes.length);
    expect(snap.swaptionVolSurface.length).toBe(doc.swaptionATMQuotes.length);
    // Verbatim values in source order (seq preserves the document ordering).
    expect(snap.curves["risk-free"][0].value).toBe(doc.curveQuotes[0].rate);
    expect(snap.curves.tlp[0].value).toBe(doc.tlpNodes[0].spread);
    expect(snap.capVolSurface[0].normalVol).toBe(doc.capQuotes[0].normalVol);
  });

  it("curve time series line up by as-of date and refuse unknown curve names", () => {
    const series = catalog.curveSeries("risk-free");
    expect(series.length).toBeGreaterThanOrEqual(1);
    const doc = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    const s = series.find((x) => x.marketId === SEED_IDS.market)!;
    expect(s.asOf).toBe(doc.calibrationDate);
    expect(s.points.length).toBe(doc.curveQuotes.length);
    expect(() => catalog.curveSeries("libor")).toThrow(CatalogValidationError);
  });
});

describe("typed absence and read-only enforcement (anchor 4)", () => {
  it("an unmirrored portfolio is a typed 404-class refusal naming the id", () => {
    expect(() => catalog.positionsPage("no-such-book", {}, 100, 0)).toThrow(CatalogNotFoundError);
    expect(() => catalog.positionsPage("no-such-book", {}, 100, 0)).toThrow(/no-such-book/);
    expect(() => catalog.positionsAggregate("no-such-book", {})).toThrow(CatalogNotFoundError);
    expect(() => catalog.marketSnapshot("no-such-market")).toThrow(CatalogNotFoundError);
    expect(() => catalog.runInputs("no-such-run")).toThrow(CatalogNotFoundError);
  });

  it("a filter value the portfolio never carried refuses by name instead of an empty page", () => {
    expect(() =>
      catalog.positionsPage(WALK_BOOK_ID, { familyId: "no-such-family" }, 100, 0),
    ).toThrow(CatalogNotFoundError);
    expect(() =>
      catalog.positionsAggregate(WALK_BOOK_ID, { instrumentType: "mortgage" }),
    ).toThrow(/instrumentType "mortgage"/);
    // Individually valid values whose intersection is empty: an HONEST empty page.
    const page = catalog.positionsPage(
      WALK_BOOK_ID,
      { familyId: "walk-a", coaNodeId: "assets.walk-b" },
      100,
      0,
    );
    expect(page.page.total).toBe(0);
    expect(page.positions).toEqual([]);
  });

  it("the catalog connection cannot write: PRAGMA query_only refuses all mutation", () => {
    expect(() =>
      catalog.db.exec("INSERT INTO meta (key, value) VALUES ('x', 'y')"),
    ).toThrow(/readonly|query_only|attempt to write/i);
    expect(() => catalog.db.exec("UPDATE positions SET notional = 0")).toThrow(
      /readonly|query_only|attempt to write|immutable/i,
    );
    expect(() => catalog.db.exec("DELETE FROM runs")).toThrow(
      /readonly|query_only|attempt to write|never deleted/i,
    );
    expect(() => catalog.db.exec("DROP TABLE positions")).toThrow(
      /readonly|query_only|attempt to write/i,
    );
  });

  it("opening a catalog over a store with no database refuses typed, naming the cure", () => {
    const empty = mkdtempSync(join(tmpdir(), "alm-p9-nodb-"));
    try {
      expect(() => Catalog.open(join(empty, "platform.db"))).toThrow(CatalogUnavailableError);
      expect(() => Catalog.open(join(empty, "platform.db"))).toThrow(/migrate-store/);
    } finally {
      try {
        rmSync(empty, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
