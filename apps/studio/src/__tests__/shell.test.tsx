import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HealthInfo } from "@alm/reader";
import { Shell } from "../shell/Shell";
import { SelectPill } from "../shell/SelectPill";
import type { Route } from "../router";
import { HEAD, OTHERS, READINESS } from "./fixtures/workspace";

const health = {
  engineVersion: "x",
  kernel: {} as never,
  schemaVersion: "1",
  storePath: "",
  queueDepth: 0,
  seed: {
    stale: [{ collection: "market", id: "market-public-2026-03-31", storedHash: "a", currentHash: "b", differences: [] }],
    retired: [],
  },
} as unknown as HealthInfo;
const retiredHealth = {
  ...health,
  seed: {
    stale: [],
    retired: [{ collection: "market", id: "market-2026-03-31", reason: "earlier market snapshot", runs: [] }],
  },
} as unknown as HealthInfo;

const WS = HEAD.id;
const at = (section: Extract<Route, { kind: "screen" }>["section"], screen: Extract<Route, { kind: "screen" }>["screen"], query: Record<string, string> = {}): Route => ({ kind: "screen", ws: WS, section, screen, query });
const shell = (route: Route, extra: { health?: HealthInfo | null; readinessState?: Parameters<typeof Shell>[0]["readinessState"]; meta?: Parameters<typeof Shell>[0]["meta"] } = {}) =>
  renderToStaticMarkup(
    <Shell route={route} head={route.kind === "screen" ? HEAD : null} workspaces={[HEAD, ...OTHERS]} readinessState={extra.readinessState ?? null} meta={extra.meta ?? null} health={extra.health ?? null}>
      <div />
    </Shell>,
  );

describe("shell", () => {
  it("top bar carries the wordmark and the seven sections, the open one current", () => {
    const html = shell(at("market", "curves"));
    expect(html).toContain("Model Sense");
    expect(html).toContain("ALM Studio");
    const mods = [...html.matchAll(/class="mod"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(mods).toEqual(["Workspace", "Market", "Balance Sheet", "Assumptions", "Run", "Results", "Govern"]);
    // The section link points at its first screen, not the page on screen, so it is current "true", never "page".
    expect(html.match(/class="mod"[^>]*aria-current="[^"]*"/g)).toEqual([`class="mod" href="#/ws/${WS}/market/curves" aria-current="true"`]);
    expect(html).toContain(`href="#/ws/${WS}/run/setups"`);
  });
  it("carries none of the four old pills", () => {
    const html = shell(at("results", "nii", { result: "run-20260926-175550-0015a15" }));
    for (const key of ["Book", "As of", "Plan", "Run"]) expect(html).not.toMatch(new RegExp(`class="pill-key"[^>]*>${key}<`));
    expect(html).not.toContain("class=\"pill pill-select\" type=\"button\" title=\"Book");
    expect(html).not.toContain("none</bdi>");
  });
  it("rail lists the open section's screens in table order, the current one marked, with no Soon tag", () => {
    const html = shell(at("market", "indices"));
    const rail = html.slice(html.indexOf('<aside class="rail">'), html.indexOf("</aside>"));
    const labels = [...rail.matchAll(/class="rail-item"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Yield curves", "Curve setups", "Derived curves", "Volatility surfaces", "Rate model", "Rate indices", "Macro factors"]);
    expect(rail).toMatch(/aria-current="page"[^>]*>Rate indices</);
    expect(rail).toContain(`<div class="rail-group-label">Market</div>`);
    expect(html).not.toContain('class="soon-tag"');
  });
  it("the Run section's rail lists its five core screens, Scenario library after Run setups", () => {
    const html = shell(at("run", "scenarios"));
    const rail = html.slice(html.indexOf('<aside class="rail">'), html.indexOf("</aside>"));
    const labels = [...rail.matchAll(/class="rail-item"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Run setups", "Scenario library", "Batches", "Queue and history", "Single instrument"]);
    expect(rail).toMatch(/aria-current="page"[^>]*>Scenario library</);
  });
  it("head band shows Section / Screen and the screen title", () => {
    const html = shell(at("results", "nii"));
    expect(html).toContain('<h1 class="page-title">Earnings (NII)</h1>');
    expect(html).toContain('<p class="head-crumb">Results / Earnings (NII)</p>');
  });
  it("the Workspace section's crumb is Workspace / Overview", () => {
    expect(shell(at("workspace", "overview"))).toContain('<p class="head-crumb">Workspace / Overview</p>');
  });
  it("Home, New and Compare sit outside a workspace: the switcher reads Workspaces and the rail lists the three pages", () => {
    const home = shell({ kind: "home", query: {} });
    expect(home).toContain(">Workspaces<");
    expect(home).toContain('<h1 class="page-title">Workspaces</h1>');
    const rail = home.slice(home.indexOf('<aside class="rail">'), home.indexOf("</aside>"));
    expect([...rail.matchAll(/class="rail-item"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["All workspaces", "New workspace", "Compare workspaces"]);
    expect(rail).toMatch(/aria-current="page"[^>]*>All workspaces</);
    expect(shell({ kind: "new", query: {} })).toContain('<h1 class="page-title">New workspace</h1>');
    expect(shell({ kind: "compare", query: {} })).toContain('<h1 class="page-title">Compare workspaces</h1>');
  });
  it("the head band holds the section's readiness chip beside the title, and the manifest meta below it", () => {
    const html = shell(at("balance", "positions"), { readinessState: READINESS.sections.balance, meta: "Book synthetic-2500-v1" });
    expect(html).toContain('<div class="head-title-row"><h1 class="page-title">Positions and import</h1><span class="status chip-readiness chip-readiness-warning">Warning</span></div>');
    expect(html).toContain('<p class="head-meta">Book synthetic-2500-v1</p>');
    expect(shell(at("balance", "positions"))).not.toContain("chip-readiness");
  });
  it("shows the stale banner with the document id when health reports a stale seed", () => {
    const html = shell(at("results", "dashboard"), { health });
    expect(html).toContain("market/market-public-2026-03-31");
    expect(html).toContain("reported, never rewritten");
    // The wrapper carries only the banner class; the stale colour lives on the chip.
    expect(html).toContain('<div class="banner" role="status"><span class="status status-stale">Stale</span>');
  });
  it("shows the retired banner with the document id and the retire command when health reports a retired seed", () => {
    const html = shell(at("results", "dashboard"), { health: retiredHealth });
    expect(html).toContain('<span class="status status-stale">Retired</span>');
    expect(html).toContain("market/market-2026-03-31");
    expect(html).toContain("npm run platform:seed -- --retire market/market-2026-03-31");
    expect(html).not.toContain(">Stale<");
  });
  it("a selector pill carries its full value in the title, so an ellipsis never hides it", () => {
    const html = renderToStaticMarkup(<SelectPill label="Run" value="run-20260926-175550-0015a15" options={[]} />);
    expect(html).toContain('title="Run: run-20260926-175550-0015a15"');
    expect(html).toContain('<span class="mono pill-value"><bdi dir="ltr">run-20260926-175550-0015a15</bdi></span>');
  });
  it("carries no assistant strip (removed in the teaching build, slice A3)", () => {
    expect(shell(at("results", "dashboard"))).not.toContain('class="assist-strip"');
  });
});
