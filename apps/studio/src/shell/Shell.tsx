import { useEffect, useReducer, type ReactNode } from "react";
import type { HealthInfo, ReadinessState, WorkspaceManifest } from "@alm/reader";
import { ANALYSIS_LABEL, SECTIONS, screenDef, stepLabel, type Route } from "../router";
import { routeHref } from "../routeHref";
import { TopBar } from "./TopBar";
import { Rail } from "./Rail";
import { HeadBand } from "./HeadBand";
import { ReadinessChip } from "./ReadinessChip";
import { StaleBanner } from "./StaleBanner";
import { ctxSheet, sheetBodyClass } from "./phone";

/** The crumb and the title of a route: Section / Screen inside a workspace, and the three pages outside one. */
export function headingFor(route: Route): { crumb: string; title: string } {
  switch (route.kind) {
    case "screen": {
      const section = SECTIONS.find((s) => s.id === route.section)!.label;
      const label = screenDef(route.section, route.screen).label;
      return { crumb: `${section} / ${label}`, title: label };
    }
    case "analysis":
      return { crumb: `${ANALYSIS_LABEL} / ${stepLabel(route.step)}`, title: stepLabel(route.step) };
    case "new":
      return { crumb: "Workspaces", title: "New workspace" };
    case "compare":
      return { crumb: "Workspaces", title: "Compare workspaces" };
    case "home":
    case "legacy":
      return { crumb: "Workspaces", title: "Workspaces" };
  }
}

/**
 * ALM Studio chrome. Fetches nothing: App loads the workspaces, the head and its readiness and passes them down. The
 * crumb is Section / Screen. The phone's context sheet (phone 1) is open or not here: a route change closes it, and so
 * does leaving the phone band, so a wider window never keeps a dialog it cannot show. While it is open the body
 * carries the lock class (phone 2); the effect's cleanup takes it off on every close and on unmount. The collapsed
 * Assistant strip is gone (teaching build): it had no provider and a disabled file drop, and read as broken.
 */
export function Shell(props: {
  route: Route;
  head: WorkspaceManifest | null;
  workspaces: WorkspaceManifest[];
  /** The open section's readiness, or null outside a workspace or while it is unread. */
  readinessState: ReadinessState | null;
  meta: ReactNode;
  health: HealthInfo | null;
  children: ReactNode;
}) {
  const heading = headingFor(props.route);
  const [ctxOpen, sendCtx] = useReducer(ctxSheet, false);
  const where = routeHref(props.route);
  useEffect(() => sendCtx("close"), [where]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia("(max-width: 900px)");
    const onChange = () => { if (!phone.matches) sendCtx("close"); };
    phone.addEventListener("change", onChange);
    return () => phone.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const cls = sheetBodyClass(ctxOpen);
    if (cls === null) return;
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, [ctxOpen]);
  const chip = props.readinessState === null ? undefined : <ReadinessChip state={props.readinessState} />;
  return (
    <div className="app app-strip">
      <TopBar route={props.route} head={props.head} workspaces={props.workspaces} ctxOpen={ctxOpen} onCtx={sendCtx} />
      <Rail route={props.route} head={props.head} />
      <main className="main">
        <HeadBand crumb={heading.crumb} title={heading.title} meta={props.meta} chip={chip} />
        <div className="content">
          <StaleBanner health={props.health} />
          {props.children}
        </div>
      </main>
    </div>
  );
}
