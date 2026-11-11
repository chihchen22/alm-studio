/**
 * Data route: the workbench surface over the platform database — the
 * database of instrument-level positions, yield curves,
 * rates, and every simulation input), built by W3-D1, queried through the nine
 * read-only /api/catalog/* endpoints of W3-P9, and until this module visible
 * only to curl.
 *
 * Honesty rules, unchanged from every prior wave:
 *  - The client NEVER computes. Every number on this page — including every
 *    aggregate — is a verbatim server read (SQL aggregates computed in the
 *    database, served with their basis) rendered through the tested formatter.
 *    The only index arithmetic is pagination bookkeeping (offset + returned),
 *    which touches row positions, never a financial number.
 *  - A NULL is an honest absence and renders as "n/a" with its reason (the
 *    server's rateKind / basis), never as 0 or a blank cell.
 *  - Errors render the server's typed message VERBATIM. The mirror-freshness
 *    404 ("…a 404 here means that sync failed … the next boot sync lands it") is
 *    shown as the server wrote it, never softened into an empty table that would
 *    imply zero rows.
 *  - No control exists for a capability the server does not have: filters,
 *    grouping keys, curves, and lineage collections are the server's own
 *    enums; pagination stays inside the server's [1, 5000] bound; there is no
 *    edit, delete, or export control on this surface.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { ApiError, listAssumptionSets, listScenarioSlates } from "@alm/reader";
import {
  CATALOG_GROUP_BY,
  CATALOG_LINEAGE_COLLECTIONS,
  getCatalogAggregate,
  getCatalogAggregateGrouped,
  getCatalogLineage,
  getCatalogMarketSnapshot,
  getCatalogPositions,
  getCatalogRunInputs,
  listCatalogMarkets,
  listCatalogPortfolios,
  listCatalogRuns,
  type CatalogAggregate,
  type CatalogGroupBy,
  type CatalogLineage,
  type CatalogLineageCollection,
  type CatalogMarketListItem,
  type CatalogMarketSnapshot,
  type CatalogPortfolio,
  type CatalogPositionFilters,
  type CatalogPositionsPage,
  type CatalogRunInputs,
  type CatalogRunListItem,
} from "@alm/reader";
import { pct, sig, usd } from "@alm/reader";
import { VolHeatmap } from "../components/VolHeatmap";
import { capGrid, swaptionGrid, type VolGrid } from "@alm/reader";

// --- Shared plumbing ---------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
}

type Fetch<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

/** Load `fn` whenever `deps` change; carries the server's error text verbatim. */
function useFetch<T>(fn: () => Promise<T>, deps: unknown[]): Fetch<T> {
  const [state, setState] = useState<Fetch<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fn()
      .then((value) => live && setState({ status: "ready", value }))
      .catch((err: unknown) => live && setState({ status: "error", message: errorText(err) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** The server's typed error, verbatim — never an empty table in its place. */
function ServerMessage({ title, message }: { title: string; message: string }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <p className="desc">The platform returned the following. The message is shown verbatim; nothing is substituted.</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{message}</pre>
    </section>
  );
}

function Hash({ value }: { value: string | null }) {
  if (value === null) return <span className="zero">n/a</span>;
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11 }} title={value}>
      {value.slice(0, 16)}…
    </span>
  );
}

/** Verbatim rate cell: a NULL rate names its reason (the server's rateKind). */
function rateCell(rate: number | null, rateKind: string): string {
  return rate === null ? `n/a (${rateKind})` : pct(rate, 4);
}

const MIRROR_NOTE =
  "This page reads the SQLite mirror of the append-only file store. A book, market snapshot, " +
  "assumption set or scenario slate written through the API, and a run that reaches its end, sync into " +
  "the mirror at once, best effort; boot, seed, and migrate remain the reconciling sync. A document or " +
  "run whose sync failed, or that was stored by other means, appears after the next boot sync " +
  " (see the limitations page).";

// --- Portfolio picker (shared by Positions and Aggregates) -------------------

function PortfolioPicker({
  portfolios,
  selected,
  onSelect,
}: {
  portfolios: CatalogPortfolio[];
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel">
      <h2>Portfolio</h2>
      <p className="desc">Books mirrored in the platform database, with the mirror&rsquo;s content-hash pin.</p>
      {portfolios.length === 0 ? (
        <p className="emptynote">No portfolios are mirrored yet.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Positions</th>
                <th style={{ textAlign: "left" }}>Content hash</th>
                <th style={{ textAlign: "left" }}>Mirrored at</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {portfolios.map((p) => (
                <tr key={p.id} style={p.id === selected ? { fontWeight: 600 } : undefined}>
                  <td style={{ fontFamily: "var(--mono)" }}>{p.id}</td>
                  <td className="num">{p.positionCount.toLocaleString("en-US")}</td>
                  <td style={{ textAlign: "left" }}>
                    <Hash value={p.contentHash} />
                  </td>
                  <td style={{ textAlign: "left", fontSize: 12 }}>{p.ingestedAt}</td>
                  <td>
                    <button style={pickBtnStyle(p.id === selected)} onClick={() => onSelect(p.id)}>
                      {p.id === selected ? "selected" : "select"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function pickBtnStyle(active: boolean): CSSProperties {
  return {
    font: "inherit",
    fontSize: 12,
    padding: "2px 10px",
    border: `1px solid ${active ? "var(--accent)" : "var(--line-strong)"}`,
    borderRadius: 6,
    background: active ? "var(--accent)" : "var(--panel)",
    color: active ? "#fff" : "var(--ink)",
    cursor: "pointer",
  };
}

// --- Filter controls ---------------------------------------------------------

/**
 * Filter options come from the server's own grouped aggregates over the same
 * portfolio (the distinct values the book actually carries), so the dropdowns
 * can never send a value the server would 404 on — and if the mirror moves
 * underneath, the 404 renders verbatim rather than being swallowed.
 */
interface FilterOptions {
  familyIds: string[];
  coaNodeIds: string[];
  instrumentTypes: string[];
}

function useFilterOptions(portfolioId: string | undefined): Fetch<FilterOptions> {
  return useFetch<FilterOptions>(
    async () => {
      if (portfolioId === undefined) return { familyIds: [], coaNodeIds: [], instrumentTypes: [] };
      const [fam, coa, typ] = await Promise.all([
        getCatalogAggregateGrouped(portfolioId, {}, "family"),
        getCatalogAggregateGrouped(portfolioId, {}, "coaNode"),
        getCatalogAggregateGrouped(portfolioId, {}, "instrumentType"),
      ]);
      const keys = (groups: Array<{ key: string | null }>) =>
        groups.map((g) => g.key).filter((k): k is string => k !== null);
      return {
        familyIds: keys(fam.groups),
        coaNodeIds: keys(coa.groups),
        instrumentTypes: keys(typ.groups),
      };
    },
    [portfolioId],
  );
}

function FilterControls({
  options,
  filters,
  onChange,
}: {
  options: FilterOptions;
  filters: CatalogPositionFilters;
  onChange: (f: CatalogPositionFilters) => void;
}) {
  const select = (
    label: string,
    values: string[],
    current: string | undefined,
    set: (v: string | undefined) => void,
  ) => (
    <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
      {label}
      <select
        style={{ font: "inherit", fontSize: 12, padding: "3px 6px" }}
        value={current ?? ""}
        onChange={(e) => set(e.target.value === "" ? undefined : e.target.value)}
      >
        <option value="">(all)</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="controls" style={{ alignItems: "center" }}>
      {select("Family", options.familyIds, filters.familyId, (v) =>
        onChange({ ...filters, familyId: v }),
      )}
      {select("COA node", options.coaNodeIds, filters.coaNodeId, (v) =>
        onChange({ ...filters, coaNodeId: v }),
      )}
      {select("Instrument type", options.instrumentTypes, filters.instrumentType, (v) =>
        onChange({ ...filters, instrumentType: v }),
      )}
    </div>
  );
}

// --- Positions view ----------------------------------------------------------

/** Page sizes offered; all inside the server's mandatory [1, 5000] bound. */
const PAGE_LIMITS = [100, 500, 1000, 5000] as const;

function PositionsView({ portfolioId }: { portfolioId: string }) {
  // The parent keys this component on portfolioId, so a portfolio switch
  // remounts it and filters/offset reset synchronously — no transient fetch
  // of an old filter against the new book.
  const [filters, setFilters] = useState<CatalogPositionFilters>({});
  const [limit, setLimit] = useState<number>(500);
  const [offset, setOffset] = useState<number>(0);
  const options = useFilterOptions(portfolioId);

  const page = useFetch<CatalogPositionsPage>(
    () => getCatalogPositions(portfolioId, filters, limit, offset),
    [portfolioId, filters, limit, offset],
  );

  return (
    <section className="panel">
      <h2>Instrument-level positions</h2>
      <p className="desc">
        One row per instrument, verbatim from the mirrored positions table. Pagination is mandatory
        server-side (max 5,000 rows per page); the total row count is the server&rsquo;s own COUNT over the
        filtered set.
      </p>
      {options.status === "ready" ? (
        <FilterControls
          options={options.value}
          filters={filters}
          onChange={(f) => {
            setFilters(f);
            setOffset(0);
          }}
        />
      ) : options.status === "error" ? (
        <p className="desc">
          Filter options unavailable: <code>{options.message}</code>
        </p>
      ) : (
        <p className="desc">Loading filter options…</p>
      )}

      {page.status === "loading" ? <p className="zero">Loading positions…</p> : null}
      {page.status === "error" ? <ServerMessage title="Positions not available" message={page.message} /> : null}
      {page.status === "ready" ? <PositionsTable page={page.value} limit={limit} setLimit={setLimit} offset={offset} setOffset={setOffset} /> : null}
    </section>
  );
}

function PositionsTable({
  page,
  limit,
  setLimit,
  offset,
  setOffset,
}: {
  page: CatalogPositionsPage;
  limit: number;
  setLimit: (n: number) => void;
  offset: number;
  setOffset: (n: number) => void;
}) {
  const p = page.page;
  const first = p.returned === 0 ? 0 : p.offset + 1;
  const last = p.offset + p.returned;
  return (
    <>
      <div className="controls" style={{ alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Rows {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")} of{" "}
          <strong>{p.total.toLocaleString("en-US")}</strong> (server total for this filter set)
        </span>
        <button disabled={p.offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          ← Prev
        </button>
        <button disabled={last >= p.total} onClick={() => setOffset(offset + limit)}>
          Next →
        </button>
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
          Page size
          <select
            style={{ font: "inherit", fontSize: 12, padding: "3px 6px" }}
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setOffset(0);
            }}
          >
            {PAGE_LIMITS.map((l) => (
              <option key={l} value={l}>
                {l.toLocaleString("en-US")}
              </option>
            ))}
          </select>
        </label>
      </div>
      {p.total === 0 ? (
        <p className="emptynote">
          The filter combination intersects to zero positions (each individual filter value exists in this
          book — a value the book never carried would have been refused by name).
        </p>
      ) : (
        <div className="tablewrap" style={{ maxHeight: 520, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th style={{ textAlign: "left" }}>Family</th>
                <th style={{ textAlign: "left" }}>COA node</th>
                <th>Side</th>
                <th style={{ textAlign: "left" }}>Type</th>
                <th>Notional</th>
                <th>Rate</th>
                <th style={{ textAlign: "left" }}>Rate kind</th>
                <th>Maturity (m)</th>
                <th>Orig. offset (m)</th>
                <th style={{ textAlign: "left" }}>Amort</th>
                <th style={{ textAlign: "left" }}>Behavioral</th>
              </tr>
            </thead>
            <tbody>
              {page.positions.map((r) => (
                <tr key={r.positionId}>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{r.positionId}</td>
                  <td style={{ textAlign: "left" }}>{r.familyId}</td>
                  <td style={{ textAlign: "left" }}>{r.coaNodeId}</td>
                  <td>{r.side ?? <span className="zero">n/a</span>}</td>
                  <td style={{ textAlign: "left" }}>{r.instrumentType}</td>
                  <td className="num">{usd(r.notional)}</td>
                  <td className="num">{r.rate === null ? <span className="zero">{rateCell(null, r.rateKind)}</span> : rateCell(r.rate, r.rateKind)}</td>
                  <td style={{ textAlign: "left", fontSize: 12 }}>{r.rateKind}</td>
                  <td className="num">{r.maturityMonths.toLocaleString("en-US")}</td>
                  <td className="num">{r.originationOffsetMonths.toLocaleString("en-US")}</td>
                  <td style={{ textAlign: "left" }}>{r.amortType}</td>
                  <td style={{ textAlign: "left", fontSize: 12 }}>{r.behavioral ?? <span className="zero">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">
        Server page echo: limit {p.limit.toLocaleString("en-US")}, offset {p.offset.toLocaleString("en-US")},
        returned {p.returned.toLocaleString("en-US")}, total {p.total.toLocaleString("en-US")}. A NULL rate is
        model-implied (nmd-b: beta-s-curve; cd: cohort-book) and is named, never shown as 0.
      </p>
    </>
  );
}

// --- Aggregates view ---------------------------------------------------------

type GroupChoice = "total" | CatalogGroupBy;

function AggregatesView({ portfolioId }: { portfolioId: string }) {
  // Keyed on portfolioId by the parent (same reset-by-remount as PositionsView).
  const [filters, setFilters] = useState<CatalogPositionFilters>({});
  const [group, setGroup] = useState<GroupChoice>("family");
  const options = useFilterOptions(portfolioId);

  const data = useFetch<{
    basis: string;
    rows: Array<{ key: string | null } & CatalogAggregate>;
    grouped: boolean;
  }>(
    async () => {
      if (group === "total") {
        const res = await getCatalogAggregate(portfolioId, filters);
        return { basis: res.basis, rows: [{ key: null, ...res.aggregate }], grouped: false };
      }
      const res = await getCatalogAggregateGrouped(portfolioId, filters, group);
      return { basis: res.basis, rows: res.groups, grouped: true };
    },
    [portfolioId, filters, group],
  );

  return (
    <section className="panel">
      <h2>SQL aggregates</h2>
      <p className="desc">
        Computed in SQL inside the database and served verbatim — this page re-sums nothing. The
        server&rsquo;s basis statement below the table says exactly how each column was computed and where a
        value is honestly NULL.
      </p>
      <div className="controls" style={{ alignItems: "center" }}>
        <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 12, marginRight: 4 }}>Group by:</span>
        <button className={group === "total" ? "active" : ""} onClick={() => setGroup("total")}>
          Total
        </button>
        {CATALOG_GROUP_BY.map((g) => (
          <button key={g} className={group === g ? "active" : ""} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>
      {options.status === "ready" ? (
        <FilterControls options={options.value} filters={filters} onChange={setFilters} />
      ) : null}

      {data.status === "loading" ? <p className="zero">Loading aggregates…</p> : null}
      {data.status === "error" ? <ServerMessage title="Aggregate not available" message={data.message} /> : null}
      {data.status === "ready" ? (
        <>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{data.value.grouped ? group : "Scope"}</th>
                  <th>Positions</th>
                  <th>Total notional</th>
                  <th>Wtd avg rate</th>
                  <th>Rated notional (basis)</th>
                  <th>Wtd avg maturity (m)</th>
                  <th>Wtd avg remaining (m)</th>
                </tr>
              </thead>
              <tbody>
                {data.value.rows.map((r, i) => (
                  <tr key={r.key ?? `total-${i}`}>
                    <td style={{ textAlign: "left" }}>
                      {data.value.grouped ? (r.key ?? <span className="zero">n/a</span>) : "All filtered positions"}
                    </td>
                    <td className="num">{r.positionCount.toLocaleString("en-US")}</td>
                    <td className="num">{r.totalNotional === null ? <span className="zero">n/a</span> : usd(r.totalNotional)}</td>
                    <td className="num">
                      {r.weightedAvgRate === null ? (
                        <span className="zero">n/a (no rate-bearing notional)</span>
                      ) : (
                        pct(r.weightedAvgRate, 4)
                      )}
                    </td>
                    <td className="num">{r.ratedNotional === null ? <span className="zero">n/a</span> : usd(r.ratedNotional)}</td>
                    <td className="num">{r.weightedAvgMaturityMonths === null ? <span className="zero">n/a</span> : sig(r.weightedAvgMaturityMonths)}</td>
                    <td className="num">
                      {r.weightedAvgRemainingMaturityMonths === null ? (
                        <span className="zero">n/a</span>
                      ) : (
                        sig(r.weightedAvgRemainingMaturityMonths)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">Server basis, verbatim: {data.value.basis}</p>
        </>
      ) : null}
    </section>
  );
}

// --- Market view -------------------------------------------------------------

function MarketView({ initialSelected }: { initialSelected?: string }) {
  const markets = useFetch<CatalogMarketListItem[]>(() => listCatalogMarkets(), []);
  const [selected, setSelected] = useState<string | undefined>(initialSelected);

  // Default to the only snapshot when exactly one is mirrored.
  useEffect(() => {
    if (markets.status === "ready" && selected === undefined && markets.value.length === 1) {
      setSelected(markets.value[0].id);
    }
  }, [markets, selected]);

  return (
    <>
      <section className="panel">
        <h2>Market snapshots</h2>
        <p className="desc">
          Mirrored market documents: curve, short-rate volatility surface and long-yield volatility surface point
          counts with the as-of date.
        </p>
        {markets.status === "loading" ? <p className="zero">Loading…</p> : null}
        {markets.status === "error" ? <ServerMessage title="Markets not available" message={markets.message} /> : null}
        {markets.status === "ready" ? (
          markets.value.length === 0 ? (
            <p className="emptynote">No market snapshots are mirrored yet.</p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Id</th>
                    <th>As of</th>
                    <th>Curve points</th>
                    <th>Short-rate volatility points</th>
                    <th>Long-yield volatility points</th>
                    <th style={{ textAlign: "left" }}>Content hash</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {markets.value.map((m) => (
                    <tr key={m.id}>
                      <td style={{ fontFamily: "var(--mono)" }}>{m.id}</td>
                      <td className="num">{m.asOf ?? <span className="zero">n/a</span>}</td>
                      <td className="num">{m.curvePoints.toLocaleString("en-US")}</td>
                      <td className="num">{m.capVolPoints.toLocaleString("en-US")}</td>
                      <td className="num">{m.swaptionVolPoints.toLocaleString("en-US")}</td>
                      <td style={{ textAlign: "left" }}>
                        <Hash value={m.contentHash} />
                      </td>
                      <td>
                        <button style={pickBtnStyle(m.id === selected)} onClick={() => setSelected(m.id)}>
                          {m.id === selected ? "selected" : "open"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>
      {selected !== undefined ? <MarketSnapshotDetail id={selected} /> : null}
    </>
  );
}

const CURVE_TITLES: Record<string, string> = {
  "risk-free": "Risk-free curve (zero-construction quotes)",
  "term-funding": "Term funding curve",
  tlp: "Term liquidity premium (TLP) nodes (spread)",
};

function MarketSnapshotDetail({ id }: { id: string }) {
  const snap = useFetch<CatalogMarketSnapshot>(() => getCatalogMarketSnapshot(id), [id]);
  if (snap.status === "loading") {
    return (
      <section className="panel">
        <h2>Snapshot {id}</h2>
        <p className="zero">Loading…</p>
      </section>
    );
  }
  if (snap.status === "error") {
    return <ServerMessage title={`Snapshot ${id} not available`} message={snap.message} />;
  }
  const s = snap.value;
  return (
    <>
      <section className="panel">
        <h2>
          Snapshot <code style={{ fontFamily: "var(--mono)" }}>{s.id}</code>
        </h2>
        <div className="provbar">
          <span>
            As of <code>{s.asOf ?? "n/a"}</code>
          </span>
          <span>
            Content hash <code>{s.contentHash}</code>
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18, marginTop: 14 }}>
          {(Object.keys(s.curves) as Array<keyof typeof s.curves>).map((curve) => (
            <div key={curve}>
              <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>{CURVE_TITLES[curve] ?? curve}</h3>
              {s.curves[curve].length === 0 ? (
                <p className="emptynote">No points mirrored for this curve.</p>
              ) : (
                <div className="tablewrap" style={{ maxHeight: 320, overflowY: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Term</th>
                        <th>t (years)</th>
                        <th style={{ textAlign: "left" }}>Instrument</th>
                        <th>{curve === "tlp" ? "Spread" : "Rate"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.curves[curve].map((q, i) => (
                        <tr key={i}>
                          <td style={{ fontFamily: "var(--mono)" }}>{q.term ?? <span className="zero">—</span>}</td>
                          <td className="num">{sig(q.tYears)}</td>
                          <td style={{ textAlign: "left" }}>{q.instrumentType ?? <span className="zero">—</span>}</td>
                          <td className="num">{pct(q.value, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Short-rate volatility surface</h2>
        <p className="desc">
          {s.capVolSurface.length.toLocaleString("en-US")} points, verbatim. Normal vols are decimal
          (0.0177 = 177 bp); a NULL strike with the ATM flag is an at-the-money quote. The heatmap shows each
          quote in basis points on one light-to-dark ramp scaled to this surface&rsquo;s own range; the
          at-the-money column sits first. Hull-White 1F calibrates to the at-the-money column.
        </p>
        <VolSurfaceChart build={() => capGrid(s.capVolSurface)} colFormat={(c) => pct(c, 2)} colLabel="Strike" />
        <details className="values">
          <summary>Values ({s.capVolSurface.length.toLocaleString("en-US")} points)</summary>
          <VolTable
            rows={s.capVolSurface.map((q, i) => ({
              key: i,
              cells: [
                sig(q.expiryYears),
                q.strike === null ? (q.isAtm ? "ATM" : "n/a") : pct(q.strike, 2),
                q.isAtm ? "yes" : "no",
                sig(q.normalVol),
              ],
            }))}
            headers={["Expiry (y)", "Strike", "ATM", "Normal vol (decimal)"]}
          />
        </details>
      </section>

      <section className="panel">
        <h2>Long-yield volatility surface</h2>
        <p className="desc">
          {s.swaptionVolSurface.length.toLocaleString("en-US")} expiry-by-tenor at-the-money points, verbatim. The
          heatmap shows each quote in basis points on the same ramp, scaled to this surface&rsquo;s own range. BGM
          calibrates to the kernel&rsquo;s 28-point default subset of this surface.
        </p>
        <VolSurfaceChart
          build={() => swaptionGrid(s.swaptionVolSurface)}
          colFormat={(c) => sig(c)}
          colLabel="Tenor (y)"
        />
        <details className="values">
          <summary>Values ({s.swaptionVolSurface.length.toLocaleString("en-US")} points)</summary>
          <VolTable
            rows={s.swaptionVolSurface.map((q, i) => ({
              key: i,
              cells: [sig(q.expiryYears), sig(q.tenorYears), sig(q.normalVol)],
            }))}
            headers={["Expiry (y)", "Tenor (y)", "Normal vol (decimal)"]}
          />
        </details>
      </section>
    </>
  );
}

/** Runs a grid builder and captures its refusal as data instead of a thrown error. */
function tryBuild(build: () => VolGrid): { ok: true; grid: VolGrid } | { ok: false; message: string } {
  try {
    return { ok: true, grid: build() };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Builds a grid inside a guard: a refused surface prints its reason verbatim and the table below still lists every point. */
function VolSurfaceChart({
  build,
  colFormat,
  colLabel,
}: {
  build: () => VolGrid;
  colFormat: (c: number) => string;
  colLabel: string;
}) {
  const built = tryBuild(build);
  if (!built.ok) {
    return (
      <div>
        <p className="desc">
          <strong>Vol surface cannot be charted.</strong> The grid builder refused the stored points; the message is
          shown verbatim and the table below still lists every point.
        </p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{built.message}</pre>
      </div>
    );
  }
  return <VolHeatmap grid={built.grid} colFormat={colFormat} colLabel={colLabel} />;
}

function VolTable({ headers, rows }: { headers: string[]; rows: Array<{ key: number; cells: string[] }> }) {
  if (rows.length === 0) return <p className="emptynote">No points mirrored for this surface.</p>;
  return (
    <div className="tablewrap" style={{ maxHeight: 360, overflowY: "auto" }}>
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, i) => (
                <td key={i} className="num">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Runs view (resolved input sets) -----------------------------------------

function RunsView() {
  const runs = useFetch<CatalogRunListItem[]>(() => listCatalogRuns(), []);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  return (
    <>
      <section className="panel">
        <h2>Mirrored runs</h2>
        <p className="desc">
          Runs the database has mirrored, with their hash pins. A run syncs here when it reaches its end,
          best effort; one whose sync failed appears after the next boot sync. The run list on the Run page
          reads the live store and may be ahead of this one.
        </p>
        {runs.status === "loading" ? <p className="zero">Loading…</p> : null}
        {runs.status === "error" ? <ServerMessage title="Runs not available" message={runs.message} /> : null}
        {runs.status === "ready" ? (
          runs.value.length === 0 ? (
            <p className="emptynote">No runs are mirrored yet (a run syncs when it reaches its end; boot, seed and migrate reconcile).</p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Run</th>
                    <th>State</th>
                    <th style={{ textAlign: "left" }}>Label</th>
                    <th style={{ textAlign: "left" }}>Submitted</th>
                    <th>Elapsed (ms)</th>
                    <th style={{ textAlign: "left" }}>Request hash</th>
                    <th style={{ textAlign: "left" }}>Engine inputs hash</th>
                    <th style={{ textAlign: "left" }}>Result hash</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.value.map((r) => (
                    <tr key={r.runId}>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{r.runId}</td>
                      <td>{r.state}</td>
                      <td style={{ textAlign: "left" }}>{r.label ?? <span className="zero">—</span>}</td>
                      <td style={{ textAlign: "left", fontSize: 12 }}>{r.submittedAt ?? "n/a"}</td>
                      <td className="num">{r.elapsedMs === null ? <span className="zero">n/a</span> : r.elapsedMs.toLocaleString("en-US")}</td>
                      <td style={{ textAlign: "left" }}>
                        <Hash value={r.platformRequestHash} />
                      </td>
                      <td style={{ textAlign: "left" }}>
                        <Hash value={r.engineInputsHash} />
                      </td>
                      <td style={{ textAlign: "left" }}>
                        <Hash value={r.resultContentHash} />
                      </td>
                      <td>
                        <button style={pickBtnStyle(r.runId === selected)} onClick={() => setSelected(r.runId)}>
                          inputs
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>
      {selected !== undefined ? <RunInputsDetail runId={selected} /> : null}
    </>
  );
}

function RunInputsDetail({ runId }: { runId: string }) {
  const inputs = useFetch<CatalogRunInputs>(() => getCatalogRunInputs(runId), [runId]);
  if (inputs.status === "loading") {
    return (
      <section className="panel">
        <h2>Resolved input set</h2>
        <p className="zero">Loading {runId}…</p>
      </section>
    );
  }
  if (inputs.status === "error") {
    return <ServerMessage title={`Input set for ${runId} not available`} message={inputs.message} />;
  }
  const r = inputs.value;
  return (
    <section className="panel">
      <h2>
        Resolved input set — <code style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{r.runId}</code>
      </h2>
      <p className="desc">
        What exactly this simulation consumed: every input artifact with the content-hash pin recorded at
        ingest and verified against the file store. Nothing here is recomputed.
      </p>
      <dl className="kv">
        <dt>State</dt>
        <dd>{r.state}</dd>
        <dt>Seed</dt>
        <dd>{r.seed ?? "n/a"}</dd>
        <dt>Grid</dt>
        <dd>{r.grid === null ? "n/a" : JSON.stringify(r.grid)}</dd>
        <dt>Engine context</dt>
        <dd>{r.engineContext === null ? "n/a" : JSON.stringify(r.engineContext)}</dd>
        <dt>Platform request hash</dt>
        <dd>{r.platformRequestHash}</dd>
        <dt>Engine inputs hash</dt>
        <dd>{r.engineInputsHash ?? "n/a (a stochastic envelope carries no deterministic provenance block)"}</dd>
        <dt>Result content hash</dt>
        <dd>{r.resultContentHash ?? "n/a (no linked result)"}</dd>
        <dt>Result bytes</dt>
        <dd>{r.resultBytes === null ? "n/a" : r.resultBytes.toLocaleString("en-US")}</dd>
        <dt>Submitted</dt>
        <dd>{r.submittedAt ?? "n/a"}</dd>
        <dt>Ended</dt>
        <dd>{r.endedAt ?? "n/a"}</dd>
      </dl>
      <div className="tablewrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Role</th>
              <th>Ord</th>
              <th style={{ textAlign: "left" }}>Collection</th>
              <th style={{ textAlign: "left" }}>Document</th>
              <th style={{ textAlign: "left" }}>Content hash (pin)</th>
            </tr>
          </thead>
          <tbody>
            {r.inputs.map((p) => (
              <tr key={`${p.role}-${p.ord}-${p.id}`}>
                <td style={{ textAlign: "left" }}>{p.role}</td>
                <td className="num">{p.ord}</td>
                <td style={{ textAlign: "left" }}>{p.collection}</td>
                <td style={{ textAlign: "left", fontFamily: "var(--mono)", fontSize: 12 }}>{p.id}</td>
                <td style={{ textAlign: "left", fontFamily: "var(--mono)", fontSize: 11, wordBreak: "break-all", whiteSpace: "normal" }}>
                  {p.contentHash}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Lineage view ------------------------------------------------------------

function LineageView() {
  const [collection, setCollection] = useState<CatalogLineageCollection>("portfolios");
  const [docId, setDocId] = useState<string | undefined>(undefined);

  // Document pickers come from the relevant listing: the catalog for
  // portfolios/markets, the file-store listings for slates and assumption sets
  // (the catalog has no listing endpoint for those two). A store document the
  // mirror has not caught up with 404s typed from the lineage call, and that
  // message renders verbatim below.
  const ids = useFetch<string[]>(
    async () => {
      if (collection === "portfolios") return (await listCatalogPortfolios()).map((p) => p.id);
      if (collection === "market") return (await listCatalogMarkets()).map((m) => m.id);
      if (collection === "scenario-slates") return (await listScenarioSlates()).map((s) => s.id);
      return (await listAssumptionSets()).map((a) => a.id);
    },
    [collection],
  );

  useEffect(() => {
    setDocId(undefined);
  }, [collection]);

  return (
    <>
      <section className="panel">
        <h2>Lineage</h2>
        <p className="desc">
          Which mirrored runs consumed a given document, with the content hash each run pinned at
          submission. Collections are the server&rsquo;s run-consumable set.
        </p>
        <div className="controls">
          {CATALOG_LINEAGE_COLLECTIONS.map((c) => (
            <button key={c} className={c === collection ? "active" : ""} onClick={() => setCollection(c)}>
              {c}
            </button>
          ))}
        </div>
        {ids.status === "loading" ? <p className="zero">Loading document list…</p> : null}
        {ids.status === "error" ? (
          <p className="desc">
            Document listing unavailable: <code>{ids.message}</code>
          </p>
        ) : null}
        {ids.status === "ready" ? (
          ids.value.length === 0 ? (
            <p className="emptynote">No documents in this collection.</p>
          ) : (
            <div className="controls">
              {ids.value.map((id) => (
                <button key={id} className={id === docId ? "active" : ""} onClick={() => setDocId(id)}>
                  {id}
                </button>
              ))}
            </div>
          )
        ) : null}
      </section>
      {docId !== undefined ? <LineageDetail collection={collection} docId={docId} /> : null}
    </>
  );
}

function LineageDetail({ collection, docId }: { collection: CatalogLineageCollection; docId: string }) {
  const lin = useFetch<CatalogLineage>(() => getCatalogLineage(collection, docId), [collection, docId]);
  if (lin.status === "loading") {
    return (
      <section className="panel">
        <h2>Lineage detail</h2>
        <p className="zero">Loading {docId}…</p>
      </section>
    );
  }
  if (lin.status === "error") {
    return <ServerMessage title={`Lineage for ${docId} not available`} message={lin.message} />;
  }
  const l = lin.value;
  return (
    <section className="panel">
      <h2>
        <code style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
          {l.collection}/{l.id}
        </code>
      </h2>
      <div className="provbar">
        <span>
          Mirrored content hash <code>{l.contentHash}</code>
        </span>
      </div>
      {l.consumedBy.length === 0 ? (
        <p className="emptynote" style={{ marginTop: 12 }}>
          No mirrored run has consumed this document (an honest empty set; a run whose sync failed appears
          after the next boot sync).
        </p>
      ) : (
        <div className="tablewrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Run</th>
                <th style={{ textAlign: "left" }}>Role</th>
                <th>State</th>
                <th style={{ textAlign: "left" }}>Submitted</th>
                <th style={{ textAlign: "left" }}>Ended</th>
                <th style={{ textAlign: "left" }}>Pinned content hash</th>
              </tr>
            </thead>
            <tbody>
              {l.consumedBy.map((c) => (
                <tr key={`${c.runId}-${c.role}`}>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{c.runId}</td>
                  <td style={{ textAlign: "left" }}>{c.role}</td>
                  <td>{c.state}</td>
                  <td style={{ textAlign: "left", fontSize: 12 }}>{c.submittedAt ?? "n/a"}</td>
                  <td style={{ textAlign: "left", fontSize: 12 }}>{c.endedAt ?? "n/a"}</td>
                  <td style={{ textAlign: "left" }}>
                    <Hash value={c.pinnedContentHash} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">
        The pinned hash is what the run recorded at submission; the mirrored hash is the document as
        mirrored. They are displayed side by side, never compared client-side.
      </p>
    </section>
  );
}

// --- Page shell --------------------------------------------------------------

type DataTab = "positions" | "aggregates" | "market" | "runs" | "lineage";

const DATA_TABS: Array<{ key: DataTab; label: string }> = [
  { key: "positions", label: "Positions" },
  { key: "aggregates", label: "Aggregates" },
  { key: "market", label: "Market" },
  { key: "runs", label: "Run inputs" },
  { key: "lineage", label: "Lineage" },
];

function isDataTab(s: string | undefined): s is DataTab {
  return s !== undefined && DATA_TABS.some((t) => t.key === s);
}

/** `initialTab` and `initialMarketId` come from the hash query (`#/data?tab=market&market=<id>`), read once at mount. */
export function DataPage({ initialTab, initialMarketId }: { initialTab?: string; initialMarketId?: string }) {
  const [tab, setTab] = useState<DataTab>(isDataTab(initialTab) ? initialTab : "positions");
  const portfolios = useFetch<CatalogPortfolio[]>(() => listCatalogPortfolios(), []);
  const [portfolioId, setPortfolioId] = useState<string | undefined>(undefined);

  // Default to the first mirrored book so the page opens showing real rows.
  useEffect(() => {
    if (portfolios.status === "ready" && portfolioId === undefined && portfolios.value.length > 0) {
      setPortfolioId(portfolios.value[0].id);
    }
  }, [portfolios, portfolioId]);

  const needsPortfolio = tab === "positions" || tab === "aggregates";

  return (
    <>
      <header className="masthead">
        <h1>Data</h1>
        <div className="sub">
          The platform database: instrument-level positions, yield curves and vol surfaces, and the
          complete resolved input set of every simulation, read through the nine read-only catalog
          endpoints. Every value is a verbatim server read; this page computes nothing.
        </div>
      </header>
      <p className="footnote" style={{ marginTop: 6 }}>{MIRROR_NOTE}</p>

      <div className="controls" style={{ marginTop: 14 }}>
        {DATA_TABS.map((t) => (
          <button key={t.key} className={t.key === tab ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {needsPortfolio ? (
        portfolios.status === "loading" ? (
          <p className="zero">Loading portfolios…</p>
        ) : portfolios.status === "error" ? (
          <ServerMessage title="Catalog not available" message={portfolios.message} />
        ) : (
          <>
            <PortfolioPicker portfolios={portfolios.value} selected={portfolioId} onSelect={setPortfolioId} />
            {portfolioId === undefined ? (
              <p className="emptynote">Select a portfolio.</p>
            ) : tab === "positions" ? (
              <PositionsView key={portfolioId} portfolioId={portfolioId} />
            ) : (
              <AggregatesView key={portfolioId} portfolioId={portfolioId} />
            )}
          </>
        )
      ) : null}

      {tab === "market" ? <MarketView initialSelected={initialMarketId} /> : null}
      {tab === "runs" ? <RunsView /> : null}
      {tab === "lineage" ? <LineageView /> : null}
    </>
  );
}
