// apps/studio/src/pages/results/resultChoice.ts
/**
 * The result picker's pure part (spec v3.1 Section 5.4). The picker lists the workspace's done runs from
 * GET /api/workspaces/:id/runs, newest first, as `${label} · ${date} · ${n} scenarios · ${basisLabel}`, and the choice
 * travels as `?result=<runId>` across the Results screens only. The default is the newest done deterministic run,
 * except where the workspace holds a done run of a record slot a pack registered (registry.ts): there the
 * newest such run is the default, the pinned run (teaching build). A stochastic row says
 * what it is (model, paths, base scenario only) in place of a scenario count. Nothing here reads a number out of a result.
 */
import type { ReadinessReport, StoredStochasticSpec, WorkspaceRunRow } from "@alm/reader";
import { hrefFor, type Query, type ScreenId } from "../../router";
import { recordSlot } from "../../registry";

/** What a Results screen is told by the page frame: where it is, the workspace cut-off and the readiness report. */
export interface ResultsFrame {
  ws: string;
  screen: ScreenId;
  cutoffDate: string | null;
  readiness: ReadinessReport | null;
}

/** The frame pageFor hands a Results screen; `head` is null when the workspace could not be read. */
export function resultsFrame(ws: string, screen: ScreenId, head: { cutoffDate: string } | null, readiness: ReadinessReport | null): ResultsFrame {
  return { ws, screen, cutoffDate: head?.cutoffDate ?? null, readiness };
}

export interface PickerRun {
  runId: string;
  /** The setup slot that launched the run; null for a migrated or API-posted run. */
  setupLineageId: string | null;
  /** The run was launched from the pinned-run setup. */
  armOfRecord: boolean;
  label: string | null;
  submittedAt: string;
  scenarioCount: number;
  /** The server's label read off the run's own request; null when the run's request record is missing. */
  basisLabel: string | null;
  stochastic: boolean;
  /** A stochastic run's stored options (GET /api/runs/:id); null when not read or not stochastic. */
  stochasticSpec: StoredStochasticSpec | null;
  /** The run predates workspaces: its pins were rebuilt by migration, so currency cannot be proved. */
  reconstructed: boolean;
  stale: boolean;
  staleRoles: string[];
}

/** The time an attachment is ordered by: the run's own submit time, else the attachment line's. Server rule. */
function stampOf(r: WorkspaceRunRow): string {
  return r.status?.submittedAt ?? r.at;
}

function newestFirst(rows: WorkspaceRunRow[]): WorkspaceRunRow[] {
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.runId) ? false : (seen.add(r.runId), true)));
  return unique.sort((a, b) => (stampOf(a) !== stampOf(b) ? (stampOf(a) < stampOf(b) ? 1 : -1) : a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

/**
 * The done runs of the workspace, newest first. `modes` maps a run id to its submission mode (from GET /api/runs);
 * a run it does not name reads as deterministic. Readiness judges staleness for the newest attached run only, so
 * that run alone can carry the Stale badge: no row is marked on a claim the server did not make.
 */
/**
 * The workspace runs a deterministic reader may read. An attached stochastic run (its line carries
 * `mode: "stochastic"`) holds a distribution envelope, with no deterministic section, plan provenance or compare table.
 */
export function deterministicRows<T extends { mode?: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.mode !== "stochastic");
}

export function pickerRuns(
  rows: WorkspaceRunRow[],
  modes: Record<string, string>,
  readiness: ReadinessReport | null,
  specs: Record<string, StoredStochasticSpec | null> = {},
): PickerRun[] {
  const ordered = newestFirst(rows);
  const item = readiness?.items.find((i) => i.section === "results" && i.item === "Newest result");
  // Readiness judges the newest deterministic run, so a Stale badge goes on that one, never on a stochastic run.
  const newestDeterministic = ordered.find((r) => r.mode !== "stochastic" && modes[r.runId] !== "stochastic");
  const staleId = item !== undefined && item.state === "stale" ? newestDeterministic?.runId ?? null : null;
  return ordered
    .filter((r) => r.status?.state === "done")
    .map((r): PickerRun => ({
      runId: r.runId,
      setupLineageId: r.setupLineageId ?? null,
      armOfRecord: recordSlot(r.setupLineageId ?? null) !== undefined,
      label: r.status?.label ?? null,
      submittedAt: stampOf(r),
      scenarioCount: r.status?.summary.scenarioCount ?? 0,
      basisLabel: r.basisLabel,
      stochastic: modes[r.runId] === "stochastic" || r.mode === "stochastic",
      stochasticSpec: modes[r.runId] === "stochastic" || r.mode === "stochastic" ? specs[r.runId] ?? null : null,
      reconstructed: r.pins === "reconstructed",
      stale: r.runId === staleId,
      staleRoles: r.runId === staleId ? (item?.staleRoles ?? []).map((s) => s.role) : [],
    }));
}

const MODEL_NAMES: Record<string, string> = { "hull-white-1f": "Hull-White", "bgm-lmm-2f": "BGM" };

/**
 * What a stochastic run is, in place of its scenario count: the engine runs the base scenario only, so the slate's
 * count would mislead. An absent model is Hull-White (StoredStochasticSpec.model).
 */
export function stochasticText(spec: StoredStochasticSpec | null): string {
  if (spec === null) return "Stochastic, base scenario only";
  const model = MODEL_NAMES[spec.model ?? "hull-white-1f"] ?? String(spec.model);
  return `Stochastic, ${model}, ${spec.nPaths} paths, base scenario only`;
}

/**
 * `${label} · ${date} · ${n} scenarios · ${basisLabel}`; the run id stands in for a missing label. A stochastic row
 * prints `stochasticText` in place of the count, and an pinned-run run ends with "pinned run".
 */
export function rowText(r: PickerRun): string {
  const n = r.stochastic ? stochasticText(r.stochasticSpec) : `${r.scenarioCount} ${r.scenarioCount === 1 ? "scenario" : "scenarios"}`;
  const text = `${r.label ?? r.runId} · ${r.submittedAt.slice(0, 10)} · ${n} · ${r.basisLabel ?? "basis not recorded"}`;
  return r.armOfRecord ? `${text} · pinned run` : text;
}

export type ResultChoice =
  /** No `result` in the address: the newest done deterministic run. */
  | { kind: "newest"; runId: string; run: PickerRun }
  /** No `result` in the address, and the workspace holds a done pinned-run run: the newest of those. */
  | { kind: "record"; runId: string; run: PickerRun }
  /** The address names a run. `run` is null when the workspace's done list does not hold it. */
  | { kind: "explicit"; runId: string; run: PickerRun | null }
  | { kind: "none" };

/** Which kind of envelope a screen reads: Stochastic distributions reads a stochastic one, every other screen a deterministic one. */
export type ResultWant = "deterministic" | "stochastic";

export function chooseResult(runs: PickerRun[], explicit: string | undefined, want: ResultWant = "deterministic"): ResultChoice {
  if (explicit !== undefined && explicit !== "") return { kind: "explicit", runId: explicit, run: runs.find((r) => r.runId === explicit) ?? null };
  // A deterministic screen opens on the pinned run when the workspace holds one.
  if (want === "deterministic") {
    const record = runs.find((r) => r.armOfRecord && !r.stochastic);
    if (record !== undefined) return { kind: "record", runId: record.runId, run: record };
  }
  // Else a screen defaults to the newest run whose envelope it can read: the deterministic screens never a stochastic one.
  const newest = runs.find((r) => r.stochastic === (want === "stochastic"));
  return newest === undefined ? { kind: "none" } : { kind: "newest", runId: newest.runId, run: newest };
}

/** Keys a Results address never carries: the old selection keys and the ones the page frame injects. */
const NOT_PAGE_STATE = ["run", "result", "book", "tab", "asOf", "plan"];

/** The address of one Results screen with the choice set (`runId`) or cleared (null); page state is kept. */
export function pickHref(ws: string, screen: ScreenId, query: Query, runId: string | null): string {
  const q: Query = {};
  for (const [k, v] of Object.entries(query)) if (!NOT_PAGE_STATE.includes(k)) q[k] = v;
  if (runId !== null) q.result = runId;
  return hrefFor({ ws, section: "results", screen, query: q });
}
