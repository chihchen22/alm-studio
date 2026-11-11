/**
 * Plan route (harness Plane 4, pieces 1 and 1b): paste a run plan, validate it,
 * read the gates, the compile block, the composed profile and the run log, then
 * run it. Every line is the server's own answer verbatim; the page computes
 * nothing and never turns a missing check into a pass.
 * Styling reuses the workbench panel classes; the redesign is piece 4.
 */
import { useEffect, useState } from "react";
import type { GateReport, RunLogEntry, ScenarioLibrary } from "@alm/engine";
import type { Profile } from "@alm/harness";
import type { ValidateResponse } from "@alm/reader";
import { ApiError, getPlanLibrary, runPlan, validatePlan } from "@alm/reader";
import type { RunLogNode } from "@alm/reader";
import { gateRows, runLogTree } from "@alm/reader";

const STARTER = JSON.stringify({
  schemaVersion: "1.4.0", planId: "PLAN-VANILLA-1", label: "Vanilla book, regulatory grid", authoredBy: "person", asOf: "2026-03-31",
  grid: { horizonMonths: 360 },
  inputs: { marketSnapshot: "market-public-2026-03-31", positionBook: "vanilla-book-v1", routingPolicy: "model-map-default-v1", assumptionSets: ["vanilla-empty-v1"] },
  stages: [
    { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
    { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
    { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
    { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
    { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve"], produces: ["EveResult"], dependsOn: ["st-curve", "st-cashflow"] },
    { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule"], produces: ["GapResult"], dependsOn: ["st-cashflow"] },
  ],
  scenarios: [{ ref: "regulatory-grid-v1#S0" }, { ref: "regulatory-grid-v1#S100" }, { ref: "regulatory-grid-v1#S-100" }, { ref: "regulatory-grid-v1#S200" }, { ref: "regulatory-grid-v1#S-200" }],
  reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
  validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
}, null, 2);

type Reports = ValidateResponse;

/**
 * The workbench table rule right-aligns and nowraps every cell past the first,
 * which suits figures and mangles a sentence. A gate detail is a sentence, so
 * the detail column alone opts out, inline: no stylesheet rule is added here.
 */
const DETAIL_CELL = { textAlign: "left", whiteSpace: "normal" } as const;

function GateTable({ title, report }: { title: string; report: GateReport }) {
  const rows = gateRows(report);
  return (
    <section className="panel">
      <h3>{title}: {report.passed ? "PASS" : `${rows.length} failure(s)`}</h3>
      {rows.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Rule</th><th>Stage</th><th style={DETAIL_CELL}>Detail</th></tr></thead>
            <tbody>{rows.map((r, i) => (<tr key={i}><td>{r.rule}</td><td>{r.stage}</td><td style={DETAIL_CELL}>{r.detail}</td></tr>))}</tbody>
          </table>
        </div>
      )}
      <details><summary>{report.checked.length} checks run</summary><ul>{report.checked.map((c, i) => <li key={i}>{c}</li>)}</ul></details>
    </section>
  );
}

/** One node of the run-log tree, rendered with the browser's own disclosure widget. */
function LogNode({ node }: { node: RunLogNode }) {
  if (node.children.length === 0) return <li>{node.label}</li>;
  return (
    <li>
      <details open>
        <summary>{node.label}</summary>
        <ul>{node.children.map((child, i) => <LogNode key={i} node={child} />)}</ul>
      </details>
    </li>
  );
}

function RunLogPanel({ entries }: { entries: RunLogEntry[] }) {
  const tree = runLogTree(entries);
  if (tree.length === 0) return null;
  return (
    <section className="panel">
      <h3>Run log</h3>
      <p>Every number in a result traces to an entry here: what was mounted, where its code came from, and which plugin answered for each seam.</p>
      <ul>{tree.map((node, i) => <LogNode key={i} node={node} />)}</ul>
    </section>
  );
}

function ProfilePanel({ profile, hash }: { profile: Profile; hash?: string }) {
  return (
    <section className="panel">
      <h3>Composed profile{hash ? ` (${hash.slice(0, 12)})` : ""}</h3>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Row</th><th style={DETAIL_CELL}>Plugin</th><th>State</th></tr></thead>
          <tbody>
            {profile.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td style={DETAIL_CELL}><code>{row.plugin}</code></td>
                <td>{row.disabled === true ? "disabled" : "active"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CompilePanel({ compile }: { compile: Reports["compile"] }) {
  return (
    <section className="panel">
      <h3>Compile: {compile.passed ? "PASS" : "REFUSED"}</h3>
      {compile.error && <p><code>{compile.error}</code></p>}
      {compile.detail && <p className="error" role="alert">{compile.detail}</p>}
      {compile.passed && <p>The profile mounts, every stage has a mounted component, and every scenario can run as declared.</p>}
    </section>
  );
}

export function PlanPage() {
  const [text, setText] = useState(STARTER);
  const [reports, setReports] = useState<Reports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [library, setLibrary] = useState<ScenarioLibrary[]>([]);

  useEffect(() => { getPlanLibrary().then(setLibrary).catch(() => setLibrary([])); }, []);

  const parse = (): unknown | null => {
    try { setError(null); return JSON.parse(text); } catch (e) { setError(`not JSON: ${(e as Error).message}`); return null; }
  };
  const onValidate = () => {
    const plan = parse();
    if (plan === null) return;
    setRunId(null);
    validatePlan(plan).then(setReports).catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)));
  };
  /**
   * A 422 plan_rejected carries the two gate reports in `detail`. Show them in
   * the same panels the Validate button fills: the refusal IS the report, and
   * reducing it to one message line would hide the server's own reasoning.
   * The reports are set verbatim; nothing here is re-derived.
   */
  const refusalReports = (e: unknown): Reports | null => {
    if (!(e instanceof ApiError) || typeof e.detail !== "object" || e.detail === null) return null;
    const d = e.detail as { type?: unknown; routing?: unknown; compile?: unknown };
    const isReport = (r: unknown): r is GateReport =>
      typeof r === "object" && r !== null && Array.isArray((r as GateReport).failures);
    if (!isReport(d.type) || !isReport(d.routing)) return null;
    // The refusal's own compile block when the server sent one, else the
    // refusal message in its place. Neither is synthesized into a pass.
    const isCompile = (c: unknown): c is Reports["compile"] =>
      typeof c === "object" && c !== null && typeof (c as { passed?: unknown }).passed === "boolean";
    return {
      type: d.type,
      routing: d.routing,
      compile: isCompile(d.compile) ? d.compile : { passed: false, detail: e.message },
    };
  };
  const onRun = () => {
    const plan = parse();
    if (plan === null) return;
    runPlan(plan).then((r) => setRunId(r.runId)).catch((e: unknown) => {
      const refusal = refusalReports(e);
      if (refusal) setReports(refusal);
      setError(e instanceof ApiError ? e.message : String(e));
    });
  };
  const canRun = reports !== null && reports.type.passed && reports.routing.passed && reports.compile.passed;

  return (
    <>
      <section className="panel">
        <h2>Run plan</h2>
        <p>A plan is data. Validate it, read the gate reports, the compile block, the composed profile and the run log, then run. The engine refuses a plan that fails either gate or whose profile will not compile.</p>
        <textarea
          aria-label="Run plan JSON"
          value={text}
          onChange={(e) => { setText(e.target.value); setReports(null); setRunId(null); setError(null); }}
          rows={24}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={onValidate}>Validate</button>
          <button onClick={onRun} disabled={!canRun} title={canRun ? undefined : "Validate first; both gates and the compile must pass"}>Run</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {runId && <p>Submitted run <a href={`#/results/${runId}`}>{runId}</a>.</p>}
      </section>
      {reports && (<><GateTable title="Type gate" report={reports.type} /><GateTable title="Routing gate" report={reports.routing} /></>)}
      {reports && <CompilePanel compile={reports.compile} />}
      {reports?.profile && <ProfilePanel profile={reports.profile} hash={reports.profileHash} />}
      {reports?.runLog && <RunLogPanel entries={reports.runLog} />}
      <section className="panel">
        <h3>Scenario library</h3>
        <ul>{library.map((l) => <li key={l.id}><code>{l.id}</code>: {l.label} ({l.scenarios.map((s) => s.id).join(", ")})</li>)}</ul>
      </section>
    </>
  );
}
