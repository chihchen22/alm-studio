/**
 * Saved curve setups on the market block (plan Task 8): the document id rule, the
 * active pointer, and the launch pin. The route (http/routes/curveSetups.ts), the setup compile and
 * readiness share this file, so the three agree on what "the active setup" and "the pinned market" are.
 *
 *   curveSetupIdOf          `cs-<16 hex of contentHash(validated block)>`: identical content, same document
 *   activeCurveSetupOf      the active pointer and the slot document it names, read from the head only
 *   readActiveCurveSetup    the active document from the store: a pointer to a missing document, or to
 *                           anything that is not a `curve-setups` document, is refused with
 *                           `The active curve setup <id> is not in the store.` and never falls back
 *   curvePinOf              the market a launch runs on: the resolved market plus one `set-curve-setup`
 *                           op, by the engine's own derive (content-addressed `derived-mk-<12 hex>`, the
 *                           reapply.ts pattern), or null when that market already carries the setup
 *   buildBaseCurveNamed     buildBaseCurve with every throw a 422 whose prefix names the route that refused
 *                           (the engine's thrown text has no context): a curveDefault marker value other than 1
 *                           `The curveDefault marker on this market: `, a market's curveSetup block
 *                           `The curve setup on this market: `, a market marked `curveDefault: 1`
 *                           `Curve default version 1 (the kernel bootstrap) on this market: `, and an unmarked
 *                           market with no block `The platform default curve on this market: `
 */
import { buildCurveFromSetup, CurveBuildError, validateCurveSetup, type CurveSetupBlock, type MarketWithCurveSetup } from "@alm/engine";
import { deriveMarketSnapshot, MarketDerivationError, type MarketDeriveResult } from "@alm/engine/src/market";
import { canonicalize, contentHash } from "@alm/engine/src/runtime/contentHash";
import { buildBaseCurve } from "@alm/engine/src/scenario";
import type { MarketSnapshot, ZeroCurve } from "@alm/kernel";
import { conflict, unprocessable } from "../http/errors";
import { NotFoundError, sha256Hex, type FileStore } from "../store/store";
import type { DocRef, MarketBlock } from "./types";

/** The prefix every engine refusal of a market's curve setup carries on a readiness item or a 422. */
export const CURVE_SETUP_ON_MARKET = "The curve setup on this market: ";

/** The prefix every refusal of an unmarked no-setup market's base curve carries on a readiness item or a 422. */
export const CURVE_DEFAULT_ON_MARKET = "The platform default curve on this market: ";

/** The prefix a refused build of a market marked `curveDefault: 1` with no curveSetup block carries. */
export const CURVE_DEFAULT_V1_ON_MARKET = "Curve default version 1 (the kernel bootstrap) on this market: ";

/** The prefix the engine's refusal of a curveDefault marker value other than 1 carries, block or none. */
export const CURVE_DEFAULT_MARKER_ON_MARKET = "The curveDefault marker on this market: ";

/** The readiness and compile sentence for an active pointer that resolves to no curve setup document. */
export function missingActiveCurveSetup(id: string): string {
  return `The active curve setup ${id} is not in the store.`;
}

/** The document id of a validated block: the canonical bytes decide it. */
export function curveSetupIdOf(block: CurveSetupBlock): string {
  return `cs-${contentHash(block).slice(0, 16)}`;
}

/** The active pointer and the slot document it names (null when no slot holds it); null when none is active. No store read. */
export function activeCurveSetupOf(market: MarketBlock): { id: string; ref: DocRef | null } | null {
  const cs = market.curveSetups;
  if (cs === undefined || cs.active === undefined) return null;
  const slot = cs.setups.find((s) => s.current.id === cs.active);
  return { id: cs.active, ref: slot?.current ?? null };
}

/**
 * The active setup's document, read as stored bytes. Null when no setup is active. A pointer whose
 * document is missing, or is not a `curve-setups` document, is a 422 with the missing sentence; bytes
 * that no longer hash to the slot's pin are a 409 (the pin rule of the setup compile); a stored block the
 * validator refuses is a 422 carrying the validator's sentences.
 */
export function readActiveCurveSetup(store: FileStore, market: MarketBlock): { ref: DocRef; block: CurveSetupBlock } | null {
  const active = activeCurveSetupOf(market);
  if (active === null) return null;
  const gone = () => unprocessable(missingActiveCurveSetup(active.id), { field: "market.curveSetups.active" });
  const ref = active.ref;
  if (ref === null || ref.collection !== "curve-setups") throw gone();
  let bytes: Buffer;
  try {
    bytes = store.getDocumentBytes("curve-setups", ref.id);
  } catch (err) {
    if (err instanceof NotFoundError) throw gone();
    throw err;
  }
  const actual = sha256Hex(bytes);
  if (actual !== ref.contentHash) throw conflict(`pin curveSetup "${ref.id}" moved: head pins ${ref.contentHash}, bytes hash ${actual}`);
  const checked = validateCurveSetup(JSON.parse(bytes.toString("utf8")) as unknown);
  if (!checked.ok) {
    throw unprocessable(`The active curve setup ${ref.id} is not a readable curve setup: ${checked.refusals.join("; ")}`, { refusals: checked.refusals });
  }
  return { ref, block: checked.block };
}

/** The builder's refusals for a validated block, or none when it builds. */
export function buildRefusalsOf(block: CurveSetupBlock): string[] {
  try {
    buildCurveFromSetup(block);
    return [];
  } catch (err) {
    if (err instanceof CurveBuildError) return err.refusals;
    throw err;
  }
}

/**
 * The market a launch runs on under the active setup: the resolved market (base or already derived)
 * with one `set-curve-setup` op, derived by the engine with no id, so the id is content-addressed and a
 * re-launch of the same setup on the same market is the same document. Null when the market already
 * carries exactly this block (the derive would refuse it as a no-op). An engine refusal is a 422 with
 * the named prefix. Pure: nothing is stored here.
 */
export function curvePinOf(base: MarketSnapshot, baseId: string, block: CurveSetupBlock): MarketDeriveResult | null {
  const carried = (base as MarketWithCurveSetup).curveSetup;
  if (carried !== undefined && canonicalize(carried) === canonicalize(block)) return null;
  try {
    return deriveMarketSnapshot(base, [{ op: "set-curve-setup", setup: block }], { baseId });
  } catch (err) {
    if (err instanceof MarketDerivationError) {
      throw unprocessable(`${CURVE_SETUP_ON_MARKET}${err.problems.map((p) => p.message).join("; ")}`, { problems: err.problems });
    }
    throw err;
  }
}

/**
 * The prefix of a refused buildBaseCurve, by the route that applies. The engine refuses a
 * marker value other than 1 before it reads anything else, so a bad marker is named as the marker's fault
 * even on a market that also carries a block; then a block wins over a valid marker. The marker test here
 * only picks the words; the engine's sentence is the authority on what is refused.
 */
function curvePrefixOf(snapshot: MarketSnapshot): string {
  const m = snapshot as MarketWithCurveSetup;
  const marker: unknown = m.curveDefault;
  if (marker !== undefined && marker !== 1) return CURVE_DEFAULT_MARKER_ON_MARKET;
  if (m.curveSetup !== undefined) return CURVE_SETUP_ON_MARKET;
  return marker === 1 ? CURVE_DEFAULT_V1_ON_MARKET : CURVE_DEFAULT_ON_MARKET;
}

/**
 * buildBaseCurve for a surface outside the run (readiness, the scenario preview). Every throw of the
 * build is a 422, never a 500, carrying the engine's message after the prefix of the
 * route that refused (curvePrefixOf): CURVE_DEFAULT_MARKER_ON_MARKET, CURVE_SETUP_ON_MARKET,
 * CURVE_DEFAULT_V1_ON_MARKET or CURVE_DEFAULT_ON_MARKET.
 */
export function buildBaseCurveNamed(snapshot: MarketSnapshot): ZeroCurve {
  const prefix = curvePrefixOf(snapshot);
  try {
    return buildBaseCurve(snapshot);
  } catch (err) {
    throw unprocessable(`${prefix}${err instanceof Error ? err.message : String(err)}`);
  }
}
