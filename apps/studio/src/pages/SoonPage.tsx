// apps/studio/src/pages/SoonPage.tsx
/** A layer the program has placed but not built: what it will do, what it waits for, the gap today. Never a number. */
import type { LayerDef } from "../router";

export function SoonPage(props: { layer: LayerDef }) {
  const { layer } = props;
  const s = layer.soon!;
  return (
    <section className="card soon-panel" aria-label={layer.label}>
      <div className="card-title">{layer.label} <span className="soon-tag">Soon</span></div>
      <p className="card-desc">{s.will}</p>
      <dl className="kv">
        <dt>Arrives in</dt><dd>Piece {s.piece}</dd>
        <dt>Today</dt><dd>{s.gap}</dd>
      </dl>
    </section>
  );
}
