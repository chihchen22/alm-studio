/**
 * Workspace clone (Studio A+E spec v3.1 Sections 2.3, 2.4 and 2.10): copy, roll-forward and the
 * supersede clone, as pure builders plus one write function.
 *
 *   stemOf, defaultCloneId   the identifier rule: stem of the source id (a trailing `-copy-<4 hex>`
 *                            or `--YYYY-MM-DD` stripped, truncated to 40), never an append to an id
 *   copyBlocks               the checklist's blocks, carried whole
 *   rollForwardBlocks        the checklist's blocks, minus the book, retagged books, snapshot and
 *                            derived markets; each derived market becomes a CarriedDefinition
 *   buildCloneManifest       one clone head, revision 0, ready for WorkspaceStore.create
 *   writeClone               plain clone: one create. Supersede clone: three steps, the source marked
 *                            only after the new workspace is complete (a failing step leaves a state
 *                            boot reconcile completes forward, never back)
 *
 * The caller holds the workspace locks of both ids and has already applied every refusal rule.
 */
import { sha256Hex } from "../store/store";
import { BLOCK_NAMES, blockHashes } from "./hashes";
import type { WorkspaceStore } from "./workspaceStore";
import type {
  BlockName,
  CarriedDefinition,
  CutoffClash,
  SetupSlot,
  WorkspaceBlocks,
  WorkspaceManifest,
  WorkspaceType,
} from "./types";

export type CloneMode = "copy" | "roll-forward";

const STEM_MAX = 40;
/** `-copy-<4 hex>` or `--YYYY-MM-DD` with the optional `-<4 hex>` a taken roll-forward id carries. */
const SUFFIX = /(?:-copy-[0-9a-f]{4}|--\d{4}-\d{2}-\d{2}(?:-[0-9a-f]{4})?)$/;

/** The source id with its clone suffixes stripped until none remains, truncated to 40 characters. */
export function stemOf(id: string): string {
  let stem = id;
  for (let m = SUFFIX.exec(stem); m !== null; m = SUFFIX.exec(stem)) stem = stem.slice(0, m.index);
  return stem.slice(0, STEM_MAX);
}

/** Four lowercase hex of sha256 over the canonical pair, the spec's disambiguator. */
export function hex4(sourceId: string, salt: string): string {
  return sha256Hex(JSON.stringify([sourceId, salt])).slice(0, 4);
}

/**
 * The default id for a clone. Copy: `<stem>-copy-<4 hex of sha256(sourceId, now)>`.
 * Roll-forward: `<stem>--<cutoffDate>`. The caller appends `-<4 hex>` (roll-forward) or re-salts (copy)
 * when the id is taken.
 */
export function defaultCloneId(sourceId: string, mode: CloneMode, cutoffDate: string, now: string): string {
  const stem = stemOf(sourceId);
  return mode === "copy" ? `${stem}-copy-${hex4(sourceId, now)}` : `${stem}--${cutoffDate}`;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function emptyBlocks(): WorkspaceBlocks {
  return {
    market: { snapshot: null, derived: [], carried: [], carriedFrom: null },
    positions: { book: null, retagged: [], coa: null, taxonomy: null, hierarchies: [] },
    targets: { balancePlans: [], templates: [] },
    assumptions: { sets: [], defaultSetId: null, routingPolicy: null },
    scenarios: { slates: [] },
    run: { setups: [], lenses: [] },
  };
}

/**
 * Copy: every block the checklist names is carried whole, pins and `pinnedAt` as they stood. The market
 * block's saved curve setups and their active pointer ride in it: a copy and a
 * roll-forward both carry them by this plain copy of the whole block (rollForwardBlocks clears only the
 * snapshot, derived and carried keys), and an unticked market block starts with no curveSetups key. Saved
 * derived curves ride the same way under their derivedCurves key.
 */
export function copyBlocks(src: WorkspaceManifest, checklist: readonly BlockName[]): WorkspaceBlocks {
  const out = emptyBlocks();
  for (const b of checklist) (out as unknown as Record<string, unknown>)[b] = clone(src.blocks[b]);
  return out;
}

/**
 * The definitions a roll-forward carries: one per derived market of the source (awaiting, its
 * DocRef kept as the `source` pin), plus every definition the source itself still carried awaiting
 * or refused (reset to awaiting: a new month is a new chance). An applied carried entry is already
 * in `derived` under the same key, so it is not listed twice.
 */
export function carriedDefinitionsOf(src: WorkspaceManifest): CarriedDefinition[] {
  const out: CarriedDefinition[] = [];
  const seen = new Set<string>();
  for (const d of src.blocks.market.derived) {
    seen.add(d.definitionKey);
    out.push({
      definitionKey: d.definitionKey,
      parentKey: d.parentKey,
      source: { collection: d.collection, id: d.id, contentHash: d.contentHash, pinnedAt: d.pinnedAt },
      status: "awaiting",
      appliedId: null,
      refusal: null,
    });
  }
  for (const c of src.blocks.market.carried) {
    if (seen.has(c.definitionKey) || c.status === "applied") continue;
    seen.add(c.definitionKey);
    out.push({ ...clone(c), status: "awaiting", appliedId: null, refusal: null });
  }
  return out;
}

/**
 * Roll-forward: the date moves, so the book, retagged books, base snapshot and derived markets are
 * cleared whatever the checklist says. The market block (when ticked) holds the carried definitions
 * awaiting re-apply; every other ticked block is carried whole.
 */
export function rollForwardBlocks(src: WorkspaceManifest, checklist: readonly BlockName[], now: string): WorkspaceBlocks {
  const out = copyBlocks(src, checklist);
  out.positions.book = null;
  out.positions.retagged = [];
  out.market.snapshot = null;
  out.market.derived = [];
  out.market.carried = [];
  out.market.carriedFrom = null;
  if (checklist.includes("market")) {
    const carried = carriedDefinitionsOf(src);
    out.market.carried = carried;
    out.market.carriedFrom = carried.length > 0 ? { workspaceId: src.id, at: now } : null;
  }
  return out;
}

export interface CloneSpec {
  id: string;
  name: string;
  type: WorkspaceType;
  mode: CloneMode;
  /** The new cut-off: the source's for a copy, the later date for a roll-forward. */
  cutoffDate: string;
  checklist: readonly BlockName[];
  supersede: boolean;
  now: string;
  /** Called only when the run block is not ticked: a fresh Standard ALCO slot, as a blank workspace gets. */
  freshSetup: () => SetupSlot;
}

/** One clone head at revision 0, for `WorkspaceStore.create`. Nothing is written here. */
export function buildCloneManifest(src: WorkspaceManifest, spec: CloneSpec): WorkspaceManifest {
  const checklist = BLOCK_NAMES.filter((b) => spec.checklist.includes(b));
  const blocks = spec.mode === "copy" ? copyBlocks(src, checklist) : rollForwardBlocks(src, checklist, spec.now);
  if (!checklist.includes("run")) blocks.run = { setups: [spec.freshSetup()], lenses: [] };
  // A recorded clash belongs to the document it names: it follows that block on a copy and is dropped on a roll-forward.
  const clashes: CutoffClash[] = spec.mode === "copy" ? src.clashes.filter((c) => checklist.includes(c.block)).map((c) => ({ ...c })) : [];
  return {
    schemaVersion: "1.0.0",
    id: spec.id,
    name: spec.name,
    type: spec.type,
    status: "active",
    cutoffDate: spec.cutoffDate,
    owner: src.owner,
    createdAt: spec.now,
    updatedAt: spec.now,
    revision: 0,
    blocks,
    blockHashes: blockHashes(blocks),
    signedHash: "",
    manifestHash: "",
    lineage: {
      mode: spec.supersede ? "supersede" : spec.mode,
      fromWorkspaceId: src.id,
      fromSignedHash: src.signedHash,
      carried: [...checklist],
      supersededBy: null,
      pendingSupersede: spec.supersede,
    },
    clashes,
    lock: null,
    note: "",
  };
}

/**
 * The supersede clone's three steps, the caller holding both locks:
 *   (1) the clone, complete and valid, with `pendingSupersede: true`;
 *   (2) the source marked `superseded` with `supersededBy`, its lock and approval untouched;
 *   (3) the clone's flag cleared.
 * A throw at any step leaves a state boot reconcile completes forward (step 2 and 3 are idempotent
 * from what each leaves), and a throw at step 1 leaves the source untouched.
 */
export function supersedeClone(wsStore: WorkspaceStore, src: WorkspaceManifest, cloneManifest: WorkspaceManifest, by: string): WorkspaceManifest {
  const pending: WorkspaceManifest = { ...cloneManifest, lineage: { ...cloneManifest.lineage, pendingSupersede: true } };
  const created = wsStore.create(pending, by);
  wsStore.commit(
    src.id,
    src.revision,
    by,
    { kind: "supersede", by: created.id },
    { ...src, status: "superseded", lineage: { ...src.lineage, supersededBy: created.id } },
  );
  // The clone's own line for step 3 is a no-field meta line: nothing about its name or note moved.
  return wsStore.commit(created.id, created.revision, by, { kind: "meta" }, { ...created, lineage: { ...created.lineage, pendingSupersede: false } });
}

/** Write one clone head: a plain create, or the three supersede steps. Returns the clone's head. */
export function writeClone(wsStore: WorkspaceStore, src: WorkspaceManifest, cloneManifest: WorkspaceManifest, by: string): WorkspaceManifest {
  return cloneManifest.lineage.pendingSupersede ? supersedeClone(wsStore, src, cloneManifest, by) : wsStore.create(cloneManifest, by);
}
