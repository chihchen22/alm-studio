/**
 * Re-apply of carried market definitions (Studio A+E spec v3.1 Section 2.4, ruling 17).
 *
 * A roll-forward leaves one CarriedDefinition per derived market of the month before, awaiting. Once
 * the new base snapshot is set, `reapplyMarket` walks them parents first and, for each whose parent
 * is applied (or null), reads the ops from the source pin (`findPinned`, live or under superseded/),
 * calls the engine's derive step on the new base with no id (so the engine assigns its
 * content-addressed `derived-mk-<12 hex>`), stores the result unless the same bytes are already
 * there, and adds a DerivedRef under the entry's unchanged definitionKey and parentKey. An op the
 * engine refuses is recorded as `refused` with the engine's text; its children stay awaiting.
 *
 * Crash order: the derived document is an append-only write that leaves a harmless orphan when the
 * head commit that follows fails; the retry derives the same id from the same bytes and reuses it.
 */
import { HttpError, conflict } from "../http/errors";
import { mirrorBestEffort } from "../http/router";
import { deriveMarketFromStore, derivedMarketMeta } from "../derivedSets/derivedMarkets";
import { serializeDocument, sha256Hex, type FileStore } from "../store/store";
import type { CarriedDefinition, DerivedRef, HistoryChange, MarketBlock, WorkspaceManifest } from "./types";

/**
 * Parents before children (Kahn over `parentKey`), the list order kept among entries that are
 * ready together. A parent that is not in the list does not hold its child back; a cycle (which a
 * well-formed manifest never holds) is appended in list order rather than dropped.
 */
export function orderParentsFirst(entries: readonly CarriedDefinition[]): CarriedDefinition[] {
  const keys = new Set(entries.map((e) => e.definitionKey));
  const placed = new Set<string>();
  const out: CarriedDefinition[] = [];
  let remaining = [...entries];
  while (remaining.length > 0) {
    const ready = remaining.filter((e) => e.parentKey === null || !keys.has(e.parentKey) || placed.has(e.parentKey));
    if (ready.length === 0) {
      out.push(...remaining);
      break;
    }
    for (const e of ready) {
      out.push(e);
      placed.add(e.definitionKey);
    }
    remaining = remaining.filter((e) => !ready.includes(e));
  }
  return out;
}

export interface ReapplyResult {
  /** The market block after the pass: the input block itself when nothing changed. */
  market: MarketBlock;
  /** One history change per call, naming the first entry that moved; null when nothing moved. */
  change: HistoryChange | null;
}

function refuse(e: CarriedDefinition, text: string): void {
  e.status = "refused";
  e.appliedId = null;
  e.refusal = text;
}

/**
 * One re-apply pass over the head's carried definitions. The caller has checked that the snapshot is
 * set and holds the workspace lock. Writes derived market documents to the store; never writes the
 * workspace head (the caller commits `market` with `change`).
 */
export function reapplyMarket(store: FileStore, head: WorkspaceManifest, now: string): ReapplyResult {
  const original = head.blocks.market;
  const snapshot = original.snapshot;
  if (snapshot === null || original.carried.length === 0) return { market: original, change: null };

  const market: MarketBlock = JSON.parse(JSON.stringify(original)) as MarketBlock;
  let change: HistoryChange | null = null;

  for (const e of orderParentsFirst(market.carried)) {
    if (e.status === "applied") continue;

    // The base this definition derives on: the new snapshot for a root, else its parent's applied market.
    let baseId: string | null;
    if (e.parentKey === null) {
      baseId = snapshot.id;
    } else {
      const parent = market.carried.find((c) => c.definitionKey === e.parentKey);
      baseId = parent ? (parent.status === "applied" ? parent.appliedId : null) : (market.derived.find((d) => d.definitionKey === e.parentKey)?.id ?? null);
    }
    if (baseId === null) continue; // parent awaiting or refused: this entry stays as it is

    const before = JSON.stringify([e.status, e.appliedId, e.refusal]);
    const held = market.derived.find((d) => d.definitionKey === e.definitionKey);
    if (held) {
      // The definition is already in the block (added by hand under its key): nothing to derive.
      e.status = "applied";
      e.appliedId = held.id;
      e.refusal = null;
    } else {
      const pinned = store.findPinned(e.source.collection, e.source.id, e.source.contentHash);
      let ops: unknown;
      if (pinned) {
        try {
          ops = (JSON.parse(pinned.bytes.toString("utf8")) as { derivedFrom?: { ops?: unknown } }).derivedFrom?.ops;
        } catch {
          ops = undefined;
        }
      }
      if (!pinned) {
        refuse(e, `the pinned bytes of market "${e.source.id}" are not in the store (neither live nor under superseded/); re-pin or keep this workspace as history`);
      } else if (!Array.isArray(ops)) {
        refuse(e, `market "${e.source.id}" carries no derivedFrom ops, so definition "${e.definitionKey}" cannot be re-applied`);
      } else {
        try {
          const result = deriveMarketFromStore(store, { baseId, ops });
          const clash = market.derived.find((d) => d.id === result.id);
          if (clash) {
            refuse(e, `definition "${e.definitionKey}" derives to market "${result.id}", already held under definition "${clash.definitionKey}"`);
          } else {
            if (store.has("market", result.id)) {
              if (store.getMeta("market", result.id).contentHash !== sha256Hex(serializeDocument(result.snapshot))) {
                throw conflict(`market "${result.id}" already exists with different content (the store is append-only)`);
              }
            } else {
              store.putDocument("market", result.id, result.snapshot, derivedMarketMeta(result));
              // After the store write: the catalog reads this derived market at once (best effort; the
              // caller holds the workspace lock, and the mirror takes none).
              mirrorBestEffort({ store }, "market", result.id);
            }
            const ref: DerivedRef = {
              collection: "market",
              id: result.id,
              contentHash: store.getMeta("market", result.id).contentHash,
              pinnedAt: now,
              definitionKey: e.definitionKey,
              parentKey: e.parentKey,
            };
            market.derived = [...market.derived, ref];
            e.status = "applied";
            e.appliedId = result.id;
            e.refusal = null;
          }
        } catch (err) {
          if (!(err instanceof HttpError) || err.status !== 422) throw err;
          refuse(e, err.message);
        }
      }
    }

    if (change === null && JSON.stringify([e.status, e.appliedId, e.refusal]) !== before) {
      change = { kind: "reapply", definitionKey: e.definitionKey, appliedId: e.appliedId, refusal: e.refusal };
    }
  }

  return change === null ? { market: original, change: null } : { market, change };
}
