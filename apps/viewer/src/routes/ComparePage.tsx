/**
 * Compare route: two stored runs side by side.
 *
 * Honesty rules:
 *  - Every displayed figure is a verbatim envelope field from run A or run B,
 *    rendered through the tested formatters in src/format.ts.
 *  - The ONE permitted client-side computation is the comparison delta B - A,
 *    performed exclusively by deriveDelta in components/DeltaTable.tsx, always
 *    labeled "derived: B - A" and always displayed beside both originals so the
 *    reader can check the subtraction.
 *  - A scenario absent from one run renders an em dash on that side and no
 *    delta; absence is never rendered as zero.
 *  - Equity durations are compared tri-state (value / "n/a (base-only)" /
 *    "flagged") with NO derived delta: a delta between numbers measured under
 *    different duration modes or gate outcomes would not be a like-for-like
 *    subtraction.
 *  - The provenance identity strip states whether the two runs' inputsHash
 *    values are byte-equal (string comparison, labeled); it never claims two
 *    runs are "the same run".
 */
import { useEffect, useMemo, useState } from "react";
import type { GapLadder, RunResult, ScenarioEVE } from "@alm/engine";
import {
  compareCsvUrl,
  getResult,
  getRun,
  listRuns,
  type ExportTable,
  type RunDetail,
  type RunSummary,
  type ScenarioMeta,
} from "@alm/reader";
import { formatScenarioLabel, signedMM, signedPct, usdMM, years } from "@alm/reader";
import { DeltaTable, type DeltaRow } from "../components/DeltaTable";
import { errorText } from "./ResultsPage";

type LoadedRun = { detail: RunDetail; result: RunResult };

type SideState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; run: LoadedRun };

function useRun(runId: string | undefined): SideState {
  const [state, setState] = useState<SideState>({ status: "idle" });
  useEffect(() => {
    if (!runId) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    Promise.all([getRun(runId), getResult(runId)])
      .then(([detail, result]) => live && setState({ status: "ready", run: { detail, result } }))
      .catch((err: unknown) => live && setState({ status: "error", message: errorText(err) }));
    return () => {
      live = false;
    };
  }, [runId]);
  return state;
}

export function ComparePage({ runA: runAProp, runB: runBProp }: { runA?: string; runB?: string }) {
  const [runs, setRuns] = useState<RunSummary[] | undefined>(undefined);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [aId, setAId] = useState<string | undefined>(runAProp);
  const [bId, setBId] = useState<string | undefined>(runBProp);

  useEffect(() => {
    let live = true;
    listRuns()
      .then((r) => live && setRuns(r))
      .catch((err: unknown) => live && setListError(errorText(err)));
    return () => {
      live = false;
    };
  }, []);

  const a = useRun(aId);
  const b = useRun(bId);

  return (
    <div className="app">
      <header className="masthead">
        <h1>Compare</h1>
        <div className="sub">
          Two stored runs side by side. Every figure is a verbatim envelope value; the only client-side
          arithmetic is the delta column, labeled &ldquo;derived: B - A&rdquo; and shown beside both
          originals.
        </div>
      </header>

      <section className="panel">
        <h2>Pick two runs</h2>
        {listError !== undefined ? (
          <p className="desc">
            Run listing unavailable: <code>{listError}</code>
          </p>
        ) : runs === undefined ? (
          <p className="desc">Loading run list…</p>
        ) : (
          <>
            <div className="controls">
              {/* Stochastic runs are excluded from the pickers, not grayed:
                  a distribution envelope has no deterministic sections to
                  compare and every deterministic read on it is refused typed.
                  A control never appears for a capability the engine refuses. */}
              <RunSelect label="Run A" runs={runs.filter((r) => r.mode !== "stochastic")} value={aId} onChange={setAId} />
              <RunSelect label="Run B" runs={runs.filter((r) => r.mode !== "stochastic")} value={bId} onChange={setBId} />
            </div>
            {runs.some((r) => r.mode === "stochastic") ? (
              <p className="footnote">
                Stochastic runs are not offered here: their result is a Monte Carlo distribution envelope
              , and a delta between a distribution statistic and a deterministic figure would not
                be a like-for-like subtraction. Read them on the Results page.
              </p>
            ) : null}
          </>
        )}
      </section>

      <SideStatus label="Run A" id={aId} state={a} />
      <SideStatus label="Run B" id={bId} state={b} />

      {a.status === "ready" && b.status === "ready" && (
        <CompareReport aId={aId!} bId={bId!} a={a.run} b={b.run} />
      )}
    </div>
  );
}

function RunSelect({
  label,
  runs,
  value,
  onChange,
}: {
  label: string;
  runs: RunSummary[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  return (
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
      <span style={{ color: "var(--muted)" }}>{label}:</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">— select —</option>
        {runs.map((r) => (
          <option key={r.runId} value={r.runId}>
            {r.label ? `${r.label} (${r.runId})` : r.runId}
            {r.state !== "done" ? ` — ${r.state}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function SideStatus({ label, id, state }: { label: string; id: string | undefined; state: SideState }) {
  if (state.status === "idle" || state.status === "ready") return null;
  if (state.status === "loading") return <p className="emptynote">{label}: loading {id}…</p>;
  return (
    <section className="panel">
      <h2>{label}: result not available</h2>
      <p className="desc">
        The platform returned the following for run <code>{id}</code>, verbatim:
      </p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{state.message}</pre>
    </section>
  );
}

// --- The comparison report ---------------------------------------------------

/** Ordered union of scenario ids: A's order first, then B-only ids in B's order. */
function scenarioUnion(a: RunResult, b: RunResult): string[] {
  const ids = a.eve.byScenario.map((s) => s.scenarioId);
  for (const s of b.eve.byScenario) {
    if (!ids.includes(s.scenarioId)) ids.push(s.scenarioId);
  }
  return ids;
}

function CompareReport({ aId, bId, a, b }: { aId: string; bId: string; a: LoadedRun; b: LoadedRun }) {
  const labelFor = useMemo(() => {
    const m = new Map<string, ScenarioMeta>();
    for (const s of b.detail.scenarios) m.set(s.id, s);
    for (const s of a.detail.scenarios) m.set(s.id, s); // A's metadata wins on collision
    return (id: string) => formatScenarioLabel(m.get(id), id);
  }, [a.detail, b.detail]);

  const ids = scenarioUnion(a.result, b.result);
  const aName = a.detail.label ?? aId;
  const bName = b.detail.label ?? bId;

  // Rows are joined by scenario id — the only honest identity (a display label
  // derived from the rateSpec does not prove two scenarios are the same
  // scenario: they may bind different assumption sets or new business). When
  // the two runs' slates use different id conventions for the same shock
  // (e.g. SM100 vs S-100, which the two seeded slates do), the union carries
  // BOTH ids, each present on one side only, so a label can appear on two rows
  // with crosswise em dashes and no delta. That is disclosed below rather than
  // silently joined by label, which would fabricate a comparison the engine
  // did not declare like-for-like. Label counting is presentation, not
  // result arithmetic.
  const labelCounts = new Map<string, number>();
  for (const id of ids) {
    const l = labelFor(id);
    labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
  }
  const duplicateLabels = [...labelCounts.entries()].filter(([, n]) => n > 1).map(([l]) => l);

  const eveOf = (r: RunResult, id: string): ScenarioEVE | undefined =>
    r.eve.byScenario.find((s) => s.scenarioId === id);
  const niiOf = (r: RunResult, id: string) => r.nii.byScenario.find((s) => s.scenarioId === id);

  const scenarioRows = (
    pick: (r: RunResult, id: string) => number | undefined,
    format: (n: number) => string,
    formatDelta?: (n: number) => string,
  ): DeltaRow[] =>
    ids.map((id) => ({
      key: id,
      label: labelFor(id),
      a: pick(a.result, id),
      b: pick(b.result, id),
      format,
      formatDelta,
    }));

  const [gapScenario, setGapScenario] = useState<string>(ids[0] ?? "S0");

  return (
    <>
      <IdentityStrip aName={aName} bName={bName} a={a.result} b={b.result} />

      {duplicateLabels.length > 0 ? (
        <section className="panel">
          <h2>Scenario row matching</h2>
          <p className="desc">
            Rows below are matched by <strong>scenario id</strong>, never by display label. These two
            runs&rsquo; slates use different scenario ids for the same shock label
            ({duplicateLabels.join(", ")}), so that label appears on two rows — one per run, each with an
            em dash on the other side and no derived delta. A join by label would fabricate a comparison
            between scenarios the engine did not declare identical (they may bind different assumption
            sets or new-business rules).
          </p>
        </section>
      ) : null}

      <section className="panel">
        <h2>EVE</h2>
        <p className="desc">
          Per scenario, both runs, discount basis A: {a.result.eve.discountBasis} / B:{" "}
          {b.result.eve.discountBasis}. Originals verbatim; the delta column is derived client-side as B
          minus A.
        </p>
        <DeltaTable
          rowHeader="Scenario — EVE"
          aLabel={aName}
          bLabel={bName}
          rows={scenarioRows((r, id) => eveOf(r, id)?.eve, usdMM, signedMM)}
        />
        <DeltaTable
          rowHeader="Scenario — Δ EVE vs base"
          aLabel={aName}
          bLabel={bName}
          rows={scenarioRows((r, id) => eveOf(r, id)?.deltaEveVsBase, signedMM)}
        />
        <DeltaTable
          rowHeader="Scenario — Δ EVE %"
          aLabel={aName}
          bLabel={bName}
          rows={scenarioRows((r, id) => eveOf(r, id)?.deltaEvePct, signedPct)}
          footnote={
            <>
              &Delta; EVE % is stored by the engine as a decimal fraction of base EVE and multiplied by 100
              for display only. The derived column is the difference of the two stored fractions, shown in
              percentage points.
            </>
          }
        />
        <DurationCompare aName={aName} bName={bName} ids={ids} labelFor={labelFor} a={a.result} b={b.result} />
      </section>

      <section className="panel">
        <h2>NII</h2>
        <p className="desc">Engine scenario totals, verbatim; never client-side sums of family rows.</p>
        <DeltaTable
          rowHeader="Scenario — net 12M"
          aLabel={aName}
          bLabel={bName}
          rows={scenarioRows((r, id) => niiOf(r, id)?.totalNet12, signedMM)}
        />
        <DeltaTable
          rowHeader="Scenario — net 24M"
          aLabel={aName}
          bLabel={bName}
          rows={scenarioRows((r, id) => niiOf(r, id)?.totalNet24, signedMM)}
        />
      </section>

      <section className="panel">
        <h2>Gap ladders — cumulative gap</h2>
        <p className="desc">
          Cumulative gap per band as the engine computed it (the running sum is an envelope field, not a
          client-side accumulation). Bands are matched by label; a band present in only one run shows an em
          dash and no delta.
        </p>
        <div className="controls">
          <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 12, marginRight: 4 }}>
            Scenario:
          </span>
          {ids.map((s) => (
            <button key={s} className={s === gapScenario ? "active" : ""} onClick={() => setGapScenario(s)}>
              {labelFor(s)}
            </button>
          ))}
        </div>
        <GapCompare
          title="Repricing gap"
          aName={aName}
          bName={bName}
          aLadders={a.result.gap.repricing}
          bLadders={b.result.gap.repricing}
          scenarioId={gapScenario}
        />
        <GapCompare
          title="Liquidity gap"
          aName={aName}
          bName={bName}
          aLadders={a.result.gap.liquidity}
          bLadders={b.result.gap.liquidity}
          scenarioId={gapScenario}
        />
      </section>

      <section className="panel">
        <h2>Export comparison</h2>
        <p className="desc">
          Aligned CSV per table for these two runs, from the server. Delta columns are labeled derived; header
          rows carry both runIds and inputsHashes.
        </p>
        <ul>
          {COMPARE_TABLES.map((t) => (
            <li key={t}>
              <a href={compareCsvUrl(aId, bId, t)}>compare {t}.csv</a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const COMPARE_TABLES: ExportTable[] = [
  "nii",
  "eve",
  "repricing-gap",
  "liquidity-gap",
  "attribution",
  "cashflows",
];

function IdentityStrip({
  aName,
  bName,
  a,
  b,
}: {
  aName: string;
  bName: string;
  a: RunResult;
  b: RunResult;
}) {
  const sameInputs = a.provenance.inputsHash === b.provenance.inputsHash;
  return (
    <section className="panel">
      <h2>Provenance identity</h2>
      <p className="desc">
        Byte-equality of the two runs&rsquo; input hashes, stated so a &ldquo;why did the number move&rdquo;
        question starts from whether the inputs moved. Note: engine-context fields (durationMode, shards) sit
        outside inputsHash, so equal hashes do not prove identical requests.
      </p>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>A: {aName}</th>
              <th>B: {bName}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Run id</td>
              <td className="num">
                <code>{a.provenance.runId}</code>
              </td>
              <td className="num">
                <code>{b.provenance.runId}</code>
              </td>
            </tr>
            <tr>
              <td>
                Inputs hash{" "}
                {sameInputs ? (
                  <span className="muted">(identical)</span>
                ) : (
                  <span className="flag">(different)</span>
                )}
              </td>
              <td className="num">
                <code>{a.provenance.inputsHash}</code>
              </td>
              <td className="num">
                <code>{b.provenance.inputsHash}</code>
              </td>
            </tr>
            <tr>
              <td>Schema</td>
              <td className="num">{a.schemaVersion}</td>
              <td className="num">{b.schemaVersion}</td>
            </tr>
            <tr>
              <td>Engine</td>
              <td className="num">{a.provenance.engineVersion}</td>
              <td className="num">{b.provenance.engineVersion}</td>
            </tr>
            <tr>
              <td>Assumption sets</td>
              <td className="num">
                {a.provenance.assumptionSets.map((s) => `${s.id} (${s.hash.slice(0, 12)}…)`).join(", ")}
              </td>
              <td className="num">
                {b.provenance.assumptionSets.map((s) => `${s.id} (${s.hash.slice(0, 12)}…)`).join(", ")}
              </td>
            </tr>
            <tr>
              <td>Seed</td>
              <td className="num">{a.provenance.seed}</td>
              <td className="num">{b.provenance.seed}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Equity effective durations, tri-state, no derived delta. "n/a (base-only)"
 * (not computed under base-only durationMode) and "flagged" (sanity
 * gate rejected) are different states; neither is a value, so no subtraction is
 * offered across them. This mirrors the v1 EveTable rendering exactly.
 */
function DurationCompare({
  aName,
  bName,
  ids,
  labelFor,
  a,
  b,
}: {
  aName: string;
  bName: string;
  ids: string[];
  labelFor: (id: string) => string;
  a: RunResult;
  b: RunResult;
}) {
  const cell = (s: ScenarioEVE | undefined) => {
    if (!s) return <>—</>;
    if (s.durationSanityPassed && s.effectiveDurationEquity !== undefined)
      return <>{years(s.effectiveDurationEquity)}</>;
    if (s.durationSanityPassed)
      return (
        <span
          className="muted"
          title="Not computed: base-only durationMode measures durations at the base environment only. Not a rejected value."
        >
          n/a (base-only)
        </span>
      );
    return (
      <span className="flag" title="Duration sanity gate did not pass; value not trusted">
        flagged
      </span>
    );
  };
  return (
    <div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Scenario — eff. dur. equity</th>
              <th>A: {aName}</th>
              <th>B: {bName}</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => (
              <tr key={id}>
                <td>{labelFor(id)}</td>
                <td className="num">{cell(a.eve.byScenario.find((s) => s.scenarioId === id))}</td>
                <td className="num">{cell(b.eve.byScenario.find((s) => s.scenarioId === id))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="footnote">
        No derived column here: durations under different duration modes or gate outcomes are not
        like-for-like, and a delta against &ldquo;n/a&rdquo; or &ldquo;flagged&rdquo; would fabricate a
        comparison the engine did not make.
      </p>
    </div>
  );
}

function GapCompare({
  title,
  aName,
  bName,
  aLadders,
  bLadders,
  scenarioId,
}: {
  title: string;
  aName: string;
  bName: string;
  aLadders: GapLadder[];
  bLadders: GapLadder[];
  scenarioId: string;
}) {
  const la = aLadders.find((l) => l.scenarioId === scenarioId);
  const lb = bLadders.find((l) => l.scenarioId === scenarioId);
  if (!la && !lb) return <p className="emptynote">{title}: neither run carries this scenario.</p>;

  // Band rows: A's band order first, then any B-only bands in B's order.
  const labels = (la?.rows ?? []).map((r) => r.band.label);
  for (const r of lb?.rows ?? []) {
    if (!labels.includes(r.band.label)) labels.push(r.band.label);
  }
  const rows: DeltaRow[] = labels.map((band) => ({
    key: band,
    label: band,
    a: la?.rows.find((r) => r.band.label === band)?.cumulativeGap,
    b: lb?.rows.find((r) => r.band.label === band)?.cumulativeGap,
    format: signedMM,
  }));

  return (
    <div style={{ marginTop: 8 }}>
      <p className="desc">{title}</p>
      <DeltaTable rowHeader="Band — cumulative gap" aLabel={aName} bLabel={bName} rows={rows} />
    </div>
  );
}
