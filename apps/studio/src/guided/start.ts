// apps/studio/src/guided/start.ts
/**
 * The first screen's start choices (S2a spec point 1) and the defaults a new analysis takes: the cut-off date is the
 * newest base market snapshot's date (spec point 10), never today, so a first run meets no date clash; the workspace
 * id is free in the store. Pure; the page calls the server.
 */
import type { MarketListItem, WorkspaceManifest } from "@alm/reader";

/** The base snapshots (not derived markets), newest date first, ties by id. */
export function baseSnapshots(markets: readonly MarketListItem[]): MarketListItem[] {
  return markets
    .filter((m) => m.derivedFromMarketId === undefined && typeof m.calibrationDate === "string")
    .sort((a, b) => (b.calibrationDate! < a.calibrationDate! ? -1 : b.calibrationDate! > a.calibrationDate! ? 1 : a.id < b.id ? -1 : 1));
}

/** The newest base snapshot, or null when the store holds none. */
export function newestSnapshot(markets: readonly MarketListItem[]): MarketListItem | null {
  return baseSnapshots(markets)[0] ?? null;
}

/** The cut-off a new workspace starts on: the newest snapshot's date, else the fallback (the last month-end). */
export function defaultCutoff(markets: readonly MarketListItem[], fallback: string): string {
  return newestSnapshot(markets)?.calibrationDate ?? fallback;
}

/** A workspace id from a name: lowercase words joined by dashes under "ws-", made unique against the store. */
export function freeWorkspaceId(name: string, workspaces: readonly Pick<WorkspaceManifest, "id">[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "analysis";
  const taken = new Set(workspaces.map((w) => w.id));
  const stem = `ws-${slug}`;
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** The first free name "<base>", "<base> 2", ... among the workspaces' names. */
export function freeName(base: string, workspaces: readonly Pick<WorkspaceManifest, "name">[]): string {
  const taken = new Set(workspaces.map((w) => w.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** The name a typed-by field defaults to when the viewer has typed none: a guided write must still name its writer. */
export const DEFAULT_BY = "Analyst";
