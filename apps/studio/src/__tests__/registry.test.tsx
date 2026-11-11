// apps/studio/src/__tests__/registry.test.tsx
/**
 * The Studio registry: a pack's screens, Results tabs, Dashboard headlines, Home cards and record slots,
 * registered here with synthetic ids, reach the rail, the router, pageFor, the Results frame and Home; with nothing
 * registered every read is the core set (routerForward.test.ts, pageFor.test.tsx). Registrations are per test file:
 * each vitest file has its own module graph.
 */
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCREENS, parseHash, screenDef, screensOf, type Route } from "../router";
import { pageFor } from "../pages/pageFor";
import { tabBody } from "../pages/results/tabs";
import { resultsScreenOfTab } from "../pageLinks";
import { HomeView } from "../pages/workspace/HomePage";
import {
  recordSlot, registerHeadline, registerHomeCard, registerRecordSlot, registerResultTab, registerScreen, registeredHeadlines,
} from "../registry";
import { HEAD } from "./fixtures/workspace";

function DemoPage(props: { ws: string }) {
  return <p>demo page of {props.ws}</p>;
}

registerScreen({ section: "run", screen: "demo-page", label: "Demo page", after: "batches", page: (ctx) => <DemoPage ws={ctx.ws} /> });
registerResultTab({ id: "demo-tab", body: (p) => <p>demo tab of {p.runId}</p> });
registerScreen({ section: "results", screen: "demo-tab", label: "Demo tab", resultsTab: "demo-tab" });
registerHeadline({ id: "demo-headline", render: ({ result }) => <p>demo headline {result.provenance.runId}</p> });
registerHomeCard({ id: "demo-card", render: ({ workspaces }) => (workspaces.length > 0 ? <section aria-label="Demo card">{workspaces.length} workspaces</section> : null) });
registerRecordSlot({ slot: "setup-demo-record", title: "Launched from the demo record setup" });

const at = (section: string, screen: string): Route => ({ kind: "screen", ws: HEAD.id, section, screen, query: {} }) as Route;
const nameOf = (el: unknown) => ((el as ReactElement).type as { name: string }).name;

describe("registered screens", () => {
  it("sit in the rail after the screen they name, and the core table is untouched", () => {
    expect(screensOf("run").map((s) => s.screen)).toEqual(["setups", "scenarios", "batches", "demo-page", "queue", "instrument"]);
    expect(screensOf("results").map((s) => s.screen).at(-1)).toBe("demo-tab");
    expect(SCREENS.some((s) => s.screen === "demo-page")).toBe(false);
    expect(screenDef("run", "demo-page")).toEqual({ section: "run", screen: "demo-page", label: "Demo page", legacyLayers: [] });
  });

  it("are routes the hash parser accepts; an unregistered id still goes home", () => {
    expect(parseHash("#/ws/ws-a/run/demo-page")).toMatchObject({ kind: "screen", section: "run", screen: "demo-page" });
    expect(parseHash("#/ws/ws-a/run/nothing-here")).toMatchObject({ kind: "home" });
  });

  it("render their own page through pageFor's default arm, or the registered tab inside the results frame", () => {
    const page = pageFor(at("run", "demo-page"), HEAD);
    expect(renderToStaticMarkup(page as ReactElement)).toBe(`<p>demo page of ${HEAD.id}</p>`);
    const results = pageFor(at("results", "demo-tab"), HEAD) as ReactElement<{ tab: string }>;
    expect(nameOf(results)).toBe("ResultsLayer");
    expect(results.props.tab).toBe("demo-tab");
  });
});

describe("registered tabs, headlines, cards and record slots", () => {
  it("a registered tab links to the Results screen registered for it; an unknown tab links to the dashboard", () => {
    expect(resultsScreenOfTab("demo-tab")).toBe("demo-tab");
    expect(resultsScreenOfTab("nii")).toBe("nii");
    expect(resultsScreenOfTab("nothing-here")).toBe("dashboard");
    expect(resultsScreenOfTab("tieout")).toBe("dashboard");
  });

  it("a registered tab has a body; a core tab keeps its own; an unknown one has none", () => {
    expect(tabBody("demo-tab")).toBeDefined();
    expect(tabBody("nii")).toBeDefined();
    expect(tabBody("nothing-here")).toBeUndefined();
  });

  it("the headline and the record slot are listed as registered", () => {
    expect(registeredHeadlines().map((h) => h.id)).toEqual(["demo-headline"]);
    expect(recordSlot("setup-demo-record")?.title).toBe("Launched from the demo record setup");
    expect(recordSlot(null)).toBeUndefined();
  });

  it("Home shows a registered card above the workspace list", () => {
    const html = renderToStaticMarkup(<HomeView workspaces={[HEAD]} banner={null} />);
    expect(html).toContain('<section aria-label="Demo card">1 workspaces</section>');
    expect(html.indexOf('aria-label="Demo card"')).toBeLessThan(html.indexOf('aria-label="Workspace actions"'));
  });

  it("refuses a second registration of the same id, a core id, and a screen with both a page and a tab", () => {
    expect(() => registerScreen({ section: "run", screen: "demo-page", label: "Again", page: () => null })).toThrow(/already registered/);
    expect(() => registerResultTab({ id: "demo-tab", body: () => null })).toThrow(/already registered/);
    expect(() => registerScreen({ section: "run", screen: "both", label: "Both", page: () => null, resultsTab: "demo-tab" })).toThrow(/exactly one/);
    expect(() => registerRecordSlot({ slot: "setup-demo-record", title: "x" })).toThrow(/already registered/);
    // A pack id that collides with a core screen or tab is refused, so the rail never shows a screen twice.
    expect(() => registerScreen({ section: "run", screen: "batches", label: "Again", page: () => null })).toThrow(/is a core screen/);
    expect(() => registerResultTab({ id: "nii", body: () => null })).toThrow(/is a core tab/);
  });
});
