/**
 * Approval records: the pure rules (Controls 2, approvals).
 *
 * A record says that a named person approved or revoked an artifact at one
 * content hash. Records are append-only: a revocation is a new record, and the
 * state of an artifact is decided by the newest record at its CURRENT content
 * hash. Nothing here touches the store, the runs or the scoring; the route in
 * http/routes/approvals.ts does the IO and calls these functions.
 *
 * `by` is typed by whoever records and is never verified: the platform has no
 * sign-in. The server assigns `id` and `at`; a client that sends either is
 * refused, because a client stamp would be unverifiable.
 */
import { assertValidId } from "../store/paths";
import { badRequest, unprocessable } from "../http/errors";

/**
 * The collections whose artifacts can be approved. Lenses are excluded on purpose. A workspace
 * approval binds to the manifest's signedHash and is written only by the sign-off route.
 */
export const APPROVAL_TARGETS = ["runs", "run-plans", "assumption-sets", "workspaces"] as const;
export type ApprovalTarget = (typeof APPROVAL_TARGETS)[number];

export type ApprovalDecision = "approved" | "revoked";
const DECISIONS: readonly ApprovalDecision[] = ["approved", "revoked"];

/**
 * The stored record. Keys are stored in exactly this order, so the bytes (and
 * the file hash) are reproducible.
 */
export interface ApprovalRecord {
  id: string;
  artifactCollection: ApprovalTarget;
  artifactId: string;
  /** 64 lowercase hex: the store file hash, or the result.json hash for a run. */
  artifactContentHash: string;
  decision: ApprovalDecision;
  /** Typed by the recorder, trimmed, 1 to 80 characters; never verified. */
  by: string;
  /** ISO 8601 UTC with milliseconds, stamped by the server. */
  at: string;
  /** Trimmed, 0 to 500 characters; "" when none. */
  note: string;
}

export type ApprovalState = "approved" | "revoked" | "changed" | "none";

/** What a client may send. */
export interface ApprovalBody {
  artifactCollection: ApprovalTarget;
  artifactId: string;
  artifactContentHash: string;
  decision: ApprovalDecision;
  by: string;
  note: string;
}

const BODY_KEYS = new Set(["artifactCollection", "artifactId", "artifactContentHash", "decision", "by", "note"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
// The note may span lines: newline (0x0a) and tab (0x09) are allowed, every other control is not.
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const BY_MAX = 80;
const NOTE_MAX = 500;

/** True when the value names one of the approvable collections. */
export function isApprovalTarget(value: unknown): value is ApprovalTarget {
  return typeof value === "string" && (APPROVAL_TARGETS as readonly string[]).includes(value);
}

/** Validate a target collection name or throw 422 naming every one. */
export function assertApprovalTarget(value: unknown): ApprovalTarget {
  if (!isApprovalTarget(value)) {
    throw unprocessable(
      `artifactCollection must be one of ${APPROVAL_TARGETS.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string") throw badRequest(`${key} must be a string`);
  return v;
}

/**
 * The body gate for POST /api/approvals. 400 for a body that is not an object,
 * an unknown key (id and at included) or a wrong type; 422 for a value outside
 * its enum, pattern or length.
 */
export function parseApprovalBody(body: unknown): ApprovalBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("the request body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!BODY_KEYS.has(key)) {
      throw badRequest(
        key === "id" || key === "at"
          ? `${key} is not accepted: the server assigns id and at`
          : `unknown key ${JSON.stringify(key)}; the server assigns id and at, and a record carries only ` +
              `${[...BODY_KEYS].join(", ")}`,
      );
    }
  }
  const collection = requireString(obj, "artifactCollection");
  const artifactId = requireString(obj, "artifactId");
  const hash = requireString(obj, "artifactContentHash");
  const decision = requireString(obj, "decision");
  const by = requireString(obj, "by");
  if (obj.note !== undefined && typeof obj.note !== "string") throw badRequest("note must be a string");
  const note = typeof obj.note === "string" ? obj.note.trim() : "";

  const target = assertApprovalTarget(collection);
  try {
    assertValidId(artifactId);
  } catch (err) {
    throw unprocessable(err instanceof Error ? err.message : String(err));
  }
  if (!HASH_PATTERN.test(hash)) {
    throw unprocessable("artifactContentHash must be 64 lowercase hex characters (a sha256)");
  }
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    throw unprocessable(`decision must be one of ${DECISIONS.join(", ")}; got ${JSON.stringify(decision)}`);
  }
  const who = by.trim();
  if (who.length === 0) throw unprocessable("by must not be empty");
  if (who.length > BY_MAX) throw unprocessable(`by must be at most ${BY_MAX} characters`);
  if (CONTROL_CHARS.test(who)) throw unprocessable("by must not contain control characters");
  if (note.length > NOTE_MAX) throw unprocessable(`note must be at most ${NOTE_MAX} characters`);
  if (NOTE_CONTROL_CHARS.test(note)) {
    throw unprocessable("note must not contain control characters (newline and tab are allowed)");
  }

  return {
    artifactCollection: target,
    artifactId,
    artifactContentHash: hash,
    decision: decision as ApprovalDecision,
    by: who,
    note,
  };
}

/** apr-<stamp without dashes, colons and dot>-<suffix>; sorts by time, passes ID_PATTERN. */
export function approvalId(at: string, suffixHex: string): string {
  return `apr-${at.replace(/[-:.]/g, "")}-${suffixHex}`;
}

/**
 * The next record stamp in epoch milliseconds: the clock, but never at or before
 * the newest stored stamp. Strictly increasing stamps make arrival order the
 * order the newest-wins rule reads, so the random id suffix never decides a
 * tie between an approval and the revocation that follows it.
 */
export function nextApprovalStampMs(nowMs: number, stored: readonly ApprovalRecord[]): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const r of stored) {
    const t = Date.parse(r.at);
    if (t > newest) newest = t;
  }
  return Math.max(nowMs, newest + 1);
}

/** Ascending (at, id): the order the newest-wins rule reads. */
function chronological(records: readonly ApprovalRecord[]): ApprovalRecord[] {
  return [...records].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The state of one artifact from ITS records. Among the records at the current
 * content hash the newest decides (approved or revoked; a revocation cancels
 * every approval before it). With none at the current hash but some at another,
 * the artifact changed after its last record. With none at all, none. `latest`
 * is the newest record at the current hash, or the newest overall when changed.
 */
export function approvalState(
  records: readonly ApprovalRecord[],
  currentHash: string,
): { state: ApprovalState; latest: ApprovalRecord | null } {
  const ordered = chronological(records);
  if (ordered.length === 0) return { state: "none", latest: null };
  const atCurrent = ordered.filter((r) => r.artifactContentHash === currentHash);
  if (atCurrent.length === 0) return { state: "changed", latest: ordered[ordered.length - 1] };
  const latest = atCurrent[atCurrent.length - 1];
  return { state: latest.decision, latest };
}
