import type { ShowBeforeRun } from "@alm/reader";
import { predicateLabel } from "@alm/reader";

/** Format a diff leaf value for display without altering it. */
function leaf(v: number | string | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toPrecision(6);
  return String(v);
}

/**
 * The show-before-run panel: the field-level diff of a compiled assumption set
 * against the base, plus the plain-language rationale. This is the object the AI
 * layer authors and a reviewer approves before any run; no balance-sheet number
 * is computed here, only two data objects are compared (the diff is produced in
 * the build step by the engine-family diff routine).
 */
export function ShowBeforeRunDiff({ sbr, familyLabel }: { sbr: ShowBeforeRun; familyLabel: (id: string) => string }) {
  const { diff, rationale, candidateSet, baseSet } = sbr;
  return (
    <section className="panel">
      <h2>Show-before-run: compiled assumption diff</h2>
      <p className="desc">
        Candidate set <strong>{candidateSet.label}</strong> versus base <strong>{baseSet.label}</strong>. The
        compiled object is data; it is shown before it runs and produces no numbers here.
      </p>

      {diff.deltas.length === 0 ? (
        <p className="emptynote">No parameter changes versus base.</p>
      ) : (
        <div className="diffgrid">
          <div className="h">Family / overlay</div>
          <div className="h" style={{ textAlign: "left" }}>
            Parameter
          </div>
          <div className="h">From</div>
          <div className="h">To</div>
          {diff.deltas.map((d, i) => (
            <DeltaRow key={i} d={d} familyLabel={familyLabel} />
          ))}
        </div>
      )}

      <pre className="rationale">{rationale}</pre>
    </section>
  );
}

function DeltaRow({
  d,
  familyLabel,
}: {
  d: ShowBeforeRun["diff"]["deltas"][number];
  familyLabel: (id: string) => string;
}) {
  return (
    <>
      <div className="c">
        {familyLabel(d.familyId)} <span className="zero">/ {d.overlayKind}</span>
        {d.selector !== undefined ? <span className="zero"> [{predicateLabel(d.selector)}]</span> : null}
      </div>
      <div className="c path">{d.path}</div>
      <div className="c">{leaf(d.from)}</div>
      <div className="c">{leaf(d.to)}</div>
    </>
  );
}
