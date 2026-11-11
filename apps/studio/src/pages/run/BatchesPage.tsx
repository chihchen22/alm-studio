// apps/studio/src/pages/run/BatchesPage.tsx
/**
 * Run > Batches (spec v3.1 Section 3.1): the Batch tab of each setup, listed across the workspace's setups. A row is
 * edited on its setup; this screen only reads, and each setup name opens that setup's Batch tab.
 */
import "../../styles/run-setups.css";
import { listRunSetups } from "@alm/reader";
import { pageErrText } from "../../errText";
import { hrefFor } from "../../router";
import { batchOverview } from "../../rows/setupRows";
import { useLoad } from "../../useLoad";

export function BatchesPage(props: { ws: string }) {
  const load = useLoad(() => listRunSetups(props.ws), [props.ws]);
  if (load.state === "loading") return <div className="card muted">Reading the run setups</div>;
  if (load.state === "error") return <div className="card" role="alert">{pageErrText(load.error)}</div>;
  const rows = batchOverview(load.value.setups);
  return (
    <section className="card" aria-label="Batches">
      <div className="card-title">Batches</div>
      <p className="card-desc">Each row is one launch of its setup. Launch validates every row first and submits nothing if any row fails. Edit rows on the setup's Batch tab.</p>
      {rows.length === 0 ? (
        <p className="field-help">No setup in this workspace holds a batch row.</p>
      ) : (
        <ul className="batches-list" aria-label="Batch rows across setups">
          {rows.map((r) => (
            <li key={`${r.lineageId}-${r.rowNo}`} className="batches-row">
              <div className="chip-row">
                <a href={hrefFor({ ws: props.ws, section: "run", screen: "setups", slot: r.lineageId, query: { tab: "batch" } })}>{r.setupName}</a>
                <span className="chip">{`Row ${r.rowNo}`}</span>
                <strong>{r.label}</strong>
              </div>
              <dl className="kv">
                <dt>Scenarios</dt>
                <dd>{r.scenarios}</dd>
                <dt>Assumption set</dt>
                <dd>{r.assumptionSets}</dd>
                <dt>NII basis</dt>
                <dd>{r.basis}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
