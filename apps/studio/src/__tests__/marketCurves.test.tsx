// apps/studio/src/__tests__/marketCurves.test.tsx
/**
 * Market curves table: zero, par, 1-month forward, discount factor,
 * TLP and all-in at the stored tenors. The seeded Lab pack is bootstrapped here with the engine's own functions, the
 * ones the preview route calls, and the figures asserted are the capstone's bootstrapped nodes, restated from the
 * digest (docs: capstone mechanics, resulting zero nodes), not read back from the code under test.
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { curveNodesOf } from "@alm/engine";
import { bootstrapZeroCurve, loadMarketSnapshot } from "@alm/kernel";
import type { CatalogMarketSnapshot } from "@alm/reader";
import { loadMarket } from "../pages/market/loadMarket";
import { MarketView } from "../pages/market/MarketView";
import { curveTable } from "../rows/marketRows";
import { LINEAGE_M, MARKETS, SERIES, SNAP } from "./fixtures/market";

const PACK = fileURLToPath(new URL("../../../../packages/kernel/public/market_public.json", import.meta.url));

/** The capstone's bootstrapped zero nodes (continuously compounded, decimal), by tenor in years. */
const CAPSTONE_ZERO: Record<number, number> = {
  0.083333: 0.0370546092, 0.25: 0.0366619134, 0.5: 0.0368582709, 1: 0.0364619237, 2: 0.0375667674, 3: 0.0377639452,
  5: 0.0389064662, 7: 0.0409624386, 10: 0.0430811124, 20: 0.0506885002, 30: 0.0498411842,
};
/** The Lab pack's term liquidity premium nodes, decimal, by tenor (the capstone's TLP list). */
const PACK_TLP: Record<number, number> = {
  0.083333: 0.002, 0.25: 0.002, 0.5: 0.0025, 1: 0.0025, 2: 0.003, 3: 0.0035, 5: 0.0045, 7: 0.0055, 10: 0.0065, 20: 0.009, 30: 0.01,
};
const ONE_HUNDREDTH_BP = 1e-6;

/** The seeded pack as the catalog route would serve it, and the base nodes the preview route would answer. */
async function seededPack() {
  const snap = await loadMarketSnapshot(PACK);
  const catalog: CatalogMarketSnapshot = {
    id: "market-public-2026-03-31",
    contentHash: "pack",
    asOf: snap.calibrationDate,
    curves: {
      "risk-free": snap.curveQuotes.map((q) => ({ term: q.term, tYears: q.tYears, instrumentType: q.instrumentType, value: q.rate })),
      "term-funding": [],
      tlp: snap.tlpNodes.map((n) => ({ term: null, tYears: n.tYears, instrumentType: null, value: n.spread })),
    },
    capVolSurface: [],
    swaptionVolSurface: [],
  };
  return { catalog, base: curveNodesOf(bootstrapZeroCurve(snap)) };
}

function mockFetch(table: Array<[string, unknown]>, preview?: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/scenarios/preview") && init?.method === "POST" && preview !== undefined) {
      return new Response(JSON.stringify(preview), { status: 200, headers: { "content-type": "application/json" } });
    }
    const hit = table.find(([k]) => url.includes(k));
    if (!hit) return new Response(JSON.stringify({ error: { code: "not-found", message: `no fixture for ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

const ROUTES: Array<[string, unknown]> = [
  ["/api/catalog/markets/market-public-2026-03-31", SNAP],
  ["/api/catalog/markets", MARKETS],
  ["/api/catalog/curves/risk-free/series", SERIES],
  ["/api/catalog/lineage/market/market-public-2026-03-31", LINEAGE_M],
];

describe("curveTable on the seeded pack", () => {
  it("has the eleven tenors, and the zero column is the capstone's bootstrapped nodes within 0.01 bp", async () => {
    const { catalog, base } = await seededPack();
    const rows = curveTable(catalog, base);
    expect(rows.map((r) => r.tYears)).toEqual(Object.keys(CAPSTONE_ZERO).map(Number).sort((a, b) => a - b));
    for (const r of rows) expect(Math.abs(r.zero - CAPSTONE_ZERO[r.tYears]!)).toBeLessThan(ONE_HUNDREDTH_BP);
    const y1 = rows.find((r) => r.tYears === 1)!;
    const y10 = rows.find((r) => r.tYears === 10)!;
    expect(y1.zero * 100).toBeCloseTo(3.6462, 4);
    expect(y10.zero * 100).toBeCloseTo(4.3081, 4);
  });

  it("TLP 10Y is 65 bp and the all-in curve is the zero plus the TLP at every tenor", async () => {
    const { catalog, base } = await seededPack();
    const rows = curveTable(catalog, base);
    const y10 = rows.find((r) => r.tYears === 10)!;
    expect(y10.tlp).toBeCloseTo(0.0065, 12);
    expect(y10.allIn).toBeCloseTo(CAPSTONE_ZERO[10]! + 0.0065, 9);
    for (const r of rows) {
      expect(r.tlp).toBeCloseTo(PACK_TLP[r.tYears]!, 12);
      expect(r.allIn).toBeCloseTo(r.zero + r.tlp!, 12);
    }
  });

  it("par is the stored quote, the discount factor is exp(-z t), and the 1-month forward is the simple forward off the discount factors", async () => {
    const { catalog, base } = await seededPack();
    const rows = curveTable(catalog, base);
    const y10 = rows.find((r) => r.tYears === 10)!;
    expect(y10.par).toBeCloseTo(0.043, 12);
    // The forward is checked against the curve object itself: linear in z between nodes, flat beyond the last.
    const curve = bootstrapZeroCurve(await loadMarketSnapshot(PACK));
    for (const r of rows) {
      expect(r.df).toBeCloseTo(Math.exp(-r.zero * r.tYears), 12);
      const expected = curve.forwardRate(r.tYears, r.tYears + 1 / 12);
      expect(r.forward1m).toBeCloseTo(expected, 9);
    }
  });

  it("a tenor with no TLP node or no par quote leaves those cells null, never a filled value", async () => {
    const { catalog, base } = await seededPack();
    const trimmed: CatalogMarketSnapshot = {
      ...catalog,
      curves: { ...catalog.curves, tlp: catalog.curves.tlp.filter((p) => p.tYears !== 10), "risk-free": catalog.curves["risk-free"].filter((p) => p.tYears !== 7) },
    };
    const rows = curveTable(trimmed, base);
    const y10 = rows.find((r) => r.tYears === 10)!;
    expect(y10.tlp).toBeNull();
    expect(y10.allIn).toBeNull();
    expect(rows.find((r) => r.tYears === 7)!.par).toBeNull();
  });
});

describe("Market curves view", () => {
  it("loadMarket asks the preview route for the base zero curve and keeps it beside the snapshot", async () => {
    const { catalog, base } = await seededPack();
    mockFetch(ROUTES, { marketSnapshot: "market-public-2026-03-31", calibrationDate: "2026-03-31", base, shocked: base, shiftBp: base.t.map(() => 0) });
    const model = await loadMarket("market-public-2026-03-31");
    expect(model.base?.t).toEqual(base.t);
    expect(model.baseNote).toBeNull();
    expect(catalog.id).toBe(model.marketId);
  });

  it("prints the table with the capstone's 1Y and 10Y zero, the 10Y TLP and the all-in", async () => {
    const { catalog, base } = await seededPack();
    mockFetch(ROUTES);
    const model = { ...(await loadMarket("market-public-2026-03-31")), snapshot: catalog, curves: [], base, baseNote: null };
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    expect(html).toContain("Curves at the stored tenors");
    for (const head of ["Zero", "Par", "1-month forward", "Discount factor", "TLP, bp", "All-in"]) expect(html).toContain(`>${head}</th>`);
    expect(html).toContain(">3.6462%<");
    expect(html).toContain(">4.3081%<");
    expect(html).toContain(">65.0<");
    expect(html).toContain(`>${((CAPSTONE_ZERO[10]! + 0.0065) * 100).toFixed(4)}%<`);
    // Eleven tenors: eleven body rows.
    expect(html.match(/<tr data-tenor=/g)?.length).toBe(11);
    expect(html).toContain("/api/scenarios/preview");
  });

  it("with the preview unavailable, says so in one sentence and prints no table", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    expect(model.base).toBeNull();
    expect(model.baseNote).toContain("no fixture for");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    expect(html).toContain("The zero curve could not be read");
    expect(html).not.toContain("<tr data-tenor=");
  });

  it("the spreads section keeps its existing cards and adds no curves table", async () => {
    const { catalog, base } = await seededPack();
    mockFetch(ROUTES);
    const model = { ...(await loadMarket("market-public-2026-03-31")), snapshot: catalog, base, baseNote: null };
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="spreads" />);
    expect(html).not.toContain("Curves at the stored tenors");
  });
});
