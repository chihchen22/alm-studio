// apps/studio/src/pages/results/StochasticGapCard.tsx
/**
 * The Gap distributions card of the Stochastic screen, shown only when the stored envelope carries `gap`
 * (the summary reply's block, verbatim). Two views on the `stogap` hash key, Repricing (SEG) by default and
 * Liquidity (EBP), the slice four-a pill pattern. Each row is a statistic of the run's Monte Carlo path set, never a
 * gap. Read view only: no launch control. Its CSV is built in the browser from the same block, both views at full
 * precision, as the NII monthly and the interest cards build theirs.
 */
import type { StochasticDistribution, StochasticGapBlock } from "@alm/engine";
import { usdMM, type StochasticCalibrationGate } from "@alm/reader";
import { gateChip } from "../../results/stochasticRun";
import {
  GAP_PS,
  GAP_VIEW_KEY,
  GAP_VIEWS,
  gapDistributionsCsv,
  gapMM,
  liquidityCumulativeRows,
  liquidityRows,
  quantileAt,
  repricingCumulativeRows,
  repricingRows,
  SIDE_LABEL,
  type GapStatRow,
  type GapView,
} from "../../results/stochasticGap";
import { downloadCsv } from "./NiiMonthlyCard";
import { setHashParam } from "./niiWindow";

export const GAP_CARD_TITLE = "Gap distributions";
export const GAP_CARD_SENTENCE = "Each row is a statistic of this run's Monte Carlo path set, never a gap.";

/** The card's notes, one per ruling the reader needs (spec Section 2 rulings 2, 5 to 7, rulings). */
export function gapNotes(g: StochasticGapBlock): string[] {
  return [
    "Hull-White only: BGM gap needs a general tenor rule.",
    `${g.horizonMonths} months: the SEG block runs to month ${g.horizonMonths}, so the bands are 0-1M to 5-10Y; what is still outstanding at month ${g.horizonMonths} is the beyond-horizon line, outstanding beyond 10 years, not banded.`,
    "The standard error is the standard error of the mean over antithetic-pair averages (nPaths / 2 independent samples).",
    `Repricing (SEG) follows the delta of accrued income under a ${g.shockBp} bp half-shock (convention ${g.convention}): each band is the signed net SEG that reprices in it, a fixed asset reading positive.`,
    "Liquidity (EBP) is the average outstanding balance and carries no interest: each band is the balance that runs off in it (EBP at the band start minus EBP at the band end), by side, net being assets minus liabilities. On every path the run-off bands plus the beyond-horizon line add back to the month-1 balance.",
    `The month-${g.horizonMonths} edge: the block carries no balance after month ${g.horizonMonths}, so EBP run-off during month ${g.horizonMonths} itself lands in the beyond-horizon line, not in 5-10Y. A ${g.horizonMonths}-month bullet reads in the SEG 5-10Y band but in the EBP beyond-horizon line.`,
    "Cumulative figures are each path's running sum of its own bands, then summarised; never a sum of band quantiles.",
  ];
}

/** A stored figure in millions, signed, titled at full precision; a missing quantile says none. */
function Cell(props: { v: number | null; se?: boolean }) {
  if (props.v === null) return <td className="num"><span className="status status-unobs">none</span></td>;
  return <td className="num" title={String(props.v)}>{props.se ? usdMM(props.v) : gapMM(props.v)}</td>;
}

function StatCells(props: { d: StochasticDistribution }) {
  const { d } = props;
  return (
    <>
      <Cell v={d.mean} />
      <Cell v={d.standardError} se />
      {GAP_PS.map((p) => <Cell key={p} v={quantileAt(d, p)} />)}
      <td className="num">{d.nPaths}</td>
    </>
  );
}

/** One table of rows: Band (and Side in the liquidity view), mean, SE, p5 to p95, N. */
function GapStatTable(props: { rows: GapStatRow[]; bySide: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th scope="col">Band</th>{props.bySide ? <th scope="col">Side</th> : null}<th scope="col" className="num">Mean</th><th scope="col" className="num">SE</th><th scope="col" className="num">p5</th><th scope="col" className="num">p25</th><th scope="col" className="num">p50</th><th scope="col" className="num">p75</th><th scope="col" className="num">p95</th><th scope="col" className="num">N</th></tr></thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={`${r.table}-${r.label}-${r.side}`}><th scope="row">{r.label}</th>{props.bySide ? <td>{SIDE_LABEL[r.side]}</td> : null}<StatCells d={r.d} /></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StochasticGapCard(props: { runId: string; gap: StochasticGapBlock; gate: StochasticCalibrationGate; view: GapView }) {
  const { gap, view } = props;
  const chip = gateChip(props.gate.state);
  const liq = view === "liquidity";
  return (
    <section className="card" aria-label={GAP_CARD_TITLE}>
      <div className="card-title">{GAP_CARD_TITLE}</div>
      <p>{`${GAP_CARD_SENTENCE} Repricing is the SEG that reprices in each band, signed net; liquidity is the EBP balance that runs off in each band, by side.`}</p>
      <p><span className={chip.className}>{chip.text}</span> Calibration, as the gate card above records it.</p>
      <nav className="chip-row" aria-label="Gap distributions view">
        {GAP_VIEWS.map((v) => (
          <button key={v.id} type="button" className="pill" aria-pressed={view === v.id} onClick={() => setHashParam(GAP_VIEW_KEY, v.id === "repricing" ? null : v.id)}>{v.label}</button>
        ))}
      </nav>
      <h3 className="viz-title">{liq ? "Liquidity run-off by band (EBP balance, no interest)" : "Repricing gap by band (SEG, signed net)"}</h3>
      <GapStatTable rows={liq ? liquidityRows(gap) : repricingRows(gap)} bySide={liq} />
      <h3 className="viz-title">{liq ? "Cumulative liquidity run-off" : "Cumulative repricing gap"}</h3>
      <GapStatTable rows={liq ? liquidityCumulativeRows(gap) : repricingCumulativeRows(gap)} bySide={liq} />
      <p className="card-desc">
        <button type="button" className="pill" onClick={() => downloadCsv(`stochastic-gap-${props.runId}.csv`, gapDistributionsCsv(gap))}>Download CSV</button>
        {" "}The CSV carries both views, every statistic of every row at full precision, as stored.
      </p>
      <ul className="card-desc">
        {gapNotes(gap).map((n) => <li key={n}>{n}</li>)}
      </ul>
      <p className="card-desc">{`Positions the SEG block does not cover: ${gap.uncoveredCount}. They enter no figure above.`}</p>
      {gap.uncovered.length > 0 ? (
        <ul className="card-desc" aria-label="Uncovered positions">
          {gap.uncovered.map((u) => (
            <li key={u.positionId}><span className="mono">{u.positionId}</span>: {u.reason}</li>
          ))}
        </ul>
      ) : null}
      <p className="card-foot">{`Source: GET /api/runs/${props.runId}/stochastic/summary, gap (the stored block, verbatim; nothing derived here)`}</p>
    </section>
  );
}
