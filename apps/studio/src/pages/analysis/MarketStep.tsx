// apps/studio/src/pages/analysis/MarketStep.tsx
/**
 * Step 1, Market (S2a spec point 3). A snapshot list that says what each snapshot holds; the yield curve edited in
 * place, with the snapshot's curve and the edit drawn together, saved as a named variant (a curve setup made active)
 * with no name to invent; the volatility surfaces with a visible way to scale or shift one; and the plain market
 * template to download, whose layout the paste box reads back.
 */
import { useEffect, useMemo, useState } from "react";
import {
  activateCurveSetup, deactivateCurveSetup, getMarket, listCurveSetups, listMarket, previewCurveSetup, saveCurveSetup, setBlock,
  type CurveSetupPreview, type MarketListItem,
} from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { tenorTicks } from "./charts";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { hrefFor } from "../../router";
import { baseSnapshots } from "../../guided/start";
import { applyPaste, changedRows, curveBlockOf, editRowsOf, isIllustrativePack, nextVariantId, summarizeSnapshot, templateFromRows, type CurveEditRow, type SnapshotLike } from "../../guided/market";
import { ActionLines, byName, Details, downloadText, useAction, useUnsavedGuard, type StepContext } from "./common";
import { tenorTextOf } from "../../market/curveSetupModel";
import { depositHistoryLine } from "../../guided/setup";

interface SnapRow { item: MarketListItem; snap: SnapshotLike }

async function loadSnapshots(): Promise<SnapRow[]> {
  const bases = baseSnapshots(await listMarket());
  return Promise.all(bases.map(async (item) => ({ item, snap: (await getMarket(item.id)) as unknown as SnapshotLike })));
}

export function MarketStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const load = useLoad(loadSnapshots, []);
  const attachedId = ctx.head.blocks.market.snapshot?.id ?? null;
  const act = useAction();
  if (load.state === "loading") return <div className="card muted">Reading the market snapshots</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  const rows = load.value;
  const attached = rows.find((r) => r.item.id === attachedId) ?? null;
  const attach = (id: string) => act.run("Attach", async () => {
    await setBlock(ctx.ws, { expectedRevision: ctx.head.revision, by: byName(), block: "market", op: "set", ref: { collection: "market", id } });
    ctx.refresh();
    return `The analysis now runs on ${id}.`;
  });
  return (
    <>
      <section className="card table-card" aria-label="Market snapshots">
        <div className="card-title">Market snapshot</div>
        <p className="card-desc">Each snapshot is one date's yield curve and volatility surfaces. The workspace is dated {ctx.head.cutoffDate}: a snapshot of that date avoids a date warning.</p>
        {rows.length === 0 ? <p className="guided-warn">The store holds no market snapshot. Import one under Advanced, Market, Yield curves.</p> : (
          <div className="table-wrap guided-tall">
            <table className="table">
              <thead><tr><th scope="col">Snapshot</th><th scope="col">Date</th><th scope="col">What it holds</th><th scope="col"></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const s = summarizeSnapshot(r.snap);
                  const on = r.item.id === attachedId;
                  return (
                    <tr key={r.item.id}>
                      <td><div className="guided-cell-stack"><span>{r.item.label ?? r.item.id}</span><span className="mono muted">{r.item.id}</span></div></td>
                      <td className="num">{s.date ?? "Not stated"}{s.date !== null && s.date !== ctx.head.cutoffDate ? <div className="field-help">not the workspace date</div> : null}</td>
                      <td className="guided-wrap">{s.sentence}</td>
                      <td>{on ? <span className="guided-badge guided-badge-quiet">In use</span> : <button type="button" className="btn" disabled={act.busy} onClick={() => attach(r.item.id)}>Use this snapshot</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <ActionLines busy={act.busy} busyText="Attaching the snapshot" error={act.error} done={act.done} />
      </section>
      <section className="card" aria-label="Deposit rate history">
        <div className="card-title">Deposit rate history</div>
        <p className="card-desc">{depositHistoryLine(ctx.guided, ctx.head.cutoffDate)}</p>
      </section>
      {attached === null ? null : <CurveEditor ctx={ctx} snapId={attached.item.id} snap={attached.snap} />}
      {attached === null ? null : <VolCard ctx={ctx} snap={attached.snap} />}
    </>
  );
}

function CurveEditor(props: { ctx: StepContext; snapId: string; snap: SnapshotLike }) {
  const { ctx, snap } = props;
  const [rows, setRows] = useState<CurveEditRow[]>(() => editRowsOf(snap));
  const [paste, setPaste] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ before: CurveSetupPreview; after: CurveSetupPreview } | null>(null);
  const act = useAction();
  const setups = useLoad(() => listCurveSetups(ctx.ws), [ctx.ws, ctx.head.revision]);
  useEffect(() => { setRows(editRowsOf(snap)); setPreview(null); }, [props.snapId]);
  const changed = useMemo(() => changedRows(rows), [rows]);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const unsaved = changed.length > 0 && savedKey !== JSON.stringify(rows);
  useUnsavedGuard(unsaved);
  const taken = setups.state === "ok" ? setups.value.setups.map((s) => s.setupId) : [];
  const active = setups.state === "ok" ? setups.value.setups.find((s) => s.active) ?? null : null;
  const variant = nextVariantId(taken);

  const doPreview = () => act.run("Preview", async () => {
    const b = curveBlockOf(snap, rows, "snapshot", variant, "Snapshot curve");
    const a = curveBlockOf(snap, rows, "edit", variant, "Your edit");
    if (a.block === null || b.block === null) throw new Error(a.problems.join(" "));
    const [before, after] = await Promise.all([previewCurveSetup(b.block), previewCurveSetup(a.block)]);
    setPreview({ before, after });
  });
  const doSave = () => act.run("Save", async () => {
    const label = `Edited curve ${variant.slice("edited-".length)} on ${props.snapId}`;
    const a = curveBlockOf(snap, rows, "edit", variant, label);
    if (a.block === null) throw new Error(a.problems.join(" "));
    const saved = await saveCurveSetup(ctx.ws, a.block, ctx.head.revision, byName());
    if (!saved.ok) throw new Error(saved.refusals.join(" "));
    await activateCurveSetup(ctx.ws, saved.id, saved.revision, byName());
    setSavedKey(JSON.stringify(rows));
    ctx.refresh();
    return `Saved as "${label}" and made it the curve the analysis runs on. The snapshot itself is unchanged.`;
  });
  const doBack = () => act.run("Back", async () => {
    await deactivateCurveSetup(ctx.ws, ctx.head.revision, byName());
    ctx.refresh();
    return "The analysis runs on the snapshot's own curve again.";
  });

  const series = preview === null ? [] : [
    { id: "before", label: "Snapshot curve", tone: "muted" as const, points: preview.before.ok ? preview.before.quoteNodes.map((n) => [n.tenorMonths, n.zeroRate * 100] as [number, number]) : [] },
    { id: "after", label: "Your edit", tone: "accent" as const, points: preview.after.ok ? preview.after.quoteNodes.map((n) => [n.tenorMonths, n.zeroRate * 100] as [number, number]) : [] },
  ];
  const refusals = preview === null ? [] : [...(preview.before.ok ? [] : preview.before.refusals), ...(preview.after.ok ? [] : preview.after.refusals)];

  return (
    <section className="card" aria-label="Yield curve">
      <div className="card-title">Yield curve</div>
      <p className="card-desc">
        The snapshot's par rates, in percent. Change any rate, or paste two columns (tenor and rate) from a spreadsheet, then preview: the snapshot's curve and
        yours are drawn together. Saving keeps the snapshot as it is and stores your curve as a named variant the analysis runs on.
      </p>
      {active !== null ? (
        <p className="guided-ok" role="status">
          The analysis runs on the variant "{active.label}". <button type="button" className="btn btn-quiet btn-flush" disabled={act.busy} onClick={doBack}>Go back to the snapshot's own curve</button>
        </p>
      ) : null}
      <div className="table-wrap guided-tall">
        <table className="table guided-table">
          <thead><tr><th scope="col">Tenor</th><th scope="col" className="num">Snapshot rate</th><th scope="col" className="num">Your rate</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.tenorMonths}>
                <td>{tenorTextOf(r.tenorMonths)}</td>
                <td className="num">{r.snapshotPercent}%</td>
                <td className="num">
                  <input className="input" aria-label={`Your rate at ${tenorTextOf(r.tenorMonths)}, percent`} value={r.editPercent}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, editPercent: e.target.value } : x)))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="guided-row">
        <label className="field" style={{ flex: "1 1 320px" }}>
          <span className="field-label">Paste from a spreadsheet</span>
          <textarea className="guided-textarea" aria-label="Paste tenor and rate rows" value={paste} placeholder={"10Y\t4.50\n30Y\t4.75"} onChange={(e) => setPaste(e.target.value)} />
          <span className="field-help">Two columns: tenor (1M, 2Y, 10Y) and the rate in percent. The market template below has this layout and carries the rates as you have them now.</span>
        </label>
      </div>
      <div className="guided-actions">
        <button type="button" className="btn" disabled={paste.trim() === ""} onClick={() => { const r = applyPaste(rows, paste); setRows(r.rows); setNotes(r.notes); setPaste(""); }}>Apply the pasted rates</button>
        <button type="button" className="btn" disabled={act.busy} onClick={doPreview}>Preview both curves</button>
        <button type="button" className="btn btn-primary" disabled={act.busy || changed.length === 0} onClick={doSave}>{`Save as "${variant}" and use it`}</button>
        <button type="button" className="btn btn-quiet" onClick={() => downloadText(`market-template-${props.snapId}.csv`, templateFromRows(rows))}>Download the market template</button>
        <button type="button" className="btn btn-quiet" disabled={changed.length === 0} onClick={() => { setRows(editRowsOf(snap)); setPreview(null); }}>Reset to the snapshot</button>
      </div>
      {notes.length > 0 ? <ul className="guided-missing">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      {unsaved ? <p><span className="guided-badge" role="status">Not saved yet</span></p> : null}
      {changed.length > 0 ? <p className="guided-note">{`Changed: ${changed.map((c) => `${c.tenor} ${c.fromPercent}% to ${c.toPercent}% (${c.changeBp > 0 ? "+" : ""}${c.changeBp} bp)`).join("; ")}.`}</p> : <p className="field-help">No rate changed yet: saving needs at least one change.</p>}
      <ActionLines busy={act.busy} error={act.error} done={act.done} />
      {refusals.length > 0 ? <p className="guided-bad" role="alert">{refusals.join(" ")}</p> : null}
      {series.length > 0 && refusals.length === 0 ? (
        <figure className="viz">
          <LinePlot series={series} xScale="sqrt" xTicks={tenorTicks} xLabel={(m) => tenorTextOf(m)} yTick={(v) => `${v.toFixed(2)}%`} format={(v) => `${v.toFixed(4)}%`} unit="zero rate, percent" />
          <figcaption className="field-help">Zero rates at the quote tenors, built log-linear on discount factor on the snapshot's convention.</figcaption>
        </figure>
      ) : null}
      <Details>
        <p>The variant is a curve setup, editable under Advanced, Market, Curve setups. Its id is {variant}; it builds from {props.snapId}.</p>
      </Details>
    </section>
  );
}

function VolCard(props: { ctx: StepContext; snap: SnapshotLike }) {
  const s = summarizeSnapshot(props.snap);
  const ws = props.ctx.ws;
  return (
    <section className="card" aria-label="Volatility surfaces">
      <div className="card-title">Volatility surfaces</div>
      <p className="card-desc">
        Cap volatilities ({s.capExpiries} expiries by {s.capStrikes} strikes{s.hasAtmCaps ? ", with the at-the-money column a Hull-White fit needs" : ""}) and swaption volatilities
        ({s.swaptionExpiries} expiries by {s.swaptionTenors} tenors). They matter for a stochastic run, which fits its rate model to them.
      </p>
      {isIllustrativePack(props.snap) ? (
        <p className="card-desc">
          <span className="guided-badge">illustrative</span> On this snapshot both surfaces, and the term funding premium the funding charges read, are constructed illustrative values, not market quotes: the volatilities are built from the realized volatility of the published curve. The yield curve itself is published US Treasury data.
        </p>
      ) : null}
      <div className="guided-actions">
        <a className="btn" href={hrefFor({ ws, section: "market", screen: "vols" })}>See the surfaces</a>
        <a className="btn" href={hrefFor({ ws, section: "run", screen: "scenarios", query: { tab: "volatility" } })}>Scale or shift a surface</a>
      </div>
      <p className="field-help">A scaled or shifted surface is saved as a market of its own, beside this snapshot; a run setup under Advanced can run on it. Typing single surface points is not offered.</p>
    </section>
  );
}
