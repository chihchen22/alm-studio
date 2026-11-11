/**
 * Market loader: six parallel reads (the snapshot list, the snapshot, the
 * benchmark curve series across snapshots, the snapshot's lineage, the base
 * zero curve the engine builds from the snapshot (the platform default curve, or
 * the snapshot's curve setup), through the shock preview route with a base rate
 * spec, and the server's name for that base curve, GET /api/market/:id/curve-default:
 * platform default v2, log-linear on discount factor, for an unmarked market, v1,
 * linear in zero, for a market pinned to it, or the setup it carries
 * (market/marketCurve.ts words it). The vol grids are
 * the reader's capGrid and swaptionGrid (stored decimal normal vol times
 * VOL_TO_BP); curve points are copied and ordered, never interpolated. The
 * zero curve read and the curve name read each degrade alone: a failure
 * leaves the rest of the model whole.
 */
import type { CurveNodes } from "@alm/engine";
import {
  capGrid,
  getCatalogCurveSeries,
  getCatalogLineage,
  getCatalogMarketSnapshot,
  getMarketCurve,
  listCatalogMarkets,
  previewShock,
  swaptionGrid,
  type CatalogCurveSeries,
  type CatalogLineage,
  type CatalogMarketListItem,
  type CatalogMarketSnapshot,
  type VolGrid,
} from "@alm/reader";
import { errText } from "../../errText";
import { curveLines, type CurveLine } from "../../rows/marketRows";
import { marketCurveOf, type MarketCurveRead } from "../../market/marketCurve";

export interface MarketModel {
  marketId: string; asOf: string | null; contentHash: string; markets: CatalogMarketListItem[];
  curves: CurveLine[]; cap: VolGrid; swaption: VolGrid;
  lineage: CatalogLineage; history: CatalogCurveSeries;
  /** The snapshot as the catalog served it: the harness instances are readings of it. */
  snapshot: CatalogMarketSnapshot;
  /** The base zero curve at its own nodes (zero rate and discount factor); null when that read failed, with the reason in baseNote. */
  base: CurveNodes | null;
  baseNote: string | null;
  /** Which curve the base is: the setup the snapshot carries, else its default; a problem when GET /api/market/:id/curve-default failed. */
  baseCurve: MarketCurveRead;
}

/** The request path of the server's name for the snapshot's base curve. For the source lines. */
export function marketCurveRoute(marketId: string): string {
  return `/api/market/${encodeURIComponent(marketId)}/curve-default`;
}

/** The request path of the snapshot, encoded as the reader sends it. For the source lines. */
export function snapshotRoute(marketId: string): string {
  return `/api/catalog/markets/${encodeURIComponent(marketId)}`;
}

/** The request path of the snapshot's lineage, encoded as the reader sends it. For the source lines. */
export function lineageRoute(marketId: string): string {
  return `/api/catalog/lineage/market/${encodeURIComponent(marketId)}`;
}

export const HISTORY_ROUTE = "/api/catalog/curves/risk-free/series";

/** The route that builds the base zero curve of a stored snapshot (POST, base rate spec, nothing shocked). */
export const BASE_CURVE_ROUTE = "/api/scenarios/preview";

export async function loadMarket(marketId: string): Promise<MarketModel> {
  const [markets, snap, history, lineage, zero, baseCurve] = await Promise.all([
    listCatalogMarkets(),
    getCatalogMarketSnapshot(marketId),
    getCatalogCurveSeries("risk-free"),
    getCatalogLineage("market", marketId),
    previewShock(marketId, { kind: "base" }).then(
      (r) => ({ base: r.base as CurveNodes | null, baseNote: null as string | null }),
      (e: unknown) => ({ base: null as CurveNodes | null, baseNote: errText(e) as string | null }),
    ),
    getMarketCurve(marketId).then(marketCurveOf, (e: unknown): MarketCurveRead => ({ kind: "problem", problem: errText(e) })),
  ]);
  return {
    marketId: snap.id,
    asOf: snap.asOf,
    contentHash: snap.contentHash,
    markets,
    curves: curveLines(snap),
    cap: capGrid(snap.capVolSurface),
    swaption: swaptionGrid(snap.swaptionVolSurface),
    lineage,
    history,
    snapshot: snap,
    base: zero.base,
    baseNote: zero.baseNote,
    baseCurve,
  };
}
