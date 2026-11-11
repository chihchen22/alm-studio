/**
 * Instrument route (harness Plane 5): the single-instrument drill.
 *
 * Take ONE position, from a stored book or hand-typed, and see the monthly
 * schedule the kernel produces for it under a scenario: the rate it saw, the
 * balance, the principal, the interest, the payment, and what that schedule is
 * worth. Nothing here is stored, so there is no run to poll.
 *
 * THE PAGE COMPUTES NOTHING. Every number rendered is a number the server sent.
 * The CSV is the received rows joined with commas; the chart scales received
 * numbers to pixels, which is the only arithmetic on this page, and it is
 * presentation. An absent WAL or duration renders "n/a" with the reason, never
 * a zero. An error renders the server's message verbatim.
 *
 * THE TYPED FORM covers "fixed-loan" and "floating-loan", whose terms are
 * entirely scalar. The other four types (mortgage, nmd, nmd-b, cd) carry a
 * calibrated parameter set or a cohort table that a hand form would have to
 * invent, so they are drilled by picking them from a book, where the parameters
 * come from the book. The ROUTE accepts all six; this is a form limit.
 *
 * THE OVERLAY IS THE SELECT ON THIS PAGE, and only that. The drill route reads
 * the assumption set named in the body; a stored slate's per-scenario
 * assumptionSetId is not looked up here, so every scenario in a slate is
 * projected under the one set this page names, or contractually under none.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  getPortfolio,
  listAssumptionSets,
  listMarket,
  listPortfolios,
  listScenarioSlates,
  projectInstrument,
  type AssumptionSetListItem,
  type InstrumentDrill,
  type InstrumentScenarioProjectionView,
  type InstrumentScheduleRowView,
  type MarketListItem,
  type PortfolioListItem,
  type ProjectInstrumentRequest,
  type ScenarioSlate,
} from "@alm/reader";
import { legTables } from "@alm/reader";
import { pct, usd } from "@alm/reader";

type Source = "book" | "typed";
type ScenarioMode = "slate" | "inline";
type TypedType = "fixed-loan" | "floating-loan";

interface Found {
  familyId: string;
  type: string;
  notional: number;
  label: string;
}

const ROW = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 } as const;
const LABEL = { fontSize: 12, color: "var(--muted)", marginRight: 4 } as const;

export function InstrumentPage() {
  const [source, setSource] = useState<Source>("book");
  const [scenarioMode, setScenarioMode] = useState<ScenarioMode>("slate");

  const [books, setBooks] = useState<PortfolioListItem[]>([]);
  const [markets, setMarkets] = useState<MarketListItem[]>([]);
  const [slates, setSlates] = useState<ScenarioSlate[]>([]);
  const [sets, setSets] = useState<AssumptionSetListItem[]>([]);

  const [portfolioId, setPortfolioId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [found, setFound] = useState<Found | "missing" | undefined>(undefined);

  const [typedType, setTypedType] = useState<TypedType>("fixed-loan");
  const [typedId, setTypedId] = useState("typed-1");
  const [notional, setNotional] = useState("1000000");
  const [maturityMonths, setMaturityMonths] = useState("60");
  const [originationOffsetMonths, setOriginationOffsetMonths] = useState("0");
  const [amortType, setAmortType] = useState<"level-pay" | "bullet">("level-pay");
  const [coupon, setCoupon] = useState("0.06");
  const [margin, setMargin] = useState("0.0125");
  const [resetFrequencyMonths, setResetFrequencyMonths] = useState("3");
  const [familyId, setFamilyId] = useState("typed");
  const [side, setSide] = useState<"asset" | "liability">("asset");

  const [marketId, setMarketId] = useState("");
  const [slateId, setSlateId] = useState("");
  const [shockBp, setShockBp] = useState("0");
  const [assumptionSetId, setAssumptionSetId] = useState("");
  const [horizonMonths, setHorizonMonths] = useState("360");
  const [durationBumpBp, setDurationBumpBp] = useState("100");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [drill, setDrill] = useState<InstrumentDrill | undefined>(undefined);
  const [activeScenario, setActiveScenario] = useState(0);

  useEffect(() => {
    listPortfolios()
      .then((v) => {
        setBooks(v);
        if (v.length > 0) setPortfolioId((cur) => cur || v[0].id);
      })
      .catch(() => setBooks([]));
    listMarket()
      .then((v) => {
        setMarkets(v);
        if (v.length > 0) setMarketId((cur) => cur || v[0].id);
      })
      .catch(() => setMarkets([]));
    listScenarioSlates()
      .then((v) => {
        setSlates(v);
        if (v.length > 0) setSlateId((cur) => cur || v[0].id);
      })
      .catch(() => setSlates([]));
    listAssumptionSets()
      .then(setSets)
      .catch(() => setSets([]));
  }, []);

  const find = useCallback(() => {
    setFound(undefined);
    getPortfolio(portfolioId)
      .then((book) => {
        const p = book.positions.find((x) => x.id === positionId);
        setFound(
          p === undefined
            ? "missing"
            : {
                familyId: p.familyId,
                type: p.terms.type,
                notional: p.terms.notional,
                label: p.terms.label || p.id,
              },
        );
      })
      .catch(() => setFound("missing"));
  }, [portfolioId, positionId]);

  const run = useCallback(() => {
    setBusy(true);
    setError(undefined);
    setDrill(undefined);
    const instrument: ProjectInstrumentRequest["instrument"] =
      source === "book"
        ? { portfolioId, positionId }
        : {
            terms:
              typedType === "fixed-loan"
                ? {
                    id: typedId,
                    type: "fixed-loan",
                    label: typedId,
                    notional: Number(notional),
                    maturityMonths: Number(maturityMonths),
                    originationOffsetMonths: Number(originationOffsetMonths),
                    amortType,
                    coupon: Number(coupon),
                  }
                : {
                    id: typedId,
                    type: "floating-loan",
                    label: typedId,
                    notional: Number(notional),
                    maturityMonths: Number(maturityMonths),
                    originationOffsetMonths: Number(originationOffsetMonths),
                    amortType,
                    indexTenorMonths: 1,
                    margin: Number(margin),
                    resetFrequencyMonths: Number(resetFrequencyMonths),
                  },
            familyId,
            side,
          };
    const body: ProjectInstrumentRequest = {
      instrument,
      marketId,
      scenarios:
        scenarioMode === "slate" ? { scenarioSlateId: slateId } : { parallelShockBp: Number(shockBp) },
      ...(assumptionSetId !== "" ? { assumptionSetId } : {}),
      horizonMonths: Number(horizonMonths),
      durationBumpBp: Number(durationBumpBp),
    };
    projectInstrument(body)
      .then((d) => {
        setDrill(d);
        setActiveScenario(0);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError || err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  }, [
    source,
    portfolioId,
    positionId,
    typedType,
    typedId,
    notional,
    maturityMonths,
    originationOffsetMonths,
    amortType,
    coupon,
    margin,
    resetFrequencyMonths,
    familyId,
    side,
    marketId,
    scenarioMode,
    slateId,
    shockBp,
    assumptionSetId,
    horizonMonths,
    durationBumpBp,
  ]);

  /**
   * Belt and braces with the route's own 400. `Number("")` is 0 and
   * `Number("abc")` is NaN, which JSON serialises to null, and a null the
   * engine reads as "not supplied" would answer on a default horizon the reader
   * never asked for. The button stays disabled rather than sending that.
   */
  const argsAreNumbers =
    horizonMonths.trim() !== "" &&
    durationBumpBp.trim() !== "" &&
    Number.isFinite(Number(horizonMonths)) &&
    Number.isFinite(Number(durationBumpBp));

  const shown = drill?.byScenario[activeScenario];

  return (
    <>
      <section className="panel">
        <h2>Single-instrument drill</h2>
        <p className="desc">
          One position, projected on demand under one or more deterministic scenarios. Nothing is
          stored: there is no run id and no audit trail here. For an auditable record, run a
          one-position book through the plan path.
        </p>

        <div style={ROW}>
          <span style={LABEL}>Source</span>
          <div className="controls" style={{ marginBottom: 0 }}>
            <button className={source === "book" ? "active" : ""} onClick={() => setSource("book")}>
              From a book
            </button>
            <button className={source === "typed" ? "active" : ""} onClick={() => setSource("typed")}>
              Typed
            </button>
          </div>
        </div>

        {source === "book" ? (
          <div style={ROW}>
            <span style={LABEL}>Book</span>
            <select value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)}>
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id} ({b.positionCount} positions)
                </option>
              ))}
            </select>
            <span style={LABEL}>Position id</span>
            <input value={positionId} onChange={(e) => setPositionId(e.target.value)} placeholder="loan-2" />
            <button onClick={find}>Find</button>
            {found === "missing" ? <span className="error" style={{ padding: 0 }}>not found</span> : null}
            {found !== undefined && found !== "missing" ? (
              <span style={{ fontSize: 12 }}>
                {found.label}: family <code>{found.familyId}</code>, type <code>{found.type}</code>,
                notional {usd(found.notional)}
              </span>
            ) : null}
          </div>
        ) : (
          <>
            <div style={ROW}>
              <span style={LABEL}>Type</span>
              <select value={typedType} onChange={(e) => setTypedType(e.target.value as TypedType)}>
                <option value="fixed-loan">fixed-loan</option>
                <option value="floating-loan">floating-loan</option>
              </select>
              <span style={LABEL}>Id</span>
              <input value={typedId} onChange={(e) => setTypedId(e.target.value)} size={12} />
              <span style={LABEL}>Family</span>
              <input value={familyId} onChange={(e) => setFamilyId(e.target.value)} size={12} />
              <span style={LABEL}>Side</span>
              <select value={side} onChange={(e) => setSide(e.target.value as "asset" | "liability")}>
                <option value="asset">asset</option>
                <option value="liability">liability</option>
              </select>
            </div>
            <div style={ROW}>
              <span style={LABEL}>Notional</span>
              <input value={notional} onChange={(e) => setNotional(e.target.value)} size={12} />
              <span style={LABEL}>Maturity (months)</span>
              <input value={maturityMonths} onChange={(e) => setMaturityMonths(e.target.value)} size={5} />
              <span style={LABEL}>Origination offset</span>
              <input
                value={originationOffsetMonths}
                onChange={(e) => setOriginationOffsetMonths(e.target.value)}
                size={4}
              />
              <span style={LABEL}>Amortization</span>
              <select
                value={amortType}
                onChange={(e) => setAmortType(e.target.value as "level-pay" | "bullet")}
              >
                <option value="level-pay">level-pay</option>
                <option value="bullet">bullet</option>
              </select>
              {typedType === "fixed-loan" ? (
                <>
                  <span style={LABEL}>Coupon (decimal)</span>
                  <input value={coupon} onChange={(e) => setCoupon(e.target.value)} size={7} />
                </>
              ) : (
                <>
                  <span style={LABEL}>Margin (decimal)</span>
                  <input value={margin} onChange={(e) => setMargin(e.target.value)} size={7} />
                  <span style={LABEL}>Reset (months)</span>
                  <input
                    value={resetFrequencyMonths}
                    onChange={(e) => setResetFrequencyMonths(e.target.value)}
                    size={4}
                  />
                </>
              )}
            </div>
            <p className="footnote">
              The typed form covers fixed-loan and floating-loan only: mortgages, non-maturity
              deposits and CDs carry a parameter set or a cohort table, so they are
              drilled by picking one from a book rather than typed here.
            </p>
          </>
        )}

        <div style={ROW}>
          <span style={LABEL}>Market</span>
          <select value={marketId} onChange={(e) => setMarketId(e.target.value)}>
            {markets.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.calibrationDate !== undefined ? ` (${m.calibrationDate})` : ""}
              </option>
            ))}
          </select>
          <span style={LABEL}>Scenarios</span>
          <div className="controls" style={{ marginBottom: 0 }}>
            <button
              className={scenarioMode === "slate" ? "active" : ""}
              onClick={() => setScenarioMode("slate")}
            >
              Stored slate
            </button>
            <button
              className={scenarioMode === "inline" ? "active" : ""}
              onClick={() => setScenarioMode("inline")}
            >
              Single parallel shock
            </button>
          </div>
          {scenarioMode === "slate" ? (
            <select value={slateId} onChange={(e) => setSlateId(e.target.value)}>
              {slates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} ({s.scenarios.length})
                </option>
              ))}
            </select>
          ) : (
            <>
              <input value={shockBp} onChange={(e) => setShockBp(e.target.value)} size={5} />
              <span style={LABEL}>bp</span>
            </>
          )}
        </div>

        <div style={ROW}>
          <span style={LABEL}>Overlay</span>
          <select value={assumptionSetId} onChange={(e) => setAssumptionSetId(e.target.value)}>
            <option value="">none (contractual)</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <span style={LABEL}>Horizon (months)</span>
          <input value={horizonMonths} onChange={(e) => setHorizonMonths(e.target.value)} size={5} />
          <span style={LABEL}>Duration bump (bp)</span>
          <input value={durationBumpBp} onChange={(e) => setDurationBumpBp(e.target.value)} size={5} />
          <button
            onClick={run}
            disabled={busy || !argsAreNumbers}
            title={
              argsAreNumbers
                ? ""
                : "Horizon and duration bump must each be a number before a drill can be sent"
            }
          >
            {busy ? "Projecting…" : "Project"}
          </button>
        </div>
        <p className="footnote">
          This select is the only assumption set that applies: a stored slate's per-scenario
          assumptionSetId is ignored here, so every scenario in the slate is drilled under the set
          named above.
        </p>

        {error !== undefined ? (
          <p className="error" style={{ padding: 0 }}>
            {error}
          </p>
        ) : null}
      </section>

      {drill !== undefined && shown !== undefined ? (
        <DrillResult
          drill={drill}
          shown={shown}
          activeScenario={activeScenario}
          onSelect={setActiveScenario}
        />
      ) : null}
    </>
  );
}

// --- Result ------------------------------------------------------------------

function DrillResult({
  drill,
  shown,
  activeScenario,
  onSelect,
}: {
  drill: InstrumentDrill;
  shown: InstrumentScenarioProjectionView;
  activeScenario: number;
  onSelect: (i: number) => void;
}) {
  const csvHref = useMemo(() => {
    const header = "month,pathRate,couponRate,balance,principal,interest,payment";
    const lines = shown.rows.map((r) =>
      [r.month, r.pathRate, r.couponRate, r.balance, r.principal, r.interest, r.payment].join(","),
    );
    return URL.createObjectURL(new Blob([`${[header, ...lines].join("\n")}\n`], { type: "text/csv" }));
  }, [shown]);

  // A blob URL pins its Blob in memory until it is revoked. Every scenario tab
  // and every new projection mints another one, so without this the page leaks
  // one schedule's worth of CSV per click for as long as the tab stays open.
  useEffect(() => {
    return () => URL.revokeObjectURL(csvHref);
  }, [csvHref]);

  return (
    <section className="panel">
      <h2>
        {drill.terms.id} ({drill.terms.type}), family <code>{drill.familyId}</code>, {drill.side}
      </h2>
      <p className="desc">
        Market <code>{drill.marketId}</code>, scenarios from <code>{drill.scenarioSource}</code>,
        horizon {drill.horizonMonths} months, duration measured at a plus and minus{" "}
        {drill.durationBumpBp} bp parallel bump of each scenario's own curve. Overlay applied:{" "}
        <code>{drill.overlayApplied}</code>. One instrument, not a family: this duration omits the
        non-interest-bearing deposit warmup re-leveling a run's family duration applies.
      </p>

      <div className="controls">
        {drill.byScenario.map((p, i) => (
          <button key={p.scenarioId} className={i === activeScenario ? "active" : ""} onClick={() => onSelect(i)}>
            {p.scenarioId}
          </button>
        ))}
      </div>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Scenario</th>
              <th>PV all-in</th>
              <th>PV risk-free</th>
              <th>WAL (months)</th>
              <th>Effective duration</th>
              <th>Resets</th>
            </tr>
          </thead>
          <tbody>
            {drill.byScenario.map((p) => (
              <tr key={p.scenarioId}>
                <td style={{ textAlign: "left", fontFamily: "var(--mono)" }}>{p.scenarioId}</td>
                <td>{usd(p.pvAllIn)}</td>
                <td>{usd(p.pvRiskFree)}</td>
                <td title={p.walMonths === undefined ? "no in-horizon principal to weight" : ""}>
                  {p.walMonths === undefined ? "n/a" : p.walMonths.toFixed(1)}
                </td>
                <td
                  title={
                    p.effectiveDuration === undefined
                      ? "base PV is zero"
                      : p.durationBasis === "notional"
                        ? "per unit of notional: a swap near par has no PV to divide by"
                        : ""
                  }
                >
                  {p.effectiveDuration === undefined ? "n/a" : p.effectiveDuration.toFixed(3)}
                </td>
                <td>{p.repricingMonths.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ScheduleChart rows={shown.rows} />

      <p style={{ margin: "10px 0" }}>
        <a href={csvHref} download={`${drill.terms.id}-${shown.scenarioId}.csv`}>
          Download CSV
        </a>{" "}
        <span className="footnote">({shown.rows.length} rows, exactly as served)</span>
      </p>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Month</th>
              <th>Path rate</th>
              <th>Coupon</th>
              <th>Balance</th>
              <th>Principal</th>
              <th>Interest</th>
              <th>Payment</th>
            </tr>
          </thead>
          <tbody>
            {shown.rows.map((r) => (
              <tr key={r.month}>
                <td style={{ textAlign: "left" }}>{r.month}</td>
                <td>{pct(r.pathRate, 3)}</td>
                <td>{pct(r.couponRate, 3)}</td>
                <td>{usd(r.balance)}</td>
                <td>{usd(r.principal)}</td>
                <td>{usd(r.interest)}</td>
                <td>{usd(r.payment)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {legTables(shown).map((t) => (
        <div className="tablewrap" key={t.leg}>
          <h3>{t.leg === "receive" ? "Receive leg" : "Pay leg"} ({t.rows.length} rows, signed as served)</h3>
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Month</th>
                <th>Coupon</th>
                <th>Balance</th>
                <th>Principal</th>
                <th>Interest</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.month}>
                  <td style={{ textAlign: "left" }}>{r.month}</td>
                  <td>{pct(r.couponRate, 3)}</td>
                  <td>{usd(r.balance)}</td>
                  <td>{usd(r.principal)}</td>
                  <td>{usd(r.interest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

/**
 * Balance and path rate on one inline SVG, two independent vertical scales, no
 * chart library. The only arithmetic is pixels: each series is scaled to its own
 * min and max, which is presentation and not a computed financial number.
 */
function ScheduleChart({ rows }: { rows: InstrumentScheduleRowView[] }) {
  if (rows.length < 2) return null;
  const W = 720;
  const H = 200;
  const PAD = 28;
  const xs = (i: number) => PAD + (i * (W - 2 * PAD)) / (rows.length - 1);
  const scale = (vals: number[]) => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo === 0 ? 1 : hi - lo;
    return (v: number) => H - PAD - ((v - lo) / span) * (H - 2 * PAD);
  };
  const yBal = scale(rows.map((r) => r.balance));
  const yRate = scale(rows.map((r) => r.pathRate));
  const path = (y: (v: number) => number, pick: (r: InstrumentScheduleRowView) => number) =>
    rows.map((r, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)},${y(pick(r)).toFixed(1)}`).join(" ");

  return (
    <div style={{ margin: "12px 0" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Balance and path rate by month">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line)" />
        <path d={path(yBal, (r) => r.balance)} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
        <path
          d={path(yRate, (r) => r.pathRate)}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <text x={PAD} y={14} fontSize={11} fill="var(--accent)">
          balance
        </text>
        <text x={PAD + 60} y={14} fontSize={11} fill="var(--ink)">
          path rate (dashed)
        </text>
        <text x={PAD} y={H - 8} fontSize={10} fill="var(--muted)">
          month {rows[0].month}
        </text>
        <text x={W - PAD - 50} y={H - 8} fontSize={10} fill="var(--muted)">
          month {rows[rows.length - 1].month}
        </text>
      </svg>
      <p className="footnote">
        Each series is scaled to its own range; the two vertical axes are independent.
      </p>
    </div>
  );
}
