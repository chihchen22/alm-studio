/**
 * Derived assumption sets.
 *
 *   POST /api/assumption-sets/derive/preview  { baseId, ops, id?, label? } -> 200 { set, changes } (stores nothing)
 *   POST /api/assumption-sets/derive          { baseId, ops, id?, label? } -> 201 created | 200 unchanged | 409 | 422
 *
 * The engine's deriveAssumptionSet derives the set and its change rows; this
 * route stores the result append-only (the hierarchies route is the precedent).
 * A re-save compares the stored file bytes: identical is 200, different content
 * under the same id is 409. An engine refusal is 422 with every problem listed
 * in detail.problems. Studio shows what is served and adds no figure.
 */
import type { AssumptionSet } from "@alm/engine";
import type { PlatformContext } from "../../context";
import { deriveFromStore, derivedSetMeta, parseDeriveBody } from "../../derivedSets/derivedSets";
import { serializeDocument, sha256Hex } from "../../store/store";
import { conflict } from "../errors";
import { mirrorBestEffort, type Router } from "../router";

export function registerDerivedSetRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("POST", "/api/assumption-sets/derive/preview", (req) => {
    const { set, changes } = deriveFromStore(store, parseDeriveBody(req.json<unknown>()));
    return { kind: "json", value: { set, changes } };
  });

  router.add("POST", "/api/assumption-sets/derive", (req) => {
    const { set, changes } = deriveFromStore(store, parseDeriveBody(req.json<unknown>()));
    if (store.has("assumption-sets", set.id)) {
      const meta = store.getMeta("assumption-sets", set.id);
      if (meta.contentHash === sha256Hex(serializeDocument(set))) {
        const stored = store.getDocument<AssumptionSet>("assumption-sets", set.id).doc;
        return { kind: "json", status: 200, value: { outcome: "unchanged", set: stored, changes } };
      }
      throw conflict(
        `assumption set "${set.id}" already exists with different content (the store is append-only); save it under a new id`,
      );
    }
    store.putDocument("assumption-sets", set.id, set, derivedSetMeta(set));
    // After the store write: the catalog and lineage reads answer for this document at once (best effort).
    mirrorBestEffort(ctx, "assumption-sets", set.id);
    return { kind: "json", status: 201, value: { outcome: "created", set, changes } };
  });
}
