/**
 * Workspace lifecycle rules (Studio A+E spec v3.1 Sections 2.4 and 2.5), as pure
 * functions over a manifest. Every refusal is a typed HTTP error from
 * `http/errors.ts`: 409 for a state conflict (locked, archived, superseded,
 * Production uniqueness), 422 for a body the rules refuse, with the field named.
 *
 *   requireBy              the typed-never-verified `by` on every mutating body
 *   assertWritable         locked, archived and superseded refuse block writes
 *   assertMetaWritable     rename and note stay open on locked, refused on archived and superseded
 *   assertBlockMember      which collections belong to which block
 *   productionUnique       one Production workspace per cut-off among the non-superseded
 *   clashOutcome           the cut-off clash rule: block for Production, warn for the rest
 *   assertSnapshotMovable  the base snapshot never moves under live derived markets
 *   applyDefaultSetRule    the default assumption set (MAJOR 4)
 *   applyBlockOp           one set, add, remove or set-default over the six blocks
 *   writeBlockOp           applyBlockOp plus the commit and, when warned, the clash line
 */
import type { Collection } from "../store/paths";
import { conflict, unprocessable } from "../http/errors";
import { RevisionConflict, type WorkspaceStore } from "./workspaceStore";
import type {
  AssumptionsBlock,
  BlockName,
  DerivedRef,
  DocRef,
  HistoryChange,
  WorkspaceBlocks,
  WorkspaceManifest,
  WorkspaceType,
} from "./types";

export const WORKSPACE_TYPES: readonly WorkspaceType[] = ["production", "test", "ftp", "stress", "monthly"];
export const BLOCK_OPS = ["set", "add", "remove", "set-default"] as const;
export type BlockOp = (typeof BLOCK_OPS)[number];

/**
 * Which collections each block may hold. `run-setups`, `curve-setups` (the market
 * block's saved curve setups) and `derived-curves` (its saved derived curves)
 * are written by their own routes, never here.
 */
export const BLOCK_COLLECTIONS: Record<BlockName, readonly Collection[]> = {
  market: ["market"],
  positions: ["portfolios", "coa", "taxonomy", "hierarchies"],
  targets: ["plans"],
  assumptions: ["assumption-sets", "routing-policies"],
  scenarios: ["scenario-slates"],
  run: ["lens"],
};

export const BY_MAX = 80;
export const NAME_MAX = 80;
export const NOTE_MAX = 500;

/**
 * A slot's lineage id (a run setup slot, or a curve setup's own `id`). It lives in the manifest and a URL,
 * never the store: an imported run setup is `setup-<planId>`, so 6 plus a store id of
 * at most 64, up to 70 characters; a new slot is 14.
 */
export const LINEAGE_PATTERN = /^[A-Za-z0-9._-]{1,70}$/;

// ---------------------------------------------------------------------------
// Body fields
// ---------------------------------------------------------------------------

/** `by`: a string of 1 to BY_MAX characters, typed and never verified (the approvals convention). */
export function requireByValue(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > BY_MAX) {
    throw unprocessable(`"by" is required: a string of 1 to ${BY_MAX} characters naming who makes this change`, { field: "by" });
  }
  return value;
}

export function requireBy(body: Record<string, unknown>): string {
  return requireByValue(body.by);
}

/** `expectedRevision`: the head revision the client read, a positive integer. */
export function requireExpectedRevision(body: Record<string, unknown>): number {
  const v = body.expectedRevision;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw unprocessable(`"expectedRevision" is required: the integer revision of the workspace head you read`, { field: "expectedRevision" });
  }
  return v;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO calendar date (YYYY-MM-DD): the one check the create and clone routes share. */
export function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw unprocessable(`"${field}" is required: an ISO date (YYYY-MM-DD)`, { field });
  }
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw unprocessable(`"${field}" ${value} is not a calendar date`, { field });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Status refusals
// ---------------------------------------------------------------------------

/**
 * Block writes, imports and launches: refused on a locked, archived or superseded workspace (409).
 * Archive applies it to every status but `locked` (a signed month may be archived, keeping its lock).
 */
export function assertWritable(head: WorkspaceManifest): void {
  switch (head.status) {
    case "locked":
      throw conflict(
        `workspace "${head.id}" is locked by approval ${head.lock?.approvalId ?? "(unrecorded)"}; a signed Production ` +
          `workspace changes only by clone (a supersede clone corrects the month)`,
      );
    case "archived":
      throw conflict(`workspace "${head.id}" is archived and read-only; clone it to keep working`);
    case "superseded":
      throw conflict(
        `workspace "${head.id}" was superseded by "${head.lineage.supersededBy ?? "(pending)"}" and is read-only; ` +
          `work in the superseding workspace`,
      );
    default:
  }
}

/** Rename and note stay open on `locked` (a signed month may need a note naming its correction). */
export function assertMetaWritable(head: WorkspaceManifest): void {
  if (head.status === "archived") throw conflict(`workspace "${head.id}" is archived; rename and note are closed`);
  if (head.status === "superseded") {
    throw conflict(
      `workspace "${head.id}" was superseded by "${head.lineage.supersededBy ?? "(pending)"}"; rename and note are closed`,
    );
  }
}

// ---------------------------------------------------------------------------
// Membership, Production uniqueness, the clash rule
// ---------------------------------------------------------------------------

export function assertBlockMember(block: BlockName, collection: Collection): void {
  const allowed = BLOCK_COLLECTIONS[block];
  if (!allowed.includes(collection)) {
    throw unprocessable(
      `collection "${collection}" does not belong to the ${block} block; it holds ${allowed.join(", ")}`,
      { field: "ref.collection", block },
    );
  }
}

/**
 * The Production workspace already holding this cut-off among the non-superseded, or null.
 * `excludeId` leaves the workspace being written out of the comparison.
 */
export function productionUnique(
  list: readonly WorkspaceManifest[],
  type: WorkspaceType,
  cutoffDate: string,
  excludeId: string | null,
): WorkspaceManifest | null {
  if (type !== "production") return null;
  return (
    list.find(
      (w) => w.type === "production" && w.cutoffDate === cutoffDate && w.status !== "superseded" && w.id !== excludeId,
    ) ?? null
  );
}

/** Ruling 5: block for Production, warn for every other type, whenever the document date differs from the cut-off. */
export function clashOutcome(type: WorkspaceType, cutoffDate: string, documentAsOf: string): "ok" | "warn" | "refuse" {
  if (documentAsOf === cutoffDate) return "ok";
  return type === "production" ? "refuse" : "warn";
}

function refuseClash(head: WorkspaceManifest, what: string, documentAsOf: string): never {
  throw unprocessable(
    `${what} is dated ${documentAsOf}, but workspace "${head.id}" is Production with cut-off ${head.cutoffDate}; a Production ` +
      `workspace holds only documents dated at its cut-off. Import a document dated ${head.cutoffDate}, or work in a ` +
      `workspace at ${documentAsOf} (a roll-forward clone carries a month's definitions to a later cut-off)`,
    { field: "asOf", cutoffDate: head.cutoffDate, documentAsOf },
  );
}

/**
 * The refusal an import raises before it stores anything: throws 422 for a Production workspace
 * whose cut-off differs from the date the document will carry, returns the outcome otherwise.
 */
export function checkImportClash(head: WorkspaceManifest, what: string, documentAsOf: string): "ok" | "warn" {
  const outcome = clashOutcome(head.type, head.cutoffDate, documentAsOf);
  if (outcome === "refuse") refuseClash(head, what, documentAsOf);
  return outcome;
}

/**
 * The base snapshot never moves under live derived markets (review B, M1): spec Sections 2.2 and
 * 2.5 rest on every derived entry sitting on the block's own base. While `derived` is non-empty a
 * set or remove of the snapshot is refused 422 naming the derived ids; the derived markets come out
 * first (a roll-forward clone is the path that carries them to a new base as definitions).
 */
export function assertSnapshotMovable(market: Pick<WorkspaceBlocks["market"], "snapshot" | "derived">): void {
  if (market.derived.length === 0) return;
  const ids = market.derived.map((d) => d.id);
  throw unprocessable(
    `market snapshot "${market.snapshot?.id ?? "(none)"}" has derived markets built on it (${ids.join(", ")}); remove them before ` +
      `replacing or removing the base snapshot, or roll forward, which carries them as definitions to re-apply on the new base`,
    { field: "ref.id", derived: ids },
  );
}

// ---------------------------------------------------------------------------
// The default assumption set (MAJOR 4)
// ---------------------------------------------------------------------------

/**
 * The `defaultSetId` after an add, remove or set-default of set `id` against the block as it stood.
 * `add` into an empty block makes that set the default; `remove` of the default is refused unless it
 * is the last set (then null); `set-default` names a set already in the block.
 */
export function applyDefaultSetRule(
  assumptions: Pick<AssumptionsBlock, "sets" | "defaultSetId">,
  op: "add" | "remove" | "set-default",
  id: string,
): string | null {
  const present = assumptions.sets.some((s) => s.id === id);
  switch (op) {
    case "add":
      return assumptions.sets.length === 0 ? id : assumptions.defaultSetId;
    case "set-default":
      if (!present) {
        throw unprocessable(`assumption set "${id}" is not in this workspace's assumptions block; add it before making it the default`, {
          field: "ref.id",
        });
      }
      return id;
    case "remove":
      if (assumptions.defaultSetId === id) {
        if (assumptions.sets.length === 1) return null;
        throw unprocessable(`assumption set "${id}" is the workspace default; set another default first`, { field: "ref.id" });
      }
      return assumptions.defaultSetId;
  }
}

// ---------------------------------------------------------------------------
// One block operation
// ---------------------------------------------------------------------------

/** What the route read about the document from the file store (never from the mirror). */
export interface ResolvedDoc {
  collection: Collection;
  id: string;
  /** The store meta contentHash at pin time. */
  contentHash: string;
  /** A book's meta as-of, or a market snapshot's calibrationDate. */
  asOf?: string;
  /** A derived market's `derivedFrom.baseId`. */
  derivedFromId?: string;
  /** A retagged book's `sourceBookId` meta. */
  sourceBookId?: string;
  /** A launch slate's `fromPlan` meta: never listed in a scenarios block. */
  fromPlan?: string;
}

export interface BlockOpResult {
  blocks: WorkspaceBlocks;
  change: HistoryChange;
  /** Present when the set produced a warned cut-off clash (a non-Production workspace). */
  clash?: { block: "positions" | "market"; id: string; documentAsOf: string };
}

const refOf = (doc: ResolvedDoc, now: string): DocRef => ({ collection: doc.collection, id: doc.id, contentHash: doc.contentHash, pinnedAt: now });

function singleSlotOnly(block: BlockName, collection: Collection, op: BlockOp): never {
  throw unprocessable(`the ${block} block holds one ${collection} document in a single slot; use op "set" or "remove", not "${op}"`, { field: "op" });
}

function listOnly(block: BlockName, collection: Collection, op: BlockOp): never {
  throw unprocessable(`the ${block} block holds ${collection} as a list; use op "add" or "remove", not "${op}"`, { field: "op" });
}

function notInBlock(block: BlockName, collection: Collection, id: string): never {
  throw unprocessable(`${collection} document "${id}" is not in the ${block} block`, { field: "ref.id" });
}

function addToList(list: DocRef[], ref: DocRef, block: BlockName): DocRef[] {
  if (list.some((r) => r.id === ref.id)) {
    throw unprocessable(`${ref.collection} document "${ref.id}" is already in the ${block} block`, { field: "ref.id" });
  }
  return [...list, ref];
}

function removeFromList<T extends { id: string }>(list: T[], id: string, block: BlockName, collection: Collection): T[] {
  if (!list.some((r) => r.id === id)) notInBlock(block, collection, id);
  return list.filter((r) => r.id !== id);
}

/**
 * Apply one block operation to a head and return the next blocks plus the history change. `doc` is
 * required for set, add and set-default (resolved from the file store by the caller); a remove needs
 * only the id, so a document that left the store can still be taken out of a block. Throws 422 on
 * every rule refusal and never mutates `head`.
 */
export function applyBlockOp(
  head: WorkspaceManifest,
  block: BlockName,
  op: BlockOp,
  collection: Collection,
  id: string,
  doc: ResolvedDoc | null,
  now: string,
): BlockOpResult {
  assertBlockMember(block, collection);
  if (op === "set-default" && (block !== "assumptions" || collection !== "assumption-sets")) {
    throw unprocessable(`set-default applies to assumption sets in the assumptions block`, { field: "op" });
  }
  if (op !== "remove" && op !== "set-default" && doc === null) {
    throw new Error(`applyBlockOp: op "${op}" needs the resolved document`);
  }

  const blocks: WorkspaceBlocks = JSON.parse(JSON.stringify(head.blocks)) as WorkspaceBlocks;
  let clash: BlockOpResult["clash"];
  const ref = doc ? refOf(doc, now) : null;
  const changeOp: "set" | "add" | "remove" = op === "set-default" ? "set" : op;

  const checkClash = (which: "positions" | "market", what: string): void => {
    const asOf = doc!.asOf;
    if (asOf === undefined) {
      if (head.type === "production") {
        throw unprocessable(`${what} carries no as-of date, so it cannot be held by a Production workspace`, { field: "asOf" });
      }
      return;
    }
    if (checkImportClash(head, what, asOf) === "warn") clash = { block: which, id, documentAsOf: asOf };
  };

  switch (block) {
    case "market": {
      const m = blocks.market;
      if (op === "set") {
        if (doc!.derivedFromId !== undefined) {
          throw unprocessable(`market "${id}" is derived from "${doc!.derivedFromId}"; add a derived market with op "add" and set the base snapshot with "set"`, { field: "op" });
        }
        assertSnapshotMovable(m);
        checkClash("market", `market snapshot "${id}"`);
        m.snapshot = ref;
      } else if (op === "add") {
        if (doc!.derivedFromId === undefined) {
          throw unprocessable(`market "${id}" is a base snapshot; set it with op "set"`, { field: "op" });
        }
        if (m.snapshot === null) {
          throw unprocessable(`derived market "${id}" needs the base snapshot first; set the market snapshot before adding derived markets`, { field: "ref.id" });
        }
        if (m.derived.some((d) => d.id === id)) {
          throw unprocessable(`derived market "${id}" is already in the market block`, { field: "ref.id" });
        }
        const baseId = doc!.derivedFromId;
        let parentKey: string | null;
        if (baseId === m.snapshot.id) {
          parentKey = null;
        } else {
          const parent = m.derived.find((d) => d.id === baseId);
          if (!parent) {
            throw unprocessable(
              `derived market "${id}" derives from "${baseId}", which is neither the block's snapshot nor a listed derived market; add its parent first`,
              { field: "ref.id" },
            );
          }
          parentKey = parent.definitionKey;
        }
        const derived: DerivedRef = { ...ref!, definitionKey: id, parentKey };
        m.derived = [...m.derived, derived];
      } else if (op === "remove") {
        const target = m.derived.find((d) => d.id === id);
        if (target) {
          const children = m.derived.filter((d) => d.parentKey === target.definitionKey).map((d) => d.id);
          if (children.length > 0) {
            throw unprocessable(
              `derived market "${id}" is the parent of ${children.join(", ")}; remove the children before their parent`,
              { field: "ref.id", children },
            );
          }
          m.derived = m.derived.filter((d) => d.id !== id);
        } else if (m.snapshot?.id === id) {
          assertSnapshotMovable(m);
          m.snapshot = null;
        } else notInBlock(block, collection, id);
      } else {
        singleSlotOnly(block, collection, op);
      }
      break;
    }
    case "positions": {
      const p = blocks.positions;
      if (collection === "portfolios") {
        if (op === "set") {
          if (doc!.sourceBookId !== undefined) {
            throw unprocessable(`book "${id}" is a retagged copy of "${doc!.sourceBookId}"; add a retagged book with op "add" and set the position book with "set"`, { field: "op" });
          }
          checkClash("positions", `position book "${id}"`);
          p.book = ref;
        } else if (op === "add") {
          if (doc!.sourceBookId === undefined) {
            throw unprocessable(`book "${id}" is not a retagged copy; set the position book with op "set"`, { field: "op" });
          }
          p.retagged = addToList(p.retagged, ref!, block);
        } else if (op === "remove") {
          if (p.book?.id === id) p.book = null;
          else p.retagged = removeFromList(p.retagged, id, block, collection);
        } else {
          singleSlotOnly(block, collection, op);
        }
      } else if (collection === "coa" || collection === "taxonomy") {
        if (op === "set") p[collection] = ref;
        else if (op === "remove") {
          if (p[collection]?.id !== id) notInBlock(block, collection, id);
          p[collection] = null;
        } else singleSlotOnly(block, collection, op);
      } else {
        // hierarchies
        if (op === "add") p.hierarchies = addToList(p.hierarchies, ref!, block);
        else if (op === "remove") p.hierarchies = removeFromList(p.hierarchies, id, block, collection);
        else listOnly(block, collection, op);
      }
      break;
    }
    case "targets": {
      const t = blocks.targets;
      if (op === "add") t.balancePlans = addToList(t.balancePlans, ref!, block);
      else if (op === "remove") t.balancePlans = removeFromList(t.balancePlans, id, block, collection);
      else listOnly(block, collection, op);
      break;
    }
    case "assumptions": {
      const a = blocks.assumptions;
      if (collection === "assumption-sets") {
        if (op === "set") listOnly(block, collection, op);
        if (op === "add") {
          const defaultSetId = applyDefaultSetRule(a, "add", id);
          a.sets = addToList(a.sets, ref!, block);
          a.defaultSetId = defaultSetId;
        } else if (op === "remove") {
          if (!a.sets.some((s) => s.id === id)) notInBlock(block, collection, id);
          const defaultSetId = applyDefaultSetRule(a, "remove", id);
          a.sets = a.sets.filter((s) => s.id !== id);
          a.defaultSetId = defaultSetId;
        } else {
          a.defaultSetId = applyDefaultSetRule(a, "set-default", id);
        }
      } else {
        // routing-policies
        if (op === "set") a.routingPolicy = ref;
        else if (op === "remove") {
          if (a.routingPolicy?.id !== id) notInBlock(block, collection, id);
          a.routingPolicy = null;
        } else singleSlotOnly(block, collection, op);
      }
      break;
    }
    case "scenarios": {
      const s = blocks.scenarios;
      if (op === "add") {
        if (doc!.fromPlan !== undefined) {
          throw unprocessable(
            `scenario slate "${id}" is the launch slate of plan "${doc!.fromPlan}"; launch slates the server writes are never listed in a workspace`,
            { field: "ref.id" },
          );
        }
        s.slates = addToList(s.slates, ref!, block);
      } else if (op === "remove") s.slates = removeFromList(s.slates, id, block, collection);
      else listOnly(block, collection, op);
      break;
    }
    case "run": {
      const r = blocks.run;
      if (op === "add") r.lenses = addToList(r.lenses, ref!, block);
      else if (op === "remove") r.lenses = removeFromList(r.lenses, id, block, collection);
      else listOnly(block, collection, op);
      break;
    }
  }

  const change: HistoryChange =
    op === "set-default" ? { kind: "set-default", setId: id } : { kind: "set-block", block, op: changeOp, ref: { collection, id } };
  return { blocks, change, ...(clash ? { clash } : {}) };
}

/**
 * Apply one block operation to the workspace head and commit it. The caller holds the workspace
 * lock. `expectedRevision` null means "the revision just read" (the import hooks, which carry no
 * client revision). A warned clash is a second history line, `{ kind: "clash" }`, that adds the
 * CutoffClash record to the head. Returns the head after the last commit.
 */
export function writeBlockOp(
  wsStore: WorkspaceStore,
  id: string,
  expectedRevision: number | null,
  by: string,
  block: BlockName,
  op: BlockOp,
  collection: Collection,
  docId: string,
  doc: ResolvedDoc | null,
): WorkspaceManifest {
  const head = wsStore.head(id);
  assertWritable(head);
  const revision = expectedRevision ?? head.revision;
  const now = new Date().toISOString();
  if (revision !== head.revision) throw new RevisionConflict(id, revision, head.revision);
  const result = applyBlockOp(head, block, op, collection, docId, doc, now);
  const after = wsStore.commit(id, head.revision, by, result.change, { ...head, blocks: result.blocks });
  if (!result.clash) return after;
  return wsStore.commit(
    id,
    after.revision,
    by,
    { kind: "clash", block: result.clash.block, id: result.clash.id, documentAsOf: result.clash.documentAsOf },
    {
      ...after,
      clashes: [
        ...after.clashes,
        { block: result.clash.block, id: result.clash.id, documentAsOf: result.clash.documentAsOf, recordedAt: now, outcome: "warned" },
      ],
    },
  );
}
