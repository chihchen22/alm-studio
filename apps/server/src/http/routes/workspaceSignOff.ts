/**
 * Workspace sign-off (Studio A+E spec v3.1 Section 2.4):
 *
 *   POST /api/workspaces/:id/sign-off   { expectedRevision, by, note?, signedHash }
 *
 * Inside the workspace lock the server recomputes the head's signedHash from its blocks; a
 * mismatch is a 409 naming both hashes (the approvals route's own rule). On a match the order is:
 * (1) write the approval record with artifactCollection "workspaces" and artifactContentHash the
 * signedHash, through the approvals route's own writer so the stamp rule is shared; (2) for a
 * Production workspace only, commit `{ kind: "lock", approvalId }` with `lock` set and status
 * `locked`. Test, FTP, Stress and Monthly keep the record and stay active and editable; their head
 * does not move. A crash between (1) and (2) is completed at boot by `reconcileAll`. A thrown lock
 * commit in a live process marks the workspace lock-pending (review B m2): every write but rename,
 * note and the lock is refused 409 until a retried sign-off locks on the same record or boot does.
 *
 * The lock and the status enter no block hash, so the signedHash after the lock is the one the
 * record binds to and the approval reads `approved` on the next request. There is no unlock: no
 * route clears `lock`, and a workspace revoke is refused by the approvals route. A locked,
 * archived or superseded workspace refuses a sign-off with the refusal `assertWritable` names.
 */
import type { PlatformContext } from "../../context";
import { parseApprovalBody } from "../../approvals/approvals";
import { blockHashes, signedHashOf } from "../../workspaces/hashes";
import { assertWritable, requireBy, requireExpectedRevision } from "../../workspaces/rules";
import { RevisionConflict } from "../../workspaces/workspaceStore";
import { HttpError, conflict, unprocessable } from "../errors";
import type { Router } from "../router";
import { writeApprovalRecord } from "./approvals";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function registerWorkspaceSignOffRoute(router: Router, ctx: PlatformContext): void {
  const { store, workspaces: wsStore } = ctx;

  router.add("POST", "/api/workspaces/:id/sign-off", (req) => {
    const id = req.params.id ?? "";
    const raw = req.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
    const body = raw as Record<string, unknown>;
    const by = requireBy(body);
    const expectedRevision = requireExpectedRevision(body);
    const signedHash = body.signedHash;
    if (typeof signedHash !== "string" || !HASH_PATTERN.test(signedHash)) {
      throw unprocessable(`"signedHash" is required: the 64 lowercase hex signedHash of the head you reviewed`, { field: "signedHash" });
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      throw unprocessable(`"note" must be a string of 0 to 500 characters`, { field: "note" });
    }

    return wsStore.withLock([id], () => {
      const head = wsStore.head(id);
      assertWritable(head);
      if (head.revision !== expectedRevision) throw new RevisionConflict(id, expectedRevision, head.revision);
      // Recomputed from the blocks, never trusted from the stored field.
      const current = signedHashOf({ ...head, blockHashes: blockHashes(head.blocks) });
      if (signedHash !== current) {
        throw conflict(
          `workspace "${id}" has signedHash ${current}, not the submitted ${signedHash}: it changed since it was ` +
            `reviewed; read GET /api/workspaces/${id} and review again`,
        );
      }
      // The approvals body gate validates by and note exactly as a direct record would be.
      const fields = parseApprovalBody({
        artifactCollection: "workspaces",
        artifactId: id,
        artifactContentHash: current,
        decision: "approved",
        by,
        note: typeof body.note === "string" ? body.note : "",
      });
      // A retry after a failed lock commit locks on the record already written (review B m2).
      const pending = wsStore.pendingLock(id);
      const record =
        pending !== null && pending.signedHash === current
          ? { id: pending.approvalId, at: pending.at, by: pending.by }
          : writeApprovalRecord(store, fields);
      if (head.type !== "production") return { kind: "json", value: head } as const;
      let next;
      try {
        next = wsStore.commit(id, head.revision, record.by, { kind: "lock", approvalId: record.id }, {
          ...head,
          status: "locked",
          lock: { lockedAt: record.at, by: record.by, approvalId: record.id, signedHash: current },
        });
      } catch (err) {
        // The record is on disk and the head is not locked: refuse every block write, import and archive
        // until a retry or the next boot completes the lock, so signedHash cannot move in the window.
        wsStore.markLockPending(id, { approvalId: record.id, at: record.at, by: record.by, signedHash: current });
        throw new HttpError(
          500,
          "internal",
          `workspace "${id}": approval ${record.id} is recorded but the lock did not commit (${err instanceof Error ? err.message : String(err)}); ` +
            `writes are refused until the lock completes: retry the sign-off, or restart the server, which completes the lock at boot`,
          { approvalId: record.id },
        );
      }
      return { kind: "json", value: next } as const;
    });
  });
}
