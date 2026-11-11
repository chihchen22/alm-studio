/**
 * Seed the platform store: the practitioner has something
 * to run before their first import.
 *
 *   - the vanilla 9-position book and a reduced synthetic book (@alm/data,
 *     the proven fixture path; the synthetic book is a pure function of the
 *     committed generator seed);
 *   - the same synthetic book tagged hqla-level (cash and investments l1, mbs
 *     l2a) under its own one-dimension taxonomy, for the survival-horizon
 *     metric;
 *   - the same book again with liability families tagged lcr-category,
 *     under a two-dimension taxonomy, for lcr-regulatory;
 *   - that book once more, under a three-dimension taxonomy, extended
 *     with an ILLUSTRATIVE undrawn committed-line book tagged
 *     commitment-category, plus the joint squeeze set and its static slate;
 *   - the Lab public market pack (Treasury CMT par yields,
 *     packages/kernel/public/market_public.json); the platform binds
 *     127.0.0.1 and deploy is declined;
 *   - the public market again with the term liquidity premium nodes raised by
 *     50 bp (derived through deriveMarketSnapshot, so the
 *     seeded bytes equal what the market derive route writes), under a new id,
 *     with no seeded run or plan pointing at it;
 *   - the public market again with three demonstration rate indices (Studio
 *     Derived through deriveMarketSnapshot, so the seeded bytes equal
 *     what the market derive route writes), under a new id, together with the
 *     synthetic book again with three floaters naming those indices and the plan
 *     that runs that book on that market;
 *   - the public market again with every constructed short-rate volatility
 *     times 1.5 (derived through deriveMarketSnapshot, so the
 *     seeded bytes equal what the market derive route writes), under a new id,
 *     with demonstration values and no seeded run or plan pointing at it;
 *   - the demo behavioral assumption set and the vanilla empty set, both bound
 *     through the engine (contentHash engine-filled, never by hand);
 *   - one "Regulatory grid" scenario slate per seeded assumption set, built
 *     from REGULATORY_SHOCKS_BP;
 *   - the demo loan repricing set (the demo bindings plus a flat-carry
 *     client rate on mortgages) with its own slate and plan, under new ids;
 *   - the demo behavioral set again with the deposit decay parameters scaled
 *     by 1.25 (derived through deriveAssumptionSet, so the
 *     seeded bytes equal what the derive route writes), with its own slate;
 *   - the deposit targets balance plan and its derived shock plan (Studio piece
 *     6b: derived through deriveBalancePlan, so the seeded bytes equal what the
 *     derive route writes), in the plans collection;
 *   - the demo chart of accounts for CSV intake (`coaId` targeting);
 *   - the demo dimension taxonomy for CSV tag columns (`taxonomyId` targeting);
 *   - the six demo lens definitions (pieces 3a to 3c) the run lens routes score a run through;
 *   - the behavioral routing policy the plan routing gate enforces.
 *
 * That list is the default "demo" profile. ALM_SEED_PROFILE may name a profile a
 * loaded pack registered (src/registry.ts), which seeds its own documents
 * and workspaces instead; the default plan is byte-identical either way
 * (seedProfileDemoUnchanged.test.ts).
 *
 * Idempotent: an id that already exists is skipped (the store is append-only;
 * nothing is overwritten). A skipped SEEDED document whose stored bytes differ
 * from what this code writes today is reported STALE. Run directly:
 * npx tsx apps/server/scripts/seed-store.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadMarketSnapshot,
  BETA_S_CURVE_DEFAULTS,
  MBS_DEFAULTS,
  NMD_DEFAULTS,
  type MarketSnapshot,
} from "@alm/kernel";
import { bindAssumptions, deriveAssumptionSet } from "@alm/engine/src/scenario";
import { deriveMarketSnapshot, type MarketDeriveResult } from "@alm/engine/src/market";
import { deriveBalancePlan, lowerBalancePlan, parseRoutingPolicy, REGULATORY_SHOCKS_BP, validateDimensions, validateLens } from "@alm/engine";
import type {
  AssumptionSet,
  BalancePlan,
  CommitmentTerms,
  DimensionTaxonomy,
  LensDefinition,
  Position,
  ProductFamilyDef,
  Scenario,
} from "@alm/engine";
import { EMPTY_DRAW_PATH, validateCommitmentTerms } from "@alm/engine/src/commitment/terms";
import { validateSwapTerms, type SwapTerms } from "@alm/engine/src/swap";
import {
  buildChartOfAccounts,
  buildVanillaPortfolio,
  vanillaAssumptionSet,
  vanillaScenarios,
  generatePortfolio,
  DEFAULT_GENERATOR_CONFIG,
} from "@alm/data";
import { buildDemoAssumptions, buildDemoScenarios, buildLoanRepricingAssumptions } from "@alm/data/src/demo/request";
import { FileStore, serializeDocument, sha256Hex, type SupersededRecord } from "../src/store/store";
import type { Collection } from "../src/store/paths";
import { resolveConfig, type SeedProfile } from "../src/config";
import { loadCompanion } from "../src/companion";
import { CORE_SEED_PROFILE, NO_WORKSPACE_PROFILES, seedProfileEntry } from "../src/registry";
import { defaultDbPath, openPlatformDb } from "../src/db/database";
import { syncStoreToDb, type DbSyncReport } from "../src/db/ingest";
import type { PortfolioSpec } from "@alm/engine";
import { buildSeedRunPlans } from "./seedRunPlans";
import { DEMO_BOOK_ID, featureDemos, featureDemoSets } from "../src/examples/featureDemos";
import { depositFormDemos, depositFormSets } from "../src/examples/depositForms";
import { survivalPathDemos } from "../src/examples/survivalPathDemo";
import { buildMacroDemoOps, MACRO_DEMO_LABEL } from "./macroSeed";
import { derivedSetMeta } from "../src/derivedSets/derivedSets";
import { derivedBalancePlanMeta } from "../src/derivedSets/derivedBalancePlans";
import { derivedMarketMeta } from "../src/derivedSets/derivedMarkets";
import { checkAgainstBook, validateHierarchy, type Hierarchy } from "../src/hierarchies/hierarchy";
import { namingWorkspaces, repinSeedOnly, type Repin } from "../src/workspaces/seedPins";
import { WorkspaceStore } from "../src/workspaces/workspaceStore";
import { formatWorkspaceSeedReport, seedWorkspaces, type WorkspaceSeedReport } from "./seed-workspaces";

export const SEED_IDS = {
  vanillaPortfolio: "vanilla-book-v1",
  syntheticPortfolio: "synthetic-2500-v1",
  // The synthetic book again, with cash, investments and mbs tagged
  // hqla-level for the survival-horizon buffer, under its own taxonomy.
  hqlaPortfolio: "synthetic-2500-hqla-v1",
  hqlaTaxonomy: "hqla-tags-v1",
  // The hqla book again, liability families tagged lcr-category for
  // lcr-regulatory, under a two-dimension taxonomy.
  lcrPortfolio: "synthetic-2500-lcr-v1",
  liquidityTaxonomy: "liquidity-tags-v1",
  // The lcr book again, plus an undrawn committed-line book tagged
  // commitment-category, under a three-dimension taxonomy. A NEW taxonomy and a
  // NEW book: `liquidity-tags-v1` and `synthetic-2500-lcr-v1` both carry pinned
  // content hashes and are not edited.
  commitmentPortfolio: "synthetic-2500-commit-v1",
  liquidityTaxonomyV2: "liquidity-tags-v2",
  // The synthetic book again, plus three ILLUSTRATIVE pay-fixed swaps
  // in one swap family (side "derivative"). A NEW book: synthetic-2500-v1 is
  // not edited.
  hedgedPortfolio: "synthetic-2500-hedged-v1",
  // The lcr book's liability positions only, every one tagged lcr-category, under the same taxonomy, so a view over a level of the seeded hierarchy validates on its re-tagged copy. A NEW book: synthetic-2500-lcr-v1 is not edited.
  lcrLiabilityPortfolio: "synthetic-lcr-liabilities-v1",
  // The synthetic book again with three floaters naming a demonstration rate index. A NEW book: synthetic-2500-v1 is not edited.
  indexedPortfolio: "synthetic-2500-indexed-v1",
  market: "market-public-2026-03-31",
  // The public market again with the TLP nodes moved by +50 bp
  // (derived, demonstration values), under a NEW id. No seeded run or plan binds it.
  fundingSpreadShockMarket: "tlp-shock-demo-v1",
  // The public market again carrying three demonstration rate
  // indices (derived, demonstration values), under a NEW id. Only the indexed
  // plan binds it.
  rateIndexMarket: "rate-indices-demo-v1",
  // The public market again with every constructed short-rate
  // volatility times 1.5 (derived, demonstration values), under a NEW id. No
  // seeded run or plan binds it.
  volShockMarket: "vol-shock-demo-v1",
  // The public market again carrying two FRED histories cut at
  // the as-of and three authored house-price projections (derived, demonstration
  // values), under a NEW id. The three macro plans bind it.
  macroMarket: "macro-demo-v1",
  demoAssumptions: "demo-behavioral-v1",
  vanillaAssumptions: "vanilla-empty-v1",
  demoSlate: "regulatory-grid-demo",
  vanillaSlate: "regulatory-grid-vanilla",
  stressAssumptions: "stress-illustrative-v1",
  stressSlate: "regulatory-grid-stress",
  // The ILLUSTRATIVE liquidity stress, as engine input.
  liquidityAssumptions: "liquidity-stress-demo-v1",
  liquiditySlate: "liquidity-grid-stress",
  // The JOINT squeeze, the 5c deposit run-off unchanged plus
  // committed-line draws, run on a static slate so wholesale does not roll.
  squeezeAssumptions: "liquidity-squeeze-demo-v1",
  squeezeSlate: "liquidity-grid-squeeze",
  // The demo set again plus one flat-carry loan client-rate binding on
  // mortgages, under NEW ids (nothing stored goes stale), and its slate.
  loanRepricingAssumptions: "loan-repricing-demo-v1",
  loanRepricingSlate: "regulatory-grid-loan-repricing",
  // The demo set again with the illustrative house-price
  // response on mortgages and mbs, mapped to hpi-down-30 and to hpi-flat, under
  // NEW ids (nothing stored goes stale).
  housingAssumptions: "housing-demo-v1",
  housingFlatAssumptions: "housing-flat-demo-v1",
  // The demo set with the deposit decay parameters scaled by
  // 1.25 (derived, demonstration values), and its slate, under NEW ids.
  decayShockAssumptions: "decay-shock-demo-v1",
  decayShockSlate: "regulatory-grid-decay-shock",
  // A deposit target plan on the synthetic book (demonstration
  // values) and the plan derived from it by one balance shock, under NEW ids.
  // Written by the seed from slice 4; slice 1 only builds them.
  demoBalancePlan: "balance-targets-demo-v1",
  balanceShockPlan: "balance-shock-demo-v1",
  demoCoa: "demo-coa-v1",
  // The example bank's chart of accounts, for the v2 CSV template.
  exampleBankCoa: "mid-size-bank-coa-v1",
  demoTaxonomy: "demo-dimensions-v1",
  demoLenses: [
    "liquidity-demo-v1",
    "rate-demo-v1",
    "capital-demo-v1",
    "strategy-demo-v1",
    // Reads the shipped demonstration custom metric, and reports
    // unobservable on a run whose plan named no custom metric stage.
    "balance-demo-v1",
    // Reads the second built-in custom metric, `wal-gap`.
    "wal-gap-demo-v1",
  ],
  // One ILLUSTRATIVE hierarchy over lcr-category, demonstration values, not a regulatory mapping
  demoHierarchy: "liquidity-funding-demo-v1",
  routingPolicy: "model-map-default-v1",
  runPlans: [
    "plan-synthetic-2500-v1",
    "plan-synthetic-2500-hedged-v1",
    "plan-vanilla-book-v1",
    // The synthetic book on the loan repricing set, appended last.
    "plan-synthetic-2500-loan-repricing-v1",
    // The liability book, contractual only, appended last.
    "plan-synthetic-lcr-liabilities-v1",
    // The indexed book on the rate indices market, appended last.
    "plan-synthetic-2500-indexed-v1",
    // The synthetic book on the macro factors market, unmapped, on hpi-down-30 and on hpi-flat, appended last.
    "plan-synthetic-2500-macro-unmapped-v1",
    "plan-synthetic-2500-housing-v1",
    "plan-synthetic-2500-housing-flat-v1",
  ],
} as const;

/** A seeded id the seed no longer writes (2026-09-24). */
export interface RetiredSeedId {
  collection: Collection;
  id: string;
  reason: string;
}

/**
 * Ids an older seed wrote and today's seed does not. A store that still holds
 * one is reported on every boot and check; it moves aside only on
 * `--retire <collection>/<id>`, never on a default seed.
 */
export const RETIRED_SEED_IDS: readonly RetiredSeedId[] = [
  {
    collection: "market",
    id: "market-2026-03-31",
    // Same asOf as the public pack and first by id, so Studio would default to it.
    reason: "earlier market snapshot, replaced by market-public-2026-03-31",
  },
];

const SYNTHETIC_POSITIONS = 2_500;

/** One document the seed writes: where it goes, its body, and the meta beside it. */
export interface SeedDocument {
  collection: Collection;
  id: string;
  doc: unknown;
  meta: Record<string, unknown>;
}

/** One differing JSON path between a stored document and today's (report only). */
export interface DiffEntry {
  path: string;
  stored: unknown;
  current: unknown;
}

/** A seeded document whose stored hash is not the hash of what the seed writes today. */
export interface StaleDocument {
  collection: Collection;
  id: string;
  storedHash: string;
  currentHash: string;
  /** Up to five differing paths; the hash comparison is the test of record. */
  differences: DiffEntry[];
}

/** A retired seed id the store still holds, with the stored runs that name it. */
export interface RetiredDocument extends RetiredSeedId {
  runs: string[];
}

export interface SeedReport {
  written: string[];
  skipped: string[];
  /** Skipped seeded documents that differ from what the seed writes today. */
  stale: StaleDocument[];
  /** Retired seed ids the store still holds (read after any --retire move). */
  retired: RetiredDocument[];
  /** Check mode only: planned seeded documents the store does not hold. */
  missing?: string[];
  /** Refresh and retire modes only: the documents moved into superseded/<stamp>/. */
  superseded?: SupersededRecord[];
  /** File-store -> database mirror report. */
  dbSync?: DbSyncReport;
  /** Default seed only (Studio A+E contract 10): the workspaces derived from the store, and what no workspace holds. */
  workspaces?: WorkspaceSeedReport;
  /** Refresh mode only: the workspace pins moved to the new hash (spec A+E Section 2.6). */
  repinned?: Repin[];
}

export function portfolioDocument(spec: PortfolioSpec): SeedDocument {
  const byFamily = new Map<string, number>();
  for (const p of spec.positions) byFamily.set(p.familyId, (byFamily.get(p.familyId) ?? 0) + 1);
  // Notional sums by side: intake-plane arithmetic on inputs (design D-P6,
  // labeled); equity is the derived plug. Same fold as the import route.
  const sideOf = new Map(spec.coa.families.map((f) => [f.id, f.side]));
  let assets = 0;
  let liabilities = 0;
  // A commitment is OFF balance sheet. Its `notional` is undrawn
  // OPTIONAL CAPACITY, not a booked balance, so folding it in would inflate
  // total assets and, since equity is the derived plug, inflate equity by the
  // whole undrawn book. It is reported on its own line instead. The commit
  // family's own COA node is a root for the same reason, but this fold keys on
  // the family's SIDE rather than on tree position, so the node placement alone
  // does not keep it out.
  let commitmentsUndrawn = 0;
  // A swap has no booked balance. Its notional is reported on its own
  // line and folded into neither side, or the derived equity plug would drop
  // by the whole hedge (the old else-branch counted it as a liability).
  let swapNotional = 0;
  for (const p of spec.positions) {
    if (p.terms.type === "commitment") commitmentsUndrawn += p.terms.notional;
    else if (p.terms.type === "swap") swapNotional += p.terms.notional;
    else if (sideOf.get(p.familyId) === "asset") assets += p.terms.notional;
    else liabilities += p.terms.notional;
  }
  return {
    collection: "portfolios",
    id: spec.id,
    doc: spec,
    meta: {
      label: spec.label,
      asOf: spec.asOf,
      positionCount: spec.positions.length,
      intake: {
        basis: "intake statistics, not engine output",
        positionCount: spec.positions.length,
        positionsByFamily: spec.coa.families.map((f) => ({
          familyId: f.id,
          positions: byFamily.get(f.id) ?? 0,
        })),
        assets,
        liabilities,
        equity: assets - liabilities,
        // Emitted only for a book that carries commitments, so the metadata of
        // every book seeded before piece 7 stays byte-for-byte as it was.
        ...(commitmentsUndrawn > 0 ? { commitmentsUndrawn } : {}),
        // Emitted only for a book that carries swaps, so every earlier book's
        // metadata stays byte-for-byte as it was.
        ...(swapNotional > 0 ? { swapNotional } : {}),
      },
      seeded: true,
    },
  };
}

/** A tagged book, validated against its own taxonomy so a drift refuses at seed time. */
export function validatedPortfolio(spec: PortfolioSpec, taxonomyId: string): PortfolioSpec {
  const problems = validateDimensions(spec);
  if (problems.length > 0) {
    throw new Error(
      `seed: portfolio "${spec.id}" is not valid against "${taxonomyId}": ` +
        problems.map((p) => `${p.rule} ${p.dimension}: ${p.message}`).join("; "),
    );
  }
  return spec;
}

export function setDocument(raw: AssumptionSet): SeedDocument {
  const bound = bindAssumptions(raw);
  return {
    collection: "assumption-sets",
    id: bound.id,
    doc: bound,
    meta: {
      label: bound.label,
      bindingsContentHash: bound.contentHash,
      bindingCount: bound.bindings.length,
      seeded: true,
    },
  };
}

/** A derived set: already bound by the derivation; the meta adds the derivation record. */
function derivedSetDocument(set: AssumptionSet): SeedDocument {
  return {
    collection: "assumption-sets",
    id: set.id,
    doc: set,
    meta: { ...derivedSetMeta(set), seeded: true },
  };
}

/** A hand-authored balance plan: the meta the plain POST writes, plus seeded. */
function balancePlanDocument(plan: BalancePlan): SeedDocument {
  return {
    collection: "plans",
    id: plan.id,
    doc: plan,
    meta: { label: plan.label, asOf: plan.asOf, targetCount: plan.targets.length, seeded: true },
  };
}

/** A derived balance plan: the derive route's meta (checked against the synthetic book), plus seeded. */
function derivedBalancePlanDocument(plan: BalancePlan): SeedDocument {
  return {
    collection: "plans",
    id: plan.id,
    doc: plan,
    meta: { ...derivedBalancePlanMeta(plan, SEED_IDS.syntheticPortfolio), seeded: true },
  };
}

export function slateDocument(id: string, label: string, scenarios: Scenario[]): SeedDocument {
  return {
    collection: "scenario-slates",
    id,
    doc: { id, label, scenarios },
    meta: { label, scenarioCount: scenarios.length, scenarioIds: scenarios.map((s) => s.id), seeded: true },
  };
}

/**
 * Up to `limit` differing leaf paths between two JSON values, keys in sorted
 * order, array indices in order. For the STALE report only.
 */
export function diffPaths(stored: unknown, current: unknown, limit = 5): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= limit) return;
    const aObj = a !== null && typeof a === "object";
    const bObj = b !== null && typeof b === "object";
    if (aObj && bObj && Array.isArray(a) === Array.isArray(b)) {
      if (Array.isArray(a)) {
        const bArr = b as unknown[];
        for (let i = 0; i < Math.max(a.length, bArr.length); i++) walk(a[i], bArr[i], `${path}[${i}]`);
      } else {
        const ar = a as Record<string, unknown>;
        const br = b as Record<string, unknown>;
        const keys = [...new Set([...Object.keys(ar), ...Object.keys(br)])].sort();
        for (const k of keys) walk(ar[k], br[k], path === "" ? k : `${path}.${k}`);
      }
      return;
    }
    if (a !== b) out.push({ path: path === "" ? "(root)" : path, stored: a, current: b });
  };
  walk(stored, current, "");
  return out;
}

/** The printed STALE block for one stale document (CLI and boot). */
export function formatStaleBlock(s: StaleDocument): string[] {
  const show = (v: unknown): string => {
    if (v === undefined) return "(absent)";
    const t = JSON.stringify(v);
    return t.length > 80 ? `${t.slice(0, 77)}...` : t;
  };
  return [
    `seed: STALE ${s.collection}/${s.id}`,
    `seed:   stored  ${s.storedHash}`,
    `seed:   current ${s.currentHash}`,
    ...s.differences.map((d) => `seed:   at ${d.path}: stored ${show(d.stored)}, current ${show(d.current)}`),
    `seed:   refresh with: npm run platform:seed -- --refresh ${s.collection}/${s.id}`,
  ];
}

/** The printed RETIRED block for one retired document the store still holds (CLI and boot). */
export function formatRetiredBlock(r: RetiredDocument): string[] {
  const key = `${r.collection}/${r.id}`;
  return [
    `seed: RETIRED ${key}`,
    `seed:   ${r.reason}`,
    ...(r.runs.length > 0
      ? [
          `seed:   named by ${r.runs.length} stored run(s): ${r.runs.join(", ")}`,
          `seed:   move those run directories out of runs/ first; --retire refuses while a run names it`,
        ]
      : []),
    `seed:   retire with: npm run platform:seed -- --retire ${key}`,
  ];
}

/** Stored run ids whose request names the document (the links the database rebuild requires). */
function runsNaming(store: FileStore, collection: Collection, id: string): string[] {
  const out: string[] = [];
  for (const runId of store.listRunIds()) {
    if (!store.runFileExists(runId, "request.json")) continue;
    const req = store.readRunJson<{
      portfolioRef?: { id?: string };
      submission?: { marketId?: string; scenarioSlateId?: string; assumptionSetIds?: string[] };
    }>(runId, "request.json");
    const sub = req.submission;
    const names =
      (collection === "market" && sub?.marketId === id) ||
      (collection === "scenario-slates" && sub?.scenarioSlateId === id) ||
      (collection === "assumption-sets" && (sub?.assumptionSetIds ?? []).includes(id)) ||
      (collection === "portfolios" && req.portfolioRef?.id === id);
    if (names) out.push(runId);
  }
  return out;
}

/** Retired seed ids the store still holds. Reads only. */
function retiredInStore(store: FileStore): RetiredDocument[] {
  return RETIRED_SEED_IDS.filter((r) => store.has(r.collection, r.id)).map((r) => ({
    ...r,
    runs: runsNaming(store, r.collection, r.id),
  }));
}

type Standing =
  | { kind: "absent" }
  | { kind: "current" }
  | { kind: "not-seeded" }
  | { kind: "stale"; finding: StaleDocument };

/**
 * Where one planned document stands against the store. Reads only; the hash
 * compared is exactly the one FileStore.putDocument records.
 */
function standingOf(store: FileStore, d: SeedDocument): Standing {
  if (!store.has(d.collection, d.id)) return { kind: "absent" };
  const meta = store.getMeta(d.collection, d.id);
  if (meta.seeded !== true) return { kind: "not-seeded" };
  const bytes = serializeDocument(d.doc);
  const currentHash = sha256Hex(bytes);
  if (meta.contentHash === currentHash) return { kind: "current" };
  const stored = store.getDocument<unknown>(d.collection, d.id).doc;
  return {
    kind: "stale",
    finding: {
      collection: d.collection,
      id: d.id,
      storedHash: meta.contentHash,
      currentHash,
      differences: diffPaths(stored, JSON.parse(bytes) as unknown),
    },
  };
}

/**
 * One scenario-id convention across the seeded slates. The vanilla
 * builder (@alm/data vanilla.ts) ids its down-shocks SM100/SM200, a
 * convention the acceptance battery pins through its own DIRECT use of the
 * builder; while the demo and stress slates use S{shockBp} (S-100/S-200).
 * The Compare view joins rows by scenario id, so a cross-slate compare of the
 * same down-shock rendered as two duplicate-labeled, un-joined rows (the
 * W4-U1 finding). The remap happens here at the seed boundary only: the
 * builder and its direct consumers (acceptance stages 1/3, handBooks) are
 * untouched, and only the ids move: labels, rate specs, and the assumption
 * binding are unchanged. A run pins its slate's scenarios verbatim into
 * request.json at submission, so no stored run is affected. The store stays
 * append-only: a store already carrying the old slate document keeps it (the
 * seed skips existing ids); freshly seeded stores get the aligned ids.
 * Verified before the change: nothing in the suite, the acceptance battery,
 * or the goldens keys off the SEEDED vanilla slate's down-shock ids
 * (accept/database.ts reads S0 only, and both of its parity arms read the
 * same seeded document).
 */
const VANILLA_SCENARIO_ID_REMAP: Readonly<Record<string, string>> = {
  SM100: "S-100",
  SM200: "S-200",
};

export function alignVanillaScenarioIds(scenarios: Scenario[]): Scenario[] {
  return scenarios.map((s) => {
    const aligned = VANILLA_SCENARIO_ID_REMAP[s.id];
    return aligned !== undefined ? { ...s, id: aligned } : s;
  });
}

/**
 * The seeded STRESS assumption set. The demo set binds the exact kernel
 * default parameters, so its overlays populate provenance without moving a
 * number. This set binds NON-default parameters to the
 * same four behavioral families of the demo COA, so a practitioner can run
 * base, run stressed, diff the two sets, and watch EVE and NII actually move.
 *
 * Every parameter here is ILLUSTRATIVE and hand-set: round numbers
 * chosen to make the behavioral channels visibly bite, calibrated to nothing,
 * derived from no dataset. The label says so and the label is the disclosure.
 *
 * The six moves, against the kernel defaults they replace:
 *   - prepay (mortgages, mbs): minCpr 2 -> 6 (turnover floor), inflection
 *     50 -> 25 bp (refi S-curve midpoint), faster prepayment at and near base;
 *   - nmd-decay (dda): closureSteady 0.75 -> 1.5 %/mo, maxRateDecay 3 -> 6 %/mo:
 *     deposit-flight stress on the non-interest book;
 *   - deposit-beta (mma): betaMin 0.45 -> 0.55, betaMax 0.80 -> 0.95; the
 *     interest-bearing book reprices harder with market rates.
 */
export function buildStressAssumptions(): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: SEED_IDS.stressAssumptions,
    label:
      "ILLUSTRATIVE stress: fast prepay + deposit flight (round illustrative numbers, NOT calibrated)",
    bindings: [
      {
        familyId: "mortgages",
        overlay: {
          kind: "prepay",
          model: "four-factor-cpr",
          params: { ...MBS_DEFAULTS, minCpr: 6.0, inflection: 25 },
        },
        modelVersion: "kernel-four-factor-cpr-1",
      },
      {
        familyId: "mbs",
        overlay: {
          kind: "prepay",
          model: "four-factor-cpr",
          params: { ...MBS_DEFAULTS, minCpr: 6.0, inflection: 25 },
        },
        modelVersion: "kernel-four-factor-cpr-1",
      },
      {
        familyId: "dda",
        overlay: {
          kind: "nmd-decay",
          params: { ...NMD_DEFAULTS, closureSteady: 1.5, maxRateDecay: 6.0 },
        },
        modelVersion: "kernel-nmd-decay-1",
      },
      {
        familyId: "mma",
        overlay: {
          kind: "deposit-beta",
          params: { ...BETA_S_CURVE_DEFAULTS, betaMin: 0.55, betaMax: 0.95 },
        },
        modelVersion: "kernel-deposit-beta-1",
      },
    ],
  };
}

/** The stress slate: the same regulatory grid, bound to the stress set. */
export function buildStressScenarios(): Scenario[] {
  return REGULATORY_SHOCKS_BP.map((shockBp): Scenario => ({
    id: `S${shockBp}`,
    label: shockBp === 0 ? "Base" : `Parallel ${shockBp > 0 ? "+" : ""}${shockBp}bp`,
    rateSpec: shockBp === 0 ? { kind: "base" } : { kind: "parallel", shockBp },
    assumptionSetId: SEED_IDS.stressAssumptions,
    newBusiness: { mode: "static", rules: [] },
  }));
}

/**
 * The ILLUSTRATIVE liquidity stress set. Two bindings and nothing
 * else: the kernel's NMD decay at a CONSTANT closure (steady equals initial)
 * with the rate incentive switched off (both caps 0), so every balance bucket
 * runs off exactly 5 percent a month on dda and 10 percent on mma. Round
 * numbers, calibrated to nothing; the label is the disclosure. No
 * deposit-beta binding (the defaults change nothing) and no cd-rollover
 * binding (static mode already pays CDs out on schedule).
 */
export function buildLiquidityStressAssumptions(): AssumptionSet {
  const constantClosure = (percentPerMonth: number) => ({
    ...NMD_DEFAULTS,
    closureSteady: percentPerMonth,
    closureInitial: percentPerMonth,
    maxRateDecay: 0,
    maxRateGrowth: 0,
  });
  return {
    schemaVersion: "1.0.0",
    id: SEED_IDS.liquidityAssumptions,
    label:
      "ILLUSTRATIVE liquidity stress: deposit run-off 5%/mo non-interest, 10%/mo interest-bearing (round illustrative numbers, NOT calibrated)",
    bindings: [
      {
        familyId: "dda",
        overlay: { kind: "nmd-decay", params: constantClosure(5) },
        modelVersion: "kernel-nmd-decay-1",
      },
      {
        familyId: "mma",
        overlay: { kind: "nmd-decay", params: constantClosure(10) },
        modelVersion: "kernel-nmd-decay-1",
      },
    ],
  };
}

/** The liquidity stress on base and +/-200bp, static mode. */
export function buildLiquidityStressScenarios(): Scenario[] {
  const on = (id: string, label: string, rateSpec: Scenario["rateSpec"]): Scenario => ({
    id,
    label,
    rateSpec,
    assumptionSetId: SEED_IDS.liquidityAssumptions,
    newBusiness: { mode: "static", rules: [] },
  });
  return [
    on("LIQ-S0", "Liquidity stress, base rates", { kind: "base" }),
    on("LIQ-S200", "Liquidity stress, +200bp", { kind: "parallel", shockBp: 200 }),
    on("LIQ-S-200", "Liquidity stress, -200bp", { kind: "parallel", shockBp: -200 }),
  ];
}

/**
 * The demo dimension taxonomy: the DimensionTaxonomy projection of
 * docs/harness/demo-dimensions.json (schemaVersion, id, label, dimensions;
 * anything else a fixture carries is dropped here rather than stored and
 * ignored). Exported so the suite runs the same projection the seed writes.
 */
export function buildDemoTaxonomy(repoRoot: string): DimensionTaxonomy {
  const raw = JSON.parse(
    readFileSync(join(repoRoot, "docs", "harness", "demo-dimensions.json"), "utf8"),
  ) as DimensionTaxonomy;
  return {
    schemaVersion: raw.schemaVersion,
    id: raw.id,
    label: raw.label,
    dimensions: raw.dimensions,
  };
}

/**
 * The one-dimension taxonomy the tagged book carries, also stored in
 * the taxonomy collection so a CSV upload can target it with a
 * `dim.hqla-level` column. The demo taxonomy `demo-dimensions-v1` is untouched.
 */
export const HQLA_TAXONOMY: DimensionTaxonomy = {
  schemaVersion: "1.0.0",
  id: "hqla-tags-v1",
  label: "HQLA levels (survival-horizon buffer)",
  dimensions: [
    { id: "hqla-level", label: "HQLA level for the survival-horizon buffer", values: ["l1", "l2a", "l2b"] },
  ],
};

/** Family id to hqla-level on the tagged book. Every position of these families is tagged. */
const HQLA_LEVEL_BY_FAMILY: Readonly<Record<string, string>> = {
  cash: "l1",
  investments: "l1",
  mbs: "l2a",
};

/**
 * The synthetic book from the same generator call and seed as
 * `synthetic-2500-v1`, with the buffer families tagged. Exported so the suite
 * checks exactly what the seed writes.
 */
export function buildHqlaPortfolio(): PortfolioSpec {
  const base = generatePortfolio({
    ...DEFAULT_GENERATOR_CONFIG,
    portfolioId: SEED_IDS.hqlaPortfolio,
    portfolioLabel: `Synthetic ALM Balance Sheet (${SYNTHETIC_POSITIONS} positions, seeded, HQLA-tagged)`,
    targetPositions: SYNTHETIC_POSITIONS,
  });
  return {
    ...base,
    taxonomy: HQLA_TAXONOMY,
    positions: base.positions.map((p) => {
      const level = HQLA_LEVEL_BY_FAMILY[p.familyId];
      return level === undefined ? p : { ...p, dimensions: { "hqla-level": level } };
    }),
  };
}

/**
 * The two-dimension taxonomy the LCR-tagged book carries, also stored
 * in the taxonomy collection so a CSV upload can target it. `hqla-tags-v1` is
 * untouched.
 */
export const LIQUIDITY_TAXONOMY: DimensionTaxonomy = {
  schemaVersion: "1.0.0",
  id: "liquidity-tags-v1",
  label: "Liquidity tags (HQLA level and LCR category)",
  dimensions: [
    { id: "hqla-level", label: "HQLA level for the liquidity buffer", values: ["l1", "l2a", "l2b"] },
    {
      id: "lcr-category",
      label: "LCR run-off category for a liability family",
      values: [
        "retail-stable",
        "retail-other",
        "operational",
        "secured-gse",
        "wholesale-nonfinancial",
        "wholesale-financial",
      ],
    },
  ],
};

/** Liability family id to lcr-category on the LCR-tagged book. DEMONSTRATION mapping. */
const LCR_CATEGORY_BY_FAMILY: Readonly<Record<string, string>> = {
  dda: "retail-stable",
  mma: "retail-other",
  cds: "retail-stable",
  fhlb: "secured-gse",
  borrowings: "wholesale-financial",
};

/**
 * The hqla book with every liability position tagged lcr-category.
 * Exported so the suite checks exactly what the seed writes.
 */
export function buildLcrPortfolio(): PortfolioSpec {
  const base = buildHqlaPortfolio();
  return {
    ...base,
    id: SEED_IDS.lcrPortfolio,
    label: `Synthetic ALM Balance Sheet (${SYNTHETIC_POSITIONS} positions, seeded, HQLA- and LCR-tagged)`,
    taxonomy: LIQUIDITY_TAXONOMY,
    positions: base.positions.map((p) => {
      const cat = LCR_CATEGORY_BY_FAMILY[p.familyId];
      return cat === undefined ? p : { ...p, dimensions: { ...p.dimensions, "lcr-category": cat } };
    }),
  };
}

/**
 * The lcr book's liability positions only, every one carrying
 * lcr-category. Taxonomy and chart of accounts are carried unchanged from the
 * lcr book, and the positions are the same objects in book order. The book
 * holds liabilities only. Exported so the suite checks exactly what the seed writes.
 */
export function buildLcrLiabilityPortfolio(): PortfolioSpec {
  const base = buildLcrPortfolio();
  const positions = base.positions.filter((p) => p.dimensions?.["lcr-category"] !== undefined);
  return {
    ...base,
    id: SEED_IDS.lcrLiabilityPortfolio,
    label: `Synthetic liability book (${positions.length} LCR-tagged liability positions of ${SEED_IDS.lcrPortfolio}, seeded)`,
    positions,
  };
}

/**
 * The three-dimension taxonomy the commitment book carries. `hqla-level`
 * and `lcr-category` are the SAME objects `liquidity-tags-v1` declares, taken
 * from `LIQUIDITY_TAXONOMY` rather than retyped, so the two taxonomies cannot
 * drift apart; `commitment-category` is the new one. This is a NEW taxonomy
 * because `liquidity-tags-v1` carries a pinned content hash and an edit would
 * move it.
 *
 * The six values are the run-off buckets of 12 CFR 249.32(e)(1), keyed exactly
 * as `US_LCR_COMMITMENT_DEMO` keys them. Their scope is the regulation's, not a
 * paraphrase of it:
 *   - facility-retail (ii) reads "retail customer or counterparty", itself a
 *     defined term in 12 CFR 249.3 that reaches some business customers;
 *   - facility-depository (v) covers depository institutions, depository
 *     institution holding companies and foreign banks, and NOT credit unions;
 *   - credit-financial (vi) and liquidity-financial (vii) cover "financial
 *     sector entities", a 249.3 defined term of which a regulated financial
 *     company is one member among several, so the bucket is wider than that;
 *   - (iii), (iv), (vi) and (vii) each expressly reach a counterparty's
 *     consolidated-subsidiary SPEs other than the (viii) SPEs.
 */
export const LIQUIDITY_TAXONOMY_V2: DimensionTaxonomy = {
  schemaVersion: "1.0.0",
  id: "liquidity-tags-v2",
  label: "Liquidity tags (HQLA level, LCR category and committed-facility category)",
  dimensions: [
    ...LIQUIDITY_TAXONOMY.dimensions.map((d) => ({ ...d })),
    {
      id: "commitment-category",
      label: "US LCR run-off category for an undrawn committed facility, 12 CFR 249.32(e)(1)",
      values: [
        "facility-retail",
        "credit-nonfinancial",
        "liquidity-nonfinancial",
        "facility-depository",
        "credit-financial",
        "liquidity-financial",
      ],
    },
  ],
};

/**
 * The off-balance-sheet COA root the committed-line families hang
 * under. A ROOT, deliberately: an undrawn line is off balance sheet, so it must
 * not sum into Total Assets, and hanging it under `coa-assets` would put
 * optional capacity inside the funded subtree and silently inflate every asset
 * roll-up that reads the tree. Summation-only; the six leaves carry the
 * positions.
 */
const COMMITMENT_COA_ROOT_ID = "coa-commitments";

/**
 * The seeded committed-line book. Six lines, one per 249.32(e)(1)
 * bucket the engine carries, so a reader can hand-verify both ends of the rate
 * table (credit-nonfinancial at 0.10, liquidity-financial at 1.00) against the
 * metric without running anything.
 *
 * ONE FAMILY PER CATEGORY, and that is a correctness requirement, not a
 * stylistic one. `commitmentRates` in report/lcr.ts rates a commitment FAMILY,
 * and refuses the whole metric when a family's positions carry more than one
 * category, exactly as the liability arm refuses a mixed `lcr-category` family
 * (spec Section 7.3's absence rule: a category the table cannot read is not a
 * zero). The first cut of this seed put all six categories on a single `commit`
 * family; `computeLcrRegulatory` then returned an EMPTY value bag for every
 * key, HQLA included, in every scenario. The book could not produce the metric
 * the piece exists to compute. A category is therefore a property of the
 * family here, and the position's tag is derived from it below, so the two
 * cannot disagree.
 *
 * Every notional and expiry here is ILLUSTRATIVE and hand-set:
 * round numbers chosen so each bucket is visible in the outflow, drawn from no
 * book and calibrated to nothing. Counterparty descriptions are generic and
 * follow the regulation's own scope.
 *
 * Each line carries `EMPTY_DRAW_PATH`: a position is an observed fact and draws
 * nothing on its own. The `commitment-draw` overlay of the squeeze set is what
 * replaces it, exactly as a `prepay` overlay replaces a mortgage's cprParams.
 *
 * Undrawn capacity totals 550,000,000, and at the table's rates the regulatory
 * commitment outflow is 132,000,000:
 *   0.05 x 60m + 0.10 x 250m + 0.30 x 80m + 0.50 x 40m + 0.40 x 100m + 1.00 x 20m
 *   =  3m + 25m + 24m + 20m + 40m + 20m  =  132m
 */
const COMMITMENT_LINES: ReadonlyArray<{
  /** The `commitment-category` this family carries, on every one of its positions. */
  category: string;
  label: string;
  notional: number;
  maturityMonths: number;
}> = [
  {
    category: "facility-retail",
    label: "Revolving lines, retail customers and counterparties (249.3 defined term)",
    notional: 60_000_000,
    maturityMonths: 24,
  },
  {
    category: "credit-nonfinancial",
    label: "Credit facilities, wholesale non-financial-sector counterparties and their consolidated SPEs",
    notional: 250_000_000,
    maturityMonths: 36,
  },
  {
    category: "liquidity-nonfinancial",
    label: "Liquidity facilities, wholesale non-financial-sector counterparties and their consolidated SPEs",
    notional: 80_000_000,
    maturityMonths: 36,
  },
  {
    category: "facility-depository",
    label: "Credit and liquidity facilities, depository institutions, depository institution holding companies and foreign banks",
    notional: 40_000_000,
    maturityMonths: 12,
  },
  {
    category: "credit-financial",
    label: "Credit facilities, financial sector entities (249.3 defined term) and their consolidated SPEs",
    notional: 100_000_000,
    maturityMonths: 36,
  },
  {
    category: "liquidity-financial",
    label: "Liquidity facilities, financial sector entities (249.3 defined term) and their consolidated SPEs",
    notional: 20_000_000,
    maturityMonths: 24,
  },
];

/** Family id for a committed-line category. One family per category; see COMMITMENT_LINES. */
const commitFamilyId = (category: string): string => `commit-${category}`;

/** COA leaf id for a committed-line category. */
const commitNodeId = (category: string): string => `coa-commit-${category}`;

/**
 * The six commitment families, one per category, each DECLARING
 * `draw-utilization`. Since piece 7 the `commitment-draw` overlay also derives
 * that class, so a family bound in the squeeze set would carry it either way;
 * the declaration is what makes it visible on the BOOK itself, before any
 * assumption set is chosen and for any set that binds no draw.
 */
export function buildCommitmentFamilies(): ProductFamilyDef[] {
  return COMMITMENT_LINES.map((line) => ({
    id: commitFamilyId(line.category),
    label: `Undrawn Committed Lines: ${line.label}`,
    side: "asset",
    instrumentType: "commitment",
    coaNodeId: commitNodeId(line.category),
    behavioralClasses: ["draw-utilization"],
  }));
}

/** The six committed lines as positions, one per family. Exported so the suite checks what the seed writes. */
export function buildCommitmentPositions(): Position[] {
  return COMMITMENT_LINES.map((line): Position => {
    const id = `${commitFamilyId(line.category)}-1`;
    const terms: CommitmentTerms = {
      id,
      type: "commitment",
      label: line.label,
      notional: line.notional,
      maturityMonths: line.maturityMonths,
      originationOffsetMonths: 0,
      amortType: "bullet",
      side: "asset",
      draw: { rampRates: [...EMPTY_DRAW_PATH.rampRates], steadyRate: EMPTY_DRAW_PATH.steadyRate },
    };
    validateCommitmentTerms(terms);
    return {
      id,
      familyId: commitFamilyId(line.category),
      coaNodeId: commitNodeId(line.category),
      terms,
      // Derived from the family's own category, so a position can never carry a
      // tag its family does not, which is the state that refuses the metric.
      dimensions: { "commitment-category": line.category },
    };
  });
}

/**
 * The LCR book (same generator call, same seed, same hqla and lcr
 * tags) re-tagged to `liquidity-tags-v2` and extended with the committed-line
 * book. Built FROM `buildLcrPortfolio()`, so the funded side is the piece 6
 * document position for position; the document itself is untouched and
 * keeps its own id and taxonomy.
 */
export function buildCommitmentPortfolio(): PortfolioSpec {
  const base = buildLcrPortfolio();
  const commitments = buildCommitmentPositions();
  return {
    ...base,
    id: SEED_IDS.commitmentPortfolio,
    label:
      `Synthetic ALM Balance Sheet (${SYNTHETIC_POSITIONS} positions, seeded, HQLA- and LCR-tagged, ` +
      `plus ${commitments.length} ILLUSTRATIVE undrawn committed lines)`,
    taxonomy: LIQUIDITY_TAXONOMY_V2,
    coa: {
      ...base.coa,
      nodes: [
        ...base.coa.nodes.map((n) => ({ ...n })),
        {
          id: COMMITMENT_COA_ROOT_ID,
          label: "Undrawn Committed Lines (off balance sheet)",
          parentId: null,
          side: "asset" as const,
          isLeaf: false,
          order: 2,
        },
        ...COMMITMENT_LINES.map((line, i) => ({
          id: commitNodeId(line.category),
          label: line.label,
          parentId: COMMITMENT_COA_ROOT_ID,
          side: "asset" as const,
          isLeaf: true,
          familyId: commitFamilyId(line.category),
          order: i,
        })),
      ],
      families: [...base.coa.families.map((f) => ({ ...f })), ...buildCommitmentFamilies()],
    },
    positions: [...base.positions, ...commitments],
  };
}

/**
 * The synthetic book, exactly as `seedStore` has always built it: one call,
 * extracted so the hedged book is built FROM it and the two cannot drift.
 */
export function buildSyntheticPortfolio(): PortfolioSpec {
  return generatePortfolio({
    ...DEFAULT_GENERATOR_CONFIG,
    portfolioId: SEED_IDS.syntheticPortfolio,
    portfolioLabel: `Synthetic ALM Balance Sheet (${SYNTHETIC_POSITIONS} positions, seeded)`,
    targetPositions: SYNTHETIC_POSITIONS,
  });
}

/** One seeded swap: tenor, notional and fixed rate. */
export interface HedgeSwapSpec {
  tenorMonths: number;
  notional: number;
  fixedRate: number;
}

/** The swap family's COA root, a ROOT so no notional sums into Total Assets. */
const HEDGE_COA_ROOT_ID = "coa-derivatives";
const HEDGE_NODE_ID = "coa-swaps";
const HEDGE_FAMILY_ID = "swaps";

/**
 * `base` plus one swap family (side "derivative", instrumentType "swap") on
 * its own COA root, holding one PAY-FIXED swap per spec. Positions of `base`
 * are carried unchanged and first.
 */
export function withHedgeSwaps(
  base: PortfolioSpec,
  id: string,
  label: string,
  swaps: readonly HedgeSwapSpec[],
): PortfolioSpec {
  const positions: Position[] = swaps.map((s) => {
    const posId = `swap-pay-fixed-${s.tenorMonths}m`;
    const terms: SwapTerms = {
      id: posId,
      type: "swap",
      label: `Pay-fixed swap, ${s.tenorMonths} months (ILLUSTRATIVE)`,
      notional: s.notional,
      maturityMonths: s.tenorMonths,
      originationOffsetMonths: 0,
      amortType: "bullet",
      direction: "pay-fixed",
      fixedRate: s.fixedRate,
    };
    validateSwapTerms(terms);
    return { id: posId, familyId: HEDGE_FAMILY_ID, coaNodeId: HEDGE_NODE_ID, terms };
  });
  return {
    ...base,
    id,
    label,
    coa: {
      ...base.coa,
      nodes: [
        ...base.coa.nodes.map((n) => ({ ...n })),
        { id: HEDGE_COA_ROOT_ID, label: "Derivatives (interest rate swaps)", parentId: null, side: "derivative" as const, isLeaf: false, order: 2 },
        { id: HEDGE_NODE_ID, label: "Interest rate swaps", parentId: HEDGE_COA_ROOT_ID, side: "derivative" as const, isLeaf: true, familyId: HEDGE_FAMILY_ID, order: 0 },
      ],
      families: [
        ...base.coa.families.map((f) => ({ ...f })),
        { id: HEDGE_FAMILY_ID, label: "Interest rate swaps", side: "derivative" as const, instrumentType: "swap" as const, coaNodeId: HEDGE_NODE_ID },
      ],
    },
    positions: [...base.positions, ...positions],
  };
}

/**
 * The seeded hedge. ILLUSTRATIVE, hand-set values,
 * calibrated to no bank. Each fixed rate is engine-convention par on the
 * public Treasury CMT pack as of 2026-03-31, rounded to 0.1 bp (struck
 * 2026-09-24). The one notional was chosen so the hedged book's +200 bp |dEVE|
 * is about half the unhedged book's, rounded to 25,000,000. Pay-fixed
 * helps the +200 scenario and hurts the -200 one: this is a directional
 * hedge, not an immunization.
 */
export const HEDGE_SWAPS: readonly HedgeSwapSpec[] = [{"tenorMonths":24,"notional":325000000,"fixedRate":0.0376},{"tenorMonths":60,"notional":325000000,"fixedRate":0.03888},{"tenorMonths":120,"notional":325000000,"fixedRate":0.04262}];

/** `synthetic-2500-v1`'s positions unchanged, plus the seeded hedge. */
export function buildHedgedPortfolio(): PortfolioSpec {
  return withHedgeSwaps(
    buildSyntheticPortfolio(),
    SEED_IDS.hedgedPortfolio,
    `Synthetic ALM Balance Sheet (${SYNTHETIC_POSITIONS} positions, seeded, plus ${HEDGE_SWAPS.length} ILLUSTRATIVE pay-fixed swaps)`,
    HEDGE_SWAPS,
  );
}

/**
 * The ILLUSTRATIVE joint squeeze. All three legs at once, because SR
 * 10-6 and Reg YY both ask for the correlated case rather than deposits and
 * commitments stressed independently, and drawdown is counter-cyclical: the
 * firms pulling on their revolvers are the firms running down their deposits.
 *
 * Leg 1 and leg 2 are the 5c deposit run-off, taken from
 * `buildLiquidityStressAssumptions()` rather than retyped, so the two sets
 * cannot drift. Leg 3 is the committed-line draw. Leg 4 is not a binding at
 * all: the slate runs `static` mode, so wholesale funding does not roll.
 *
 * Leg 3 is SIX bindings, not one, because the book carries one commitment
 * family per run-off category (see COMMITMENT_LINES). Every one of them carries
 * the identical path, built once and spread, so the six can never drift into
 * six different draw assumptions. Month 1 draws 35 percent of the whole undrawn
 * book: 0.35 x 550,000,000 = 192,500,000, unchanged by the split.
 *
 * The ramp 35/15/10 percent a month then 2 percent is anchored to published
 * crisis evidence, not to round numbers, and is not to be tuned. Each rate is a
 * fraction of what is STILL UNDRAWN, the same convention the deposit run-off
 * uses. The set is still ILLUSTRATIVE and fitted to no book; the label is the
 * disclosure.
 */
export function buildLiquiditySqueezeAssumptions(): AssumptionSet {
  const draw = { kind: "commitment-draw", rampRates: [0.35, 0.15, 0.1], steadyRate: 0.02 } as const;
  return {
    schemaVersion: "1.0.0",
    id: SEED_IDS.squeezeAssumptions,
    label:
      "ILLUSTRATIVE liquidity squeeze: deposit run-off 5%/mo non-interest, 10%/mo interest-bearing, " +
      "committed-line draws 35/15/10%/mo then 2% (anchored to published crisis evidence, NOT calibrated)",
    bindings: [
      ...buildLiquidityStressAssumptions().bindings,
      ...buildCommitmentFamilies().map((fam) => ({
        familyId: fam.id,
        overlay: { ...draw, rampRates: [...draw.rampRates] },
        modelVersion: "engine-commitment-draw-1",
      })),
    ],
  };
}

/** The squeeze on base and +/-200bp, static mode (wholesale does not roll). */
export function buildLiquiditySqueezeScenarios(): Scenario[] {
  const on = (id: string, label: string, rateSpec: Scenario["rateSpec"]): Scenario => ({
    id,
    label,
    rateSpec,
    assumptionSetId: SEED_IDS.squeezeAssumptions,
    newBusiness: { mode: "static", rules: [] },
  });
  return [
    on("SQZ-S0", "Liquidity squeeze, base rates", { kind: "base" }),
    on("SQZ-S200", "Liquidity squeeze, +200bp", { kind: "parallel", shockBp: 200 }),
    on("SQZ-S-200", "Liquidity squeeze, -200bp", { kind: "parallel", shockBp: -200 }),
  ];
}

/** The demo regulatory grid, every scenario bound to the loan repricing set. */
export function buildLoanRepricingScenarios(): Scenario[] {
  return buildDemoScenarios().map((s): Scenario => ({ ...s, assumptionSetId: SEED_IDS.loanRepricingAssumptions }));
}

/**
 * The three ops of the seeded decay shock. Each scales one dda
 * nmd-decay parameter by 1.25: the steady and initial closure rates and the
 * rate-driven outflow cap, so every outflow channel runs a quarter faster; the
 * inflow cap maxRateGrowth is left alone. A multiplier of round size on the
 * demo set, ILLUSTRATIVE and calibrated to nothing. Exported so the suite
 * restates the same ops against the route.
 */
export const DECAY_SHOCK_OPS = [
  { target: { familyId: "dda", kind: "nmd-decay" }, path: "params.closureSteady", op: "scale", value: 1.25 },
  { target: { familyId: "dda", kind: "nmd-decay" }, path: "params.closureInitial", op: "scale", value: 1.25 },
  { target: { familyId: "dda", kind: "nmd-decay" }, path: "params.maxRateDecay", op: "scale", value: 1.25 },
] as const;

/**
 * The seeded decay shock set: the demo set run through the engine's own
 * deriveAssumptionSet, the function POST /api/assumption-sets/derive calls, so
 * the seeded bytes equal the route's bytes. Demonstration values, NOT calibrated.
 */
export function buildDecayShockAssumptions(): AssumptionSet {
  return deriveAssumptionSet(buildDemoAssumptions(), DECAY_SHOCK_OPS, {
    id: SEED_IDS.decayShockAssumptions,
    label: "Deposit decay +25% on the demo set (demonstration values, NOT calibrated)",
  }).set;
}

/** The regulatory grid on the decay shock set: the demo scenarios, bound to it. */
export function buildDecayShockScenarios(): Scenario[] {
  return buildDemoScenarios().map((s): Scenario => ({ ...s, assumptionSetId: SEED_IDS.decayShockAssumptions }));
}

/**
 * The seeded base balance plan. dda and mma are each held flat
 * at one knot, month 12, at the synthetic book's own opening balance, summed from
 * its positions (whole dollars), so the plan lowers to "flat" on the synthetic,
 * lcr and hedged books alike. A flat knot at the book's balance is the book's
 * balance and no fitted value. The -100 bp spread over the index and the 12-month
 * term are round demonstration values, calibrated to nothing. NOT written by
 * planSeedDocuments (the base of the derived shock plan).
 */
export function buildDemoBalancePlan(): BalancePlan {
  const book = buildSyntheticPortfolio();
  const opening = (familyId: string): number =>
    book.positions.filter((p) => p.familyId === familyId).reduce((sum, p) => sum + p.terms.notional, 0);
  const pricing = { spreadOverIndexBp: -100, termMonths: 12 };
  return {
    schemaVersion: "1.0.0",
    id: SEED_IDS.demoBalancePlan,
    label: "Deposit targets held flat at month 12 on the synthetic book (demonstration values)",
    asOf: book.asOf,
    targets: [
      { familyId: "dda", path: [{ month: 12, balance: opening("dda") }], newBusinessPricing: { ...pricing } },
      { familyId: "mma", path: [{ month: 12, balance: opening("mma") }], newBusinessPricing: { ...pricing } },
    ],
    unlistedFamilies: "runoff",
  };
}

/**
 * The one op of the seeded balance shock. It scales the dda
 * target at month 12 by 0.9. A one-knot target lowers to ONE monthly rate that
 * continues to the horizon, so 0.9 at month 12 is about minus 0.874 percent a
 * month. A factor of round size, demonstration values, calibrated to nothing.
 * Exported so the suite restates the same op against the route.
 */
export const BALANCE_SHOCK_OPS = [{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }] as const;

/**
 * The seeded balance shock plan: the demo base run through the engine's own
 * deriveBalancePlan, the function the derive route calls, against the synthetic
 * book, so the seeded bytes equal the route's bytes. Demonstration values, NOT
 * calibrated. Written by planSeedDocuments beside its base.
 */
export function buildBalanceShockPlan(): BalancePlan {
  return deriveBalancePlan(buildDemoBalancePlan(), BALANCE_SHOCK_OPS, {
    book: buildSyntheticPortfolio(),
    id: SEED_IDS.balanceShockPlan,
    label: "dda target 10% lower at month 12 on the deposit targets (demonstration values, NOT calibrated)",
  }).plan;
}

/**
 * The one op of the seeded funding spread shock. It adds 50 bp
 * to the TLP node at every tenor except t = 0, which stays pinned at 0. A round
 * demonstration value, calibrated to nothing. Exported so the suite restates the
 * same op against the route.
 */
export const FUNDING_SPREAD_SHOCK_OPS = [{ op: "add", value: 50 }] as const;

/** The seeded funding spread shock label; the derivation keeps it because it says "demonstration". */
export const FUNDING_SPREAD_SHOCK_LABEL = "TLP +50 bp on every node of the public market pack (demonstration values)";

/**
 * The seeded funding spread shock: the public market snapshot run through the
 * engine's own deriveMarketSnapshot, the function the derive route calls, so the
 * seeded bytes equal the route's bytes. Demonstration values, NOT calibrated.
 * Returns the whole derive result because the store meta is built from it.
 */
export function buildFundingSpreadShockMarket(base: MarketSnapshot): MarketDeriveResult {
  return deriveMarketSnapshot(base, FUNDING_SPREAD_SHOCK_OPS, {
    baseId: SEED_IDS.market,
    id: SEED_IDS.fundingSpreadShockMarket,
    label: FUNDING_SPREAD_SHOCK_LABEL,
  });
}

/**
 * The three ops of the seeded rate indices market. Two benchmark
 * indices with no basis (one-month and three-month) and one prime-style index
 * that sits 300 bp over the one-month benchmark. Round demonstration values,
 * calibrated to nothing. Exported so the suite restates the same ops
 * against the route.
 */
export const RATE_INDEX_DEMO_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
] as const;

/** The seeded rate indices market label; the derivation keeps it because it says "demonstration". */
export const RATE_INDEX_DEMO_LABEL = "Three rate indices on the public market pack (demonstration values)";

/**
 * The seeded rate indices market: the public market snapshot run through the
 * engine's own deriveMarketSnapshot, the function the derive route calls, so the
 * seeded bytes equal the route's bytes. No TLP op, so the TLP nodes and the
 * term-funding quotes are carried unchanged. Demonstration values, NOT calibrated.
 */
export function buildRateIndexMarket(base: MarketSnapshot): MarketDeriveResult {
  return deriveMarketSnapshot(base, RATE_INDEX_DEMO_OPS, {
    baseId: SEED_IDS.market,
    id: SEED_IDS.rateIndexMarket,
    label: RATE_INDEX_DEMO_LABEL,
  });
}

/**
 * The one op of the seeded volatility shock. It scales every
 * constructed short-rate volatility in every expiry row by 1.5. A round
 * demonstration value, calibrated to nothing. Exported so the suite restates the
 * same op against the route.
 */
export const VOL_SHOCK_DEMO_OPS = [{ op: "scale-short-rate-vol", value: 1.5 }] as const;

/** The seeded volatility shock label; the derivation keeps it because it says "demonstration". */
export const VOL_SHOCK_DEMO_LABEL =
  "Constructed short-rate volatilities times 1.5 at every expiry of the public market pack (demonstration values)";

/**
 * The seeded volatility shock: the public market snapshot run through the
 * engine's own deriveMarketSnapshot, the function the derive route calls, so the
 * seeded bytes equal the route's bytes. Only the cap quotes and the derivation
 * record differ from the base. Demonstration values, NOT calibrated.
 */
export function buildVolShockMarket(base: MarketSnapshot): MarketDeriveResult {
  return deriveMarketSnapshot(base, VOL_SHOCK_DEMO_OPS, {
    baseId: SEED_IDS.market,
    id: SEED_IDS.volShockMarket,
    label: VOL_SHOCK_DEMO_LABEL,
  });
}

/**
 * The illustrative house-price response of the parameterization
 * of record v1, at most two
 * significant figures each. Demonstration values, read from and tuned to no
 * fitted, calibrated or licensed source.
 */
export const HOUSING_DEMO_PARAMS = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 } as const;

/**
 * The demo set with the housing group on its two four-factor
 * bindings (mortgages and mbs) and both families mapped to one projection on
 * macro-demo-v1. Every other binding is the demo set's, unchanged.
 */
export function buildHousingAssumptions(id: string, seriesId: "hpi-down-30" | "hpi-flat", label: string): AssumptionSet {
  const demo = buildDemoAssumptions();
  return {
    schemaVersion: demo.schemaVersion, id, label,
    bindings: demo.bindings.map((b) => (b.overlay.kind === "prepay" && b.overlay.model === "four-factor-cpr" && (b.familyId === "mortgages" || b.familyId === "mbs"))
      ? { ...b, overlay: { ...b.overlay, housing: { ...HOUSING_DEMO_PARAMS } } } : b),
    macroBindings: [
      { seriesId, feeder: "prepay-housing", familyId: "mortgages" },
      { seriesId, feeder: "prepay-housing", familyId: "mbs" },
    ],
  };
}

/**
 * The seeded macro factors market: the public market snapshot
 * run through the engine's own deriveMarketSnapshot, the function the derive
 * route calls, so the seeded bytes equal the route's bytes. Only the macro block
 * and the derivation record differ from the base. Demonstration values; the
 * histories feed no run and the projections are authored, never a forecast.
 */
export function buildMacroMarket(base: MarketSnapshot, root: string): MarketDeriveResult {
  return deriveMarketSnapshot(base, buildMacroDemoOps(root), { baseId: SEED_IDS.market, id: SEED_IDS.macroMarket, label: MACRO_DEMO_LABEL });
}

/**
 * Which seeded floaters name which seeded index. The three
 * lowest-numbered floating-loans positions, one per index, so the seeded plan
 * exercises a benchmark, a term benchmark and a prime-style index.
 */
export const INDEXED_FLOATERS: ReadonlyArray<readonly [positionId: string, rateIndexId: string]> = [
  ["floating-loans-0", "rfr-1m"],
  ["floating-loans-1", "rfr-3m"],
  ["floating-loans-2", "prime-demo"],
];

/**
 * `synthetic-2500-v1` with `rateIndexId` added to the terms of
 * the three floaters in INDEXED_FLOATERS and nothing else changed. Throws if a
 * named position is absent or is not a floating loan, so a drifted generator
 * refuses before any document is written.
 */
export function buildIndexedPortfolio(): PortfolioSpec {
  const base = buildSyntheticPortfolio();
  const named = new Map<string, string>(INDEXED_FLOATERS);
  const seen = new Set<string>();
  const positions = base.positions.map((p): Position => {
    const indexId = named.get(p.id);
    if (indexId === undefined) return p;
    if (p.terms.type !== "floating-loan") {
      throw new Error(`seed: position "${p.id}" is a ${p.terms.type}; only a floating-loan can name rate index "${indexId}"`);
    }
    seen.add(p.id);
    return { ...p, terms: { ...p.terms, rateIndexId: indexId } };
  });
  for (const id of named.keys()) {
    if (!seen.has(id)) throw new Error(`seed: the synthetic book has no position "${id}" to name a rate index`);
  }
  return {
    ...base,
    id: SEED_IDS.indexedPortfolio,
    label: `Synthetic ALM Balance Sheet (${SYNTHETIC_POSITIONS} positions, seeded, three floaters naming demonstration rate indices)`,
    positions,
  };
}

/**
 * One ILLUSTRATIVE hierarchy over the lcr-category tag. It groups
 * the six closed LCR categories into three funding sources and six run-off
 * buckets. Demonstration values, not a regulatory mapping and not an internal
 * one. Already in the canonical form `parseHierarchy` stores (key order, map keys
 * in code-unit order, trimmed labels). Exported so the suite loads exactly what
 * the seed writes. The seed writes the hierarchy only; it never writes the book
 * that applying it produces.
 */
export function buildDemoHierarchy(): Hierarchy {
  return {
    schemaVersion: "1.0.0",
    id: SEED_IDS.demoHierarchy,
    label: "Liquidity funding hierarchy over the LCR category tag (demonstration values)",
    kind: "liquidity",
    sourceDimension: "lcr-category",
    levels: [
      { id: "funding", label: "Funding source" },
      { id: "bucket", label: "Run-off bucket" },
    ],
    nodes: [
      { id: "retail", parentId: null, level: "funding" },
      { id: "unsecured-wholesale", parentId: null, level: "funding" },
      { id: "secured", parentId: null, level: "funding" },
      { id: "retail-stable", parentId: "retail", level: "bucket" },
      { id: "retail-less-stable", parentId: "retail", level: "bucket" },
      { id: "operational", parentId: "unsecured-wholesale", level: "bucket" },
      { id: "nonfinancial-wholesale", parentId: "unsecured-wholesale", level: "bucket" },
      { id: "financial-wholesale", parentId: "unsecured-wholesale", level: "bucket" },
      { id: "gse-secured", parentId: "secured", level: "bucket" },
    ],
    map: {
      operational: "operational",
      "retail-other": "retail-less-stable",
      "retail-stable": "retail-stable",
      "secured-gse": "gse-secured",
      "wholesale-financial": "financial-wholesale",
      "wholesale-nonfinancial": "nonfinancial-wholesale",
    },
  };
}

/**
 * The six demo lens definitions (pieces 3a to 3c): the `lenses` array of the shipped
 * docs/harness/lenses.json. The file's top-level `note` states that every limit
 * is a demonstration value; it is documentation for a reader of the file and is
 * not part of a LensDefinition, so it is dropped here rather than stored and
 * ignored. Exported so the suite loads exactly what the seed writes.
 */
export function buildDemoLenses(repoRoot: string): LensDefinition[] {
  const raw = JSON.parse(
    readFileSync(join(repoRoot, "docs", "harness", "lenses.json"), "utf8"),
  ) as { note: string; lenses: LensDefinition[] };
  return raw.lenses;
}

/**
 * The Lab public market pack the seed stores under `market-public-2026-03-31` (the demo profile). A registered
 * profile may store the same parsed pack with a curve default version 1 marker under its own id.
 */
export async function loadPublicMarket(repoRoot: string): Promise<MarketSnapshot> {
  return loadMarketSnapshot(join(repoRoot, "packages", "kernel", "public", "market_public.json"));
}

/**
 * The public market document. With no `as`, the shared `market-public-2026-03-31` with the same bytes and meta
 * in every profile that plans it, so a shared id never reads stale. `as` names another id and label for the
 * same snapshot document (a registered profile's own marked market).
 */
export function publicMarketDocument(snapshot: MarketSnapshot, as?: { id: string; label: string }): SeedDocument {
  return {
    collection: "market",
    id: as?.id ?? SEED_IDS.market,
    doc: snapshot,
    meta: { label: as?.label ?? "Public market pack 2026-03-31 (Treasury CMT par yields)", seeded: true },
  };
}

/**
 * The behavioral routing policy the plan routing gate enforces (harness Plane 4), parsed through the engine
 * so a malformed file refuses here. The same document in every profile.
 */
export function routingPolicyDocument(repoRoot: string): SeedDocument {
  const policy = parseRoutingPolicy(
    JSON.parse(readFileSync(join(repoRoot, "docs", "harness", "model-map.json"), "utf8")),
  );
  return {
    collection: "routing-policies",
    id: policy.id,
    doc: policy,
    meta: { label: policy.label, classCount: policy.classes.length, seeded: true },
  };
}

/**
 * Every document the seed writes, in write order. Pure over the repo: reads
 * committed fixtures, writes nothing. Each validation that used to run only on
 * a first write now runs on every seed, so a drifted fixture refuses before any
 * document is written.
 *
 * `profile` (ALM_SEED_PROFILE): "demo", the default, plans exactly the documents
 * below; any other id plans the documents of the profile a loaded pack
 * registered under it (src/registry.ts), so the default path imports nothing new.
 */
export async function planSeedDocuments(repoRoot: string, profile: SeedProfile = CORE_SEED_PROFILE): Promise<SeedDocument[]> {
  // The starter profile and the learn profile write the demo catalogue's documents exactly; only
  // their workspaces differ.
  if (profile !== CORE_SEED_PROFILE && !NO_WORKSPACE_PROFILES.includes(profile)) return seedProfileEntry(profile).plan(repoRoot);
  // Kept so the demonstration hierarchy is checked against the very book the plan writes.
  const lcrBook = buildLcrPortfolio();
  const liabilityBook = buildLcrLiabilityPortfolio();
  const docs: SeedDocument[] = [
    // Books. The vanilla book keeps its own id from @alm/data; the synthetic book
    // is regenerated from the committed master seed at a reduced position count.
    portfolioDocument(buildVanillaPortfolio()),
    portfolioDocument(buildSyntheticPortfolio()),
    // Pieces 5b, 6 and 7: each tagged book validated against its own taxonomy.
    portfolioDocument(validatedPortfolio(buildHqlaPortfolio(), HQLA_TAXONOMY.id)),
    portfolioDocument(validatedPortfolio(lcrBook, LIQUIDITY_TAXONOMY.id)),
    portfolioDocument(validatedPortfolio(buildCommitmentPortfolio(), LIQUIDITY_TAXONOMY_V2.id)),
    // The hedged book, a new document; synthetic-2500-v1 is untouched.
    portfolioDocument(buildHedgedPortfolio()),
    // The liability book, a new document; synthetic-2500-lcr-v1 is untouched.
    portfolioDocument(validatedPortfolio(liabilityBook, LIQUIDITY_TAXONOMY.id)),
    // The indexed book, a new document; synthetic-2500-v1 is untouched.
    portfolioDocument(buildIndexedPortfolio()),
  ];

  // Market snapshot (Lab public market pack, Treasury CMT basis).
  const snapshot = await loadPublicMarket(repoRoot);
  docs.push(publicMarketDocument(snapshot));
  // The funding spread shock, derived from the SAME loaded
  // snapshot (the derivation never mutates its base). No run or plan binds it.
  const fundingShock = buildFundingSpreadShockMarket(snapshot);
  docs.push({
    collection: "market",
    id: fundingShock.id,
    doc: fundingShock.snapshot,
    meta: { ...derivedMarketMeta(fundingShock), seeded: true },
  });
  // The rate indices market, derived from the same snapshot. Only the indexed plan binds it.
  const rateIndexMarket = buildRateIndexMarket(snapshot);
  docs.push({
    collection: "market",
    id: rateIndexMarket.id,
    doc: rateIndexMarket.snapshot,
    meta: { ...derivedMarketMeta(rateIndexMarket), seeded: true },
  });
  // The volatility shock, derived from the same snapshot. No run or plan binds it.
  const volShock = buildVolShockMarket(snapshot);
  docs.push({
    collection: "market",
    id: volShock.id,
    doc: volShock.snapshot,
    meta: { ...derivedMarketMeta(volShock), seeded: true },
  });
  // The macro factors market, derived from the same snapshot. The three macro plans bind it.
  const macroMarket = buildMacroMarket(snapshot, repoRoot);
  docs.push({
    collection: "market",
    id: macroMarket.id,
    doc: macroMarket.snapshot,
    meta: { ...derivedMarketMeta(macroMarket), seeded: true },
  });

  // Assumption sets (ids come from the @alm/data builders; the stress set is
  // seeded here: W4-P8, illustrative parameters, see buildStressAssumptions).
  docs.push(
    setDocument(buildDemoAssumptions()),
    setDocument(vanillaAssumptionSet()),
    setDocument(buildStressAssumptions()),
    setDocument(buildLiquidityStressAssumptions()),
    setDocument(buildLiquiditySqueezeAssumptions()),
    setDocument(buildLoanRepricingAssumptions()),
    derivedSetDocument(buildDecayShockAssumptions()),
    // The two housing demonstration sets, bound through the engine.
    setDocument(buildHousingAssumptions(SEED_IDS.housingAssumptions, "hpi-down-30", "Demo behavioral set with the house-price response, mapped to hpi-down-30 (illustrative)")),
    setDocument(buildHousingAssumptions(SEED_IDS.housingFlatAssumptions, "hpi-flat", "Demo behavioral set with the house-price response, mapped to hpi-flat (illustrative)")),
  );

  // Scenario slates: one regulatory grid per seeded set.
  docs.push(
    slateDocument(SEED_IDS.demoSlate, "Regulatory grid (demo behavioral set)", buildDemoScenarios()),
    slateDocument(
      SEED_IDS.vanillaSlate,
      "Regulatory grid (vanilla, no overlays)",
      alignVanillaScenarioIds(vanillaScenarios(SEED_IDS.vanillaAssumptions)),
    ),
    slateDocument(
      SEED_IDS.stressSlate,
      "Regulatory grid (ILLUSTRATIVE stress set, not calibrated)",
      buildStressScenarios(),
    ),
    slateDocument(
      SEED_IDS.liquiditySlate,
      "Liquidity stress (ILLUSTRATIVE deposit run-off) on base and +/-200bp",
      buildLiquidityStressScenarios(),
    ),
    slateDocument(
      SEED_IDS.squeezeSlate,
      "Liquidity squeeze (deposit run-off plus committed-line draws, no wholesale renewal) on base and +/-200bp",
      buildLiquiditySqueezeScenarios(),
    ),
    slateDocument(
      SEED_IDS.loanRepricingSlate,
      "Regulatory grid (demo loan repricing set)",
      buildLoanRepricingScenarios(),
    ),
    slateDocument(
      SEED_IDS.decayShockSlate,
      "Regulatory grid (deposit decay shock, demonstration values)",
      buildDecayShockScenarios(),
    ),
  );

  // The base balance plan and the shock derived from it. The
  // base must lower on the synthetic book it is seeded against (every target, at
  // the 360-month grid), so a plan that cannot run refuses the seed. Demonstration
  // values, calibrated to nothing. No seeded run plan binds either plan: none has
  // a balance stage, and slates cannot carry a balance plan.
  {
    const book = buildSyntheticPortfolio();
    const base = buildDemoBalancePlan();
    const openings = new Map<string, number>();
    for (const p of book.positions) openings.set(p.familyId, (openings.get(p.familyId) ?? 0) + p.terms.notional);
    try {
      lowerBalancePlan(base, openings, 360, book.asOf);
    } catch (err) {
      throw new Error(
        `seed: balance plan "${base.id}" does not lower: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    docs.push(balancePlanDocument(base), derivedBalancePlanDocument(buildBalanceShockPlan()));
  }

  // The behavioral routing policy the plan routing gate enforces (harness
  // Plane 4), parsed through the engine so a malformed file refuses here.
  docs.push(routingPolicyDocument(repoRoot));

  // Studio S2: one runnable plan per demo book, the documents the plan
  // builder opens. Stored as authored (key order kept), never parser-rebuilt.
  for (const plan of buildSeedRunPlans({
    market: SEED_IDS.market,
    routingPolicy: SEED_IDS.routingPolicy,
    syntheticPortfolio: SEED_IDS.syntheticPortfolio,
    hedgedPortfolio: SEED_IDS.hedgedPortfolio,
    vanillaPortfolio: SEED_IDS.vanillaPortfolio,
    demoAssumptions: SEED_IDS.demoAssumptions,
    vanillaAssumptions: SEED_IDS.vanillaAssumptions,
    loanRepricingAssumptions: SEED_IDS.loanRepricingAssumptions,
    lcrLiabilityPortfolio: SEED_IDS.lcrLiabilityPortfolio,
    indexedPortfolio: SEED_IDS.indexedPortfolio,
    rateIndexMarket: SEED_IDS.rateIndexMarket,
    macroMarket: SEED_IDS.macroMarket,
    housingAssumptions: SEED_IDS.housingAssumptions,
    housingFlatAssumptions: SEED_IDS.housingFlatAssumptions,
  })) {
    docs.push({
      collection: "run-plans",
      id: plan.planId,
      doc: plan,
      meta: { label: plan.label, positionBook: plan.inputs.positionBook, asOf: plan.asOf, seeded: true },
    });
  }

  // Demo COA for CSV intake.
  docs.push({
    collection: "coa",
    id: SEED_IDS.demoCoa,
    doc: buildChartOfAccounts(),
    meta: { label: "Demo chart of accounts (11 families)", seeded: true },
  });
  // The example bank's own chart of accounts, so the v2 CSV template (a swap, a cd
  // cohort book, a commitment, a floating liability) imports against a stored chart. Read from the example file, the
  // one source of the bank.
  const exampleBank = JSON.parse(readFileSync(join(repoRoot, "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec;
  docs.push({
    collection: "coa",
    id: SEED_IDS.exampleBankCoa,
    doc: exampleBank.coa,
    meta: { label: `Quillfield Bank chart of accounts (${exampleBank.coa.families.length} families)`, seeded: true },
  });

  // Demo dimension taxonomy for CSV dim.<id> tag columns, validated
  // through the engine's D1 rules. The probe spec carries no position, so only
  // the taxonomy rules run.
  const taxonomy = buildDemoTaxonomy(repoRoot);
  const taxonomyProblems = validateDimensions({
    id: "seed-taxonomy-probe",
    label: "seed-time taxonomy probe",
    asOf: "1970-01-01",
    coa: buildChartOfAccounts(),
    positions: [],
    taxonomy,
  });
  if (taxonomyProblems.length > 0) {
    throw new Error(
      `seed: taxonomy "${taxonomy.id}" is not valid: ` +
        taxonomyProblems.map((p) => `${p.rule} ${p.dimension}: ${p.message}`).join("; "),
    );
  }
  // Pieces 5b, 6 and 7: the hqla, liquidity and v2 liquidity taxonomies. v2 is
  // a second document, not an edit of v1.
  for (const t of [taxonomy, HQLA_TAXONOMY, LIQUIDITY_TAXONOMY, LIQUIDITY_TAXONOMY_V2]) {
    docs.push({
      collection: "taxonomy",
      id: t.id,
      doc: t,
      meta: { label: t.label, dimensionCount: t.dimensions.length, seeded: true },
    });
  }

  // The six demo lens definitions (pieces 3a to 3c). The FIRST problem refuses
  // the whole seed. The seed is the only writer of a lens: there is no write route.
  for (const lens of buildDemoLenses(repoRoot)) {
    const problems = validateLens(lens);
    if (problems.length > 0) {
      throw new Error(
        `seed: lens "${lens.id}" is not valid: ` +
          problems.map((p) => `${p.rule} ${p.field}: ${p.message}`).join("; "),
      );
    }
    docs.push({
      collection: "lens",
      id: lens.id,
      doc: lens,
      meta: { label: lens.label, objective: lens.objective, constraintCount: lens.constraints.length, seeded: true },
    });
  }

  // The feature demos on the example bank, before the hierarchy (which stays last), so no earlier
  // document moves: the two sets they name, bound through the engine, then one run setup per demo, through the
  // run-setups route's own parse gate and id rule (src/examples/featureDemos.ts). No workspace pins them until the
  // Studio's Feature demos card opens one on the Example bank workspace.
  docs.push(...planFeatureDemoDocuments(repoRoot));
  // The deposit desk's five sets and the seven deposit-form setups, after the documents and
  // still before the hierarchy, so no earlier document moves.
  docs.push(...planDepositFormDocuments(repoRoot));
  // The survival-path setup, after the documents and still before the hierarchy, so
  // no earlier document moves. Its one set is the illustrative set, already seeded above.
  docs.push(...planSurvivalPathDocuments(repoRoot));

  // The one demonstration hierarchy, written last. Validated on every
  // seed against the lcr book above; the FIRST failure refuses the whole seed.
  const hierarchy = buildDemoHierarchy();
  const hierarchyProblems = [
    ...validateHierarchy(hierarchy),
    ...checkAgainstBook(hierarchy, lcrBook).problems,
    ...checkAgainstBook(hierarchy, liabilityBook).problems,
  ];
  if (hierarchyProblems.length > 0) {
    throw new Error(`seed: hierarchy "${hierarchy.id}" is not valid: ${hierarchyProblems.join("; ")}`);
  }
  // Every liability-book position must carry the source tag, so
  // its re-tagged copy leaves nothing untagged.
  const untagged = liabilityBook.positions.find((p) => p.dimensions?.[hierarchy.sourceDimension] === undefined);
  if (untagged !== undefined) {
    throw new Error(`seed: book "${liabilityBook.id}" has a position without ${hierarchy.sourceDimension}: ${untagged.id}`);
  }
  docs.push({
    collection: "hierarchies",
    id: hierarchy.id,
    doc: hierarchy,
    meta: {
      label: hierarchy.label,
      kind: hierarchy.kind,
      sourceDimension: hierarchy.sourceDimension,
      checkedBookId: SEED_IDS.lcrPortfolio,
      seeded: true,
    },
  });
  return docs;
}

/** The feature demos' sets and setups, as seed documents (both core profiles). */
export function planFeatureDemoDocuments(repoRoot: string): SeedDocument[] {
  const out: SeedDocument[] = featureDemoSets(repoRoot).map((s) => setDocument(s));
  for (const d of featureDemos(repoRoot)) {
    out.push({ collection: "run-setups", id: d.setup.id, doc: d.setup, meta: { label: d.setup.name, demo: d.id, bookId: DEMO_BOOK_ID, seeded: true } });
  }
  return out;
}

/** The deposit desk's sets and the deposit-form setups, as seed documents (both core profiles). */
export function planDepositFormDocuments(repoRoot: string): SeedDocument[] {
  const out: SeedDocument[] = depositFormSets(repoRoot).map((s) => setDocument(s));
  for (const d of depositFormDemos(repoRoot)) {
    out.push({ collection: "run-setups", id: d.setup.id, doc: d.setup, meta: { label: d.setup.name, demo: d.id, bookId: d.bookId, seeded: true } });
  }
  return out;
}

/** The survival-path setup, as a seed document (both core profiles). Its set is S3b-1's. */
export function planSurvivalPathDocuments(repoRoot: string): SeedDocument[] {
  return survivalPathDemos(repoRoot).map((d) => ({ collection: "run-setups", id: d.setup.id, doc: d.setup, meta: { label: d.setup.name, demo: d.id, bookId: d.bookId, seeded: true } }));
}

/** How the seed runs: default append-only, read-only check, named refresh, or named retire. */
export type SeedOptions =
  | { mode: "seed" }
  | { mode: "check" }
  | { mode: "refresh"; targets: string[]; stamp?: string }
  | { mode: "retire"; targets: string[]; stamp?: string };

export type RetireRefusal = "not-retired" | "absent" | "named-by-runs" | "named-by-workspaces";

const RETIRE_REFUSAL_TEXT: Record<RetireRefusal, string> = {
  "not-retired": "it is not on the seed's retired list (RETIRED_SEED_IDS)",
  absent: "the store does not hold it",
  "named-by-runs": "stored runs name it, and the database rebuild needs every document a run names",
  "named-by-workspaces": "a workspace pins it, or a setup's consumed pins name it",
};

/** A named retire target the seed will not move. Thrown before any file moves. */
export class SeedRetireRefusedError extends Error {
  readonly target: string;
  readonly reason: RetireRefusal;
  readonly runs: string[];
  /** The workspace ids that name the target; set for "named-by-workspaces" only. */
  readonly workspaces: string[];
  constructor(target: string, reason: RetireRefusal, named: string[] = []) {
    const list = named.length > 0 ? ` (${named.join(", ")})` : "";
    super(`seed: refusing to retire "${target}": ${RETIRE_REFUSAL_TEXT[reason]}${list}; nothing was moved`);
    this.name = "SeedRetireRefusedError";
    this.target = target;
    this.reason = reason;
    this.runs = reason === "named-by-runs" ? named : [];
    this.workspaces = reason === "named-by-workspaces" ? named : [];
  }
}

/** Resolve every retire target to a retired document the store holds and no run names, or throw. Reads only. */
function retireTargets(
  retired: RetiredDocument[],
  targets: string[],
  workspacesNaming: (collection: Collection, id: string) => string[] = () => [],
): RetiredDocument[] {
  const out: RetiredDocument[] = [];
  for (const target of targets) {
    // A workspace pin is decided first, for any target (spec A+E Section 2.6): a pinned document never moves.
    const slash = target.indexOf("/");
    if (slash > 0) {
      const named = workspacesNaming(target.slice(0, slash) as Collection, target.slice(slash + 1));
      if (named.length > 0) throw new SeedRetireRefusedError(target, "named-by-workspaces", named);
    }
    if (!RETIRED_SEED_IDS.some((r) => `${r.collection}/${r.id}` === target)) {
      throw new SeedRetireRefusedError(target, "not-retired");
    }
    const held = retired.find((r) => `${r.collection}/${r.id}` === target);
    if (held === undefined) throw new SeedRetireRefusedError(target, "absent");
    if (held.runs.length > 0) throw new SeedRetireRefusedError(target, "named-by-runs", held.runs);
    if (!out.includes(held)) out.push(held);
  }
  return out;
}

export type RefreshRefusal = "unknown" | "absent" | "not-seeded" | "not-stale";

const REFUSAL_TEXT: Record<RefreshRefusal, string> = {
  unknown: "the seed writes no document under that collection and id",
  absent: "the store does not hold it; a default seed writes it",
  "not-seeded": "its stored meta is not seeded: true, so it is an imported document",
  "not-stale": "its stored hash already equals what the seed writes today",
};

/** A named refresh target the seed will not supersede. Thrown before any file moves. */
export class SeedRefreshRefusedError extends Error {
  readonly target: string;
  readonly reason: RefreshRefusal;
  constructor(target: string, reason: RefreshRefusal) {
    super(`seed: refusing to refresh "${target}": ${REFUSAL_TEXT[reason]}; nothing was moved`);
    this.name = "SeedRefreshRefusedError";
    this.target = target;
    this.reason = reason;
  }
}

/**
 * A refresh that failed after at least one target was superseded and rewritten.
 * Carries the records already moved so the CLI can print the database rebuild.
 */
export class SeedRefreshIncompleteError extends Error {
  readonly superseded: SupersededRecord[];
  constructor(superseded: SupersededRecord[], cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`${why} (stopped after ${superseded.length} target(s) superseded)`, { cause });
    this.name = "SeedRefreshIncompleteError";
    this.superseded = superseded;
  }
}

/** A filesystem-safe, time-sorted stamp for superseded/<stamp>/. */
export function supersedeStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Resolve every refresh target to a stale planned document, or throw. Reads only. */
function refreshTargets(planned: SeedDocument[], standings: Standing[], targets: string[]): number[] {
  const out: number[] = [];
  for (const target of targets) {
    const i = planned.findIndex((d) => `${d.collection}/${d.id}` === target);
    if (i < 0) throw new SeedRefreshRefusedError(target, "unknown");
    const kind = standings[i].kind;
    if (kind === "absent") throw new SeedRefreshRefusedError(target, "absent");
    if (kind === "not-seeded") throw new SeedRefreshRefusedError(target, "not-seeded");
    if (kind === "current") throw new SeedRefreshRefusedError(target, "not-stale");
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

/**
 * Seed a store. Safe to call on every boot: existing ids are skipped, and a
 * skipped seeded document that differs from today's is reported, never rewritten.
 */
export async function seedStore(
  store: FileStore,
  repoRoot: string,
  options: SeedOptions = { mode: "seed" },
  profile: SeedProfile = CORE_SEED_PROFILE,
): Promise<SeedReport> {
  // Refresh and retire move documents a workspace pins, and the workspace mutex is in-process:
  // run them with the server stopped (spec A+E Section 2.6). Decided before anything is read.
  const workspaces = new WorkspaceStore(store.paths.root);
  if (options.mode === "refresh" || options.mode === "retire") {
    const live = workspaces.liveServer();
    if (live !== null) {
      throw new Error(`seed: a platform server (pid ${live.pid}, since ${live.startedAt}) is live on this store; stop it first`);
    }
  }
  const planned = await planSeedDocuments(repoRoot, profile);
  // Classification reads only, and precedes every write in every mode.
  const standings = planned.map((d) => standingOf(store, d));
  // Every refusal is decided here, before any directory is made or any file moves.
  const moves = options.mode === "refresh" ? refreshTargets(planned, standings, options.targets) : [];
  const retires =
    options.mode === "retire"
      ? retireTargets(retiredInStore(store), options.targets, (c, i) => namingWorkspaces(workspaces, c, i))
      : [];
  // --check writes nothing: no collection directory, no document, no meta, no database.
  if (options.mode !== "check") store.init();

  const report: SeedReport = { written: [], skipped: [], stale: [], retired: [] };
  // A retire moves the pair aside and writes nothing in its place.
  if (options.mode === "retire") {
    const stamp = options.stamp ?? supersedeStamp();
    const superseded: SupersededRecord[] = [];
    report.superseded = superseded;
    try {
      for (const r of retires) superseded.push(store.supersedeDocument(r.collection, r.id, stamp, "retired"));
    } catch (err) {
      if (superseded.length === 0) throw err;
      throw new SeedRefreshIncompleteError(superseded, err);
    }
  }
  // Each target is moved and then rewritten before the next one moves, so a
  // failure leaves at most the failing target unmoved (supersedeDocument is
  // all-or-nothing) and every earlier target already holds today's document.
  const refreshed = new Set<number>();
  if (options.mode === "refresh") {
    const stamp = options.stamp ?? supersedeStamp();
    const superseded: SupersededRecord[] = [];
    report.superseded = superseded;
    try {
      for (const i of moves) {
        const s = standings[i];
        const d = planned[i];
        if (s.kind !== "stale") throw new Error(`seed: internal: ${d.collection}/${d.id} is not stale`);
        superseded.push(store.supersedeDocument(s.finding.collection, s.finding.id, stamp, s.finding.currentHash));
        store.putDocument(d.collection, d.id, d.doc, d.meta);
        report.written.push(`${d.collection}/${d.id}`);
        refreshed.add(i);
        // Seed-only workspaces follow the document to its new bytes; every other pin stays and
        // resolves through findPinned from superseded/.
        const moved = repinSeedOnly(
          workspaces,
          d.collection,
          d.id,
          s.finding.storedHash,
          store.getMeta(d.collection, d.id).contentHash,
          new Date().toISOString(),
        );
        if (moved.length > 0) (report.repinned ??= []).push(...moved);
      }
    } catch (err) {
      if (superseded.length === 0) throw err;
      throw new SeedRefreshIncompleteError(superseded, err);
    }
  }

  const missing: string[] = [];
  for (let i = 0; i < planned.length; i++) {
    if (refreshed.has(i)) continue;
    const d = planned[i];
    const standing = standings[i];
    const key = `${d.collection}/${d.id}`;
    if (standing.kind === "absent") {
      if (options.mode === "check") {
        missing.push(key);
        continue;
      }
      store.putDocument(d.collection, d.id, d.doc, d.meta);
      report.written.push(key);
      continue;
    }
    report.skipped.push(key);
    if (standing.kind === "stale") report.stale.push(standing.finding);
  }
  if (options.mode === "check") report.missing = missing;
  report.retired = retiredInStore(store);
  // Only the default seed syncs the database. A refresh or retire leaves
  // platform.db pinning the moved document; the CLI prints the rebuild.
  if (options.mode !== "seed") return report;

  // Mirror the store into the platform database. Idempotent:
  // content already mirrored is skipped by hash; the file store stays the byte
  // store of record and a divergence refuses loudly rather than syncing.
  const db = openPlatformDb(defaultDbPath(store.paths.root));
  try {
    report.dbSync = syncStoreToDb(store, db);
  } finally {
    db.close();
  }

  // Studio A+E contract 10: derive the workspaces from the store by rule. Creates only ids that are
  // absent, so a boot never rewrites a head an analyst has edited.
  if (NO_WORKSPACE_PROFILES.includes(profile)) {
    // The starter store holds no workspace: the Studio's first screen offers the three start choices. The
    // learn store's workspaces are made after boot by the learn kit, through the Studio's own calls.
    report.workspaces = { created: [], unnamedAttachments: [], unattached: [], runsAttached: [], legacyWorkspace: null, unimportedPlans: [], expectedToFail: [] };
    return report;
  }
  if (profile !== CORE_SEED_PROFILE) {
    // A registered profile's own workspaces first (authored, not derived from run plans), then the generic rules,
    // which create nothing on such a store and attach any run submitted outside a launch.
    const wsStore = new WorkspaceStore(store.paths.root);
    const created = await seedProfileEntry(profile).seedWorkspaces(store, wsStore);
    const generic = seedWorkspaces(store, wsStore);
    report.workspaces = { ...generic, created: [...created, ...generic.created], unnamedAttachments: [] };
    return report;
  }
  report.workspaces = seedWorkspaces(store, new WorkspaceStore(store.paths.root));
  return report;
}

/**
 * Parse the CLI arguments: none, --check, one or more --refresh <collection>/<id>,
 * or one or more --retire <collection>/<id>. Refresh and retire do not mix.
 */
export function parseSeedArgs(argv: string[]): SeedOptions {
  if (argv.length === 0) return { mode: "seed" };
  if (argv.length === 1 && argv[0] === "--check") return { mode: "check" };
  const flag = argv[0];
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if ((flag === "--refresh" || flag === "--retire") && argv[i] === flag && next !== undefined && !next.startsWith("--")) {
      targets.push(next);
      i++;
      continue;
    }
    throw new Error(
      `seed: unrecognized arguments ${JSON.stringify(argv)}; use no argument, --check, ` +
        `--refresh <collection>/<id> (repeatable), or --retire <collection>/<id> (repeatable); ` +
        `refresh and retire need the platform server stopped`,
    );
  }
  return { mode: flag === "--retire" ? "retire" : "refresh", targets };
}

/** The CLI body, separated from process state so tests drive it. Returns the exit code. */
export async function runSeedCli(
  argv: string[],
  store: FileStore,
  repoRoot: string,
  log: (line: string) => void = (line) => console.log(line),
  profile: SeedProfile = CORE_SEED_PROFILE,
): Promise<number> {
  const parsed = parseSeedArgs(argv);
  const stamp = supersedeStamp();
  const options: SeedOptions =
    parsed.mode === "refresh" || parsed.mode === "retire" ? { mode: parsed.mode, targets: parsed.targets, stamp } : parsed;
  const root = store.paths.root;
  let report: SeedReport;
  try {
    report = await seedStore(store, repoRoot, options, profile);
  } catch (err) {
    // A refresh that stopped partway still moved targets: print the rebuild, then fail.
    if (err instanceof SeedRefreshIncompleteError) {
      log(`seed: ${options.mode} stopped partway: ${err.message}`);
      logSuperseded(log, root, stamp, err.superseded);
    }
    throw err;
  }
  log(`seed: store at ${root}`);
  // Named only off the default, so the demo output reads as it always did.
  if (profile !== "demo") log(`seed: profile ${profile}`);
  for (const w of report.written) log(`seed: wrote   ${w}`);
  for (const s of report.skipped) log(`seed: skipped ${s} (exists; store is append-only)`);
  for (const m of report.missing ?? []) log(`seed: missing ${m} (a default seed would write it)`);
  for (const s of report.stale) for (const line of formatStaleBlock(s)) log(line);
  for (const r of report.retired) for (const line of formatRetiredBlock(r)) log(line);
  for (const p of report.repinned ?? []) {
    log(`seed: re-pinned workspace ${p.workspaceId} ${p.block} ${p.id} (old ${p.from}, new ${p.to})`);
  }
  if (report.dbSync !== undefined) {
    const d = report.dbSync;
    log(
      `seed: db mirror: ${d.documentsIngested.length} document(s) ingested, ${d.documentsSkipped} already mirrored, ` +
        `${d.positionsInserted} position row(s), ${d.curvePointsInserted} curve point(s), ${d.elapsedMs} ms`,
    );
  }
  if (report.workspaces !== undefined) for (const line of formatWorkspaceSeedReport(report.workspaces, "seed:")) log(line);
  logSuperseded(log, root, stamp, report.superseded ?? []);
  return options.mode === "check" && (report.stale.length > 0 || report.retired.length > 0) ? 1 : 0;
}

/** Print each superseded move and, when any moved, the database rebuild. */
function logSuperseded(log: (line: string) => void, root: string, stamp: string, superseded: SupersededRecord[]): void {
  for (const r of superseded) {
    log(
      `seed: superseded ${r.collection}/${r.id} into ${join(root, "superseded", stamp, r.collection)} ` +
        `(old ${r.oldHash}, new ${r.newHash})`,
    );
  }
  if (superseded.length > 0) {
    log(`seed: platform.db was NOT synced; it still pins the superseded hash and now diverges from the file store.`);
    log(`seed: the next boot or default seed refuses (StoreDivergenceError) until it is rebuilt. With the server stopped:`);
    log(`seed:   npx tsx apps/server/scripts/migrate-store.ts --store ${root} --db ${join(root, "platform.rebuilt.db")}`);
    log(
      `seed:   then move ${join(root, "platform.db")} (and platform.db-wal, platform.db-shm if present) into ` +
        `${join(root, "superseded", stamp)}/ and rename platform.rebuilt.db to platform.db`,
    );
  }
}

// CLI entry: seed the configured store.
const invokedDirectly = process.argv[1] !== undefined && /seed-store\.(ts|mjs|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  // The optional extension folder, when present, registers its seed profiles before the profile is resolved.
  loadCompanion()
    .then(() => {
      const config = resolveConfig();
      return runSeedCli(process.argv.slice(2), new FileStore(config.storeRoot), config.repoRoot, undefined, config.seedProfile ?? CORE_SEED_PROFILE);
    })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
