// apps/studio/src/pages/results/NiiMonthlyCard.tsx
/**
 * The monthly NII card (spec v3.1 Sections 5.4 and 6.1): income, expense and net for every month of the
 * window, per scenario and per family, from GET /api/runs/:id/result/nii/monthly (engine contract 7), with a chart on
 * the existing LinePlot and a 12 and 24 month roll-up marked as derived. An absent reply prints its typed reason and
 * is not an error. Every figure carries the window and the basis label. Slice three (decisions 124 to 126) adds the
 * monthly detail for a family or an account node from the envelope in memory (monthlyDetail.ts), a CSV of every shown
 * series to the grid horizon, and the node picker; the chart of accounts is the reply's own `coa` field. Teaching slice
 * A4 fixes the CSV header: scenario and family or node columns, a unit on every column, RFC 4180 quoting.
 */
import type { RunResult } from "@alm/engine";
import type { NiiMonthlyReply, NiiMonthlyScenario } from "@alm/reader";
import { ApiError, getNiiMonthly, NOT_IN_RUN, pct, signedMM, usd, usdMM } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { moneyTick } from "../../format/figures";
import { errText } from "../../errText";
import type { Query } from "../../router";
import { useLoad } from "../../useLoad";
import { MONTHLY_ABSENT_TEXT } from "./NiiAbsentStates";
import { niiCaption, rollUp, setHashParam, setHashParams, windowChoices, MIN_WINDOW } from "./niiWindow";
import { familiesUnder, monthlyDetail, nodeIncome, NEXT_SENTENCE, SUMMED, type Coa, type Col } from "./monthlyDetail";

/** Either side of the stored-versus-derived check, in dollars: a float sum agrees to well within this. */
const MATCH_TOLERANCE = 0.5;

export interface NiiMonthlyViewProps {
  reply: NiiMonthlyReply;
  runId: string;
  scenarioId: string;
  scenarioLabel: (id: string) => string;
  window: number;
  /** One family's rows; null reads the scenario total. */
  family: string | null;
  basisLabel: string | null;
  query: Query;
  /** The envelope's stored 12 and 24 month nets for this scenario; null when the screen has none to compare. */
  stored: { net12: number | null; net24: number | null } | null;
  /** The envelope the page holds and the chosen account node; the chart rides on the reply. */
  result?: RunResult;
  node?: string | null;
}

function WindowControl(props: { window: number; grid: number }) {
  const min = Math.min(MIN_WINDOW, props.grid);
  return (
    <div className="nii-window" role="group" aria-label="NII window">
      <label className="field-label" htmlFor="nii-window-range">Window, months</label>
      <input
        id="nii-window-range"
        type="range"
        min={min}
        max={props.grid}
        step={1}
        value={props.window}
        onChange={(e) => setHashParam("window", e.target.value)}
        aria-valuetext={`${props.window} months`}
      />
      <span className="num">{props.window}</span>
      <span className="chip-row">
        {windowChoices(props.grid).map((m) => (
          <button key={m} type="button" className="pill" aria-pressed={m === props.window} onClick={() => setHashParam("window", String(m))}>{m}</button>
        ))}
      </span>
    </div>
  );
}

function FamilyChips(props: { families: string[]; family: string | null; nodes: string[]; node: string | null; coa: Coa | null }) {
  const name = (id: string) => props.coa?.nodes.find((n) => n.id === id)?.label;
  const all = props.family === null && props.node === null;
  return (
    <nav className="chip-row" aria-label="Family">
      <button type="button" className="pill" aria-pressed={all} onClick={() => setHashParams({ family: null, node: null })}>All families</button>
      {props.families.map((f) => (
        <button key={f} type="button" className="pill" aria-pressed={props.family === f} onClick={() => setHashParams({ family: f, node: null })}>{f}</button>
      ))}
      {props.nodes.length === 0 ? null : (
        <select aria-label="Account node" value={props.node ?? ""} onChange={(e) => setHashParams({ node: e.target.value === "" ? null : e.target.value, family: null })}>
          <option value="">Account node</option>
          {props.nodes.map((n) => <option key={n} value={n}>{name(n) === undefined ? n : `${name(n)}, ${n}`}</option>)}
        </select>
      )}
    </nav>
  );
}

/** Hand the viewer `text` as a file named `name` (the Gap tab's interest-inclusive ladder uses it too). */
export function downloadCsv(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** RFC 4180 cell: quoted only when it holds a comma, a quote or a line break, inner quotes doubled. */
const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The card's CSV. Each row names its scenario and its family (TOTAL for all families) or account node,
 * and each column head carries its unit: USD, or an annual rate as a decimal for the yield. Values are the series as
 * the card holds them, blank where a value is not worked out.
 */
export function niiMonthlyCsv(scenarioId: string, pick: { kind: "family" | "node"; id: string } | null, cols: Col[]): string {
  const unit = (c: Col) => (c.id === "yield" ? "annual rate as a decimal" : "USD");
  const head = ["scenarioId", "familyId", "coaNodeId", "Month", ...cols.map((c) => `${c.label} (${unit(c)}${c.note === undefined ? "" : `, ${c.note}`})`)];
  const family = pick === null ? "TOTAL" : pick.kind === "family" ? pick.id : "";
  const node = pick?.kind === "node" ? pick.id : "";
  const n = Math.max(0, ...cols.map((c) => c.values.length));
  const lines = [head.map(csvCell).join(",")];
  for (let k = 0; k < n; k++) lines.push([scenarioId, family, node, k + 1, ...cols.map((c) => c.values[k] ?? "")].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

type Series = { income: number[]; expense: number[]; net: number[] };

function seriesOf(s: NiiMonthlyScenario, family: string | null, node: string | null, coa: Coa | null): Series | null {
  if (node !== null) return coa === null ? null : nodeIncome(s, familiesUnder(coa, node));
  if (family === null) return s;
  return s.byFamily.find((f) => f.familyId === family) ?? null;
}

function RollUpTable(props: { s: Series; stored: NiiMonthlyViewProps["stored"]; total: boolean; basisLabel: string | null }) {
  const rows = [12, 24].map((m) => {
    const net = rollUp(props.s.net, m);
    const storedNet = m === 12 ? props.stored?.net12 : props.stored?.net24;
    return { m, income: rollUp(props.s.income, m), expense: rollUp(props.s.expense, m), net, storedNet: props.total ? storedNet ?? null : null };
  });
  const cell = (v: number | null, f: (n: number) => string) => (v === null ? <span className="status status-unobs">{NOT_IN_RUN}</span> : f(v));
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Derived roll-up of the monthly series</caption>
          <thead><tr><th scope="col">Window</th><th scope="col" className="num">Income</th><th scope="col" className="num">Expense</th><th scope="col" className="num">Net</th><th scope="col" className="num">Stored net</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m}>
                <th scope="row">{r.m} months <span className="chip" title="Summed here from the monthly rows above">derived</span></th>
                <td className="num">{cell(r.income, usdMM)}</td>
                <td className="num">{cell(r.expense, usdMM)}</td>
                <td className="num">{cell(r.net, signedMM)}</td>
                <td className="num">
                  {r.storedNet === null ? <span className="muted">not compared</span> : (
                    <>
                      {signedMM(r.storedNet)}{" "}
                      {r.net === null ? null : Math.abs(r.net - r.storedNet) <= MATCH_TOLERANCE
                        ? <span className="status status-pass">matches the stored horizon sum</span>
                        : <span className="status status-breach">differs from the stored horizon sum</span>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="nii-note">Derived roll-up: the sum of months 1 to 12 and 1 to 24 of the series above, computed here from the reader's monthly rows, not an engine field. The stored column is the engine's own horizon sum. {props.basisLabel === null ? "" : `Basis: ${props.basisLabel}.`}</p>
    </>
  );
}

/** The card for one reply. Props only, so every branch renders without a fetch. */
export function NiiMonthlyView(props: NiiMonthlyViewProps) {
  const { reply } = props;
  if (reply.kind === "absent") {
    return (
      <section className="card unobs-panel" aria-label="Monthly NII">
        <div className="card-title">Monthly NII</div>
        <span className="status status-unobs">Not stored</span>
        <p className="unobs-text">{MONTHLY_ABSENT_TEXT[reply.reason]}</p>
      </section>
    );
  }
  const node = props.family === null ? props.node ?? null : null;
  const coa = reply.coa ?? null;
  const scenario = reply.byScenario.find((s) => s.scenarioId === props.scenarioId);
  const s = scenario === undefined ? null : seriesOf(scenario, props.family, node, coa);
  if (scenario === undefined || s === null) {
    return (
      <section className="card unobs-panel" aria-label="Monthly NII">
        <div className="card-title">Monthly NII</div>
        <span className="status status-unobs">{NOT_IN_RUN}</span>
        <p className="unobs-text">
          {scenario === undefined
            ? `The monthly reader has no rows for scenario ${props.scenarioId}.`
            : node !== null
              ? `Node ${node} has no family rows to sum on scenario ${props.scenarioId}${coa === null ? ": the chart of accounts is not at hand" : ""}.`
              : `Family ${props.family} has no monthly rows on scenario ${props.scenarioId}.`}
        </p>
      </section>
    );
  }
  const grid = reply.horizonMonths;
  const window = Math.min(props.window, s.net.length);
  const months = Array.from({ length: window }, (_, k) => k);
  const points = (v: number[]): Point[] => months.map((k): Point => [k + 1, v[k]!]);
  const label = props.scenarioLabel(props.scenarioId);
  const subject = node !== null ? `${label}, node ${node}` : props.family === null ? label : `${label}, ${props.family}`;
  const pick = props.family !== null ? { kind: "family" as const, id: props.family } : node !== null ? { kind: "node" as const, id: node } : null;
  const detail = pick === null || props.result === undefined ? null : monthlyDetail({ result: props.result, scenarioId: props.scenarioId, label, pick, coa });
  const extra = detail?.cols ?? [];
  const nodeNote = node === null ? undefined : SUMMED;
  const csvCols: Col[] = [
    { id: "income", label: "Income", values: s.income, ...(nodeNote === undefined ? {} : { note: nodeNote }) },
    { id: "expense", label: "Expense", values: s.expense, ...(nodeNote === undefined ? {} : { note: nodeNote }) },
    { id: "net", label: "Net interest", values: s.net, ...(nodeNote === undefined ? {} : { note: nodeNote }) },
    ...extra,
  ];
  const nodes = props.result?.cashflows.byScenario.find((x) => x.scenarioId === props.scenarioId)?.byCoaNode.map((n) => n.coaNodeId) ?? [];
  return (
    <section className="card table-card" aria-label="Monthly NII">
      <div className="card-title">{niiCaption(props.window, props.basisLabel)}</div>
      <p className="card-desc">Income, expense and net per month, {subject}. Bucket k is calendar month k + 1; a derivative family books neither side and reads its net settlement.</p>
      <WindowControl window={props.window} grid={grid} />
      <FamilyChips families={scenario.byFamily.map((f) => f.familyId)} family={props.family} nodes={coa === null ? [] : nodes} node={node} coa={coa} />
      {node === null ? null : <p className="card-desc">Income, expense, net interest and originations for {node} are summed here from the family rows; balance, principal and interest are the node&apos;s own stored rows.</p>}
      <figure className="viz" aria-label="Income, expense and net">
        <LinePlot
          series={[
            { id: "income", label: "Income", points: points(s.income), tone: "accent" },
            { id: "expense", label: "Expense", points: points(s.expense), tone: "second" },
            { id: "net", label: "Net", points: points(s.net), tone: "third" },
          ]}
          xScale="linear"
          xTicks={monthTicks}
          xLabel={(m) => `M${m}`}
          yTick={moneyTick}
          zoom
          yZero
          unit="USD per month"
          format={(v) => usd(v)}
        />
        <figcaption className="card-foot">Source: GET /api/runs/{props.runId}/result/nii/monthly, scenario {props.scenarioId}.</figcaption>
      </figure>
      <RollUpTable s={s} stored={props.stored} total={pick === null} basisLabel={props.basisLabel} />
      {props.result === undefined ? null : pick === null
        ? <p className="card-desc">Pick a family or an account node for balance, principal, interest, yield and originations.</p>
        : detail!.notes.map((n) => <p key={n} className="card-desc" role="note">{n}</p>)}
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Monthly income, expense and net</caption>
          <thead><tr><th scope="col" className="num">Month</th><th scope="col" className="num">Income</th><th scope="col" className="num">Expense</th><th scope="col" className="num">Net</th>
            {extra.map((c) => <th key={c.id} scope="col" className="num">{c.label}{c.note === undefined ? null : <> <span className="chip">{c.note}</span></>}</th>)}</tr></thead>
          <tbody>
            {months.map((k) => (
              <tr key={k}>
                <th scope="row" className="num">{k + 1}</th>
                <td className="num">{usd(s.income[k]!)}</td>
                <td className="num">{usd(s.expense[k]!)}</td>
                <td className="num">{usd(s.net[k]!)}</td>
                {extra.map((c) => {
                  const v = c.values[k];
                  return <td key={c.id} className="num">{v === null || v === undefined ? "" : c.id === "yield" ? pct(v) : usd(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">Whole dollars as the engine reader returns them; the first {window} of {grid} months.
        {" "}<button type="button" className="pill" onClick={() => downloadCsv(`nii-monthly-${props.runId}-${props.scenarioId}-${pick?.id ?? "total"}.csv`, niiMonthlyCsv(props.scenarioId, pick, csvCols))}>Download CSV</button>
        {" "}The CSV carries every series shown, to month {grid}.</p>
      {props.result === undefined ? null : <p className="card-foot">{NEXT_SENTENCE}</p>}
    </section>
  );
}

/**
 * Reads the monthly reply and renders it. A stochastic run answers 409 with the reason in its message; that is the
 * same absent state the reply arm names, so it prints as one. Any other failure is a real error and says so.
 */
export function NiiMonthlyCard(props: Omit<NiiMonthlyViewProps, "reply">) {
  const load = useLoad(() => getNiiMonthly(props.runId), [props.runId]);
  if (load.state === "loading") return <div className="card muted" aria-label="Monthly NII">Reading monthly NII for {props.runId}</div>;
  if (load.state === "error") {
    if (load.error instanceof ApiError && load.error.status === 409) {
      return <NiiMonthlyView {...props} reply={{ kind: "absent", reason: "stochastic" }} />;
    }
    return <div className="card" role="alert" aria-label="Monthly NII">{errText(load.error)}</div>;
  }
  return <NiiMonthlyView {...props} reply={load.value} />;
}
