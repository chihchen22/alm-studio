/**
 * The ALM Studio top bar: wordmark, the seven sections, the workspace switcher and the theme switch (spec v3.1
 * Section 3.4). The four old context pills (Book, As of, Plan, Run) are gone: the one context is the workspace.
 * Outside a workspace the sections are disabled and say why. On a phone (up to 900px) the switcher, the sections with
 * their screens and the theme switch are the same one group, shown as a bottom sheet over a scrim; the context button
 * and the crumb chip open it. Both buttons, the sheet's head and the scrim are display: none above 900px, and the
 * group is a dialog only while open, so the desktop bar and its accessibility tree hold.
 */
import { useEffect, useRef } from "react";
import type { WorkspaceManifest } from "@alm/reader";
import { ANALYSIS_LABEL, ANALYSIS_STEPS, SECTIONS, analysisHref, firstScreenOf, homeHref, hrefFor, screenDef, screensOf, selectionQuery, stepLabel, type Route } from "../router";
import { ThemeSeg } from "./ThemeSeg";
import { PILL_NONE } from "./SelectPill";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { trapTab, type CtxSheetEvent } from "./phone";

/** What Tab can land on inside the sheet; an element not rendered (no client rects) is left out. */
const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function TopBar(props: { route: Route; head: WorkspaceManifest | null; workspaces: WorkspaceManifest[]; ctxOpen: boolean; onCtx: (e: CtxSheetEvent) => void }) {
  const { ctxOpen, onCtx, head, route } = props;
  const current = route.kind === "screen" ? route : null;
  const step = route.kind === "analysis" ? route : null;
  const opener = useRef<HTMLElement | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Focus moves into the sheet on open and back to the button that opened it on close.
  useEffect(() => {
    if (ctxOpen) close.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = ctxOpen;
  }, [ctxOpen]);
  // Escape closes the sheet, unless the switcher's menu is open in it: that Escape is the menu's, and closes it first.
  // Tab and Shift+Tab stay inside the sheet while it is open (aria-modal).
  useEffect(() => {
    if (!ctxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sheet.current?.querySelector(".pill-menu")) onCtx("close");
      if (e.key === "Tab" && sheet.current) {
        const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
        const next = trapTab(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (next !== null) {
          e.preventDefault();
          items[next]!.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxOpen, onCtx]);
  const openFrom = (e: { currentTarget: HTMLElement }) => {
    opener.current = e.currentTarget;
    onCtx("toggle");
  };
  const workspaceName = head === null ? PILL_NONE : head.name;
  const here = current === null ? null : screenDef(current.section, current.screen);
  const sectionLabel = (id: string) => SECTIONS.find((s) => s.id === id)!.label;
  return (
    <header className="topbar">
      <a className="wordmark" href={homeHref()}>
        <span className="wordmark-brand">Model Sense</span> <span className="wordmark-product">ALM Studio</span>
      </a>
      <button className="ctx-button" type="button" aria-expanded={ctxOpen} aria-controls="ctx-sheet" title={`Working context. Workspace: ${workspaceName}`} onClick={openFrom}>
        Workspace <span className="mono">{workspaceName}</span>
      </button>
      <button className="nav-chip" type="button" aria-expanded={ctxOpen} aria-controls="ctx-sheet" onClick={openFrom}>
        {current !== null && here !== null ? `${sectionLabel(current.section)} > ${here.label}` : step !== null ? `${ANALYSIS_LABEL} > ${stepLabel(step.step)}` : "Workspaces"}
      </button>
      <nav className="modbar" aria-label="Sections">
        {/* The guided Analysis path first; today's seven sections follow, grouped under Advanced. */}
        {head === null ? (
          <a className="mod mod-analysis" aria-disabled="true" title="Open a workspace first">{ANALYSIS_LABEL}</a>
        ) : (
          <a className="mod mod-analysis" href={analysisHref(head.id, step?.step ?? "market")} aria-current={step !== null ? "true" : undefined}>{ANALYSIS_LABEL}</a>
        )}
        <span className="modbar-group" aria-hidden="true">Advanced</span>
        {SECTIONS.map((s) =>
          head === null ? (
            <a key={s.id} className="mod" aria-disabled="true" title="Open a workspace first">{s.label}</a>
          ) : (
            <a key={s.id} className="mod" href={hrefFor({ ws: head.id, section: s.id, screen: firstScreenOf(s.id), query: selectionQuery(route.query, s.id) })} aria-current={current !== null && current.section === s.id ? "true" : undefined}>{s.label}</a>
          ),
        )}
      </nav>
      <div
        className="topbar-ctx"
        id="ctx-sheet"
        ref={sheet}
        data-open={ctxOpen ? "true" : undefined}
        role={ctxOpen ? "dialog" : undefined}
        aria-modal={ctxOpen ? true : undefined}
        aria-labelledby={ctxOpen ? "ctx-sheet-title" : undefined}
      >
        <div className="ctx-sheet-head">
          <h2 className="ctx-sheet-title" id="ctx-sheet-title">Working context</h2>
          <button ref={close} className="ctx-sheet-close" type="button" aria-label="Close working context" onClick={() => onCtx("close")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <WorkspaceSwitcher head={head} workspaces={props.workspaces} />
        {head !== null && (current !== null || step !== null) ? (
          <nav className="section-sheet" aria-label="Sections and screens">
            <div className="section-sheet-group analysis-sheet-group">
              <div className="analysis-sheet-head">{ANALYSIS_LABEL}</div>
              {ANALYSIS_STEPS.map((st, i) => (
                <a key={st.id} className="analysis-sheet-item" href={analysisHref(head.id, st.id)} aria-current={step !== null && step.step === st.id ? "page" : undefined}>{`${i + 1}. ${st.label}`}</a>
              ))}
            </div>
            <div className="analysis-sheet-head">Advanced</div>
            {SECTIONS.map((s) => (
              <div className="section-sheet-group" key={s.id}>
                <div className="section-sheet-head">{s.label}</div>
                {screensOf(s.id).map((sc) => (
                  <a
                    key={sc.screen}
                    className="section-sheet-item"
                    href={hrefFor({ ws: head.id, section: s.id, screen: sc.screen, query: selectionQuery(route.query, s.id) })}
                    aria-current={current !== null && s.id === current.section && sc.screen === current.screen ? "page" : undefined}
                  >{sc.label}</a>
                ))}
              </div>
            ))}
          </nav>
        ) : null}
        <ThemeSeg />
      </div>
      <div className="ctx-scrim" aria-hidden="true" data-open={ctxOpen ? "true" : undefined} onClick={() => onCtx("close")} />
    </header>
  );
}
