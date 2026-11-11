// apps/studio/src/govern/workspaceGovern.ts
/**
 * Govern additions for a workspace (spec v3.1 Section 3.1): history, clone tree, supersede links and the
 * sign-off gate. Pure shaping of the head, the workspace list and the history lines; nothing is computed.
 */
import type { BlockName, HistoryChange, HistoryLine, WorkspaceManifest } from "@alm/reader";
import { curveSetupChangeText, derivedCurveChangeText, type CurveSetupLabels } from "../rows/workspaceRows";

const BLOCK_LABEL: Record<BlockName, string> = {
  market: "Market",
  positions: "Positions",
  targets: "Strategy and targets",
  assumptions: "Assumptions",
  scenarios: "Scenarios",
  run: "Run",
};

const short = (hash: string): string => hash.slice(0, 12);

/** One history change in words; `labels` names curve setups by label (the id when none is known); `by` is the line's typed name. */
export function changeText(c: HistoryChange, labels?: CurveSetupLabels, by?: string): string {
  switch (c.kind) {
    case "create": return "Created";
    case "set-block": return derivedCurveChangeText(c, by) ?? curveSetupChangeText(c, labels) ?? `${BLOCK_LABEL[c.block]}: ${c.op} ${c.ref.collection} ${c.ref.id}`;
    case "set-default": return `Default assumption set: ${c.setId}`;
    case "meta": {
      const parts: string[] = [];
      if (c.name !== undefined) parts.push(`Renamed to ${c.name}`);
      if (c.note !== undefined) parts.push("Note changed");
      return parts.length === 0 ? "Name and note unchanged" : parts.join(", ");
    }
    case "status": return `Status ${c.from} to ${c.to}`;
    case "lock": return `Locked on approval ${c.approvalId}`;
    case "supersede": return `Superseded by ${c.by}`;
    case "re-pin": return `Re-pinned ${BLOCK_LABEL[c.block]} ${c.id}: ${short(c.from)} to ${short(c.to)}`;
    case "reapply": return c.refusal !== null
      ? `Re-applied definition ${c.definitionKey}, refused: ${c.refusal}`
      : `Re-applied definition ${c.definitionKey}${c.appliedId !== null ? ` as ${c.appliedId}` : ""}`;
    case "clash": return `Cut-off clash recorded: ${c.block} ${c.id} is dated ${c.documentAsOf}`;
  }
}

export interface HistoryRow {
  revision: number;
  at: string;
  by: string;
  text: string;
  /** The signedHash the head held after this revision. */
  signedHash: string;
  /** The line was written by a boot reconcile, not by a request. */
  reconciled: boolean;
}

/** Newest revision first. */
export function historyRows(lines: HistoryLine[], labels?: CurveSetupLabels): HistoryRow[] {
  return [...lines]
    .sort((a, b) => b.revision - a.revision)
    .map((l) => ({ revision: l.revision, at: l.at, by: l.by, text: changeText(l.change, labels, l.by), signedHash: l.manifest.signedHash, reconciled: l.reconciled === true }));
}

export interface CloneNode {
  id: string;
  name: string;
  type: WorkspaceManifest["type"] | null;
  cutoffDate: string | null;
  status: WorkspaceManifest["status"] | null;
  mode: WorkspaceManifest["lineage"]["mode"] | null;
  /** The id is named by a lineage but no manifest holds it. */
  missing: boolean;
}

const nodeOf = (w: WorkspaceManifest): CloneNode => ({ id: w.id, name: w.name, type: w.type, cutoffDate: w.cutoffDate, status: w.status, mode: w.lineage.mode, missing: false });

/**
 * The clone tree around a workspace, read from each manifest's `lineage.fromWorkspaceId`: ancestors root first, and
 * every descendant in depth-first order with its depth. A cycle in malformed data stops the walk.
 */
export function cloneTree(head: WorkspaceManifest, all: WorkspaceManifest[]): { ancestors: CloneNode[]; descendants: Array<CloneNode & { depth: number }> } {
  const byId = new Map(all.map((w) => [w.id, w] as const));
  const seen = new Set<string>([head.id]);
  const ancestors: CloneNode[] = [];
  let cur: WorkspaceManifest = head;
  while (cur.lineage.fromWorkspaceId !== null) {
    const id: string = cur.lineage.fromWorkspaceId;
    if (seen.has(id)) break;
    seen.add(id);
    const parent = byId.get(id);
    if (parent === undefined) {
      ancestors.unshift({ id, name: id, type: null, cutoffDate: null, status: null, mode: null, missing: true });
      break;
    }
    ancestors.unshift(nodeOf(parent));
    cur = parent;
  }
  const descendants: Array<CloneNode & { depth: number }> = [];
  const walk = (id: string, depth: number): void => {
    const children = all
      .filter((w) => w.lineage.fromWorkspaceId === id && !seen.has(w.id))
      .sort((a, b) => (a.cutoffDate !== b.cutoffDate ? (a.cutoffDate < b.cutoffDate ? -1 : 1) : a.id < b.id ? -1 : 1));
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      descendants.push({ ...nodeOf(c), depth });
      walk(c.id, depth + 1);
    }
  };
  walk(head.id, 1);
  return { ancestors, descendants };
}

export function supersedeLinks(head: WorkspaceManifest, _all: WorkspaceManifest[]): { supersededBy: string | null; supersedes: string | null; pending: boolean } {
  return {
    supersededBy: head.lineage.supersededBy,
    supersedes: head.lineage.mode === "supersede" ? head.lineage.fromWorkspaceId : null,
    pending: head.lineage.pendingSupersede,
  };
}

export const PRODUCTION_LOCK_WARNING =
  "Signing a Production workspace locks it: its blocks, imports and launches are refused from then on, and a correction is a superseding clone. There is no unlock.";

/** Why a sign-off cannot be sent now, or null when it can. */
export function signOffBlock(head: WorkspaceManifest, by: string): string | null {
  if (head.status === "locked") return "This workspace is locked; a locked workspace takes no further sign-off. Clone it to change it.";
  if (head.status === "archived") return "This workspace is archived; an archived workspace takes no sign-off.";
  if (head.status === "superseded") return "This workspace is superseded; sign off the workspace that superseded it.";
  if (by.trim() === "") return "Type your name to sign off.";
  return null;
}

/** The stage ids a stored run resolved plugins for, in order of first appearance in its run log. */
export function chainStages(runLog: ReadonlyArray<{ t: string; scope?: { stageId?: string } }> | undefined): string[] {
  const out: string[] = [];
  for (const e of runLog ?? []) {
    const id = e.t === "resolve" ? e.scope?.stageId : undefined;
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}
