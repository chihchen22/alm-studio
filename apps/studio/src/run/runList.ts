// apps/studio/src/run/runList.ts
/**
 * The Run page's lists and links (Studio S3a). GET /api/runs carries no plan
 * id, and POST /api/plans/run names the run's slate plan-<planId>
 * (apps/server/src/http/routes/plans.ts), so the plan id is read off the
 * slate name; a run not submitted from a plan has none.
 */
import type { RunState, RunSummary } from "@alm/reader";
import { resultsScreenOfTab, screenHref } from "../pageLinks";

export interface PastRunRow {
  runId: string;
  state: RunState;
  planId: string | null;
  label: string | null;
  submittedAt: string;
  /** The run's book, from refs.portfolioId recorded at submission; null when the run has no refs. */
  bookId: string | null;
  /** Present (true) on a stochastic run, whose results open on the Stochastic distributions screen. */
  stochastic?: true;
}

export function planIdOfSlate(slateId: string): string | null {
  return slateId.startsWith("plan-") && slateId.length > 5 ? slateId.slice(5) : null;
}

/** Newest first by the stored submittedAt (ISO 8601 sorts as text). */
export function pastRunRows(runs: RunSummary[]): PastRunRow[] {
  return runs
    .map((r) => ({
      runId: r.runId,
      state: r.state,
      // A stochastic launch's base slate is not a plan's, so it names no plan.
      planId: r.refs === undefined || r.mode === "stochastic" ? null : planIdOfSlate(r.refs.scenarioSlateId),
      label: r.label ?? null,
      submittedAt: r.submittedAt,
      bookId: r.refs?.portfolioId ?? null,
      ...(r.mode === "stochastic" ? { stochastic: true as const } : {}),
    }))
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0));
}

export function omitKeys(query: Record<string, string>, keys: string[]): Record<string, string> {
  const out = { ...query };
  for (const k of keys) delete out[k];
  return out;
}

/** Queue and history with the confirm sheet open for one stored plan. */
export function runHref(ws: string, query: Record<string, string>, planId: string): string {
  return screenHref({ ws, section: "run", screen: "queue" }, { ...omitKeys(query, ["run", "tab"]), plan: planId });
}

/** Queue and history following one run's progress. */
export function progressHref(ws: string, query: Record<string, string>, runId: string): string {
  return screenHref({ ws, section: "run", screen: "queue" }, { ...omitKeys(query, ["plan", "run", "tab"]), run: runId });
}

/** One run's results: the measure screen the page's tab names (the dashboard when it names none), the run as the picker's choice. */
export function resultsHref(ws: string, query: Record<string, string>, runId: string, stochastic = false): string {
  if (stochastic) return screenHref({ ws, section: "results", screen: "stochastic" }, { run: runId });
  return screenHref({ ws, section: "results", screen: resultsScreenOfTab(query.tab) }, { run: runId });
}

export type RunPageMode = { kind: "progress"; runId: string } | { kind: "confirm"; planId: string } | { kind: "list" };

export function runPageMode(query: Record<string, string>): RunPageMode {
  if (query.run !== undefined && query.run !== "") return { kind: "progress", runId: query.run };
  if (query.plan !== undefined && query.plan !== "") return { kind: "confirm", planId: query.plan };
  return { kind: "list" };
}
