// apps/studio/src/run/CompiledChainPanel.tsx
/**
 * The compiled chain, read-only (spec v3.1 Section 5.5, ruling 8). The model chain canvas retired as an editor: the
 * run setup is the editor, and this panel shows the stages the compiler built from it, one row per stage with its
 * id, component, kind, consumes, produces and dependsOn, and the two gate reports. It is a list by default so it fits
 * a phone. It carries no button, input, drag handle or editable region, and it has no handler of its own.
 */
import type { GateFailure, GateReport, GateRule, PlanStage } from "@alm/engine";
import type { SetupValidationEntry } from "@alm/reader";

export interface ChainGates {
  type: GateReport;
  routing: GateReport;
}

const GATE_RULES: readonly string[] = ["T1", "T2", "T3", "T4", "T5", "T6", "R1", "R2", "R3", "R4"] satisfies readonly GateRule[];

function isGateFailure(x: unknown): x is GateFailure {
  if (typeof x !== "object" || x === null) return false;
  if (!("gate" in x) || (x.gate !== "type" && x.gate !== "routing")) return false;
  if (!("rule" in x) || typeof x.rule !== "string" || !GATE_RULES.includes(x.rule)) return false;
  if (!("detail" in x) || typeof x.detail !== "string") return false;
  return "stageId" in x && (x.stageId === null || typeof x.stageId === "string");
}

function isStringList(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((c) => typeof c === "string");
}

function isGateReport(x: unknown): x is GateReport {
  if (typeof x !== "object" || x === null) return false;
  if (!("passed" in x) || typeof x.passed !== "boolean") return false;
  if (!("failures" in x) || !Array.isArray(x.failures) || !x.failures.every(isGateFailure)) return false;
  return "checked" in x && isStringList(x.checked);
}

/**
 * The two gate reports a refused compile carries in its error detail (the plan routes' 422 body, kept as
 * `reports.error.detail` by the validate route), or null when the detail is anything else.
 */
export function refusalGates(detail: unknown): ChainGates | null {
  if (typeof detail !== "object" || detail === null || !("type" in detail) || !("routing" in detail)) return null;
  const { type, routing } = detail;
  return isGateReport(type) && isGateReport(routing) ? { type, routing } : null;
}

function words(list: readonly string[] | undefined): string {
  return list === undefined || list.length === 0 ? "none" : list.join(", ");
}

function GateLine(props: { name: string; report: GateReport }) {
  const { report } = props;
  const failures = report.failures.length;
  const checks = report.checked.length;
  const head = `${report.passed ? "Passed" : failures > 0 ? "Refused" : "Not run"}: ${failures} ${failures === 1 ? "failure" : "failures"}, ${checks} ${checks === 1 ? "check line" : "check lines"}`;
  return (
    <div className="chain-gate">
      <div className="chain-gate-head">
        <span className="field-label">{`${props.name} gate`}</span> <span>{head}</span>
      </div>
      {failures > 0 ? (
        <ul className="chain-gate-list">
          {report.failures.map((f, i) => (
            <li key={i}>{`${f.rule}${f.stageId === undefined || f.stageId === null ? "" : ` at ${f.stageId}`}: ${f.detail}`}</li>
          ))}
        </ul>
      ) : null}
      {checks > 0 ? (
        <ul className="chain-gate-list muted">
          {report.checked.map((c, i) => (
            <li key={i} className="mono">{c}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Gates(props: { gates: ChainGates | null }) {
  if (props.gates === null) return null;
  return (
    <div className="chain-gates">
      <GateLine name="Type" report={props.gates.type} />
      <GateLine name="Routing" report={props.gates.routing} />
    </div>
  );
}

/**
 * `stored` is the newest stored validation of the setup when this session holds none: its stages are not stored
 * with it, so the card says that rather than that nothing was ever compiled.
 */
export function CompiledChainPanel(props: { stages: readonly PlanStage[]; gates: ChainGates | null; stored?: SetupValidationEntry | null }) {
  const { stages, gates } = props;
  if (stages.length === 0) {
    const stored = props.stored !== undefined && props.stored !== null;
    return (
      <section className="card chain-panel" aria-label="Compiled chain">
        <div className="card-title">Compiled chain <span className="chip">Read-only</span></div>
        <p className="card-desc">
          {stored
            ? "The stages are not stored with a validation. Validate again to see them."
            : "No compiled chain yet. Validate the setup: the chain appears once its inputs resolve and the compiler builds the stages."}
        </p>
        <Gates gates={gates} />
      </section>
    );
  }
  const hasBalance = stages.some((s) => s.id === "st-balance");
  return (
    <section className="card chain-panel" aria-label="Compiled chain">
      <div className="card-title">Compiled chain <span className="chip">Read-only</span></div>
      <p className="card-desc">The stages the compiler built from this setup. Change the setup, not the chain.</p>
      <ol className="chain-list">
        {stages.map((s) => (
          <li key={s.id} className="chain-stage">
            <div className="chain-head">
              <span className="mono">{s.id}</span>
              <span className="chain-component">{s.component}</span>
              <span className="chip">{s.kind}</span>
            </div>
            <dl className="chain-meta">
              <dt>Consumes</dt>
              <dd>{words(s.consumes)}</dd>
              <dt>Produces</dt>
              <dd>{words(s.produces)}</dd>
              <dt>Depends on</dt>
              <dd>{words(s.dependsOn)}</dd>
            </dl>
            {s.note !== undefined && s.note !== "" ? <p className="field-help">{s.note}</p> : null}
          </li>
        ))}
      </ol>
      {hasBalance ? (
        <p className="field-help">st-balance sits between st-cashflow and st-nii: NII reads the balance stage's series; EVE and gap stay on the contractual stage.</p>
      ) : null}
      <Gates gates={gates} />
    </section>
  );
}
