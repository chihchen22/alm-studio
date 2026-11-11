/**
 * Book route: portfolio listing, detail, and import.
 * Listing values (balances, position counts) are intake statistics — arithmetic
 * on INPUTS computed server-side at import — and are labeled as
 * such wherever shown. No engine result renders on this page.
 */
import { useCallback, useEffect, useState } from "react";
import type { PortfolioSpec } from "@alm/engine";
import { ApiError, getPortfolio, listPortfolios, type PortfolioListItem } from "@alm/reader";
import { ImportPanel } from "../components/ImportPanel";
import { usdMM } from "@alm/reader";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: PortfolioListItem[] };

type DetailState =
  | { status: "idle" }
  | { status: "loading"; id: string }
  | { status: "error"; id: string; message: string }
  | { status: "ready"; spec: PortfolioSpec };

export function PortfolioPage() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });

  const refresh = useCallback(() => {
    setList({ status: "loading" });
    listPortfolios()
      .then((items) => setList({ status: "ready", items }))
      .catch((err: unknown) =>
        setList({ status: "error", message: err instanceof ApiError ? `${err.code}: ${err.message}` : String(err) }),
      );
  }, []);

  useEffect(() => refresh(), [refresh]);

  function open(id: string) {
    setDetail({ status: "loading", id });
    getPortfolio(id)
      .then((spec) => setDetail({ status: "ready", spec }))
      .catch((err: unknown) =>
        setDetail({ status: "error", id, message: err instanceof Error ? err.message : String(err) }),
      );
  }

  return (
    <>
      <section className="panel">
        <h2>Portfolios</h2>
        <p className="desc">
          The books of record in the platform store. Balances shown are intake statistics (sums of imported
          notionals), not engine output.
        </p>
        {list.status === "loading" ? <p className="zero">Loading…</p> : null}
        {list.status === "error" ? <p className="error" style={{ padding: 0 }}>{list.message}</p> : null}
        {list.status === "ready" ? (
          list.items.length === 0 ? (
            <p className="zero">No portfolios in the store yet. Import one below.</p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Id</th>
                    <th style={{ textAlign: "left" }}>Label</th>
                    <th>Positions</th>
                    <th>As of</th>
                    <th>Assets*</th>
                    <th>Liabilities*</th>
                    <th style={{ textAlign: "left" }}>Content hash</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((p) => (
                    <tr key={p.id}>
                      <td style={{ fontFamily: "var(--mono)" }}>{p.id}</td>
                      <td style={{ textAlign: "left" }}>{p.label}</td>
                      <td className="num">{p.positionCount.toLocaleString("en-US")}</td>
                      <td className="num">{p.asOf}</td>
                      <td className="num">{p.intakeStats ? usdMM(p.intakeStats.assets) : "—"}</td>
                      <td className="num">{p.intakeStats ? usdMM(p.intakeStats.liabilities) : "—"}</td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 11, textAlign: "left" }}>
                        {p.contentHash.slice(0, 16)}…
                      </td>
                      <td>
                        <button
                          style={{
                            font: "inherit",
                            fontSize: 12,
                            padding: "2px 10px",
                            border: "1px solid var(--line-strong)",
                            borderRadius: 6,
                            background: "var(--panel)",
                            color: "var(--ink)",
                            cursor: "pointer",
                          }}
                          onClick={() => open(p.id)}
                        >
                          detail
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
        <p className="footnote">* Intake statistics computed at import from position notionals, not engine output.</p>
      </section>

      {detail.status === "loading" ? (
        <section className="panel">
          <h2>Portfolio detail</h2>
          <p className="zero">Loading {detail.id}…</p>
        </section>
      ) : null}
      {detail.status === "error" ? (
        <section className="panel">
          <h2>Portfolio detail</h2>
          <p className="error" style={{ padding: 0 }}>
            {detail.id}: {detail.message}
          </p>
        </section>
      ) : null}
      {detail.status === "ready" ? <PortfolioDetail spec={detail.spec} /> : null}

      <ImportPanel onImported={() => refresh()} />
    </>
  );
}

function PortfolioDetail({ spec }: { spec: PortfolioSpec }) {
  // Family position counts are an intake-plane fold over inputs,
  // labeled below; no result-plane number appears on this page.
  const countByFamily = new Map<string, number>();
  for (const pos of spec.positions) {
    countByFamily.set(pos.familyId, (countByFamily.get(pos.familyId) ?? 0) + 1);
  }
  return (
    <section className="panel">
      <h2>
        Portfolio <code style={{ fontFamily: "var(--mono)" }}>{spec.id}</code>
      </h2>
      <p className="desc">
        {spec.label} — {spec.positions.length.toLocaleString("en-US")} positions, as of {spec.asOf}. Import-only:
        the platform has no position editing; re-import under a new id is the edit path.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Family</th>
              <th style={{ textAlign: "left" }}>Label</th>
              <th>Side</th>
              <th>Positions*</th>
            </tr>
          </thead>
          <tbody>
            {spec.coa.families.map((f) => (
              <tr key={f.id}>
                <td style={{ fontFamily: "var(--mono)" }}>{f.id}</td>
                <td style={{ textAlign: "left" }}>{f.label}</td>
                <td>{f.side}</td>
                <td className="num">{(countByFamily.get(f.id) ?? 0).toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="footnote">* Position counts folded from the imported spec (intake statistics, not engine output).</p>
    </section>
  );
}
