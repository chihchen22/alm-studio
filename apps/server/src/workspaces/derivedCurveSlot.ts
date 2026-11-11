/**
 * Saved derived curves on the market block (plan Task 6): the document id rule, the
 * slot read, the curves a market's indices name, and the launch pin that carries them into the run's
 * market beside the active curve setup. The route (http/routes/derivedCurves.ts), the setup compile and
 * readiness share this file, so the three agree on which curves a launch pins and on the pinned market.
 *
 *   derivedCurveIdOf     `dc-<16 hex of contentHash(validated block)>`: identical content, same document
 *   namedCurveIdsOf      the derived curve ids the indices of a market name, distinct and sorted
 *   readDerivedCurve     the slot document a curve id names, read as stored bytes: null when no slot
 *                        holds that id (the engine's run check then names the index and the curve), a
 *                        422 when the slot's document is not in the store or is not a readable curve, a
 *                        409 when its bytes no longer hash to the slot's pin; it never falls back
 *   marketPinOf          the market a launch runs on: the resolved market plus one `set-curve-setup` op
 *                        (when a setup is active) and one `set-derived-curve` op per pinned curve, in ONE
 *                        derive (content-addressed `derived-mk-<12 hex>`), or null when the market
 *                        already carries all of it. With no curve it is exactly curvePinOf, so
 *                        a workspace whose market names no derived curve pins the same bytes as before.
 */
import { validateDerivedCurve, type CurveSetupBlock, type DerivedCurveBlock, type MarketWithCurveSetup, type MarketWithDerivedCurves } from "@alm/engine";
import { deriveMarketSnapshot, MarketDerivationError, type MarketDeriveResult } from "@alm/engine/src/market";
import { canonicalize, contentHash } from "@alm/engine/src/runtime/contentHash";
import type { MarketSnapshot } from "@alm/kernel";
import { conflict, unprocessable } from "../http/errors";
import { NotFoundError, sha256Hex, type FileStore } from "../store/store";
import { curvePinOf } from "./curveSetupSlot";
import type { DocRef, MarketBlock } from "./types";

/** The prefix every engine refusal of a pin with derived curves carries on a readiness item or a 422. */
export function pinRefusalPrefix(withSetup: boolean): string {
  return withSetup ? "The curve setup and derived curves on this market: " : "The derived curves on this market: ";
}

/** The document id of a validated block: the canonical bytes decide it. */
export function derivedCurveIdOf(block: DerivedCurveBlock): string {
  return `dc-${contentHash(block).slice(0, 16)}`;
}

/** The derived curve ids the market's indices name by `spreadCurve`, distinct and sorted. Tolerant: a malformed block names none. */
export function namedCurveIdsOf(market: MarketSnapshot): string[] {
  const block = (market as { rateIndices?: unknown }).rateIndices;
  if (!Array.isArray(block)) return [];
  const ids = new Set<string>();
  for (const entry of block as unknown[]) {
    const curve = entry !== null && typeof entry === "object" ? (entry as { spreadCurve?: unknown }).spreadCurve : undefined;
    if (typeof curve === "string") ids.add(curve);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The slot pin a curve id names (the slot's lineage key is the curve's own id), or null when no slot holds it. No store read. */
export function derivedCurveRefOf(market: MarketBlock, curveId: string): DocRef | null {
  return market.derivedCurves?.curves.find((c) => c.lineageKey === curveId)?.current ?? null;
}

/** The sentence for a slot whose document is gone (or is not a derived curve document). */
export function missingDerivedCurve(curveId: string, docId: string): string {
  return `The derived curve "${curveId}" (${docId}) is not in the store.`;
}

/**
 * The derived curve a slot names, read as stored bytes. Null when no slot holds `curveId`. A slot whose
 * document is missing is a 422 with the missing sentence, bytes that no longer hash to the pin a 409, a
 * stored block the validator refuses a 422 with its sentences.
 */
export function readDerivedCurve(store: FileStore, market: MarketBlock, curveId: string): { ref: DocRef; block: DerivedCurveBlock } | null {
  const ref = derivedCurveRefOf(market, curveId);
  if (ref === null) return null;
  const gone = () => unprocessable(missingDerivedCurve(curveId, ref.id), { field: "market.derivedCurves" });
  if (ref.collection !== "derived-curves") throw gone();
  let bytes: Buffer;
  try {
    bytes = store.getDocumentBytes("derived-curves", ref.id);
  } catch (err) {
    if (err instanceof NotFoundError) throw gone();
    throw err;
  }
  const actual = sha256Hex(bytes);
  if (actual !== ref.contentHash) throw conflict(`pin derivedCurve "${ref.id}" moved: head pins ${ref.contentHash}, bytes hash ${actual}`);
  const checked = validateDerivedCurve(JSON.parse(bytes.toString("utf8")) as unknown);
  if (!checked.ok) {
    throw unprocessable(`The derived curve "${curveId}" (${ref.id}) is not a readable derived curve: ${checked.refusals.join("; ")}`, { refusals: checked.refusals });
  }
  return { ref, block: checked.block };
}

/**
 * The market a launch runs on: `base` plus the active setup (null when none) and the saved curves its
 * indices name, in one derive with no id. A curve the market already carries byte for byte, like a setup
 * it already carries, adds no op; null when no op is left. An engine refusal is a 422 with the named
 * prefix. Pure: nothing is stored here.
 */
export function marketPinOf(
  base: MarketSnapshot,
  baseId: string,
  setup: CurveSetupBlock | null,
  curves: readonly DerivedCurveBlock[],
): MarketDeriveResult | null {
  if (curves.length === 0) return setup === null ? null : curvePinOf(base, baseId, setup);
  const ops: unknown[] = [];
  const carriedSetup = (base as MarketWithCurveSetup).curveSetup;
  if (setup !== null && (carriedSetup === undefined || canonicalize(carriedSetup) !== canonicalize(setup))) {
    ops.push({ op: "set-curve-setup", setup });
  }
  const carriedCurves = (base as MarketWithDerivedCurves).derivedCurves ?? [];
  for (const curve of curves) {
    const held = carriedCurves.find((c) => c.id === curve.id);
    if (held === undefined || canonicalize(held) !== canonicalize(curve)) ops.push({ op: "set-derived-curve", curve });
  }
  if (ops.length === 0) return null;
  try {
    return deriveMarketSnapshot(base, ops, { baseId });
  } catch (err) {
    if (err instanceof MarketDerivationError) {
      throw unprocessable(`${pinRefusalPrefix(setup !== null)}${err.problems.map((p) => p.message).join("; ")}`, { problems: err.problems });
    }
    throw err;
  }
}
