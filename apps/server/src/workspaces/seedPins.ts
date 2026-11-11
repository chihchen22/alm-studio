/**
 * What the seed CLI needs to know about workspaces (Studio A+E spec v3.1 Section 2.6).
 *
 *  - namingWorkspaces: the retire refusal. A document is named when any workspace head, of any
 *    status, pins it in any block, or any consumed-pins line of any `setups.ndjson` names it.
 *  - repinSeedOnly: the refresh re-pin. After a refresh moves a document, every seed-only
 *    workspace (every history line written by `seed`, `migration` or `seed-refresh`) that is
 *    `active` and held the old hash gets one `re-pin` history line per block that held it.
 *    `setups.ndjson` is never rewritten, and a locked, archived or superseded workspace is never
 *    touched, so a signed month's pins cannot move.
 *
 * Both run with the platform server stopped (the CLI refuses on a live `.server.json`), so no
 * in-process mutex is needed here.
 */
import type { Collection } from "../store/paths";
import { BLOCK_NAMES } from "./hashes";
import type { BlockName, DocRef, WorkspaceBlocks, WorkspaceManifest } from "./types";
import type { WorkspaceStore } from "./workspaceStore";

/** The three writers that are not a person. */
export const NON_INTERACTIVE_WRITERS: readonly string[] = ["seed", "migration", "seed-refresh"];

/** Every DocRef one block holds, by reference, so a caller on a clone may rewrite them in place. */
export function refsInBlock(blocks: WorkspaceBlocks, block: BlockName): DocRef[] {
  const out: DocRef[] = [];
  const push = (r: DocRef | null | undefined): void => {
    if (r) out.push(r);
  };
  switch (block) {
    case "market":
      push(blocks.market.snapshot);
      blocks.market.derived.forEach(push);
      blocks.market.carried.forEach((c) => push(c.source));
      break;
    case "positions":
      push(blocks.positions.book);
      blocks.positions.retagged.forEach(push);
      push(blocks.positions.coa);
      push(blocks.positions.taxonomy);
      blocks.positions.hierarchies.forEach(push);
      break;
    case "targets":
      blocks.targets.balancePlans.forEach(push);
      blocks.targets.templates.forEach(push);
      break;
    case "assumptions":
      blocks.assumptions.sets.forEach(push);
      push(blocks.assumptions.routingPolicy);
      break;
    case "scenarios":
      blocks.scenarios.slates.forEach(push);
      break;
    case "run":
      blocks.run.setups.forEach((s) => push(s.current));
      blocks.run.lenses.forEach(push);
      break;
  }
  return out;
}

/** True when every history line was written by the seed, a migration or a seed refresh. */
export function isSeedOnly(history: ReadonlyArray<{ by: string }>): boolean {
  return history.every((l) => NON_INTERACTIVE_WRITERS.includes(l.by));
}

/** The ids of the workspaces that name `collection/id`, ascending: by head pin, or by a consumed-pins line. */
export function namingWorkspaces(wsStore: WorkspaceStore, collection: Collection, id: string): string[] {
  const hits = (r: DocRef | undefined): boolean => r !== undefined && r.collection === collection && r.id === id;
  const out: string[] = [];
  for (const head of wsStore.list()) {
    const byHead = BLOCK_NAMES.some((b) => refsInBlock(head.blocks, b).some(hits));
    const bySetups = wsStore
      .readSetupEvents(head.id)
      .some((e) => (e.t === "validate" || e.t === "launch") && Object.values(e.consumed).some(hits));
    if (byHead || bySetups) out.push(head.id);
  }
  return out.sort();
}

export interface Repin {
  workspaceId: string;
  block: BlockName;
  id: string;
  from: string;
  to: string;
}

/**
 * Move every pin of `collection/id` at `from` to `to` in each seed-only, active workspace: one history
 * line per block, by `seed-refresh`. Returns what moved, in workspace and block order.
 */
export function repinSeedOnly(wsStore: WorkspaceStore, collection: Collection, id: string, from: string, to: string, now: string): Repin[] {
  const done: Repin[] = [];
  for (const listed of wsStore.list()) {
    if (listed.status !== "active" || listed.lock !== null) continue;
    if (!isSeedOnly(wsStore.history(listed.id))) continue;
    let head: WorkspaceManifest = listed;
    for (const block of BLOCK_NAMES) {
      const blocks = structuredClone(head.blocks);
      const hit = refsInBlock(blocks, block).filter((r) => r.collection === collection && r.id === id && r.contentHash === from);
      if (hit.length === 0) continue;
      for (const r of hit) {
        r.contentHash = to;
        r.pinnedAt = now;
      }
      head = wsStore.commit(head.id, head.revision, "seed-refresh", { kind: "re-pin", block, id, from, to }, { ...head, blocks });
      done.push({ workspaceId: head.id, block, id, from, to });
    }
  }
  return done;
}
