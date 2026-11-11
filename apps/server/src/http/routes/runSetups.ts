/**
 * Run setup routes (Studio A+E spec v3.1 Sections 2.8 and 5.2, contract 16):
 *
 *   GET  /api/run-setups?workspaceId=   { setups: the slots joined to their current documents, missing: slots whose document is gone }
 *   GET  /api/run-setups/:docId         one immutable setup document
 *   POST /api/run-setups                append-only: write the document, move or add the slot
 *
 * A setup is immutable. Editing writes a new document whose id is
 * `rs-<16 hex of contentHash(document with id removed)>` (Section 2.10), so identical content
 * is the same document, and moves the slot's `current` with one `set-block` history line on
 * the `run` block. The POST body is `{ workspaceId, setupLineageId, expectedRevision, by,
 * setup }`; `setup` is the document without an id (an `id` in it is ignored).
 *
 * Order of refusals: workspace 404, body shape 422 (so a malformed document never costs a
 * revision read), then under the workspace lock the writable status 409 and the revision 409.
 * The document is written only after those pass, so a refused request leaves no orphan.
 */
import type { PlatformContext } from "../../context";
import { AlreadyExistsError, NotFoundError } from "../../store/store";
import { runSetupIdOf } from "../../workspaces/standardAlco";
import { parseRunSetup } from "../../workspaces/runSetupParse";
import { assertWritable, LINEAGE_PATTERN, requireBy, requireExpectedRevision } from "../../workspaces/rules";
import type { DocRef, RunSetup, SetupSlot, WorkspaceManifest } from "../../workspaces/types";
import { RevisionConflict } from "../../workspaces/workspaceStore";
import { unprocessable } from "../errors";
import type { Router } from "../router";

type Body = Record<string, unknown>;

function bodyOf(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
  return raw as Body;
}

export function registerRunSetupRoutes(router: Router, ctx: PlatformContext): void {
  const { store, workspaces: wsStore } = ctx;

  router.add("GET", "/api/run-setups", (req) => {
    const workspaceId = req.query.get("workspaceId");
    if (workspaceId === null || workspaceId.length === 0) {
      throw unprocessable(`"workspaceId" is required: the workspace whose setups to list`, { field: "workspaceId" });
    }
    const head = wsStore.head(workspaceId); // 404 for an unknown workspace
    // One slot whose document is gone never takes the list down (review C m6): it is skipped and
    // named in `missing`, as readiness names the same slot as an Error item.
    const setups: Array<{ slot: SetupSlot; setup: RunSetup }> = [];
    const missing: Array<{ setupLineageId: string; docId: string; problem: string }> = [];
    for (const slot of head.blocks.run.setups) {
      try {
        setups.push({ slot, setup: store.getDocument<RunSetup>("run-setups", slot.current.id).doc });
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        missing.push({ setupLineageId: slot.setupLineageId, docId: slot.current.id, problem: `the slot's setup document "${slot.current.id}" is not in the store` });
      }
    }
    return { kind: "json", value: { setups, missing } };
  });

  router.add("GET", "/api/run-setups/:docId", (req) => ({
    kind: "json",
    value: store.getDocument<RunSetup>("run-setups", req.params.docId ?? "").doc,
  }));

  router.add("POST", "/api/run-setups", (req) => {
    const body = bodyOf(req.json());
    const workspaceId = body.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw unprocessable(`"workspaceId" is required: the workspace this setup belongs to`, { field: "workspaceId" });
    }
    wsStore.head(workspaceId); // 404 before the body is judged
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);
    const lineageId = body.setupLineageId;
    if (typeof lineageId !== "string" || !LINEAGE_PATTERN.test(lineageId)) {
      throw unprocessable(`"setupLineageId" is required: 1 to 70 characters from A-Z a-z 0-9 . _ -`, { field: "setupLineageId" });
    }
    const parsed = parseRunSetup(body.setup);
    if (parsed.supersedes !== null && !store.has("run-setups", parsed.supersedes)) {
      throw unprocessable(`supersedes: run setup "${parsed.supersedes}" is not in the store`, { field: "supersedes" });
    }
    const doc: RunSetup = { id: runSetupIdOf(parsed), ...parsed };

    return wsStore.withLock([workspaceId], () => {
      const head = wsStore.head(workspaceId);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(workspaceId, expectedRevision, head.revision);

      // Append-only: identical content is the same document, so an existing id is reused as it stands.
      let meta;
      if (store.has("run-setups", doc.id)) {
        meta = store.getMeta("run-setups", doc.id);
      } else {
        try {
          meta = store.putDocument("run-setups", doc.id, doc, { label: doc.name, workspaceId });
        } catch (err) {
          if (!(err instanceof AlreadyExistsError)) throw err;
          meta = store.getMeta("run-setups", doc.id); // another request wrote the same bytes first
        }
      }

      const existing = head.blocks.run.setups.find((s) => s.setupLineageId === lineageId);
      if (existing !== undefined && existing.current.id === doc.id) {
        // Saving what the slot already holds changes nothing: no revision, no history line.
        return { kind: "json", status: 200, value: { setup: doc, manifest: head } } as const;
      }
      const ref: DocRef = { collection: "run-setups", id: doc.id, contentHash: meta.contentHash, pinnedAt: new Date().toISOString() };
      const slot: SetupSlot = { setupLineageId: lineageId, current: ref };
      const setups = existing === undefined ? [...head.blocks.run.setups, slot] : head.blocks.run.setups.map((s) => (s === existing ? slot : s));
      const next: WorkspaceManifest = { ...head, blocks: { ...head.blocks, run: { ...head.blocks.run, setups } } };
      const manifest = wsStore.commit(
        workspaceId,
        expectedRevision,
        by,
        { kind: "set-block", block: "run", op: existing === undefined ? "add" : "set", ref: { collection: "run-setups", id: doc.id } },
        next,
      );
      return { kind: "json", status: 201, value: { setup: doc, manifest } } as const;
    });
  });
}
