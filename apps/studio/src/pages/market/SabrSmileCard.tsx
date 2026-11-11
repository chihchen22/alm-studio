/**
 * Market > Volatility surfaces: the SABR smile, a surface preview. One expiry row of
 * the short-rate volatility surface against the smile GET /api/market/:id/vol-smile computes at the row's forward,
 * with alpha, rho and nu movable from the route's heuristic. Every number is the route's; Studio scales vols to bp and
 * strikes to percent, and prints the route's note verbatim. Nothing is fitted, stored or read by a run.
 */
import { useEffect, useState } from "react";
import { getVolSmile, pct, sig, VOL_TO_BP, volSmilePath, type VolSmileOverrides, type VolSmileReply } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { niceTicks, stepDecimals } from "../../charts/plotScale";
import { errText } from "../../errText";
import { tenorLabel } from "../../format/tenor";

export const SABR_COPY = {
  title: "SABR smile, surface preview",
  desc: "One expiry row of the short-rate volatility surface against the SABR smile in the Hagan normal form (beta 0) at the row's forward. The sliders move alpha, rho and nu away from the heuristic; nothing is fitted, saved or fed to a run.",
} as const;

type Knob = "alpha" | "rho" | "nu";

export interface SabrSmileViewProps {
  marketId: string;
  /** The stored expiry rows of the short-rate volatility surface, years, ascending. */
  expiries: number[];
  expiry: number;
  over: VolSmileOverrides;
  /** The last reply; null before the first one, or while a new expiry is read. */
  reply: VolSmileReply | null;
  /** The route's refusal in words; null when the last read answered. */
  error: string | null;
  onExpiry(expiryYears: number): void;
  onSlide(knob: Knob, value: number): void;
  onReset(): void;
}

const bp = (v: number) => (v * VOL_TO_BP).toFixed(1);

/** Each slider: knob, label, bounds and step in its shown unit, and the scale from the route's value to that unit. */
const KNOBS: Array<[Knob, string, number, number, number | "any", number]> = [
  ["alpha", "Alpha, bp of normal volatility", 1, 300, "any", VOL_TO_BP],
  ["rho", "Rho", -0.99, 0.99, 0.01, 1],
  ["nu", "Nu", 0.01, 3, 0.01, 1],
];

export function SabrSmileView(props: SabrSmileViewProps) {
  const { reply, over, error, expiry } = props;
  const h = reply?.heuristic;
  return (
    <section className="card viz" aria-label={SABR_COPY.title}>
      <div className="viz-head">
        <div className="card-title">{SABR_COPY.title}</div>
        <p className="viz-sub">{SABR_COPY.desc}</p>
      </div>
      {props.expiries.length === 0 ? (
        <p className="unobs-text">The snapshot stores no short-rate volatility surface, so there is no smile to preview.</p>
      ) : (
        <>
          <div className="param-grid">
            <label className="field">
              <span className="field-label">Expiry</span>
              <select aria-label="Expiry" value={String(expiry)} onChange={(e) => props.onExpiry(Number(e.target.value))}>
                {props.expiries.map((y) => <option key={y} value={String(y)}>{tenorLabel(y)}</option>)}
              </select>
            </label>
            {KNOBS.map(([k, label, min, max, step, scale]) => {
              const v = (over[k] ?? h?.[k] ?? 0) * scale;
              return (
                <label className="field" key={k}>
                  <span className="field-label">{label}: <span className="num">{k === "alpha" ? v.toFixed(1) : sig(v, 4)}</span></span>
                  <input type="range" min={min} max={k === "alpha" ? Math.max(max, Math.ceil(2 * (h?.alpha ?? 0) * scale)) : max} step={step} value={v} disabled={h === undefined} aria-label={label} onChange={(e) => props.onSlide(k, Number(e.target.value) / scale)} />
                </label>
              );
            })}
          </div>
          <p className="card-desc">
            {/* After a refusal the last reply's values are not the ones on the sliders, so the line is left out. */}
            {reply !== null && error === null ? <>In use: alpha {bp(reply.params.alpha)} bp, rho {sig(reply.params.rho, 4)}, nu {sig(reply.params.nu, 4)}, beta {sig(reply.params.beta, 4)}. The heuristic: alpha {bp(reply.heuristic.alpha)} bp, rho {sig(reply.heuristic.rho, 4)}, nu {sig(reply.heuristic.nu, 4)}.{" "}</> : null}
            <button type="button" className="btn btn-quiet btn-flush" disabled={Object.keys(over).length === 0} onClick={props.onReset}>Back to the heuristic</button>
          </p>
          {error !== null ? <p className="unobs-text" role="alert">{error}</p> : reply === null ? <p className="muted">Reading the smile at the {tenorLabel(expiry)} expiry</p> : <SmileChart reply={reply} />}
          <p className="card-foot">
            Source: GET /api{volSmilePath(props.marketId, expiry, over)}
            {reply !== null && error === null ? <>; underlying tenor {tenorLabel(reply.underlyingTau)}, forward {pct(reply.forward, 4)}</> : null}
          </p>
        </>
      )}
    </section>
  );
}

function SmileChart(props: { reply: VolSmileReply }) {
  const { reply } = props;
  return (
    <>
      <LinePlot
        series={[
          { id: "model", label: "SABR, Hagan normal form (beta 0)", tone: "accent", points: reply.curve.map((c) => [c.strike, c.modelVol]) },
          { id: "stored", label: "Stored points, the at-the-money column placed at the forward", tone: "second", points: reply.points.map((p) => [p.strike, p.normalVol]) },
        ]}
        xScale="linear"
        xTicks={(lo, hi) => niceTicks(lo, hi, 5).ticks.map((v) => ({ value: v, label: pct(v, 1) }))}
        xLabel={(x) => pct(x, 2)}
        yTick={(v, step) => (v * VOL_TO_BP).toFixed(stepDecimals(step * VOL_TO_BP))}
        format={(v) => `${bp(v)} bp`}
        unit="Normal volatility, bp; strike in percent"
        height={260}
        table={false}
      />
      <p className="card-foot">{reply.note}</p>
      <details className="viz-table">
        <summary>Show the stored points</summary>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Strike</th><th scope="col" className="num">Stored, bp</th><th scope="col" className="num">Model, bp</th><th scope="col" className="num">Residual, bp</th></tr></thead>
            <tbody>
              {reply.points.map((p) => (
                <tr key={`${p.strike}:${p.isAtm}`}>
                  <th scope="row">{p.isAtm ? `ATM at the forward ${pct(p.strike, 2)}` : pct(p.strike, 2)}</th>
                  <td className="num">{bp(p.normalVol)}</td>
                  <td className="num">{bp(p.modelVol)}</td>
                  <td className="num">{p.residualBp.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

/** The card with its state: the chosen expiry and overrides, read again 150 ms after the last change. */
export function SabrSmileCard(props: { marketId: string; expiries: number[] }) {
  const { marketId, expiries } = props;
  const [expiry, setExpiry] = useState(() => (expiries.includes(5) ? 5 : expiries[0] ?? 0));
  const [over, setOver] = useState<VolSmileOverrides>({});
  const [reply, setReply] = useState<VolSmileReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (expiries.length === 0) return;
    let live = true;
    const t = setTimeout(() => {
      getVolSmile(marketId, expiry, over).then(
        (r) => { if (live) { setReply(r); setError(null); } },
        (e: unknown) => { if (live) setError(errText(e)); },
      );
    }, 150);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketId, expiry, over.alpha, over.rho, over.nu, expiries.length]);
  return (
    <SabrSmileView
      marketId={marketId} expiries={expiries} expiry={expiry} over={over} reply={reply} error={error}
      onExpiry={(y) => { setExpiry(y); setReply(null); setError(null); }}
      onSlide={(k, v) => setOver((o) => ({ ...o, [k]: v }))}
      onReset={() => setOver({})}
    />
  );
}
