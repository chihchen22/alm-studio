// apps/studio/src/pages/analysis/AnalysisPage.tsx
/**
 * The guided Analysis path: #/ws/<ws>/analysis/<step>. A progress strip of the nine
 * steps with each one's state as a word (Done, Needs attention, Optional), the open step's status card (what is
 * missing, in plain words; the server's own words behind Details; the Advanced screens the step gathers), the step
 * itself, and Back and Continue. Today's screens stay under Advanced; none is deleted.
 */
import { useState, type ReactNode } from "react";
import { getRunSetup, listGuidedRuns, listWorkspaceRuns, type GuidedRunRow, type ReadinessReport, type RunSetup, type WorkspaceManifest, type WorkspaceRunRow } from "@alm/reader";
import { ANALYSIS_STEPS, analysisHref, type StepId } from "../../router";
import { advancedHrefs, GUIDED_SLOT, nextStep, STATE_LABEL, stepStates, type StepState, type StepStatus } from "../../guided/steps";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { Details, guidedSlotOf, type StepContext } from "./common";
import { MarketStep } from "./MarketStep";
import { BalanceStep } from "./BalanceStep";
import { BehaviorStep } from "./BehaviorStep";
import { NewVolumeStep } from "./NewVolumeStep";
import { CalibrationStep, HorizonCard, NewVolumeViewsCard, SimulationStep } from "./SimulationSteps";
import { ScenariosStep } from "./ScenariosStep";
import { RunStep } from "./RunStep";
import { ReportsStep, reportsRunId } from "./ReportsStep";


interface Loaded {
  guided: RunSetup | null;
  runs: WorkspaceRunRow[];
  stochastic: GuidedRunRow[];
}

async function loadAnalysis(head: WorkspaceManifest): Promise<Loaded> {
  const slot = guidedSlotOf(head);
  // Stochastic runs: attached ones from runs.ndjson and S2a's links (fix round 1, H2); no label matching.
  const [guided, runs, stochastic] = await Promise.all([
    slot === null ? Promise.resolve(null) : getRunSetup(slot.current.id),
    listWorkspaceRuns(head.id).catch(() => [] as WorkspaceRunRow[]),
    listGuidedRuns(head.id).catch(() => [] as GuidedRunRow[]),
  ]);
  const stamp = (r: WorkspaceRunRow): string => r.status?.submittedAt ?? r.at;
  const sorted = [...runs].sort((a, b) => (stamp(a) < stamp(b) ? 1 : -1));
  return { guided, ...splitRuns(sorted, stochastic) };
}

/**
 * The workspace's attached runs split by mode. A stochastic launch is attached in
 * runs.ndjson (its line carries `mode: "stochastic"` and the setup document it ran); an S2a run linked only in
 * guided-runs.ndjson stays readable as it was, with no migration. The two lists are merged by run id, newest first.
 */
export function splitRuns(rows: WorkspaceRunRow[], linked: GuidedRunRow[]): { runs: WorkspaceRunRow[]; stochastic: GuidedRunRow[] } {
  const deterministic = rows.filter((r) => r.mode !== "stochastic");
  const attached: GuidedRunRow[] = rows
    .filter((r) => r.mode === "stochastic")
    .map((r) => ({ runId: r.runId, setupLineageId: r.setupLineageId ?? "", setupDocId: r.setupDocId ?? "", at: r.at, by: "", status: r.status }));
  const ids = new Set(attached.map((r) => r.runId));
  const merged = [...attached, ...linked.filter((r) => !ids.has(r.runId))];
  const stamp = (r: GuidedRunRow): string => r.status?.submittedAt ?? r.at;
  merged.sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0));
  return { runs: deterministic, stochastic: merged };
}

const MARK: Record<StepState, string> = { done: "✓", attention: "!", optional: "-" };

export function ProgressStrip(props: { ws: string; states: StepStatus[]; current: StepId }) {
  return (
    <nav aria-label="Analysis progress">
      <ol className="guided-strip">
        {props.states.map((s, i) => (
          <li key={s.id}>
            <a className={`guided-step guided-state-${s.state}`} href={analysisHref(props.ws, s.id)} aria-current={s.id === props.current ? "step" : undefined}>
              <span className="guided-step-name">{`${i + 1}. ${s.label}`}</span>
              <span className="guided-step-state"><span className="guided-mark" aria-hidden="true">{MARK[s.state]}</span>{STATE_LABEL[s.state]}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function StatusCard(props: { ws: string; status: StepStatus; intro: ReactNode; result?: string | null }) {
  const s = props.status;
  return (
    <section className="card guided-status" aria-label="Step status">
      <div className="guided-status-head">
        <h2 className="card-title">{`Step ${ANALYSIS_STEPS.findIndex((x) => x.id === s.id) + 1}: ${s.label}`}</h2>
        <span className={`guided-step-state guided-state-${s.state}`}><span className="guided-mark" aria-hidden="true">{MARK[s.state]}</span>{STATE_LABEL[s.state]}</span>
      </div>
      <p className="card-desc">{props.intro}</p>
      {s.missing.length > 0 ? <ul className="guided-missing">{s.missing.map((m) => <li key={m}>{m}</li>)}</ul> : null}
      <div className="guided-links">
        <span>Advanced:</span>
        {advancedHrefs(props.ws, s.id, props.result ?? null).map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
      </div>
      {s.details.length > 0 ? (
        <Details summary="Details: the workspace check's own words">
          <ul>{s.details.map((d) => <li key={d}>{d}</li>)}</ul>
        </Details>
      ) : null}
    </section>
  );
}

const INTRO: Record<StepId, string> = {
  market: "Pick the market the analysis runs on: the yield curve and the volatility surfaces, dated at the workspace's cut-off.",
  balance: "Load the positions: your own file from a template, or the example. The balance sheet must tie: assets equal liabilities plus equity.",
  behavior: "Choose how each family behaves: how mortgages prepay, how deposits decay and reprice. Keep each position's own values, or start on the published defaults and change them later.",
  "new-volume": "Say what happens when balances mature or run off, and set any growth targets.",
  calibration: "Fit the rate model behind a stochastic run to the volatility surface, check the fit against its gate, and save it for runs to use.",
  simulation: "Run one deterministic path per scenario, or many simulated paths of the base scenario.",
  scenarios: "Choose the rate scenarios the run measures: the standard sets, or your own shock by tenor.",
  run: "Check the analysis and launch it.",
  reports: "Build the report you need from the run: metric, scenarios, horizon, granularity and grouping. View it, compare two runs, export it.",
};

export function AnalysisPage(props: { ws: string; step: StepId; head: WorkspaceManifest | null; readiness: ReadinessReport | null; query: Record<string, string>; refresh: () => void }) {
  const { head } = props;
  const [tick, setTick] = useState(0);
  const load = useLoad(() => (head === null ? Promise.reject(new Error(`Workspace ${props.ws} could not be read.`)) : loadAnalysis(head)), [head?.id, head?.revision, tick]);
  if (head === null) return <div className="card" role="alert">Workspace {props.ws} could not be read.</div>;
  if (load.state === "loading") return <div className="card muted">Reading the analysis</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const { guided, runs, stochastic } = load.value;
  const deterministic = runs
    .filter((r) => r.setupLineageId === GUIDED_SLOT)
    .map((r) => ({ runId: r.runId, state: r.status?.state ?? "unknown", submittedAt: r.status?.submittedAt ?? r.at }));
  const linked = stochastic.map((r) => ({ runId: r.runId, state: r.status?.state ?? "unknown", submittedAt: r.status?.submittedAt ?? r.at, setupDocId: r.setupDocId }));
  const states = stepStates({
    readiness: props.readiness,
    guided,
    guidedPinnedAt: guidedSlotOf(head)?.current.pinnedAt ?? null,
    deterministic,
    stochastic: linked,
    newestResultIsGuided: runs[0] !== undefined && runs[0].setupLineageId === GUIDED_SLOT,
  });
  const status = states.find((s) => s.id === props.step)!;
  const ctx: StepContext = {
    ws: props.ws,
    head,
    readiness: props.readiness,
    guided,
    runs,
    stochastic,
    query: props.query,
    refresh: () => { props.refresh(); setTick((t) => t + 1); },
    go: (step, query) => { window.location.hash = analysisHref(props.ws, step, query); },
  };
  const index = ANALYSIS_STEPS.findIndex((x) => x.id === props.step);
  const prev = index > 0 ? ANALYSIS_STEPS[index - 1]!.id : null;
  const next = index < ANALYSIS_STEPS.length - 1 ? ANALYSIS_STEPS[index + 1]!.id : null;
  const firstOpen = nextStep(states);
  return (
    <>
      <ProgressStrip ws={props.ws} states={states} current={props.step} />
      <StatusCard ws={props.ws} status={status} intro={INTRO[props.step]} result={props.step === "reports" ? reportsRunId(ctx) : null} />
      {stepBody(props.step, ctx)}
      <nav className="guided-nav" aria-label="Step navigation">
        {prev === null ? <span /> : <a className="btn" href={analysisHref(props.ws, prev)}>{`Back: ${ANALYSIS_STEPS[index - 1]!.label}`}</a>}
        {next === null ? (
          firstOpen === null ? <span className="muted">Every step is done.</span> : <a className="btn" href={analysisHref(props.ws, firstOpen)}>{`Go to the first step that needs attention: ${states.find((s) => s.id === firstOpen)!.label}`}</a>
        ) : (
          <a className="btn btn-primary" href={analysisHref(props.ws, next)}>{`Continue: ${ANALYSIS_STEPS[index + 1]!.label}`}</a>
        )}
      </nav>
    </>
  );
}

function stepBody(step: StepId, ctx: StepContext): ReactNode {
  switch (step) {
    case "market": return <MarketStep ctx={ctx} />;
    case "balance": return <BalanceStep ctx={ctx} />;
    case "behavior": return <BehaviorStep ctx={ctx} />;
    case "new-volume": return <NewVolumeStep ctx={ctx} />;
    case "calibration": return <CalibrationStep ctx={ctx} />;
    case "simulation": return <><SimulationStep ctx={ctx} /><HorizonCard ctx={ctx} /><NewVolumeViewsCard ctx={ctx} /></>;
    case "scenarios": return <ScenariosStep ctx={ctx} />;
    case "run": return <RunStep ctx={ctx} />;
    case "reports": return <ReportsStep ctx={ctx} />;
  }
}
