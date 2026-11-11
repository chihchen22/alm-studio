// apps/studio/src/results/overview.ts
/**
 * The Overview tab's view model (Studio S3a): EVE and NII at 12 and 24 months
 * per scenario, each read at its registry path and formatted like the viewer.
 * No worst-case pick and no arithmetic: a cell holds the stored field or
 * "Not in this run" with the reason. A block the envelope lacks, or one that
 * lists no scenarios, is named in `missing` so the tab says so.
 */
import type { RunResult } from "@alm/engine";
import { formatHeadline, headlineFor, NOT_IN_RUN, readPath, type Headline, type HeadlineMetric, type PathRead } from "@alm/reader";

export interface OverviewCell {
  headline: Headline;
  read: PathRead;
  text: string;
}

export interface OverviewRow {
  scenarioId: string;
  eve: OverviewCell;
  nii12: OverviewCell;
  nii24: OverviewCell;
}

export interface OverviewModel {
  rows: OverviewRow[];
  missing: Array<{ block: "eve" | "nii"; reason: string }>;
}

function cell(result: RunResult, metric: HeadlineMetric, scenarioId: string): OverviewCell {
  const headline = headlineFor(metric, scenarioId);
  const read = readPath(result, headline.envelopePath);
  return { headline, read, text: read.kind === "value" ? formatHeadline(headline, read.value) : NOT_IN_RUN };
}

export function overviewModel(result: RunResult): OverviewModel {
  const r = result as Partial<RunResult>;
  const missing: OverviewModel["missing"] = [];
  for (const block of ["eve", "nii"] as const) {
    if (r[block] === undefined) missing.push({ block, reason: `The envelope carries no ${block} block.` });
    else if ((r[block]!.byScenario ?? []).length === 0) missing.push({ block, reason: `The ${block} block lists no scenarios.` });
  }
  const ids: string[] = [];
  for (const s of [...(r.eve?.byScenario ?? []), ...(r.nii?.byScenario ?? [])]) if (!ids.includes(s.scenarioId)) ids.push(s.scenarioId);
  return {
    rows: ids.map((id) => ({ scenarioId: id, eve: cell(result, "eve", id), nii12: cell(result, "nii12", id), nii24: cell(result, "nii24", id) })),
    missing,
  };
}

export function overviewCells(model: OverviewModel): OverviewCell[] {
  return model.rows.flatMap((r) => [r.eve, r.nii12, r.nii24]);
}
