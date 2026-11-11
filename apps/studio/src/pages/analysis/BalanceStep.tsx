// apps/studio/src/pages/analysis/BalanceStep.tsx
/**
 * Step 2, Balance sheet (S2a spec point 4). The CSV and JSON templates download from the step; the import form is the
 * one Advanced uses (every error listed by row and field; a bad file never replaces a good book); after an import the
 * step shows the totals by side, the asset, liability and equity tie check, the families by their labels, and a clear
 * note when the book's date is not the workspace date.
 */
import {
  getPortfolio, listExampleBooks, setBlock,
  POSITIONS_CSV_TEMPLATE_COA, POSITIONS_CSV_TEMPLATE_URL, POSITIONS_JSON_TEMPLATE_URL,
} from "@alm/reader";
import { ensureExample } from "../../guided/importBook";
import type { PortfolioSpec } from "@alm/engine";
import { ImportPositions } from "../balance/ImportPositions";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { money } from "../../format/figures";
import { dateNote, summarizeBook } from "../../guided/book";
import { ActionLines, byName, Details, useAction, type StepContext } from "./common";

export const INSTRUMENT_LABEL: Record<string, string> = {
  "fixed-loan": "Fixed-rate loan, bond or term funding",
  "floating-loan": "Floating-rate loan",
  mortgage: "Mortgage",
  nmd: "Non-maturity deposit",
  "nmd-b": "Interest-bearing deposit",
  cd: "Term deposit",
  commitment: "Committed line",
  swap: "Interest rate swap",
  "non-rate-sensitive": "Held at book, not rate-sensitive",
};

export function BalanceStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const bookId = ctx.head.blocks.positions.book?.id ?? null;
  return (
    <>
      <section className="card" aria-label="Templates">
        <div className="card-title">Start from a template</div>
        <p className="card-desc">Download a template, replace its rows with your positions, then import the file below.</p>
        <div className="guided-actions">
          <a className="btn" href={POSITIONS_CSV_TEMPLATE_URL} download>Download the CSV template</a>
          <a className="btn" href={POSITIONS_JSON_TEMPLATE_URL} download>Download the JSON template</a>
        </div>
        <ul className="guided-missing">
          <li>The CSV template has one row per position, one column per term, and uses the stored chart of accounts {POSITIONS_CSV_TEMPLATE_COA}, Quillfield Bank's (the example bank): pick it as the chart of accounts when you import. Families and account nodes must be ones that chart holds. It shows every kind of row: loans, securities, deposits, a floating borrowing, a swap (side left blank), an undrawn line with its draw path, and certificates of deposit as one row per cohort under one position id. To tag positions, add a column named dim.&lt;tag&gt;, for example dim.region: each such column becomes a tag the Reports step can group by. The dim.liquidityRole column takes one of the six liquidity roles, and dim.hqla-level the HQLA level (l1, l2a or l2b) of a position tagged hqla-stock.</li>
          <li>The JSON template is Quillfield Bank's own file: it carries its own chart of accounts, so any families and labels you choose work. A file whose id is already stored is stored under the next free id, and the note says which.</li>
        </ul>
        {bookId === null ? <ExampleButton ctx={ctx} /> : null}
      </section>
      <ImportPositions head={ctx.head} open={bookId === null} onImported={ctx.refresh} fallbackBy={byName()} />
      {bookId === null ? null : <BookSummaryCard ctx={ctx} bookId={bookId} />}
    </>
  );
}

function ExampleButton(props: { ctx: StepContext }) {
  const { ctx } = props;
  const act = useAction();
  const examples = useLoad(() => listExampleBooks(), []);
  if (examples.state !== "ok" || examples.value.length === 0) return null;
  const ex = examples.value[0]!;
  const onUse = () => act.run("Example", async () => {
    const book = await ensureExample(ex);
    await setBlock(ctx.ws, { expectedRevision: ctx.head.revision, by: byName(), block: "positions", op: "set", ref: { collection: "portfolios", id: book.id } });
    ctx.refresh();
    return `Loaded the example positions: ${ex.positionCount} positions${book.reused ? ", the copy already stored" : ""}.`;
  });
  return (
    <div className="guided-actions">
      <button type="button" className="btn btn-quiet" disabled={act.busy} onClick={onUse}>{`Or load the example positions (${ex.positionCount} positions, dated ${ex.asOf})`}</button>
      <ActionLines busy={act.busy} busyText="Loading the example positions" error={act.error} done={act.done} />
    </div>
  );
}

function BookSummaryCard(props: { ctx: StepContext; bookId: string }) {
  const { ctx } = props;
  const load = useLoad(() => getPortfolio(props.bookId), [props.bookId]);
  if (load.state === "loading") return <div className="card muted">Reading the positions</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const book = load.value as PortfolioSpec;
  const s = summarizeBook(book);
  const note = dateNote(book.asOf, ctx.head.cutoffDate);
  return (
    <>
      <section className="card" aria-label="Positions loaded">
        <div className="card-title">{`Loaded: ${book.label}`}</div>
        <p className="card-desc">{`${s.positionCount} positions in ${s.families.filter((f) => f.positions > 0).length} families, dated ${book.asOf}. Totals are the positions' balances added up, before any run.`}</p>
        <div className="tiles guided-row">
          <div className="stat"><div className="stat-label">Assets</div><div className="stat-value">{money(s.assets)}</div></div>
          <div className="stat"><div className="stat-label">Liabilities</div><div className="stat-value">{money(s.liabilities)}</div></div>
          <div className="stat"><div className="stat-label">Equity</div><div className="stat-value">{money(s.equityPositions + s.plug)}</div></div>
        </div>
        <p className={s.tie.ok ? "guided-ok" : "guided-bad"} role="status">{s.tie.ok ? `The balance sheet ties. ${s.tie.sentence}` : s.tie.sentence}</p>
        {s.offBalance.sentence !== null ? <p className="card-desc">{s.offBalance.sentence}</p> : null}
        {note !== null ? <p className="guided-warn" role="status">{note}</p> : null}
        <Details>
          <p>Book id {book.id}; chart of accounts of {book.coa.nodes.length} nodes and {book.coa.families.length} families. Exact totals: assets {s.assets}, liabilities {s.liabilities}, equity {s.equityPositions + s.plug}.</p>
        </Details>
      </section>
      <section className="card table-card" aria-label="Families">
        <div className="card-title">Families</div>
        <div className="table-wrap guided-tall">
          <table className="table">
            <thead><tr><th scope="col">Family</th><th scope="col">Side</th><th scope="col">Instrument</th><th scope="col" className="num">Positions</th><th scope="col" className="num">Balance</th></tr></thead>
            <tbody>
              {s.families.filter((f) => f.positions > 0).map((f) => (
                <tr key={f.familyId}>
                  <td>{f.label}</td>
                  <td>{f.offBalance ? (f.side === "derivative" ? "off balance sheet (notional)" : "off balance sheet (undrawn)") : f.side}</td>
                  <td>{INSTRUMENT_LABEL[f.instrumentType] ?? f.instrumentType}</td>
                  <td className="num">{f.positions}</td>
                  <td className="num">{money(f.notional)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
