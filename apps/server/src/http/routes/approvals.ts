/**
 * Approval records (Controls 2, approvals): append-only sign-off records over
 * runs, run plans, assumption sets and workspaces. For runs, run plans and
 * assumption sets nothing here gates a run; for workspaces the record is the
 * gate. Nothing here touches a lens or a score, or is read by the
 * compiler.
 *
 * A workspace record binds to the manifest's signedHash and is written only by
 * POST /api/workspaces/:id/sign-off (through writeApprovalRecord below): a direct
 * POST here for a workspace is refused 422, and a revoke of one is refused 409,
 * because a signed Production workspace is corrected by a supersede clone and
 * never unlocked.
 *
 *   GET  /api/approvals                           every record, ascending id (chronological; stamps strictly increase)
 *   GET  /api/approvals/status/:collection/:id    { currentContentHash, state, latest, records }
 *   GET  /api/approvals/:id                       one stored record, verbatim
 *   POST /api/approvals                           the body below -> 201 with the stored record
 *
 * POST body: { artifactCollection, artifactId, artifactContentHash, decision, by, note? }.
 * The server assigns `id` and `at` and refuses a body that carries either. The
 * client sends the content hash it reviewed; the server recomputes the current
 * hash from the stored bytes and answers 409 on a mismatch, so a record always
 * binds to bytes the server can prove. That hash is the store file hash for a
 * run plan or an assumption set (the same hash run_inputs pins; NOT the engine's
 * bindingsContentHash that the assumption-set listing calls contentHash), and the
 * sha256 over result.json for a finished run.
 *
 * A revocation is a new record and needs a live approval at the same hash. There
 * is no PUT and no DELETE: the store refuses an overwrite, and no route removes.
 * The `by` field is typed by whoever records and is never verified.
 */
import { randomBytes } from "node:crypto";
import type { PlatformContext } from "../../context";
import type { RunStatus } from "../../jobs/types";
import {
  approvalId,
  approvalState,
  assertApprovalTarget,
  nextApprovalStampMs,
  parseApprovalBody,
  type ApprovalRecord,
  type ApprovalTarget,
} from "../../approvals/approvals";
import { assertValidId } from "../../store/paths";
import { sha256Hex, type FileStore } from "../../store/store";
import { conflict, unprocessable } from "../errors";
import type { Router } from "../router";

/** The one sentence both workspace refusals carry. */
const WORKSPACE_CORRECTION = "a signed Production workspace is corrected by a supersede clone, never revoked";

/**
 * The current content hash of an artifact, from its stored bytes. A workspace has no stored
 * document: its hash is the head's signedHash, read after reconcile.
 */
function currentHash(ctx: PlatformContext, collection: ApprovalTarget, id: string): string {
  const { store } = ctx;
  if (collection === "workspaces") return ctx.workspaces.head(id).signedHash;
  if (collection === "runs") {
    // readRunJson raises the 404 for an unknown run.
    const status = store.readRunJson<RunStatus>(id, "status.json");
    if (status.state !== "done") {
      throw conflict(`run "${id}" is ${status.state}; only a finished run's result can be signed off`);
    }
    if (!store.runFileExists(id, "result.json")) {
      throw conflict(`run "${id}" is done but its result.json is missing; there is no result to sign off`);
    }
    return sha256Hex(store.readRunBytes(id, "result.json"));
  }
  return sha256Hex(store.getDocumentBytes(collection, id));
}

function allRecords(store: FileStore): ApprovalRecord[] {
  return store.listMeta("approvals").map((meta) => store.getDocument<ApprovalRecord>("approvals", meta.id).doc);
}

function recordsFor(store: FileStore, collection: ApprovalTarget, id: string): ApprovalRecord[] {
  return allRecords(store).filter((r) => r.artifactCollection === collection && r.artifactId === id);
}

/**
 * Stamp and store one record: `at` strictly after every stored stamp (so a same-millisecond
 * revoke still sorts last), the id from that stamp, the fields in the stored order. Shared by
 * POST /api/approvals and the workspace sign-off route, so both follow one stamp rule. The
 * caller has already validated the fields and checked the hash.
 */
export function writeApprovalRecord(
  store: FileStore,
  fields: Pick<ApprovalRecord, "artifactCollection" | "artifactId" | "artifactContentHash" | "decision" | "by" | "note">,
): ApprovalRecord {
  const at = new Date(nextApprovalStampMs(Date.now(), allRecords(store))).toISOString();
  const id = approvalId(at, randomBytes(3).toString("hex"));
  // Field order is the stored order; the bytes are reproducible.
  const record: ApprovalRecord = {
    id,
    artifactCollection: fields.artifactCollection,
    artifactId: fields.artifactId,
    artifactContentHash: fields.artifactContentHash,
    decision: fields.decision,
    by: fields.by,
    at,
    note: fields.note,
  };
  store.putDocument("approvals", id, record, {
    artifactCollection: record.artifactCollection,
    artifactId: record.artifactId,
    decision: record.decision,
  });
  return record;
}

export function registerApprovalRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("GET", "/api/approvals", () => ({ kind: "json", value: allRecords(store) }));

  // Registered before :id; a different segment count keeps the two apart anyway.
  router.add("GET", "/api/approvals/status/:collection/:id", (req) => {
    const collection = assertApprovalTarget(req.params.collection);
    const id = assertValidId(req.params.id ?? "");
    const hash = currentHash(ctx, collection, id);
    const records = recordsFor(store, collection, id);
    const { state, latest } = approvalState(records, hash);
    return {
      kind: "json",
      value: {
        artifactCollection: collection,
        artifactId: id,
        currentContentHash: hash,
        state,
        latest,
        records,
      },
    };
  });

  router.add("GET", "/api/approvals/:id", (req) => ({
    kind: "json",
    value: store.getDocument<ApprovalRecord>("approvals", assertValidId(req.params.id ?? "")).doc,
  }));

  router.add("POST", "/api/approvals", (req) => {
    const parsed = parseApprovalBody(req.json());
    if (parsed.artifactCollection === "workspaces") {
      if (parsed.decision === "revoked") {
        throw conflict(`a workspace approval cannot be revoked: there is no unlock; ${WORKSPACE_CORRECTION}`);
      }
      throw unprocessable(
        `workspace approvals are written by POST /api/workspaces/:id/sign-off; ${WORKSPACE_CORRECTION}`,
        { field: "artifactCollection" },
      );
    }
    const current = currentHash(ctx, parsed.artifactCollection, parsed.artifactId);
    if (parsed.artifactContentHash !== current) {
      throw conflict(
        `the ${parsed.artifactCollection} artifact "${parsed.artifactId}" has content hash ${current}, not the ` +
          `submitted ${parsed.artifactContentHash}: it changed since it was reviewed, or the hash is not its ` +
          `stored-file hash; read GET /api/approvals/status/${parsed.artifactCollection}/${parsed.artifactId} and review again`,
      );
    }
    if (parsed.decision === "revoked") {
      const { state } = approvalState(recordsFor(store, parsed.artifactCollection, parsed.artifactId), current);
      if (state !== "approved") {
        throw conflict(
          `nothing to revoke at this content hash: "${parsed.artifactId}" is ${state} at ${current}`,
        );
      }
    }
    return { kind: "json", status: 201, value: writeApprovalRecord(store, parsed) };
  });
}
