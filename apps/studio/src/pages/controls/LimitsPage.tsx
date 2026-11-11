// apps/studio/src/pages/controls/LimitsPage.tsx
/**
 * Govern > Controls > Limits (Controls, read-only first build). Lists each stored lens from GET /api/lenses: its
 * label and objective, then its constraints (reader, test, limit, label). Every number is a stored field, printed as
 * the Explain > Lenses tab prints a limit. Read-only: the seed is the only writer of a lens, so the page has no
 * control that edits one. Scoring a run through these lenses is the Lenses tab and the Dashboard's Limit use card.
 */
import { listLenses, sig, type LensListItem } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";

/** The stored op in words. */
function opText(op: string): string {
  return op === "atMost" ? "at most" : op === "atLeast" ? "at least" : op;
}

/** The reader's stored parameters, key=value joined by "; " in stored key order. */
function paramsText(params: Record<string, string | number>): string {
  return Object.entries(params).map(([k, v]) => `${k}=${v}`).join("; ");
}

function LensDefinitionCard(props: { lens: LensListItem }) {
  const l = props.lens;
  return (
    <section className="card table-card" aria-label={`Lens ${l.id}`}>
      <div className="card-title">{l.label}</div>
      <p className="card-desc">Objective {l.objective}; id <span className="mono">{l.id}</span>.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Constraint</th><th scope="col">Reader</th><th scope="col">Test</th><th scope="col" className="num">Limit</th><th scope="col">Label</th></tr></thead>
          <tbody>
            {l.constraints.map((c) => (
              <tr key={c.id}>
                <th scope="row" className="mono">{c.id}</th>
                <td className="mono">{c.reader}{c.params !== undefined ? <span className="muted"> {paramsText(c.params)}</span> : null}</td>
                <td>{opText(c.op)}</td>
                <td className="num">{sig(c.limit)}</td>
                <td>{c.label ?? <span className="muted">No label stored</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-foot">Content hash <span className="mono">{l.contentHash}</span></p>
    </section>
  );
}

/** The stored lenses, one card each, in the order the route returned them. Props only. */
export function LimitsView(props: { lenses: LensListItem[] }) {
  return (
    <>
      <section className="card" aria-label="About these limits">
        {props.lenses.length === 0
          ? <p className="unobs-text">The store holds no lens definition, so /api/lenses returned none.</p>
          : <p className="card-desc">The {props.lenses.length} stored lenses are demonstration values: every limit is illustrative, and none is a calibrated or governed limit.</p>}
        <p className="card-desc">Editing is not available yet: the seed is the only writer, and this page only reads.</p>
        <p className="card-foot">Source: /api/lenses</p>
      </section>
      {props.lenses.map((l) => <LensDefinitionCard key={l.id} lens={l} />)}
    </>
  );
}

export function LimitsPage() {
  const load = useLoad(() => listLenses(), []);
  if (load.state === "loading") return <div className="card muted">Reading the stored lenses</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <LimitsView lenses={load.value} />;
}
