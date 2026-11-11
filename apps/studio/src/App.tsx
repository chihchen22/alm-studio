/**
 * Studio root (Piece E2). One frame per workspace: the health report, the workspace list, the head of the open
 * workspace, its readiness and the book's store meta. An old address is resolved here, once, against the store and
 * then rewritten in place; an address that names no workspace lands on Workspace Home with a banner. Nothing here
 * computes a balance-sheet number; the meta line prints what the head and the store meta hold.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  getHealth,
  getReadiness,
  getWorkspace,
  listPortfolios,
  listWorkspaceRuns,
  listWorkspaces,
  type HealthInfo,
  type PortfolioListItem,
  type ReadinessReport,
  type WorkspaceManifest,
  type WorkspaceRunRow,
} from "@alm/reader";
import { useRoute, type Route } from "./router";
import { routeHref } from "./routeHref";
import { stashForwardBanner } from "./forwardBanner";
import { readerLegacyApi, resolveLegacyRoute, type ForwardBanner, type LegacyApi } from "./resolveLegacy";
import { Shell, headingFor } from "./shell/Shell";
import { manifestMeta, type BookMeta } from "./shell/manifestMeta";
import { pageFor, type PageEnv } from "./pages/pageFor";
import { pageErrText, reasonOf } from "./errText";

/** What one frame holds. `route` is the route the address resolved to: never a legacy one. */
export interface Frame {
  route: Route;
  health: HealthInfo;
  workspaces: WorkspaceManifest[];
  head: WorkspaceManifest | null;
  readiness: ReadinessReport | null;
  bookMeta: BookMeta;
  /** Why the open workspace could not be read, in words; null when it was. */
  failure: string | null;
  banner: ForwardBanner | null;
}

/** The reads a frame makes. `legacy` is the forwarder's evidence reader. */
export interface FrameApi {
  getHealth(): Promise<HealthInfo>;
  listWorkspaces(): Promise<WorkspaceManifest[]>;
  getWorkspace(id: string): Promise<WorkspaceManifest>;
  getReadiness(id: string): Promise<ReadinessReport>;
  listPortfolios(): Promise<PortfolioListItem[]>;
  listWorkspaceRuns(id: string): Promise<WorkspaceRunRow[]>;
  legacy(): LegacyApi;
}

export function readerFrameApi(): FrameApi {
  return { getHealth, listWorkspaces, getWorkspace, getReadiness, listPortfolios, listWorkspaceRuns, legacy: readerLegacyApi };
}

/**
 * Loads one frame. Health and the workspace list are fatal. The open workspace's head failing is carried as a
 * failure sentence; its readiness, the book's meta and its run list failing degrade to none, and the meta line says
 * Unobservable, so one failed read never blanks the page.
 */
export async function loadFrame(route: Route, api: FrameApi = readerFrameApi()): Promise<Frame> {
  const [health, workspaces] = await Promise.all([api.getHealth(), api.listWorkspaces()]);
  let at: Route = route;
  let banner: ForwardBanner | null = null;
  if (route.kind === "legacy") {
    const r = await resolveLegacyRoute(route, api.legacy());
    if (r.kind === "screen") at = r.slot === undefined ? { kind: "screen", ws: r.ws, section: r.section, screen: r.screen, query: r.query } : { kind: "screen", ws: r.ws, section: r.section, screen: r.screen, query: r.query, slot: r.slot };
    else {
      at = { kind: "home", query: {} };
      banner = r.banner ?? null;
    }
  }
  const frame: Frame = { route: at, health, workspaces, head: null, readiness: null, bookMeta: { positionCount: null, doneRunCount: null }, failure: null, banner };
  // A screen and a step of the Analysis path both read their workspace.
  if (at.kind !== "screen" && at.kind !== "analysis") return frame;
  const ws = at.ws;
  const [head, readiness, books, runs] = await Promise.all([
    api.getWorkspace(ws).then((h): WorkspaceManifest | string => h, (e: unknown) => (e instanceof ApiError ? pageErrText(e) : reasonOf(e))),
    api.getReadiness(ws).catch(() => null),
    api.listPortfolios().catch(() => null),
    api.listWorkspaceRuns(ws).catch(() => null),
  ]);
  if (typeof head === "string") return { ...frame, failure: `Workspace ${ws} could not be read: ${head}` };
  const bookId = head.blocks.positions.book?.id ?? null;
  return {
    ...frame,
    head,
    readiness,
    bookMeta: {
      positionCount: books === null || bookId === null ? null : books.find((b) => b.id === bookId)?.positionCount ?? null,
      doneRunCount: runs === null ? null : runs.filter((r) => r.status?.state === "done").length,
    },
  };
}

/** What a frame is reloaded by: the workspace for a screen, the typed address for an old one, and one key for Home, New and Compare, which read the same list. */
function frameKey(route: Route): string {
  return route.kind === "screen" || route.kind === "analysis" ? `ws:${route.ws}` : route.kind === "legacy" ? `legacy:${route.from}` : "workspaces";
}

/**
 * What makes the frame read again. The frame is replaced (loading) when `frameKey` moves; it is read again in place when
 * the screen inside one workspace moves, so the head band's done-run count and the section chip never keep the value
 * they had when a launch was queued (Slice 1 drive, step 8 of spec Section 3.6).
 */
export function frameReadKey(route: Route): string {
  if (route.kind === "analysis") return `${frameKey(route)}:analysis/${route.step}`;
  return route.kind === "screen" ? `${frameKey(route)}:${route.section}/${route.screen}` : frameKey(route);
}

type FrameState = { state: "loading" } | { state: "ok"; key: string; value: Frame } | { state: "error"; key: string; error: ApiError | Error };

export function App() {
  const route = useRoute();
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<FrameState>({ state: "loading" });
  const key = frameKey(route);
  const readKey = frameReadKey(route);
  useEffect(() => {
    let cancelled = false;
    // A refresh, or a move to another screen of the same workspace, keeps the frame on screen while it rereads; a different workspace or address starts from loading.
    setLoaded((prev) => (prev.state !== "loading" && prev.key === key ? prev : { state: "loading" }));
    loadFrame(route).then(
      (value) => { if (!cancelled) setLoaded({ state: "ok", key, value }); },
      (e: unknown) => { if (!cancelled) setLoaded({ state: "error", key, error: e instanceof Error ? e : new Error(String(e)) }); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readKey, tick]);
  // A frame loaded for another workspace or address is never shown for this one: the page reads loading until its own arrives.
  const frame: FrameState = loaded.state !== "loading" && loaded.key !== key ? { state: "loading" } : loaded;
  // The route to show: the live one, or for an old address the one it resolved to.
  const at: Route = route.kind === "legacy" && frame.state === "ok" ? frame.value.route : route;
  const stashedFor = useRef<string | null>(null);
  useEffect(() => {
    if (route.kind !== "legacy" || frame.state !== "ok") return;
    window.history.replaceState(null, "", routeHref(frame.value.route));
    // The banner is written once per typed address: a later reread of the same frame must not bring it back after Home took it.
    if (stashedFor.current !== route.from) {
      stashedFor.current = route.from;
      stashForwardBanner(frame.value.banner);
    }
  }, [route, frame]);
  useEffect(() => {
    document.title = `${headingFor(at).title} · ALM Studio`;
  }, [at]);
  const none: ReactNode = <div />;
  if (frame.state === "loading") return <Shell route={at} head={null} workspaces={[]} readinessState={null} meta="Loading the workspace" health={null}>{none}</Shell>;
  if (frame.state === "error") {
    return <Shell route={at} head={null} workspaces={[]} readinessState={null} meta="Workspaces unavailable" health={null}><div className="card" role="alert">{errorText(frame.error)}</div></Shell>;
  }
  const { head, workspaces, readiness, bookMeta, health, failure } = frame.value;
  const open = at.kind === "screen" ? at : null;
  const env: PageEnv = { workspaces, readiness, refresh: () => setTick((t) => t + 1) };
  // The Analysis path shows the workspace's meta line and no section chip: its progress strip carries each step's state.
  const metaSection = open !== null ? open.section : at.kind === "analysis" ? "workspace" : null;
  return (
    <Shell
      route={at}
      head={head}
      workspaces={workspaces}
      readinessState={open !== null && readiness !== null ? readiness.sections[open.section] : null}
      meta={metaSection !== null && head !== null ? manifestMeta(metaSection, head, bookMeta) : null}
      health={health}
    >
      {failure !== null ? <div className="card" role="alert">{failure}</div> : pageFor(at, head, env)}
    </Shell>
  );
}

/**
 * An ApiError is the server's own answer: status and message verbatim, or plain words when it carried none. Anything
 * else is a failed request, read through reasonOf, so a rejected fetch never prints the browser's raw text (final
 * review M1); a reason that is already a sentence stands alone.
 */
export function errorText(error: ApiError | Error): string {
  if (error instanceof ApiError) return pageErrText(error);
  const reason = reasonOf(error);
  return `${/[.?!]$/.test(reason) ? reason : `The platform did not answer: ${reason}.`} Start it with npm run platform, then reload.`;
}
