/**
 * Stored run plans (Studio S2).
 *
 *   GET  /api/run-plans        listing (the meta rows)
 *   GET  /api/run-plans/:id    the stored plan, verbatim
 *   POST /api/run-plans        { plan } -> 201 meta | 200 meta (identical re-save) | 409 | 422
 *
 * Append-only like every collection. parseBodyPlan (the body guard and
 * parseRunPlan call shared with POST /api/plans/validate and /api/plans/run) is
 * the shape gate only: the stored document is the request's plan as JSON.parse
 * read it, so the key order the author wrote survives and the Studio canvas
 * round-trips it. The parser's rebuilt object is never stored.
 */
import type { PlatformContext } from "../../context";
import { assertValidId } from "../../store/paths";
import { serializeDocument, sha256Hex } from "../../store/store";
import { conflict } from "../errors";
import type { Router } from "../router";
import { parseBodyPlan } from "./plans";

export function registerRunPlanRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("GET", "/api/run-plans", () => ({ kind: "json", value: store.listMeta("run-plans") }));

  router.add("GET", "/api/run-plans/:id", (req) => ({
    kind: "json",
    value: store.getDocument("run-plans", assertValidId(req.params.id ?? "")).doc,
  }));

  router.add("POST", "/api/run-plans", (req) => {
    const body = req.json<{ plan: unknown }>();
    const parsed = parseBodyPlan(body);
    const id = assertValidId(parsed.planId);
    if (store.has("run-plans", id)) {
      const meta = store.getMeta("run-plans", id);
      if (meta.contentHash === sha256Hex(serializeDocument(body.plan))) return { kind: "json", status: 200, value: meta };
      throw conflict(`run plan "${id}" already exists with different content (the store is append-only); save it under a new id`);
    }
    const meta = store.putDocument("run-plans", id, body.plan, {
      label: parsed.label,
      positionBook: parsed.inputs.positionBook,
      asOf: parsed.asOf,
    });
    return { kind: "json", status: 201, value: meta };
  });
}
