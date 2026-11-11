// apps/studio/src/pages/results/OverviewTab.tsx
/** Overview (Studio S3a): the headline table. Hover a value for the envelope field it was read from. */
import { NOT_IN_RUN } from "@alm/reader";
import { overviewModel, type OverviewCell } from "../../results/overview";
import { NotInRun, type TabProps } from "./common";

function HeadlineCell(props: { cell: OverviewCell }) {
  const c = props.cell;
  if (c.read.kind === "not-in-run") return <td className="num"><span className="status status-unobs" title={c.read.reason}>{NOT_IN_RUN}</span></td>;
  return <td className="num" title={c.headline.envelopePath}>{c.text}</td>;
}

export function OverviewTab(p: TabProps) {
  const model = overviewModel(p.result);
  return (
    <>
      {model.missing.map((m) => <NotInRun key={m.block} title={m.block === "eve" ? "EVE" : "NII"} reason={m.reason} />)}
      {model.rows.length === 0 ? null : (
        <section className="card table-card" aria-label="Headlines by scenario">
          <div className="card-title">Headlines by scenario</div>
          <p className="card-desc">EVE and NII at 12 and 24 months as the envelope stores them. Hover a value for its field.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Scenario</th><th scope="col" className="num">EVE</th><th scope="col" className="num">NII 12m</th><th scope="col" className="num">NII 24m</th></tr></thead>
              <tbody>
                {model.rows.map((r) => (
                  <tr key={r.scenarioId}>
                    <th scope="row">{p.scenarioLabel(r.scenarioId)} <span className="mono muted">{r.scenarioId}</span></th>
                    <HeadlineCell cell={r.eve} />
                    <HeadlineCell cell={r.nii12} />
                    <HeadlineCell cell={r.nii24} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="card-foot">Source: /api/runs/{p.runId}/result, fields {model.rows[0]!.eve.headline.envelopePath}, {model.rows[0]!.nii12.headline.envelopePath}, {model.rows[0]!.nii24.headline.envelopePath} and the same per scenario</p>
        </section>
      )}
    </>
  );
}
