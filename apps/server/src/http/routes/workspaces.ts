/**
 * Workspace lifecycle routes (Studio A+E spec v3.1 Sections 2.4 and 2.8), the
 * subset the lifecycle task owns:
 *
 *   GET  /api/workspaces              heads, newest cut-off first
 *   POST /api/workspaces              create blank, plus the Standard ALCO setup and the seeded routing policy
 *   GET  /api/workspaces/:id          the head, after reconcile
 *   GET  /api/workspaces/:id/history  history lines, oldest first
 *   GET  /api/workspaces/:id/runs     runs attached to the workspace, newest first, joined to status.json and
 *                                     the basis label read off the run's own request.json
 *   POST /api/workspaces/:id/blocks   set, add, remove, set-default (expectedRevision, by)
 *   POST /api/workspaces/:id/meta     rename and note (expectedRevision, by)
 *   POST /api/workspaces/:id/archive  status becomes archived (expectedRevision, by, note?)
 *
 * Every mutating body carries `by` (typed, never verified) and `expectedRevision`;
 * a head whose revision differs is a 409 with both numbers. Every write runs
 * inside the workspace's in-process lock. Compare, clone, re-apply, sign-off,
 * readiness and the setup routes register elsewhere; `GET /api/workspaces/compare`
 * must be registered BEFORE this file's `:id` route, because both are three segments.
 */
import type { PlatformContext } from "../../context";
import type { RunStatus, StoredRunRequest } from "../../jobs/types";
import { basisLabelOfRun } from "../../workspaces/setupCompile";
import { assertValidId, COLLECTIONS, InvalidIdError, type Collection } from "../../store/paths";
import { sha256Hex } from "../../store/store";
import { BLOCK_NAMES, blockHashes, slugOf } from "../../workspaces/hashes";
import {
  BLOCK_OPS,
  NAME_MAX,
  NOTE_MAX,
  WORKSPACE_TYPES,
  assertBlockMember,
  assertMetaWritable,
  assertWritable,
  productionUnique,
  requireBy,
  requireExpectedRevision,
  requireIsoDate,
  writeBlockOp,
  type BlockOp,
  type ResolvedDoc,
} from "../../workspaces/rules";
import { emptyBlocks } from "../../workspaces/clone";
import { preferSeeded } from "../../workspaces/seeded";
import { standardAlcoSetup } from "../../workspaces/standardAlco";
import type { BlockName, HistoryChange, RunAttachment, WorkspaceManifest, WorkspaceType } from "../../workspaces/types";
import { RevisionConflict } from "../../workspaces/workspaceStore";
import { conflict, unprocessable } from "../errors";
import type { Router } from "../router";
import { registerWorkspaceCompareRoute } from "./workspaceCompare";
import { registerWorkspaceLaunchRoutes } from "./workspaceLaunch";
import { registerWorkspaceSignOffRoute } from "./workspaceSignOff";

type Body = Record<string, unknown>;

function bodyOf(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
  return raw as Body;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw unprocessable(`"${field}" is required: a string of 1 to ${max} characters`, { field });
  }
  return value;
}

function optionalNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > NOTE_MAX) {
    throw unprocessable(`"note" must be a string of 0 to ${NOTE_MAX} characters`, { field: "note" });
  }
  return value;
}

/** Newest cut-off first, then id, so the order is stable. */
function byCutoffDesc(a: WorkspaceManifest, b: WorkspaceManifest): number {
  if (a.cutoffDate !== b.cutoffDate) return a.cutoffDate < b.cutoffDate ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function registerWorkspaceRoutes(router: Router, ctx: PlatformContext): void {
  const { store, workspaces: wsStore } = ctx;

  // Compare shares three segments with `:id`: it must register first.
  registerWorkspaceCompareRoute(router, ctx);

  router.add("GET", "/api/workspaces", () => ({ kind: "json", value: wsStore.list().sort(byCutoffDesc) }));

  router.add("POST", "/api/workspaces", (req) => {
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const name = requireText(body.name, "name", NAME_MAX);
    const type = body.type;
    if (typeof type !== "string" || !WORKSPACE_TYPES.includes(type as WorkspaceType)) {
      throw unprocessable(`"type" must be one of ${WORKSPACE_TYPES.join(", ")}`, { field: "type" });
    }
    const cutoffDate = requireIsoDate(body.cutoffDate, "cutoffDate");
    const owner = requireText(body.owner, "owner", NAME_MAX);
    const note = optionalNote(body.note) ?? "";
    let id: string;
    if (body.id !== undefined) {
      if (typeof body.id !== "string") throw unprocessable(`"id" must be a string`, { field: "id" });
      id = assertValidId(body.id);
    } else {
      try {
        id = slugOf(name);
      } catch (err) {
        if (err instanceof InvalidIdError) throw unprocessable("name yields no id; type one", { field: "name" });
        throw err;
      }
    }
    const wsType = type as WorkspaceType;

    return wsStore.withLock([id], () => {
      if (wsStore.has(id)) throw conflict(`workspace "${id}" already exists; choose another id`);
      const clash = productionUnique(wsStore.list(), wsType, cutoffDate, null);
      if (clash) {
        throw conflict(
          `workspace "${clash.id}" is already the Production workspace for cut-off ${cutoffDate}; a correction is a ` +
            `supersede clone of it, not a second Production workspace`,
        );
      }

      // The Standard ALCO document first: an append-only write that leaves a harmless orphan if the
      // manifest write fails. Identical bytes are one document, so an existing id is reused.
      const setup = standardAlcoSetup(id);
      const setupMeta = store.has("run-setups", setup.id)
        ? store.getMeta("run-setups", setup.id)
        : store.putDocument("run-setups", setup.id, setup, { label: setup.name, workspaceId: id });
      const now = new Date().toISOString();
      const blocks = emptyBlocks();
      blocks.run.setups = [
        {
          setupLineageId: `setup-${sha256Hex(JSON.stringify([id, now])).slice(0, 8)}`,
          current: { collection: "run-setups", id: setup.id, contentHash: setupMeta.contentHash, pinnedAt: now },
        },
      ];
      // A blank workspace carries the routing policy the seed ships, so a first validate does not stop on a
      // missing role; the Assumptions page swaps it. A store with no policy leaves the field null as before.
      const policy = preferSeeded(store.listMeta("routing-policies"));
      if (policy !== undefined) {
        blocks.assumptions.routingPolicy = { collection: "routing-policies", id: policy.id, contentHash: policy.contentHash, pinnedAt: now };
      }
      const manifest: WorkspaceManifest = {
        schemaVersion: "1.0.0",
        id,
        name,
        type: wsType,
        status: "active",
        cutoffDate,
        owner,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        blocks,
        blockHashes: blockHashes(blocks),
        signedHash: "",
        manifestHash: "",
        lineage: { mode: "blank", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false },
        clashes: [],
        lock: null,
        note,
      };
      return { kind: "json", status: 201, value: wsStore.create(manifest, by) } as const;
    });
  });

  router.add("GET", "/api/workspaces/:id", (req) => ({ kind: "json", value: wsStore.head(req.params.id ?? "") }));

  router.add("GET", "/api/workspaces/:id/history", (req) => ({ kind: "json", value: wsStore.history(req.params.id ?? "") }));

  router.add("GET", "/api/workspaces/:id/runs", (req) => {
    const id = req.params.id ?? "";
    wsStore.head(id); // 404 for an unknown workspace
    const seen = new Set<string>();
    const rows: Array<RunAttachment & { status: RunStatus | null; basisLabel: string | null }> = [];
    for (const a of wsStore.readRunAttachments(id)) {
      if (seen.has(a.runId)) continue;
      seen.add(a.runId);
      const status = store.runFileExists(a.runId, "status.json") ? store.readRunJson<RunStatus>(a.runId, "status.json") : null;
      let basisLabel: string | null = null;
      if (store.runFileExists(a.runId, "request.json")) {
        const stored = store.readRunJson<StoredRunRequest>(a.runId, "request.json");
        basisLabel = basisLabelOfRun(stored.planDocument, stored.request.scenarios);
      }
      rows.push({ ...a, status, basisLabel });
    }
    const stamp = (r: RunAttachment & { status: RunStatus | null }): string => r.status?.submittedAt ?? r.at;
    rows.sort((x, y) => (stamp(x) !== stamp(y) ? (stamp(x) < stamp(y) ? 1 : -1) : x.runId < y.runId ? 1 : x.runId > y.runId ? -1 : 0));
    return { kind: "json", value: rows };
  });

  router.add("POST", "/api/workspaces/:id/blocks", (req) => {
    const id = req.params.id ?? "";
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);
    const block = body.block;
    if (typeof block !== "string" || !(BLOCK_NAMES as readonly string[]).includes(block)) {
      throw unprocessable(`"block" must be one of ${BLOCK_NAMES.join(", ")}`, { field: "block" });
    }
    const op = body.op;
    if (typeof op !== "string" || !(BLOCK_OPS as readonly string[]).includes(op)) {
      throw unprocessable(`"op" must be one of ${BLOCK_OPS.join(", ")}`, { field: "op" });
    }
    const ref = body.ref;
    if (typeof ref !== "object" || ref === null) throw unprocessable(`"ref" is required: { collection, id }`, { field: "ref" });
    const { collection, id: docId } = ref as { collection?: unknown; id?: unknown };
    if (typeof collection !== "string" || !(COLLECTIONS as readonly string[]).includes(collection)) {
      throw unprocessable(`"ref.collection" must be one of ${COLLECTIONS.join(", ")}`, { field: "ref.collection" });
    }
    if (typeof docId !== "string") throw unprocessable(`"ref.id" is required: a document id`, { field: "ref.id" });
    assertValidId(docId);
    assertBlockMember(block as BlockName, collection as Collection);

    return wsStore.withLock([id], () => {
      const head = wsStore.head(id);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(id, expectedRevision, head.revision);
      const doc = op === "remove" || op === "set-default" ? null : resolveDoc(ctx, collection as Collection, docId);
      const next = writeBlockOp(wsStore, id, expectedRevision, by, block as BlockName, op as BlockOp, collection as Collection, docId, doc);
      return { kind: "json", status: 201, value: next } as const;
    });
  });

  router.add("POST", "/api/workspaces/:id/meta", (req) => {
    const id = req.params.id ?? "";
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);
    const name = body.name === undefined ? undefined : requireText(body.name, "name", NAME_MAX);
    const note = optionalNote(body.note);

    return wsStore.withLock([id], () => {
      const head = wsStore.head(id);
      // Immutable fields are refused whatever the status: a cut-off date is set at creation and never moves.
      for (const field of ["cutoffDate", "type", "id"] as const) {
        if (body[field] !== undefined && body[field] !== head[field]) {
          throw unprocessable(`"${field}" is immutable: it is set at creation and the server refuses any later change`, { field });
        }
      }
      if (name === undefined && note === undefined) {
        throw unprocessable(`send "name", "note" or both; the cutoffDate, type and id never change`, { field: "name" });
      }
      assertMetaWritable(head);
      const change: HistoryChange = { kind: "meta", ...(name !== undefined ? { name } : {}), ...(note !== undefined ? { note } : {}) };
      const next = wsStore.commit(id, expectedRevision, by, change, {
        ...head,
        ...(name !== undefined ? { name } : {}),
        ...(note !== undefined ? { note } : {}),
      });
      return { kind: "json", value: next } as const;
    });
  });

  router.add("POST", "/api/workspaces/:id/archive", (req) => {
    const id = req.params.id ?? "";
    const body = bodyOf(req.json());
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);
    const note = optionalNote(body.note);

    return wsStore.withLock([id], () => {
      const head = wsStore.head(id);
      if (head.status === "archived") throw conflict(`workspace "${id}" is already archived`);
      // Ruling: a locked Production month may be archived. The status moves,
      // the lock stays on the manifest and signedHash does not move (status enters no hash); an archived
      // workspace refuses every write. A superseded one stays superseded. No unarchive in Slice 1.
      if (head.status !== "locked") assertWritable(head);
      const next = wsStore.commit(
        id,
        expectedRevision,
        by,
        { kind: "status", from: head.status, to: "archived" },
        { ...head, status: "archived", ...(note !== undefined ? { note } : {}) },
      );
      return { kind: "json", value: next } as const;
    });
  });

  // POST /api/workspaces/:id/sign-off: the logic lives in workspaceSignOff.ts.
  registerWorkspaceSignOffRoute(router, ctx);

  // POST /api/workspaces/:id/setups/:lineageId/{validate,launch}: the logic lives in workspaceLaunch.ts.
  registerWorkspaceLaunchRoutes(router, ctx);
}

/**
 * Read what the rules need about a document from the FILE STORE (never the
 * mirror): a book's as-of and retagged marker from its meta, a market's calibration date and
 * base from the snapshot document, a launch slate's marker from its meta. An unknown document
 * is a 422 naming it.
 */
export function resolveDoc(ctx: PlatformContext, collection: Collection, id: string): ResolvedDoc {
  const { store } = ctx;
  if (!store.has(collection, id)) throw unprocessable(`${collection} document "${id}" is not in the store`, { field: "ref.id" });
  const meta = store.getMeta(collection, id);
  const out: ResolvedDoc = { collection, id, contentHash: meta.contentHash };
  if (collection === "portfolios") {
    if (typeof meta.asOf === "string") out.asOf = meta.asOf;
    if (typeof meta.sourceBookId === "string") out.sourceBookId = meta.sourceBookId;
  } else if (collection === "market") {
    const doc = store.getDocument<{ calibrationDate?: unknown; derivedFrom?: { baseId?: unknown } }>("market", id).doc;
    if (typeof doc.calibrationDate === "string") out.asOf = doc.calibrationDate;
    if (doc.derivedFrom && typeof doc.derivedFrom.baseId === "string") out.derivedFromId = doc.derivedFrom.baseId;
  } else if (collection === "scenario-slates") {
    if (typeof meta.fromPlan === "string") out.fromPlan = meta.fromPlan;
  }
  return out;
}
