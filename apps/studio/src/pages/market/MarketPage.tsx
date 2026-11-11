/**
 * Market route: load the workspace's snapshot, then render it with the harness frame of its module under the charts.
 * Loading and error states name what happened; nothing is filled in. The frame is read-only (Section 4.2): the curve
 * instances for Yield curves, the surfaces for Volatility surfaces.
 */
import { VolShockLink } from "../scenarios/ScenarioTabs";
import { getCurveSetup, getPluginCatalog, getRun, listMarket, listPortfolios, listRunSetups, listRuns, type WorkspaceManifest } from "@alm/reader";
import { AttachStored } from "../../controls/AttachStored";
import { baseSnapshotOptions, derivedMarketOptions, marketAddBody, marketSetBody, writeBlock } from "../../controls/attachBodies";
import { hrefFor } from "../../router";
import { useLoad } from "../../useLoad";
import { pageErrText } from "../../errText";
import { curveInstances, curveMethods, rateModelNamesOf, volInstances, volMethods, type CatalogLike } from "../../harness/instances";
import { MarketView, type MarketSection } from "./MarketView";
import { UploadWorkbook, uploadWritable } from "./UploadWorkbook";
import { loadMarket } from "./loadMarket";
import { marketCurveText } from "../../market/marketCurve";

const NO_CATALOG: CatalogLike = { components: [], mounted: [] };

/**
 * The rate models of the done stochastic runs on this market snapshot, by harness name. A
 * stochastic run is posted from the Workbench or the API and attaches to no workspace, so the snapshot is the scope:
 * GET /api/runs gives each run's mode and market, each stochastic run's detail its `stochastic.model` (absent is
 * Hull-White, decision 80).
 */
export async function stochasticRunModels(marketId: string): Promise<string[]> {
  const runs = (await listRuns()).filter((r) => r.mode === "stochastic" && r.state === "done" && r.refs?.marketId === marketId);
  const details = await Promise.all(runs.map((r) => getRun(r.runId).catch(() => null)));
  return rateModelNamesOf(details.flatMap((d) => (d === null ? [] : [d.stochastic?.model])));
}

/**
 * The load's deps: the section only as "vols or not", so moving between the curves and spreads views (the TLP or Term
 * funding instance on Yield curves) keeps the loaded frame instead of reloading it.
 */
export function frameContextDeps(ws: string, bookId: string | null, activeSetupId: string | null, section: MarketSection, marketId: string): unknown[] {
  return [ws, bookId, activeSetupId ?? "", section === "vols", marketId];
}

/** What the frame reads beyond the snapshot; every read degrades to none, so a failed one never blanks the page. */
export async function loadFrameContext(ws: string, bookId: string | null, activeSetupId: string | null, vols: boolean, marketId: string) {
  const [catalog, setups, books, activeSetup, rateModelNames] = await Promise.all([
    getPluginCatalog().catch(() => NO_CATALOG),
    listRunSetups(ws).catch(() => null),
    bookId === null ? Promise.resolve(null) : listPortfolios().catch(() => null),
    // The active curve setup's name: its label, else its id; the document id when the read fails.
    activeSetupId === null ? Promise.resolve(null) : getCurveSetup(activeSetupId).then((b) => (b.label !== "" ? b.label : b.id), () => activeSetupId),
    vols ? stochasticRunModels(marketId).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    catalog,
    setupsOnBase: setups === null ? [] : setups.setups.filter((s) => s.setup.inputs.market.role === "base").map((s) => s.slot.setupLineageId),
    rateModelNames,
    positions: books === null || bookId === null ? null : books.find((b) => b.id === bookId)?.positionCount ?? null,
    activeSetup,
  };
}

function MarketLoaded(props: { ws: string; bookId: string | null; marketId: string; query: Record<string, string>; section: MarketSection; activeSetupId: string | null }) {
  const { ws, bookId, marketId, query, section, activeSetupId } = props;
  const load = useLoad(() => loadMarket(marketId), [marketId]);
  const context = useLoad(() => loadFrameContext(ws, bookId, activeSetupId, section === "vols", marketId), frameContextDeps(ws, bookId, activeSetupId, section, marketId));
  if (load.state === "loading") return <div className="card muted">Reading the catalog</div>;
  if (load.state === "error") {
    const e = load.error;
    return <div className="card" role="alert">{pageErrText(e)}</div>;
  }
  const model = load.value;
  const ctx = context.state === "ok" ? context.value : null;
  const selected = query.instance ?? null;
  const frame = ctx === null ? null
    : section === "vols"
      ? { module: "vol-surface" as const, instances: volInstances(model.snapshot, { rateModelNames: ctx.rateModelNames }), methods: volMethods(ctx.catalog), selected }
      : { module: "curve" as const, instances: curveInstances(model.snapshot, { positions: ctx.positions, setupsOnBase: ctx.setupsOnBase, baseCurve: marketCurveText(model.baseCurve) }), methods: curveMethods(ctx.catalog), selected };
  // The active setup wins over the snapshot's own base curve for this workspace's runs; while it is read, its id stands in.
  return <MarketView ws={ws} model={model} query={query} section={section} frame={frame} activeSetup={ctx?.activeSetup ?? activeSetupId} />;
}

/**
 * Market > Yield curves: the workspace's base snapshot and the control that sets it from the stored snapshots
 * (final review M1). The server refuses a replacement while derived markets sit on the base, in its own words.
 */
export function SnapshotAttach(props: { head: WorkspaceManifest; onChanged: () => void }) {
  const { head } = props;
  const current = head.blocks.market.snapshot;
  return (
    <AttachStored
      head={head}
      title="Market snapshot of this workspace"
      selectLabel="Attach a stored snapshot"
      current={current === null ? "No snapshot is attached. Pick a stored base snapshot; the server checks its date against the cut-off." : <>This workspace holds <span className="mono">{current.id}</span>. Attaching another replaces it; the server refuses while derived markets sit on it.</>}
      foot="Source: GET /api/market (base snapshots only); the write is POST /api/workspaces/<id>/blocks, market set."
      attachedIds={current === null ? [] : [current.id]}
      loadingText="Reading the stored market snapshots"
      list={() => listMarket().then(baseSnapshotOptions)}
      body={marketSetBody}
      done={(id) => `Attached snapshot ${id}`}
      onChanged={props.onChanged}
      blocked={writeBlock(head, "its base snapshot")}
    />
  );
}

/** Market > Yield curves: add a stored derived market to the workspace, so a run setup can name it (decision 42). */
export function DerivedAttach(props: { head: WorkspaceManifest; onChanged: () => void }) {
  const { head } = props;
  const held = head.blocks.market.derived;
  return (
    <AttachStored
      head={head}
      title="Derived markets of this workspace"
      selectLabel="Attach a derived market"
      current={held.length === 0
        ? "No derived market is attached. Attach one saved on Rate indices, Funding spread shocks, Volatility shocks or Macro factors; a run setup then names it as its Market on Run > Setups."
        : <>This workspace holds {held.map((d, i) => <span key={d.id}>{i > 0 ? ", " : ""}<span className="mono">{d.id}</span></span>)}. A run setup names one as its Market on Run &gt; Setups.</>}
      foot="Source: GET /api/market (markets derived from this workspace's snapshot or from a derived market it holds); the write is POST /api/workspaces/<id>/blocks, market add."
      attachedIds={held.map((d) => d.id)}
      loadingText="Reading the stored derived markets"
      list={() => listMarket().then((l) => derivedMarketOptions(l, head))}
      body={marketAddBody}
      done={(id) => `Attached derived market ${id}. Name it as a run setup's Market on Run > Setups.`}
      onChanged={props.onChanged}
      blocked={writeBlock(head, "its derived markets")}
    />
  );
}

export function MarketPage(props: { ws: string; bookId?: string | null; marketId: string | null; query: Record<string, string>; section: MarketSection; head?: WorkspaceManifest | null; onChanged?: () => void }) {
  const head = props.head ?? null;
  // The attach control lives on Yield curves (its spreads view included); Volatility surfaces points there.
  const attach = head !== null && props.section !== "vols" ? <SnapshotAttach head={head} onChanged={props.onChanged ?? (() => {})} /> : null;
  // The derived-market card sits under it once there is a snapshot, which the server needs before any add (decision 42).
  const derivedAttach = head !== null && props.section !== "vols" && head.blocks.market.snapshot !== null ? <DerivedAttach head={head} onChanged={props.onChanged ?? (() => {})} /> : null;
  // The workbook upload sits under it on the same screens, and only while the server would take a write.
  const upload = head !== null && props.section !== "vols" && uploadWritable(head) ? <UploadWorkbook head={head} onChanged={props.onChanged ?? (() => {})} /> : null;
  if (props.marketId === null) {
    return (
      <>
        <div className="card unobs-panel">
          <span className="status status-unobs">Unobservable</span>
          <p className="unobs-text">
            {props.section === "vols"
              ? <>No market snapshot is attached to this workspace. <a href={hrefFor({ ws: props.ws, section: "market", screen: "curves" })}>Attach a stored snapshot on Market &gt; Yield curves.</a></>
              : "No market snapshot is attached to this workspace. Attach a stored snapshot or import a workbook below."}
          </p>
        </div>
        {attach}
        {derivedAttach}
        {upload}
      </>
    );
  }
  return (
    <>
      <MarketLoaded ws={props.ws} bookId={props.bookId ?? null} marketId={props.marketId} query={props.query} section={props.section} activeSetupId={head?.blocks.market.curveSetups?.active ?? null} />
      {/* The visible way to change a surface: before it the volatility shock page had no control that reached it. */}
      {props.section === "vols" ? <VolShockLink ws={props.ws} /> : null}
      {attach}
      {derivedAttach}
      {upload}
    </>
  );
}
