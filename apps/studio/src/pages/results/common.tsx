// apps/studio/src/pages/results/common.tsx
/** Shared parts of the Results tabs (Studio S3a). Nothing here reads or computes a number. */
import type { RunResult } from "@alm/engine";
import { NOT_IN_RUN, type RunDetail } from "@alm/reader";
import { resultsScreenOfTab, screenHref } from "../../pageLinks";

export interface TabProps {
  ws: string;
  runId: string;
  detail: RunDetail;
  result: RunResult;
  query: Record<string, string>;
  scenarioLabel: (id: string) => string;
  /** The run's balance sheet basis label by provenance; null or absent when none is at hand. */
  basisLabel?: string | null;
}

/** A block the envelope may lack at runtime although the type says it is required. */
export function blockOf<K extends keyof RunResult>(r: RunResult, k: K): RunResult[K] | undefined {
  return (r as Partial<RunResult>)[k];
}

export function NotInRun(props: { title: string; reason: string }) {
  return (
    <section className="card unobs-panel" aria-label={props.title}>
      <div className="card-title">{props.title}</div>
      <span className="status status-unobs">{NOT_IN_RUN}</span>
      <p className="unobs-text">{props.reason}</p>
    </section>
  );
}

export function selectedScenario(ids: string[], query: Record<string, string>): string | null {
  return query.scenario !== undefined && ids.includes(query.scenario) ? query.scenario : ids[0] ?? null;
}

/** The address of the screen a tab sits on with one page key changed; the run stays as the picker's choice. */
export function tabHref(ws: string, query: Record<string, string>, patch: Record<string, string>): string {
  return screenHref({ ws, section: "results", screen: resultsScreenOfTab(query.tab) }, { ...query, ...patch });
}

export function ScenarioPicker(props: { ws: string; ids: string[]; selected: string; query: Record<string, string>; label: (id: string) => string }) {
  return (
    <nav className="chip-row" aria-label="Scenario">
      {props.ids.map((id) => (
        <a key={id} className="pill" href={tabHref(props.ws, props.query, { scenario: id })} aria-current={id === props.selected ? "true" : undefined}>
          {props.label(id)}
        </a>
      ))}
    </nav>
  );
}
