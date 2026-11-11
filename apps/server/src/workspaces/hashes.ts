/**
 * The three workspace hashes and the slug rule (Studio A+E spec v3.1 Sections 2.2 and 2.10).
 *
 *  - blockHashes: per block, contentHash over that block's entry tuples, sorted by each
 *    tuple's own JSON string, so attachment order never matters. `pinnedAt`, `carriedFrom`
 *    and refusal text enter no tuple.
 *  - signedHash: contentHash of { id, type, cutoffDate, blockHashes }. The approval binds
 *    to this, so a lock, rename, note or status change never moves it.
 *  - manifestHash: contentHash of the whole head minus updatedAt, revision and itself.
 *    Identifies one revision in history; nothing signs it.
 */
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { InvalidIdError } from "../store/paths";
import type { BlockName, WorkspaceBlocks, WorkspaceManifest } from "./types";

export type Tuple = Array<string | null>;

const doc = (r: { collection: string; id: string; contentHash: string }): Tuple => [r.collection, r.id, r.contentHash];

const byJson = (x: Tuple, y: Tuple): number => {
  const a = JSON.stringify(x);
  const b = JSON.stringify(y);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** The sorted entry tuples of one block: what blockHashes hashes, and what compare lists. */
export function blockTuples(blocks: WorkspaceBlocks, block: BlockName): Tuple[] {
  const out: Tuple[] = [];
  switch (block) {
    case "market": {
      const m = blocks.market;
      if (m.snapshot) out.push(doc(m.snapshot));
      for (const d of m.derived) out.push(["derived", d.id, d.contentHash, d.definitionKey, d.parentKey]);
      for (const c of m.carried) out.push(["carried", c.definitionKey, c.parentKey, c.source.id, c.source.contentHash, c.status, c.appliedId]);
      // Saved curve setups and the active pointer. No tuple when the slot is absent, so a
      // workspace with no curve setup hashes exactly as before.
      if (m.curveSetups !== undefined) {
        for (const s of m.curveSetups.setups) out.push(["curve-setups", s.lineageKey, s.current.id, s.current.contentHash]);
        if (m.curveSetups.active !== undefined) out.push(["curve-active", m.curveSetups.active]);
      }
      // Saved derived curves. No tuple when the slot is absent, as above.
      if (m.derivedCurves !== undefined) {
        for (const c of m.derivedCurves.curves) out.push(["derived-curves", c.lineageKey, c.current.id, c.current.contentHash]);
      }
      break;
    }
    case "positions": {
      const p = blocks.positions;
      for (const r of [p.book, p.coa, p.taxonomy, ...p.retagged, ...p.hierarchies]) if (r) out.push(doc(r));
      break;
    }
    case "targets": {
      const t = blocks.targets;
      for (const r of [...t.balancePlans, ...t.templates]) out.push(doc(r));
      break;
    }
    case "assumptions": {
      const a = blocks.assumptions;
      for (const r of a.sets) out.push(doc(r));
      if (a.routingPolicy) out.push(doc(a.routingPolicy));
      if (a.defaultSetId !== null) out.push(["default", a.defaultSetId]);
      break;
    }
    case "scenarios":
      for (const r of blocks.scenarios.slates) out.push(doc(r));
      break;
    case "run": {
      const r = blocks.run;
      for (const s of r.setups) out.push(["run-setups", s.setupLineageId, s.current.id, s.current.contentHash]);
      for (const l of r.lenses) out.push(doc(l));
      break;
    }
  }
  return out.sort(byJson);
}

export const BLOCK_NAMES: readonly BlockName[] = ["market", "positions", "targets", "assumptions", "scenarios", "run"];

export function blockHashes(blocks: WorkspaceBlocks): Record<BlockName, string> {
  return Object.fromEntries(BLOCK_NAMES.map((b) => [b, contentHash(blockTuples(blocks, b))])) as Record<BlockName, string>;
}

export function signedHashOf(m: Pick<WorkspaceManifest, "id" | "type" | "cutoffDate" | "blockHashes">): string {
  return contentHash({ id: m.id, type: m.type, cutoffDate: m.cutoffDate, blockHashes: m.blockHashes });
}

export function manifestHashOf(m: WorkspaceManifest): string {
  const { updatedAt: _u, revision: _r, manifestHash: _h, ...rest } = m;
  return contentHash(rest);
}

/**
 * Spec Section 2.10 slug rule: `ws-<stem>`, the name lowercased, every run of characters
 * outside [a-z0-9] collapsed to one hyphen, leading and trailing hyphens stripped,
 * truncated to 40 characters. An empty stem throws InvalidIdError (the route maps it to 422).
 */
export function slugOf(name: string): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  if (stem.length === 0) throw new InvalidIdError(`ws-${stem}`);
  return `ws-${stem}`;
}
