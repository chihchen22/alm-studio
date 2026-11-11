// apps/studio/src/market/marketCurve.ts
/**
 * Which base curve a stored market builds, in words. A market with a
 * curveSetup block builds that setup. With none, an unmarked market builds platform default v2, log-linear on discount
 * factor, from its own quotes; a market marked `curveDefault: 1` (set by a seed only) builds platform
 * default v1, linear in zero; a market whose quotes v2 cannot take falls back to v1 with a reason.
 *
 * The server judges this, not the Studio: GET /api/market/:id/curve-default answers with the stamp the engine's
 * curveDefaultStampOf gives (the function a run's provenance stamp uses), and this module only words it. The base
 * text ("platform default v2, log-linear on discount factor", "platform default v1, linear in zero", "setup <label>
 * (<id>)") matches the server's curve line (apps/server/src/export/curveLine.ts); the suffixes "(this market is pinned
 * to it)" and "not read: ..." are the Studio's own. Types only from the reader; nothing here runs engine code.
 */
import type { MarketCurveReply, MarketCurveStamp } from "@alm/reader";

export const CURVE_DEFAULT_V2_TEXT = "platform default v2, log-linear on discount factor";
export const CURVE_DEFAULT_V1_TEXT = "platform default v1, linear in zero";

export type MarketCurveRead =
  | { kind: "setup"; id: string; label?: string }
  | { kind: "default"; version: 2 }
  | { kind: "default"; version: 1; reason?: string }
  | { kind: "problem"; problem: string };

/** One side of the server's reply as a read: a refusal is a problem in the server's words. */
export function readOfStamp(s: MarketCurveStamp): MarketCurveRead {
  if (s.kind === "refused") return { kind: "problem", problem: s.reason };
  if (s.kind === "setup") return "label" in s && typeof s.label === "string" && s.label !== "" ? { kind: "setup", id: s.id, label: s.label } : { kind: "setup", id: s.id };
  if (s.version === 2) return { kind: "default", version: 2 };
  return s.reason === undefined ? { kind: "default", version: 1 } : { kind: "default", version: 1, reason: s.reason };
}

/** The base curve a stored market builds: its setup when it carries one, else its default. */
export function marketCurveOf(reply: MarketCurveReply): MarketCurveRead {
  return readOfStamp(reply.builds);
}

/**
 * The default a stored market builds with no setup on it: what "Use the platform default curve" returns a workspace
 * to, and what a derived curve's estimate on platform-default reads.
 */
export function marketDefaultOf(reply: MarketCurveReply): MarketCurveRead {
  return readOfStamp(reply.default);
}

/** The read in words, for example "platform default v2, log-linear on discount factor". */
export function marketCurveText(r: MarketCurveRead): string {
  switch (r.kind) {
    case "setup":
      return r.label !== undefined && r.label !== r.id ? `setup ${r.label} (${r.id})` : `setup ${r.id}`;
    case "problem":
      return `not read: ${r.problem}`;
    default:
      if (r.version === 2) return CURVE_DEFAULT_V2_TEXT;
      return r.reason === undefined ? `${CURVE_DEFAULT_V1_TEXT} (this market is pinned to it)` : `${CURVE_DEFAULT_V1_TEXT} (fallback: ${r.reason})`;
  }
}

/** One sentence on the default a market builds (marketDefaultOf), for the Curve setups page. */
export function marketDefaultSentence(r: MarketCurveRead): string {
  if (r.kind === "problem") return `Which default this market builds could not be read: ${r.problem}`;
  if (r.kind === "setup") return `This market builds ${marketCurveText(r)}.`;
  if (r.version === 2) return `This market builds ${CURVE_DEFAULT_V2_TEXT}, from its own quotes.`;
  if (r.reason === undefined) return `This market builds ${CURVE_DEFAULT_V1_TEXT}: it is pinned to the older default.`;
  return `This market builds ${CURVE_DEFAULT_V1_TEXT}: platform default v2 cannot take its quotes (${r.reason}).`;
}

/** The button that returns a workspace to the platform default, naming the version the market builds when it is known. */
export function defaultButtonText(r: MarketCurveRead | null): string {
  return r !== null && r.kind === "default" ? `Use the platform default curve (v${r.version})` : "Use the platform default curve";
}
