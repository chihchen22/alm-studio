// apps/server/src/__tests__/importMirrorSync.test.ts
// Studio blank-path round, Task 3 (D1 server): a positions or market import syncs its OWN document into the
// SQLite mirror at once, so the catalog and lineage reads answer 200 for it without a reboot (ruling:
// sync after each import, no read fallback). The catalog's lazy read connection is opened BEFORE each import,
// so a 200 afterwards also proves a row committed by another connection is visible to it under WAL. Expected
// values are restated by hand: the CSV below carries exactly two positions, p1 and p2.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { defaultDbPath, openPlatformDb } from "../db/database";
import { syncDocumentToDb } from "../db/ingest";
import { mirrorBestEffort } from "../http/router";
import { TEST_COA } from "../intake/__tests__/fixtures";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  const store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot()); // seeds AND mirrors at boot, as the platform does
  store.putDocument("coa", "mirror-coa", TEST_COA, { label: "mirror test COA" });
}, 300_000);
afterAll(() => t.close());
afterEach(() => vi.restoreAllMocks());

const CSV = [
  "position_id,family_id,coa_node_id,terms_type,label,notional,maturityMonths,originationOffsetMonths,amortType,side,coupon,indexTenorMonths,margin,resetFrequencyMonths,depositRate,beta",
  "p1,loans,n-loans,fixed-loan,,1000000,60,0,level-pay,,0.05,,,,,",
  "p2,loans,n-loans,fixed-loan,,2000000,36,0,level-pay,,0.045,,,,,",
].join("\r\n");
const csvQuery = (portfolioId: string, extra = "") =>
  `/api/portfolios/import?format=csv&coaId=mirror-coa&label=mirror%20csv&portfolioId=${portfolioId}&asOf=2026-03-31${extra}`;

function workbook(): Uint8Array {
  const sheets: Record<string, (string | number)[][]> = {
    SOFR_OIS_Curve: [["Term", "InstType", "Mid"], ["1 D", "CASH", 0.04], ["1 MO", "CASH", 0.041], ["1 YR", "SWAP", 0.042], ["5 YR", "SWAP", 0.043]],
    FHLB_Curve: [["Term", "Mid"], ["1 D", 0.04], ["1 MO", 0.044], ["1 YR", 0.0455], ["5 YR", 0.047]],
    Cap_Volatility: [["Synthetic cap vol surface"], ["Expiry", "1.00%", "ATM"], ["1 YR", 0.008, 0.0085], ["5 YR", 0.0082, 0.0087]],
    ATM_Swaption_Volatility: [["Synthetic ATM swaption vols"], ["Expiry", "1 YR", "5 YR"], ["1 YR", 0.007, 0.0075], ["5 YR", 0.0072, 0.0077]],
  };
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
const importWorkbook = (query: string, filename: string) =>
  api(t.base, "POST", `/api/market/import-workbook?${query}`, workbook(), { "x-filename": filename });

/** Open the Catalog's lazy read connection BEFORE the import, so a later 200 proves WAL visibility. */
async function warmCatalog(): Promise<void> {
  expect((await api(t.base, "GET", "/api/catalog/portfolios")).status).toBe(200);
}

type CatalogPositions = { page: { total: number; returned: number }; positions: Array<{ positionId: string }> };

describe("a positions import is mirrored at once", () => {
  it("a plain CSV import answers 200 on the catalog positions and lineage reads with no re-sync", async () => {
    await warmCatalog();
    // Before the import the id is unmirrored: the typed 404 is unchanged for an id never imported.
    const missing = await api<{ error: { message: string } }>(t.base, "GET", "/api/catalog/portfolios/mirror-csv-1/positions");
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toContain(
      "a document written through the API, and a run at its end, sync at once; a 404 here means that sync failed " +
        "(the server logged one line) or the document was stored by other means; the next boot sync lands it",
    );
    const imp = await api(t.base, "POST", csvQuery("mirror-csv-1"), CSV);
    expect(imp.status).toBe(201);
    const pos = await api<CatalogPositions>(t.base, "GET", "/api/catalog/portfolios/mirror-csv-1/positions");
    expect(pos.status).toBe(200);
    expect(pos.body.page.total).toBe(2);
    expect(pos.body.positions.map((p) => p.positionId).sort()).toEqual(["p1", "p2"]);
    const lin = await api<{ collection: string; id: string; consumedBy: unknown[] }>(t.base, "GET", "/api/catalog/lineage/portfolios/mirror-csv-1");
    expect(lin.status).toBe(200);
    expect(lin.body).toMatchObject({ collection: "portfolios", id: "mirror-csv-1", consumedBy: [] });
    const list = await api<Array<{ id: string; positionCount: number }>>(t.base, "GET", "/api/catalog/portfolios");
    expect(list.body.find((p) => p.id === "mirror-csv-1")?.positionCount).toBe(2);
  });

  it("a workspace (in-lock) import is mirrored too", async () => {
    await warmCatalog();
    const ws = await api(t.base, "POST", "/api/workspaces", { name: "Mirror WS", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", id: "ws-mirror-pos" });
    expect(ws.status).toBe(201);
    const imp = await api(t.base, "POST", csvQuery("mirror-csv-2", "&workspaceId=ws-mirror-pos&by=tester"), CSV);
    expect(imp.status).toBe(201);
    const pos = await api<CatalogPositions>(t.base, "GET", "/api/catalog/portfolios/mirror-csv-2/positions");
    expect(pos.status).toBe(200);
    expect(pos.body.page.total).toBe(2);
    expect((await api(t.base, "GET", "/api/catalog/lineage/portfolios/mirror-csv-2")).status).toBe(200);
  });
});

describe("a market workbook import is mirrored at once", () => {
  it("a plain import answers 200 on GET /api/catalog/markets/:id and lineage", async () => {
    await warmCatalog();
    expect((await api(t.base, "GET", "/api/catalog/markets/mirror-mkt-1")).status).toBe(404);
    const imp = await importWorkbook("id=mirror-mkt-1", "synthetic_market_20260331.xlsx");
    expect(imp.status).toBe(201);
    const snap = await api<{ id: string }>(t.base, "GET", "/api/catalog/markets/mirror-mkt-1");
    expect(snap.status).toBe(200);
    expect(snap.body.id).toBe("mirror-mkt-1");
    expect((await api(t.base, "GET", "/api/catalog/lineage/market/mirror-mkt-1")).status).toBe(200);
  });

  it("a workspace (in-lock) import is mirrored too", async () => {
    await warmCatalog();
    const ws = await api(t.base, "POST", "/api/workspaces", { name: "Mirror MKT", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", id: "ws-mirror-mkt" });
    expect(ws.status).toBe(201);
    const imp = await importWorkbook("id=mirror-mkt-2&workspaceId=ws-mirror-mkt&by=tester", "synthetic_market_20260331.xlsx");
    expect(imp.status).toBe(201);
    expect((await api(t.base, "GET", "/api/catalog/markets/mirror-mkt-2")).status).toBe(200);
  });
});

describe("syncDocumentToDb", () => {
  it("is idempotent: a second call for the same document changes no row count and ingests nothing", async () => {
    const store = new FileStore(t.storeRoot);
    expect((await api(t.base, "POST", csvQuery("mirror-idem"), CSV)).status).toBe(201);
    const count = (): { docs: number; positions: number } => {
      const db = openPlatformDb(defaultDbPath(t.storeRoot));
      try {
        const n = (sql: string): number => (db.db.prepare(sql).get() as { n: number }).n;
        return { docs: n("SELECT COUNT(*) AS n FROM documents"), positions: n("SELECT COUNT(*) AS n FROM positions") };
      } finally {
        db.close();
      }
    };
    const before = count();
    const first = syncDocumentToDb({ store }, "portfolios", "mirror-idem");
    const second = syncDocumentToDb({ store }, "portfolios", "mirror-idem");
    expect(first.documentsIngested).toEqual([]);
    expect(first.documentsSkipped).toBe(1);
    expect(second.documentsSkipped).toBe(1);
    expect(count()).toEqual(before);
  });

  it("mirrors a document stored behind the route's back, once, and then skips it", async () => {
    const store = new FileStore(t.storeRoot);
    const spec = { schemaVersion: "1.0.0", id: "mirror-direct", label: "direct", asOf: "2026-03-31", coa: TEST_COA, positions: [] };
    store.putDocument("portfolios", "mirror-direct", spec, { label: "direct", asOf: "2026-03-31", positionCount: 0 });
    const first = syncDocumentToDb({ store }, "portfolios", "mirror-direct");
    expect(first.documentsIngested).toEqual(["portfolios/mirror-direct"]);
    const again = syncDocumentToDb({ store }, "portfolios", "mirror-direct");
    expect(again.documentsIngested).toEqual([]);
    expect(again.documentsSkipped).toBe(1);
  });

  it("refuses a collection the mirror does not hold, naming it", () => {
    const store = new FileStore(t.storeRoot);
    expect(() => syncDocumentToDb({ store }, "run-setups", "anything")).toThrow(/run-setups/);
  });
});

describe("the mirror is best effort: an import that saved its document never answers 500 because of it", () => {
  /** A mirror row under the id with a different content hash: the sync refuses it as a divergence. */
  function plantDivergentRow(collection: string, id: string): void {
    const db = openPlatformDb(defaultDbPath(t.storeRoot));
    try {
      db.db
        .prepare("INSERT INTO documents (collection, id, content_hash, body, meta_json, ingested_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(collection, id, "0".repeat(64), Buffer.from("{}"), "{}", new Date().toISOString());
    } finally {
      db.close();
    }
  }

  it("a positions import whose mirror sync throws still answers 201, stores the book and logs one line", async () => {
    plantDivergentRow("portfolios", "mirror-fail-pos");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const imp = await api(t.base, "POST", csvQuery("mirror-fail-pos"), CSV);
    expect(imp.status).toBe(201);
    const stored = await api<{ id: string }>(t.base, "GET", "/api/portfolios/mirror-fail-pos");
    expect(stored.status).toBe(200);
    expect(stored.body.id).toBe("mirror-fail-pos");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toMatch(/portfolios\/mirror-fail-pos/);
  });

  it("a market import whose mirror sync throws still answers 201 and stores the snapshot", async () => {
    plantDivergentRow("market", "mirror-fail-mkt");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const imp = await importWorkbook("id=mirror-fail-mkt", "synthetic_market_20260331.xlsx");
    expect(imp.status).toBe(201);
    expect((await api(t.base, "GET", "/api/market/mirror-fail-mkt")).status).toBe(200);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toMatch(/market\/mirror-fail-mkt/);
  });

  it("mirrorBestEffort never rethrows, and logs the collection and id on one line", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new FileStore(t.storeRoot);
    expect(() => mirrorBestEffort({ store }, "portfolios", "no-such-doc-anywhere")).not.toThrow();
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line).toMatch(/portfolios\/no-such-doc-anywhere/);
    expect(line).not.toMatch(/\n/);
  });
});

describe("a store that was never mirrored", () => {
  it("an import still answers 201 and does not conjure a partial platform.db", async () => {
    const bare = await bootTestPlatform();
    try {
      new FileStore(bare.storeRoot).putDocument("coa", "mirror-coa", TEST_COA, { label: "mirror test COA" });
      const imp = await api(bare.base, "POST", csvQuery("mirror-bare"), CSV);
      expect(imp.status).toBe(201);
      expect(existsSync(join(bare.storeRoot, "platform.db"))).toBe(false);
      expect(readFileSync(join(bare.storeRoot, "portfolios", "mirror-bare.json")).length).toBeGreaterThan(0);
    } finally {
      await bare.close();
    }
  });
});
