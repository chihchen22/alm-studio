// apps/studio/src/pages/dashboard/DashboardPage.tsx
/**
 * Analyze > Dashboard (ALM Studio P1). Reads the run in the Run pill, or the
 * newest done deterministic run of the selected book (and then says which run
 * it picked); with none, the book summary (the former Home page) and a way to
 * run. Every figure is a stored field (dashboardModel). The Limit use card
 * (Controls) reads the stored lenses for the same run on its own load, so a
 * failed lens read prints in the card and never blocks the rest of the page.
 */
import { Fragment } from "react";
import { getPlanLibrary, getRunLenses, listLenses, listRuns, type RunSummary, getWorkspace } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { screenHref } from "../../pageLinks";
import { dashboardModel, GRID_LIBRARY, type DashboardModel } from "../../dashboard/dashboardModel";
import { limitUseModel, type LimitUseModel } from "../../dashboard/limitUseModel";
import { loadResults } from "../results/loadResults";
import { NoResultCard, RunStrip } from "../results/ResultsPage";
import { envelopeBasisLabel } from "../../rows/basisLabel";
import { gridAsOfOf, ModelConventionNote, ResultMeta } from "../results/GridAsOf";
import { niiCaption } from "../results/niiWindow";
import { ResultsGate, type ResultsFrame } from "../results/ResultPicker";
import { HomePage } from "../home/HomePage";
import { registeredHeadlines } from "../../registry";
import { NewBusinessChip } from "../../results/newBusiness";
import { MACRO_PATH_NOTE } from "../../market/macroModel";

export function latestRunFor(runs: RunSummary[], bookId: string | null): string | null {
  const mine = runs.filter((r) => r.state === "done" && (r.mode ?? "deterministic") === "deterministic" && r.refs?.portfolioId === bookId);
  mine.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0));
  return mine[0]?.runId ?? null;
}

/** The lens file's own wording (docs/harness/lenses.json note). */
export const DEMO_LIMITS_NOTE = "Demonstration values: every limit is illustrative, and none is a calibrated or governed limit.";

/** The sentence for a workspace that attached no limit: demonstration limits stay off unless set. */
export const NO_LIMITS_NOTE = "No limits are set for this workspace, so nothing is scored against a limit. Demonstration limits stay off until a workspace attaches them.";

/**
 * Limit use (Controls): one row per stored lens, its roll-up status and its stored headline headroom. Props only.
 * `lensIds`, when given, are the lenses the workspace attached: only those are shown, and none attached says so
 * (demonstration limits never read Breach on a book nobody set limits for).
 */
export function LimitUseCard(props: { runId: string; model: LimitUseModel; lensIds?: string[] }) {
  const all = props.model;
  const m: LimitUseModel = all.state === "ok" && props.lensIds !== undefined ? { state: "ok", rows: all.rows.filter((r) => props.lensIds!.includes(r.lensId)) } : all;
  if (props.lensIds !== undefined && props.lensIds.length === 0) {
    return (
      <section className="card table-card" aria-label="Limit use">
        <div className="card-title">Limit use</div>
        <p className="card-desc">{NO_LIMITS_NOTE}</p>
      </section>
    );
  }
  return (
    <section className="card table-card" aria-label="Limit use">
      <div className="card-title">Limit use</div>
      {m.state === "loading" ? <p className="card-desc muted">Reading the lenses for {props.runId}</p> : null}
      {m.state === "error" ? <p role="alert"><span className="status status-breach">✕ Lenses refused</span> {m.text}</p> : null}
      {m.state === "not-applicable" ? <p className="unobs-text"><span className="status status-unobs">Not applicable</span> {m.text}</p> : null}
      {m.state === "ok" && m.rows.length === 0 ? <p className="unobs-text">The store holds no lens definition, so /api/runs/{props.runId}/lenses returned none.</p> : null}
      {m.state === "ok" && m.rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Lens</th><th scope="col">Status</th><th scope="col" className="num">Min headroom</th></tr></thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.lensId}>
                  <th scope="row" title={r.lensId}>{r.label}</th>
                  <td><span className={r.statusClass}>{r.statusText}</span></td>
                  <td className="num">{r.headroom === null ? <span className="muted">No headline stored</span> : <>{r.headroom}{r.worst !== null ? <> <span className="muted">{r.worst}</span></> : null}</>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="card-foot">{DEMO_LIMITS_NOTE}</p>
      <p className="card-foot">Source: /api/runs/{props.runId}/lenses, fields lenses[].status, .headline, .worst; labels from /api/lenses</p>
    </section>
  );
}

/** `basisLabel` is the run's balance sheet basis by provenance: the NII tile and columns carry it with their window. */
export function DashboardView(props: { runId: string; model: DashboardModel; limitUse: LimitUseModel; basisLabel?: string | null; lensIds?: string[] }) {
  return (
    <>
      <div className="dash-cards">
        {props.model.cards.map((c) => (
          <div key={c.key} className="stat">
            <div className="stat-label">{c.label}</div>
            {c.absent ? <span className="status status-unobs">{c.value}</span> : <div className={`stat-value${c.tone === "neg" ? " is-neg" : ""}`} title={c.field ?? undefined}>{c.value}</div>}
            <div className={`stat-note${c.tone === "neg" ? " neg" : ""}`}>{c.sub}</div>
            {c.key === "nii12" && !c.absent && props.basisLabel !== undefined && props.basisLabel !== null ? <div className="stat-note">{niiCaption(12, props.basisLabel)}</div> : null}
          </div>
        ))}
      </div>
      <div className="dash-row">
        <section className="card table-card" aria-label="By scenario">
          <div className="card-title">By scenario, USD millions</div>
          {props.basisLabel !== undefined && props.basisLabel !== null ? <p className="card-desc">NII 12M and 24M: {props.basisLabel}</p> : null}
          {props.model.newBusinessNote !== null ? <p className="card-desc" role="note">{props.model.newBusinessNote}</p> : null}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Scenario</th><th scope="col" className="num">EVE</th><th scope="col" className="num">ΔEVE</th><th scope="col" className="num">NII 12M</th><th scope="col" className="num">NII 24M</th></tr></thead>
              <tbody>
                {props.model.rows.map((r) => (
                  <tr key={r.scenarioId}>
                    <th scope="row" title={r.scenarioId}>{r.label}{r.newBusiness ? <> <NewBusinessChip scenarioId={r.scenarioId} /></> : null}</th>
                    <td className="num">{r.eve}</td>
                    <td className={`num${r.deltaTone === null ? "" : ` ${r.deltaTone}`}`}>{r.deltaEve}</td>
                    <td className="num">{r.nii12}</td>
                    <td className="num">{r.nii24}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-foot">Source: /api/runs/{props.runId}/result, fields eve.byScenario[].eve, .deltaEveVsBase, .deltaEvePct, nii.byScenario[].totalNet12, .totalNet24</p>
          <p className="card-foot">{MACRO_PATH_NOTE}</p>
        </section>
        <LimitUseCard runId={props.runId} model={props.limitUse} {...(props.lensIds === undefined ? {} : { lensIds: props.lensIds })} />
      </div>
    </>
  );
}

function DashboardRun(props: { ws: string; runId: string; picked: boolean; query: Record<string, string>; meta?: { cutoff: string | null; basisLabel: string | null }; lensIds?: string[] }) {
  const load = useLoad(() => Promise.all([loadResults(props.runId), getPlanLibrary()]), [props.runId]);
  // Its own load: the lens readings and the stored labels. A failure lands in the Limit use card only.
  const lenses = useLoad(() => Promise.all([getRunLenses(props.runId), listLenses()]).then(([readings, definitions]) => ({ readings, definitions })), [props.runId]);
  if (load.state === "loading")return <div className="card muted">Reading run {props.runId}</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const [data, libraries] = load.value;
  const strip = <RunStrip ws={props.ws} runId={props.runId} data={data} query={props.query} picked={props.picked} />;
  const meta = props.meta;
  if (data.result === null) {
    return <>{strip}{meta === undefined ? null : <ResultMeta gridAsOf={null} cutoff={meta.cutoff} basisLabel={meta.basisLabel} />}<NoResultCard ws={props.ws} runId={props.runId} data={data} /></>;
  }
  // Null when the library does not hold the grid: the stress card then says the grid is Unobservable.
  const grid = libraries.find((l) => l.id === GRID_LIBRARY)?.scenarios.map((s) => s.id) ?? null;
  const basisLabel = meta === undefined ? undefined : meta.basisLabel ?? envelopeBasisLabel(data.result);
  return (
    <>
      {strip}
      {meta === undefined ? null : <ResultMeta gridAsOf={gridAsOfOf(data.result)} cutoff={meta.cutoff} basisLabel={basisLabel ?? null} />}
      <ModelConventionNote result={data.result} />
      {registeredHeadlines().map((h) => <Fragment key={h.id}>{h.render({ result: data.result!, detail: data.detail })}</Fragment>)}
      <DashboardView runId={props.runId} model={dashboardModel(data.result, data.detail, grid)} limitUse={limitUseModel(lenses, data.result)} {...(basisLabel === undefined ? {} : { basisLabel })} {...(props.lensIds === undefined ? {} : { lensIds: props.lensIds })} />
    </>
  );
}

/** The result picker first, then the Dashboard on the run it chose: the framed form every workspace route uses. */
function FramedDashboard(props: { ws: string; query: Record<string, string>; frame: ResultsFrame }) {
  // The lenses the workspace attached: only those are scored. Unread, the card shows every stored lens as before.
  const head = useLoad(() => getWorkspace(props.ws), [props.ws]);
  const lensIds = head.state === "ok" ? head.value.blocks.run.lenses.map((l) => l.id) : undefined;
  return (
    <ResultsGate frame={props.frame} query={props.query}>
      {(pick) => <DashboardRun ws={props.ws} runId={pick.runId} picked={false} query={props.query} meta={{ cutoff: props.frame.cutoffDate, basisLabel: pick.basisLabel }} {...(lensIds === undefined ? {} : { lensIds })} />}
    </ResultsGate>
  );
}

export function DashboardPage(props: { ws: string; bookId: string | null; marketId: string | null; query: Record<string, string>; viewerBase: string; frame?: ResultsFrame }) {
  if (props.frame !== undefined) return <FramedDashboard ws={props.ws} query={props.query} frame={props.frame} />;
  return <LegacyDashboard ws={props.ws} bookId={props.bookId} marketId={props.marketId} query={props.query} viewerBase={props.viewerBase} />;
}

function LegacyDashboard(props: { ws: string; bookId: string | null; marketId: string | null; query: Record<string, string>; viewerBase: string }) {
  const runs = useLoad(() => listRuns(), [props.query.run ?? ""]);
  if (props.query.run !== undefined && props.query.run !== "") return <DashboardRun ws={props.ws} runId={props.query.run} picked={false} query={props.query} />;
  // No book: nothing of a book to read, so no book request is made.
  if (props.bookId === null) return <NoBook />;
  if (runs.state === "loading") return <div className="card muted">Reading the run list</div>;
  if (runs.state === "error") return <div className="card" role="alert">{errText(runs.error)}</div>;
  const latest = latestRunFor(runs.value, props.bookId);
  if (latest !== null) return <DashboardRun ws={props.ws} runId={latest} picked={true} query={props.query} />;
  return (
    <>
      <NoRun text={`No done run for book ${props.bookId}. Open a plan and run it.`} ws={props.ws} />
      <HomePage bookId={props.bookId} marketId={props.marketId} viewerBase={props.viewerBase} />
    </>
  );
}

/** No book in the Book pill: the pill is the way out, so the panel carries no button. */
function NoBook() {
  return (
    <section className="card unobs-panel" aria-label="No book">
      <span className="status status-unobs">No book</span>
      <p className="unobs-text">No book selected. Pick a book in the Book pill.</p>
    </section>
  );
}

function NoRun(props: { text: string; ws: string }) {
  return (
    <section className="card unobs-panel" aria-label="No run">
      <span className="status status-unobs">No run</span>
      <p className="unobs-text">{props.text}</p>
      <a className="btn btn-primary" href={screenHref({ ws: props.ws, section: "run", screen: "queue" })}>Go to Runs</a>
    </section>
  );
}
