/** Home route: load, then render. Loading and error states name what happened; nothing is filled in. */
import { useLoad } from "../../useLoad";
import { pageErrText } from "../../errText";
import { HomeView } from "./HomeView";
import { loadHome } from "./loadHome";

function HomeLoaded(props: { bookId: string; marketId: string | null; viewerBase: string }) {
  const { bookId, marketId } = props;
  const load = useLoad(() => loadHome(bookId, marketId), [bookId, marketId]);
  if (load.state === "loading") return <div className="card muted">Reading the catalog</div>;
  if (load.state === "error") {
    const e = load.error;
    return <div className="card" role="alert">{pageErrText(e)}</div>;
  }
  return <HomeView model={load.value} viewerBase={props.viewerBase} />;
}

export function HomePage(props: { bookId: string | null; marketId: string | null; viewerBase: string }) {
  if (props.bookId === null) {
    return <div className="card unobs-panel"><p className="unobs-text">Unobservable: no book in /api/catalog/portfolios.</p></div>;
  }
  return <HomeLoaded bookId={props.bookId} marketId={props.marketId} viewerBase={props.viewerBase} />;
}
