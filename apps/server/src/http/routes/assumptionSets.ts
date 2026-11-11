/**
 * Assumption-set routes.
 *
 *   GET  /api/assumption-sets        listing with contentHash
 *   GET  /api/assumption-sets/:id    the bound set
 *   POST /api/assumption-sets        AssumptionSet (no contentHash) ->
 *                                    201 bound set (engine bindAssumptions is
 *                                    the validator; its hash, never hand-made)
 *   POST /api/assumption-sets/diff   { baseId, candidate | candidateId } ->
 *                                    AssumptionDiff (the show-before-run diff)
 *
 * Derived sets are written by POST /api/assumption-sets/derive (see
 * routes/derivedSets.ts); this plain save refuses a body that carries a
 * derivedFrom, so the record in the store always means a derivation made it.
 * The listing adds derivedFromSetId to the row of a derived set, and
 * macroBindings to the row of a set that carries a macro mapping, or
 * documentMissing to a row whose document file is gone.
 *
 * Engine refusals surface verbatim as 422 (the platform never rewrites an
 * engine refusal into something softer).
 */
import type { AssumptionSet } from "@alm/engine";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { diffAssumptions } from "@alm/ai/src/compiler";
import type { PlatformContext } from "../../context";
import { badRequest, unprocessable } from "../errors";
import { mirrorBestEffort, validated, type Router } from "../router";

/**
 * The stored set's macro mapping, read from the document itself so a
 * set stored before the field existed (or by any put site) answers the same; an
 * unmapped set adds no key, so its listing row is unchanged. A meta whose
 * document file is missing marks its own row documentMissing instead of failing
 * the whole listing with 404.
 */
function macroBindingsOf(ctx: PlatformContext, id: string): { macroBindings?: AssumptionSet["macroBindings"]; documentMissing?: true } {
  if (!ctx.store.has("assumption-sets", id)) return { documentMissing: true };
  const mb = ctx.store.getDocument<AssumptionSet>("assumption-sets", id).doc.macroBindings;
  return mb === undefined ? {} : { macroBindings: mb };
}

export function registerAssumptionSetRoutes(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/assumption-sets", () => ({
    kind: "json",
    // Listing per the frozen client interface: bare array whose `contentHash`
    // is the ENGINE's bindings hash (bindAssumptions fills it; the
    // show-before-run gate keys on it), never the store's file-byte hash.
    value: ctx.store.listMeta("assumption-sets").map((meta) => ({
      id: meta.id,
      label: meta.label,
      contentHash: meta.bindingsContentHash ?? meta.contentHash,
      ...(meta.bindingCount !== undefined ? { bindingCount: meta.bindingCount } : {}),
      ...(meta.derivedFromSetId !== undefined ? { derivedFromSetId: meta.derivedFromSetId } : {}),
      ...macroBindingsOf(ctx, meta.id),
    })),
  }));

  // NOTE: route order matters: "diff" must not be captured as an :id.
  router.add("POST", "/api/assumption-sets/diff", (req) => {
    const body = req.json<{ baseId?: string; candidateId?: string; candidate?: AssumptionSet }>();
    if (typeof body.baseId !== "string") throw badRequest("diff requires a baseId");
    const base = ctx.store.getDocument<AssumptionSet>("assumption-sets", body.baseId).doc;
    let candidate: AssumptionSet;
    if (body.candidate !== undefined) {
      // A hand-edited candidate is bound (validated + hashed) before diffing,
      // so the diff describes the object that would actually run.
      candidate = validated(() => bindAssumptions(body.candidate!));
    } else if (typeof body.candidateId === "string") {
      candidate = ctx.store.getDocument<AssumptionSet>("assumption-sets", body.candidateId).doc;
    } else {
      throw badRequest("diff requires either a candidate object or a candidateId");
    }
    return { kind: "json", value: validated(() => diffAssumptions(base, candidate)) };
  });

  router.add("GET", "/api/assumption-sets/:id", (req) => ({
    kind: "json",
    value: ctx.store.getDocument<AssumptionSet>("assumption-sets", req.params.id).doc,
  }));

  router.add("POST", "/api/assumption-sets", (req) => {
    const raw = req.json<AssumptionSet>();
    if (typeof raw === "object" && raw !== null && "derivedFrom" in raw) {
      throw unprocessable("derivedFrom is written by POST /api/assumption-sets/derive; a plain save cannot carry it");
    }
    const bound = validated(() => bindAssumptions(raw));
    ctx.store.putDocument("assumption-sets", bound.id, bound, {
      label: bound.label,
      /** The engine's own hash over bindings (distinct from the file hash). */
      bindingsContentHash: bound.contentHash,
      bindingCount: bound.bindings.length,
    });
    // After the store write: the catalog and lineage reads answer for this document at once (best effort).
    mirrorBestEffort(ctx, "assumption-sets", bound.id);
    return { kind: "json", status: 201, value: bound };
  });
}
