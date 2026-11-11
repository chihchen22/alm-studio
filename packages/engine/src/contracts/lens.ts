/**
 * The lens document (harness Plane 5).
 *
 * A lens is DATA: a stored definition naming constraints over a closed set of
 * readers. What is code is the reader set, not the limits. Six are seeded as
 * demonstration values and a practitioner edits the fixture and re-seeds; there
 * is no write route, by design.
 *
 * The reader union lives here rather than beside the readers in report/ because
 * LensConstraint names it and this layer may not import from report/. The
 * reader FUNCTIONS live in report/lensReaders.ts and re-export this constant,
 * so a definition and its readers cannot name two different sets.
 */

export type LensObjective = "liquidity" | "rate" | "capital" | "strategy";
export type ConstraintOp = "atMost" | "atLeast";

/**
 * The closed reader set. A definition naming anything else
 * fails rule V3. Adding one is a contract change, not a configuration change.
 */
export const LENS_READER_IDS = [
  "deltaEvePct",
  "deltaNiiPct",
  "cumulativeLiquidityGap",
  "shortfallCount",
  "capitalRatio",
  // One named value of one custom metric, by (metricId, key). It is
  // APPENDED, never inserted: the list is the report order too.
  "customValue",
] as const;
export type LensReaderId = (typeof LENS_READER_IDS)[number];

/**
 * The id shape a lens and its constraints match. It is the same LITERAL the
 * store's ID_PATTERN uses (apps/server/src/store/paths.ts), restated because
 * the engine cannot import the server; a server test pins the two sources
 * equal, so they cannot drift apart unnoticed.
 */
export const LENS_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface LensConstraint {
  /** Unique within the lens. Matches LENS_ID_PATTERN. */
  id: string;
  reader: LensReaderId;
  /** Reader-specific parameters; shape fixed per reader. Absent when the reader takes none. */
  params?: Record<string, string | number>;
  op: ConstraintOp;
  /** Finite. Same unit as the reader's value. */
  limit: number;
  label?: string;
}

export interface LensDefinition {
  id: string;
  label: string;
  objective: LensObjective;
  /** One or more, in author order. Author order is the report order. */
  constraints: LensConstraint[];
}
