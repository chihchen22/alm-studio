/**
 * Workbench shell: nav plus a small hash router (no react-router,
 * no new dependencies). The practitioner's loop reads left to right — Book,
 * Assumptions, Scenarios, Run, Results, Compare — plus the preserved v1
 * fixture archive (routes/FixtureArchive.tsx carries the former
 * App body unchanged).
 *
 * ROUTE CONTRACT WITH W1-P4 (as landed, both modules in this wave):
 *  - `#/results/<runId>` renders ResultsPage with `runId` (decoded segment);
 *    `#/results` renders it with runId undefined and the page shows its own
 *    run picker.
 *  - `#/compare?a=<runId>&b=<runId>` renders ComparePage with `runA`/`runB`
 *    from the query; absent keys mean the page shows its pickers.
 *  - ResultsPage, ComparePage, and FixtureArchive render their own full-page
 *    `.app` container (masthead included); the shell adds only the nav. The
 *    setup routes (Book, Assumptions, Scenarios, Run) are panel lists and get
 *    the `.app` container from the shell.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { PortfolioPage } from "./routes/PortfolioPage";
import { AssumptionsPage } from "./routes/AssumptionsPage";
import { ScenariosPage } from "./routes/ScenariosPage";
import { RunPage } from "./routes/RunPage";
import { PlanPage } from "./routes/PlanPage";
import { InstrumentPage } from "./routes/InstrumentPage";
import { ResultsPage } from "./routes/ResultsPage";
import { ComparePage } from "./routes/ComparePage";
import { DataPage } from "./routes/DataPage";

// The v1 archive is the only route pulling the charting library (W4-U1 logged
// the 611 kB chunk); lazy-loading it splits that library out of the main
// bundle. Same component, same route, loaded on first visit to #/archive.
const FixtureArchive = lazy(() =>
  import("./routes/FixtureArchive").then((m) => ({ default: m.FixtureArchive })),
);

// --- Hash routing ------------------------------------------------------------

interface Route {
  /** Path segments after "#/", decoded. */
  segments: string[];
  /** Query pairs after "?", decoded. */
  query: Record<string, string>;
}

function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart, queryPart] = raw.split("?", 2);
  const segments = pathPart.split("/").filter((s) => s !== "").map(decodeURIComponent);
  const query: Record<string, string> = {};
  if (queryPart) {
    for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  }
  return { segments, query };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

// --- Shell -------------------------------------------------------------------

const NAV: Array<{ path: string; label: string }> = [
  { path: "book", label: "Book" },
  { path: "assumptions", label: "Assumptions" },
  { path: "scenarios", label: "Scenarios" },
  { path: "run", label: "Run" },
  { path: "plan", label: "Plan" },
  { path: "instrument", label: "Instrument" },
  { path: "results", label: "Results" },
  { path: "compare", label: "Compare" },
  { path: "data", label: "Data" },
  { path: "archive", label: "v1 Archive" },
];

export function App() {
  const route = useHashRoute();
  const head = route.segments[0] ?? "book";

  // Full-page routes render their own .app container; setup routes get it here.
  const body =
    head === "archive" ? (
      <Suspense
        fallback={
          <div className="app">
            <p className="loading">Loading the v1 archive…</p>
          </div>
        }
      >
        <FixtureArchive />
      </Suspense>
    ) : head === "results" ? (
      <ResultsPage runId={route.segments[1]} />
    ) : head === "compare" ? (
      <ComparePage runA={route.query.a} runB={route.query.b} />
    ) : head === "data" ? (
      <div className="app">
        <DataPage initialTab={route.query.tab} initialMarketId={route.query.market} />
      </div>
    ) : (
      <div className="app">
        {head === "assumptions" ? (
          <AssumptionsPage />
        ) : head === "scenarios" ? (
          <ScenariosPage />
        ) : head === "run" ? (
          <RunPage />
        ) : head === "plan" ? (
          <PlanPage />
        ) : head === "instrument" ? (
          <InstrumentPage />
        ) : (
          <PortfolioPage />
        )}
      </div>
    );

  return (
    <>
      <nav
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
          alignItems: "center",
          padding: "10px 20px",
          borderBottom: "1px solid var(--line-strong)",
          background: "var(--panel)",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 14, marginRight: 14 }}>ALM Engine — Workbench</span>
        {NAV.map((n) => {
          const active = head === n.path || (head === "" && n.path === "book");
          return (
            <a
              key={n.path}
              href={`#/${n.path}`}
              style={{
                fontSize: 13,
                textDecoration: "none",
                padding: "4px 12px",
                borderRadius: 999,
                color: active ? "#fff" : "var(--ink)",
                background: active ? "var(--accent)" : "transparent",
                border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
              }}
            >
              {n.label}
            </a>
          );
        })}
      </nav>
      {body}
    </>
  );
}
