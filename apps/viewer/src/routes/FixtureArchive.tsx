/**
 * The v1 fixture archive: the original static-fixture report, kept as a route.
 * This is the pre-platform viewer of record — a
 * read-only reader over the two build-time RunResult fixtures under public/,
 * both written by scripts/generateFixture.mts. runResult.json was regenerated
 * on the round illustrative beta default on 2026-11-10; vanillaRunResult.json
 * stays at its committed bytes. The loader and report below are the former
 * App.tsx body, moved verbatim; only the component names changed
 * (App -> FixtureArchive).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Bundle } from "@alm/reader";
import { usdMM } from "@alm/reader";
import { ScenarioLabelProvider, useScenarioLabel } from "@alm/reader";
import { ProvenancePanel } from "../components/ProvenancePanel";
import { NiiTable } from "../components/NiiTable";
import { EveTable } from "../components/EveTable";
import { GapLadders } from "../components/GapLadders";
import { AttributionWaterfall } from "../components/AttributionWaterfall";
import { CashflowRunoff } from "../components/CashflowRunoff";
import { ShowBeforeRunDiff } from "../components/ShowBeforeRunDiff";
import { NotImplementedPanel } from "../components/NotImplementedPanel";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bundle: Bundle };

/** The two engine-produced bundles the viewer can render (generateFixture.mts). */
const BOOKS = [
  { key: "synthetic", label: "Synthetic 11-family book", file: "runResult.json" },
  { key: "vanilla", label: "Vanilla book (no optionality)", file: "vanillaRunResult.json" },
] as const;
type BookKey = (typeof BOOKS)[number]["key"];

/** The RunResult is served as a static asset, fetched over HTTP like an API. */
async function loadBundle(file: string): Promise<Bundle> {
  const res = await fetch(`${import.meta.env.BASE_URL}${file}`);
  if (!res.ok) throw new Error(`fetch ${file} failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as Bundle;
}

export function FixtureArchive() {
  const [book, setBook] = useState<BookKey>("synthetic");
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    const file = BOOKS.find((b) => b.key === book)?.file ?? BOOKS[0].file;
    loadBundle(file)
      .then((bundle) => live && setState({ status: "ready", bundle }))
      .catch((err: unknown) =>
        live && setState({ status: "error", message: err instanceof Error ? err.message : String(err) }),
      );
    return () => {
      live = false;
    };
  }, [book]);

  const picker = (
    <div className="bookpicker">
      {BOOKS.map((b) => (
        <button
          key={b.key}
          className={b.key === book ? "active" : ""}
          onClick={() => setBook(b.key)}
          disabled={state.status === "loading"}
        >
          {b.label}
        </button>
      ))}
    </div>
  );

  if (state.status === "loading") return <div className="app loading">Loading run result…</div>;
  if (state.status === "error") return <div className="app error">Failed to load: {state.message}</div>;
  return (
    <ScenarioLabelProvider scenarios={state.bundle.generatedFrom.scenarios}>
      <Report bundle={state.bundle} picker={picker} />
    </ScenarioLabelProvider>
  );
}

function Report({ bundle, picker }: { bundle: Bundle; picker: ReactNode }) {
  const { runResult: r, generatedFrom: gen, derived, showBeforeRun } = bundle;
  const scenarioLabel = useScenarioLabel();

  const familyLabel = useMemo(() => {
    const map = new Map(gen.families.map((f) => [f.id, f.label]));
    return (id: string) => map.get(id) ?? id;
  }, [gen.families]);

  const scenarioIds = r.nii.byScenario.map((s) => s.scenarioId);
  const [scenario, setScenario] = useState<string>(scenarioIds[0] ?? "S0");

  const bs = gen.balanceSheet;

  return (
    <div className="app">
      <header className="masthead">
        <h1>ALM Engine — Run Result Viewer</h1>
        {picker}
        <div className="sub">
          Read-only reader over a RunResult. Every number is fetched from the engine-produced JSON; the client
          computes nothing.
        </div>
        <div className="provbar">
          <span>
            Portfolio <code>{gen.portfolioId}</code>
          </span>
          <span>{gen.positionCount.toLocaleString("en-US")} positions</span>
          <span>as of {gen.asOf}</span>
          <span>
            Assets <code>{usdMM(bs.assets)}</code>
          </span>
          <span>
            Liabilities <code>{usdMM(bs.liabilities)}</code>
          </span>
          <span>
            Equity <code>{usdMM(bs.equity)}</code>
          </span>
          <span>
            Run <code>{r.provenance.runId}</code>
          </span>
        </div>
      </header>

      <div className="controls" style={{ marginTop: 18 }}>
        <span style={{ alignSelf: "center", color: "var(--muted)", fontSize: 12, marginRight: 4 }}>
          Scenario (NII by family, gap, runoff):
        </span>
        {scenarioIds.map((s) => (
          <button key={s} className={s === scenario ? "active" : ""} onClick={() => setScenario(s)}>
            {scenarioLabel(s)}
          </button>
        ))}
      </div>

      <NiiTable nii={r.nii} familyLabel={familyLabel} selected={scenario} />
      <EveTable eve={r.eve} />
      <AttributionWaterfall waterfalls={derived.waterfalls} />
      <GapLadders repricing={r.gap.repricing} liquidity={r.gap.liquidity} selected={scenario} />
      <CashflowRunoff cashflows={r.cashflows} selected={scenario} />
      <ShowBeforeRunDiff sbr={showBeforeRun} familyLabel={familyLabel} />
      <ProvenancePanel prov={r.provenance} gen={gen} schemaVersion={r.schemaVersion} />
      <NotImplementedPanel tags={r.notImplemented} />

      <p className="footnote">{gen.note}</p>
      <p className="footnote">{derived.note}</p>
    </div>
  );
}
