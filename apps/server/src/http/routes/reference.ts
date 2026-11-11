/**
 * Stored reference documents (read-only).
 *
 *   GET /api/reference       every stored reference document, ascending id:
 *                            { id, label, kind, contentHash }
 *   GET /api/reference/:id   the stored document, verbatim (404 naming the id when absent)
 *
 * The seed is the only writer (a registered seed profile may write parameters
 * documents and reconciliation targets); no write route exists, so a POST
 * answers the platform's no-route 404. A run never reads this collection; a
 * tie-out and the Studio views a pack registers do.
 */
import type { PlatformContext } from "../../context";
import type { Router } from "../router";

export function registerReferenceRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("GET", "/api/reference", () => ({
    kind: "json",
    value: store.listMeta("reference").map((meta) => ({
      id: meta.id,
      label: typeof meta.label === "string" ? meta.label : meta.id,
      ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
      contentHash: meta.contentHash,
    })),
  }));

  router.add("GET", "/api/reference/:id", (req) => ({
    kind: "json",
    value: store.getDocument<unknown>("reference", req.params.id ?? "").doc,
  }));
}
