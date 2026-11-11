// apps/studio/src/__tests__/setupsPage.test.tsx
/**
 * Run > Run setups page and Batches: the loader degrades by read, the page reads its own head, a locked
 * workspace is read-only in words, and the file keeps its own stylesheet and shared files untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BatchesPage } from "../pages/run/BatchesPage";
import { loadCoaNodes, loadSetupsPage } from "../pages/run/loadSetups";
import { SetupsPage, readOnlyReason } from "../pages/run/SetupsPage";
import { HEAD, READINESS } from "./fixtures/workspace";
import { LIBRARIES, SLATES, STANDARD_ALCO } from "./fixtures/setup";

function mockFetch(table: Array<[string, unknown | "fail"]>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    const hit = table.find(([k]) => url.includes(k));
    if (!hit || hit[1] === "fail") return new Response(JSON.stringify({ error: { code: "not-found", message: `no fixture for ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

const SLOT = { setupLineageId: "setup-standard-alco", current: { collection: "run-setups", id: "rs-standard-alco", contentHash: "h", pinnedAt: "t" } };
const SETUPS = { setups: [{ slot: SLOT, setup: STANDARD_ALCO }], missing: [] };

describe("loadSetupsPage", () => {
  it("reads head, setups, readiness, runs, libraries and the workspace's slates only", async () => {
    const named = { ...HEAD, blocks: { ...HEAD.blocks, scenarios: { slates: [{ collection: "scenario-slates", id: "alco-user-slate", contentHash: "h", pinnedAt: "t" }] } } };
    mockFetch([
      ["/api/run-setups", SETUPS],
      ["/readiness", READINESS],
      ["/runs", []],
      ["/api/plans/library", LIBRARIES],
      ["/api/scenario-slates", [...SLATES, { id: "not-in-block", label: "Other", scenarios: [] }]],
      [`/api/workspaces/${HEAD.id}`, named],
    ]);
    const d = await loadSetupsPage(HEAD.id);
    expect(d.setups.setups).toHaveLength(1);
    expect(d.readiness?.launchable["setup-standard-alco"]).toBeDefined();
    expect(d.libraries.map((l) => l.id)).toEqual(["regulatory-grid-v1", "steepener-v1"]);
    expect(d.slates.map((s) => s.id)).toEqual(["alco-user-slate"]);
  });

  it("one failed secondary read never blanks the page; a failed head does", async () => {
    mockFetch([["/api/run-setups", SETUPS], ["/readiness", "fail"], ["/runs", "fail"], ["/api/plans/library", "fail"], ["/api/scenario-slates", "fail"], [`/api/workspaces/${HEAD.id}`, HEAD]]);
    const d = await loadSetupsPage(HEAD.id);
    expect(d.readiness).toBeNull();
    expect(d.runs).toEqual([]);
    expect(d.libraries).toEqual([]);
    expect(d.slates).toEqual([]);
    mockFetch([["/api/run-setups", SETUPS], [`/api/workspaces/${HEAD.id}`, "fail"]]);
    await expect(loadSetupsPage(HEAD.id)).rejects.toThrow();
  });

  it("loadCoaNodes maps the book's nodes and degrades to none", async () => {
    mockFetch([["/api/portfolios/b1", { id: "b1", coa: { nodes: [{ id: "n1", label: "Assets" }, { id: "n2", label: "Deposits" }], families: [] } }]]);
    expect(await loadCoaNodes("b1")).toEqual([{ id: "n1", label: "Assets" }, { id: "n2", label: "Deposits" }]);
    expect(await loadCoaNodes(null)).toEqual([]);
    mockFetch([["/api/portfolios/b1", "fail"]]);
    expect(await loadCoaNodes("b1")).toEqual([]);
  });
});

describe("readOnlyReason", () => {
  it("is null for an active workspace and a sentence for locked, archived and superseded ones", () => {
    expect(readOnlyReason(HEAD)).toBeNull();
    expect(readOnlyReason({ ...HEAD, status: "locked" })).toBe("This workspace is locked by its sign-off. Clone it to change a setup or to launch.");
    expect(readOnlyReason({ ...HEAD, status: "archived" })).toBe("This workspace is archived and read-only.");
    expect(readOnlyReason({ ...HEAD, status: "superseded" })).toBe("This workspace was superseded and is read-only.");
  });
});

describe("pages", () => {
  it("the setups page reads loading before its data arrives", () => {
    expect(renderToStaticMarkup(<SetupsPage ws={HEAD.id} head={HEAD} query={{}} />)).toContain("Reading the run setups");
  });
  it("the batches page reads loading before its data arrives", () => {
    expect(renderToStaticMarkup(<BatchesPage ws={HEAD.id} />)).toContain("Reading the run setups");
  });
});

describe("files", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("the page imports its own stylesheet once and app.css is not edited for it", () => {
    expect(read("../pages/run/SetupsPage.tsx").split('import "../../styles/run-setups.css";').length - 1).toBe(1);
    expect(read("../styles/app.css")).not.toContain("setups-layout");
  });
  it("the stylesheet uses tokens only", () => {
    const css = read("../styles/run-setups.css");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgba?|hsla?|oklch|color-mix)\(/);
  });
});
