// apps/studio/src/pages/analysis/ReportsStep.tsx
/**
 * Step 9, Reports (S2a spec point 9). A report builder after the run: metric, scenarios, horizon, granularity (monthly
 * and buckets today) and grouping (family, account node, position, tag through a dimension view); view the table,
 * compare two runs, export at full precision. A grouping the run did not store is offered as "re-run with this added":
 * the setup is saved with it and the Run step launches it. A stochastic run opens its distributions.
 */
import { useMemo, useState } from "react";
import { exportCsvUrl, getInstruments, getPivot, getPortfolio, getResult, getRun, getStochasticSummary, rollUpCsvUrl, stochasticSummaryCsvUrl } from "@alm/reader";
import type { RollUpAlignment } from "@alm/engine/src/report/rollUp";
import type { InstrumentsFile, PivotMetric, PivotResult, PortfolioSpec, RunResult } from "@alm/engine";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { money, moneyTick } from "../../format/figures";
import { pct } from "@alm/reader";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { hrefFor } from "../../router";
import { GUIDED_SLOT } from "../../guided/steps";
import { withInstrumentResults, withView } from "../../guided/setup";
import {
  ALIGNMENT_LABEL, buildReport, compareTables, distributionReading, goingConcernDifference, goingConcernSpanText, GRANULARITY_LABEL, GROUPING_LABEL, METRIC_LABEL, metricsFor, normalizeChoice, optionsFor, reportCsv,
  TAG_MEASURE_LABEL, tagMeasureFor, tagMeasuresOn, tagTable,
  type Granularity, type Grouping, type Metric, type ReportChoice, type ReportTable,
} from "../../guided/report";
import { StochasticRunPage } from "../results/StochasticRunPage";
import { ActionLines, Details, downloadText, linkedRunText, runText, saveGuided, useAction, type StepContext } from "./common";

interface RunOption { runId: string; text: string; kind: "deterministic" | "stochastic" }

export function runOptions(ctx: Pick<StepContext, "runs" | "stochastic">): RunOption[] {
  const det = ctx.runs
    .filter((r) => r.status?.state === "done")
    .sort((a, b) => (a.setupLineageId === GUIDED_SLOT ? -1 : 0) - (b.setupLineageId === GUIDED_SLOT ? -1 : 0))
    .map((r) => ({ runId: r.runId, text: `${runText({ runId: r.runId, label: r.status?.label, endedAt: r.status?.endedAt })}${r.setupLineageId === GUIDED_SLOT ? "" : " (Advanced setup)"}`, kind: "deterministic" as const }));
  const sto = ctx.stochastic.filter((r) => r.status?.state === "done").map((r) => ({ runId: r.runId, text: `${linkedRunText(r)} (stochastic)`, kind: "stochastic" as const }));
  return [...det, ...sto];
}

/** The deterministic run the Reports step shows: the address's run when it is one of the options, else the first (M4). */
export function reportsRunId(ctx: Pick<StepContext, "runs" | "stochastic" | "query">): string | null {
  const options = runOptions(ctx);
  const picked = options.find((o) => o.runId === ctx.query.run) ?? options[0] ?? null;
  return picked !== null && picked.kind === "deterministic" ? picked.runId : null;
}

export function ReportsStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const options = runOptions(ctx);
  const [runId, setRunId] = useState<string | null>(ctx.query.run ?? options[0]?.runId ?? null);
  const picked = options.find((o) => o.runId === runId) ?? options[0] ?? null;
  if (picked === null) return <section className="card"><p className="guided-warn">No run of this analysis is done yet. Launch it on the Run step; its reports open here.</p></section>;
  return (
    <>
      <section className="card" aria-label="Run">
        <label className="field">
          <span className="field-label">Run</span>
          <select className="guided-select" aria-label="Run" value={picked.runId} onChange={(e) => { setRunId(e.target.value); ctx.go("reports", { ...ctx.query, run: e.target.value }); }}>
            {options.map((o) => <option key={o.runId} value={o.runId}>{o.text}</option>)}
          </select>
        </label>
      </section>
      {picked.kind === "stochastic" ? <StochasticPlain runId={picked.runId} ws={ctx.ws} /> : <Builder ctx={ctx} runId={picked.runId} others={options.filter((o) => o.kind === "deterministic" && o.runId !== picked.runId)} />}
    </>
  );
}

/** `labels` names each scenario as the run stored it (L4): S100 reads "Parallel +100 bp"; an export keeps the ids. */
interface Loaded { result: RunResult; book: PortfolioSpec; labels: Record<string, string> }

async function loadRun(runId: string, bookId: string): Promise<Loaded> {
  const [result, book, detail] = await Promise.all([getResult(runId), getPortfolio(bookId), getRun(runId).catch(() => null)]);
  const labels: Record<string, string> = {};
  for (const sc of detail?.scenarios ?? []) labels[sc.id] = sc.label ?? sc.id;
  return { result, book: book as PortfolioSpec, labels };
}

function Builder(props: { ctx: StepContext; runId: string; others: RunOption[] }) {
  const { ctx } = props;
  const bookId = ctx.head.blocks.positions.book?.id ?? "";
  const load = useLoad(() => loadRun(props.runId, bookId), [props.runId, bookId]);
  if (load.state === "loading") return <div className="card muted">Reading the run</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <BuilderBody ctx={ctx} runId={props.runId} data={load.value} others={props.others} />;
}

/** The book's authorable tag dimensions with the values its positions carry. */
function tagDims(book: PortfolioSpec): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  for (const p of book.positions) for (const d of Object.keys(p.dimensions ?? {})) if (d !== "behavioralClasses") seen.add(d);
  return [...seen].map((id) => ({ id, label: book.taxonomy?.dimensions.find((d) => d.id === id)?.label ?? id }));
}

function BuilderBody(props: { ctx: StepContext; runId: string; data: Loaded; others: RunOption[] }) {
  const { ctx, data } = props;
  const scenarioIds = data.result.nii.byScenario.map((s) => s.scenarioId);
  const [raw, setRaw] = useState<ReportChoice>({ metric: "nii", scenarios: scenarioIds, horizon: data.result.nii.horizonsMonths[0] ?? 12, granularity: "horizon", grouping: "family", focus: "" });
  const [tagDim, setTagDim] = useState<string>("");
  const choice = normalizeChoice(raw, data.result);
  const opts = optionsFor(choice.metric);
  const rolled = choice.granularity === "quarterly" || choice.granularity === "annual";
  const set = (patch: Partial<ReportChoice>) => setRaw({ ...raw, ...patch });
  const dims = tagDims(data.book);
  // Per-position results are read only when the reader asks for them: most runs do not store them.
  const inst = useLoad(() => (choice.grouping === "position" ? getInstruments(props.runId).catch(() => null) : Promise.resolve(null)), [props.runId, choice.grouping === "position"]);
  const instruments: InstrumentsFile | null = inst.state === "ok" ? inst.value : null;
  const instLoading = choice.grouping === "position" && inst.state === "loading";

  const built = useMemo((): { table: ReportTable | null; error: string | null } => {
    if (choice.grouping === "tag") return { table: null, error: null };
    if (choice.grouping === "position" && instruments === null) return { table: null, error: null };
    try {
      return { table: buildReport(data.result, data.book, choice, instruments), error: null };
    } catch (e) {
      return { table: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [data, instruments, JSON.stringify(choice)]);

  const focusOptions = choice.grouping === "account"
    ? data.book.coa.nodes.filter((n) => n.parentId === null).map((n) => ({ id: n.id, label: n.label }))
    : data.book.coa.families.map((f) => ({ id: f.id, label: f.label }));

  return (
    <>
      <ValueCard result={data.result} labels={data.labels} />
      <section className="card" aria-label="Report builder">
        <div className="card-title">Build a report</div>
        <div className="guided-row">
          <label className="field">
            <span className="field-label">Metric</span>
            <select className="guided-select" aria-label="Metric" value={choice.metric} onChange={(e) => set({ metric: e.target.value as Metric })}>
              {metricsFor(data.result).map((m) => <option key={m} value={m}>{METRIC_LABEL[m]}</option>)}
            </select>
          </label>
          {choice.metric === "nii" || choice.metric === "newvolume" || choice.metric === "balance" ? (
            <label className="field">
              <span className="field-label">Horizon</span>
              <select className="guided-select" aria-label="Horizon" value={choice.horizon} onChange={(e) => set({ horizon: Number(e.target.value) })}>
                {data.result.nii.horizonsMonths.map((h) => <option key={h} value={h}>{`${h} months`}</option>)}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span className="field-label">Granularity</span>
            <select className="guided-select" aria-label="Granularity" value={choice.granularity} onChange={(e) => set({ granularity: e.target.value as Granularity })}>
              {opts.granularities.map((g) => <option key={g} value={g}>{GRANULARITY_LABEL[g]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Group by</span>
            <select className="guided-select" aria-label="Group by" value={choice.grouping} onChange={(e) => set({ grouping: e.target.value as Grouping, focus: "" })}>
              {opts.groupings.map((g) => <option key={g} value={g}>{GROUPING_LABEL[g]}</option>)}
            </select>
          </label>
          {(choice.metric === "nii" || choice.metric === "newvolume") && (choice.granularity === "monthly" || rolled) ? (
            <label className="field">
              <span className="field-label">Show</span>
              <select className="guided-select" aria-label="Show" value={choice.focus} onChange={(e) => set({ focus: e.target.value })}>
                <option value="">The whole balance sheet</option>
                {(choice.grouping === "account" || choice.grouping === "family" || choice.metric === "newvolume" ? (choice.metric === "newvolume" ? data.book.coa.families.map((f) => ({ id: f.id, label: f.label })) : focusOptions) : []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
          ) : null}
          {choice.metric === "balance" && choice.grouping === "family" ? (
            <label className="field">
              <span className="field-label">Family</span>
              <select className="guided-select" aria-label="Family" value={choice.focus === "" ? (data.result.cashflows.byScenario[0]?.byFamily.find((f) => (f.series.balance[0] ?? 0) !== 0)?.familyId ?? "") : choice.focus} onChange={(e) => set({ focus: e.target.value })}>
                {data.book.coa.families.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
          ) : null}
          {rolled ? (
            <label className="field">
              <span className="field-label">Periods</span>
              <select className="guided-select" aria-label="Periods" value={choice.alignment ?? "cutoff"} onChange={(e) => set({ alignment: e.target.value as RollUpAlignment })}>
                {(["cutoff", "calendar"] as const).map((a) => <option key={a} value={a}>{ALIGNMENT_LABEL[a]}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        <fieldset className="guided-fieldset">
          <legend>Scenarios</legend>
          <div className="chip-row">
            {scenarioIds.map((id) => (
              <label key={id} className="guided-option">
                <input type="checkbox" checked={choice.scenarios.includes(id)} onChange={() => set({ scenarios: choice.scenarios.includes(id) ? choice.scenarios.filter((x) => x !== id) : [...choice.scenarios, id] })} />
                <span title={id}>{scenarioName(data.labels, id)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {rolled ? <p className="field-help">Flows add up over each period; balances show the end of the period with the average beside it; rates are the period's interest over its balances, annualised. Value has no quarterly or annual view.</p> : null}
      </section>
      {choice.grouping === "position" && !instLoading && instruments === null ? <RerunCard ctx={ctx} what="per-position results" edit={(s) => withInstrumentResults(s, data.book.coa.nodes.filter((n) => n.parentId === null).map((n) => n.id))} /> : null}
      {choice.grouping === "tag" ? <TagReport ctx={ctx} runId={props.runId} dims={dims} dim={tagDim} setDim={setTagDim} metric={choice.metric} choice={choice} asOf={data.result.cashflows.grid.asOf} labels={data.labels} viewIds={(data.result.views ?? []).map((v) => v.viewId)} offer={tagMeasuresOn(data.result, choice.scenarios)} /> : null}
      {built.error !== null ? (
        built.error.startsWith("monthly buckets") ? <section className="card"><p className="guided-warn">This run stored the nine standard buckets only. Choose Gap buckets, or set monthly buckets in the setup under Advanced and run again.</p></section>
          : <section className="card" role="alert">{built.error}</section>
      ) : null}
      {built.table !== null ? <TableCard table={built.table} runId={props.runId} labels={data.labels} /> : null}
      {built.table !== null && props.others.length > 0 ? <CompareCard ctx={ctx} a={built.table} others={props.others} choice={choice} book={data.book} /> : null}
      <section className="card" aria-label="More">
        <div className="guided-links">
          <span>Full exports from the run:</span>
          <a href={exportCsvUrl(props.runId, "nii")}>NII CSV</a>
          <a href={exportCsvUrl(props.runId, "eve")}>EVE CSV</a>
          <a href={exportCsvUrl(props.runId, "repricing-gap")}>Repricing gap CSV</a>
          <a href={exportCsvUrl(props.runId, "liquidity-gap")}>Liquidity gap CSV</a>
          <a href={rollUpCsvUrl(props.runId, "quarter", choice.alignment ?? "cutoff")}>Quarterly roll-up CSV</a>
          <a href={rollUpCsvUrl(props.runId, "year", choice.alignment ?? "cutoff")}>Annual roll-up CSV</a>
          <a href={hrefFor({ ws: ctx.ws, section: "results", screen: "dashboard", query: { result: props.runId } })}>Open the run under Advanced</a>
        </div>
      </section>
    </>
  );
}

/** A scenario's name for a reader: the run's own label, with the id when they differ. */
function scenarioName(labels: Record<string, string>, id: string): string {
  const l = labels[id];
  return l === undefined || l === id ? id : `${l} (${id})`;
}

function TableCard(props: { table: ReportTable; runId: string; labels?: Record<string, string> }) {
  const t = props.table;
  const chartable = t.rowHead === "Month" && t.rows.length > 1;
  return (
    <section className="card table-card" aria-label="Report">
      <div className="card-title">{t.title}</div>
      {chartable ? (
        <figure className="viz">
          <LinePlot
            series={t.columns.slice(0, 6).map((c, i) => ({ id: c, label: c, tone: (["accent", "second", "third", "fourth", "fifth", "sixth"] as const)[i]!, points: t.rows.map((r, m) => [m + 1, r.values[i] ?? null] as Point) }))}
            xScale="linear" xTicks={monthTicks} xLabel={(m) => `Month ${m}`} yTick={moneyTick} format={money} unit="dollars" zoom
          />
        </figure>
      ) : null}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">{t.rowHead === "" ? "" : t.rowHead}</th>{t.columns.map((c) => <th key={c} scope="col" className="num" title={c}>{props.labels?.[c] ?? c}</th>)}</tr></thead>
          <tbody>
            {t.rows.map((r, ri) => <tr key={r.label}><td>{r.label}</td>{r.values.map((v, i) => <td key={i} className="num">{v === null ? "Not stored" : t.rowUnits?.[ri] === "rate" ? pct(v, 2) : money(v)}</td>)}</tr>)}
            {t.total !== null ? <tr><td><strong>{t.total.label}</strong></td>{t.total.values.map((v, i) => <td key={i} className="num"><strong>{v === null ? "Not stored" : money(v)}</strong></td>)}</tr> : null}
          </tbody>
        </table>
      </div>
      {t.notes.length > 0 ? <ul className="guided-missing">{t.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      <div className="guided-actions">
        <button type="button" className="btn" onClick={() => downloadText(`report-${props.runId}.csv`, reportCsv(t, props.runId))}>Export this table (CSV, full precision)</button>
        <span className="field-help">Figures on screen are in millions with one decimal; the export carries every digit the run stored.</span>
      </div>
    </section>
  );
}

function CompareCard(props: { ctx: StepContext; a: ReportTable; others: RunOption[]; choice: ReportChoice; book: PortfolioSpec }) {
  const [b, setB] = useState<string>("");
  const [col, setCol] = useState<string>(props.a.columns[0] ?? "");
  const load = useLoad(() => (b === "" ? Promise.resolve(null) : getResult(b)), [b]);
  let table: ReportTable | null = null;
  let err: string | null = null;
  if (load.state === "ok" && load.value !== null) {
    try {
      table = compareTables(props.a, buildReport(load.value, props.book, props.choice), col);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <section className="card" aria-label="Compare two runs">
      <div className="card-title">Compare with another run</div>
      <div className="guided-row">
        <label className="field">
          <span className="field-label">Run B</span>
          <select className="guided-select" aria-label="Run B" value={b} onChange={(e) => setB(e.target.value)}>
            <option value="">Choose a run</option>
            {props.others.map((o) => <option key={o.runId} value={o.runId}>{o.text}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Scenario</span>
          <select className="guided-select" aria-label="Scenario to compare" value={col} onChange={(e) => setCol(e.target.value)}>
            {props.a.columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {load.state === "error" ? <p className="guided-bad">{errText(load.error)}</p> : null}
      {err !== null ? <p className="guided-bad">{err}</p> : null}
      {table !== null ? <TableCard table={table} runId={`${props.ctx.ws}-compare`} /> : null}
    </section>
  );
}

function RerunCard(props: { ctx: StepContext; what: string; edit: Parameters<typeof saveGuided>[1] }) {
  const { ctx } = props;
  const act = useAction();
  const onAdd = () => act.run("Add", async () => {
    await saveGuided(ctx, props.edit);
    ctx.refresh();
    ctx.go("run");
  });
  return (
    <section className="card" aria-label="Re-run with this added">
      <p className="guided-note">{`This run did not store ${props.what}. Add them to the analysis and run it again: the setup is saved with them, and the Run step launches it.`}</p>
      <div className="guided-actions">
        <button type="button" className="btn btn-primary" disabled={act.busy || ctx.guided === null} onClick={onAdd}>{`Re-run with ${props.what} added`}</button>
        {ctx.guided === null ? <span className="field-help">This run came from an Advanced setup; answer the New volume step to start your own.</span> : null}
      </div>
      <ActionLines busy={act.busy} error={act.error} done={act.done} />
    </section>
  );
}

/**
 * A report by one tag on every pivot measure (S2b-3 spec point 3): the reader picks the tag and the measure; the
 * table is read from the run's view by that tag (one pivot per scenario) and built by `tagTable`.
 */
function TagReport(props: { ctx: StepContext; runId: string; dims: Array<{ id: string; label: string }>; dim: string; setDim: (d: string) => void; metric: Metric; choice: ReportChoice; asOf: string; labels: Record<string, string>; viewIds: string[]; offer: { measures: PivotMetric[]; note: string | null } }) {
  const dim = props.dim === "" ? props.dims[0]?.id ?? "" : props.dim;
  const [picked, setPicked] = useState<PivotMetric | null>(null);
  const wanted = picked ?? tagMeasureFor(props.metric);
  // Fix round M1: only a measure the run stores by tag on these scenarios is offered or asked for.
  const measure = props.offer.measures.includes(wanted) ? wanted : props.offer.measures.includes("evePv") && props.metric === "nii" ? "evePv" : props.offer.measures[0] ?? "evePv";
  const load = useLoad(async (): Promise<PivotResult[] | { missing: true } | { error: string } | "none"> => {
    if (dim === "") return "none";
    // The run's own views say whether it stored this one; only an absent view is offered the re-run.
    if (!props.viewIds.includes(`by-${dim}`)) return { missing: true };
    try {
      return await Promise.all(props.choice.scenarios.map((s) => getPivot(props.runId, { view: `by-${dim}`, metric: measure, scenarioId: s })));
    } catch (e) {
      return { error: errText(e) };
    }
  }, [props.runId, dim, measure, props.choice.scenarios.join(","), props.viewIds.join(",")]);
  if (props.dims.length === 0) return <section className="card"><p className="guided-note">Your positions carry no tags, so there is nothing to group by tag. Add a column named dim.&lt;tag&gt; to the positions file (for example dim.region) and import it again: each such column becomes a tag.</p></section>;
  const label = props.dims.find((d) => d.id === dim)?.label ?? dim;
  let table: ReportTable | null = null;
  let err: string | null = null;
  if (load.state === "ok" && Array.isArray(load.value)) {
    try {
      table = tagTable(load.value, measure, label, { months: props.choice.horizon, granularity: props.choice.granularity, ...(props.choice.alignment !== undefined ? { alignment: props.choice.alignment } : {}), asOf: props.asOf });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <>
      <section className="card" aria-label="Tag">
        <div className="guided-row">
          <label className="field">
            <span className="field-label">Tag</span>
            <select className="guided-select" aria-label="Tag" value={dim} onChange={(e) => props.setDim(e.target.value)}>
              {props.dims.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Measure</span>
            <select className="guided-select" aria-label="Measure" value={measure} onChange={(e) => setPicked(e.target.value as PivotMetric)}>
              {props.offer.measures.map((m) => <option key={m} value={m}>{TAG_MEASURE_LABEL[m]}</option>)}
            </select>
          </label>
        </div>
      </section>
      {props.offer.note !== null ? <section className="card"><p className="guided-note">{props.offer.note}</p></section> : null}
      {load.state === "ok" && typeof load.value === "object" && "missing" in load.value ? <RerunCard ctx={props.ctx} what={`a view by ${label}`} edit={(s) => withView(s, dim, `By ${label}`)} /> : null}
      {load.state === "ok" && typeof load.value === "object" && "error" in load.value ? <section className="card" role="alert">{load.value.error}</section> : null}
      {err !== null ? <section className="card" role="alert">{err}</section> : null}
      {table !== null ? <TableCard table={table} runId={props.runId} labels={props.labels} /> : null}
      {load.state === "loading" ? <div className="card muted">Reading the view</div> : null}
    </>
  );
}

/**
 * A stochastic run in plain figures (millions, one decimal): the mean and the 5th, 50th and 95th percentiles of value
 * and of 12-month net interest income, and the fit against its gate. The run's full statistics, at full precision,
 * are behind Details and in its CSV.
 */
function StochasticPlain(props: { runId: string; ws: string }) {
  const load = useLoad(() => getStochasticSummary(props.runId), [props.runId]);
  if (load.state === "loading") return <div className="card muted">Reading the run</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const sum = load.value;
  const eve = distributionReading(sum.eveDistribution.rows as never);
  const nii = distributionReading(sum.nii12mDistribution.rows as never);
  const cal = sum.calibration as unknown as { rmseBp?: number; rmseGateBp?: number; rmseGateBreached?: boolean };
  const cell = (v: number | null) => <td className="num">{v === null ? "Not stored" : money(v)}</td>;
  return (
    <>
      <section className="card table-card" aria-label="Stochastic run">
        <div className="card-title">Distribution across the simulated paths, base scenario</div>
        <div className="table-wrap guided-tall">
          <table className="table">
            <thead><tr><th scope="col">Measure</th><th scope="col" className="num">Mean</th><th scope="col" className="num">5th percentile</th><th scope="col" className="num">Median</th><th scope="col" className="num">95th percentile</th></tr></thead>
            <tbody>
              <tr><td>Economic value of equity</td>{cell(eve.mean)}{cell(eve.p5)}{cell(eve.p50)}{cell(eve.p95)}</tr>
              <tr><td>Net interest income, 12 months</td>{cell(nii.mean)}{cell(nii.p5)}{cell(nii.p50)}{cell(nii.p95)}</tr>
            </tbody>
          </table>
        </div>
        {typeof cal?.rmseBp === "number" ? (
          <p className={cal.rmseGateBreached === true ? "guided-warn" : "guided-ok"}>{`Rate model fit: ${cal.rmseBp.toFixed(2)} bp against a ${cal.rmseGateBp ?? "stated"} bp gate, ${cal.rmseGateBreached === true ? "above the gate (disclosed)" : "within the gate"}.`}</p>
        ) : null}
        <p className="field-help">A distribution of the paths, not a single value; the positions run off on every path. A stochastic value is not comparable with a deterministic one: the bases differ.</p>
        <div className="guided-actions"><a className="btn" href={stochasticSummaryCsvUrl(props.runId)}>Export the statistics (CSV, full precision)</a></div>
      </section>
      <section className="card" aria-label="Full statistics">
        <Details summary="Details: every stored statistic of this run, at full precision">
          <StochasticRunPage ws={props.ws} query={{ run: props.runId }} />
        </Details>
      </section>
    </>
  );
}

/**
 * Run-off and going-concern value side by side (S2b-2 spec point 3), shown only when the run stored the
 * going-concern block: the base scenario's two values, the new volume's value between them, and the one sentence on
 * the difference. Every figure is a stored number.
 */
function ValueCard(props: { result: RunResult; labels: Record<string, string> }) {
  const gc = props.result.eve.goingConcern;
  if (gc === undefined) return null;
  const base = props.result.eve.byScenario.find((s) => s.deltaEveVsBase === 0 && gc.byScenario.some((g) => g.scenarioId === s.scenarioId)) ?? props.result.eve.byScenario[0];
  const row = base === undefined ? undefined : gc.byScenario.find((g) => g.scenarioId === base.scenarioId);
  if (base === undefined || row === undefined) return null;
  return (
    <section className="card" aria-label="Run-off and going-concern value">
      <div className="card-title">{`Value: run-off and going concern, ${props.labels[base.scenarioId] ?? base.scenarioId}`}</div>
      <dl className="guided-pair">
        <div><dt>Run-off EVE (the regulatory measure)</dt><dd>{money(base.eve)}</dd></div>
        <div><dt>{`Value of the ${goingConcernSpanText(gc)}`}</dt><dd>{money(row.newVolumeValue)}</dd></div>
        <div><dt>Going-concern EVE</dt><dd>{money(row.eve)}</dd></div>
      </dl>
      <p className="field-help">{goingConcernDifference(gc)}</p>
      <p className="field-help">Choose Economic value of equity below to read both values in every scenario, by family as well.</p>
    </section>
  );
}
