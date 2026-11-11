/**
 * Derived markets (extended by Pieces 7a, 6d and 7b): funding spread
 * shocks, rate indices, short-rate volatility shocks and macro series stored as market snapshots.
 *
 *   POST /api/market/derive/preview  { baseId, ops, id?, label? } -> 200 { id, label, snapshot, changes, indexChanges, volChanges, termFundingQuotesDropped } (stores nothing)
 *   POST /api/market/derive          { baseId, ops, id?, label? } -> 201 created | 200 unchanged | 409 | 422
 *
 * The ops are TLP ops (add, scale), rate index ops (set-index,
 * add-index-basis) and short-rate volatility ops (scale-short-rate-vol,
 * add-short-rate-vol), applied in order. changes lists the TLP nodes touched,
 * indexChanges the rate indices touched (an empty list when no index op ran) and
 * volChanges one row per volatility expiry row touched (an empty list when no
 * volatility op ran). macroChanges lists the macro series touched and
 * is present only when a macro op ran (set-macro-series, remove-macro-series).
 *
 * The engine's deriveMarketSnapshot derives the snapshot and its change rows;
 * this route stores the result append-only (the derived-set route is the
 * precedent). A re-save compares the stored file bytes: identical is 200,
 * different content under the same id is 409. An engine refusal is 422 with
 * every problem listed in detail.problems. Studio shows what is served and adds
 * no figure.
 */
import type { PlatformContext } from "../../context";
import { deriveMarketFromStore, derivedMarketMeta, parseMarketDeriveBody } from "../../derivedSets/derivedMarkets";
import { serializeDocument, sha256Hex } from "../../store/store";
import { conflict } from "../errors";
import { mirrorBestEffort, type Router } from "../router";

export function registerDerivedMarketRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("POST", "/api/market/derive/preview", (req) => {
    const r = deriveMarketFromStore(store, parseMarketDeriveBody(req.json<unknown>()));
    return {
      kind: "json",
      value: {
        id: r.id,
        label: r.label,
        snapshot: r.snapshot,
        changes: r.changes,
        indexChanges: r.indexChanges,
        volChanges: r.volChanges,
        ...(r.macroChanges.length > 0 ? { macroChanges: r.macroChanges } : {}),
        termFundingQuotesDropped: r.termFundingQuotesDropped,
      },
    };
  });

  router.add("POST", "/api/market/derive", (req) => {
    const r = deriveMarketFromStore(store, parseMarketDeriveBody(req.json<unknown>()));
    const rest = {
      id: r.id,
      label: r.label,
      changes: r.changes,
      indexChanges: r.indexChanges,
      volChanges: r.volChanges,
      ...(r.macroChanges.length > 0 ? { macroChanges: r.macroChanges } : {}),
      termFundingQuotesDropped: r.termFundingQuotesDropped,
    };
    if (store.has("market", r.id)) {
      const meta = store.getMeta("market", r.id);
      if (meta.contentHash === sha256Hex(serializeDocument(r.snapshot))) {
        const stored = store.getDocument<unknown>("market", r.id).doc;
        return { kind: "json", status: 200, value: { outcome: "unchanged", ...rest, snapshot: stored } };
      }
      throw conflict(
        `market "${r.id}" already exists with different content (the store is append-only); save it under a new id`,
      );
    }
    store.putDocument("market", r.id, r.snapshot, derivedMarketMeta(r));
    // After the store write: the catalog and lineage reads answer for this document at once (best effort).
    mirrorBestEffort(ctx, "market", r.id);
    return { kind: "json", status: 201, value: { outcome: "created", ...rest, snapshot: r.snapshot } };
  });
}
