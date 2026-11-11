import type { NotImplemented } from "@alm/engine";

/**
 * Surfaces RunResult.notImplemented verbatim. An unfinished layer appears here as
 * an explicit tag; the engine never substitutes a plausible number for it. An
 * empty list is itself a result worth stating.
 */
export function NotImplementedPanel({ tags }: { tags: NotImplemented[] }) {
  return (
    <section className="panel">
      <h2>Not-implemented tags</h2>
      <p className="desc">Layers that did not run in this result, reported rather than faked.</p>
      {tags.length === 0 ? (
        <p className="emptynote">None. Every layer of this run produced a result.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Layer</th>
                <th style={{ textAlign: "left" }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t, i) => (
                <tr key={i}>
                  <td>{t.layer}</td>
                  <td style={{ textAlign: "left", whiteSpace: "normal" }}>{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
