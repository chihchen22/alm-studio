// apps/studio/src/pages/scenarios/ShockPreviewCard.tsx
/**
 * The shock preview card (spec Section 5.1 item 4), props
 * only: the served base and shocked zero curves as a chart and a table, or the
 * state the preview is in. Every number is a served field; the reader's
 * previewRows scales the two rates to percent for display, and bp1 prints the
 * served shift to one decimal.
 */
import { bp1, pctPoints, previewRows, type ShockPreview } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { stepDecimals } from "../../charts/plotScale";
import { tenorLabel } from "../../format/tenor";
import { errText } from "../../errText";
import type { PreviewState } from "./useShockPreview";

/** A percent-unit tick: 4.2%, at the decimals the tick step needs (the Rates tab's convention). */
const pctTick = (v: number, step: number) => v.toFixed(stepDecimals(step)) + "%";

const NO_FLOOR = "The engine applies no floor: a zero rate below zero is shown as it is.";

function PreviewBody(props: { reply: ShockPreview }) {
  let rows: ReturnType<typeof previewRows>;
  try {
    rows = previewRows(props.reply);
  } catch (e) {
    return <div role="alert"><span className="status status-breach">✕ Preview not drawable</span> {errText(e)}</div>;
  }
  const last = rows[rows.length - 1];
  return (
    <>
      <p className="card-desc">
        Calibration date {props.reply.calibrationDate}. Continuously compounded zero rates. Longest curve tenor {last === undefined ? "Unobservable: the reply holds no node" : tenorLabel(last.t)}. The chart spaces the tenors to scale on a square-root axis.
      </p>
      {/* Tenors to scale on a square-root axis, as on the Market card (Polish 13). The y range fits the two curves, so
          the shock shows at every tenor; the tooltip adds the shift to the base in whole signed bp. The card's table
          holds every plotted value, so the chart keeps no Show table of its own. */}
      <LinePlot
        series={[
          { id: "base", label: "Base curve", points: rows.map((r) => [r.t, r.basePct]), tone: "muted" },
          { id: "shocked", label: "Shocked curve", points: rows.map((r) => [r.t, r.shockedPct]), tone: "accent" },
        ]}
        xScale="sqrt"
        xDomain={[0, last === undefined ? 1 : last.t]}
        xTicks={rows.map((r) => ({ value: r.t, label: tenorLabel(r.t) }))}
        xLabel={tenorLabel}
        yTick={pctTick}
        unit="percent"
        format={pctPoints}
        delta="base"
        table={false}
      />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col" className="num">Tenor</th><th scope="col" className="num">Base</th><th scope="col" className="num">Shocked</th><th scope="col" className="num">Shift (bp)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.t}>
                <th scope="row" className="num">{tenorLabel(r.t)}</th>
                <td className="num">{pctPoints(r.basePct)}</td>
                <td className="num">{pctPoints(r.shockedPct)}</td>
                <td className="num">{bp1(r.shiftBp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ShockPreviewCard(props: { marketSnapshot: string; preview: PreviewState; onRetry?: () => void }) {
  const { preview } = props;
  return (
    <section className="card" aria-label="Shock preview">
      <div className="card-title">Preview on <span className="mono">{props.marketSnapshot}</span></div>
      {preview.state === "idle" ? <p className="card-desc">Complete the form to see the shocked curve.</p> : null}
      {preview.state === "checking" ? (
        <>
          <p className="card-desc muted" role="status">
            {`Checking the shock on ${props.marketSnapshot}${preview.last !== undefined ? ". The chart below shows the previous form." : ""}`}
          </p>
          {/* Polish 1 S1: the last ok reply stays drawn, dimmed, so the card does not flash while a new form is checked. */}
          {preview.last !== undefined ? <div className="preview-stale"><PreviewBody reply={preview.last} /></div> : null}
        </>
      ) : null}
      {preview.state === "refused" ? <div role="alert"><span className="status status-breach">✕ Refused</span> {preview.message}</div> : null}
      {preview.state === "unavailable" ? (
        <div role="alert">
          <span className="status status-unobs">Preview unavailable</span> {preview.message}
          {/* A bordered secondary button on its own line, so it reads as an action, not as part of the sentence. */}
          {props.onRetry !== undefined ? <div className="sheet-actions"><button type="button" className="btn" onClick={props.onRetry}>Check again</button></div> : null}
        </div>
      ) : null}
      {preview.state === "ok" ? <PreviewBody reply={preview.reply} /> : null}
      <p className="card-foot">{NO_FLOOR} Source: POST /api/scenarios/preview.</p>
    </section>
  );
}
