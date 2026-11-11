/**
 * Derived markets (server side; Piece 7a adds the rate index
 * ops). The derivation itself is the engine's pure function deriveMarketSnapshot; this module only parses the
 * request body, reads the base market from the store, and carries the engine's
 * refusal across as a 422 with every problem listed. Nothing here computes a
 * spread, so the seed, the route and the tests share one implementation and the
 * bytes agree by construction.
 */
import type { MarketSnapshot } from "@alm/kernel";
import {
  MarketDerivationError,
  deriveMarketSnapshot,
  isShortRateVolOp,
  type MarketDeriveResult,
} from "@alm/engine/src/market";
import { unprocessable } from "../http/errors";
import { assertValidId } from "../store/paths";
import type { FileStore } from "../store/store";

/**
 * ops is a list of TLP ops (add, scale), rate index ops (set-index,
 * add-index-basis) and short-rate volatility ops (scale-short-rate-vol,
 * add-short-rate-vol); this module only checks that it is a list, and the engine
 * judges every op.
 */
export const MARKET_DERIVE_USAGE = "POST /api/market/derive takes { baseId, ops, id?, label? }";
const BODY_KEYS: ReadonlySet<string> = new Set(["baseId", "ops", "id", "label"]);

export interface MarketDeriveBody {
  baseId: string;
  ops: unknown[];
  id?: string;
  label?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and shape-check a derive request body. The ops themselves are judged by the engine. */
export function parseMarketDeriveBody(body: unknown): MarketDeriveBody {
  if (!isPlainObject(body)) throw unprocessable(MARKET_DERIVE_USAGE);
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.has(k)) {
      throw unprocessable(`unknown field ${JSON.stringify(k)} in the request body; send { baseId, ops, id?, label? }`);
    }
  }
  if (typeof body.baseId !== "string") throw unprocessable(MARKET_DERIVE_USAGE);
  if (!Array.isArray(body.ops)) throw unprocessable(MARKET_DERIVE_USAGE);
  if (body.id !== undefined && typeof body.id !== "string") throw unprocessable(MARKET_DERIVE_USAGE);
  if (body.label !== undefined && typeof body.label !== "string") throw unprocessable(MARKET_DERIVE_USAGE);
  const out: MarketDeriveBody = { baseId: body.baseId, ops: body.ops };
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

/** The store meta a derived market carries beside its document. The label lives here, not in the document. */
export function derivedMarketMeta(result: MarketDeriveResult): Record<string, unknown> {
  const from = result.snapshot.derivedFrom;
  if (from === undefined) throw new Error(`market "${result.id}" carries no derivedFrom`);
  return {
    label: result.label,
    derivedFromMarketId: from.baseId,
    derivedOpCount: from.ops.length,
  };
}

/**
 * Read the base market from the store and derive; an engine refusal becomes a 422 listing every problem. The engine checks an index history id's shape only, so every `historyId` the derived
 * block names must also be in the store (one problem per index, in block order). The derive and preview routes and
 * the roll-forward re-apply all go through here, so a re-applied market whose history is still stored applies.
 */
export function deriveMarketFromStore(store: FileStore, body: MarketDeriveBody): MarketDeriveResult {
  const baseId = assertValidId(body.baseId);
  const base = store.getDocument<MarketSnapshot>("market", baseId).doc;
  let result: MarketDeriveResult;
  try {
    result = deriveMarketSnapshot(base, body.ops, {
      baseId,
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
    });
  } catch (err) {
    if (err instanceof MarketDerivationError) throw unprocessable(err.message, { problems: err.problems });
    throw err;
  }
  // Every refusal names both ways out, since the Studio and re-apply replay carried ops, so an id that came from an
  // earlier derive arrives as an op (B3b follow-up item 5, option B; fix round 1). An id the base market itself carries
  // on the same index also says it came from the base. The refusal is unchanged: the check reads the whole derive
  // result. The id hashes the whole document, so only the same file under the same file name, unit and label restores it.
  const remedy =
    "clear the history (Clear the history on Market > Rate indices, a set-index-history op with historyId null), " +
    "or import the history on Market > Rate indices; an import restores this id only from the same file under the same file name, unit and label";
  const baseHistory = new Map(((base as { rateIndices?: Array<{ id: string; historyId?: string }> }).rateIndices ?? []).map((r) => [r.id, r.historyId]));
  const unknown = (result.snapshot.rateIndices ?? [])
    .filter((r) => r.historyId !== undefined && !store.has("index-histories", r.historyId))
    .map((r) => ({
      at: "rateIndices",
      message:
        baseHistory.get(r.id) === r.historyId
          ? `rate index ${JSON.stringify(r.id)} carries index history ${JSON.stringify(r.historyId)}, which is not in the store; the id comes from the base market ${JSON.stringify(baseId)}, ` +
            `so every derive on it is refused until the index stops naming it: ${remedy}`
          : `rate index ${JSON.stringify(r.id)} names index history ${JSON.stringify(r.historyId)}, which is not in the store; ${remedy}`,
    }));
  if (unknown.length > 0) {
    throw unprocessable(`derived market refused: ${unknown.length} problem(s); every problem is listed: ${unknown.map((p) => p.message).join("; ")}`, { problems: unknown });
  }
  return result;
}

/**
 * Where a short-rate volatility shock sits in a market's lineage.
 * "shocked": linkId is the first market, walking from the run's market back
 * through derivedFrom.baseId, whose own derivedFrom ops hold a volatility op,
 * and baseId is the base that link was derived from. "broken": the walk reached
 * a base that is not in the store (or a cycle), so the platform cannot confirm
 * the lineage carries no shock; linkId is the last market read.
 */
export type ShortRateVolShockLineage =
  | { kind: "none" }
  | { kind: "shocked"; linkId: string; baseId: string }
  | { kind: "broken"; linkId: string; missingBaseId: string };

const derivedFromOf = (doc: unknown): { baseId: string; ops: unknown[] } | undefined => {
  if (!isPlainObject(doc) || !isPlainObject(doc.derivedFrom)) return undefined;
  const { baseId, ops } = doc.derivedFrom;
  if (typeof baseId !== "string") return undefined;
  return { baseId, ops: Array.isArray(ops) ? ops : [] };
};

/**
 * Walk a market's derivedFrom chain through the store and report whether any
 * link applied a short-rate volatility op. The immediate record alone misses a
 * chain such as a funding spread shock derived from a volatility-shocked
 * market, so the route walks every link. The walk keeps a visited set, and a
 * cycle reports "broken".
 */
export function shortRateVolShockLineage(store: FileStore, marketId: string, market: unknown): ShortRateVolShockLineage {
  const visited = new Set<string>([marketId]);
  let linkId = marketId;
  let doc: unknown = market;
  for (;;) {
    const from = derivedFromOf(doc);
    if (from === undefined) return { kind: "none" };
    if (from.ops.some(isShortRateVolOp)) return { kind: "shocked", linkId, baseId: from.baseId };
    if (visited.has(from.baseId) || !store.has("market", from.baseId)) {
      return { kind: "broken", linkId, missingBaseId: from.baseId };
    }
    visited.add(from.baseId);
    linkId = from.baseId;
    doc = store.getDocument<unknown>("market", from.baseId).doc;
  }
}
