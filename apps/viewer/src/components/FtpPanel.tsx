/**
 * FTP tab: renders the RunResult.ftp block verbatim.
 *
 * Honesty rules:
 *  - Every figure is an envelope field through the tested formatters. Family
 *    rates are the engine's notional-weighted rates; the panel never derives a
 *    rate from dollars.
 *  - An absent family rate means the family holds no positions (the contract:
 *    "the engine does not print 0 where undefined is the truth"); it renders
 *    "n/a (empty family)", never 0 and never blank.
 *  - The block is BASE-SCENARIO ONLY. The shocked-scenario refusal
 *    travels INSIDE the block as a typed NotImplemented and is rendered here
 *    in the engine's own words.
 *  - The NIM bridge shows the engine's stored bridgeNet12 beside its stored
 *    niiNet12 (copied verbatim from computeNII engine-side); the panel
 *    displays both and computes neither.
 * This panel is only mounted when the envelope carries the block; a seasoned
 * book omits it and carries the typed `ftp.seasoned-book` register tag, which
 * the Overview register renders verbatim.
 */
import type { FtpResult } from "@alm/engine";
import { pct, signClass, signedMM, usdMM } from "@alm/reader";
import { bridgeHasDerivatives } from "@alm/reader";
import { useScenarioLabel } from "@alm/reader";

function RateCell({ value }: { value: number | undefined }) {
  if (value === undefined) {
    return (
      <td className="num">
        <span
          className="muted"
          title="The family holds no positions; an empty family has no rate and the engine does not print 0 where undefined is the truth."
        >
          n/a (empty family)
        </span>
      </td>
    );
  }
  return <td className="num">{pct(value, 4)}</td>;
}

export function FtpPanel({
  ftp,
  familyLabel,
  ftpJsonUrl,
}: {
  ftp: FtpResult;
  familyLabel: (id: string) => string;
  ftpJsonUrl: string;
}) {
  const scenarioLabel = useScenarioLabel();
  const withDerivatives = bridgeHasDerivatives(ftp.nimBridge);
  return (
    <>
      <section className="panel">
        <h2>Funds Transfer Pricing</h2>
        <p className="desc">
          Par-matched static-strip FTP for the {scenarioLabel(ftp.scenarioId)} scenario (base only).
          IR leg par-matched against {ftp.irBasis}; all-in leg against {ftp.allInBasis}; LP is the residual,
          all-in minus IR. Rates are the engine&rsquo;s notional-weighted family rates, verbatim; nothing on
          this tab is derived client-side.
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Family</th>
                <th>Side</th>
                <th>Positions</th>
                <th>Notional</th>
                <th>Coupon</th>
                <th>IR FTP</th>
                <th>LP FTP</th>
                <th>All-in FTP</th>
                <th>FTP margin</th>
                <th>Coupon int. 12M</th>
                <th>FTP accrual 12M</th>
                <th>Margin 12M</th>
              </tr>
            </thead>
            <tbody>
              {ftp.byFamily.map((f) => (
                <tr key={f.familyId}>
                  <td>{familyLabel(f.familyId)}</td>
                  <td>{f.side}</td>
                  <td className="num">{f.positionCount.toLocaleString("en-US")}</td>
                  <td className="num">{usdMM(f.notional)}</td>
                  <RateCell value={f.couponRate} />
                  <RateCell value={f.irFtpRate} />
                  <RateCell value={f.lpFtpRate} />
                  <RateCell value={f.allInFtpRate} />
                  <RateCell value={f.ftpMarginRate} />
                  <td className="num">{signedMM(f.couponInterest12)}</td>
                  <td className="num">{signedMM(f.ftpAccrual12)}</td>
                  <td className={`num ${signClass(f.margin12)}`}>{signedMM(f.margin12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="footnote">
          FTP margin is sign-flipped by the engine so franchise value reads positive on both sides (asset:
          coupon &minus; all-in; liability: all-in &minus; coupon). Monthly balance / coupon / FTP-accrual
          series per family are in the stored block:{" "}
          <a href={ftpJsonUrl}>ftp block (JSON, verbatim)</a>.
        </p>
      </section>

      <section className="panel">
        <h2>Book roll-up and NIM bridge</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Book NIM rate</th>
                <th>Charges 12M (assets)</th>
                <th>Credits 12M (liabilities)</th>
                <th>Mismatch center 12M</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{pct(ftp.book.bookNimRate, 4)}</td>
                <td className="num">{signedMM(ftp.book.charges12)}</td>
                <td className="num">{signedMM(ftp.book.credits12)}</td>
                <td className={`num ${signClass(ftp.book.mismatchCenter12)}`}>
                  {signedMM(ftp.book.mismatchCenter12)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="tablewrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Lending margin {ftp.nimBridge.horizonMonths}M</th>
                <th>Funding margin {ftp.nimBridge.horizonMonths}M</th>
                <th>Mismatch center {ftp.nimBridge.horizonMonths}M</th>
                {withDerivatives ? <th>Derivatives {ftp.nimBridge.horizonMonths}M</th> : null}
                <th>Bridge net {ftp.nimBridge.horizonMonths}M</th>
                <th>NII net {ftp.nimBridge.horizonMonths}M (computeNII)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{signedMM(ftp.nimBridge.lendingMargin12)}</td>
                <td className="num">{signedMM(ftp.nimBridge.fundingMargin12)}</td>
                <td className="num">{signedMM(ftp.nimBridge.mismatchCenter12)}</td>
                {withDerivatives && ftp.nimBridge.derivativesNet12 !== undefined ? (
                  <td className="num">{signedMM(ftp.nimBridge.derivativesNet12)}</td>
                ) : null}
                <td className="num">{signedMM(ftp.nimBridge.bridgeNet12)}</td>
                <td className="num">{signedMM(ftp.nimBridge.niiNet12)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="footnote">
          The bridge welds FTP to the already-validated NII number: bridge net and NII net are both stored
          engine values (the reconciliation to 1e-9 is asserted engine-side); this panel shows both and
          computes neither.
        </p>
      </section>

      <section className="panel">
        <h2>Shocked scenarios — refused, typed</h2>
        <p className="desc">
          The engine&rsquo;s own refusal, carried inside the FTP block and shown verbatim; a shocked-scenario
          FTP series is not published this window.
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Layer</th>
                <th style={{ textAlign: "left" }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{ftp.shockedScenarios.layer}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>{ftp.shockedScenarios.reason}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
