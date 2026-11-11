/**
 * Assumptions: the sets and the routing policy a workspace holds, and the mapping grid over one set. Pure functions. The block bodies
 * are the ones POST /api/workspaces/:id/blocks takes (spec v3.1 Section 2.4, "The default set"): `add` attaches a
 * stored set, and the first one attached becomes the workspace default; `set-default` moves the default among the
 * sets attached.
 */
import type { AssumptionSet } from "@alm/engine";
import { bindingParts, type SetBlockBody, type WorkspaceManifest } from "@alm/reader";
import { writeBlock } from "../controls/attachBodies";
import { selectorText } from "./selectorText";

function setBody(head: WorkspaceManifest, setId: string, by: string, op: "add" | "set-default"): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "assumptions", op, ref: { collection: "assumption-sets", id: setId } };
}

/** Attach a stored set to the assumptions block. */
export function attachBody(head: WorkspaceManifest, setId: string, by: string): SetBlockBody {
  return setBody(head, setId, by, "add");
}

/** Name an attached set as the workspace default. */
export function defaultBody(head: WorkspaceManifest, setId: string, by: string): SetBlockBody {
  return setBody(head, setId, by, "set-default");
}

/** Set the workspace's routing policy: the block holds one, so `set` replaces whichever is attached. */
export function routingPolicyBody(head: WorkspaceManifest, policyId: string, by: string): SetBlockBody {
  return { expectedRevision: head.revision, by, block: "assumptions", op: "set", ref: { collection: "routing-policies", id: policyId } };
}

/** Why the routing policy cannot be changed on this workspace, in words; null when it can. Mirrors the server's write refusal. */
export function policyBlock(head: WorkspaceManifest): string | null {
  return writeBlock(head, "its routing policy");
}

export interface MappingRow {
  familyId: string;
  selector: string;
  /** One cell per kind in `kinds`: the model version bound, or null where the set binds none. */
  cells: Array<string | null>;
}

export interface MappingGrid {
  kinds: string[];
  rows: MappingRow[];
}

/** Family and selector against overlay kind for one set: each cell the bound model version. Kinds and rows in sorted order. */
export function mappingGrid(set: Pick<AssumptionSet, "bindings">): MappingGrid {
  const kinds = [...new Set(set.bindings.map((b) => bindingParts(b).kind))].sort();
  const rows = new Map<string, MappingRow>();
  for (const b of set.bindings) {
    const p = bindingParts(b);
    const selector = selectorText(b.selector);
    const key = `${b.familyId}::${selector}`;
    const row = rows.get(key) ?? { familyId: b.familyId, selector, cells: kinds.map(() => null) };
    row.cells[kinds.indexOf(p.kind)] = p.modelVersion;
    rows.set(key, row);
  }
  const sorted = [...rows.values()].sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
  return { kinds, rows: sorted };
}
