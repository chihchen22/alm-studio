// apps/studio/src/pages/results/NiiConventions.tsx
/**
 * The NII tab's two earnings conventions side by side. The runoff card is the engine's own NII:
 * the existing book runs off and nothing replaces it. The constant balance card is the seg block's
 * convention: runoff is replaced by new vintages and the shock starts at step 1. Each card
 * carries its NIM; the second adds the four sources of the change. Every figure is a stored field.
 */
import type { SegResult } from "@alm/engine";
import { signedMM, usdMM } from "@alm/reader";
import { baseScenarioId } from "../../results/readouts";
import { blockOf, type TabProps } from "./common";

const nim = (v: number): string => `${v.toFixed(2)}%`;

function RunoffCard(p: TabProps) {
  const nii = blockOf(p.result, "nii");
  const ids = (nii?.byScenario ?? []).map((s) => s.scenarioId);
  const id = baseScenarioId(p.detail, ids);
  const row = id === null ? undefined : nii?.byScenario.find((s) => s.scenarioId === id);
  return (
    <section className="card" aria-label="Runoff convention">
      <div className="card-title">Runoff convention (engine)</div>
      <p className="card-desc">The existing book runs off and nothing replaces it; the shock starts at step 0.</p>
      {row === undefined ? <p className="unobs-text">The envelope has no base scenario NII row.</p> : (
        <dl className="kv">
          <dt>Net interest income, 12 months</dt><dd className="num" title={`nii.byScenario[scenarioId=${row.scenarioId}].totalNet12`}>{usdMM(row.totalNet12)}</dd>
          <dt>Scenario</dt><dd>{p.scenarioLabel(row.scenarioId)}</dd>
        </dl>
      )}
      <p className="kv-status">
        {nii?.nimPct === undefined
          ? <span className="status status-unobs" title="The engine writes nii.nimPct only when the run opts in to seg">NIM not in this run</span>
          : <span className="num" title="nii.nimPct">NIM {nim(nii.nimPct)}</span>}
      </p>
      <p className="card-foot">Source: nii.byScenario, nii.nimPct</p>
    </section>
  );
}

function ConstantCard(props: { seg: SegResult; runId: string }) {
  const { seg } = props;
  const n = seg.book.nii;
  const groups = seg.byAttributionGroup === undefined ? null : Object.entries(seg.byAttributionGroup);
  return (
    <section className="card table-card" aria-label="Constant balance sheet convention">
      <div className="card-title">Constant balance sheet convention</div>
      <p className="card-desc">Runoff is replaced by new vintages, so the balance sheet stays constant; the shock starts at step 1, so month 1 is unshocked. Changes are the shocked level less the base level.</p>
      <dl className="kv">
        <dt>Net interest income, {seg.niiHorizonMonths} months</dt><dd className="num" title="seg.book.nii.base12">{usdMM(n.base12)}</dd>
        <dt>+{seg.niiShockBp}bp, change</dt><dd className="num" title="seg.book.nii.up12">{signedMM(n.up12 - n.base12)}</dd>
        <dt>−{seg.niiShockBp}bp, change</dt><dd className="num" title="seg.book.nii.down12">{signedMM(n.down12 - n.base12)}</dd>
      </dl>
      <p className="kv-status"><span className="num" title="seg.nimPct">NIM {nim(seg.nimPct)}</span></p>
      {groups === null ? (
        <p className="unobs-text">No split by source: no position carries the attributionGroup dimension.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Source</th><th scope="col" className="num">+{seg.niiShockBp}bp, change</th><th scope="col" className="num">−{seg.niiShockBp}bp, change</th></tr></thead>
            <tbody>
              {groups.map(([group, g]) => (
                <tr key={group}>
                  <th scope="row" title={group}>{group.replace(/_/g, " ")}</th>
                  <td className="num">{signedMM(g.up12 - g.base12)}</td>
                  <td className="num">{signedMM(g.down12 - g.base12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">Source: /api/runs/{props.runId}/result seg.book.nii, seg.nimPct, seg.byAttributionGroup</p>
    </section>
  );
}

/** Nothing for a run that did not opt in to seg: the NII tab stays as it was. */
export function NiiConventions(p: TabProps) {
  const seg = blockOf(p.result, "seg");
  if (seg === undefined) return null;
  return (
    <>
      <RunoffCard {...p} />
      <ConstantCard seg={seg} runId={p.runId} />
    </>
  );
}
