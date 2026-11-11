/**
 * Platform database schema.
 *
 * Design stance, carried over from the file store it mirrors:
 *
 *  - **The document is the source of truth for bytes.** Every stored artifact
 *    (portfolio, market snapshot, assumption set, scenario slate, COA) lands in
 *    `documents` as its EXACT file-store bytes plus the SHA-256 over those
 *    bytes. Reconstruction of a run's inputs is byte-exact by construction.
 *  - **Relational tables are exploded, queryable projections** of those
 *    documents: one row per position, one row per curve/vol point, one row per
 *    overlay binding, one row per scenario. They are derived at ingest inside
 *    the same transaction as the document row and are immutable with it.
 *  - **Immutability is enforced in the schema, not by convention.** Triggers
 *    RAISE(ABORT) on any UPDATE or DELETE of content rows. A run row may only
 *    move its lifecycle columns (state, phase, timings, result linkage); its
 *    identity columns (run_id, request bytes, request hash) are trigger-frozen.
 *    Nothing a completed run referenced can be edited underneath it, because
 *    nothing content-bearing can be edited at all — a new version is a new id.
 *
 * All DDL is idempotent (IF NOT EXISTS) so opening an existing database is a
 * no-op; `meta.schema_version` pins the shape and a mismatch refuses loudly
 * (see database.ts) instead of silently reinterpreting rows.
 */

// 1.3.0 (2026-09-25, id-rename): curve_points ids 'sofr-ois' and 'fhlb' became 'risk-free' and 'term-funding'.
export const DB_SCHEMA_VERSION = "1.3.0";

/** Tables whose rows are fully immutable once written. */
const IMMUTABLE_TABLES = [
  "documents",
  "positions",
  "curve_points",
  "cap_vol_points",
  "swaption_vol_points",
  "assumption_bindings",
  "slate_scenarios",
  "run_inputs",
] as const;

function immutabilityTriggers(): string {
  return IMMUTABLE_TABLES.map(
    (t) => `
CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
BEGIN SELECT RAISE(ABORT, 'append-only store: ${t} rows are immutable; supersede under a new id'); END;
CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
BEGIN SELECT RAISE(ABORT, 'append-only store: ${t} rows are never deleted'); END;`,
  ).join("\n");
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Canonical documents: exact file-store bytes, content-addressed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL CHECK (collection IN
                 ('portfolios','market','assumption-sets','scenario-slates','coa')),
  id TEXT NOT NULL,
  content_hash TEXT NOT NULL, -- SHA-256 hex over body (= file-store meta.contentHash)
  body BLOB NOT NULL, -- the stored JSON document, byte-exact
  meta_json TEXT NOT NULL, -- the file-store DocumentMeta record, verbatim JSON
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS documents_by_hash ON documents (content_hash);

-- ---------------------------------------------------------------------------
-- Positions: one row per on-book instrument (queryable at 100k rows).
-- Exploded from the portfolio document; side comes from the embedded COA.
--
-- side carries a THIRD value, 'off-balance-sheet' (schema 1.1.0).
-- An undrawn committed line is declared asset-side in the chart of accounts (a
-- line is extended BY the bank), but its notional is optional capacity the
-- bank does not own. Mirroring it as 'asset' made SUM(notional) GROUP BY side
-- disagree with the portfolio's own intake metadata, which excludes it. A named
-- third value keeps the row PRESENT and queryable, rather than a NULL that
-- cannot be told from an unresolved family, and makes the asset bucket
-- reconcile to intake.assets exactly.
--
-- side carries a FOURTH value, 'derivative' (schema 1.2.0): a swap
-- family's side, mirrored verbatim from the chart of accounts. A swap has no
-- booked balance, so its notional is in neither the asset nor the liability
-- bucket, and SUM(notional) GROUP BY side keeps reconciling to intake.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  portfolio_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  coa_node_id TEXT NOT NULL,
  side TEXT CHECK (side IN ('asset','liability','off-balance-sheet','derivative')),
  instrument_type TEXT NOT NULL, -- fixed-loan | floating-loan | mortgage | nmd | nmd-b | cd | commitment | swap
  notional REAL NOT NULL,
  rate REAL, -- see rate_kind; NULL when the rate is model-implied
  rate_kind TEXT NOT NULL, -- coupon | margin | note-rate | deposit-rate | beta-s-curve | cohort-book | undrawn-line | swap-fixed-rate
  maturity_months INTEGER NOT NULL,
  origination_offset_months INTEGER NOT NULL,
  amort_type TEXT NOT NULL,
  behavioral TEXT, -- terms-embedded behavioral parameter set, if any
  terms_json TEXT NOT NULL, -- full instrument terms, verbatim JSON
  PRIMARY KEY (portfolio_id, position_id)
);
CREATE INDEX IF NOT EXISTS positions_by_family ON positions (portfolio_id, family_id);
CREATE INDEX IF NOT EXISTS positions_by_type ON positions (portfolio_id, instrument_type);

-- ---------------------------------------------------------------------------
-- Market time series: curve quotes, cap vols, swaption vols, keyed by the
-- snapshot's as-of date so multiple snapshots line up as a time series.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS curve_points (
  market_id TEXT NOT NULL,
  as_of TEXT NOT NULL, -- snapshot calibrationDate
  curve TEXT NOT NULL CHECK (curve IN ('risk-free','term-funding','tlp')),
  seq INTEGER NOT NULL, -- source ordering within the curve
  term TEXT, -- tenor label; NULL for TLP nodes
  t_years REAL NOT NULL,
  instrument_type TEXT, -- CASH | SWAP for risk-free; NULL otherwise
  value REAL NOT NULL, -- rate (curves) or spread (tlp), decimal
  PRIMARY KEY (market_id, curve, seq)
);
CREATE INDEX IF NOT EXISTS curve_points_series ON curve_points (curve, as_of, t_years);

CREATE TABLE IF NOT EXISTS cap_vol_points (
  market_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  seq INTEGER NOT NULL,
  expiry_years REAL NOT NULL,
  strike REAL, -- NULL for ATM
  is_atm INTEGER NOT NULL CHECK (is_atm IN (0,1)),
  normal_vol REAL NOT NULL,
  PRIMARY KEY (market_id, seq)
);

CREATE TABLE IF NOT EXISTS swaption_vol_points (
  market_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  seq INTEGER NOT NULL,
  expiry_years REAL NOT NULL,
  tenor_years REAL NOT NULL,
  normal_vol REAL NOT NULL,
  PRIMARY KEY (market_id, seq)
);

-- ---------------------------------------------------------------------------
-- Assumption sets and scenario slates, exploded for queryability.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assumption_bindings (
  set_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  family_id TEXT NOT NULL,
  overlay_kind TEXT NOT NULL, -- prepay | nmd-decay | deposit-beta | cd-rollover | commitment-draw | loan-client-rate | registered
  model_version TEXT NOT NULL,
  overlay_json TEXT NOT NULL, -- the overlay parameters, verbatim JSON
  PRIMARY KEY (set_id, seq)
);
CREATE INDEX IF NOT EXISTS assumption_bindings_by_family ON assumption_bindings (family_id, overlay_kind);

CREATE TABLE IF NOT EXISTS slate_scenarios (
  slate_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  label TEXT NOT NULL,
  assumption_set_id TEXT NOT NULL,
  rate_spec_kind TEXT NOT NULL, -- base | parallel | twist | custom
  rate_spec_json TEXT NOT NULL,
  new_business_mode TEXT NOT NULL, -- static | dynamic
  PRIMARY KEY (slate_id, seq)
);

-- ---------------------------------------------------------------------------
-- Runs: the complete input set of every simulation, plus lifecycle and the
-- link to the stored result. request_body is the verbatim request.json bytes;
-- run_inputs pins every referenced artifact by content hash.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN
                          ('queued','running','done','error','cancelled','interrupted')),
  phase TEXT,
  label TEXT,
  submitted_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  elapsed_ms INTEGER,
  platform_request_hash TEXT NOT NULL, -- SHA-256 over request.json bytes
  engine_inputs_hash TEXT, -- result.provenance.inputsHash once done
  seed TEXT,
  grid_json TEXT, -- { horizonMonths, asOf }
  engine_context_json TEXT, -- { durationMode, shards }
  request_body BLOB NOT NULL, -- runs/<id>/request.json, byte-exact
  result_ref TEXT, -- store-relative path to result.json, once done
  result_content_hash TEXT, -- SHA-256 over result.json bytes, once done
  result_bytes INTEGER,
  error_message TEXT,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_inputs (
  run_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN
                 ('portfolio','market','scenario-slate','assumption-set')),
  ord INTEGER NOT NULL,
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  content_hash TEXT NOT NULL, -- pin over the referenced document bytes
  PRIMARY KEY (run_id, role, ord)
);

${immutabilityTriggers()}

-- Runs: lifecycle columns may advance; identity columns are frozen; no deletes.
CREATE TRIGGER IF NOT EXISTS runs_no_delete BEFORE DELETE ON runs
BEGIN SELECT RAISE(ABORT, 'append-only store: run rows are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS runs_identity_frozen
BEFORE UPDATE OF run_id, platform_request_hash, request_body, seed, grid_json,
                 engine_context_json, submitted_at, ingested_at ON runs
BEGIN SELECT RAISE(ABORT,
  'append-only store: a run''s identity (id, request bytes, request hash, seed, grid, context) is immutable; only lifecycle columns may change'); END;
`;
