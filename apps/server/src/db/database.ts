/**
 * Platform database handle.
 *
 * One SQLite file per store root, at `<storeRoot>/platform.db` (inside the
 * gitignored var/ tree). `node:sqlite` DatabaseSync only — a Node built-in;
 * zero new npm dependencies.
 *
 * Opening is idempotent: the DDL is IF-NOT-EXISTS and the stored schema
 * version is checked against DB_SCHEMA_VERSION. A version mismatch refuses
 * loudly rather than reinterpreting rows under an old shape; the cure is a
 * fresh migrate (`npx tsx apps/server/scripts/migrate-store.ts`) into a new
 * file — the file store remains the byte store of record, so the database is
 * always reconstructible from it.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type DatabaseSyncInstance } from "./sqlite";
import { DB_SCHEMA_VERSION, SCHEMA_SQL } from "./schema";

/** Thrown when the on-disk schema version does not match this build. */
export class SchemaVersionError extends Error {
  constructor(path: string, found: string | undefined, expected: string) {
    super(
      `platform database at ${path} carries schema version ${JSON.stringify(found)} ` +
        `but this build expects ${JSON.stringify(expected)}; refusing to read it under the wrong shape. ` +
        `Re-create it from the file store (the store of record) with apps/server/scripts/migrate-store.ts ` +
        `against a fresh database path.`,
    );
    this.name = "SchemaVersionError";
  }
}

/** Default database location under a store root. */
export function defaultDbPath(storeRoot: string): string {
  return join(storeRoot, "platform.db");
}

export class PlatformDb {
  readonly path: string;
  readonly db: DatabaseSyncInstance;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL keeps reads cheap beside the write path; NORMAL sync is the standard
    // local-tool pairing. Both are pragmas, not data-shape decisions.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (row === undefined) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(DB_SCHEMA_VERSION);
    } else if (row.value !== DB_SCHEMA_VERSION) {
      this.db.close();
      throw new SchemaVersionError(path, row.value, DB_SCHEMA_VERSION);
    }
  }

  /** Run `fn` inside a transaction; rollback on throw, rethrow. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Open (creating if absent) the platform database at `path`. */
export function openPlatformDb(path: string): PlatformDb {
  return new PlatformDb(path);
}
