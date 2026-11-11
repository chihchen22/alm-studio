/**
 * A neutral bar pair per category. Marks only in the SVG; labels, unit and
 * legend are HTML so they never stretch. Bar geometry is a display scaling of
 * the served values into the 0..100 viewBox; the values themselves are in each
 * bar's title and in the Show table, formatted by usdMM, never repainted.
 */
import { usdMM } from "@alm/reader";

export interface BarPairRow { label: string; a: number; b: number }

export function BarPairs(props: { rows: BarPairRow[]; aLabel: string; bLabel: string; unit: string; height?: number; catLabel?: string }) {
  const { rows, aLabel, bLabel, unit, catLabel = "Scenario" } = props;
  const values = rows.flatMap((r) => [r.a, r.b]);
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const span = hi - lo || 1;
  const y = (v: number) => ((hi - v) / span) * 100;
  const zeroY = y(0);
  const band = rows.length > 0 ? 100 / rows.length : 100;
  const barW = band * 0.28;
  const gap = band * 0.02;
  const bar = (v: number, x: number, fill: string, title: string) => {
    const top = Math.min(y(v), zeroY);
    return (
      <g>
        <title>{title}</title>
        <rect className="hit" x={x - gap} y={0} width={barW + 2 * gap} height={100} />
        <rect x={x} y={top} width={barW} height={Math.abs(y(v) - zeroY)} fill={fill} />
      </g>
    );
  };
  return (
    <div className="plot">
      <div className="plot-top">
        <span>{unit}</span>
        <div className="legend">
          <span><i className="key-box" style={{ background: "var(--ink-2)" }} />{aLabel}</span>
          <span><i className="key-box" style={{ background: "var(--line-2)" }} />{bLabel}</span>
        </div>
      </div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${aLabel} and ${bLabel} by ${rows.map((r) => r.label).join(", ")}, ${unit}`}
        style={props.height === undefined ? undefined : { height: `${props.height}px` }}
      >
        {lo < 0 && <line className="zero-line" x1={0} x2={100} y1={zeroY} y2={zeroY} />}
        {rows.map((r, i) => {
          const mid = i * band + band / 2;
          return (
            <g key={r.label}>
              {bar(r.a, mid - gap - barW, "var(--ink-2)", `${r.label}, ${aLabel}: ${usdMM(r.a)}`)}
              {bar(r.b, mid + gap, "var(--line-2)", `${r.label}, ${bLabel}: ${usdMM(r.b)}`)}
            </g>
          );
        })}
      </svg>
      <div className="plot-cats" aria-hidden="true">
        {rows.map((r) => <span key={r.label}>{r.label}</span>)}
      </div>
      <details className="viz-table">
        <summary>Show table</summary>
        <table className="table">
          <thead><tr><th scope="col">{catLabel}</th><th scope="col" className="num">{aLabel}</th><th scope="col" className="num">{bLabel}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}><th scope="row">{r.label}</th><td className="num lvl">{usdMM(r.a)}</td><td className="num lvl">{usdMM(r.b)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
