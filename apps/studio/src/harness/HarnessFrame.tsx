// apps/studio/src/harness/HarnessFrame.tsx
/**
 * The plug-in harness frame (spec v3.1 Section 4.1), read-only in Slice 1: the instances of one module on the left,
 * and for the selected one a method menu with each method's availability, its settings as a definition list, its
 * inputs, its validation state, what uses it and where it came from. The Formula and Code slots are reserved and say
 * so. The frame draws what it is given; the instances come from `instances.ts`, and nothing here writes.
 */
import { ReadinessChip } from "../shell/ReadinessChip";
import { reservedMethods, type HarnessInstanceView, type HarnessMethod, type HarnessModule } from "./instances";

export const MODULE_LABEL: Record<HarnessModule, string> = {
  curve: "Curve construction",
  "vol-surface": "Volatility surface",
  "rate-model": "Rate model",
  "rate-index": "Rate index",
  "import-template": "Import template",
  behavioral: "Behavioral assumption",
  "new-business-template": "New-business template",
};

const PIECE_TEXT: Record<NonNullable<HarnessMethod["piece"]>, string> = { B: "a later release", C: "a later release", D: "a later release", later: "a later phase" };

function Availability(props: { method: HarnessMethod }) {
  const { method } = props;
  if (method.availability === "mounted") return <span className="chip chip-runs">mounted</span>;
  if (method.availability === "catalog") return <span className="chip chip-catalog">engine: later phase</span>;
  if (method.availability === "preview") return <span className="chip chip-catalog">surface preview</span>;
  return <span className="chip chip-catalog">reserved, {PIECE_TEXT[method.piece ?? "later"]}</span>;
}

function usedByText(u: HarnessInstanceView["usedBy"][number]): string {
  if (u.kind === "position" && u.count !== undefined) return `${u.count.toLocaleString("en-US")} ${u.count === 1 ? "position" : "positions"}`;
  return u.id;
}

export interface HarnessFrameProps {
  module: HarnessModule;
  instances: HarnessInstanceView[];
  /** The engine-backed methods of the module; the module's reserved list is appended here. */
  methods: HarnessMethod[];
  /** The instance on the right; null opens the first. */
  selected: string | null;
  /** The address of an instance, when the page keeps the selection in the URL; absent means a plain list. */
  hrefOf?: (id: string) => string;
}

export function HarnessFrame(props: HarnessFrameProps) {
  const { module, instances, hrefOf } = props;
  const chosen = instances.find((i) => i.id === props.selected) ?? instances[0] ?? null;
  const have = new Set(props.methods.map((m) => m.id));
  const menu = [...props.methods, ...reservedMethods(module).filter((m) => !have.has(m.id))];
  const inUse = (m: HarnessMethod): boolean => chosen !== null && (m.id === chosen.methodId || (m.aliases ?? []).includes(chosen.methodId));
  return (
    <section className="card harness" aria-label={`${MODULE_LABEL[module]} instances and methods`}>
      <div className="card-title">{MODULE_LABEL[module]}</div>
      <div className="harness-grid">
        <nav className="harness-list" aria-label="Instances">
          <div className="run-sub">Instances</div>
          {instances.length === 0 ? (
            <p className="card-desc">No instance in this release.</p>
          ) : (
            <ul className="list">
              {instances.map((i) => (
                <li key={i.id}>
                  {hrefOf === undefined
                    ? <span aria-current={chosen !== null && i.id === chosen.id ? "true" : undefined}>{i.name}</span>
                    : <a href={hrefOf(i.id)} aria-current={chosen !== null && i.id === chosen.id ? "true" : undefined}>{i.name}</a>}{" "}
                  <ReadinessChip state={i.validation.state} />
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="harness-body">
          <section aria-label="Method">
            <div className="run-sub">Method</div>
            <ul className="list harness-methods">
              {menu.map((m) => (
                <li key={m.id} aria-current={inUse(m) ? "true" : undefined}>
                  {m.label} <span className="mono">{m.id}</span> <Availability method={m} />
                  {inUse(m) ? <> <span className="status status-pass">In use</span></> : null}
                  {m.note !== undefined ? <span className="muted"> {m.note}</span> : null}
                  {m.link !== undefined ? <> <a href={m.link.href}>{m.link.text}</a></> : null}
                </li>
              ))}
            </ul>
          </section>
          {chosen === null ? (
            <>
              {["Settings", "Inputs", "Validation", "Used by", "Provenance"].map((region) => (
                <section key={region} aria-label={region}>
                  <div className="run-sub">{region}</div>
                  <p className="card-desc">No instance to show.</p>
                </section>
              ))}
            </>
          ) : (
            <>
              <section aria-label="Settings">
                <div className="run-sub">Settings</div>
                <dl className="kv">
                  {chosen.settings.flatMap((s, k) => [<dt key={`t${k}`}>{s.label}</dt>, <dd key={`d${k}`}>{s.value}</dd>])}
                </dl>
                <p className="card-foot">Read-only in this release. Settings are edited where the document is saved.</p>
              </section>
              <section aria-label="Inputs">
                <div className="run-sub">Inputs</div>
                {chosen.inputs.length === 0 ? <p className="card-desc">No input.</p> : (
                  <ul className="list">{chosen.inputs.map((x) => <li key={`${x.kind}:${x.ref}`}><span className="muted">{x.kind}</span> <span className="mono">{x.ref}</span></li>)}</ul>
                )}
              </section>
              <section aria-label="Validation">
                <div className="run-sub">Validation</div>
                <p><ReadinessChip state={chosen.validation.state} /></p>
                {chosen.validation.messages.map((m, k) => <p className="card-desc" key={k}>{m}</p>)}
              </section>
              <section aria-label="Used by">
                <div className="run-sub">Used by</div>
                {chosen.usedBy.length === 0 ? <p className="card-desc">Nothing in this workspace uses it yet.</p> : (
                  <ul className="list">{chosen.usedBy.map((u) => <li key={`${u.kind}:${u.id}`}><span className="mono">{usedByText(u)}</span></li>)}</ul>
                )}
              </section>
              <section aria-label="Provenance">
                <div className="run-sub">Provenance</div>
                <dl className="kv">
                  <dt>Recorded by</dt><dd>{chosen.provenance.by ?? "not recorded"}</dd>
                  <dt>Recorded at</dt><dd>{chosen.provenance.at ?? "not recorded"}</dd>
                  <dt>Content hash</dt><dd className="mono">{chosen.provenance.contentHash ?? "not recorded"}</dd>
                </dl>
              </section>
            </>
          )}
          <section aria-label="Custom">
            <div className="run-sub">Custom</div>
            <ul className="list">
              <li>Formula: <span className="muted">not available in this release</span></li>
              <li>Code: <span className="muted">not available in this release</span></li>
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
