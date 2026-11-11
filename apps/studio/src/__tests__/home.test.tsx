import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { usdMM, signedPct } from "@alm/reader";
import { loadHome } from "../pages/home/loadHome";
import { HomeView } from "../pages/home/HomeView";
import { newestDoneRun } from "../rows/homeRows";
import { AGG, AGG_SIDE, EVE, INPUTS, LENSES, LINEAGE, NII } from "./fixtures/home";

function mockFetch(table: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input); const key = Object.keys(table).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: { code: "not-found", message: `no fixture for ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(table[key]), { status: 200, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe("Home", () => {
  it("picks the newest done run from lineage", () => { expect(newestDoneRun(LINEAGE as never)).toBe("run-new"); });
  it("loads and prints every figure exactly as the routes returned it", async () => {
    // The grouped key comes first: the ungrouped path is a prefix of it and the mock matches the first key found.
    mockFetch({ "/api/catalog/portfolios/book-a/positions/aggregate?groupBy=side": AGG_SIDE, "/api/catalog/lineage/portfolios/book-a": LINEAGE, "/api/runs/run-new/result/eve": EVE, "/api/runs/run-new/result/nii": NII,
      "/api/runs/run-new/lenses": LENSES, "/api/catalog/portfolios/book-a/positions/aggregate": AGG, "/api/catalog/runs/run-new/inputs": INPUTS });
    const model = await loadHome("book-a", "market-1");
    expect(model.run?.runId).toBe("run-new");
    expect(model.run?.eve[1].deltaEveVsBase).toBe(EVE.byScenario[1].deltaEveVsBase);
    expect(model.run?.nii[0].totalNet12).toBe(NII.byScenario[0].totalNet12);
    expect(model.intake.positionCount).toBe(AGG.aggregate.positionCount);
    const html = renderToStaticMarkup(<HomeView model={model} viewerBase="/" />);
    expect(html).toContain(usdMM(EVE.byScenario[0].eve));
    expect(html).toContain(signedPct(EVE.byScenario[1].deltaEvePct));
    expect(html).toContain(usdMM(NII.byScenario[0].totalNet12));
    expect(html).toContain("rate-demo-v1"); expect(html).toContain("breach"); expect(html).toContain("unobservable");
    expect(html).toContain("req-hash-1");
    expect(html).toContain("/api/runs/run-new/result/eve");   // the source line
    const assetsTile = html.match(/<div class="stat-label">Assets<\/div><div class="stat-value">(.*?)<\/div>/)?.[1] ?? "";
    expect(assetsTile.replace(/<[^>]+>/g, "")).toBe(usdMM(AGG_SIDE.groups.find((g) => g.key === "asset")!.totalNotional!));
    expect(html).toContain('<div class="stat-source">/api/catalog/portfolios/book-a/positions/aggregate?groupBy=side, groups[key=asset].totalNotional</div>');
    // The server's basis sentence rides on the tile's title, not the source line.
    expect(html).toContain(`, basis: ${AGG_SIDE.basis}"><div class="stat-label">Assets</div>`);
    expect(html).toContain("Min headroom vs limit");
    expect(html).toContain("stat-delta");
    // A zero delta prints no chip at all.
    const flat = { ...model, run: { ...model.run!, eve: model.run!.eve.map((r) => ({ ...r, deltaEvePct: 0 })) } };
    expect(renderToStaticMarkup(<HomeView model={flat} viewerBase="/" />)).not.toContain("stat-delta");
  });
  it("renders the unobservable panel when the book has no done run", async () => {
    mockFetch({ "/api/catalog/lineage/portfolios/book-b": { ...LINEAGE, id: "book-b", consumedBy: [] },
      "/api/catalog/portfolios/book-b/positions/aggregate?groupBy=side": { ...AGG_SIDE, groups: [] }, "/api/catalog/portfolios/book-b/positions/aggregate": AGG });
    const model = await loadHome("book-b", null);
    expect(model.run).toBeNull();
    const html = renderToStaticMarkup(<HomeView model={model} viewerBase="/" />);
    expect(html).toContain("no run stored for this book");
    expect(html).toContain('<div class="stat-label">Assets</div><div class="stat-value"><span class="status status-unobs">Unobservable</span>');
    expect(html).not.toContain("n/a");
  });
});
