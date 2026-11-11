// apps/studio/src/pages/results/FtpTab.tsx
/**
 * FTP tab (Studio S3a): result.ftp as stored. Base scenario only;
 * the shocked-scenario refusal travels inside the block and prints verbatim.
 * An absent family rate is an empty family, never 0.
 * Teaching slice A4: the table links to its server CSV (ftp.csv), every value
 * at full precision where the tab rounds.
 * A run that prices a deposit on its replicating-portfolio credit shows a Deposit credits card.
 */
import type { FtpFamilyRow } from "@alm/engine";
import { bridgeHasDerivatives, exportCsvUrl, NOT_IN_RUN, pct, signedMM, usdMM } from "@alm/reader";
import { bridgeNote, newBusinessRead } from "../../results/newBusiness";
import { blockOf, NotInRun, type TabProps } from "./common";
import { DepositCreditsCard } from "./DepositReadouts";

type RateField = "couponRate" | "irFtpRate" | "lpFtpRate" | "allInFtpRate" | "ftpMarginRate";

function RateCell(props: { f: FtpFamilyRow; field: RateField }) {
  const v = props.f[props.field];
  if (v === undefined) {
    const reason = `${props.field} is absent for family ${props.f.familyId}: the engine transfer-prices no notional for this family (an empty family, an off-balance-sheet commitment or a swap, none of which is funded), so it stores no rate`;
    return <td className="num"><span className="status status-unobs" title={reason}>{NOT_IN_RUN}</span></td>;
  }
  return <td className="num">{pct(v, 4)}</td>;
}

export const NO_PRICED_NOTIONAL = "The engine transfer-prices no notional in this book (every family is empty, an off-balance-sheet commitment or a swap, none of which is funded): it stores 0 here as its zero-notional guard, not as a rate";

export function FtpTab(p: TabProps) {
  const ftp = blockOf(p.result, "ftp");
  if (ftp === undefined) {
    return <NotInRun title="FTP" reason="The envelope carries no ftp block: a seasoned book omits it and carries a notImplemented tag instead, an envelope stored before the block existed does not carry it, or the run setup turned FTP off." />;
  }
  const withDer = bridgeHasDerivatives(ftp.nimBridge);
  const h = ftp.nimBridge.horizonMonths;
  const noPricedNotional = ftp.book.bookNimRate === 0 && ftp.byFamily.every((f) => f.notional === 0);
  // FTP reads the contractual stage; NII reads the balance stage when the base runs new business (spec Section 5.2 item 4).
  const nbNote = bridgeNote(newBusinessRead(p.result), ftp.scenarioId);
  return (
    <>
      <section className="card table-card" aria-label="FTP by family">
        <div className="card-title">Funds transfer pricing, {p.scenarioLabel(ftp.scenarioId)}</div>
        <p className="card-desc">IR leg against {ftp.irBasis}, all-in leg against {ftp.allInBasis}; rates are the engine's notional-weighted family rates.</p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Family</th><th scope="col">Side</th><th scope="col" className="num">Positions</th><th scope="col" className="num">Notional</th><th scope="col" className="num">Coupon</th><th scope="col" className="num">IR FTP</th><th scope="col" className="num">LP FTP</th><th scope="col" className="num">All-in FTP</th><th scope="col" className="num">FTP margin</th><th scope="col" className="num">Coupon interest 12m</th><th scope="col" className="num">FTP accrual 12m</th><th scope="col" className="num">Margin 12m</th></tr></thead>
            <tbody>
              {ftp.byFamily.map((f) => (
                <tr key={f.familyId}>
                  <th scope="row" className="mono">{f.familyId}</th>
                  <td>{f.side}</td>
                  <td className="num">{f.positionCount.toLocaleString("en-US")}</td>
                  <td className="num">{usdMM(f.notional)}</td>
                  <RateCell f={f} field="couponRate" />
                  <RateCell f={f} field="irFtpRate" />
                  <RateCell f={f} field="lpFtpRate" />
                  <RateCell f={f} field="allInFtpRate" />
                  <RateCell f={f} field="ftpMarginRate" />
                  <td className="num">{signedMM(f.couponInterest12)}</td>
                  <td className="num">{signedMM(f.ftpAccrual12)}</td>
                  <td className="num">{signedMM(f.margin12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-desc">
          <a className="btn btn-quiet" href={exportCsvUrl(p.runId, "ftp")} download>Export ftp.csv</a>
          {" "}The CSV carries every family, the book roll-up and the NIM bridge at full precision; a blank rate is a rate the engine does not store.
        </p>
        <p className="card-foot">Source: /api/runs/{p.runId}/result ftp.byFamily</p>
      </section>
      {/* The deposit credits, when a family carries one. */}
      <DepositCreditsCard byFamily={ftp.byFamily} scenarioLabel={p.scenarioLabel} />
      <section className="card table-card" aria-label="Book roll-up and NIM bridge">
        <div className="card-title">Book roll-up and NIM bridge</div>
        <dl className="kv">
          <dt>Book NIM rate</dt>
          <dd className="num">{pct(ftp.book.bookNimRate, 4)}{noPricedNotional ? <> <span className="status status-unobs" title={NO_PRICED_NOTIONAL}>no priced notional</span></> : null}</dd>
          <dt>Charges 12m (assets)</dt><dd className="num">{signedMM(ftp.book.charges12)}</dd>
          <dt>Credits 12m (liabilities)</dt><dd className="num">{signedMM(ftp.book.credits12)}</dd>
          <dt>Mismatch center 12m</dt><dd className="num">{signedMM(ftp.book.mismatchCenter12)}</dd>
          <dt>Lending margin {h}m</dt><dd className="num">{signedMM(ftp.nimBridge.lendingMargin12)}</dd>
          <dt>Funding margin {h}m</dt><dd className="num">{signedMM(ftp.nimBridge.fundingMargin12)}</dd>
          <dt>Mismatch center {h}m</dt><dd className="num">{signedMM(ftp.nimBridge.mismatchCenter12)}</dd>
          {withDer && ftp.nimBridge.derivativesNet12 !== undefined ? (<><dt>Derivatives {h}m</dt><dd className="num">{signedMM(ftp.nimBridge.derivativesNet12)}</dd></>) : null}
          <dt>Bridge net {h}m</dt><dd className="num">{signedMM(ftp.nimBridge.bridgeNet12)}</dd>
          {ftp.nimBridge.newBusinessNet12 !== undefined ? (<><dt>New business net {h}m</dt><dd className="num">{signedMM(ftp.nimBridge.newBusinessNet12)}</dd></>) : null}
          <dt>NII net {h}m</dt><dd className="num">{signedMM(ftp.nimBridge.niiNet12)}</dd>
        </dl>
        {ftp.nimBridge.newBusinessNet12 !== undefined ? <p className="card-desc" role="note">New business net is the part of 12-month NII the FTP margins do not explain: the income on balances the run originated, which the contractual bridge does not cover. Bridge net plus new business net is NII net.</p> : null}
        {p.basisLabel !== undefined && p.basisLabel !== null ? <p className="card-desc" role="note">Basis: {p.basisLabel}</p> : null}
        {nbNote !== null ? <p className="card-desc" role="note">{nbNote}</p> : null}
        <p className="card-foot">Bridge net and NII net are both stored engine values; this tab computes neither. Source: ftp.book and ftp.nimBridge.</p>
      </section>
      <section className="card unobs-panel" aria-label="Shocked scenarios">
        <div className="card-title">Shocked scenarios</div>
        <span className="status status-unobs">Refused by the engine</span>
        <p className="unobs-text"><span className="mono">{ftp.shockedScenarios.layer}</span> {ftp.shockedScenarios.reason}</p>
      </section>
    </>
  );
}
