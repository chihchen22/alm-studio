/**
 * A workspace head and a readiness report as the server serves them (spec v3.1 Sections 2.2, 2.7 and 3.5).
 * HEAD is the ws-synthetic-2500-v1 row of the Section 2.7 table: Test, cut-off 2026-03-31, 16 sets with
 * demo-behavioral-v1 the default, 3 derived markets, 9 run setup slots (8 imported plus Standard ALCO).
 */
import type { DerivedRef, DocRef, ReadinessReport, WorkspaceManifest } from "@alm/reader";

const PINNED_AT = "2026-10-09T09:00:00.000Z";

const ref = (collection: DocRef["collection"], id: string): DocRef => ({ collection, id, contentHash: `hash-${id}`, pinnedAt: PINNED_AT });
const derived = (id: string): DerivedRef => ({ ...ref("market", id), definitionKey: id, parentKey: null });

const SET_IDS = [
  "demo-behavioral-v1", "loan-repricing-demo-v1", "housing-demo-v1", "housing-flat-demo-v1", "decay-shock-demo-v1",
  "stress-illustrative-v1", "stack-ab60dc782a83",
  ...Array.from({ length: 9 }, (_, i) => `demo-behavioral-v1-edit-${i + 1}`),
];

const SETUP_IDS = [
  "setup-standard-alco", "setup-plan-synthetic-2500-v1", "setup-plan-synthetic-2500-loan-repricing-v1",
  "setup-plan-synthetic-2500-housing-v1", "setup-plan-synthetic-2500-housing-flat-v1",
  "setup-plan-synthetic-2500-macro-unmapped-v1", "setup-plan-synthetic-2500-v1-edit-1",
  "setup-plan-synthetic-2500-v1-edit-2", "setup-plan-synthetic-2500-v1-edit-3",
];

export const HEAD: WorkspaceManifest = {
  schemaVersion: "1.0.0",
  id: "ws-synthetic-2500-v1",
  name: "Synthetic 2,500 book",
  type: "test",
  status: "active",
  cutoffDate: "2026-03-31",
  owner: "ALM",
  createdAt: PINNED_AT,
  updatedAt: PINNED_AT,
  revision: 4,
  blocks: {
    market: {
      snapshot: ref("market", "market-public-2026-03-31"),
      derived: ["macro-demo-v1", "tlp-shock-demo-v1", "vol-shock-demo-v1"].map(derived),
      carried: [],
      carriedFrom: null,
    },
    positions: {
      book: ref("portfolios", "synthetic-2500-v1"),
      retagged: [],
      coa: ref("coa", "demo-coa-v1"),
      taxonomy: null,
      hierarchies: [],
    },
    targets: { balancePlans: [ref("plans", "balance-targets-demo-v1"), ref("plans", "balance-shock-demo-v1")], templates: [] },
    assumptions: { sets: SET_IDS.map((id) => ref("assumption-sets", id)), defaultSetId: "demo-behavioral-v1", routingPolicy: ref("routing-policies", "routing-demo-v1") },
    scenarios: { slates: [] },
    run: { setups: SETUP_IDS.map((id) => ({ setupLineageId: id, current: ref("run-setups", `rs-${id}`) })), lenses: [] },
  },
  blockHashes: { market: "bh-market", positions: "bh-positions", targets: "bh-targets", assumptions: "bh-assumptions", scenarios: "bh-scenarios", run: "bh-run" },
  signedHash: "signed-hash",
  manifestHash: "manifest-hash",
  lineage: { mode: "seed", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false },
  clashes: [],
  lock: null,
  note: "",
};

/** A workspace of another type and date, for the switcher's grouping. */
export const OTHERS: WorkspaceManifest[] = [
  { ...HEAD, id: "ws-prod-2026-02", name: "February production", type: "production", cutoffDate: "2026-02-28", status: "locked" },
  { ...HEAD, id: "ws-monthly-2026-01", name: "January monthly", type: "monthly", cutoffDate: "2026-01-31" },
  { ...HEAD, id: "ws-stress-hqla", name: "HQLA stress", type: "stress" },
  { ...HEAD, id: "ws-old", name: "Retired scratch", type: "test", status: "archived" },
];

/** Readiness with the Balance Sheet section at Warning; the Run section holds an optional Not set item that never counts. */
export const READINESS: ReadinessReport = {
  items: [
    { section: "market", item: "Base snapshot", state: "valid", required: true, detail: "set, calibration date equals the cut-off" },
    { section: "balance", item: "Positions", state: "warning", required: true, detail: "a cut-off clash is recorded" },
    { section: "balance", item: "Chart of accounts", state: "valid", required: true, detail: "book embeds a chart" },
    { section: "balance", item: "Strategy", state: "not-set", required: false, detail: "no balance plan; a Flat basis needs none" },
    { section: "assumptions", item: "Sets", state: "valid", required: true, detail: "16 sets resolve" },
    { section: "assumptions", item: "Routing policy", state: "valid", required: true, detail: "Routing policy \"model-map-default-v1\" is attached." },
    { section: "run", item: "Run setups", state: "stale", required: true, detail: "a consumed pin moved", staleRoles: [{ role: "book", pinned: "a", current: "b" }] },
    { section: "run", item: "Vol surface", state: "not-set", required: false, detail: "no cap quotes" },
  ],
  sections: { workspace: "valid", market: "valid", balance: "warning", assumptions: "valid", run: "stale", results: "not-set", govern: "not-set" },
  launchable: { "setup-standard-alco": { ok: true, blocking: [], acknowledgeable: ["Run setups"] } },
};

/** A blank workspace's readiness (spec v3.1 Section 3.6 step 3): every required item Not set, the setup a Draft. */
export const READINESS_BLANK: ReadinessReport = {
  items: [
    { section: "market", item: "Base snapshot", state: "not-set", required: true, detail: "no base snapshot is set" },
    { section: "market", item: "Curves", state: "not-set", required: true, detail: "no snapshot" },
    { section: "market", item: "Vol surface", state: "not-set", required: false, detail: "no cap quotes" },
    { section: "balance", item: "Positions", state: "not-set", required: true, detail: "no position book is set" },
    { section: "balance", item: "Chart of accounts", state: "not-set", required: true, detail: "no book" },
    { section: "balance", item: "Strategy", state: "not-set", required: false, detail: "a Flat basis needs no balance plan" },
    { section: "assumptions", item: "Sets", state: "not-set", required: true, detail: "no assumption set is attached" },
    { section: "assumptions", item: "Routing policy", state: "valid", required: true, detail: "the create route pinned the seeded policy" },
    { section: "run", item: "Scenarios", state: "valid", required: true, detail: "the regulatory grid resolves" },
    { section: "run", item: "Run setups", state: "draft", required: true, detail: "Standard ALCO has never been validated" },
    { section: "results", item: "Newest result", state: "not-set", required: true, detail: "no run" },
    { section: "govern", item: "Sign-off", state: "not-set", required: false, detail: "no approval" },
  ],
  sections: { workspace: "not-set", market: "not-set", balance: "not-set", assumptions: "not-set", run: "draft", results: "not-set", govern: "not-set" },
  launchable: { "setup-standard-alco": { ok: false, blocking: ["Base snapshot", "Positions", "Sets"], acknowledgeable: [] } },
};
