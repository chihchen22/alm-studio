// apps/studio/src/charts/Waterfall.tsx
/**
 * Horizontal waterfall as HTML rows (Studio S3a): label, a track with the bar
 * placed by barBox, and the stored amount. Marks only; every amount is in the
 * row text, the hover title and the tab's table. The base and scenario
 * anchors print through anchorFormat when given (the viewer prints them
 * unsigned), every step through format.
 */
import { barBox, type WfBar, type WfLayout } from "../results/waterfall";

export function Waterfall(props: { layout: WfLayout; unit: string; format: (v: number) => string; anchorFormat?: (v: number) => string }) {
  const { bars, lo, hi } = props.layout;
  const text = (b: WfBar) => (b.kind === "anchor" && props.anchorFormat !== undefined ? props.anchorFormat : props.format)(b.amount);
  const zero = barBox({ key: "z", label: "", amount: 0, from: 0, to: 0, kind: "anchor" }, lo, hi).left;
  return (
    <div className="plot">
      <div className="plot-top">
        <span>{props.unit}</span>
        <div className="legend">
          <span><i className="key-box wf-up" />Raises</span>
          <span><i className="key-box wf-down" />Lowers</span>
          <span><i className="key-box wf-anchor" />Base and scenario</span>
        </div>
      </div>
      <div className="wf" role="img" aria-label={bars.map((b) => `${b.label} ${text(b)}`).join(", ")}>
        {bars.map((b) => {
          const box = barBox(b, lo, hi);
          return (
            <div className="wf-row" key={b.key} title={`${b.label}: ${text(b)}`}>
              <span className="wf-label">{b.label}</span>
              <span className="wf-track">
                <span className="wf-zero" style={{ left: `${zero}%` }} />
                <span className={`wf-bar wf-${b.kind}`} style={{ left: `${box.left}%`, width: `${box.width}%` }} />
              </span>
              <span className="num wf-value">{text(b)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
