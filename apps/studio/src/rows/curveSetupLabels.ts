// apps/studio/src/rows/curveSetupLabels.ts
/**
 * Curve setup labels for a workspace history (step B1 follow-up). A history line names a curve setup by its
 * document id (cs-...); the label lives in the document. A cs- id is a content hash, so its label never changes: each id
 * is read at most once per session (a module-level cache, also seeded from the setup list, which names every current
 * document). A read that fails is not cached and leaves the id out, so the line falls back to the id. The label is
 * never written into the history itself.
 */
import { getCurveSetup, getWorkspaceHistory, type HistoryLine } from "@alm/reader";
import type { CurveSetupLabels } from "./workspaceRows";

const cache = new Map<string, string>();

/** Labels the caller already holds (the setup list's rows), so no history load reads them again. */
export function rememberCurveSetupLabels(rows: readonly { id: string; label: string }[]): void {
  for (const r of rows) if (typeof r.label === "string") cache.set(r.id, r.label);
}

/** Test hook: forget every cached label. */
export function clearCurveSetupLabelCache(): void {
  cache.clear();
}

/** The curve setup document ids a history names, each once, in first-seen order. */
export function curveSetupIdsOf(lines: readonly HistoryLine[]): string[] {
  const ids = new Set<string>();
  for (const l of lines) {
    if (l.change.kind === "set-block" && l.change.ref.collection === "curve-setups") ids.add(l.change.ref.id);
  }
  return [...ids];
}

/** The label of each curve setup the history names, read only for ids not cached; an id whose read fails is left out. */
export async function curveSetupLabelsFor(
  lines: readonly HistoryLine[],
  read: (docId: string) => Promise<{ label: string }> = getCurveSetup,
): Promise<Map<string, string>> {
  const ids = curveSetupIdsOf(lines);
  const unknown = ids.filter((id) => !cache.has(id));
  await Promise.all(unknown.map(async (id) => {
    try {
      const label = (await read(id)).label;
      if (typeof label === "string") cache.set(id, label);
    } catch {
      // Not cached: the line names the id, and the next load tries again.
    }
  }));
  const labels = new Map<string, string>();
  for (const id of ids) {
    const label = cache.get(id);
    if (label !== undefined) labels.set(id, label);
  }
  return labels;
}

/** A workspace history with the labels of the curve setups it names. */
export async function historyWithCurveLabels(workspaceId: string): Promise<{ lines: HistoryLine[]; labels: CurveSetupLabels }> {
  const lines = await getWorkspaceHistory(workspaceId);
  return { lines, labels: await curveSetupLabelsFor(lines) };
}
