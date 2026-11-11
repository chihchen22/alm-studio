/**
 * Market > Rate indices: the definitions a workspace holds, in dependency order (ruling 4, ruling 17). A definition is
 * a derived market in the block (TLP shock, vol shock, rate indices, macro series) or an entry carried across a
 * roll-forward that waits to be re-applied on the new base. Each names the definition it was derived from, so the
 * list reads parent first with the depth of each. Pure functions over the manifest.
 */
import type { MarketBlock, ReapplyMarketBody, WorkspaceManifest } from "@alm/reader";
import { definitionOrder } from "../harness/instances";

export type DefinitionState = "in-block" | "awaiting" | "applied" | "refused";

export interface DefinitionRowView {
  key: string;
  parentKey: string | null;
  level: number;
  state: DefinitionState;
  /** The derived market the definition resolves to; null while it awaits or was refused. */
  appliedId: string | null;
  /** The engine's refusal text; null otherwise. */
  refusal: string | null;
}

export function definitionRows(market: MarketBlock): DefinitionRowView[] {
  const byKey = new Map<string, { definitionKey: string; parentKey: string | null; state: DefinitionState; appliedId: string | null; refusal: string | null }>();
  for (const d of market.derived) byKey.set(d.definitionKey, { definitionKey: d.definitionKey, parentKey: d.parentKey, state: "in-block", appliedId: d.id, refusal: null });
  // A carried entry is the later word: an applied one names the derived market it became.
  for (const c of market.carried) byKey.set(c.definitionKey, { definitionKey: c.definitionKey, parentKey: c.parentKey, state: c.status, appliedId: c.appliedId, refusal: c.refusal });
  return definitionOrder([...byKey.values()]).map((r) => ({ key: r.definitionKey, parentKey: r.parentKey, level: r.level, state: r.state, appliedId: r.appliedId, refusal: r.refusal }));
}

/** POST /api/workspaces/:id/market/reapply at the head revision the page read. */
export function reapplyBody(head: WorkspaceManifest, by: string): ReapplyMarketBody {
  return { expectedRevision: head.revision, by };
}

/** How many carried entries still wait. */
export function awaitingCount(market: MarketBlock): number {
  return market.carried.filter((c) => c.status === "awaiting").length;
}

export function stateText(r: Pick<DefinitionRowView, "state" | "appliedId">): string {
  switch (r.state) {
    case "in-block": return "In the block";
    case "awaiting": return "Awaiting re-apply";
    case "applied": return r.appliedId === null ? "Re-applied" : `Re-applied as ${r.appliedId}`;
    case "refused": return "Refused";
  }
}
