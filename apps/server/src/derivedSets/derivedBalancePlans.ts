/**
 * Derived balance plans (server side). The derivation itself is
 * the engine's pure function deriveBalancePlan; this module only parses the
 * request body, reads the base plan and the book from the store, and carries the
 * engine's refusal across as a 422 with every problem listed. Nothing here
 * computes a balance, so the seed, the route and the tests share one
 * implementation and the bytes agree by construction.
 */
import type { BalanceKnotChange, BalancePlan, NewBusinessRule, PortfolioSpec } from "@alm/engine";
import { BalancePlanDerivationError, deriveBalancePlan } from "@alm/engine/src/plan";
import { unprocessable } from "../http/errors";
import { assertValidId } from "../store/paths";
import type { FileStore } from "../store/store";

export const BALANCE_DERIVE_USAGE = "POST /api/balance-plans/derive takes { baseId, bookId, ops, id?, label? }";
const BODY_KEYS: ReadonlySet<string> = new Set(["baseId", "bookId", "ops", "id", "label"]);

export interface BalanceDeriveBody {
  baseId: string;
  bookId: string;
  ops: unknown[];
  id?: string;
  label?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and shape-check a derive request body. The ops themselves are judged by the engine. */
export function parseBalanceDeriveBody(body: unknown): BalanceDeriveBody {
  if (!isPlainObject(body)) throw unprocessable(BALANCE_DERIVE_USAGE);
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.has(k)) {
      throw unprocessable(`unknown field ${JSON.stringify(k)} in the request body; send { baseId, bookId, ops, id?, label? }`);
    }
  }
  if (typeof body.baseId !== "string") throw unprocessable(BALANCE_DERIVE_USAGE);
  if (typeof body.bookId !== "string") throw unprocessable(BALANCE_DERIVE_USAGE);
  if (!Array.isArray(body.ops)) throw unprocessable(BALANCE_DERIVE_USAGE);
  if (body.id !== undefined && typeof body.id !== "string") throw unprocessable(BALANCE_DERIVE_USAGE);
  if (body.label !== undefined && typeof body.label !== "string") throw unprocessable(BALANCE_DERIVE_USAGE);
  const out: BalanceDeriveBody = { baseId: body.baseId, bookId: body.bookId, ops: body.ops };
  if (body.id !== undefined) {
    assertValidId(body.id);
    if (body.id.startsWith("derived-")) {
      throw unprocessable("ids starting derived- are reserved for the derived id; leave id empty to get it");
    }
    out.id = body.id;
  }
  if (body.label !== undefined) out.label = body.label;
  return out;
}

/** The store meta a derived balance plan carries beside its document. */
export function derivedBalancePlanMeta(plan: BalancePlan, bookId: string): Record<string, unknown> {
  const from = plan.derivedFrom;
  if (from === undefined) throw new Error(`balance plan "${plan.id}" carries no derivedFrom`);
  return {
    label: plan.label,
    asOf: plan.asOf,
    targetCount: plan.targets.length,
    derivedFromPlanId: from.baseId,
    derivedOpCount: from.ops.length,
    checkedBookId: bookId,
  };
}

/** Read the base plan and the book from the store and derive; an engine refusal becomes a 422 listing every problem. */
export function deriveBalancePlanFromStore(
  store: FileStore,
  body: BalanceDeriveBody,
): { plan: BalancePlan; changes: BalanceKnotChange[]; rules: NewBusinessRule[] } {
  const base = store.getDocument<BalancePlan>("plans", assertValidId(body.baseId)).doc;
  const book = store.getDocument<PortfolioSpec>("portfolios", assertValidId(body.bookId)).doc;
  try {
    return deriveBalancePlan(base, body.ops, {
      book,
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
    });
  } catch (err) {
    if (err instanceof BalancePlanDerivationError) throw unprocessable(err.message, { problems: err.problems });
    throw err;
  }
}
