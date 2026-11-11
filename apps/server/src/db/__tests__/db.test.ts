/**
 * W3-D1 database layer tests. The anchors, per the module mandate:
 *
 *  1. BYTE PARITY: a run composed from DB-resolved inputs is byte-identical
 *     to the same run composed from the file store, and both reproduce the
 *     pinned vanilla golden effectiveDurationEquity 5.3663292287711295 (an
 *     oracle neither path can influence).
 *  2. IMMUTABILITY: schema triggers refuse UPDATE/DELETE on content rows and
 *     on a run's identity columns; divergence between store and DB refuses.
 *  3. RECONCILIATION: position rows summed by family in SQL equal an
 *     independent fold over the portfolio document, and side totals equal the
 *     store's intake metadata.
 *  4. PROVENANCE: an ingested run pins every referenced artifact by content
 *     hash and its stored request bytes round-trip exactly.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet, PortfolioSpec, RunRequest, Scenario } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { repoRoot } from "../../config";
import { FileStore, sha256Hex, writeFileAtomic } from "../../store/store";
import type { StoredRunRequest, RunStatus } from "../../jobs/types";
import { seedStore, SEED_IDS, type SeedReport } from "../../../scripts/seed-store";
import { defaultDbPath, openPlatformDb, PlatformDb } from "../database";
import { syncStoreToDb, StoreDivergenceError } from "../ingest";
import { composeRunInputsFromDb, readRunRequestBytes } from "../resolve";

// The vanilla base equity duration on curve default 2 (was 5.366960016565166); deltas Step 1
const PINNED_VANILLA_EQUITY_DURATION = 5.3663292287711295;
const FIXED_STAMP = "2026-08-02T00:00:00.000Z";

let storeRoot: string;
let store: FileStore;
let db: PlatformDb;
let seedReport: SeedReport;

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

/**
 * Compose the run request from the FILE store, field-for-field the way
 * routes/runs.ts composes a submission (the platform's proven path).
 */
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

/** The engine context exactly as runnerEntry builds it for platform defaults. */
function engineContext() {
  return { ...resolveDefaultContext(), durationMode: "base-only" as const, shards: "auto" as const };
}

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-db-test-"));
  store = new FileStore(storeRoot);
  seedReport = await seedStore(store, repoRoot());
  db = openPlatformDb(defaultDbPath(storeRoot));
});

afterAll(() => {
  try {
    db.close();
  } catch {
    // already closed by a test
  }
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // Windows file locking (McAfee); the OS temp cleaner owns the leftovers.
  }
});

describe("seed mirror", () => {
  it("seeding mirrors every store document into the database", () => {
    expect(seedReport.dbSync).toBeDefined();
    const d = seedReport.dbSync!;
    // 3 portfolios, 1 market, 4 assumption sets, 4 slates, 1 coa.
    // Re-expectation: was 8/8: the seed gained the ILLUSTRATIVE
    // stress assumption set + its slate so an overlay visibly moves a number
    // Re-expectation: was 10; the seed gained the hqla-tagged
    // synthetic book; its taxonomy is not a mirrored collection.
    // Re-expectation: was 11; the liquidity stress set + its slate.
    // Re-expectation: was 13; the lcr-tagged synthetic book; its taxonomy is not a mirrored collection.
    // Re-expectation: was 14; +3 for the commitment book, the joint
    // squeeze assumption set and its slate. The v2 taxonomy is not a mirrored
    // collection either, so it does not count here.
    // Re-expectation: was 17; +1 for synthetic-2500-hedged-v1. No new
    // assumption set, slate or mirrored taxonomy.
    // Re-expectation: was 18; +2 for the loan repricing assumption
    // set and its slate. The plan is not a mirrored collection.
    // Re-expectation: was 20; +2 for the derived decay shock
    // assumption set and its slate.
    // Re-expectation: was 22; +1 for the liability book (a
    // mirrored portfolio). The run plan is not a mirrored collection.
    // Re-expectation: was 23; +1 for the tlp-shock-demo-v1
    // derived market (market is a mirrored collection).
    // Re-expectation: was 24; +2 for the rate-indices-demo-v1
    // market and the synthetic-2500-indexed-v1 book (both mirrored collections).
    // The indexed run plan is not a mirrored collection.
    // Re-expectation: was 26; +1 for the vol-shock-demo-v1 derived market
    // (market is a mirrored collection).
    // Re-expectation: was 27; +1 for the macro-demo-v1 derived market (market is mirrored).
    // Re-expectation (Studio Piece 7b slice 4): was 28; +2 for the two housing assumption sets (run plans are not mirrored).
    // Re-expectation: was 30; +1 for the example bank's chart of accounts, coa/mid-size-bank-coa-v1 (the v2 CSV template's chart; coa is a mirrored collection).
    // Re-expectation: was 31; +2 for the example bank's two feature demo sets (run setups are not mirrored).
    // Re-expectation: was 33; +5 for the deposit desk's five sets (run setups are not mirrored).
    expect(d.documentsIngested.length).toBe(38);
    // 2,351 synthetic (the cds family's 150 draws fold into ONE
    // cohort-book position, so 2,500 draws emit 2,351 positions) + 9 vanilla.
    // It was >= 2_509 before the cds draws folded into one position.
    expect(d.positionsInserted).toBeGreaterThanOrEqual(2_360);
    expect(d.curvePointsInserted).toBeGreaterThan(0);
    expect(d.capVolPointsInserted).toBeGreaterThan(0);
    expect(d.swaptionVolPointsInserted).toBeGreaterThan(0);
    // Re-expectation: was 10: three slates x the 5-scenario grid now
    // that the ILLUSTRATIVE stress slate is seeded.
    // Re-expectation: was 15; plus the 3-scenario liquidity slate.
    // Re-expectation: was 18; plus the 3-scenario squeeze slate.
    // Re-expectation: was 21; plus the 5-scenario loan repricing slate.
    // Re-expectation: was 26; plus the 5-scenario decay shock slate.
    expect(d.scenariosInserted).toBe(31);
    // Log the measured ingest time for the module report (scale honesty).
    console.log(
      `[W3-D1 timing] full store mirror: ${d.elapsedMs} ms for ${d.positionsInserted} positions, ` +
        `${d.curvePointsInserted} curve points, ${d.capVolPointsInserted + d.swaptionVolPointsInserted} vol points`,
    );
  });

  it("every documents row carries the file store's exact content hash", () => {
    for (const collection of ["portfolios", "market", "assumption-sets", "scenario-slates", "coa"] as const) {
      for (const meta of store.listMeta(collection)) {
        const row = db.db
          .prepare("SELECT content_hash, body FROM documents WHERE collection = ? AND id = ?")
          .get(collection, meta.id) as { content_hash: string; body: Uint8Array } | undefined;
        expect(row, `${collection}/${meta.id} missing from db`).toBeDefined();
        expect(row!.content_hash).toBe(meta.contentHash);
        // Round-trip: the stored bytes re-hash to the same pin.
        expect(sha256Hex(row!.body)).toBe(meta.contentHash);
      }
    }
  });

  it("a second sync is a no-op (idempotent by content hash)", () => {
    const second = syncStoreToDb(store, db);
    expect(second.documentsIngested).toEqual([]);
    // Re-expectation: was 8: same two seed documents as above.
    // Re-expectation: was 10; the hqla-tagged book, as above.
    // Re-expectation: was 11; the liquidity set + slate, as above.
    // Re-expectation: was 13; the lcr-tagged book, as above.
    // Re-expectation: was 14; the commitment book, the squeeze set
    // and its slate, as above.
    // Re-expectation: was 17; the hedged book, as above.
    // Re-expectation: was 18; the loan repricing set and slate, as above.
    // Re-expectation: was 20; the decay shock set and slate, as above.
    // Re-expectation: was 22; the liability book, as above.
    // Re-expectation: was 23; the derived market, as above.
    // Re-expectation: was 24; the indices market and the indexed book, as above.
    // Re-expectation: was 26; the vol-shock-demo-v1 derived market, as above.
    // Re-expectation: was 27; the macro-demo-v1 derived market, as above.
    // Re-expectation (Studio Piece 7b slice 4): was 28; the two housing sets, as above.
    // Re-expectation: was 30; +1 for the example bank's chart of accounts, coa/mid-size-bank-coa-v1 (the v2 CSV template's chart; coa is a mirrored collection).
    // Re-expectation: was 31; +2 for the two feature demo sets.
    // Re-expectation: was 33; +5 for the deposit desk's five sets.
    expect(second.documentsSkipped).toBe(38);
    expect(second.positionsInserted).toBe(0);
  });
});

describe("byte parity (the anchor)", () => {
  it("a run from DB-resolved inputs is byte-identical to the file-store run and hits the pinned golden", () => {
    const runId = "parity-run-1";
    const fileSide = composeFromFileStore(runId);
    const dbSide = composeRunInputsFromDb(db, {
      runId,
      portfolioId: SEED_IDS.vanillaPortfolio,
      marketId: SEED_IDS.market,
      scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
      gridHorizonMonths: 360,
      seed: "platform-0",
      engineContext: { durationMode: "base-only", shards: "auto" },
    });
    // Timestamps are caller-injected; fix them identically on both sides.
    dbSide.request.timestamps = { startedAt: FIXED_STAMP, finishedAt: FIXED_STAMP };

    // The composed requests must already agree byte-for-byte.
    const reqA = Buffer.from(JSON.stringify(fileSide.request), "utf8");
    const reqB = Buffer.from(JSON.stringify(dbSide.request), "utf8");
    expect(Buffer.compare(reqA, reqB)).toBe(0);

    // And the pins must match the file store's own metadata.
    const portfolioMeta = store.getMeta("portfolios", SEED_IDS.vanillaPortfolio);
    const pin = dbSide.pins.find((p) => p.role === "portfolio")!;
    expect(pin.contentHash).toBe(portfolioMeta.contentHash);

    // Execute both. Same engine, but the INPUTS came from two different stores.
    const t0 = performance.now();
    const resultFile = buildRunResult(fileSide.request, fileSide.portfolio, engineContext());
    const resultDb = buildRunResult(dbSide.request, dbSide.portfolio, engineContext());
    const ms = Math.round(performance.now() - t0);

    const bytesFile = Buffer.from(JSON.stringify(resultFile), "utf8");
    const bytesDb = Buffer.from(JSON.stringify(resultDb), "utf8");
    expect(Buffer.compare(bytesFile, bytesDb)).toBe(0);
    console.log(
      `[W3-D1 parity] result ${bytesFile.length} bytes, sha256 ${sha256Hex(bytesFile).slice(0, 16)}..., ` +
        `two vanilla runs in ${ms} ms`,
    );

    // Independent oracle: the pinned vanilla golden, exact to the last digit.
    // In base-only duration mode exactly one scenario (base) carries it.
    const withDuration = resultDb.eve.byScenario.filter((s) => s.effectiveDurationEquity !== undefined);
    expect(withDuration.length).toBe(1); // base-only duration mode
    expect(withDuration[0].effectiveDurationEquity).toBe(PINNED_VANILLA_EQUITY_DURATION);
  });
});

describe("immutability (schema-enforced)", () => {
  it("refuses UPDATE and DELETE on documents", () => {
    expect(() => db.db.exec("UPDATE documents SET meta_json = '{}'")).toThrow(/immutable/);
    expect(() => db.db.exec("DELETE FROM documents")).toThrow(/never deleted/);
  });

  it("refuses UPDATE and DELETE on positions and curve points", () => {
    expect(() => db.db.exec("UPDATE positions SET notional = notional * 2")).toThrow(/immutable/);
    expect(() => db.db.exec("DELETE FROM positions")).toThrow(/never deleted/);
    expect(() => db.db.exec("UPDATE curve_points SET value = 0")).toThrow(/immutable/);
    expect(() => db.db.exec("DELETE FROM curve_points")).toThrow(/never deleted/);
  });

  it("refuses re-ingesting a document whose bytes changed under its id", () => {
    // Simulate append-only corruption in a scratch store: same id, new bytes.
    const scratch = mkdtempSync(join(tmpdir(), "alm-db-div-"));
    const s2 = new FileStore(scratch);
    s2.init();
    s2.putDocument("coa", "c1", { families: [] }, {});
    const db2 = openPlatformDb(join(scratch, "d.db"));
    try {
      syncStoreToDb(s2, db2);
      // Overwrite the stored file out-of-band (the store itself refuses).
      const path = s2.paths.documentPath("coa", "c1");
      writeFileSync(path, `${JSON.stringify({ families: ["tampered"] })}\n`);
      const meta = s2.getMeta("coa", "c1");
      const metaPath = s2.paths.metaPath("coa", "c1");
      writeFileSync(
        metaPath,
        `${JSON.stringify({ ...meta, contentHash: sha256Hex(`${JSON.stringify({ families: ["tampered"] })}\n`) })}\n`,
      );
      expect(() => syncStoreToDb(s2, db2)).toThrow(StoreDivergenceError);
    } finally {
      db2.close();
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});

describe("runs: complete input set, pins, reconstruction", () => {
  const runId = "run-20260802-000000-001abcd";

  it("ingests a completed run with content-hash pins over every input", () => {
    const { request, portfolio } = composeFromFileStore(runId);
    void portfolio;
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
    const result = buildRunResult(request, composeFromFileStore(runId).portfolio, engineContext());
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

    const report = syncStoreToDb(store, db);
    expect(report.runsIngested).toEqual([runId]);

    const row = db.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown>;
    expect(row.state).toBe("done");
    expect(row.platform_request_hash).toBe(sha256Hex(store.readRunBytes(runId, "request.json")));
    expect(row.result_content_hash).toBe(sha256Hex(store.readRunBytes(runId, "result.json")));
    expect(row.engine_inputs_hash).toBe(result.provenance.inputsHash);
    expect(row.result_ref).toBe(`runs/${runId}/result.json`);

    // Pins: portfolio from the submission-time pin; the rest against documents.
    const pins = db.db
      .prepare("SELECT role, collection, doc_id, content_hash FROM run_inputs WHERE run_id = ? ORDER BY role, ord")
      .all(runId) as Array<{ role: string; collection: string; doc_id: string; content_hash: string }>;
    expect(pins.length).toBe(4);
    for (const p of pins) {
      const meta = store.getMeta(p.collection as "portfolios", p.doc_id);
      expect(p.content_hash, `${p.role} pin`).toBe(meta.contentHash);
    }
  });

  it("round-trips the stored request bytes exactly and freezes run identity", () => {
    const fromDb = Buffer.from(readRunRequestBytes(db, runId));
    const fromFile = store.readRunBytes(runId, "request.json");
    expect(Buffer.compare(fromDb, fromFile)).toBe(0);

    expect(() => db.db.exec(`UPDATE runs SET request_body = x'00' WHERE run_id = '${runId}'`)).toThrow(
      /identity/,
    );
    expect(() => db.db.exec(`DELETE FROM runs WHERE run_id = '${runId}'`)).toThrow(/never deleted/);
    // Lifecycle columns remain movable (state transitions on later syncs).
    db.db.exec(`UPDATE runs SET phase = 'done' WHERE run_id = '${runId}'`);
  });
});

describe("position-level queryability", () => {
  it("SQL family aggregates reconcile to an independent fold over the document", () => {
    const doc = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
    const expected = new Map<string, { notional: number; count: number }>();
    for (const p of doc.positions) {
      const e = expected.get(p.familyId) ?? { notional: 0, count: 0 };
      e.notional += p.terms.notional;
      e.count += 1;
      expected.set(p.familyId, e);
    }
    const t0 = performance.now();
    const rows = db.db
      .prepare(
        `SELECT family_id, SUM(notional) AS notional, COUNT(*) AS n
         FROM positions WHERE portfolio_id = ? GROUP BY family_id`,
      )
      .all(SEED_IDS.syntheticPortfolio) as Array<{ family_id: string; notional: number; n: number }>;
    const queryMs = performance.now() - t0;
    expect(rows.length).toBe(expected.size);
    let total = 0;
    for (const r of rows) {
      const e = expected.get(r.family_id);
      expect(e, r.family_id).toBeDefined();
      expect(r.n).toBe(e!.count);
      // Same summation order (insert order within family), so exact equality is
      // expected; tolerate one ulp of reassociation defensively.
      expect(Math.abs(r.notional - e!.notional)).toBeLessThanOrEqual(Math.abs(e!.notional) * 1e-12);
      total += r.notional;
    }
    // Side totals reconcile to the intake metadata the seed recorded.
    const meta = store.getMeta("portfolios", SEED_IDS.syntheticPortfolio);
    const intake = meta.intake as { assets: number; liabilities: number };
    const sides = db.db
      .prepare(
        `SELECT side, SUM(notional) AS notional FROM positions WHERE portfolio_id = ? GROUP BY side`,
      )
      .all(SEED_IDS.syntheticPortfolio) as Array<{ side: string; notional: number }>;
    const bySide = new Map(sides.map((s) => [s.side, s.notional]));
    expect(Math.abs(bySide.get("asset")! - intake.assets)).toBeLessThanOrEqual(intake.assets * 1e-12);
    expect(Math.abs(bySide.get("liability")! - intake.liabilities)).toBeLessThanOrEqual(
      intake.liabilities * 1e-12,
    );
    expect(total).toBeGreaterThan(0);
    console.log(
      `[W3-D1 timing] grouped aggregate over ${doc.positions.length} positions: ${queryMs.toFixed(2)} ms`,
    );
  });

  it("rate columns are populated per instrument type, never fabricated", () => {
    const kinds = db.db
      .prepare(
        `SELECT instrument_type, rate_kind, COUNT(*) AS n, SUM(rate IS NULL) AS nulls
         FROM positions GROUP BY instrument_type, rate_kind`,
      )
      .all() as Array<{ instrument_type: string; rate_kind: string; n: number; nulls: number }>;
    for (const k of kinds) {
      if (k.instrument_type === "nmd-b") {
        expect(k.rate_kind).toBe("beta-s-curve");
        expect(k.nulls).toBe(k.n); // model-implied: honestly NULL
      } else if (k.instrument_type === "cd") {
        // W3-A2b cohort-book arm: per-cohort contract rates live in
        // terms_json; the scalar rate column is honestly NULL with a named
        // kind, same convention as nmd-b.
        expect(k.rate_kind).toBe("cohort-book");
        expect(k.nulls).toBe(k.n);
      } else if (k.instrument_type === "commitment") {
        // An undrawn committed line carries no rate at all (it is
        // optional capacity, not a funded balance), so the rate column is
        // honestly NULL under a named kind, as for nmd-b and cd.
        expect(k.rate_kind).toBe("undrawn-line");
        expect(k.nulls).toBe(k.n);
      } else if (k.instrument_type === "swap") {
        // A swap's one scalar rate is its fixed leg's coupon.
        expect(k.rate_kind).toBe("swap-fixed-rate");
        expect(k.nulls).toBe(0);
      } else {
        expect(k.rate_kind).not.toMatch(/^unrecognized:/);
        expect(k.nulls).toBe(0);
      }
    }
    // The commitment branch above proves nothing if no commitment row exists.
    expect(kinds.some((k) => k.instrument_type === "commitment")).toBe(true);
    expect(kinds.some((k) => k.instrument_type === "swap")).toBe(true);
  });
});
