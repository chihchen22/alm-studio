// Piece B slice two, Task 8 part B: Market > Volatility surfaces (cards retitled, each naming the model that reads it,
// the count line, the SABR smile surface preview) and the rate model names the vol frame reads from the workspace's runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getVolSmile, type VolSmileReply } from "@alm/reader";
import { loadMarket } from "../pages/market/loadMarket";
import { MarketView, marketMeta } from "../pages/market/MarketView";
import { frameContextDeps, loadFrameContext, stochasticRunModels } from "../pages/market/MarketPage";
import { SabrSmileView, SABR_COPY, type SabrSmileViewProps } from "../pages/market/SabrSmileCard";
import { LINEAGE_M, MARKETS, SERIES, SNAP } from "./fixtures/market";
import { mockFetch } from "./fixtures/run";
import { HarnessFrame } from "../harness/HarnessFrame";
import { volInstances, volMethods } from "../harness/instances";

afterEach(() => vi.unstubAllGlobals());

const SWEEP = /cap (normal )?vol|cap quote|cap surface|swaption (quote|normal|grid|atm)/i;
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const ROUTES: Array<[string, unknown]> = [
  ["/api/catalog/markets/market-public-2026-03-31", SNAP],
  ["/api/catalog/markets", MARKETS],
  ["/api/catalog/curves/risk-free/series", SERIES],
  ["/api/catalog/lineage/market/market-public-2026-03-31", LINEAGE_M],
];

describe("Volatility surfaces: the two cards and the count line", () => {
  it("retitles both cards, names the model that reads each, and holds no old surface naming", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const html = renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="vols" />);
    const t = text(html);
    expect(t).toContain("Short-rate volatility surface, normal bp (constructed illustrative)");
    expect(t).toContain("Long-yield volatility surface, normal bp (constructed illustrative)");
    expect(t).toContain("Read by Hull-White 1F: a stochastic run calibrates to the at-the-money column; the strike wings stay unread.");
    expect(t).toContain("Read by BGM: a stochastic run calibrates to the default subset of this surface (28 points).");
    // The short-rate card comes first, then the long-yield card, then the SABR card.
    expect(t.indexOf("Short-rate volatility surface, normal bp")).toBeLessThan(t.indexOf("Long-yield volatility surface, normal bp"));
    expect(t.indexOf("Long-yield volatility surface, normal bp")).toBeLessThan(t.indexOf(SABR_COPY.title));
    expect(html).toContain('aria-label="Short-rate volatility surface, 2 expiries by 2 strikes');
    expect(html).toContain('aria-label="Long-yield volatility surface, 2 expiries by 2 swap tenors');
    expect(html).not.toMatch(SWEEP);
    expect(html).not.toMatch(BANNED_CHARS);
  });
  it("the SABR card reads the smile route after the page draws: the server render shows it waiting, with its copy", async () => {
    mockFetch(ROUTES);
    const model = await loadMarket("market-public-2026-03-31");
    const t = text(renderToStaticMarkup(<MarketView ws="ws-a" model={model} query={{}} section="vols" />));
    expect(t).toContain(SABR_COPY.title);
    expect(t).toContain(SABR_COPY.desc);
    expect(t).toContain("Reading the smile at the 1Y expiry");
  });
  it("the count line names the two surfaces and drops the old quote words", () => {
    const meta = text(renderToStaticMarkup(<>{marketMeta(MARKETS, "market-public-2026-03-31")}</>));
    expect(meta).toContain("9 curve points, 4 short-rate volatility points, 4 long-yield volatility points, as of 2026-03-31");
    expect(meta).not.toMatch(SWEEP);
  });
});

const REPLY: VolSmileReply = {
  marketId: "market-public-2026-03-31",
  expiryYears: 5,
  underlyingTau: 0.25,
  forward: 0.046341422508,
  heuristic: { alpha: 0.0072545, beta: 0, rho: -0.35, nu: 0.95 },
  params: { alpha: 0.0072545, beta: 0, rho: -0.35, nu: 0.95 },
  points: [
    { strike: 0.03, isAtm: false, normalVol: 0.0081, modelVol: 0.00795, residualBp: -1.5 },
    { strike: 0.046341422508, isAtm: true, normalVol: 0.0072, modelVol: 0.0072545, residualBp: 0.545 },
    { strike: 0.06, isAtm: false, normalVol: 0.0077, modelVol: 0.0078, residualBp: 1 },
  ],
  curve: [
    { strike: 0.03, modelVol: 0.00795 },
    { strike: 0.035, modelVol: 0.0076 },
    { strike: 0.06, modelVol: 0.0078 },
  ],
  note: "THE ROUTE NOTE, printed verbatim.",
};

const view = (over: Partial<SabrSmileViewProps> = {}): SabrSmileViewProps => ({
  marketId: "market-public-2026-03-31",
  expiries: [1, 2, 5],
  expiry: 5,
  over: {},
  reply: REPLY,
  error: null,
  onExpiry: () => {},
  onSlide: () => {},
  onReset: () => {},
  ...over,
});

describe("SABR smile card (surface preview)", () => {
  it("an expiry select and three labelled sliders, the smile chart, the stored points against the model, the route's note under the chart", () => {
    const html = renderToStaticMarkup(<SabrSmileView {...view()} />);
    const t = text(html);
    expect(html).toContain('aria-label="SABR smile, surface preview"');
    expect(t).toContain(SABR_COPY.title);
    expect(t).toContain(SABR_COPY.desc);
    // The expiry select: every stored expiry row, the chosen one selected.
    expect(html).toMatch(/<select[^>]*aria-label="Expiry"/);
    expect(html).toContain('<option value="1">1Y</option><option value="2">2Y</option><option value="5" selected="">5Y</option>');
    // Three sliders, each labelled, in the route's open ranges.
    expect(html).toMatch(/<input[^>]*type="range"[^>]*aria-label="Alpha, bp of normal volatility"/);
    expect(html).toMatch(/<input[^>]*type="range"[^>]*min="-0.99"[^>]*max="0.99"[^>]*aria-label="Rho"/);
    expect(html).toMatch(/<input[^>]*type="range"[^>]*min="0.01"[^>]*max="3"[^>]*aria-label="Nu"/);
    expect(t).toContain("In use: alpha 72.5 bp, rho -0.35, nu 0.95, beta 0. The heuristic: alpha 72.5 bp, rho -0.35, nu 0.95.");
    // The chart, then the note verbatim under it.
    expect(html).toContain("SABR, Hagan normal form (beta 0)");
    expect(html).toContain("Stored points, the at-the-money column placed at the forward");
    expect(html.indexOf("<svg")).toBeGreaterThan(-1);
    expect(html.indexOf("THE ROUTE NOTE, printed verbatim.")).toBeGreaterThan(html.indexOf("<svg"));
    // The stored points against the model, as the route returned them, in bp.
    expect(t).toContain("Strike Stored, bp Model, bp Residual, bp");
    expect(t).toContain("3.00% 81.0 79.5 -1.5");
    expect(t).toContain("ATM at the forward 4.63% 72.0 72.5 0.5");
    expect(t).toContain("6.00% 77.0 78.0 1.0");
    expect(t).toContain("Source: GET /api/market/market-public-2026-03-31/vol-smile?expiryYears=5; underlying tenor 3M, forward 4.6341%");
    // With no override the reset is off.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Back to the heuristic<\/button>/);
    expect(html).not.toMatch(SWEEP);
    expect(html).not.toMatch(BANNED_CHARS);
  });
  it("an override is shown against the heuristic and the reset is on; the slider holds the override", () => {
    const reply = { ...REPLY, params: { ...REPLY.params, rho: 0.2 } };
    const html = renderToStaticMarkup(<SabrSmileView {...view({ over: { rho: 0.2 }, reply })} />);
    expect(text(html)).toContain("In use: alpha 72.5 bp, rho 0.2, nu 0.95, beta 0. The heuristic: alpha 72.5 bp, rho -0.35, nu 0.95.");
    expect(html).toMatch(/<input[^>]*aria-label="Rho" value="0.2"/);
    expect(html).toMatch(/<button[^>]*>Back to the heuristic<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Back to the heuristic/);
  });
  it("a refused query shows the route's message in words and no chart; the controls stay", () => {
    const html = renderToStaticMarkup(<SabrSmileView {...view({ over: { nu: 2.9 }, error: "422: the preview cannot be computed: the model vol at strike 0.06 is not a finite number" })} />);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("422: the preview cannot be computed: the model vol at strike 0.06 is not a finite number");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("THE ROUTE NOTE");
    expect(html).toMatch(/aria-label="Nu"/);
  });
  it("after a refusal the in-use line is hidden (it would show the last answered values) and the reset stays", () => {
    const html = renderToStaticMarkup(<SabrSmileView {...view({ over: { nu: 2.9 }, error: "422: refused in words" })} />);
    expect(text(html)).not.toContain("In use:");
    expect(html).toMatch(/<button[^>]*>Back to the heuristic<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Back to the heuristic/);
  });
  it("carried-over overrides refused at a newly chosen expiry (no reply yet): the reset is still offered", () => {
    const html = renderToStaticMarkup(<SabrSmileView {...view({ reply: null, over: { nu: 2.9 }, error: "422: refused in words" })} />);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Nu"/);
    expect(html).toMatch(/<button[^>]*>Back to the heuristic<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Back to the heuristic/);
  });
  it("before the first reply the card says what it reads and the sliders are off", () => {
    const html = renderToStaticMarkup(<SabrSmileView {...view({ reply: null })} />);
    expect(text(html)).toContain("Reading the smile at the 5Y expiry");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Rho"/);
  });
  it("a snapshot with no short-rate expiry row says so and reads nothing", () => {
    const html = renderToStaticMarkup(<SabrSmileView {...view({ expiries: [], reply: null })} />);
    expect(text(html)).toContain("The snapshot stores no short-rate volatility surface, so there is no smile to preview.");
    expect(html).not.toContain("<select");
  });
});

describe("the smile route and the run models, read through @alm/reader", () => {
  it("getVolSmile asks for one expiry, with only the overrides given", async () => {
    mockFetch([["/vol-smile", REPLY]]);
    await getVolSmile("market-public-2026-03-31", 5);
    await getVolSmile("market public", 0.5, { alpha: 0.008, nu: 1.2 });
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toMatch(/\/api\/market\/market-public-2026-03-31\/vol-smile\?expiryYears=5$/);
    expect(urls[1]).toMatch(/\/api\/market\/market%20public\/vol-smile\?expiryYears=0\.5&alpha=0\.008&nu=1\.2$/);
  });
  it("stochasticRunModels: the done stochastic runs on this market snapshot, each read for its stored model; an absent model is Hull-White 1F", async () => {
    const m = "market-public-2026-03-31";
    const refs = (marketId: string) => ({ portfolioId: "p", marketId, scenarioSlateId: "s", assumptionSetIds: [] });
    mockFetch([
      ["/api/runs/run-hw", { runId: "run-hw", state: "done", stochastic: { nPaths: 64 } }],
      ["/api/runs/run-bgm", { runId: "run-bgm", state: "done", stochastic: { nPaths: 64, model: "bgm-lmm-2f" } }],
      ["/api/runs", [
        { runId: "run-hw", state: "done", mode: "stochastic", refs: refs(m) },
        { runId: "run-bgm", state: "done", mode: "stochastic", refs: refs(m) },
        { runId: "run-det", state: "done", mode: "deterministic", refs: refs(m) },
        { runId: "run-failed", state: "failed", mode: "stochastic", refs: refs(m) },
        { runId: "run-other-market", state: "done", mode: "stochastic", refs: refs("market-2025-12-31") },
      ]],
    ]);
    expect(await stochasticRunModels(m)).toEqual(["Hull-White 1F", "BGM"]);
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => /\/api\/runs\/run-/.test(u)).sort()).toEqual([expect.stringMatching(/run-bgm$/), expect.stringMatching(/run-hw$/)]);
    // The frame then lists each surface as used by the model that read it.
    const inst = volInstances(SNAP, { rateModelNames: await stochasticRunModels(m) });
    expect(inst.map((i) => i.usedBy)).toEqual([[{ kind: "instance", id: "Hull-White 1F" }], [{ kind: "instance", id: "BGM" }]]);
  });
  it("the frame context reloads only when the vols screen is entered or left: curves and spreads (the TLP or Term funding instance) share one load", async () => {
    const m = "market-public-2026-03-31";
    expect(frameContextDeps("ws-a", null, "cs-1", "curves", m)).toEqual(frameContextDeps("ws-a", null, "cs-1", "spreads", m));
    expect(frameContextDeps("ws-a", null, "cs-1", "vols", m)).not.toEqual(frameContextDeps("ws-a", null, "cs-1", "curves", m));
    const refs = { portfolioId: "p", marketId: m, scenarioSlateId: "s", assumptionSetIds: [] };
    const routes: Array<[string, unknown]> = [
      ["/api/runs/run-bgm", { runId: "run-bgm", state: "done", stochastic: { nPaths: 64, model: "bgm-lmm-2f" } }],
      ["/api/runs", [{ runId: "run-bgm", state: "done", mode: "stochastic", refs }]],
      ["/api/catalog/plugins", { components: [], mounted: [] }],
      ["/api/run-setups", { setups: [], missing: [] }],
      ["/api/curve-setups/cs-1", { id: "cs-1", label: "Setup one" }],
    ];
    mockFetch(routes);
    const curves = await loadFrameContext("ws-a", null, "cs-1", false, m);
    const curveUrls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    // No run is read off the vols screen, and the active setup's name is read.
    expect(curveUrls.some((u) => u.includes("/api/runs"))).toBe(false);
    expect(curves.rateModelNames).toEqual([]);
    expect(curves.activeSetup).toBe("Setup one");
    vi.unstubAllGlobals();
    mockFetch(routes);
    const vols = await loadFrameContext("ws-a", null, "cs-1", true, m);
    expect(vols.rateModelNames).toEqual(["BGM"]);
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/runs"))).toHaveLength(2);
  });
  it("stochasticRunModels reads none when no stochastic run sits on the snapshot, and the frame says nothing uses it yet", async () => {
    mockFetch([["/api/runs", [
      { runId: "run-det", state: "done", mode: "deterministic", refs: { portfolioId: "p", marketId: "market-public-2026-03-31", scenarioSlateId: "s", assumptionSetIds: [] } },
      { runId: "run-elsewhere", state: "done", mode: "stochastic", refs: { portfolioId: "p", marketId: "market-2025-12-31", scenarioSlateId: "s", assumptionSetIds: [] } },
    ]]]);
    const names = await stochasticRunModels("market-public-2026-03-31");
    expect(names).toEqual([]);
    const inst = volInstances(SNAP, { rateModelNames: names });
    const html = renderToStaticMarkup(<HarnessFrame module="vol-surface" instances={inst} methods={volMethods({ components: [], mounted: [] })} selected={inst[0]!.id} />);
    expect(text(html)).toContain("Nothing in this workspace uses it yet.");
  });
});
