/**
 * One scenario's rate shock by tenor. x is placed by tenor, not
 * by index (geometry in scenarios/shockPicture.ts). Marks only in the SVG (the
 * line and the zero line, stretched with preserveAspectRatio="none", strokes
 * kept at weight by non-scaling-stroke); the unit and the tenor labels are
 * HTML. The right edge is the longest curve tenor, labelled in words in the
 * top row, so no tenor label prints over them. Every knot is in the Show
 * table. A refused scenario shows its reason, no SVG.
 */
import { geometry, tenorText, type Picture } from "../scenarios/shockPicture";

export function ShockPicture(props: { picture: Picture; label: string }) {
  const { picture, label } = props;
  if (picture.kind === "refused") {
    return <p className="unobs-text"><span className="status status-unobs">Refused</span> {picture.reason}</p>;
  }
  const g = geometry(picture.knots);
  const tickStyle = (x: number) => ({
    position: "absolute" as const,
    left: `${x}%`,
    flex: "none",
    transform: x >= 100 ? "translateX(-100%)" : x > 0 ? "translateX(-50%)" : "none",
  });
  return (
    <div className="plot">
      <div className="plot-top"><span>bp shift by tenor</span><span>right edge: longest curve tenor</span></div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${label}: rate shock in bp by tenor`}>
        <line x1={0} x2={100} y1={g.zeroY} y2={g.zeroY} stroke="var(--ink-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline
          points={g.points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>
      <div className="plot-cats" aria-hidden="true" style={{ position: "relative", height: "1.5em" }}>
        {g.xTicks.map((t) => <span key={t.text} style={tickStyle(t.x)}>{t.text}</span>)}
      </div>
      <details className="viz-table">
        <summary>Show table</summary>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Tenor</th><th scope="col" className="num">Shift (bp)</th></tr></thead>
            <tbody>
              {picture.knots.map((k, i) => <tr key={i}><th scope="row">{tenorText(k.x)}</th><td className="num">{k.bp}</td></tr>)}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
