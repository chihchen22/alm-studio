/**
 * Balance Sheet > Positions and import: read the page's query keys, load, then render, with the import form of the
 * workspace above (open while the workspace holds no book). Loading and error states name what happened; nothing is
 * filled in.
 */
import { CATALOG_GROUP_BY, listPortfolios, type CatalogGroupBy, type CatalogPositionFilters, type WorkspaceManifest } from "@alm/reader";
import { AttachStored } from "../../controls/AttachStored";
import { bookOptions, positionsSetBody, writeBlock } from "../../controls/attachBodies";
import { useLoad } from "../../useLoad";
import { pageErrText } from "../../errText";
import { BalanceView, balanceHref } from "./BalanceView";
import { ImportPositions } from "./ImportPositions";
import { InstrumentDrawer } from "./InstrumentDrawer";
import { loadBalance, loadPositionsPage } from "./loadBalance";

/** groupBy (default family), offset (default 0, a non-negative integer), and the three filters; an empty value is no filter. */
export function readBalanceQuery(query: Record<string, string>): { groupBy: CatalogGroupBy; offset: number; filters: CatalogPositionFilters } {
  const groupBy = (CATALOG_GROUP_BY as readonly string[]).includes(query.groupBy ?? "") ? (query.groupBy as CatalogGroupBy) : "family";
  const offset = /^\d+$/.test(query.offset ?? "") ? Number(query.offset) : 0;
  const filters: CatalogPositionFilters = {};
  if (query.familyId) filters.familyId = query.familyId;
  if (query.coaNodeId) filters.coaNodeId = query.coaNodeId;
  if (query.instrumentType) filters.instrumentType = query.instrumentType;
  return { groupBy, offset, filters };
}

function BalanceLoaded(props: { ws: string; bookId: string; query: Record<string, string> }) {
  const { ws, bookId, query } = props;
  const { groupBy, offset, filters } = readBalanceQuery(query);
  // Two loads: paging refetches only the positions page; a group-by switch refetches only the model.
  const load = useLoad(() => loadBalance(bookId, groupBy, filters), [bookId, groupBy, filters.familyId, filters.coaNodeId, filters.instrumentType]);
  const positions = useLoad(() => loadPositionsPage(bookId, filters, offset), [bookId, offset, filters.familyId, filters.coaNodeId, filters.instrumentType]);
  if (load.state === "loading") return <div className="card muted">Reading the catalog</div>;
  if (load.state === "error") {
    const e = load.error;
    return <div className="card" role="alert">{pageErrText(e)}</div>;
  }
  return <BalanceView ws={ws} model={load.value} positions={positions} query={query} />;
}

/**
 * The position book of this workspace and the control that sets it from the stored books (Studio Part 2 D7). The
 * server applies the cut-off clash rule and refuses a retagged copy; its refusal is printed in its own words.
 */
function BookAttach(props: { head: WorkspaceManifest; onChanged: () => void }) {
  const { head } = props;
  const current = head.blocks.positions.book;
  return (
    <AttachStored
      head={head}
      title="Position book of this workspace"
      selectLabel="Attach a stored book"
      current={current === null ? "No position book is attached. Pick a stored book; the server checks its as-of date against the cut-off." : <>This workspace holds <span className="mono">{current.id}</span>. Attaching another replaces it.</>}
      foot="Source: GET /api/portfolios (retagged copies are left out); the write is POST /api/workspaces/<id>/blocks, positions set."
      attachedIds={current === null ? [] : [current.id]}
      loadingText="Reading the stored books"
      list={() => listPortfolios().then(bookOptions)}
      body={positionsSetBody}
      done={(id) => `Attached book ${id}`}
      onChanged={props.onChanged}
      blocked={writeBlock(head, "its position book")}
    />
  );
}

export function BalancePage(props: { ws: string; head?: WorkspaceManifest | null; onChanged?: () => void; bookId: string | null; marketId: string | null; query: Record<string, string> }) {
  const { ws, head = null, bookId, marketId, query } = props;
  const form = head === null ? null : <ImportPositions head={head} open={bookId === null} onImported={props.onChanged ?? (() => {})} />;
  const attach = head === null ? null : <BookAttach head={head} onChanged={props.onChanged ?? (() => {})} />;
  if (bookId === null) {
    return (
      <>
        {form}
        {attach}
        <div className="card unobs-panel"><p className="unobs-text">Unobservable: this workspace names no position book. Import positions above, or set a stored book.</p></div>
      </>
    );
  }
  return (
    <>
      {form}
      {attach}
      <BalanceLoaded ws={ws} bookId={bookId} query={query} />
      {query.position && <InstrumentDrawer bookId={bookId} positionId={query.position} marketId={marketId} closeHref={balanceHref(ws, query, { position: null })} />}
    </>
  );
}
