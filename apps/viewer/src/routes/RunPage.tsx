/**
 * Run cockpit (design Sections 4.1 and 4.3): pick portfolio, market snapshot,
 * scenario slate, and assumption sets; see the show-before-run gate; submit;
 * watch the queue over SSE.
 *
 * THE GATE IS THE PRODUCT. A candidate assumption set is compiled, diffed
 * against the baseline, and SHOWN before it runs: whenever any selected set's
 * contentHash differs from the baseline's, Submit stays disabled until the
 * diff for that exact pairing (keyed by both content hashes) has been fetched
 * from the server's diff endpoint and rendered. An empty diff renders as "no
 * parameter changes versus base", which is itself information. This is the
 * safety mechanism that makes assumption authoring defensible; it is a hard
 * UI invariant, not a nicety.
 *
 * Baseline rule (design 4.3 step 1): the assumption set of the selected
 * portfolio's most recent completed run, else the seeded demo base set.
 *
 * Progress renders phases exactly as received from the four-phase seam; no
 * synthetic percent bar exists anywhere on this page (design 3.4).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AssumptionDiff, AssumptionSet, StochasticModel } from "@alm/engine";
import {
  ApiError,
  diffAssumptionSets,
  getAssumptionSet,
  listAssumptionSets,
  listMarket,
  listPortfolios,
  listRuns,
  listScenarioSlates,
  submitRun,
  type AssumptionSetListItem,
  type MarketListItem,
  type PortfolioListItem,
  type RunSummary,
  type ScenarioSlate,
  type SubmitRunBody,
} from "@alm/reader";
import { subscribeRunEvents, type RunEvent } from "@alm/reader";
import { RunCard } from "../components/RunCard";
import { ShowBeforeRunDiff } from "../components/ShowBeforeRunDiff";
import { stochasticBodyOf } from "../stochasticBody";

/** Seeded demo base set id (data/src/demo/request.ts DEMO_ASSUMPTION_SET_ID). */
const DEMO_BASE_SET_ID = "demo-behavioral-v1";

/** A gate pairing key: both content hashes, so an edit invalidates its own approval. */
function pairingKey(baseId: string, baseHash: string, candId: string, candHash: string): string {
  return `${baseId}:${baseHash}->${candId}:${candHash}`;
}

export function RunPage() {
  // --- Store listings --------------------------------------------------------
  const [portfolios, setPortfolios] = useState<PortfolioListItem[]>([]);
  const [markets, setMarkets] = useState<MarketListItem[]>([]);
  const [slates, setSlates] = useState<ScenarioSlate[]>([]);
  const [sets, setSets] = useState<AssumptionSetListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- Cockpit selection -----------------------------------------------------
  const [portfolioId, setPortfolioId] = useState("");
  const [marketId, setMarketId] = useState("");
  const [slateId, setSlateId] = useState("");
  const [selectedSetIds, setSelectedSetIds] = useState<string[]>([]);
  const [durationMode, setDurationMode] = useState<"base-only" | "per-scenario">("base-only");
  const [shards, setShards] = useState<"auto" | 1>("auto");
  // Run mode: the stochastic arm is a landed platform capability.
  // Deterministic-only options (durationMode, shards) are hidden in
  // stochastic mode — a control must not appear for something that mode does
  // not compute — and the server's 202 cost note is echoed verbatim below.
  const [mode, setMode] = useState<"deterministic" | "stochastic">("deterministic");
  const [nPaths, setNPaths] = useState(256);
  // Rate model: Hull-White 1F by default. The submit body
  // writes `model` only for BGM, so a Hull-White post stores no model key, as before the slice.
  const [rateModel, setRateModel] = useState<StochasticModel>("hull-white-1f");
  const [costNote, setCostNote] = useState<string | null>(null);

  // --- Gate state ------------------------------------------------------------
  const [renderedPairings, setRenderedPairings] = useState<Set<string>>(new Set());
  const [openDiff, setOpenDiff] = useState<{
    pairing: string;
    baseSet: AssumptionSet;
    candidateSet: AssumptionSet;
    diff: AssumptionDiff;
  } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  // --- Queue -----------------------------------------------------------------
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refreshRuns = useCallback(() => {
    listRuns()
      .then(setRuns)
      .catch(() => {
        /* the queue list is refreshed opportunistically; the next SSE event retries */
      });
  }, []);

  useEffect(() => {
    Promise.all([listPortfolios(), listMarket(), listScenarioSlates(), listAssumptionSets()])
      .then(([p, m, sl, st]) => {
        setPortfolios(p);
        setMarkets(m);
        setSlates(sl);
        setSets(st);
      })
      .catch((err: unknown) => {
        setLoadError(
          err instanceof ApiError
            ? `${err.code}: ${err.message}`
            : `Platform server unreachable (${String(err)}). Start it with: npm run platform`,
        );
      });
    refreshRuns();
  }, [refreshRuns]);

  // SSE: subscribe to every non-terminal run; fold events into the local list.
  // Keyed by the joined id list so the effect re-runs only when the ACTIVE ids
  // change, not on every status fold (ids are [A-Za-z0-9._-] by store contract,
  // so the comma join is unambiguous).
  const activeKey = useMemo(
    () =>
      runs
        .filter((r) => r.state === "queued" || r.state === "running")
        .map((r) => r.runId)
        .join(","),
    [runs],
  );
  useEffect(() => {
    const activeRunIds = activeKey === "" ? [] : activeKey.split(",");
    const unsubs = activeRunIds.map((runId) =>
      subscribeRunEvents(runId, {
        onEvent: (event: RunEvent) => {
          if (event.t === "phase") {
            setRuns((prev) => prev.map((r) => (r.runId === runId ? { ...r, phase: event.phase } : r)));
          } else if (event.t === "status") {
            setRuns((prev) => prev.map((r) => (r.runId === runId ? { ...r, ...event.status } : r)));
            const state = event.status.state;
            if (state === "done" || state === "error" || state === "cancelled" || state === "interrupted") {
              refreshRuns();
            }
          }
          // log lines are not rendered in the cockpit; the run detail store keeps them
        },
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [activeKey, refreshRuns]);

  // --- Baseline (design 4.3 step 1) -----------------------------------------
  const baseline: AssumptionSetListItem | null = useMemo(() => {
    if (sets.length === 0) return null;
    const completed = runs
      .filter((r) => r.state === "done" && r.refs?.portfolioId === portfolioId)
      .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
    const fromRun = completed[0]?.refs?.assumptionSetIds?.[0];
    const byId = (id: string) => sets.find((s) => s.id === id) ?? null;
    if (fromRun) {
      const found = byId(fromRun);
      if (found) return found;
    }
    return byId(DEMO_BASE_SET_ID) ?? sets[0] ?? null;
  }, [runs, sets, portfolioId]);

  // --- Gate evaluation -------------------------------------------------------
  const selectedSets = selectedSetIds
    .map((id) => sets.find((s) => s.id === id))
    .filter((s): s is AssumptionSetListItem => s !== undefined);

  const pendingPairings = baseline
    ? selectedSets
        .filter((s) => s.contentHash !== baseline.contentHash)
        .map((s) => ({ set: s, key: pairingKey(baseline.id, baseline.contentHash, s.id, s.contentHash) }))
        .filter((p) => !renderedPairings.has(p.key))
    : [];

  const gateSatisfied = baseline !== null && pendingPairings.length === 0;
  const selectionComplete =
    portfolioId !== "" && marketId !== "" && slateId !== "" && selectedSetIds.length > 0;
  const canSubmit = selectionComplete && gateSatisfied && !submitting;

  // Mark a pairing rendered only AFTER its diff has actually been committed to
  // the screen (the openDiff panel below renders it in the same pass).
  useEffect(() => {
    if (!openDiff) return;
    setRenderedPairings((prev) => {
      if (prev.has(openDiff.pairing)) return prev;
      const next = new Set(prev);
      next.add(openDiff.pairing);
      return next;
    });
  }, [openDiff]);

  async function showDiff(candidate: AssumptionSetListItem) {
    if (!baseline) return;
    setDiffBusy(true);
    setDiffError(null);
    try {
      const [diff, baseSet, candidateSet] = await Promise.all([
        diffAssumptionSets({ baseId: baseline.id, candidateId: candidate.id }),
        getAssumptionSet(baseline.id),
        getAssumptionSet(candidate.id),
      ]);
      setOpenDiff({
        pairing: pairingKey(baseline.id, baseline.contentHash, candidate.id, candidate.contentHash),
        baseSet,
        candidateSet,
        diff,
      });
    } catch (err) {
      setDiffError(err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err));
    } finally {
      setDiffBusy(false);
    }
  }

  async function doSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setCostNote(null);
    const body: SubmitRunBody =
      mode === "stochastic"
        ? stochasticBodyOf({
            portfolioId,
            marketId,
            scenarioSlateId: slateId,
            assumptionSetIds: selectedSetIds,
            nPaths,
            model: rateModel,
          })
        : {
            portfolioId,
            marketId,
            scenarioSlateId: slateId,
            assumptionSetIds: selectedSetIds,
            engineOptions: { durationMode, shards },
          };
    try {
      const res = await submitRun(body);
      if (res.stochastic?.costNote) setCostNote(res.stochastic.costNote);
      refreshRuns();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSet(id: string) {
    setSelectedSetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <>
      <section className="panel">
        <h2>Run cockpit</h2>
        <p className="desc">
          Compose a run from stored artifacts. The engine computes in a child process; the platform serves stored
          results verbatim and adds no arithmetic.
        </p>
        {loadError ? <p className="error" style={{ padding: 0 }}>{loadError}</p> : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
          <Picker label="portfolio" value={portfolioId} onChange={setPortfolioId}
            options={portfolios.map((p) => ({ id: p.id, text: `${p.id} (${p.positionCount.toLocaleString("en-US")} pos)` }))} />
          <Picker label="market" value={marketId} onChange={setMarketId}
            options={markets.map((m) => ({ id: m.id, text: m.calibrationDate ? `${m.id} (${m.calibrationDate})` : m.id }))} />
          <Picker label="scenario slate" value={slateId} onChange={setSlateId}
            options={slates.map((s) => ({ id: s.id, text: `${s.id} (${s.scenarios.length} scenarios)` }))} />
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            Assumption sets{" "}
            {baseline ? (
              <span className="zero">
                — baseline for the gate: <code style={{ fontFamily: "var(--mono)" }}>{baseline.id}</code>{" "}
                (hash {baseline.contentHash.slice(0, 12)}…)
              </span>
            ) : (
              <span className="zero">— no sets in the store yet</span>
            )}
          </div>
          {sets.map((s) => {
            const selected = selectedSetIds.includes(s.id);
            const differs = baseline !== null && s.contentHash !== baseline.contentHash;
            const key = baseline ? pairingKey(baseline.id, baseline.contentHash, s.id, s.contentHash) : "";
            const rendered = key !== "" && renderedPairings.has(key);
            return (
              <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "3px 0", fontSize: 13 }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input type="checkbox" checked={selected} onChange={() => toggleSet(s.id)} />
                  <code style={{ fontFamily: "var(--mono)" }}>{s.id}</code>
                  <span className="zero">{s.label}</span>
                </label>
                {selected && differs ? (
                  rendered ? (
                    <span className="flag" style={{ background: "var(--pos)", color: "#fff" }}>diff reviewed</span>
                  ) : (
                    <>
                      <span className="flag">diff required before submit</span>
                      <button style={miniButton} disabled={diffBusy} onClick={() => void showDiff(s)}>
                        show diff vs baseline
                      </button>
                    </>
                  )
                ) : null}
                {selected && !differs && baseline ? (
                  <span className="zero" style={{ fontSize: 12 }}>= baseline content</span>
                ) : null}
              </div>
            );
          })}
          {diffError ? <p className="error" style={{ padding: 0 }}>{diffError}</p> : null}
        </div>

        {openDiff ? (
          <ShowBeforeRunDiff
            sbr={{
              baseSet: openDiff.baseSet,
              candidateSet: openDiff.candidateSet,
              diff: openDiff.diff,
              rationale: "hand-authored edit",
            }}
            familyLabel={(id) => id}
          />
        ) : null}

        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
          <label style={{ fontSize: 13 }}>
            <span className="zero" style={{ marginRight: 6 }}>mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "deterministic" | "stochastic")}
              style={fieldStyle}
            >
              <option value="deterministic">deterministic (grid)</option>
              <option value="stochastic">stochastic (Monte Carlo distribution)</option>
            </select>
          </label>
          {mode === "deterministic" ? (
            <>
              <label style={{ fontSize: 13 }}>
                <span className="zero" style={{ marginRight: 6 }}>duration mode</span>
                <select
                  value={durationMode}
                  onChange={(e) => setDurationMode(e.target.value as "base-only" | "per-scenario")}
                  style={fieldStyle}
                >
                  <option value="base-only">base-only (default)</option>
                  <option value="per-scenario">per-scenario (slow)</option>
                </select>
              </label>
              <label style={{ fontSize: 13 }}>
                <span className="zero" style={{ marginRight: 6 }}>shards</span>
                <select
                  value={String(shards)}
                  onChange={(e) => setShards(e.target.value === "auto" ? "auto" : 1)}
                  style={fieldStyle}
                >
                  <option value="auto">auto (workers)</option>
                  <option value="1">1 (single-thread)</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label style={{ fontSize: 13 }}>
                <span className="zero" style={{ marginRight: 6 }}>rate model</span>
                <select
                  value={rateModel}
                  onChange={(e) => setRateModel(e.target.value as StochasticModel)}
                  style={fieldStyle}
                >
                  <option value="hull-white-1f">Hull-White 1F (default)</option>
                  <option value="bgm-lmm-2f">BGM (shifted-CEV LMM, Rebonato 2F)</option>
                </select>
              </label>
              <label style={{ fontSize: 13 }}>
                <span className="zero" style={{ marginRight: 6 }}>paths (N)</span>
                <input
                  type="number"
                  value={nPaths}
                  min={20}
                  step={2}
                  onChange={(e) => setNPaths(Number(e.target.value))}
                  style={{ ...fieldStyle, width: 90 }}
                />
              </label>
            </>
          )}
        </div>
        {mode === "deterministic" ? (
          <p className="footnote">
            Cost labels, measured on the build machine at 100k positions (see the limitations page): base-only grid
            44.4 s sharded / 66.2 s single-thread; per-scenario duration mode 151.8 s single-thread. Shard count
            never changes the numbers, only the wall clock.
          </p>
        ) : (
          <p className="footnote">
            Stochastic mode COSTS TIME: each of the N paths re-projects the full position book once, so cost
            scales linearly in positions &times; paths. Base scenario only; the result is a
            distribution envelope with N and standard errors, not a deterministic EVE/NII. Path counts must be
            even, at least 20; counts above 256 are refused unless the server runs with RUN_PERF, and the
            requested count is never silently adjusted. The slate&rsquo;s base scenario must be static. Hull-White
            1F calibrates to the at-the-money column of the short-rate volatility surface, so the market
            snapshot must carry that column. BGM calibrates to the default subset of the long-yield volatility
            surface, so the snapshot must carry at least 8 of its 28 points, and BGM refuses a market that
            carries a short-rate volatility shock, which it would not read. A violation is a typed 422 shown
            verbatim here.
          </p>
        )}
        {costNote ? (
          <p className="footnote">
            Server cost note (202 echo, verbatim): <code>{costNote}</code>
          </p>
        ) : null}

        <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="active"
            style={{ ...submitStyle, opacity: canSubmit ? 1 : 0.45, cursor: canSubmit ? "pointer" : "not-allowed" }}
            disabled={!canSubmit}
            onClick={() => void doSubmit()}
          >
            {submitting ? "Submitting…" : "Submit run"}
          </button>
          {!selectionComplete ? (
            <span className="zero" style={{ fontSize: 12 }}>
              pick a portfolio, market, slate, and at least one assumption set
            </span>
          ) : !gateSatisfied ? (
            <span className="flag">
              gate: review the diff for {pendingPairings.map((p) => p.set.id).join(", ")} before submitting
            </span>
          ) : null}
        </div>
        {submitError ? <p className="error" style={{ padding: 0 }}>{submitError}</p> : null}
      </section>

      <section className="panel">
        <h2>Queue</h2>
        <p className="desc">
          Live over SSE. Phases render exactly as the engine reports them (resolve, project, report, done); there
          is no synthetic percent bar. Elapsed is wall clock; nothing here is an engine number.
        </p>
        {runs.length === 0 ? (
          <p className="zero">No runs yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...runs]
              .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
              .map((r) => (
                <RunCard key={r.runId} run={r} onChanged={refreshRuns} />
              ))}
          </div>
        )}
      </section>
    </>
  );
}

function Picker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; text: string }>;
}) {
  return (
    <label style={{ fontSize: 13 }}>
      <span className="zero" style={{ marginRight: 6 }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={fieldStyle}>
        <option value="">— pick —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}

const fieldStyle = {
  font: "inherit",
  fontSize: 13,
  padding: "3px 8px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
} as const;

const miniButton = {
  font: "inherit",
  fontSize: 12,
  padding: "2px 10px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
  cursor: "pointer",
} as const;

const submitStyle = {
  font: "inherit",
  fontSize: 14,
  fontWeight: 600,
  padding: "7px 22px",
  border: "1px solid var(--accent)",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#fff",
} as const;
