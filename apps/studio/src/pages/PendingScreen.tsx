/** A screen the frame names and a later task of Slice 1 builds. It states what it is and holds no number. */
export function PendingScreen(props: { label: string }) {
  return (
    <section className="card soon-panel" aria-label={props.label}>
      <div className="card-title">{props.label} <span className="soon-tag">Soon</span></div>
      <p className="card-desc">This screen is placed in the workspace frame and is not built yet.</p>
    </section>
  );
}
