/**
 * The shell on a phone (ALM Studio phone 1,
 * and Piece E2: the sections, the rail and the switcher). Studio tests have no DOM: the markup is the server render,
 * and the sheet's open and close, the run tail and the chip scroll are pure functions. What only a layout engine shows
 * (the rows, the sheet over its scrim, focus moving, no sideways scroll at 375 px) is the review's 390 px probe.
 * Expected values and texts are restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Shell } from "../shell/Shell";
import { TopBar } from "../shell/TopBar";
import { chipScrollLeft, ctxSheet, runTail, trapTab } from "../shell/phone";
import type { Route } from "../router";
import { HEAD, OTHERS } from "./fixtures/workspace";

const inWs: Route = { kind: "screen", ws: HEAD.id, section: "results", screen: "nii", query: {} };
const shell = (route: Route = inWs, head = HEAD as typeof HEAD | null) =>
  renderToStaticMarkup(<Shell route={route} head={head} workspaces={[HEAD, ...OTHERS]} readinessState={null} meta={null} health={null}><div /></Shell>);

describe("the context button", () => {
  it("reads Workspace and the open workspace's name", () => {
    expect(shell()).toContain(`<button class="ctx-button" type="button" aria-expanded="false" aria-controls="ctx-sheet" title="Working context. Workspace: ${HEAD.name}">Workspace <span class="mono">${HEAD.name}</span></button>`);
  });
  it("reads Workspace none outside a workspace", () => {
    expect(shell({ kind: "home", query: {} }, null)).toContain('title="Working context. Workspace: none">Workspace <span class="mono">none</span></button>');
  });
  it("comes before the section row, so the tab order follows the phone's rows", () => {
    const html = shell();
    expect(html.indexOf('class="wordmark"')).toBeLessThan(html.indexOf('class="ctx-button"'));
    expect(html.indexOf('class="ctx-button"')).toBeLessThan(html.indexOf('class="nav-chip"'));
    expect(html.indexOf('class="nav-chip"')).toBeLessThan(html.indexOf('class="modbar"'));
  });
});

describe("the context sheet markup", () => {
  it("is the top bar's context group itself: the switcher, the sections and the theme control, each rendered once", () => {
    const html = shell();
    expect(html).toContain('<div class="topbar-ctx" id="ctx-sheet">');
    expect(html.match(/class="pill-menu-wrap switcher"/g)).toHaveLength(1);
    expect(html.match(/class="section-sheet"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Theme"/g)).toHaveLength(1);
    expect(html.match(/class="theme-cycle"/g)).toHaveLength(1);
  });
  it("carries a heading and a close button ahead of the switcher, and a scrim after the group", () => {
    const html = shell();
    expect(html).toContain('<div class="ctx-sheet-head"><h2 class="ctx-sheet-title" id="ctx-sheet-title">Working context</h2><button class="ctx-sheet-close" type="button" aria-label="Close working context">');
    expect(html.indexOf('class="ctx-sheet-head"')).toBeLessThan(html.indexOf('class="pill-menu-wrap switcher"'));
    expect(html).toContain('<div class="ctx-scrim" aria-hidden="true"></div>');
    expect(html.indexOf('id="ctx-sheet"')).toBeLessThan(html.indexOf('class="ctx-scrim"'));
  });
  it("is a modal dialog only while open, and marks the group and the scrim open", () => {
    const shut = renderToStaticMarkup(<TopBar route={inWs} head={HEAD} workspaces={[HEAD]} ctxOpen={false} onCtx={() => {}} />);
    expect(shut).not.toContain('role="dialog"');
    expect(shut).not.toContain("data-open");
    const open = renderToStaticMarkup(<TopBar route={inWs} head={HEAD} workspaces={[HEAD]} ctxOpen={true} onCtx={() => {}} />);
    expect(open).toContain('<div class="topbar-ctx" id="ctx-sheet" data-open="true" role="dialog" aria-modal="true" aria-labelledby="ctx-sheet-title">');
    expect(open).toContain('aria-expanded="true" aria-controls="ctx-sheet"');
    expect(open).toContain('<div class="ctx-scrim" aria-hidden="true" data-open="true"></div>');
  });
  it("keeps the wordmark's accessible name whole: Model Sense and ALM Studio both in the link", () => {
    expect(shell()).toContain('<span class="wordmark-brand">Model Sense</span> <span class="wordmark-product">ALM Studio</span></a>');
  });
});

describe("the section and rail row, merged for a phone", () => {
  it("is one crumb chip, Section then Screen, that opens the sheet; the rail keeps its label, links, order and current page for the desktop", () => {
    const html = shell();
    expect(html).toContain('<button class="nav-chip" type="button" aria-expanded="false" aria-controls="ctx-sheet">Results &gt; Earnings (NII)</button>');
    expect(html).toContain('<aside class="rail"><nav aria-label="Screens">');
    expect(html).toMatch(/class="rail-item"[^>]*aria-current="page">Earnings \(NII\)</);
  });
  it("the sheet lists every section with its screens, the current screen marked, links inside this workspace only", () => {
    const html = shell();
    const nav = html.slice(html.indexOf('class="section-sheet"'), html.indexOf('aria-label="Theme"'));
    const heads = [...nav.matchAll(/class="section-sheet-head">([^<]+)</g)].map((m) => m[1]);
    expect(heads).toEqual(["Workspace", "Market", "Balance Sheet", "Assumptions", "Run", "Results", "Govern"]);
    expect(nav.match(/class="section-sheet-item"/g)).toHaveLength(45); // the core screens; a pack registers its own
    for (const m of nav.matchAll(/class="section-sheet-item" href="([^"]+)"/g)) expect(m[1]!.startsWith(`#/ws/${HEAD.id}/`)).toBe(true);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav).toMatch(/aria-current="page">Earnings \(NII\)</);
  });
  it("at phone width the section bar and rail merge into one crumb chip that opens a sheet with the seven sections", () => {
    const html = shell({ kind: "screen", ws: HEAD.id, section: "balance", screen: "positions", query: {} });
    expect(html).toContain("Balance Sheet &gt; Positions and import");
    expect(html).toMatch(/class="section-sheet"[\s\S]*Workspace[\s\S]*Govern/);
    expect((html.match(/class="chip-row"/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(html.match(/class="nav-chip"/g)).toHaveLength(1);
    expect(html.match(/class="section-sheet-head"/g)).toHaveLength(7);
  });
  it("outside a workspace the chip reads Workspaces and there is no section list: only the switcher and the theme", () => {
    const html = shell({ kind: "home", query: {} }, null);
    expect(html).toContain('<button class="nav-chip" type="button" aria-expanded="false" aria-controls="ctx-sheet">Workspaces</button>');
    expect(html).not.toContain('class="section-sheet"');
  });
});

describe("ctxSheet, the sheet's open and close", () => {
  it("opens on open and on toggle from shut", () => {
    expect(ctxSheet(false, "open")).toBe(true);
    expect(ctxSheet(false, "toggle")).toBe(true);
  });
  it("shuts on close and on toggle from open", () => {
    expect(ctxSheet(true, "close")).toBe(false);
    expect(ctxSheet(true, "toggle")).toBe(false);
  });
  it("stays as it is when the event asks for what it already is", () => {
    expect(ctxSheet(true, "open")).toBe(true);
    expect(ctxSheet(false, "close")).toBe(false);
  });
});

describe("runTail", () => {
  it("is an ellipsis and the last seven characters of a long id", () => {
    expect(runTail("run-20260927-183526-001e52d")).toBe("…001e52d");
  });
  it("is none when no run is chosen or the query holds an empty run", () => {
    expect(runTail(undefined)).toBe("none");
    expect(runTail("")).toBe("none");
  });
  it("is the whole id when it has seven characters or fewer", () => {
    expect(runTail("r-1")).toBe("r-1");
    expect(runTail("abcdefg")).toBe("abcdefg");
  });
});

describe("chipScrollLeft, the chip row's scroll that brings the current chip into view", () => {
  const view = { left: 0, right: 390 };
  it("leaves a chip that is already in view where it is", () => {
    expect(chipScrollLeft(0, view, { left: 20, right: 100 }, 16)).toBe(0);
    expect(chipScrollLeft(40, view, { left: 16, right: 374 }, 16)).toBe(40);
  });
  it("scrolls right just far enough that a chip past the right edge ends 16 px inside it", () => {
    // 0 + 480 - 390 + 16
    expect(chipScrollLeft(0, view, { left: 400, right: 480 }, 16)).toBe(106);
  });
  it("scrolls left just far enough that a chip past the left edge starts 16 px inside it", () => {
    // 200 + (-50) - 0 - 16
    expect(chipScrollLeft(200, view, { left: -50, right: 30 }, 16)).toBe(134);
  });
  it("never asks for a scroll below zero", () => {
    expect(chipScrollLeft(4, view, { left: 0, right: 60 }, 16)).toBe(0);
  });
  it("puts a chip wider than the view at the left edge", () => {
    // 10 + 100 - 0 - 16
    expect(chipScrollLeft(10, view, { left: 100, right: 600 }, 16)).toBe(94);
  });
});

describe("trapTab, Tab and Shift+Tab held inside the open sheet", () => {
  it("wraps Tab from the last of five focusables to the first, and Shift+Tab from the first to the last", () => {
    expect(trapTab(5, 4, false)).toBe(0);
    expect(trapTab(5, 0, true)).toBe(4);
  });
  it("lets the browser move focus between the ends", () => {
    expect(trapTab(5, 2, false)).toBeNull();
    expect(trapTab(5, 2, true)).toBeNull();
    expect(trapTab(5, 0, false)).toBeNull();
    expect(trapTab(5, 4, true)).toBeNull();
  });
  it("brings focus that is outside the sheet back in: Tab to the first, Shift+Tab to the last", () => {
    expect(trapTab(5, -1, false)).toBe(0);
    expect(trapTab(5, -1, true)).toBe(4);
  });
  it("does nothing when the sheet holds nothing to focus", () => {
    expect(trapTab(0, -1, false)).toBeNull();
  });
});
