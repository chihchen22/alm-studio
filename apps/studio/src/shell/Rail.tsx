/**
 * The rail: the screens of the open section, from the SCREENS table, as links inside the current workspace. Outside a
 * workspace it lists the three workspace pages instead. On a phone (phone 1) the rail is not shown: the sheet the crumb
 * chip opens lists every section with its screens, and the context button's sheet carries the switcher.
 */
import { Fragment } from "react";
import type { WorkspaceManifest } from "@alm/reader";
import { ANALYSIS_LABEL, ANALYSIS_STEPS, SECTIONS, analysisHref, homeHref, hrefFor, newWorkspaceHref, screensOf, selectionQuery, type Route } from "../router";
import { SCENARIO_TABS } from "../pages/scenarios/ScenarioTabs";

export function Rail(props: { route: Route; head: WorkspaceManifest | null }) {
  const { route, head } = props;
  if (route.kind === "analysis" && head !== null) {
    // The guided path's nine steps in order; each step's state is on the page's own progress strip.
    return (
      <aside className="rail">
        <nav aria-label="Analysis steps">
          <div className="rail-group">
            <div className="rail-group-label">{ANALYSIS_LABEL}</div>
            {ANALYSIS_STEPS.map((st, i) => (
              <a key={st.id} className="rail-item rail-step" href={analysisHref(head.id, st.id)} aria-current={st.id === route.step ? "page" : undefined}>
                <span className="rail-step-no" aria-hidden="true">{i + 1}</span>{st.label}
              </a>
            ))}
          </div>
        </nav>
      </aside>
    );
  }
  if (route.kind === "screen" && head !== null) {
    const label = SECTIONS.find((s) => s.id === route.section)!.label;
    return (
      <aside className="rail">
        <nav aria-label="Screens">
          <div className="rail-group">
            <div className="rail-group-label">{label}</div>
            {screensOf(route.section).map((s) => (
              <Fragment key={s.screen}>
                <a className="rail-item" href={hrefFor({ ws: head.id, section: route.section, screen: s.screen, query: selectionQuery(route.query, route.section) })} aria-current={s.screen === route.screen && !(route.section === "run" && s.screen === "scenarios" && (route.query.tab ?? "rate") !== "rate") ? "page" : undefined}>
                  {s.label}
                </a>
                {/* The Scenario library's other pages, reached before only by typing ?tab=. */}
                {route.section === "run" && s.screen === "scenarios"
                  ? SCENARIO_TABS.filter((t) => t.tab !== "rate").map((t) => (
                    <a key={t.tab} className="rail-item rail-subitem" href={hrefFor({ ws: head.id, section: "run", screen: "scenarios", query: { tab: t.tab } })} aria-current={route.screen === "scenarios" && route.query.tab === t.tab ? "page" : undefined}>
                      {t.label}
                    </a>
                  ))
                  : null}
              </Fragment>
            ))}
          </div>
        </nav>
      </aside>
    );
  }
  const pages: Array<{ kind: Route["kind"]; label: string; href: string }> = [
    { kind: "home", label: "All workspaces", href: homeHref() },
    { kind: "new", label: "New workspace", href: newWorkspaceHref() },
    { kind: "compare", label: "Compare workspaces", href: "#/workspaces/compare" },
  ];
  return (
    <aside className="rail">
      <nav aria-label="Workspace pages">
        <div className="rail-group">
          <div className="rail-group-label">Workspaces</div>
          {pages.map((p) => (
            <a key={p.kind} className="rail-item" href={p.href} aria-current={p.kind === route.kind ? "page" : undefined}>{p.label}</a>
          ))}
        </div>
      </nav>
    </aside>
  );
}
