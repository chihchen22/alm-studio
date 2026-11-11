// apps/server/src/db/__tests__/swapIngest.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hedgedBook, swapPosition } from "@alm/engine/src/swap/__tests__/fixtures";
import { FileStore } from "../../store/store";
import { openPlatformDb, type PlatformDb } from "../database";
import { syncStoreToDb } from "../ingest";
import { DB_SCHEMA_VERSION } from "../schema";

const root = mkdtempSync(join(tmpdir(), "alm-swap-db-"));
let db: PlatformDb | undefined;

afterAll(() => {
  db?.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // The OS temp cleaner owns the leftovers.
  }
});

describe("the positions mirror carries a swap", () => {
  it("writes side 'derivative', type 'swap', the fixed rate under its own kind, at schema 1.3.0", () => {
    const store = new FileStore(root);
    store.init();
    const book = hedgedBook("swap-db-book", [swapPosition("SW1", undefined, { fixedRate: 0.0375 })]);
    store.putDocument("portfolios", book.id, book, { label: book.label, asOf: book.asOf, positionCount: book.positions.length });
    db = openPlatformDb(join(root, "platform.db"));
    let outcome: string;
    try {
      const report = syncStoreToDb(store, db);
      const row = db.db
        .prepare("SELECT side, instrument_type, rate, rate_kind FROM positions WHERE portfolio_id = ? AND position_id = ?")
        .get(book.id, "SW1");
      outcome = `unrecognized=${report.positionsUnrecognizedType} row=${JSON.stringify(row)}`;
    } catch (err) {
      outcome = `THREW: ${String(err)}`;
    }
    expect(outcome).toBe(
      'unrecognized=0 row={"side":"derivative","instrument_type":"swap","rate":0.0375,"rate_kind":"swap-fixed-rate"}',
    );
    expect(db.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "1.3.0" });
    expect(DB_SCHEMA_VERSION).toBe("1.3.0");
  });
});
