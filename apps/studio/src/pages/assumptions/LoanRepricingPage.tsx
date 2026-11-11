// apps/studio/src/pages/assumptions/LoanRepricingPage.tsx
/**
 * Data > Assumptions > Loan repricing. The stored flat-carry spreads
 * through the By kind table, then the run's projected client rate: the rows the
 * rate document stores, read at a few months. The page states what the rate is
 * and what reads it; nothing is computed here.
 */
import { getRates, type WorkspaceManifest } from "@alm/reader";
import type { RateDocument } from "@alm/engine";
import { clientRateModel, type ClientRateModel } from "../../assumptions/clientRatePathModel";
import { useLoad } from "../../useLoad";
import { ByKindPage } from "./ByKindPage";

/** The plain lines the section carries, in order. */
export const CLIENT_RATE_LINES = [
  "Flat carry: the total spread over the 10-year benchmark stays at its set value for the whole horizon.",
  "This equals the rate the prepayment refinance incentive computes for itself where a prepayment binding with both spreads applies.",
  "The client rate moves one for one with the 10-year benchmark from the first month. This is a modeling choice, and it overstates how fast offered rates follow market rates over the next year.",
  "No floor is applied: the client rate is the benchmark plus the spread in every month.",
  "No measure reads this rate yet: NII, EVE, gap and FTP are unchanged by it.",
  "Where a prepayment binding also applies, the total spread must equal its securitization plus primary spread.",
] as const;

/** The section for a model (null while the document loads): the plain lines, then a state sentence or one block per scenario. Props only. */
export function ClientRateView(props: { model: ClientRateModel | null }) {
  const { model } = props;
  return (
    <section className="card" aria-label="Projected client rate">
      <div className="card-title">Projected client rate</div>
      {CLIENT_RATE_LINES.map((l) => <p className="card-desc" key={l}>{l}</p>)}
      {model === null ? <p className="card-desc muted">Reading the rate document</p> : null}
      {model !== null && model.message !== null ? <p className="card-desc" role="status">{model.message}</p> : null}
      {(model?.scenarios ?? []).map((s) => (
        <div key={s.scenarioId}>
          <div className="card-title mono">{s.scenarioId}</div>
          {s.omitted !== null ? <p className="card-desc">{s.omitted}</p> : null}
          {s.rows.map((r, i) => (
            <div key={`${r.family}|${r.selector}|${i}`}>
              <p className="card-desc"><span className="mono">{r.family}</span>, <span className="words">{r.selector}</span>, total spread {r.spread}</p>
              <p className="card-desc">{r.basis}</p>
              <div className="table-wrap">
                <table className="table" aria-label={`Client rate, ${s.scenarioId}, ${r.family}`}>
                  <thead><tr>{r.cells.map((c) => <th scope="col" className="num" key={c.month}>Month {c.month}</th>)}</tr></thead>
                  <tbody><tr>{r.cells.map((c) => <td className="num" key={c.month}>{c.text}</td>)}</tr></tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ))}
      <p className="card-foot">Source: /api/runs/:id/rates scenarios[].clientRates</p>
    </section>
  );
}

function ClientRateSection(props: { run: string }) {
  const load = useLoad<RateDocument | null>(() => (props.run === "" ? Promise.resolve(null) : getRates(props.run)), [props.run]);
  const model = load.state === "loading" ? null : clientRateModel(load.state === "ok" ? { doc: load.value } : { error: load.error }, props.run);
  return <ClientRateView model={model} />;
}

export function LoanRepricingPage(props: { ws: string; head?: WorkspaceManifest | null; query: Record<string, string> }) {
  return (
    <>
      <ByKindPage ws={props.ws} head={props.head} layer="data/assumptions/loan-repricing" query={props.query} />
      <ClientRateSection run={props.query.run ?? ""} />
    </>
  );
}
