/** The stored chart of accounts as a depth-first tree (ALM Studio P1). Order is the stored sibling order. */
import { usdMM } from "@alm/reader";

export interface CoaNodeLike {
  id: string;
  label: string;
  parentId: string | null;
  side: string;
  isLeaf: boolean;
  familyId?: string;
  order: number;
}

export interface CoaRow {
  id: string;
  label: string;
  depth: number;
  side: string;
  familyId: string | null;
  isLeaf: boolean;
}

export function coaRows(nodes: CoaNodeLike[]): CoaRow[] {
  const kids = (parent: string | null) => nodes.filter((n) => (n.parentId ?? null) === parent).sort((a, b) => a.order - b.order);
  const out: CoaRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids(parent)) {
      out.push({ id: n.id, label: n.label, depth, side: n.side, familyId: n.familyId ?? null, isLeaf: n.isLeaf });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** A cell's printed text; muted marks a statement of absence rather than a value. */
export interface CoaCell {
  text: string;
  muted: boolean;
}

/**
 * The grouped aggregate's rows (groupBy=coaNode) keyed by leaf id. The null-key
 * row is the ungrouped remainder and belongs to no leaf, so it is dropped. A
 * null totalNotional stays null: it is not a zero.
 */
export function leafNotionals(groups: ReadonlyArray<{ key: string | null; totalNotional: number | null }>): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const g of groups) if (g.key !== null) out.set(g.key, g.totalNotional);
  return out;
}

/**
 * A row's notional cell. A leaf prints its served total. A leaf the grouped
 * aggregate does not serve holds no positions; a leaf served with a null total
 * has positions whose notional is null. Neither is a zero. A parent prints that
 * no roll-up is served: Studio does not add.
 */
export function notionalCell(isLeaf: boolean, served: number | null | undefined): CoaCell {
  if (!isLeaf) return { text: "No roll-up served", muted: true };
  if (served === undefined) return { text: "Unobservable: no positions", muted: false };
  if (served === null) return { text: "Unobservable: notional null", muted: false };
  return { text: usdMM(served), muted: false };
}

/** A row's family cell. Parents carry no family by design and say so, muted; a leaf without one says so too. */
export function familyCell(isLeaf: boolean, familyId: string | null): CoaCell {
  if (familyId !== null) return { text: familyId, muted: false };
  return isLeaf ? { text: "No family", muted: true } : { text: "None: parent", muted: true };
}
