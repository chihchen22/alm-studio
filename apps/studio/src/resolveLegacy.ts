/**
 * Forwarding of the old addresses (spec v3.1 Section 3.3). `parseHash` is pure and names the old
 * address's target screen; the workspace it belongs in needs the store, so App runs this one async
 * step before it renders and then rewrites the bar with `history.replaceState`.
 *
 * Evidence, in order, and never a guess:
 *   1. a `run` key: the workspaces holding that run. Exactly one resolves; none or several is
 *      Home with a banner. A run key that matches nothing does NOT fall through to the book key.
 *   2. no run key, a `book` key: the workspaces whose positions block names that book. Exactly one
 *      resolves; several is Home with the banner listing them; none is Home.
 *   3. neither: Home with a banner. There is no "newest active workspace" fallback.
 *
 * What survives the forward: page state keeps its keys; the run key becomes `result` on a Results
 * target and is dropped elsewhere; `book`, `asOf` and `plan` are dropped, `plan` becoming the setup
 * slot only on run/setups and only when a slot imported from that plan id exists in the workspace.
 */
import {
  listRunSetups, listWorkspaceRuns, listWorkspaces,
  type WorkspaceManifest,
} from "@alm/reader";
import { forwardTarget, type Query, type Route, type ScreenId, type SectionId } from "./router";

export interface LegacyWorkspace {
  id: string;
  /** The book the workspace's positions block names, or null. */
  bookId: string | null;
  /** The plan ids its run setup slots were imported from (`importedFrom`). */
  setupPlanIds: string[];
}

export interface LegacyApi {
  listWorkspaces(): Promise<LegacyWorkspace[]>;
  /** The ids of the workspaces that hold this run (an attachment line, or `status.summary.workspaceId`). */
  workspacesOfRun(runId: string): Promise<string[]>;
}

export interface ForwardBanner {
  /** The old address as typed. */
  oldAddress: string;
  /** The workspaces the evidence named when it named more than one; empty when it named none. */
  candidates: string[];
}

export type LegacyResolution =
  | { kind: "screen"; ws: string; section: SectionId; screen: ScreenId; query: Query; slot?: string }
  | { kind: "home"; banner?: ForwardBanner };

/** Page state that does not travel: the four old selection keys. `tab` of an old Results address is already consumed by `parseHash`. */
const DROPPED_KEYS = new Set(["book", "asOf", "plan", "run"]);

function present(v: string | undefined): v is string {
  return v !== undefined && v !== "";
}

/**
 * Resolves an old address (a `legacy` route). Any other route resolves to itself: a screen route to
 * the same screen, Home, New and Compare to Home with no banner.
 */
export async function resolveLegacyRoute(route: Route, api: LegacyApi): Promise<LegacyResolution> {
  if (route.kind === "screen") {
    return route.slot === undefined
      ? { kind: "screen", ws: route.ws, section: route.section, screen: route.screen, query: route.query }
      : { kind: "screen", ws: route.ws, section: route.section, screen: route.screen, query: route.query, slot: route.slot };
  }
  if (route.kind !== "legacy") return { kind: "home" };

  const banner = (candidates: string[]): LegacyResolution => ({ kind: "home", banner: { oldAddress: route.from, candidates } });
  const run = route.query.run;
  const book = route.query.book;
  const workspaces = await api.listWorkspaces();

  let ws: LegacyWorkspace | null = null;
  if (present(run)) {
    const held = await api.workspacesOfRun(run);
    if (held.length !== 1) return banner(held);
    ws = workspaces.find((w) => w.id === held[0]) ?? null;
    if (ws === null) return banner(held);
  } else if (present(book)) {
    const held = workspaces.filter((w) => w.bookId === book);
    if (held.length !== 1) return banner(held.map((w) => w.id));
    ws = held[0]!;
  } else {
    return banner([]);
  }

  const target = forwardTarget(route.layer);
  const query: Query = {};
  for (const [k, v] of Object.entries(route.query)) if (!DROPPED_KEYS.has(k)) query[k] = v;
  for (const [k, v] of Object.entries(target.query)) query[k] = v;
  if (target.section === "results" && present(run)) query.result = run;

  const plan = route.query.plan;
  if (target.screen === "setups" && target.section === "run" && present(plan) && ws.setupPlanIds.includes(plan)) {
    return { kind: "screen", ws: ws.id, section: target.section, screen: target.screen, query, slot: `setup-${plan}` };
  }
  return { kind: "screen", ws: ws.id, section: target.section, screen: target.screen, query };
}

/**
 * The reader-backed api: `GET /api/workspaces`, `GET /api/workspaces/:id/runs` and
 * `GET /api/run-setups?workspaceId=`. One instance caches the workspace list for one resolution.
 * A failed runs read propagates (App lands on Home): swallowing it could make a run look held by
 * one workspace when it is held by two.
 */
export function readerLegacyApi(): LegacyApi {
  let cached: Promise<WorkspaceManifest[]> | null = null;
  const manifests = () => (cached ??= listWorkspaces());
  return {
    async listWorkspaces() {
      const all = await manifests();
      return Promise.all(all.map(async (m): Promise<LegacyWorkspace> => {
        const slots = m.blocks.run.setups.map((s) => s.setupLineageId);
        let planIds: string[];
        try {
          const reply = await listRunSetups(m.id);
          planIds = reply.setups.map((x) => x.setup.importedFrom).filter((p): p is string => p !== null);
        } catch {
          // The slot id of an import is `setup-<planId>`: the same fact, read from the manifest.
          planIds = slots.filter((id) => id.startsWith("setup-")).map((id) => id.slice("setup-".length));
        }
        return { id: m.id, bookId: m.blocks.positions.book?.id ?? null, setupPlanIds: planIds };
      }));
    },
    async workspacesOfRun(runId) {
      const all = await manifests();
      const rows = await Promise.all(all.map(async (m) => ({ id: m.id, runs: await listWorkspaceRuns(m.id) })));
      return rows.filter((r) => r.runs.some((x) => x.runId === runId)).map((r) => r.id);
    },
  };
}
