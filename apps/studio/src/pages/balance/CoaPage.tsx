/**
 * Data > Balance sheet > Chart of accounts (ALM Studio P1). The stored tree,
 * with each leaf's served notional from the grouped aggregate. Parent nodes
 * carry no total: the platform serves no roll-up, and Studio does not add.
 */
import { getCatalogAggregateGrouped, getPortfolio } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { coaRows, familyCell, leafNotionals, notionalCell, type CoaRow } from "../../balance/coaModel";

export function CoaView(props: { bookId: string; rows: CoaRow[]; notional: Map<string, number | null> }) {
  return (
    <section className="card table-card" aria-label="Chart of accounts">
      <div className="card-title">Chart of accounts, {props.bookId}</div>
      <p className="card-desc">One chart of accounts per book. Risk, liquidity and regulatory hierarchies are mapped from a book's tags on Hierarchies and mapping, which writes a re-tagged book; capital, ledger and planning hierarchies are not built. Parent rows show no total: no roll-up is served. A leaf the grouped aggregate does not serve prints Unobservable: no positions; a leaf served with a null total prints Unobservable: notional null.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Node</th><th scope="col">Side</th><th scope="col">Family</th><th scope="col" className="num">Notional</th></tr></thead>
          <tbody>
            {props.rows.map((r) => {
              const fam = familyCell(r.isLeaf, r.familyId);
              const amt = notionalCell(r.isLeaf, props.notional.get(r.id));
              return (
                <tr key={r.id}>
                  <th scope="row" style={{ paddingLeft: `calc(var(--sp-3) + ${r.depth} * var(--sp-5))` }}>{r.label} <span className="mono muted">{r.id}</span></th>
                  <td>{r.side}</td>
                  <td className={fam.muted ? "muted" : "mono"}>{fam.text}</td>
                  <td className={amt.muted ? "num muted" : "num"}>{amt.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="card-foot">Source: /api/portfolios/{props.bookId} coa.nodes; leaf notional from /api/catalog/portfolios/{props.bookId}/positions/aggregate?groupBy=coaNode groups[].totalNotional</p>
    </section>
  );
}

export function CoaPage(props: { bookId: string | null }) {
  const bookId = props.bookId;
  const load = useLoad(async () => {
    if (bookId === null) return null;
    const [spec, grouped] = await Promise.all([getPortfolio(bookId), getCatalogAggregateGrouped(bookId, {}, "coaNode")]);
    return { spec, grouped };
  }, [bookId]);
  if (bookId === null) return <div className="card unobs-panel"><p className="unobs-text">Unobservable: no book selected.</p></div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  // A null value is the previous no-book load, still held for the one render before the new load starts.
  if (load.state === "loading" || load.value === null) return <div className="card muted">Reading book {bookId}</div>;
  const { spec, grouped } = load.value;
  return <CoaView bookId={bookId} rows={coaRows(spec.coa.nodes)} notional={leafNotionals(grouped.groups)} />;
}
