/**
 * The seed's workspace generator (Studio A+E spec v3.1 Section 2.7; plan Task D1, contract 10).
 *
 * Derives the workspace set from the file store by rule. Every rule reads documents and meta;
 * nothing is matched by a label. The twelve rules, in the order the spec states them:
 *
 *   1  one Test workspace per distinct (position book, base market) pair among the SEEDED run plans
 *   2  into it: the book, the base market, every derived market and assumption set a plan of the pair
 *      names, the book's taxonomy, every lens, the routing policy, the COA
 *   3  the hand-kept map UNNAMED_SEED_ATTACHMENTS (and the three Stress workspaces it names), plus
 *      the hand list UNATTACHED_SEED_DOCUMENTS of documents left out on purpose
 *   4  sets follow their base (derivedFrom.baseId, or the Studio edit shape <baseId>-edit-<n>)
 *   5  a set with no such link attaches to the workspace of a run that consumed it on that book
 *   6  a non-seed book no workspace head pins gets its own Test workspace ws-import-<bookId>
 *   7  an authored slate attaches to every workspace whose sets cover every set it names
 *   8  balance plans: meta checkedBookId, else bp-<bookId>-edit-<n>, else derivedFrom, else the map
 *   9  a hierarchy attaches by its meta checkedBookId
 *   10 every run plan whose (book, base market) matches a workspace is imported as a setup
 *   11 every stored run attaches by its submission to an active, unlocked head (else ws-legacy-<as-of>)
 *   12 the default set
 *
 * The generator creates a workspace whose id is absent and never compares an existing head with
 * what it would have written. Run attachment lines are the one thing it adds to a workspace that
 * already exists: a run that no `runs.ndjson` line attaches yet. `status.json` is never written.
 *
 * This module does not import seed-store.ts at load time (seed-store imports this module); the
 * seeded ids it needs are literals here, and seedWorkspaces.test.ts pins each against SEED_IDS.
 */
import type { RunPlan } from "@alm/engine";
import type { Collection } from "../src/store/paths";
import { sha256Hex, type DocumentMeta, type FileStore } from "../src/store/store";
import { blockHashes } from "../src/workspaces/hashes";
import { emptyBlocks } from "../src/workspaces/clone";
import { importPlanAsSetup } from "../src/workspaces/importPlan";
import { isSeeded, preferSeeded } from "../src/workspaces/seeded";
import { standardAlcoSetup } from "../src/workspaces/standardAlco";
import type { DerivedRef, DocRef, RunAttachment, RunSetup, SetupSlot, WorkspaceManifest, WorkspaceType } from "../src/workspaces/types";
import type { WorkspaceStore } from "../src/workspaces/workspaceStore";

/** The writer literal on every history line the generator makes. */
export const SEED_BY = "seed";
/** The writer literal on every run attachment line the generator makes. */
const MIGRATION_BY = "migration" as const;

// ---------------------------------------------------------------------------
// The two hand-kept lists (rule 3). Seeded ids as literals; the test pins them against SEED_IDS.
// ---------------------------------------------------------------------------

const PUBLIC_MARKET = "market-public-2026-03-31";
const VANILLA_EMPTY_SET = "vanilla-empty-v1";

/** A seeded document no seeded plan names, attached to named workspaces by hand. */
export interface UnnamedSeedAttachment {
  collection: Collection;
  id: string;
  /** One entry per document, however many workspaces take it. */
  workspaceIds: string[];
  reason: string;
}

/** A Stress workspace the map creates: no seeded run plan runs these books, so rule 1 never sees them. */
interface StressWorkspace {
  id: string;
  bookId: string;
}

const STRESS_WORKSPACES: readonly StressWorkspace[] = [
  { id: "ws-synthetic-2500-hqla-v1", bookId: "synthetic-2500-hqla-v1" },
  { id: "ws-synthetic-2500-lcr-v1", bookId: "synthetic-2500-lcr-v1" },
  { id: "ws-synthetic-2500-commit-v1", bookId: "synthetic-2500-commit-v1" },
];
const STRESS_IDS = STRESS_WORKSPACES.map((s) => s.id);

/**
 * Order matters for one thing: a workspace whose default set rule 12 takes from this map takes the
 * first assumption set listed for it (the commit workspace: stress, then squeeze).
 */
export const UNNAMED_SEED_ATTACHMENTS: readonly UnnamedSeedAttachment[] = [
  {
    collection: "market",
    id: "tlp-shock-demo-v1",
    workspaceIds: ["ws-synthetic-2500-v1"],
    reason: "the TLP +50 bp derived market; no seeded run plan binds it",
  },
  {
    collection: "market",
    id: "vol-shock-demo-v1",
    workspaceIds: ["ws-synthetic-2500-v1"],
    reason: "the short-rate volatility x1.5 derived market; no seeded run plan binds it",
  },
  {
    collection: "assumption-sets",
    id: "stress-illustrative-v1",
    workspaceIds: ["ws-synthetic-2500-v1"],
    reason: "the illustrative stress set on the synthetic book; its slate regulatory-grid-stress follows it",
  },
  {
    collection: "plans",
    id: "balance-targets-demo-v1",
    workspaceIds: ["ws-synthetic-2500-v1"],
    reason: "the deposit targets balance plan on the synthetic book; no id or meta ties it to a book",
  },
  {
    collection: "assumption-sets",
    id: "liquidity-stress-demo-v1",
    workspaceIds: [...STRESS_IDS],
    reason: "the illustrative liquidity stress set every Stress workspace runs; no seeded run plan names it",
  },
  {
    collection: "assumption-sets",
    id: "liquidity-squeeze-demo-v1",
    workspaceIds: ["ws-synthetic-2500-commit-v1"],
    reason: "the joint squeeze set needs the committed-line book; only the commit workspace holds one",
  },
];

/** A seeded document left out of every workspace on purpose. */
export interface UnattachedSeedDocument {
  collection: Collection;
  id: string;
  reason: string;
}

export const UNATTACHED_SEED_DOCUMENTS: readonly UnattachedSeedDocument[] = [
  {
    collection: "taxonomy",
    id: "demo-dimensions-v1",
    reason:
      "the shipped demo dimension taxonomy for CSV intake; no stored book names it, so no workspace holds it; " +
      "attach with a block operation when a book imported against it exists",
  },
  {
    collection: "coa",
    id: "mid-size-bank-coa-v1",
    reason:
      "the example bank's chart of accounts, stored for the v2 CSV template; a chart rides on its book, " +
      "so no workspace holds it as a block",
  },
  {
    collection: "assumption-sets",
    id: "quillfield-illustrative-v1",
    reason:
      "a feature demo's set on the example bank; the Studio imports the example bank's book, " +
      "so the Feature demos card adds the set to that workspace when a demo is opened",
  },
  {
    collection: "assumption-sets",
    id: "quillfield-constant-prepay-v1",
    reason: "the constant-prepayment feature demo's set, added to the example bank's workspace when that demo is opened",
  },
];

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface WorkspaceSeedReport {
  /** Workspace ids created by this call, in creation order. */
  created: string[];
  /** The rule-3 map, one line per document: `<collection>/<id> -> <workspace ids> (<reason>)`. */
  unnamedAttachments: string[];
  /**
   * Seeded or stored documents no workspace holds after this call, sorted `<collection>/<id>`.
   * The hand list is a subset; a document no rule placed is listed here too.
   */
  unattached: string[];
  /** Run attachment lines written by this call: `<runId> -> <workspaceId>`. */
  runsAttached: string[];
  /** The legacy workspace's id when any run was attached to it by this call (or it already held runs), else null. */
  legacyWorkspace: string | null;
  /** Run plans no workspace imported on this call, with the refusal: `<planId>: <why>`. */
  unimportedPlans: string[];
  /** Imported setups the engine is known to refuse at validate (named so the slot reads Draft then Error): `<planId>: <why>`. */
  expectedToFail: string[];
}

/** Stored run plans that import as a valid document and then fail the engine's own compile. */
export const KNOWN_ENGINE_REFUSALS: ReadonlyArray<{ planId: string; reason: string }> = [
  {
    planId: "plan-synthetic-2500-v1-edit-2",
    reason: "its stacked set binds mma to nmd-decay and the plan's st-decay selector does not reach it; validate reports the engine's refusal",
  },
];

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface PlanOfWorkspace {
  id: string;
  type: WorkspaceType;
  name: string;
  bookId: string;
  baseMarketId: string;
  derived: Set<string>;
  sets: Set<string>;
  /** Sets rule 3 or rule 6 attached, in attach order (rule 12 fallback). */
  mapSets: string[];
  slates: Set<string>;
  balancePlans: Set<string>;
  hierarchies: Set<string>;
  routingPolicyId: string | null;
}

interface RunFacts {
  runId: string;
  portfolioId: string;
  marketId: string;
  setIds: string[];
  asOf: string | null;
}

const MAX_NAME = 80;
const EDIT_SHAPE = /^(.+)-edit-\d+$/;
const BALANCE_EDIT_SHAPE = /^bp-(.+)-edit-\d+$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function wsIdFor(prefix: string, bookId: string, taken: ReadonlySet<string>, marketId: string): string {
  let id = `${prefix}${bookId}`;
  if (id.length > 64) id = `${prefix}${bookId.slice(0, 40)}-${sha256Hex(bookId).slice(0, 8)}`;
  if (taken.has(id)) id = `${id.slice(0, 55)}-${sha256Hex(marketId).slice(0, 8)}`;
  return id;
}

class Inventory {
  readonly meta = new Map<Collection, DocumentMeta[]>();
  private readonly marketBase = new Map<string, string | null>();
  private readonly setBase = new Map<string, string | null>();

  constructor(private readonly store: FileStore) {}

  list(collection: Collection): DocumentMeta[] {
    let m = this.meta.get(collection);
    if (m === undefined) {
      m = this.store.listMeta(collection);
      this.meta.set(collection, m);
    }
    return m;
  }

  ids(collection: Collection): Set<string> {
    return new Set(this.list(collection).map((m) => m.id));
  }

  /** The market a derived market was derived from, or null for a base snapshot. */
  parentMarket(id: string): string | null {
    if (this.marketBase.has(id)) return this.marketBase.get(id)!;
    const meta = this.list("market").find((m) => m.id === id);
    let parent: string | null = meta === undefined ? null : str(meta.derivedFromMarketId);
    if (meta !== undefined && parent === null) {
      const doc = this.store.getDocument<{ derivedFrom?: { baseId?: unknown } }>("market", id).doc;
      parent = str(doc.derivedFrom?.baseId);
    }
    this.marketBase.set(id, parent);
    return parent;
  }

  /** The root of a derived market's chain (the market itself when it is a base). */
  rootMarket(id: string): string {
    let cur = id;
    for (let i = 0; i < 16; i++) {
      const p = this.parentMarket(cur);
      if (p === null) return cur;
      cur = p;
    }
    return cur;
  }

  /** The stored set this one derives from: derivedFrom.baseId, else the edit shape over a stored set, else null. */
  baseOfSet(id: string): string | null {
    if (this.setBase.has(id)) return this.setBase.get(id)!;
    const stored = this.ids("assumption-sets");
    const meta = this.list("assumption-sets").find((m) => m.id === id);
    let base: string | null = meta === undefined ? null : str(meta.derivedFromSetId);
    if (base === null && meta !== undefined) {
      const doc = this.store.getDocument<{ derivedFrom?: { baseId?: unknown } }>("assumption-sets", id).doc;
      base = str(doc.derivedFrom?.baseId);
    }
    if (base === null) {
      const m = EDIT_SHAPE.exec(id);
      if (m !== null && stored.has(m[1]!)) base = m[1]!;
    }
    if (base !== null && !stored.has(base)) base = null;
    this.setBase.set(id, base);
    return base;
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Runs no workspace attaches yet and no launch stamped: the migration's input (rule 11). */
function pendingRuns(store: FileStore, attached: ReadonlySet<string>): RunFacts[] {
  const out: RunFacts[] = [];
  for (const runId of store.listRunIds()) {
    if (attached.has(runId) || !store.runFileExists(runId, "request.json")) continue;
    // A launched run names its workspace; reconcile attaches it. Cheap text test before the parse.
    const bytes = store.readRunBytes(runId, "request.json");
    let req: { workspace?: { workspaceId?: unknown }; submission?: Record<string, unknown>; request?: { grid?: { asOf?: unknown } } };
    try {
      req = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (typeof req.workspace?.workspaceId === "string") continue;
    const sub = req.submission;
    if (sub === undefined || typeof sub.portfolioId !== "string" || typeof sub.marketId !== "string") continue;
    const setIds = Array.isArray(sub.assumptionSetIds) ? sub.assumptionSetIds.filter((s): s is string => typeof s === "string") : [];
    out.push({
      runId,
      portfolioId: sub.portfolioId,
      marketId: sub.marketId,
      setIds,
      asOf: typeof req.request?.grid?.asOf === "string" ? req.request.grid.asOf : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

export function seedWorkspaces(store: FileStore, wsStore: WorkspaceStore, now: () => string = () => new Date().toISOString()): WorkspaceSeedReport {
  const inv = new Inventory(store);
  const report: WorkspaceSeedReport = {
    created: [],
    unnamedAttachments: UNNAMED_SEED_ATTACHMENTS.map(
      (u) => `${u.collection}/${u.id} -> ${u.workspaceIds.join(", ")} (${u.reason})`,
    ),
    unattached: [],
    runsAttached: [],
    legacyWorkspace: null,
    unimportedPlans: [],
    expectedToFail: [],
  };

  const bookMetas = inv.list("portfolios");
  const bookMeta = new Map(bookMetas.map((m) => [m.id, m]));
  const marketIds = inv.ids("market");
  const setIds = inv.ids("assumption-sets");

  // Stored runs no workspace attaches yet.
  const alreadyAttached = new Set<string>();
  for (const h of wsStore.list()) for (const a of wsStore.readRunAttachments(h.id)) alreadyAttached.add(a.runId);
  const runs = pendingRuns(store, alreadyAttached);

  // Every stored run plan, once.
  const planDocs = new Map<string, RunPlan>();
  for (const m of inv.list("run-plans")) planDocs.set(m.id, store.getDocument<RunPlan>("run-plans", m.id).doc);

  const plans: PlanOfWorkspace[] = [];
  const taken = new Set<string>();
  const newPlan = (id: string, type: WorkspaceType, bookId: string, baseMarketId: string): PlanOfWorkspace => {
    const meta = bookMeta.get(bookId);
    const label = meta === undefined ? "" : String(meta.label ?? "");
    const p: PlanOfWorkspace = {
      id,
      type,
      name: (label.length > 0 ? label : id).slice(0, MAX_NAME),
      bookId,
      baseMarketId,
      derived: new Set(),
      sets: new Set(),
      mapSets: [],
      slates: new Set(),
      balancePlans: new Set(),
      hierarchies: new Set(),
      routingPolicyId: null,
    };
    plans.push(p);
    taken.add(id);
    return p;
  };

  const addMarket = (p: PlanOfWorkspace, marketId: string): void => {
    if (marketId === p.baseMarketId || !marketIds.has(marketId)) return;
    // A derived market's own parent must be in the block when it is not the base (parentKey names it).
    const parent = inv.parentMarket(marketId);
    if (parent !== null && parent !== p.baseMarketId) addMarket(p, parent);
    p.derived.add(marketId);
  };

  // Rule 1: one Test workspace per distinct (book, base market) pair among the seeded run plans.
  const seededPlanMetas = inv.list("run-plans").filter(isSeeded);
  const seededPlanIds = new Set(seededPlanMetas.map((m) => m.id));
  for (const m of seededPlanMetas) {
    const plan = planDocs.get(m.id)!;
    const book = plan.inputs.positionBook;
    const base = inv.rootMarket(plan.inputs.marketSnapshot);
    if (!bookMeta.has(book) || !marketIds.has(base)) continue;
    if (plans.some((p) => p.bookId === book && p.baseMarketId === base)) continue;
    newPlan(wsIdFor("ws-", book, taken, base), "test", book, base);
  }

  // Rule 2: what a plan of the pair names (any stored plan of the pair, seeded or edited).
  for (const doc of planDocs.values()) {
    const base = inv.rootMarket(doc.inputs.marketSnapshot);
    for (const p of plans) {
      if (p.bookId !== doc.inputs.positionBook || p.baseMarketId !== base) continue;
      addMarket(p, doc.inputs.marketSnapshot);
      for (const s of doc.inputs.assumptionSets ?? []) if (setIds.has(s)) p.sets.add(s);
      const bps = [doc.balancePlan, ...Object.values(doc.scenarioBalancePlans ?? {})];
      for (const b of bps) if (typeof b === "string") p.balancePlans.add(b);
      if (p.routingPolicyId === null && seededPlanIds.has(doc.planId)) p.routingPolicyId = doc.inputs.routingPolicy;
    }
  }

  // Rule 3: the Stress workspaces, then the hand map.
  for (const s of STRESS_WORKSPACES) {
    if (!bookMeta.has(s.bookId) || !marketIds.has(PUBLIC_MARKET) || plans.some((p) => p.id === s.id)) continue;
    newPlan(s.id, "stress", s.bookId, PUBLIC_MARKET);
  }
  for (const u of UNNAMED_SEED_ATTACHMENTS) {
    if (!store.has(u.collection, u.id)) continue;
    for (const wsId of u.workspaceIds) {
      const p = plans.find((x) => x.id === wsId);
      if (p === undefined) continue;
      if (u.collection === "market") addMarket(p, u.id);
      else if (u.collection === "assumption-sets") {
        p.sets.add(u.id);
        p.mapSets.push(u.id);
      } else if (u.collection === "plans") p.balancePlans.add(u.id);
    }
  }

  // Rule 6: a non-seed book with no workspace yet gets its own Test workspace on the public base market.
  // "No workspace yet" reads the heads on disk too: a book an analyst imported into a workspace (or a
  // retagged copy) after the migration is that workspace's, and the next boot creates nothing for it.
  const pinnedBooks = new Set<string>();
  for (const h of wsStore.list()) {
    const b = h.blocks.positions;
    if (b.book !== null) pinnedBooks.add(b.book.id);
    for (const r of b.retagged) pinnedBooks.add(r.id);
  }
  const baseMarketFallback = marketIds.has(PUBLIC_MARKET)
    ? PUBLIC_MARKET
    : inv.list("market").map((m) => m.id).find((id) => inv.parentMarket(id) === null) ?? null;
  for (const m of bookMetas) {
    if (isSeeded(m) || pinnedBooks.has(m.id) || plans.some((p) => p.bookId === m.id) || baseMarketFallback === null) continue;
    const p = newPlan(wsIdFor("ws-import-", m.id, taken, baseMarketFallback), "test", m.id, baseMarketFallback);
    const consumed: string[] = [];
    for (const r of runs) {
      if (r.portfolioId !== m.id) continue;
      for (const s of r.setIds) if (setIds.has(s) && !consumed.includes(s)) consumed.push(s);
    }
    const chosen = consumed.length > 0 ? consumed : setIds.has(VANILLA_EMPTY_SET) ? [VANILLA_EMPTY_SET] : [];
    for (const s of chosen) {
      p.sets.add(s);
      p.mapSets.push(s);
    }
  }

  // Rules 4 and 5 to a fixed point: sets follow their base; a set with no link follows a run on the book.
  const attachedSets = (): Set<string> => new Set(plans.flatMap((p) => [...p.sets]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of plans) {
      for (const id of setIds) {
        if (p.sets.has(id)) continue;
        const base = inv.baseOfSet(id);
        if (base !== null && p.sets.has(base)) {
          p.sets.add(id);
          changed = true;
        }
      }
    }
    const held = attachedSets();
    for (const r of runs) {
      for (const p of plans) {
        if (p.bookId !== r.portfolioId || inv.rootMarket(r.marketId) !== p.baseMarketId) continue;
        for (const s of r.setIds) {
          if (!setIds.has(s) || held.has(s)) continue;
          p.sets.add(s);
          held.add(s);
          changed = true;
        }
      }
    }
  }

  // Rule 11, first half: a run on a derived market the block does not yet hold adds it (creation only).
  for (const r of runs) {
    for (const p of plans) {
      if (p.bookId !== r.portfolioId || inv.rootMarket(r.marketId) !== p.baseMarketId) continue;
      if (!r.setIds.every((s) => p.sets.has(s))) continue;
      addMarket(p, r.marketId);
    }
  }

  // Rule 7: authored slates (launch slates carry fromPlan and are never listed in a block).
  for (const m of inv.list("scenario-slates")) {
    if (m.fromPlan !== undefined) continue;
    const doc = store.getDocument<{ scenarios?: Array<{ assumptionSetId?: unknown }> }>("scenario-slates", m.id).doc;
    const named = new Set((doc.scenarios ?? []).map((s) => s.assumptionSetId).filter((s): s is string => typeof s === "string"));
    if (named.size === 0) continue;
    for (const p of plans) if ([...named].every((s) => p.sets.has(s))) p.slates.add(m.id);
  }

  // Rule 8: balance plans. checkedBookId, else bp-<bookId>-edit-<n>, else derivedFrom, else the map (applied above).
  const planMetas = inv.list("plans");
  const derivedPlans: Array<{ id: string; base: string }> = [];
  for (const m of planMetas) {
    const checked = str(m.checkedBookId);
    if (checked !== null) {
      for (const p of plans) if (p.bookId === checked) p.balancePlans.add(m.id);
      continue;
    }
    const shape = BALANCE_EDIT_SHAPE.exec(m.id);
    if (shape !== null && bookMeta.has(shape[1]!)) {
      for (const p of plans) if (p.bookId === shape[1]) p.balancePlans.add(m.id);
      continue;
    }
    let base = str(m.derivedFromPlanId);
    if (base === null) {
      const doc = store.getDocument<{ derivedFrom?: { baseId?: unknown } }>("plans", m.id).doc;
      base = str(doc.derivedFrom?.baseId);
    }
    if (base !== null) derivedPlans.push({ id: m.id, base });
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of derivedPlans) {
      for (const p of plans) {
        if (p.balancePlans.has(d.base) && !p.balancePlans.has(d.id)) {
          p.balancePlans.add(d.id);
          changed = true;
        }
      }
    }
  }

  // Rule 9: hierarchies by checkedBookId.
  for (const m of inv.list("hierarchies")) {
    const checked = str(m.checkedBookId);
    if (checked === null) continue;
    for (const p of plans) if (p.bookId === checked) p.hierarchies.add(m.id);
  }

  // The shared singletons: lenses, the routing policy, the COA.
  const lensIds = inv.list("lens").map((m) => m.id);
  const policyMetas = inv.list("routing-policies");
  const coaMetas = inv.list("coa");

  // ---- create the absent workspaces -------------------------------------------------------
  const stamp = now();
  const refOf = (collection: Collection, id: string): DocRef => ({
    collection,
    id,
    contentHash: store.getMeta(collection, id).contentHash,
    pinnedAt: stamp,
  });
  const lineageOfPlan = (planId: string): string => `setup-${planId}`;

  for (const p of plans) {
    if (wsStore.has(p.id)) continue;

    const blocks = emptyBlocks();
    blocks.positions.book = refOf("portfolios", p.bookId);
    const coa = preferSeeded(coaMetas);
    if (coa !== undefined) blocks.positions.coa = refOf("coa", coa.id);
    const taxId = str(store.getDocument<{ taxonomy?: { id?: unknown } }>("portfolios", p.bookId).doc.taxonomy?.id);
    if (taxId !== null && store.has("taxonomy", taxId)) blocks.positions.taxonomy = refOf("taxonomy", taxId);
    blocks.positions.hierarchies = [...p.hierarchies].sort().map((id) => refOf("hierarchies", id));

    blocks.market.snapshot = refOf("market", p.baseMarketId);
    blocks.market.derived = [...p.derived].sort().map((id): DerivedRef => {
      const parent = inv.parentMarket(id);
      return { ...refOf("market", id), definitionKey: id, parentKey: parent === null || parent === p.baseMarketId ? null : parent };
    });

    blocks.targets.balancePlans = [...p.balancePlans].filter((id) => store.has("plans", id)).sort().map((id) => refOf("plans", id));

    // Rule 12: the default set, then the rest sorted.
    const seededPlan = inv.list("run-plans").find((m) => m.id === `plan-${p.bookId}` && isSeeded(m));
    const named = seededPlan === undefined ? null : planDocs.get(seededPlan.id)?.inputs.assumptionSets?.[0] ?? null;
    const defaultSetId =
      named !== null && p.sets.has(named) ? named : p.mapSets.find((s) => p.sets.has(s)) ?? [...p.sets].sort()[0] ?? null;
    const ordered = [...p.sets].sort().filter((s) => s !== defaultSetId);
    blocks.assumptions.sets = (defaultSetId === null ? ordered : [defaultSetId, ...ordered]).map((id) => refOf("assumption-sets", id));
    blocks.assumptions.defaultSetId = defaultSetId;
    const policyId = p.routingPolicyId ?? preferSeeded(policyMetas)?.id ?? null;
    if (policyId !== null && store.has("routing-policies", policyId)) blocks.assumptions.routingPolicy = refOf("routing-policies", policyId);

    blocks.scenarios.slates = [...p.slates].sort().map((id) => refOf("scenario-slates", id));
    blocks.run.lenses = lensIds.map((id) => refOf("lens", id));

    const draft: WorkspaceManifest = {
      schemaVersion: "1.0.0",
      id: p.id,
      name: p.name,
      type: p.type,
      status: "active",
      cutoffDate: String(bookMeta.get(p.bookId)?.asOf ?? ""),
      owner: SEED_BY,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 0,
      blocks,
      blockHashes: blockHashes(blocks),
      signedHash: "",
      manifestHash: "",
      lineage: { mode: "seed", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false },
      clashes: [],
      lock: null,
      note: "Derived from the stored documents by the seed's migration rule.",
    };

    // The Standard ALCO slot, then rule 10: every run plan of this pair, imported.
    const putSetup = (setup: RunSetup): DocRef => {
      if (!store.has("run-setups", setup.id)) store.putDocument("run-setups", setup.id, setup, { label: setup.name, workspaceId: p.id });
      return refOf("run-setups", setup.id);
    };
    const slots: SetupSlot[] = [];
    slots.push({
      setupLineageId: `setup-${sha256Hex(JSON.stringify([p.id, "standard-alco"])).slice(0, 8)}`,
      current: putSetup(standardAlcoSetup(p.id)),
    });
    for (const [planId, doc] of [...planDocs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (doc.inputs.positionBook !== p.bookId || inv.rootMarket(doc.inputs.marketSnapshot) !== p.baseMarketId) continue;
      let setup: RunSetup;
      try {
        setup = importPlanAsSetup(doc, draft);
      } catch (err) {
        report.unimportedPlans.push(`${planId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      slots.push({ setupLineageId: lineageOfPlan(planId), current: putSetup(setup) });
      const known = KNOWN_ENGINE_REFUSALS.find((k) => k.planId === planId);
      if (known !== undefined) report.expectedToFail.push(`${planId}: ${known.reason}`);
    }
    draft.blocks.run.setups = slots;
    draft.blockHashes = blockHashes(draft.blocks);

    wsStore.create(draft, SEED_BY);
    report.created.push(p.id);
  }

  // ---- rule 11, second half: attach every pending run ---------------------------------------
  const heads = wsStore.list();
  const matches = (h: WorkspaceManifest, r: RunFacts): boolean => {
    const book = h.blocks.positions.book;
    const books = [book?.id, ...h.blocks.positions.retagged.map((b) => b.id)];
    if (!books.includes(r.portfolioId)) return false;
    const snapshot = h.blocks.market.snapshot;
    if (snapshot === null) return false;
    const marketOk = r.marketId === snapshot.id || h.blocks.market.derived.some((d) => d.id === r.marketId) || inv.rootMarket(r.marketId) === snapshot.id;
    if (!marketOk) return false;
    const held = new Set(h.blocks.assumptions.sets.map((s) => s.id));
    return r.setIds.every((s) => held.has(s));
  };
  // Only an active, unlocked head takes a run: a run the lock never saw must not land in a signed
  // month's Results, and an archived or superseded head is read-only history (review M3).
  const open = heads.filter((h) => h.status === "active" && h.lock === null);
  for (const r of runs) {
    let target = open.filter((h) => matches(h, r)).map((h) => h.id).sort()[0];
    if (target === undefined) {
      const asOf = r.asOf ?? str(bookMeta.get(r.portfolioId)?.asOf);
      if (asOf === null) {
        // No as-of to name a legacy workspace by: left unattached and listed, never invented.
        report.unattached.push(`runs/${r.runId}`);
        continue;
      }
      target = `ws-legacy-${asOf}`;
      if (!wsStore.has(target)) {
        const blocks = emptyBlocks();
        const coa = preferSeeded(coaMetas);
        if (coa !== undefined) blocks.positions.coa = refOf("coa", coa.id);
        blocks.run.lenses = lensIds.map((id) => refOf("lens", id));
        const alco = standardAlcoSetup(target);
        if (!store.has("run-setups", alco.id)) store.putDocument("run-setups", alco.id, alco, { label: alco.name, workspaceId: target });
        blocks.run.setups = [
          { setupLineageId: `setup-${sha256Hex(JSON.stringify([target, "standard-alco"])).slice(0, 8)}`, current: refOf("run-setups", alco.id) },
        ];
        wsStore.create(
          {
            schemaVersion: "1.0.0",
            id: target,
            name: `Legacy runs as of ${asOf}`,
            type: "test",
            status: "archived",
            cutoffDate: asOf,
            owner: SEED_BY,
            createdAt: stamp,
            updatedAt: stamp,
            revision: 0,
            blocks,
            blockHashes: blockHashes(blocks),
            signedHash: "",
            manifestHash: "",
            lineage: { mode: "seed", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false },
            clashes: [],
            lock: null,
            note: "Holds stored runs that matched no seeded workspace; read-only history.",
          },
          SEED_BY,
        );
        report.created.push(target);
      }
      report.legacyWorkspace = target;
    }
    const line: RunAttachment = { runId: r.runId, attachedBy: MIGRATION_BY, at: stamp, pins: "reconstructed" };
    wsStore.appendRunAttachment(target, line);
    report.runsAttached.push(`${r.runId} -> ${target}`);
  }

  // ---- what no workspace holds, read from the heads on disk ---------------------------------
  const held = new Map<Collection, Set<string>>();
  const hold = (c: Collection, id: string | undefined): void => {
    if (id === undefined) return;
    let s = held.get(c);
    if (s === undefined) held.set(c, (s = new Set()));
    s.add(id);
  };
  for (const h of wsStore.list()) {
    const b = h.blocks;
    hold("portfolios", b.positions.book?.id);
    for (const r of b.positions.retagged) hold("portfolios", r.id);
    hold("coa", b.positions.coa?.id);
    hold("taxonomy", b.positions.taxonomy?.id);
    for (const r of b.positions.hierarchies) hold("hierarchies", r.id);
    hold("market", b.market.snapshot?.id);
    for (const d of b.market.derived) hold("market", d.id);
    for (const r of b.targets.balancePlans) hold("plans", r.id);
    for (const r of b.assumptions.sets) hold("assumption-sets", r.id);
    hold("routing-policies", b.assumptions.routingPolicy?.id);
    for (const r of b.scenarios.slates) hold("scenario-slates", r.id);
    for (const r of b.run.lenses) hold("lens", r.id);
    for (const s of b.run.setups) {
      try {
        const from = store.getDocument<RunSetup>("run-setups", s.current.id).doc.importedFrom;
        if (from !== null) hold("run-plans", from);
      } catch {
        // A pinned setup the store lost is readiness's finding, not the seed's.
      }
    }
  }
  const covered: Array<[Collection, DocumentMeta[]]> = [
    ["portfolios", inv.list("portfolios")],
    ["market", inv.list("market")],
    ["assumption-sets", inv.list("assumption-sets")],
    ["scenario-slates", inv.list("scenario-slates").filter((m) => m.fromPlan === undefined)],
    ["plans", inv.list("plans")],
    ["run-plans", inv.list("run-plans")],
    ["lens", inv.list("lens")],
    ["coa", inv.list("coa")],
    ["taxonomy", inv.list("taxonomy")],
    ["routing-policies", inv.list("routing-policies")],
    ["hierarchies", inv.list("hierarchies")],
  ];
  const missing = new Set<string>(report.unattached);
  for (const [collection, metas] of covered) {
    for (const m of metas) if (!(held.get(collection)?.has(m.id) ?? false)) missing.add(`${collection}/${m.id}`);
  }
  report.unattached = [...missing].sort();
  return report;
}

/** The report as log lines, `prefix` first on each (main.ts: "platform:", the CLI: "seed:"). */
export function formatWorkspaceSeedReport(report: WorkspaceSeedReport, prefix: string): string[] {
  const out: string[] = [];
  for (const id of report.created) out.push(`${prefix} seeded workspace ${id}`);
  for (const r of report.runsAttached) out.push(`${prefix} attached run ${r}`);
  if (report.created.length > 0) {
    for (const line of report.unnamedAttachments) out.push(`${prefix} attached by the seed map: ${line}`);
    for (const line of report.expectedToFail) out.push(`${prefix} imported setup expected to fail validate: ${line}`);
    for (const line of report.unimportedPlans) out.push(`${prefix} run plan not imported as a setup: ${line}`);
  }
  for (const u of report.unattached) {
    const hand = UNATTACHED_SEED_DOCUMENTS.find((d) => `${d.collection}/${d.id}` === u);
    out.push(`${prefix} in no workspace: ${u}${hand === undefined ? "" : ` (${hand.reason})`}`);
  }
  return out;
}
