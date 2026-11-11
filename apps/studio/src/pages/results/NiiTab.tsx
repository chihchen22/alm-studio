// apps/studio/src/pages/results/NiiTab.tsx
/**
 * NII tab (Studio S3a): the horizon block and the selected scenario's monthly
 * net vector, both as stored. The horizon nets are the engine's own partial
 * sums of that vector; nothing is summed here.
 */
import { NOT_IN_RUN, niiHorizonRows, niiMonthlyNet, signedMM } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { moneyTick } from "../../format/figures";
import { usd } from "../../balance/targetsModel";
import { shortfallRows, type ShortfallRow } from "../../results/shortfallRows";
import { NewBusinessChip, newBusinessNote, newBusinessRead } from "../../results/newBusiness";
import { blockOf, NotInRun, ScenarioPicker, selectedScenario, type TabProps } from "./common";
import { BasisNotes } from "./NiiBasisNotes";
import { NiiConventions } from "./NiiConventions";
import { NewBusinessBlock } from "./NewBusinessBlock";
import { NiiMonthlyCard } from "./NiiMonthlyCard";
import { niiCaption, windowOf } from "./niiWindow";

/** A shortfall row's React key: the JSON pair, so "a-b" with "c" and "a" with "b-c" stay apart (Piece 2 bugs). */
export function shortfallKey(r: ShortfallRow): string {
  return JSON.stringify([r.scenarioId, r.familyId]);
}

/** Where a dynamic scenario could not reach its target. Values as stored, in full USD. */
/** `bound` says the run's provenance names a balance plan (results/newBusiness); it splits the two empty states. */
export function ShortfallCard(props: { runId: string; rows: ShortfallRow[]; bound: boolean; scenarioLabel(id: string): string }) {
  return (
    <section className="card table-card" aria-label="Target shortfalls">
      <div className="card-title">Target shortfalls</div>
      <p className="card-desc">Where new business could not hold a family on its balance target. The engine originates only and never sells, so a target below the runoff path ends above target.</p>
      {props.rows.length === 0 ? (
        props.bound
          ? <p className="kv-status"><span className="status status-pass">Every target held</span> No shortfall stored: new business held every target in the scenarios that ran it.</p>
          : <p className="kv-status"><span className="status status-unobs">No balance plan</span> This run binds no balance plan, so there is no target to check.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Scenario</th><th scope="col">Family</th><th scope="col">Rule</th><th scope="col" className="num">Target at end, USD</th><th scope="col" className="num">Achieved at end, USD</th><th scope="col" className="num">Gap, USD</th><th scope="col" className="num">First short bucket</th><th scope="col" className="num">Short buckets</th></tr></thead>
            <tbody>
              {props.rows.map((r) => (
                <tr key={shortfallKey(r)}>
                  <th scope="row">{props.scenarioLabel(r.scenarioId)}</th>
                  <td className="mono">{r.familyId}</td>
                  <td>{r.reinvest}</td>
                  <td className="num">{usd(r.targetBalanceEnd)}</td>
                  <td className="num">{usd(r.achievedBalanceEnd)}</td>
                  <td className="num">{usd(r.balanceGapEnd)}</td>
                  <td className="num">{r.firstBucket}</td>
                  <td className="num">{r.clampedBuckets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">Source: /api/runs/{props.runId}/result nii.byScenario[].shortfalls</p>
    </section>
  );
}

export function NiiTab(p: TabProps) {
  const nii = blockOf(p.result, "nii");
  if (nii === undefined) return <NotInRun title="NII" reason="The envelope carries no nii block." />;
  const table = niiHorizonRows(p.result);
  const ids = table.rows.map((r) => r.scenarioId);
  const sel = selectedScenario(ids, p.query);
  const monthly = sel === null ? null : niiMonthlyNet(p.result, sel);
  const nb = newBusinessRead(p.result);
  // The window opens on the run's nii.windowMonths, else 60 months, and runs to the grid length (slice three
  // decision 118); an explicit ?window= wins. The label is the run's own, by provenance.
  const label = p.basisLabel ?? null;
  const grid = p.result.cashflows?.grid?.horizonMonths ?? (monthly !== null && monthly.kind === "series" ? monthly.values.length : 0);
  const window = windowOf(p.query, grid > 0 ? grid : 60, nii.windowMonths);
  const stored = sel === null ? null : table.rows.find((r) => r.scenarioId === sel) ?? null;
  const storedNet = (months: number): number | null => {
    const c = stored?.cells.find((x) => x.horizonMonths === months);
    return c !== undefined && c.read.kind === "value" ? c.read.value : null;
  };
  return (
    <>
      <NiiConventions {...p} />
      <section className="card table-card" aria-label="NII by horizon">
        <div className="card-title">Net interest income by horizon</div>
        <p className="card-desc">The engine's horizon sums. The 12 and 24 month columns are the pinned fields; any other horizon reads totalNetByHorizon.</p>
        {p.basisLabel !== undefined && p.basisLabel !== null ? <p className="card-desc">Basis: {p.basisLabel}</p> : null}
        <BasisNotes basisLabel={label} products={p.result.nii.byScenario.some((s) => (s.newBusiness ?? []).some((n) => n.product?.source === "template"))} />
        {nb !== null ? <p className="card-desc" role="note">{newBusinessNote(nb)}</p> : null}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Scenario</th>{table.horizons.map((h) => <th scope="col" key={h} className="num">Net {h}m</th>)}</tr></thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.scenarioId}>
                  <th scope="row">{p.scenarioLabel(r.scenarioId)} <span className="mono muted">{r.scenarioId}</span>{nb?.mapped.includes(r.scenarioId) ? <> <NewBusinessChip scenarioId={r.scenarioId} /></> : null}</th>
                  {r.cells.map((c) => c.read.kind === "value"
                    ? <td key={c.horizonMonths} className="num" title={c.envelopePath}>{signedMM(c.read.value)}</td>
                    : <td key={c.horizonMonths} className="num"><span className="status status-unobs" title={c.read.reason}>{NOT_IN_RUN}</span></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-foot">Source: /api/runs/{p.runId}/result nii.byScenario</p>
      </section>
      <ShortfallCard runId={p.runId} rows={shortfallRows(p.result)} bound={nb !== null} scenarioLabel={p.scenarioLabel} />
      {sel === null ? null : <ScenarioPicker ws={p.ws} ids={ids} selected={sel} query={p.query} label={p.scenarioLabel} />}
      {sel === null || monthly === null ? null : monthly.kind === "not-in-run" ? (
        <NotInRun title="Monthly net interest" reason={monthly.reason} />
      ) : (
        <figure className="card viz" aria-label="Monthly net interest">
          <div className="viz-head"><div className="card-title">Monthly net interest, {p.scenarioLabel(sel)}</div></div>
          <p className="card-desc">{niiCaption(window, label)}</p>
          {/* Bucket k is calendar month k + 1 on a linear month axis. No area: the values are signed (Polish 13). */}
          <LinePlot
            series={[{ id: sel, label: p.scenarioLabel(sel), points: monthly.values.slice(0, window).map((v, k): Point => [k + 1, v]), tone: "accent" }]}
            xScale="linear"
            xTicks={monthTicks}
            xLabel={(m) => `M${m}`}
            yTick={moneyTick}
            zoom
            unit="USD per month, side-signed"
            format={signedMM}
          />
          <figcaption className="card-foot">Source: nii.byScenario[scenarioId={sel}].netMonthly. Bucket k is calendar month k+1.</figcaption>
        </figure>
      )}
      {sel === null ? null : (
        <NiiMonthlyCard
          runId={p.runId}
          scenarioId={sel}
          scenarioLabel={p.scenarioLabel}
          window={window}
          family={p.query.family !== undefined && p.query.family !== "" ? p.query.family : null}
          basisLabel={label}
          query={p.query}
          stored={{ net12: storedNet(12), net24: storedNet(24) }}
          result={p.result}
          node={p.query.node !== undefined && p.query.node !== "" ? p.query.node : null}
        />
      )}
      {sel === null ? null : <NewBusinessBlock result={p.result} scenarioId={sel} scenarioLabel={p.scenarioLabel} basisLabel={label} window={window} />}
    </>
  );
}
