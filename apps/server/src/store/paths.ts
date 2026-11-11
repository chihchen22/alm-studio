/**
 * Store path layout and id discipline.
 *
 * Every platform artifact is a JSON file under the store root:
 *
 *   portfolios/<id>.json          PortfolioSpec verbatim; <id>.meta.json beside it
 *   market/<id>.json              MarketSnapshot;         <id>.meta.json beside it
 *   assumption-sets/<id>.json     AssumptionSet AFTER engine bindAssumptions()
 *   scenario-slates/<id>.json     { id, label, scenarios } with exactly one base
 *   plans/<id>.json               BalancePlan referenced by a RunPlan
 *   routing-policies/<id>.json    RoutingPolicy the routing gate enforces
 *   lens/<id>.json                LensDefinition the read routes score a run through
 *   run-plans/<id>.json           RunPlan as the author wrote it (Studio S2)
 *   approvals/<id>.json           ApprovalRecord (Controls 2), append-only sign-off records
 *   hierarchies/<id>.json Hierarchy: a tag-route mapping table, append-only
 *   runs/<runId>/                 request.json, status.json, result.json, rates.json, log.ndjson
 *
 * Ids double as filenames, so they are validated against a strict allowlist and
 * anything else is rejected loudly with the offending id echoed back. No path
 * under this module is ever deleted; the store is append-only by construction.
 */
import { join } from "node:path";

/** The one id shape the platform accepts (usable as a filename on Windows). */
export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Thrown when an id cannot double as a store filename. */
export class InvalidIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(
      `invalid id ${JSON.stringify(id)}: ids must match ${String(ID_PATTERN)} ` +
        `(letters, digits, dot, underscore, hyphen; 1-64 chars) so they are usable as store filenames`,
    );
    this.name = "InvalidIdError";
    this.id = id;
  }
}

/** Validate an id or throw InvalidIdError. Returns the id for chaining. */
export function assertValidId(id: string): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new InvalidIdError(id);
  return id;
}

/**
 * The store collections holding one JSON document per id. `coa` holds stored
 * charts of accounts for CSV position intake, which targets a stored COA by
 * `coaId` (seeded from the demo COA). `taxonomy` holds
 * stored dimension taxonomies, which CSV intake targets by `taxonomyId` for
 * its `dim.<id>` tag columns (seeded from the shipped
 * demo-dimensions fixture, and written by the seed alone). `lens` holds stored
 * lens definitions, which the two read routes score a finished run through
 * (seeded from the shipped lenses fixture, and written by the seed
 * alone). `plans` holds balance plans a RunPlan references by id and
 * `routing-policies` the behavioral model map the routing gate enforces
 * (harness Plane 4). `run-plans` holds the RunPlan documents the
 * Studio plan builder saves and the seed writes (Studio S2); `plans` stays the
 * balance-plan collection. `approvals` holds the append-only sign-off records of
 * Controls 2 (approvals): records only, written by the approvals route alone,
 * never read by a run and never mirrored to the database or lineage.
 * `hierarchies` holds the tag-route mapping tables: hierarchies are
 * written by the hierarchies route and the seed, never read by a run, and never
 * mirrored to the database or lineage. `run-setups` (Studio A+E) holds the
 * immutable run setup documents a workspace's slots point at: written by the
 * workspace create route and the run-setups route, append-only like the rest.
 * `curve-setups` holds the immutable curve setup documents a
 * workspace's market block lists (`cs-<16 hex>` of the validated block): written
 * by the curve-setups route alone, read by the launch pin, and never mirrored to
 * the database (the derived market the launch pins is a `market` document and is).
 * `reference` holds reference documents the seed
 * alone writes: a parameters document (the regulatory deposit convention) and
 * reconciliation targets. Read by a tie-out and the Studio
 * through GET /api/reference; never read by a run, never pinned in a workspace
 * block, never mirrored to the database.
 * `derived-curves` holds the immutable derived curve documents
 * (`dc-<16 hex>` of the validated block) on the same pattern: written by the
 * derived-curves route alone, read by the launch pin, and never mirrored.
 * `index-histories` holds the immutable index history
 * documents (`ih-<16 hex>` of the document's content hash), monthly fixings
 * imported from a CSV or .xlsx file: written by the index-histories import route
 * alone, not workspace-scoped, read by the launch pin, and never mirrored.
 */
export type Collection =
  | "portfolios"
  | "market"
  | "assumption-sets"
  | "scenario-slates"
  | "coa"
  | "taxonomy"
  | "lens"
  | "plans"
  | "routing-policies"
  | "run-plans"
  | "approvals"
  | "hierarchies"
  | "run-setups"
  | "curve-setups"
  | "derived-curves"
  | "index-histories"
  | "reference"
  /** Saved rate-model fits, `cal-<16 hex>` of the content hash, append-only. */
  | "calibrations";

export const COLLECTIONS: readonly Collection[] = [
  "portfolios",
  "market",
  "assumption-sets",
  "scenario-slates",
  "coa",
  "taxonomy",
  "lens",
  "plans",
  "routing-policies",
  "run-plans",
  "approvals",
  "hierarchies",
  "run-setups",
  "curve-setups",
  "derived-curves",
  "index-histories",
  "reference",
  "calibrations",
];

/** The files one run directory holds. instruments.json is the optional per-position results file (schema 1.9.0). */
export type RunFileName =
  | "request.json"
  | "status.json"
  | "result.json"
  | "rates.json"
  | "instruments.json"
  | "log.ndjson";

export interface StorePaths {
  root: string;
  collectionDir(collection: Collection): string;
  documentPath(collection: Collection, id: string): string;
  metaPath(collection: Collection, id: string): string;
  runsDir(): string;
  runDir(runId: string): string;
  runFile(runId: string, file: RunFileName): string;
}

/** Build the path helpers over one store root. Pure; touches no filesystem. */
export function storePaths(root: string): StorePaths {
  return {
    root,
    collectionDir: (collection) => join(root, collection),
    documentPath: (collection, id) => join(root, collection, `${assertValidId(id)}.json`),
    metaPath: (collection, id) => join(root, collection, `${assertValidId(id)}.meta.json`),
    runsDir: () => join(root, "runs"),
    runDir: (runId) => join(root, "runs", assertValidId(runId)),
    runFile: (runId, file) => join(root, "runs", assertValidId(runId), file),
  };
}
