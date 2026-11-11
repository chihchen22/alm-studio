import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { usdMM } from "@alm/reader";
import { loadBalance, loadPositionsPage } from "../pages/balance/loadBalance";
import { BalanceView } from "../pages/balance/BalanceView";
import { groupRows } from "../rows/balanceRows";
import { BOOK, CASHFLOWS, GROUPED, LENSES, LINEAGE, PAGE } from "./fixtures/balance";

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
  ["/api/catalog/portfolios/book-a/positions/aggregate?groupBy=family", GROUPED],
  ["/api/catalog/portfolios/book-a/positions?", PAGE],
  ["/api/catalog/lineage/portfolios/book-a", LINEAGE],
  ["/api/runs/run-new/result/cashflows", CASHFLOWS],
  ["/api/runs/run-new/lenses", LENSES],
  ["/api/portfolios/book-a", BOOK],
];

describe("Balance Sheet", () => {
  it("loads and prints every figure exactly as the routes returned it", async () => {
    mockFetch(ROUTES);
    const model = await loadBalance("book-a", "family", {});
    const page = await loadPositionsPage("book-a", {}, 0);
    expect(model.groups[0].totalNotional).toBe(GROUPED.groups[0].totalNotional);
    expect(model.familyGroups.map((g) => g.key)).toEqual(["loans", "dda", "(none)"]);
    expect(page.page.total).toBe(2351);
    expect(model.runoff?.runId).toBe("run-new");
    expect(model.runoff?.scenarioId).toBe("S0");
    expect(model.runoff?.byFamily[0].balance).toEqual(CASHFLOWS.byScenario[0].byFamily[0].series.balance);
    expect(model.runoff?.byFamily.map((f) => f.side)).toEqual(["asset", "liability"]);
    const html = renderToStaticMarkup(<BalanceView ws="ws-a" model={model} positions={{ state: "ok", value: page }} query={{ book: "book-a", asOf: "market-1" }} />);
    expect(html).toContain(usdMM(GROUPED.groups[0].totalNotional!));
    // A group-by chip and the pager write the workspace address; the book and the as-of are the workspace's, not the query's.
    expect(html).toContain('href="#/ws/ws-a/balance/positions?groupBy=side"');
    expect(html).toContain('href="#/ws/ws-a/balance/positions?offset=50"');
    expect(html).toContain("/api/catalog/portfolios/book-a/positions?limit=50&amp;offset=0");
    for (const p of PAGE.positions) expect(html).toContain(p.positionId);
    expect(html).toContain(`offset 0, returned ${PAGE.page.returned}, total 2,351`);
    // Null rates print the footnote's reason, null group rates the unobservable chip; never "n/a".
    expect(html).toContain(">model-implied</td>");
    // Each position row and each group row opens on a row header (Row header scope): the position id, linked, and the group key.
    expect(html).toContain('<th scope="row" class="mono"><a href="#/ws/ws-a/balance/positions?position=pos-loan-0001">pos-loan-0001</a></th><td class="mono">loans</td>');
    expect(html).toContain('<th scope="row" class="mono"><a href="#/ws/ws-a/balance/positions?position=pos-dda-0002">pos-dda-0002</a></th><td class="mono">dda</td>');
    expect(html).toContain('<tr><th scope="row" class="mono">loans</th><td class="num">');
    expect(html).toContain('<tr><th scope="row" class="mono">dda</th><td class="num">');
    expect(html).not.toContain("n/a");
    expect(html).toContain("/api/catalog/portfolios/book-a/positions/aggregate?groupBy=family");
    expect(html).toContain("Runoff by family, balance at start of bucket");
    expect(html).toContain("cashflows.byScenario[S0].byFamily[].series.balance");
  });
  it("draws the runoff on LinePlot: month index on x, the y axis from 0 in USD, one line per family (Polish 13)", async () => {
    const scaled = { ...CASHFLOWS, byScenario: [{ ...CASHFLOWS.byScenario[0], byFamily: [
      { familyId: "loans", series: { balance: [900e6, 800e6, 700e6], principal: [0, 0, 0], interest: [0, 0, 0] } },
      { familyId: "dda", series: { balance: [500e6, 490e6, 480e6], principal: [0, 0, 0], interest: [0, 0, 0] } } ] }] };
    mockFetch([...ROUTES.filter(([k]) => !k.includes("cashflows")), ["/api/runs/run-new/result/cashflows", scaled]]);
    const model = await loadBalance("book-a", "family", {});
    const html = renderToStaticMarkup(<BalanceView ws="ws-a" model={model} positions={{ state: "loading" }} query={{ book: "book-a" }} />);
    expect(html).toContain('role="img" aria-label="loans (asset), dda (liability), USD, axis from 0"');
    expect(html).toContain('<div class="lp-unit"><span>USD, axis from 0</span><span>Drag to zoom</span></div>');
    // 0 to 900M padded 45M above: raw step 945M / 6 = 157.5M rounds to 200M, so ticks $0M to $1,000M in millions:
    // $0M on the plot's foot (272 px), $1,000M on its top (10 px). "$1,000M" is seven characters, so the left margin
    // grows to ceil(7 * 6.6) + 8 + 4 = 59 px and the labels anchor at 51 px (fix round 1).
    expect(html).toContain('<text class="lp-ax" x="51" y="275.5" text-anchor="end">$0M</text>');
    expect(html).toContain('<text class="lp-ax" x="51" y="13.5" text-anchor="end">$1,000M</text>');
    // Buckets 0 to 2 at months 1 to 3, x 59, 341.5 and 624 px (565 px of plot); y = 10 + (1000 - v) / 1000 * 262 px.
    expect(html).toContain('<path class="lp-line" d="M59.00,36.20L341.50,62.40L624.00,88.60" stroke="var(--series-1)"></path>');
    expect(html).toContain('<path class="lp-line" d="M59.00,141.00L341.50,143.62L624.00,146.24" stroke="var(--muted)"></path>');
    // Month ticks over 1 to 3 are every 3 months: M3 alone.
    expect(html).toContain('text-anchor="middle">M3</text>');
    expect(html).toContain('<summary>Show table</summary>');
    expect(html).toContain('<tr><th scope="row">Month 1</th><td class="num lvl">$900.0M</td><td class="num lvl">$500.0M</td></tr>');
    expect(html).not.toContain("over 3 points");
  });
  it("skips a newest run that serves no cashflows (a stochastic run) and draws the runoff from the next newest", async () => {
    const stochastic = { runId: "run-stoch", role: "portfolio", state: "done", submittedAt: null, endedAt: "9999-01-01T00:00:00.000Z", pinnedContentHash: "x" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/runs/run-stoch/")) return new Response(JSON.stringify({ error: { code: "bad-request", message: "no such section" } }), { status: 400 });
      if (url.includes("/api/catalog/lineage/portfolios/book-a")) return new Response(JSON.stringify({ ...LINEAGE, consumedBy: [stochastic, ...LINEAGE.consumedBy] }), { status: 200 });
      const hit = ROUTES.find(([k]) => url.includes(k));
      return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response("{}", { status: 404 });
    }));
    const model = await loadBalance("book-a", "family", {});
    expect(model.runoff?.runId).toBe("run-new");
  });
  it("maps a null group key to (none) and shows the unobservable runoff panel with no done run", async () => {
    expect(groupRows(GROUPED).map((g) => g.key)).toEqual(["loans", "dda", "(none)"]);
    mockFetch([...ROUTES.filter(([k]) => !k.includes("lineage")), ["/api/catalog/lineage/portfolios/book-a", { ...LINEAGE, consumedBy: [] }]]);
    const model = await loadBalance("book-a", "family", {});
    expect(model.runoff).toBeNull();
    const html = renderToStaticMarkup(<BalanceView ws="ws-a" model={model} positions={{ state: "loading" }} query={{ book: "book-a" }} />);
    expect(html).toContain("Unobservable");
    expect(html).toContain("no run stored for this book");
    expect(html).not.toContain("n/a");
  });
});
