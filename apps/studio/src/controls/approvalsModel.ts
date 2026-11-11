// apps/studio/src/controls/approvalsModel.ts
/**
 * The Approvals page's pure model (Controls 2, approvals): the table rows, the state sentence and the reasons the two
 * record buttons are off. Nothing is scored or derived here; a row prints a stored field. The name on a record is typed
 * by whoever recorded it and is not verified, so the model carries it as a plain string and never as an identity.
 */
import type { ApprovalDecision, ApprovalRecord, ApprovalStatus, ApprovalTarget } from "@alm/reader";

/** The three approvable artifacts, in words. */
export const TARGET_LABEL: Record<ApprovalTarget, string> = {
  runs: "Run result",
  "run-plans": "Run plan",
  "assumption-sets": "Assumption set",
};

export interface ApprovalRow {
  /** The server-assigned record id. */
  id: string;
  /** The server-stamped ISO 8601 UTC time. */
  at: string;
  /** The decision word with its icon, so the decision never rests on colour alone. */
  decisionText: string;
  statusClass: string;
  /** The target word and the artifact id. */
  artifactText: string;
  hash: string;
  by: string;
  note: string;
}

const DECISION_TEXT: Record<ApprovalDecision, string> = { approved: "✓ approved", revoked: "✕ revoked" };
const DECISION_CLASS: Record<ApprovalDecision, string> = { approved: "status status-pass", revoked: "status status-breach" };

/** Newest first. The route returns ascending id order, which is chronological; ties on `at` break by id. */
export function recordRows(records: ApprovalRecord[]): ApprovalRow[] {
  return [...records]
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1))
    .map((r) => ({
      id: r.id,
      at: r.at,
      decisionText: DECISION_TEXT[r.decision],
      statusClass: DECISION_CLASS[r.decision],
      // A workspace sign-off is a record on the "workspaces" collection, which the record form does not offer.
      artifactText: `${TARGET_LABEL[r.artifactCollection] ?? ((r.artifactCollection as string) === "workspaces" ? "Workspace" : r.artifactCollection)} ${r.artifactId}`,
      hash: r.artifactContentHash,
      by: r.by,
      note: r.note,
    }));
}

/** The artifact's state at its current content hash, in words, with the class that carries it. */
export function stateLine(status: ApprovalStatus): { cls: string; text: string } {
  switch (status.state) {
    case "approved": return { cls: "status status-pass", text: "Approved at this content hash" };
    case "revoked": return { cls: "status status-breach", text: "Revoked at this content hash" };
    case "changed": return { cls: "status status-unobs", text: "Records exist only for an earlier content hash; this content has none" };
    case "none": return { cls: "muted", text: "No record for this artifact" };
  }
}

export interface ApprovalForm {
  target: ApprovalTarget;
  artifactId: string;
  /** Typed, not verified. */
  by: string;
  note: string;
}

/** Why a record button is off, or null when it is on. */
export function recordBlock(form: ApprovalForm, status: ApprovalStatus | null, decision: ApprovalDecision): string | null {
  if (form.artifactId === "") return "Choose an artifact first";
  if (status === null) return "Reading the artifact status";
  if (form.by.trim() === "") return "Type a name in Recorded by";
  if (decision === "revoked" && status.state !== "approved") return "Nothing to revoke: this content hash is not approved";
  return null;
}
