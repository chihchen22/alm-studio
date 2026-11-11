/**
 * Migrate / mirror the append-only file store into the platform database.
 *
 *   npx tsx apps/server/scripts/migrate-store.ts [--store <dir>] [--db <file>]
 *
 * Defaults: the configured store root (ALM_PLATFORM_STORE or <repo>/var/store)
 * and <storeRoot>/platform.db. Idempotent: content already mirrored is
 * skipped; diverging content refuses with a nonzero exit (the file store is
 * the byte store of record and the database never silently disagrees with it).
 */
import { existsSync } from "node:fs";
import { FileStore } from "../src/store/store";
import { resolveConfig } from "../src/config";
import { loadCompanion } from "../src/companion";
import { defaultDbPath, openPlatformDb } from "../src/db/database";
import { syncStoreToDb } from "../src/db/ingest";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function main(): void {
  const config = resolveConfig();
  const storeRoot = argValue("--store") ?? config.storeRoot;
  const dbPath = argValue("--db") ?? defaultDbPath(storeRoot);

  if (!existsSync(storeRoot)) {
    console.error(`migrate: store root ${storeRoot} does not exist; nothing to migrate`);
    process.exit(1);
  }

  const store = new FileStore(storeRoot);
  const db = openPlatformDb(dbPath);
  try {
    const report = syncStoreToDb(store, db);
    console.log(`migrate: store ${storeRoot}`);
    console.log(`migrate: db    ${dbPath}`);
    for (const d of report.documentsIngested) console.log(`migrate: ingested document ${d}`);
    for (const r of report.runsIngested) console.log(`migrate: ingested run ${r}`);
    for (const r of report.runsUpdated) console.log(`migrate: advanced run ${r}`);
    console.log(
      `migrate: documents ${report.documentsIngested.length} ingested / ${report.documentsSkipped} already mirrored; ` +
        `runs ${report.runsIngested.length} ingested / ${report.runsUpdated.length} advanced / ${report.runsSkipped} skipped`,
    );
    console.log(
      `migrate: rows — positions ${report.positionsInserted}, curve points ${report.curvePointsInserted}, ` +
        `cap vols ${report.capVolPointsInserted}, swaption vols ${report.swaptionVolPointsInserted}, ` +
        `overlay bindings ${report.bindingsInserted}, scenarios ${report.scenariosInserted}`,
    );
    if (report.positionsUnrecognizedType > 0) {
      console.log(
        `migrate: NOTE ${report.positionsUnrecognizedType} position(s) carry an instrument type this ` +
          `build does not recognize; their rate column is unpopulated (rate_kind names the type; terms_json is verbatim)`,
      );
    }
    console.log(`migrate: ${report.elapsedMs} ms`);
  } catch (err) {
    console.error(`migrate: REFUSED — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

// The optional extension folder, when present, registers its seed profiles before the profile is resolved.
loadCompanion()
  .then(main)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
