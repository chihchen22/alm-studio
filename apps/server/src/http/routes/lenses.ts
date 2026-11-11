/**
 * Stored lens definitions (Controls, limits; read-only first build).
 *
 *   GET /api/lenses    every stored lens, ascending id: { id, label, objective,
 *                      constraints, contentHash }
 *
 * Read-only by design. The seed is the only writer of a lens (spec
 * Section 1) and no write route is added here; a POST answers the platform's
 * no-route 404. The fields are the stored document's, verbatim; `contentHash`
 * is the store's SHA-256 over the stored file bytes. Scoring a run through
 * these definitions stays with GET /api/runs/:id/lens and /lenses.
 */
import type { LensDefinition } from "@alm/engine";
import type { PlatformContext } from "../../context";
import type { Router } from "../router";

export function registerLensRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("GET", "/api/lenses", () => ({
    kind: "json",
    value: store.listMeta("lens").map((meta) => {
      const doc = store.getDocument<LensDefinition>("lens", meta.id).doc;
      return {
        id: doc.id,
        label: doc.label,
        objective: doc.objective,
        constraints: doc.constraints,
        contentHash: meta.contentHash,
      };
    }),
  }));
}
