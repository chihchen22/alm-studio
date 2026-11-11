/**
 * Derived assumption sets (server side). The derivation itself
 * is the engine's pure function deriveAssumptionSet; this module only parses
 * the request body, reads the base from the store and carries the engine's
 * refusal across as a 422 with every problem listed. Nothing here computes a
 * parameter value, so the seed, the route and the tests share one
 * implementation and the bytes agree by construction.
 */
import type { AssumptionSet, DerivationChange } from "@alm/engine";
import { AssumptionDerivationError, deriveAssumptionSet } from "@alm/engine/src/scenario";
import { unprocessable } from "../http/errors";
import { assertValidId } from "../store/paths";
import type { FileStore } from "../store/store";

export const DERIVE_USAGE = "POST /api/assumption-sets/derive takes { baseId, ops, id?, label? }";
const BODY_KEYS: ReadonlySet<string> = new Set(["baseId", "ops", "id", "label"]);

export interface DeriveBody {
  baseId: string;
  ops: unknown[];
  id?: string;
  label?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and shape-check a derive request body. The ops themselves are judged by the engine. */
export function parseDeriveBody(body: unknown): DeriveBody {
  if (!isPlainObject(body)) throw unprocessable(DERIVE_USAGE);
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.has(k)) {
      throw unprocessable(`unknown field ${JSON.stringify(k)} in the request body; send { baseId, ops, id?, label? }`);
    }
  }
  if (typeof body.baseId !== "string") throw unprocessable(DERIVE_USAGE);
  if (!Array.isArray(body.ops)) throw unprocessable(DERIVE_USAGE);
  if (body.id !== undefined && typeof body.id !== "string") throw unprocessable(DERIVE_USAGE);
  if (body.label !== undefined && typeof body.label !== "string") throw unprocessable(DERIVE_USAGE);
  const out: DeriveBody = { baseId: body.baseId, ops: body.ops };
  if (body.id !== undefined) {
    assertValidId(body.id);
    if (body.id.startsWith("stack-")) throw unprocessable("ids starting stack- are reserved for assumption stacks");
    if (body.id.startsWith("derived-")) {
      throw unprocessable("ids starting derived- are reserved for the derived id; leave id empty to get it");
    }
    out.id = body.id;
  }
  if (body.label !== undefined) out.label = body.label;
  return out;
}

/** The store meta a derived set carries beside its document. */
export function derivedSetMeta(set: AssumptionSet): Record<string, unknown> {
  const from = set.derivedFrom;
  if (from === undefined) throw new Error(`assumption set "${set.id}" carries no derivedFrom`);
  return {
    label: set.label,
    /** The engine's own hash over bindings (distinct from the file hash). */
    bindingsContentHash: set.contentHash,
    bindingCount: set.bindings.length,
    derivedFromSetId: from.baseId,
    derivedOpCount: from.ops.length,
  };
}

/** Read the base from the store and derive; an engine refusal becomes a 422 listing every problem. */
export function deriveFromStore(store: FileStore, body: DeriveBody): { set: AssumptionSet; changes: DerivationChange[] } {
  const base = store.getDocument<AssumptionSet>("assumption-sets", assertValidId(body.baseId)).doc;
  try {
    return deriveAssumptionSet(base, body.ops, {
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
    });
  } catch (err) {
    if (err instanceof AssumptionDerivationError) throw unprocessable(err.message, { problems: err.problems });
    throw err;
  }
}
