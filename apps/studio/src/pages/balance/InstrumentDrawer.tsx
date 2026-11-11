/**
 * Instrument drawer: one position projected on demand by POST
 * /api/instrument/project at a 0 bp parallel shock (the route labels it Base).
 * Every figure is the route's own; a refusal (422) is printed verbatim.
 * The two terms the engine reads beside the kernel's, where a position carries them: a
 * floater's funding tenor and an nmd deposit's straight-line runoff.
 */
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import { modelConventionNoteText } from "../results/GridAsOf";
import { Fragment, useEffect, type ReactNode } from "react";
import { legTables, pct, projectInstrument, usd, years, type InstrumentDrill, type InstrumentScheduleRowView } from "@alm/reader";
import { useLoad } from "../../useLoad";
import { pageErrText } from "../../errText";

const MONTHS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** One engine term of a position as the drawer prints it: its label and its value in words. */
export interface EngineTermRow { label: string; value: string }

/**
 * The engine terms a position carries and the engine reads, in words; [] for none. A funding tenor
 * is read on a floating loan only, a straight-line runoff on an nmd only, as intake checks them.
 */
export function engineTermRows(terms: Record<string, unknown>): EngineTermRow[] {
  const out: EngineTermRow[] = [];
  const tenor = terms.fundingTenorMonths;
  if (terms.type === "floating-loan" && typeof tenor === "number") {
    out.push({ label: "Funding tenor", value: `${tenor} months: FTP reads the rate leg at the reset tenor and the liquidity leg here` });
  }
  const linear = terms.linearDecay as { horizonMonths?: unknown } | undefined;
  if (terms.type === "nmd" && linear !== undefined && typeof linear.horizonMonths === "number") {
    out.push({ label: "Straight-line runoff", value: `${linear.horizonMonths} months: the same amount leaves every month` });
  }
  return out;
}

function Unobs() {
  return <span className="status status-unobs">Unobservable</span>;
}

function Schedule(props: { title: string; rows: InstrumentScheduleRowView[] }) {
  return (
    <div className="drawer-block">
      <div className="card-title">{props.title}</div>
      <div className="table-wrap drawer-table">
        <table className="table">
          <thead>
            <tr><th scope="col" className="num">Month</th><th scope="col" className="num">Path rate</th><th scope="col" className="num">Coupon</th><th scope="col" className="num">Balance</th><th scope="col" className="num">Principal</th><th scope="col" className="num">Interest</th><th scope="col" className="num">Payment</th></tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.month}>
                <th scope="row" className="num">{r.month}</th>
                <td className="num">{pct(r.pathRate)}</td>
                <td className="num">{pct(r.couponRate)}</td>
                <td className="num lvl">{usd(r.balance)}</td>
                <td className="num">{usd(r.principal)}</td>
                <td className="num">{usd(r.interest)}</td>
                <td className="num">{usd(r.payment)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DrillBody(props: { drill: InstrumentDrill }) {
  const { drill } = props;
  const s = drill.byScenario[0];
  if (s === undefined) return <p className="unobs-text"><Unobs /> The route returned no scenario projection.</p>;
  const legs = legTables(s);
  return (
    <>
      <dl className="kv">
        <dt>Position</dt><dd className="mono">{drill.terms.id}</dd>
        <dt>Type</dt><dd className="mono">{drill.terms.type}</dd>
        <dt>Family</dt><dd className="mono">{drill.familyId}</dd>
        <dt>Side</dt><dd>{drill.side}</dd>
        <dt>Scenarios</dt><dd className="mono">{drill.scenarioSource}, {s.scenarioId}</dd>
        <dt>Market</dt><dd className="mono">{drill.marketId}</dd>
        {engineTermRows(drill.terms).map((r) => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}
        <dt>WAL</dt><dd>{s.walMonths === undefined ? <Unobs /> : <span className="num" title={String(s.walMonths)}>{MONTHS.format(s.walMonths)} months</span>}</dd>
        <dt>Effective duration</dt>
        <dd>{s.effectiveDuration === undefined ? <Unobs /> : <span className="num" title={String(s.effectiveDuration)}>{years(s.effectiveDuration)} years{s.durationBasis === "notional" ? ", per unit of notional" : ""}</span>}</dd>
      </dl>
      <Schedule title={legs.length > 0 ? "Net schedule" : "Schedule"} rows={s.rows} />
      {legs.map((l) => <Schedule key={l.leg} title={l.leg === "receive" ? "Receive leg" : "Pay leg"} rows={l.rows} />)}
      {modelConventionNoteText(drill.modelConvention) !== null ? <p className="card-desc" role="note">{modelConventionNoteText(drill.modelConvention)}</p> : null}
      <p className="card-foot">Source: POST /api/instrument/project byScenario[{s.scenarioId}], parallelShockBp 0, overlay {drill.overlayApplied}</p>
    </>
  );
}

function DrillLoaded(props: { bookId: string; positionId: string; marketId: string }) {
  const { bookId, positionId, marketId } = props;
  const load = useLoad(
    // The drawer belongs to no setup, so it walks a CD book on the convention a new setup carries.
    () => projectInstrument({ instrument: { portfolioId: bookId, positionId }, marketId, scenarios: { parallelShockBp: 0 }, modelConvention: CURRENT_MODEL_CONVENTION }),
    [bookId, positionId, marketId],
  );
  if (load.state === "loading") return <p className="muted">Projecting {positionId}</p>;
  if (load.state === "error") {
    const e = load.error;
    return <p role="alert" className="drawer-error">{pageErrText(e)}</p>;
  }
  return <DrillBody drill={load.value} />;
}

export function InstrumentDrawer(props: { bookId: string; positionId: string; marketId: string | null; closeHref: string }) {
  const { bookId, positionId, marketId, closeHref } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") window.location.hash = closeHref; };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeHref]);
  let body: ReactNode;
  if (marketId === null) body = <p className="unobs-text">Pick an as-of market in the header first.</p>;
  else body = <DrillLoaded bookId={bookId} positionId={positionId} marketId={marketId} />;
  return (
    <aside className="drawer" aria-label={`Instrument ${positionId}`}>
      <div className="sheet drawer-sheet">
        <div className="sheet-head">
          <div className="sheet-title mono">{positionId}</div>
          <a className="btn btn-quiet" href={closeHref}>Close</a>
        </div>
        <div className="sheet-body">{body}</div>
      </div>
    </aside>
  );
}
