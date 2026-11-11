/**
 * The Studio top bar, the manifest meta line and the readiness chip (Piece E2, spec v3.1 Sections 3.4, 3.5 and 3.7).
 * Studio tests have no DOM: the markup is the server render. The bar carries the workspace switcher in place of the
 * four old pills; the seven sections come from the SCREENS table; the sheet a phone opens holds the switcher, the
 * sections with their screens and the theme switch. Expected values and texts are restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "../shell/TopBar";
import { manifestMeta } from "../shell/manifestMeta";
import { READINESS_ESCALATION, ReadinessChip } from "../shell/ReadinessChip";
import { WorkspaceSwitcher, switcherGroups } from "../shell/WorkspaceSwitcher";
import { HEAD, OTHERS, READINESS } from "./fixtures/workspace";

const inWs = { kind: "screen" as const, ws: "ws-synthetic-2500-v1", section: "balance" as const, screen: "positions" as const, query: {} };
const home = { kind: "home" as const, query: {} };
const SECTIONS = ["Workspace", "Market", "Balance Sheet", "Assumptions", "Run", "Results", "Govern"];

describe("top bar", () => {
  it("renders the switcher with name, type badge and cut-off, the seven sections in order, and no Book, As of, Plan or Run pill", () => {
    const html = renderToStaticMarkup(<TopBar route={inWs} head={HEAD} workspaces={[HEAD]} ctxOpen={false} onCtx={() => {}} />);
    const bar = html.slice(html.indexOf('class="modbar"'), html.indexOf('class="topbar-ctx"'));
    const labels = [...bar.matchAll(/class="mod"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(SECTIONS);
    expect(html).toContain(HEAD.name);
    expect(html).toContain("cut-off 2026-03-31");
    expect(html).toMatch(/type-badge[^>]*>Test</);
    // No old pill: no pill key reads Book, As of, Plan or Run, and no pill carries a run id or the word none.
    for (const key of ["Book", "As of", "Plan", "Run"]) expect(html).not.toMatch(new RegExp(`class="pill-key"[^>]*>${key}<`));
    expect(html).not.toContain("pill-label");
    expect(html).not.toContain(">none<");
    // The open section is current; the others are not.
    expect(html.match(/class="mod"[^>]*aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/class="mod"[^>]*aria-current="true"[^>]*>Balance Sheet</);
  });
  it("each section links to its first screen inside the current workspace", () => {
    const html = renderToStaticMarkup(<TopBar route={inWs} head={HEAD} workspaces={[HEAD]} ctxOpen={false} onCtx={() => {}} />);
    const base = "#/ws/ws-synthetic-2500-v1";
    for (const [section, screen] of [["workspace", "overview"], ["market", "curves"], ["balance", "positions"], ["assumptions", "prepay"], ["run", "setups"], ["results", "dashboard"], ["govern", "lineage"]]) {
      expect(html).toContain(`class="mod" href="${base}/${section}/${screen}"`);
    }
  });
  it("outside a workspace the pill reads Workspaces and the sections are disabled with a title", () => {
    const html = renderToStaticMarkup(<TopBar route={home} head={null} workspaces={[HEAD]} ctxOpen={false} onCtx={() => {}} />);
    expect(html).toContain(">Workspaces<");
    // The seven sections and the Analysis entry in front of them.
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(8);
    expect(html).toContain('title="Open a workspace first"');
    expect(html).not.toContain('class="mod" href=');
  });
  it("the wordmark returns to Workspace Home, and carries no selection", () => {
    const html = renderToStaticMarkup(<TopBar route={inWs} head={HEAD} workspaces={[HEAD]} ctxOpen={false} onCtx={() => {}} />);
    expect(html).toContain('<a class="wordmark" href="#/workspaces">');
  });
});

describe("the phone sheet", () => {
  const sheet = (open: boolean) => renderToStaticMarkup(<TopBar route={inWs} head={HEAD} workspaces={[HEAD]} ctxOpen={open} onCtx={() => {}} />);
  it("the context button reads Workspace and the workspace's name", () => {
    expect(sheet(false)).toContain(`title="Working context. Workspace: ${HEAD.name}">Workspace <span class="mono">${HEAD.name}</span></button>`);
  });
  it("a crumb chip names Section > Screen and opens the sheet that lists the seven sections with their screens", () => {
    const html = sheet(false);
    expect(html).toContain("Balance Sheet &gt; Positions and import");
    const nav = html.slice(html.indexOf('class="section-sheet"'));
    const heads = [...nav.matchAll(/class="section-sheet-head">([^<]+)</g)].map((m) => m[1]);
    expect(heads).toEqual(SECTIONS);
    expect(nav).toContain('href="#/ws/ws-synthetic-2500-v1/market/rate-model"');
    expect(nav).toMatch(/aria-current="page"[^>]*>Positions and import</);
  });
  it("is a modal dialog only while open", () => {
    expect(sheet(false)).not.toContain('role="dialog"');
    expect(sheet(true)).toContain('role="dialog" aria-modal="true"');
  });
});

describe("workspace switcher", () => {
  it("groups Production first, then Monthly newest first, then Test, FTP and Stress, with History last", () => {
    const groups = switcherGroups([HEAD, ...OTHERS, { ...HEAD, id: "ws-monthly-2026-02", name: "February monthly", type: "monthly", cutoffDate: "2026-02-28" }]);
    expect(groups.map((g) => g.label)).toEqual(["Production", "Monthly", "Test", "Stress", "History"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["ws-monthly-2026-02", "ws-monthly-2026-01"]);
    expect(groups[4]!.rows.map((r) => r.id)).toEqual(["ws-old"]);
  });
  it("a locked Production workspace still sits under Production; superseded and archived ones go to History", () => {
    const groups = switcherGroups([...OTHERS, { ...HEAD, id: "ws-sup", type: "production", status: "superseded" }]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["ws-prod-2026-02"]);
    expect(groups.at(-1)!.rows.map((r) => r.id).sort()).toEqual(["ws-old", "ws-sup"]);
  });
  it("lists every workspace with its type and cut-off date, the current one marked", () => {
    const html = renderToStaticMarkup(<WorkspaceSwitcher head={HEAD} workspaces={[HEAD, ...OTHERS]} defaultOpen />);
    for (const w of [HEAD, ...OTHERS]) {
      expect(html).toContain(w.name);
      expect(html).toContain(`href="#/ws/${w.id}/workspace/overview"`);
    }
    expect(html).toContain("cut-off 2026-02-28");
    for (const label of ["Production", "Monthly", "Test", "Stress"]) expect(html).toMatch(new RegExp(`type-badge[^>]*>${label}<`));
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain(">All workspaces<");
  });
  it("the pill reads the workspace name and its cut-off, never a catalog path", () => {
    const html = renderToStaticMarkup(<WorkspaceSwitcher head={HEAD} workspaces={[HEAD]} />);
    expect(html).toContain(`<span class="switcher-name">${HEAD.name}</span>`);
    expect(html).not.toContain("/api/catalog");
  });
});

describe("manifest meta line", () => {
  const m = (section: string, bookMeta = { positionCount: 2351 as number | null, doneRunCount: 3 as number | null }) =>
    renderToStaticMarkup(<>{manifestMeta(section as never, HEAD, bookMeta)}</>);
  it("prints the block's own facts per section, cut-off on every section except Govern, and never a catalog path", () => {
    expect(m("balance")).toContain("synthetic-2500-v1");
    expect(m("balance")).toContain("2,351");
    expect(m("balance")).toContain("cut-off 2026-03-31");
    expect(m("market")).toContain("market-public-2026-03-31");
    expect(m("market")).toContain("3 derived");
    expect(m("assumptions")).toContain("16 sets");
    expect(m("assumptions")).toContain("default demo-behavioral-v1");
    expect(m("run")).toContain("9 setups");
    expect(m("run")).toContain("3 done runs");
    for (const s of ["workspace", "market", "balance", "assumptions", "run", "results"]) expect(m(s), s).toContain("cut-off 2026-03-31");
    expect(m("govern")).not.toContain("cut-off");
    for (const s of ["balance", "market", "assumptions", "run", "results", "workspace", "govern"]) expect(m(s), s).not.toContain("/api/catalog");
  });
  it("a count of exactly one takes the singular noun (Studio Part 2 m8)", () => {
    const one = { ...HEAD, blocks: { ...HEAD.blocks, assumptions: { ...HEAD.blocks.assumptions, sets: HEAD.blocks.assumptions.sets.slice(0, 1) }, run: { ...HEAD.blocks.run, setups: HEAD.blocks.run.setups.slice(0, 1) } } };
    const text = (section: string, bookMeta: { positionCount: number | null; doneRunCount: number | null }) =>
      renderToStaticMarkup(<>{manifestMeta(section as never, one, bookMeta)}</>);
    expect(text("assumptions", { positionCount: 1, doneRunCount: 1 })).toContain("1 set");
    expect(text("assumptions", { positionCount: 1, doneRunCount: 1 })).not.toContain("1 sets");
    expect(text("balance", { positionCount: 1, doneRunCount: 1 })).toContain("1 position");
    expect(text("balance", { positionCount: 1, doneRunCount: 1 })).not.toContain("1 positions");
    expect(text("run", { positionCount: 1, doneRunCount: 1 })).toContain("1 setup");
    expect(text("run", { positionCount: 1, doneRunCount: 1 })).toContain("1 done run");
    expect(text("run", { positionCount: 1, doneRunCount: 1 })).not.toContain("1 done runs");
    expect(text("run", { positionCount: 1, doneRunCount: 0 })).toContain("0 done runs");
  });
  it("the Workspace and Govern lines carry the type, the revision and whether the head is signed and locked", () => {
    expect(m("workspace")).toContain("Test");
    expect(m("workspace")).toContain("revision 4");
    expect(m("workspace")).toContain("not locked");
    expect(m("govern")).toContain("revision 4");
    const locked = { ...HEAD, type: "production" as const, lock: { lockedAt: "2026-10-09T10:00:00.000Z", by: "Chih", approvalId: "ap-1", signedHash: "abcdef0123456789" } };
    const text = renderToStaticMarkup(<>{manifestMeta("govern", locked, { positionCount: null, doneRunCount: null })}</>);
    expect(text).toContain("Production");
    expect(text).toContain("signed and locked 2026-10-09 by Chih");
    expect(text).not.toContain("cut-off");
    expect(renderToStaticMarkup(<>{manifestMeta("workspace", locked, { positionCount: null, doneRunCount: null })}</>)).toContain("signed and locked");
  });
  it("says so when a block is empty or a count is unobservable, in words", () => {
    const empty = { ...HEAD, blocks: { ...HEAD.blocks, positions: { ...HEAD.blocks.positions, book: null }, market: { ...HEAD.blocks.market, snapshot: null, derived: [] }, assumptions: { ...HEAD.blocks.assumptions, sets: [], defaultSetId: null } } };
    const text = (section: string) => renderToStaticMarkup(<>{manifestMeta(section as never, empty, { positionCount: null, doneRunCount: null })}</>);
    expect(text("balance")).toContain("no positions attached");
    expect(text("market")).toContain("no base snapshot");
    expect(text("assumptions")).toContain("0 sets");
    expect(text("assumptions")).toContain("no default set");
    expect(m("balance", { positionCount: null, doneRunCount: null })).toContain("positions Unobservable");
  });
});

describe("readiness chip", () => {
  it("one token class per state and the escalation word", () => {
    for (const [state, word] of [["valid", "Valid"], ["not-set", "Not set"], ["draft", "Draft"], ["warning", "Warning"], ["error", "Error"], ["stale", "Stale"]] as const) {
      const html = renderToStaticMarkup(<ReadinessChip state={state} />);
      expect(html).toContain(`chip-readiness-${state}`);
      expect(html).toContain(`>${word}<`);
      expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });
  it("shows the server's worst counted state of the section: an optional Not set never counts", () => {
    expect(renderToStaticMarkup(<ReadinessChip state={READINESS.sections.balance} />)).toContain("Warning");
    // Run holds a required Stale item and an optional Not set one: the chip reads Stale.
    expect(renderToStaticMarkup(<ReadinessChip state={READINESS.sections.run} />)).toContain(">Stale<");
  });
  it("escalation order, worst first", () => {
    expect(READINESS_ESCALATION).toEqual(["error", "not-set", "stale", "warning", "draft", "valid"]);
  });
});
