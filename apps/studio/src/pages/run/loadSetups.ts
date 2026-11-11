// apps/studio/src/pages/run/loadSetups.ts
/**
 * Run > Run setups loaders. One read of the workspace head, its setups (slot and current document), readiness, the
 * attached runs, the shipped scenario libraries and the stored slates. The head and the setups are fatal; every
 * other read degrades to none or empty, so one failed read never blanks the screen. Values are carried verbatim.
 */
import { viewDimensionOptions, type ViewDimOption } from "../../plan/planViews";
import type { ScenarioLibrary } from "@alm/engine";
import {
  getPlanLibrary,
  getPortfolio,
  getReadiness,
  getWorkspace,
  listRunSetups,
  listScenarioSlates,
  listWorkspaceRuns,
  type ReadinessReport,
  type RunSetupsReply,
  type ScenarioSlate,
  type WorkspaceManifest,
  type WorkspaceRunRow,
} from "@alm/reader";

export interface SetupsPageData {
  head: WorkspaceManifest;
  setups: RunSetupsReply;
  readiness: ReadinessReport | null;
  runs: WorkspaceRunRow[];
  libraries: ScenarioLibrary[];
  /** The slates the workspace's scenarios block names, resolved from the store. */
  slates: ScenarioSlate[];
}

export async function loadSetupsPage(ws: string): Promise<SetupsPageData> {
  const [head, setups, readiness, runs, libraries, allSlates] = await Promise.all([
    getWorkspace(ws),
    listRunSetups(ws),
    getReadiness(ws).catch(() => null),
    listWorkspaceRuns(ws).catch((): WorkspaceRunRow[] => []),
    getPlanLibrary().catch((): ScenarioLibrary[] => []),
    listScenarioSlates().catch((): ScenarioSlate[] => []),
  ]);
  const named = new Set(head.blocks.scenarios.slates.map((r) => r.id));
  return { head, setups, readiness, runs, libraries, slates: allSlates.filter((s) => named.has(s.id)) };
}

/** The book's chart of account nodes for the instrument-level node choice; empty when the book cannot be read. */
/** The dimensions a setup view may group by on the book (its declared tags plus the derived two); none without a book. */
export async function loadViewOptions(bookId: string | null): Promise<ViewDimOption[]> {
  if (bookId === null) return [];
  const book = await getPortfolio(bookId);
  return viewDimensionOptions(book.taxonomy);
}

export async function loadCoaNodes(bookId: string | null): Promise<Array<{ id: string; label: string }>> {
  if (bookId === null) return [];
  try {
    const book = await getPortfolio(bookId);
    return book.coa.nodes.map((n) => ({ id: n.id, label: n.label }));
  } catch {
    return [];
  }
}
