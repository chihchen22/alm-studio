/**
 * Platform database layer barrel.
 *
 * SQLite via the `node:sqlite` built-in (zero npm dependencies). The
 * append-only file store remains the byte store of record; the database is its
 * content-hash-verified relational mirror: instrument-level positions, curve
 * and vol time series, assumption overlays, scenario slates, and the complete
 * pinned input set of every run.
 */
export { DB_SCHEMA_VERSION, SCHEMA_SQL } from "./schema";
export { PlatformDb, openPlatformDb, defaultDbPath, SchemaVersionError } from "./database";
export { syncStoreToDb, StoreDivergenceError, type DbSyncReport } from "./ingest";
export {
  composeRunInputsFromDb,
  readDocumentVerified,
  readRunRequestBytes,
  DbNotFoundError,
  DbIntegrityError,
  type ResolvedRunInputs,
  type RunInputSpec,
  type VerifiedDocument,
} from "./resolve";
