/**
 * Derived balance plans.
 *
 *   POST /api/balance-plans/derive/preview  { baseId, bookId, ops, id?, label? } -> 200 { plan, changes, rules } (stores nothing)
 *   POST /api/balance-plans/derive          { baseId, bookId, ops, id?, label? } -> 201 created | 200 unchanged | 409 | 422
 *
 * The engine's deriveBalancePlan derives the plan, its change rows and its
 * lowered new-business rules against the named book; this route stores the
 * result append-only (the derived-set route is the precedent). A re-save
 * compares the stored file bytes: identical is 200, different content under the
 * same id is 409. An engine refusal is 422 with every problem listed in
 * detail.problems. Studio shows what is served and adds no figure.
 */
import type { BalancePlan } from "@alm/engine";
import type { PlatformContext } from "../../context";
import {
  deriveBalancePlanFromStore,
  derivedBalancePlanMeta,
  parseBalanceDeriveBody,
} from "../../derivedSets/derivedBalancePlans";
import { serializeDocument, sha256Hex } from "../../store/store";
import { conflict } from "../errors";
import type { Router } from "../router";

export function registerDerivedBalancePlanRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("POST", "/api/balance-plans/derive/preview", (req) => {
    const { plan, changes, rules } = deriveBalancePlanFromStore(store, parseBalanceDeriveBody(req.json<unknown>()));
    return { kind: "json", value: { plan, changes, rules } };
  });

  router.add("POST", "/api/balance-plans/derive", (req) => {
    const parsed = parseBalanceDeriveBody(req.json<unknown>());
    const { plan, changes, rules } = deriveBalancePlanFromStore(store, parsed);
    if (store.has("plans", plan.id)) {
      const meta = store.getMeta("plans", plan.id);
      if (meta.contentHash === sha256Hex(serializeDocument(plan))) {
        const stored = store.getDocument<BalancePlan>("plans", plan.id).doc;
        return { kind: "json", status: 200, value: { outcome: "unchanged", plan: stored, changes, rules } };
      }
      throw conflict(
        `balance plan "${plan.id}" already exists with different content (the store is append-only); save it under a new id`,
      );
    }
    store.putDocument("plans", plan.id, plan, derivedBalancePlanMeta(plan, parsed.bookId));
    return { kind: "json", status: 201, value: { outcome: "created", plan, changes, rules } };
  });
}
