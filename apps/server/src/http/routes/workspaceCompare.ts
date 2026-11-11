/**
 * GET /api/workspaces/compare?a=<id>&b=<id> (Studio A+E spec v3.1 Section 2.8).
 *
 * Per block the verdict is read from the heads' stored block hashes: `same` when the two
 * hashes match, `only-a` when b's entry list is empty and a's is not, `only-b` the reverse,
 * else `changed`. A changed block carries both entry-tuple lists (the exact tuples the hash
 * covers), so Studio can lay them side by side. Read-only: it answers on a locked, superseded
 * or archived workspace. Register it BEFORE the `:id` route: both are three segments.
 */
import type { PlatformContext } from "../../context";
import { BLOCK_NAMES, blockTuples, type Tuple } from "../../workspaces/hashes";
import type { BlockName, WorkspaceManifest } from "../../workspaces/types";
import { badRequest } from "../errors";
import type { Router } from "../router";

export type CompareVerdict = "same" | "changed" | "only-a" | "only-b";

export interface CompareBlock {
  verdict: CompareVerdict;
  a?: Tuple[];
  b?: Tuple[];
}

export interface CompareSide {
  id: string;
  name: string;
  type: WorkspaceManifest["type"];
  status: WorkspaceManifest["status"];
  cutoffDate: string;
  revision: number;
  signedHash: string;
}

export interface CompareReply {
  a: CompareSide;
  b: CompareSide;
  blocks: Record<BlockName, CompareBlock>;
}

const side = (m: WorkspaceManifest): CompareSide => ({
  id: m.id,
  name: m.name,
  type: m.type,
  status: m.status,
  cutoffDate: m.cutoffDate,
  revision: m.revision,
  signedHash: m.signedHash,
});

export function compareWorkspaces(a: WorkspaceManifest, b: WorkspaceManifest): CompareReply {
  const blocks = {} as Record<BlockName, CompareBlock>;
  for (const name of BLOCK_NAMES) {
    if (a.blockHashes[name] === b.blockHashes[name]) {
      blocks[name] = { verdict: "same" };
      continue;
    }
    const left = blockTuples(a.blocks, name);
    const right = blockTuples(b.blocks, name);
    if (right.length === 0 && left.length > 0) blocks[name] = { verdict: "only-a" };
    else if (left.length === 0 && right.length > 0) blocks[name] = { verdict: "only-b" };
    else blocks[name] = { verdict: "changed", a: left, b: right };
  }
  return { a: side(a), b: side(b), blocks };
}

export function registerWorkspaceCompareRoute(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/workspaces/compare", (req) => {
    const a = req.query.get("a") ?? "";
    const b = req.query.get("b") ?? "";
    if (a.length === 0 || b.length === 0) throw badRequest(`compare needs both ?a=<workspaceId> and ?b=<workspaceId>`);
    // head() reconciles first and answers 404 for an unknown id.
    return { kind: "json", value: compareWorkspaces(ctx.workspaces.head(a), ctx.workspaces.head(b)) };
  });
}
