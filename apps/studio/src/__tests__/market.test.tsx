import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { pct, swaptionGrid, VOL_TO_BP } from "@alm/reader";
import { loadMarket } from "../pages/market/loadMarket";
import { MarketView, marketMeta } from "../pages/market/MarketView";
import { MarketPage } from "../pages/market/MarketPage";
import { curveAxis, curveLines, seqStep } from "../rows/marketRows";
import { defaultSelection } from "../selection";
import { LINEAGE_M, MARKETS, SERIES, SNAP } from "./fixtures/market";

/** Keys are listed most specific first; the FIRST key the URL contains wins. */
function mockFetch(table: Array<[string, unknown]>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input); const hit = table.find(([k]) => url.includes(k));
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

describe("Market", () => {
  it("loads and prints every figure exactly as the routes returned it", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const riskFree = model.curves.find((c) => c.curve === "risk-free");
    // Sorted by tYears: the stored 1M point (second in the route body) comes first, value verbatim.
    expect(riskFree?.points[0].value).toBe(SNAP.curves["risk-free"][1].value);
    expect(riskFree?.points.map((p) => p.term)).toEqual(["1M", "1Y", "10Y"]);
    expect(model.cap.rows.length).toBe(new Set(SNAP.capVolSurface.map((q) => q.expiryYears)).size);
    expect(model.swaption.rows.length).toBe(2);
    expect(model.asOf).toBe("2026-03-31");
    expect(model.lineage.consumedBy[0].runId).toBe("run-market-1");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{ book: "book-a", asOf: "market-public-2026-03-31" }} section="curves" />);
    expect(html).toContain(pct(SNAP.curves["risk-free"][1].value, 2));
    expect(html).toContain("2026-03-31");
    expect(html).toContain("/api/catalog/markets/market-public-2026-03-31");
    expect(html).toContain("/api/catalog/curves/risk-free/series");
    expect(html).toContain("/api/catalog/lineage/market/market-public-2026-03-31");
    expect(html).toContain("Quoted points as stored; the zero and forward curves built from them appear on a run&#x27;s Rates tab.");
    // The snapshots are listed as a fact: the workspace pins one base, so no chip writes a selection.
    expect(html).not.toContain("asOf=market-2025-12-31");
    expect(html).toContain("The workspace pins the marked snapshot");
    expect(html).toContain("run-market-1");
    const vols = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{ book: "book-a", asOf: "market-public-2026-03-31" }} section="vols" />);
    // The viewer's VolHeatmap cell formatter: bp.toFixed(1).
    expect(vols).toContain(`>${(SNAP.capVolSurface[0].normalVol * VOL_TO_BP).toFixed(1)}<`);
    expect(vols).toContain("/api/catalog/markets/market-public-2026-03-31");
    // The cap grid has no quote at (1Y, 4.00%): that cell prints the Unobservable chip. It sits in the first selection's
    // column (2Y by 4.00%), so it carries its grid indexes and the cross class (Polish 10 T4).
    expect(vols).toContain('<div class="hm-cell unobs hm-x" data-i="0" data-j="1" title="1Y, 4.00%: Unobservable, no quote stored"><span class="status status-unobs">Unobservable</span></div>');
    // Two cap gaps in the fixture: (1Y, 4.00%) and the 2Y ATM quote; the swaption grid is full.
    expect(vols).toContain('<div class="hm-cell unobs" title="2Y, ATM: Unobservable, no quote stored">');
    expect(vols.match(/class="hm-cell unobs[^"]*"/g)?.length).toBe(2);
    // Each surface is an explorer: the canvas, the two slices and the linked grid.
    expect(vols.match(/<canvas class="s3-canvas"/g)?.length).toBe(2);
    expect(vols).toContain("Drag the surface to turn it; hover the surface or the grid to read a stored quote, click to pin it. A face joins four stored quotes; nothing is interpolated.");
  });
  it("curves section: snapshots, benchmark curve only, history, lineage; no vol surface", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    expect(html).toContain("Snapshots");
    expect(html).toContain("Benchmark discount curve");
    expect(html).not.toContain("Term liquidity premium spread");
    expect(html).not.toContain("volatility surface, normal bp");
  });
  it("lineage prints the date part of the stored endedAt", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    expect(html).toContain("<td>2026-09-02</td>");
    expect(html).not.toContain("2026-09-02T00:10:00Z");
  });
  it("lineage prints Unobservable with its reason when the run has no stored endedAt", async () => {
    const open = { ...LINEAGE_M, consumedBy: [{ ...LINEAGE_M.consumedBy[0]!, state: "running", endedAt: null }] };
    mockFetch([["/api/catalog/lineage/market/market-public-2026-03-31", open], ...ROUTES]);
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    expect(html).toContain('<th scope="row" class="mono">run-market-1</th><td class="mono">market</td><td>running</td><td>Unobservable: no end time recorded</td>');
  });
  it("one stored snapshot: one muted line, no duplicate chart", async () => {
    const one = { ...SERIES, series: SERIES.series.slice(1) };
    mockFetch([["/api/catalog/curves/risk-free/series", one], ...ROUTES]);
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    const card = html.slice(html.indexOf('aria-label="Benchmark curve across snapshots"'), html.indexOf("Lineage"));
    expect(card).toContain('<p class="muted">One snapshot stored; the comparison draws when a second is loaded.</p>');
    expect(card).not.toContain("One line per stored snapshot");
  });
  it("vols section: the short-rate and long-yield surfaces and the SABR preview only", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="vols" />);
    expect(html).toContain("Short-rate volatility surface, normal bp (constructed illustrative)");
    expect(html).toContain("Long-yield volatility surface, normal bp (constructed illustrative)");
    expect(html).not.toContain("Snapshots");
  });
  it("vols section: expiries and swap tenors print as tenors (1M, 3M, 9M, then years), strikes as percents (Polish 10 Task 5, F2 and F10)", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    // A swaption grid with the snapshot's month expiries: 1/12, 0.25 and 0.75 of a year, then 1Y; tenors 1Y and 10Y.
    const q = (e: number, t: number, v: number) => ({ expiryYears: e, tenorYears: t, normalVol: v });
    const swaption = swaptionGrid([q(1 / 12, 1, 0.009), q(1 / 12, 10, 0.0095), q(0.25, 1, 0.0092), q(0.25, 10, 0.0096), q(0.75, 1, 0.0094), q(0.75, 10, 0.0097), q(1, 1, 0.0096), q(1, 10, 0.0098)]);
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={{ ...model, swaption }} query={{}} section="vols" />);
    // The grid's row and column headers; the first selection is the last of four expiries and the second of two
    // tenors, 1Y by 10Y, so those two headers carry the highlight.
    for (const h of ["1M", "3M", "9M"]) expect(html).toContain(`<div class="hm-row">${h}</div>`);
    expect(html).toContain('<div class="hm-row hm-on">1Y</div>');
    expect(html).toContain('<div class="hm-col">1Y</div>');
    expect(html).toContain('<div class="hm-col hm-on">10Y</div>');
    expect(html).toContain('<div class="vx-slice-title">Across swap tenors at the 1Y expiry</div>');
    expect(html).toContain('<div class="vx-slice-title">Across expiries for the 10Y swap</div>');
    // The expiry slice's x ticks.
    expect(html).toContain('text-anchor="middle">1M</text>');
    expect(html).not.toContain("0.08333Y");
    expect(html).not.toContain("0.75Y");
    // The cap keeps its strikes in percent and its expiries in years.
    expect(html).toContain('<div class="hm-col">3.00%</div>');
    expect(html).toContain('<div class="hm-row hm-on">2Y</div>');
  });
  it("spreads section: term funding and TLP curves only", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="spreads" />);
    expect(html).toContain("Term liquidity premium spread");
    expect(html).not.toContain("Benchmark discount curve");
  });
  it("picks a --seq step on seven equal bins, 4 when the range is flat", () => {
    expect(seqStep(0, 0, 100, 7)).toBe(1);
    expect(seqStep(100, 0, 100, 7)).toBe(7);
    expect(seqStep(5, 5, 5, 7)).toBe(4);
    expect(seqStep(50, 0, 100, 7)).toBe(4);
  });
  it("copies every stored curve's points, ordered by tYears", () => {
    const lines = curveLines(SNAP);
    expect(lines.map((l) => l.curve)).toEqual(["risk-free", "term-funding", "tlp"]);
    expect(lines[0].points.map((p) => p.tYears)).toEqual([0.083333, 1, 10]);
    expect(lines[2].points[0]).toEqual({ tYears: 0, term: null, value: 0 });
    // The route body is not reordered in place.
    expect(SNAP.curves["risk-free"][0].term).toBe("1Y");
  });
  it("lines stored curves up on their tenors in years, ascending, with a label and a gap where a curve does not quote (Polish 10 T2)", () => {
    const [, tf, tlp] = curveLines(SNAP);
    expect(curveAxis([tf!.points, tlp!.points])).toEqual({
      tenors: [0, 0.083333, 1, 10],
      labels: ["0Y", "1M", "1Y", "10Y"],
      values: [[null, 0.039438, 0.039348, 0.049241], [0, null, 0.0025, 0.0065]],
    });
  });
  it("drops a curve with no points, so a derived market's empty term-funding curve draws no line (Piece 6c)", () => {
    const derived = { ...SNAP, curves: { ...SNAP.curves, "term-funding": [] } };
    expect(curveLines(derived).map((l) => l.curve)).toEqual(["risk-free", "tlp"]);
  });
  it("labels a tenor no list names with the tenor label, not years: 1M, not 0.08333Y (Piece 6c)", () => {
    const tlpOnly = [
      { tYears: 0, term: null, value: 0 },
      { tYears: 0.083333, term: null, value: 0.007 },
      { tYears: 0.5, term: null, value: 0.0075 },
      { tYears: 10, term: null, value: 0.0115 },
    ];
    expect(curveAxis([tlpOnly])).toEqual({
      tenors: [0, 0.083333, 0.5, 10],
      labels: ["0Y", "1M", "6M", "10Y"],
      values: [[0, 0.007, 0.0075, 0.0115]],
    });
  });
  it("the default market skips a derived market that shares its base's as-of date (Piece 6c)", () => {
    const base = { id: "market-public-2026-03-31", contentHash: "h", ingestedAt: "t", asOf: "2026-03-31", curvePoints: 1, capVolPoints: 0, swaptionVolPoints: 0 };
    const derived = { ...base, id: "derived-mk-abc", derivedFromMarketId: "market-public-2026-03-31" };
    expect(defaultSelection([], [derived, base]).marketId).toBe("market-public-2026-03-31");
    expect(defaultSelection([], [derived]).marketId).toBe("derived-mk-abc");
  });
  it("draws the stored curves through LinePlot: tenors to scale, y numbers, the benchmark area, a legend for two or more (Polish 10 T2)", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const curves = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="curves" />);
    const stored = curves.slice(curves.indexOf("Stored curves"), curves.indexOf("Benchmark curve across snapshots"));
    expect(stored).toContain("Rate, percent; tenor to scale on a square-root axis");
    expect(stored).not.toContain("evenly spaced");
    expect(stored).toContain('class="lp-area"');
    expect(stored).not.toContain("lp-legend");
    for (const t of ["1M", "1Y", "10Y"]) expect(stored).toContain(`>${t}</text>`);
    // The benchmark's stored range, 3.68% to 4.30%, on a 242 px plot: 0.1% ticks from 3.6% to 4.4%.
    expect(stored).toContain(">3.6%</text>");
    expect(stored).toContain(">4.4%</text>");
    const history = curves.slice(curves.indexOf("Benchmark curve across snapshots"), curves.indexOf("Lineage"));
    expect(history).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:var(--muted)"></i>2025-12-31 (market-2025-12-31)</button>');
    expect(history).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:var(--series-1)"></i>2026-03-31 (market-public-2026-03-31)</button>');
    const spreads = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="spreads" />);
    // The TLP's 0-year point draws on the tenor axis; two curves, a legend and no area.
    expect(spreads).toContain(">0Y</text>");
    expect(spreads).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:var(--series-3)"></i>Term liquidity premium spread</button>');
    expect(spreads).not.toContain("lp-area");
  });
  it("names the route when no market is stored, and prints the header meta from the list item", () => {
    const html = renderToStaticMarkup(<MarketPage ws="ws-a" marketId={null} query={{}} section="curves" />);
    expect(html).toContain("No market snapshot is attached to this workspace. Attach a stored snapshot or import a workbook below.");
    expect(html.match(/Unobservable/g)?.length).toBe(1);
    expect(html).toContain('<span class="status status-unobs">Unobservable</span>');
    expect(html).toContain("unobs-panel");
    const meta = renderToStaticMarkup(<>{marketMeta(MARKETS, "market-public-2026-03-31")}</>).replace(/<[^>]+>/g, "");
    expect(meta).toContain("9 curve points, 4 short-rate volatility points, 4 long-yield volatility points, as of 2026-03-31");
    expect(renderToStaticMarkup(<>{marketMeta(MARKETS, "market-nope")}</>)).toContain("Unobservable");
  });
  it("prints basis-neutral curve labels, never SOFR or FHLB as a label", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const q = { book: "book-a", asOf: "market-public-2026-03-31" };
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={q} section="curves" />);
    const vols = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={q} section="vols" />);
    const spreads = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={q} section="spreads" />);
    // Since the id-rename the route paths carry no SOFR or FHLB either, so every section's whole page is checked.
    for (const page of [html, vols, spreads]) expect(page).not.toMatch(/SOFR|FHLB/i);
    expect(html).toContain("Benchmark discount curve");
    expect(spreads).toContain("Term funding curve");
    expect(spreads).toContain("Term liquidity premium spread");
    expect(html).toContain("Benchmark curve across snapshots");
  });
});
