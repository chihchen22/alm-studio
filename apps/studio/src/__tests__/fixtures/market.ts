/**
 * Hand-typed minimal route bodies for the Market reconciliation test. Only the fields the loader reads. The rates and
 * vols are copied from the public pack (`packages/kernel/public/market_public.json`) at the same tenors and grid points:
 * Treasury CMT quotes, the constructed term-funding quotes, the hand-specified TLP schedule and the constructed
 * illustrative vol blocks. Instrument types are structural only. The 2025-12-31 series is round illustrative numbers.
 */
import type { CatalogCurveSeries, CatalogLineage, CatalogMarketListItem, CatalogMarketSnapshot } from "@alm/reader";

export const MARKETS: CatalogMarketListItem[] = [
  { id: "market-public-2026-03-31", contentHash: "hash-q1", ingestedAt: "2026-09-23T00:00:00Z", asOf: "2026-03-31", curvePoints: 9, capVolPoints: 4, swaptionVolPoints: 4 },
  { id: "market-2025-12-31", contentHash: "hash-q4", ingestedAt: "2026-09-22T00:00:00Z", asOf: "2025-12-31", curvePoints: 9, capVolPoints: 4, swaptionVolPoints: 4 },
];

// Points deliberately out of tYears order in risk-free, so the ordering is exercised.
export const SNAP: CatalogMarketSnapshot = {
  id: "market-public-2026-03-31",
  contentHash: "hash-q1",
  asOf: "2026-03-31",
  curves: {
    "risk-free": [
      { term: "1Y", tYears: 1, instrumentType: "SWAP", value: 0.0368 },
      { term: "1M", tYears: 0.083333, instrumentType: "CASH", value: 0.0374 },
      { term: "10Y", tYears: 10, instrumentType: "SWAP", value: 0.043 },
    ],
    "term-funding": [
      { term: "1M", tYears: 0.083333, instrumentType: null, value: 0.039438 },
      { term: "1Y", tYears: 1, instrumentType: null, value: 0.039348 },
      { term: "10Y", tYears: 10, instrumentType: null, value: 0.049241 },
    ],
    tlp: [
      { term: null, tYears: 0, instrumentType: null, value: 0 },
      { term: null, tYears: 1, instrumentType: null, value: 0.0025 },
      { term: null, tYears: 10, instrumentType: null, value: 0.0065 },
    ],
  },
  capVolSurface: [
    { expiryYears: 1, strike: 0.03, isAtm: false, normalVol: 0.007025 },
    { expiryYears: 1, strike: null, isAtm: true, normalVol: 0.006345 },
    { expiryYears: 2, strike: 0.03, isAtm: false, normalVol: 0.006804 },
    { expiryYears: 2, strike: 0.04, isAtm: false, normalVol: 0.006369 },
  ],
  swaptionVolSurface: [
    { expiryYears: 1, tenorYears: 5, normalVol: 0.011922 },
    { expiryYears: 1, tenorYears: 10, normalVol: 0.010757 },
    { expiryYears: 5, tenorYears: 5, normalVol: 0.011044 },
    { expiryYears: 5, tenorYears: 10, normalVol: 0.009879 },
  ],
};

export const SERIES: CatalogCurveSeries = { curve: "risk-free", series: [
  { marketId: "market-2025-12-31", asOf: "2025-12-31", points: [
    { term: "1M", tYears: 0.083333, value: 0.039 }, { term: "1Y", tYears: 1, value: 0.037 }, { term: "10Y", tYears: 10, value: 0.04 } ] },
  { marketId: "market-public-2026-03-31", asOf: "2026-03-31", points: [
    { term: "1M", tYears: 0.083333, value: 0.0374 }, { term: "1Y", tYears: 1, value: 0.0368 }, { term: "10Y", tYears: 10, value: 0.043 } ] },
] };

export const LINEAGE_M: CatalogLineage = { collection: "market", id: "market-public-2026-03-31", contentHash: "hash-q1", consumedBy: [
  { runId: "run-market-1", role: "market", state: "done", submittedAt: "2026-09-02T00:00:00Z", endedAt: "2026-09-02T00:10:00Z", pinnedContentHash: "hash-q1" },
] };

/** The harness tests' snapshot: the stored snapshot above. */
export const MARKET: CatalogMarketSnapshot = SNAP;

/**
 * The plugin catalog as GET /api/catalog/plugins serves it, reduced to the rows the harness reads: curve and
 * term-structure components and the curve builders mounted. As on the live catalog, no Hull-White or stochastic plugin
 * is mounted: the Rate model page marks Hull-White 1F and BGM mounted from a Studio constant.
 */
export const CATALOG = {
  components: [
    { id: "alm-yield-curve", kind: "curve", label: "SOFR OIS zero curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], purpose: "Bootstraps a zero curve from par swap quotes. ACT/360, annual fixed schedule, Brent root-finding, linear in zero." },
    { id: "alm-tlp-overlay", kind: "curve", label: "Term liquidity premium overlay", consumes: ["ZeroCurve"], produces: ["ZeroCurve"], purpose: "TLP spread over SOFR, composing additively in zero space." },
    { id: "alm-hull-white", kind: "term-structure", label: "Hull-White 1-factor", consumes: ["ZeroCurve"], produces: ["RatePath"], purpose: "Shifted-Gaussian short rate." },
    { id: "alm-bgm-lmm", kind: "term-structure", label: "BGM / LIBOR market model", consumes: ["ZeroCurve"], produces: ["RatePath"], purpose: "Rebonato 2-factor volatility." },
    { id: "alm-sabr", kind: "term-structure", label: "SABR smile", consumes: ["MarketSnapshot"], produces: ["VolSurface"], purpose: "Bachelier closed-form smile at a single expiry." },
    { id: "alm-deposit-decay", kind: "behavioral", label: "NMD decay kernel", consumes: ["Cashflow"], produces: ["Cashflow"], purpose: "Age-ramped baseline closure." },
  ],
  stageKinds: [] as Array<{ id: string; label: string }>,
  mounted: [
    { id: "engine.rate-path", aliases: [] as string[], kind: "term-structure" as string | null },
    { id: "alm-yield-curve", aliases: [] as string[], kind: "curve" as string | null },
    { id: "alm-tlp-overlay", aliases: [] as string[], kind: "curve" as string | null },
    { id: "engine.behavioral.decay", aliases: ["alm-deposit-decay"], kind: "behavioral" as string | null },
  ],
};
