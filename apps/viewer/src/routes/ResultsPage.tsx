/**
 * Results route: renders one stored run's RunResult envelope,
 * verbatim, fetched through the frozen typed client (src/api/client.ts).
 *
 * Honesty rules this page enforces:
 *  - Every number is a verbatim envelope field rendered through the tested
 *    formatters in src/format.ts. The page computes nothing: no sums, no
 *    percentages beyond display scaling (pct/signedPct multiply a stored
 *    decimal fraction by 100, which is presentation, unit-tested).
 *  - `deltaEvePct` is a decimal FRACTION in the envelope (the limitations page
 *    Section 2); it is displayed through signedPct (x100), never re-derived.
 *  - Base-only duration mode: a shocked scenario's equity duration is
 *    undefined with durationSanityPassed true; that renders "n/a (base-only)".
 *    A gate-rejected duration renders "flagged". The two states are never
 *    conflated and neither is ever blank or zero (EveTable draws the
 *    distinction; the overview mirrors it).
 *  - The NotImplemented register renders verbatim, in the engine's own words.
 *  - Attribution renders the engine's per-family, per-driver contributions as
 *    stored. Unlike the v1 fixture viewer (which aggregated per-driver steps
 *    at build time, outside the browser), this page does NOT sum contributions
 *    client-side; it shows the stored rows.
 *  - A missing or failed result renders the server's error verbatim (ApiError
 *    carries the typed { code, message, detail } body unmodified); nothing is
 *    substituted for a result that does not exist.
 *
 * W3-P7 additions:
 *  - The page branches on the run's stored mode: a stochastic run's
 *    result is a SEPARATE distribution envelope fetched from /stochastic and
 *    rendered by StochasticReport; none of the deterministic tabs (which the
 *    server refuses typed for such runs) are painted for it, so a distribution
 *    mean can never appear beside a deterministic EVE.
 *  - The FTP tab appears ONLY when the envelope carries the ftp block; a
 *    seasoned book omits the block and its typed `ftp.seasoned-book` register
 *    tag renders verbatim in the Overview register instead. A control never
 *    appears for a capability the engine refused.
 *  - Key-rate durations and the EVE channel decomposition (cost-labeled
 *    engine opt-ins) render inside the EVE tab only when the envelope carries
 *    the blocks; when absent, a muted note states they were not computed —
 *    distinct from a blank and from a rejected value.
 *
 * Piece 4b addition:
 *  - A Rates tab (RatesPanel) draws the run's rate document on
 *    both run modes: on the deterministic report as an ordinary tab, on the
 *    stochastic report behind a Report / Rates view bar. The panel's numbers
 *    are stored document fields scaled to percent; see RatesPanel.tsx.
 *
 * Piece 4d addition:
 *  - A Metrics tab (CustomMetricPanel) shows the run's custom metric block,
 *    painted only when the envelope carries `custom`; one table and one bar
 *    chart per key, family rows collapsed, absent values as "unobservable".
 */
import { useEffect, useState } from "react";
import type { AttributionResult, RunResult, StochasticRunResult } from "@alm/engine";
import {
  ApiError,
  exportCsvUrl,
  getResult,
  getRun,
  getStochasticResult,
  listPortfolios,
  listRuns,
  type ExportTable,
  type PortfolioListItem,
  type RunDetail,
  type RunSummary,
} from "@alm/reader";
import { signClass, signedMM, signedPct, usdMM, years } from "@alm/reader";
import { ScenarioLabelProvider, useScenarioLabel } from "@alm/reader";
import { NiiTable } from "../components/NiiTable";
import { EveTable } from "../components/EveTable";
import { GapLadders } from "../components/GapLadders";
import { CashflowRunoff } from "../components/CashflowRunoff";
import { NotImplementedPanel } from "../components/NotImplementedPanel";
import { ProvenancePanel } from "../components/ProvenancePanel";
import { FtpPanel } from "../components/FtpPanel";
import { KeyRatePanel } from "../components/KeyRatePanel";
import { ChannelsPanel } from "../components/ChannelsPanel";
import { StochasticReport } from "../components/StochasticReport";
import { ViewsPanel } from "../components/ViewsPanel";
import { RatesPanel } from "../components/RatesPanel";
import { CustomMetricPanel } from "../components/CustomMetricPanel";

/** Renders an ApiError (or any error) verbatim: code, message, and 422 detail. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = err.detail !== undefined ? `\n${JSON.stringify(err.detail, null, 2)}` : "";
    return `${err.status} ${err.code}: ${err.message}${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// --- Page --------------------------------------------------------------------

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "nii", label: "NII" },
  { key: "eve", label: "EVE" },
  { key: "ftp", label: "FTP" },
  { key: "attribution", label: "Attribution" },
  { key: "gap", label: "Gap" },
  { key: "views", label: "Views" },
  { key: "metrics", label: "Metrics" },
  { key: "runoff", label: "Runoff" },
  { key: "rates", label: "Rates" },
  { key: "provenance", label: "Provenance" },
  { key: "export", label: "Export" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: RunDetail; result: RunResult; portfolio?: PortfolioListItem }
  | { status: "ready-stochastic"; detail: RunDetail; stochastic: StochasticRunResult };

/** Reads a run id out of a "#/results/<id>" style hash; convenience only. */
function runIdFromHash(): string | undefined {
  const m = /#\/?results\/([^/?&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function ResultsPage({ runId: runIdProp }: { runId?: string }) {
  const [runId, setRunId] = useState<string | undefined>(() => runIdProp ?? runIdFromHash());
  const [runs, setRuns] = useState<RunSummary[] | undefined>(undefined);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (runIdProp !== undefined) setRunId(runIdProp);
  }, [runIdProp]);

  useEffect(() => {
    let live = true;
    listRuns()
      .then((r) => live && setRuns(r))
      .catch((err: unknown) => live && setListError(errorText(err)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!runId) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    // The detail first: the stored mode decides WHICH result exists for this
    // run. Guessing and letting the wrong route 400 would
    // render a refusal for a result that does exist under the other route.
    getRun(runId)
      .then(async (detail) => {
        if ((detail.mode ?? "deterministic") === "stochastic") {
          const stochastic = await getStochasticResult(runId);
          if (live) setState({ status: "ready-stochastic", detail, stochastic });
          return;
        }
        const result = await getResult(runId);
        // Portfolio metadata beside the provenance record: a store LOOKUP by the
        // run's recorded reference, no arithmetic. Non-fatal when unavailable.
        let portfolio: PortfolioListItem | undefined;
        if (detail.refs?.portfolioId) {
          try {
            portfolio = (await listPortfolios()).find((p) => p.id === detail.refs?.portfolioId);
          } catch {
            portfolio = undefined;
          }
        }
        if (live) setState({ status: "ready", detail, result, portfolio });
      })
      .catch((err: unknown) => live && setState({ status: "error", message: errorText(err) }));
    return () => {
      live = false;
    };
  }, [runId]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>Results</h1>
        <div className="sub">
          Verbatim reader over a stored RunResult. Every number is an envelope field rendered through the
          tested formatter; the client computes nothing on this page.
        </div>
      </header>

      <RunPicker runs={runs} listError={listError} selected={runId} onSelect={setRunId} />

      {state.status === "idle" && <p className="emptynote">Select a run to view its result.</p>}
      {state.status === "loading" && <p className="emptynote">Loading run {runId}…</p>}
      {state.status === "error" && (
        <section className="panel">
          <h2>Result not available</h2>
          <p className="desc">
            The platform returned the following for run <code>{runId}</code>. The message is shown verbatim;
            nothing is substituted for a missing result.
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{state.message}</pre>
        </section>
      )}
      {state.status === "ready" && (
        <ScenarioLabelProvider scenarios={state.detail.scenarios}>
          <RunReport
            runId={runId!}
            detail={state.detail}
            result={state.result}
            portfolio={state.portfolio}
          />
        </ScenarioLabelProvider>
      )}
      {state.status === "ready-stochastic" && (
        <ScenarioLabelProvider scenarios={state.detail.scenarios}>
          <StochasticView runId={runId!} stochastic={state.stochastic} marketId={state.detail.refs?.marketId} />
        </ScenarioLabelProvider>
      )}
    </div>
  );
}

function RunPicker({
  runs,
  listError,
  selected,
  onSelect,
}: {
  runs: RunSummary[] | undefined;
  listError: string | undefined;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel">
      <h2>Run</h2>
      {listError !== undefined ? (
        <p className="desc">
          Run listing unavailable: <code>{listError}</code>
        </p>
      ) : runs === undefined ? (
        <p className="desc">Loading run list…</p>
      ) : runs.length === 0 ? (
        <p className="emptynote">The store holds no runs yet.</p>
      ) : (
        <div className="controls">
          {runs.map((r) => (
            <button
              key={r.runId}
              className={r.runId === selected ? "active" : ""}
              onClick={() => onSelect(r.runId)}
              title={`state: ${r.state}${r.mode === "stochastic" ? "; mode: stochastic (distribution envelope, not a deterministic result)" : ""}`}
            >
              {r.label ? `${r.label} (${r.runId})` : r.runId}
              {r.mode === "stochastic" ? " [stochastic]" : ""}
              {r.state !== "done" ? ` — ${r.state}` : ""}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A stochastic run's page: the distribution report as before, plus the Rates
 * tab behind a two-button view bar. The deterministic tab strip is
 * not painted here: the server refuses the deterministic result routes for a
 * stochastic run, and a control never appears for a refused read.
 */
function StochasticView({
  runId,
  stochastic,
  marketId,
}: {
  runId: string;
  stochastic: StochasticRunResult;
  marketId?: string;
}) {
  const [view, setView] = useState<"report" | "rates">("report");
  return (
    <>
      <div className="controls" style={{ marginTop: 14 }}>
        <button className={view === "report" ? "active" : ""} onClick={() => setView("report")}>
          Report
        </button>
        <button className={view === "rates" ? "active" : ""} onClick={() => setView("rates")}>
          Rates
        </button>
      </div>
      {view === "report" && (
        <StochasticReport sto={stochastic} jsonUrl={`/api/runs/${encodeURIComponent(runId)}/stochastic`} />
      )}
      {view === "rates" && <RatesPanel runId={runId} errorText={errorText} marketId={marketId} />}
    </>
  );
}

function RunReport({
  runId,
  detail,
  result: r,
  portfolio,
}: {
  runId: string;
  detail: RunDetail;
  result: RunResult;
  portfolio?: PortfolioListItem;
}) {
  const [tab, setTab] = useState<TabKey>("overview");
  const scenarioIds = r.nii.byScenario.map((s) => s.scenarioId);
  const [scenario, setScenario] = useState<string>(scenarioIds[0] ?? "S0");

  // The run detail carries scenario metadata but no family label map; family
  // ids render as themselves rather than through an invented label.
  const familyLabel = (id: string) => id;

  // The FTP tab exists only when the envelope carries the block (W2-A1 /
  // W3-A4b). A seasoned book OMITS it with the typed `ftp.seasoned-book`
  // register tag (rendered verbatim in the Overview register); older stored
  // envelopes simply predate the block. Either way, no control is painted for
  // a capability this run did not produce. The Views tab follows the same
  // rule: painted only when the envelope carries `views`, which a run without
  // a declared view does not. The Metrics tab follows it too: painted only
  // when the envelope carries a non-empty custom block.
  const tabs = TABS.filter(
    (t) =>
      (t.key !== "ftp" || r.ftp !== undefined) &&
      (t.key !== "views" || (r.views !== undefined && r.views.length > 0)) &&
      (t.key !== "metrics" || (r.custom !== undefined && Object.keys(r.custom).length > 0)),
  );
  // A tab selection that no longer exists for this run (e.g. FTP selected,
  // then a run without the block picked) falls back to Overview rather than
  // rendering an empty body.
  const activeTab: TabKey = tabs.some((t) => t.key === tab) ? tab : "overview";

  return (
    <>
      <div className="provbar" style={{ marginTop: 12 }}>
        <span>
          Run <code>{r.provenance.runId}</code>
        </span>
        <span>
          Schema <code>{r.schemaVersion}</code>
        </span>
        <span>
          Engine <code>{r.provenance.engineVersion}</code>
        </span>
        <span>
          Inputs hash <code>{r.provenance.inputsHash}</code>
        </span>
        <span>
          State <code>{detail.state}</code>
        </span>
      </div>

      <div className="controls" style={{ marginTop: 14 }}>
        {tabs.map((t) => (
          <button key={t.key} className={t.key === activeTab ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {(activeTab === "gap" || activeTab === "runoff" || activeTab === "nii" || activeTab === "views" || activeTab === "metrics") && (
        <div className="controls">
          <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 12, marginRight: 4 }}>
            Scenario:
          </span>
          {scenarioIds.map((s) => (
            <ScenarioButton key={s} id={s} active={s === scenario} onClick={() => setScenario(s)} />
          ))}
        </div>
      )}

      {activeTab === "overview" && <Overview result={r} />}
      {activeTab === "nii" && <NiiTable nii={r.nii} familyLabel={familyLabel} selected={scenario} />}
      {activeTab === "eve" && (
        <>
          <EveTable eve={r.eve} />
          {r.eve.keyRate !== undefined ? <KeyRatePanel keyRate={r.eve.keyRate} /> : null}
          {r.eve.channels !== undefined ? <ChannelsPanel channels={r.eve.channels} /> : null}
          {r.eve.keyRate === undefined && r.eve.channels === undefined ? (
            <p className="footnote">
              This run did not compute the opt-in key-rate / channel decompositions. They are
              cost-labeled engine opt-ins (each adds multiple full-book regenerations) and are not yet
              requestable through a platform submission; their absence is &ldquo;not run&rdquo;, not a
              rejected value.
            </p>
          ) : null}
        </>
      )}
      {activeTab === "ftp" && r.ftp !== undefined && (
        <FtpPanel
          ftp={r.ftp}
          familyLabel={familyLabel}
          ftpJsonUrl={`/api/runs/${encodeURIComponent(runId)}/result/ftp`}
        />
      )}
      {activeTab === "attribution" && <AttributionVerbatim attribution={r.attribution} />}
      {activeTab === "gap" && (
        <GapLadders repricing={r.gap.repricing} liquidity={r.gap.liquidity} selected={scenario} />
      )}
      {activeTab === "views" && <ViewsPanel runId={runId} result={r} scenario={scenario} errorText={errorText} />}
      {activeTab === "metrics" && r.custom !== undefined && <CustomMetricPanel custom={r.custom} scenario={scenario} />}
      {activeTab === "runoff" && <CashflowRunoff cashflows={r.cashflows} selected={scenario} />}
      {activeTab === "rates" && <RatesPanel runId={runId} errorText={errorText} marketId={detail.refs?.marketId} />}
      {activeTab === "provenance" && (
        <ProvenancePanel
          prov={r.provenance}
          gen={{
            positionCount: portfolio?.positionCount,
            asOf: portfolio?.asOf,
            portfolioLabel: portfolio?.label,
          }}
          schemaVersion={r.schemaVersion}
        />
      )}
      {activeTab === "export" && <ExportPanel runId={runId} />}
    </>
  );
}

function ScenarioButton({ id, active, onClick }: { id: string; active: boolean; onClick: () => void }) {
  const scenarioLabel = useScenarioLabel();
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      {scenarioLabel(id)}
    </button>
  );
}

/**
 * Overview: per-scenario headline fields, each a verbatim envelope read.
 * deltaEvePct is stored as a decimal fraction and displayed through signedPct
 * (which multiplies by 100 for display; unit-tested in format.test.ts).
 */
function Overview({ result: r }: { result: RunResult }) {
  const scenarioLabel = useScenarioLabel();
  return (
    <>
      <section className="panel">
        <h2>Headlines</h2>
        <p className="desc">
          Per-scenario headline figures, read verbatim from the stored envelope. NII columns are the engine's
          scenario totals, not client-side sums.
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                <th>EVE</th>
                <th>&Delta; EVE</th>
                <th>&Delta; EVE %</th>
                <th>NII net 12M</th>
                <th>NII net 24M</th>
                <th>Eff. dur. equity</th>
              </tr>
            </thead>
            <tbody>
              {r.eve.byScenario.map((s) => {
                const nii = r.nii.byScenario.find((n) => n.scenarioId === s.scenarioId);
                return (
                  <tr key={s.scenarioId}>
                    <td>{scenarioLabel(s.scenarioId)}</td>
                    <td className="num">{usdMM(s.eve)}</td>
                    <td className={`num ${signClass(s.deltaEveVsBase)}`}>{signedMM(s.deltaEveVsBase)}</td>
                    <td className={`num ${signClass(s.deltaEvePct)}`}>{signedPct(s.deltaEvePct)}</td>
                    <td className="num">{nii ? signedMM(nii.totalNet12) : "—"}</td>
                    <td className="num">{nii ? signedMM(nii.totalNet24) : "—"}</td>
                    <td className="num">
                      {s.durationSanityPassed && s.effectiveDurationEquity !== undefined ? (
                        years(s.effectiveDurationEquity)
                      ) : s.durationSanityPassed ? (
                        <span
                          className="muted"
                          title="Not computed: base-only durationMode measures durations at the base environment only. Not a rejected value."
                        >
                          n/a (base-only)
                        </span>
                      ) : (
                        <span className="flag" title="Duration sanity gate did not pass; value not trusted">
                          flagged
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="footnote">
          &Delta; EVE % is stored by the engine as a decimal fraction of base EVE and multiplied by 100 for
          display only. &ldquo;n/a (base-only)&rdquo; means the duration was not computed under base-only
          durationMode; &ldquo;flagged&rdquo; means the sanity gate rejected it. The two are different states
          and neither is a value.
        </p>
      </section>
      <NotImplementedPanel tags={r.notImplemented} />
    </>
  );
}

/**
 * Attribution, verbatim: the engine's stored headline decompositions with their
 * per-family, per-driver contributions exactly as emitted. No client-side
 * aggregation: unlike the v1 fixture (which pre-summed per-driver steps at
 * build time), this page shows the stored rows.
 */
function AttributionVerbatim({ attribution }: { attribution: AttributionResult }) {
  const scenarioLabel = useScenarioLabel();
  return (
    <section className="panel">
      <h2>Attribution</h2>
      <p className="desc">
        Decomposition of each headline delta versus base, verbatim from the envelope. Contributions are
        order-conditional (see the limitations page); the residual is sum(contributions) − totalDelta, reported,
        never hidden.
      </p>
      {attribution.headlines.length === 0 ? (
        <p className="emptynote">No attribution headlines in this result.</p>
      ) : (
        attribution.headlines.map((h) => (
          <div key={`${h.metric}:${h.scenarioId}`} style={{ marginTop: 12 }}>
            <p className="desc">
              <strong>{h.metric}</strong> — {scenarioLabel(h.scenarioId)}: base {signedMM(h.baseValue)},
              scenario {signedMM(h.scenarioValue)}, total &Delta; {signedMM(h.totalDelta)}, residual{" "}
              {signedMM(h.residual)}
            </p>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Family</th>
                    <th>Driver</th>
                    <th>Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {h.contributions.map((c, i) => (
                    <tr key={i}>
                      <td>{c.familyId}</td>
                      <td>{c.driver}</td>
                      <td className={`num ${signClass(c.amount)}`}>{signedMM(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

const EXPORT_TABLES: ExportTable[] = [
  "nii",
  "eve",
  "repricing-gap",
  "liquidity-gap",
  "attribution",
  "cashflows",
];

function ExportPanel({ runId }: { runId: string }) {
  return (
    <section className="panel">
      <h2>Export</h2>
      <p className="desc">
        CSV per table from the stored envelope, no recompute, full float precision. Every CSV opens with
        comment rows carrying runId, inputsHash, the curve the run built on, schemaVersion, and engineVersion, so a pasted table stays
        traceable to its run.
      </p>
      <ul>
        {EXPORT_TABLES.map((t) => (
          <li key={t}>
            <a href={exportCsvUrl(runId, t)}>{t}.csv</a>
          </li>
        ))}
        <li>
          <a href={`/api/runs/${encodeURIComponent(runId)}/result`}>
            result.json (the full envelope, the canonical export)
          </a>
        </li>
      </ul>
    </section>
  );
}
