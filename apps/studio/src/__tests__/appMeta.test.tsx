// apps/studio/src/__tests__/appMeta.test.tsx
/**
 * The frame App loads and the head band's meta line (Piece E2). The four-pill context (chipsFor), the catalog meta
 * (metaFor) and the book and as-of resolution are gone: the head names the book and the snapshot, the meta line prints
 * the head's own facts, and an old address resolves against the store once. Expected values are restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, type HealthInfo, type PortfolioListItem, type WorkspaceRunRow } from "@alm/reader";
import { errorText, frameReadKey, loadFrame, type FrameApi } from "../App";
import { parseHash } from "../router";
import { HeadBand } from "../shell/HeadBand";
import type { LegacyApi } from "../resolveLegacy";
import { HEAD, OTHERS, READINESS } from "./fixtures/workspace";

const HEALTH = { engineVersion: "x", seed: { stale: [], retired: [] } } as unknown as HealthInfo;
const BOOKS = [
  { id: "synthetic-2500-v1", positionCount: 2351 },
  { id: "vanilla-book-v1", positionCount: 12 },
] as unknown as PortfolioListItem[];
const RUNS = [
  { runId: "r1", status: { state: "done" } },
  { runId: "r2", status: { state: "error" } },
  { runId: "r3", status: null },
  { runId: "r4", status: { state: "done" } },
] as unknown as WorkspaceRunRow[];

interface Calls { head: string[]; readiness: string[]; portfolios: number; runs: string[] }
function fakeApi(over: Partial<FrameApi> = {}, legacy?: Partial<LegacyApi>): { api: FrameApi; calls: Calls } {
  const calls: Calls = { head: [], readiness: [], portfolios: 0, runs: [] };
  const api: FrameApi = {
    getHealth: async () => HEALTH,
    listWorkspaces: async () => [HEAD, ...OTHERS],
    getWorkspace: async (id) => { calls.head.push(id); return HEAD; },
    getReadiness: async (id) => { calls.readiness.push(id); return READINESS; },
    listPortfolios: async () => { calls.portfolios += 1; return BOOKS; },
    listWorkspaceRuns: async (id) => { calls.runs.push(id); return RUNS; },
    legacy: () => ({
      listWorkspaces: async () => [{ id: HEAD.id, bookId: "synthetic-2500-v1", setupPlanIds: [] }],
      workspacesOfRun: async () => [],
      ...legacy,
    }),
    ...over,
  };
  return { api, calls };
}

describe("the frame", () => {
  it("a workspace screen loads the head, its readiness, the book's store meta and the done-run count", async () => {
    const { api, calls } = fakeApi();
    const route = parseHash(`#/ws/${HEAD.id}/balance/positions`);
    const f = await loadFrame(route, api);
    expect(f.route).toEqual(route);
    expect(f.head).toBe(HEAD);
    expect(f.readiness).toBe(READINESS);
    expect(f.bookMeta).toEqual({ positionCount: 2351, doneRunCount: 2 });
    expect(f.workspaces.map((w) => w.id)).toEqual([HEAD.id, ...OTHERS.map((w) => w.id)]);
    expect(f.failure).toBeNull();
    expect(f.banner).toBeNull();
    expect(calls.head).toEqual([HEAD.id]);
  });
  it("Home, New and Compare read the list and health only", async () => {
    for (const hash of ["#/workspaces", "#/workspaces/new", "#/workspaces/compare?a=x&b=y"]) {
      const { api, calls } = fakeApi();
      const f = await loadFrame(parseHash(hash), api);
      expect(f.head, hash).toBeNull();
      expect(f.readiness, hash).toBeNull();
      expect(calls.head, hash).toEqual([]);
      expect(calls.portfolios, hash).toBe(0);
    }
  });
  it("a failed readiness, book list or run list degrades to none and the meta line says Unobservable; the head still loads", async () => {
    const down = async () => { throw new ApiError(500, "internal", "boom"); };
    const { api } = fakeApi({ getReadiness: down, listPortfolios: down, listWorkspaceRuns: down });
    const f = await loadFrame(parseHash(`#/ws/${HEAD.id}/results/nii`), api);
    expect(f.head).toBe(HEAD);
    expect(f.readiness).toBeNull();
    expect(f.bookMeta).toEqual({ positionCount: null, doneRunCount: null });
    expect(f.failure).toBeNull();
  });
  it("a head that cannot be read is a sentence naming the workspace and the reason, and no head", async () => {
    const { api } = fakeApi({ getWorkspace: async () => { throw new ApiError(404, "not-found", "no such workspace"); } });
    const f = await loadFrame(parseHash("#/ws/ws-gone/market/curves"), api);
    expect(f.head).toBeNull();
    expect(f.failure).toBe("Workspace ws-gone could not be read: 404: no such workspace");
  });
  it("health and the workspace list stay fatal", async () => {
    const down = new Error("down");
    await expect(loadFrame(parseHash("#/workspaces"), fakeApi({ getHealth: async () => { throw down; } }).api)).rejects.toThrow("down");
    await expect(loadFrame(parseHash("#/workspaces"), fakeApi({ listWorkspaces: async () => { throw down; } }).api)).rejects.toThrow("down");
  });
  it("an old address is resolved against the store, once, into a screen of the workspace its evidence names", async () => {
    const { api, calls } = fakeApi();
    const f = await loadFrame(parseHash("#/data/market/curves?book=synthetic-2500-v1"), api);
    expect(f.route).toEqual({ kind: "screen", ws: HEAD.id, section: "market", screen: "curves", query: {} });
    expect(f.head).toBe(HEAD);
    expect(calls.head).toEqual([HEAD.id]);
  });
  it("an old address that names no workspace lands on Home with the banner naming it", async () => {
    const { api } = fakeApi();
    const f = await loadFrame(parseHash("#/data/market/curves"), api);
    expect(f.route.kind).toBe("home");
    expect(f.head).toBeNull();
    expect(f.banner).toEqual({ oldAddress: "#/data/market/curves", candidates: [] });
  });
});

describe("head band", () => {
  it("prints no meta line when there is none", () => {
    expect(renderToStaticMarkup(<HeadBand crumb="Govern / Model inventory" title="Model inventory" meta={null} />)).not.toContain("head-meta");
    expect(renderToStaticMarkup(<HeadBand crumb="Market / Yield curves" title="Yield curves" meta="m" />)).toContain('<p class="head-meta">m</p>');
  });
  it("puts the chip beside the title only when there is one", () => {
    expect(renderToStaticMarkup(<HeadBand crumb="c" title="t" meta={null} />)).not.toContain("head-title-row");
    expect(renderToStaticMarkup(<HeadBand crumb="c" title="t" meta={null} chip={<span>chip</span>} />)).toContain('<div class="head-title-row"><h1 class="page-title">t</h1><span>chip</span></div>');
  });
});

describe("the error line", () => {
  it("a non-JSON failure names the status once, in words; a server reply keeps its status and message", () => {
    expect(errorText(new ApiError(502, "http-error", "502 Bad Gateway"))).toBe("The request failed with HTTP 502 and the reply gave no reason.");
    expect(errorText(new ApiError(500, "internal", "boom"))).toBe("500: boom");
    // A rejected fetch is a TypeError; it reads as the platform not being reached, never the browser's raw text (final review M1).
    expect(errorText(new TypeError("Failed to fetch"))).toBe("The platform could not be reached. Is it running? Start it with npm run platform, then reload.");
    expect(errorText(new Error("boom"))).toBe("The platform did not answer: boom. Start it with npm run platform, then reload.");
  });
});

describe("frameReadKey, what makes the frame read again", () => {
  it("moves with the screen inside one workspace, so the head band's done-run count and the section chip are read when a screen opens", () => {
    const a = frameReadKey(parseHash("#/ws/ws-synthetic-2500-v1/run/setups"));
    const b = frameReadKey(parseHash("#/ws/ws-synthetic-2500-v1/results/dashboard"));
    expect(a).toBe("ws:ws-synthetic-2500-v1:run/setups");
    expect(b).toBe("ws:ws-synthetic-2500-v1:results/dashboard");
    expect(a).not.toBe(b);
  });
  it("is the frame key itself outside a workspace screen", () => {
    expect(frameReadKey(parseHash("#/workspaces"))).toBe("workspaces");
  });
});
