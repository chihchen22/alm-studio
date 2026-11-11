/**
 * The workspace switcher (spec v3.1 Section 3.4): the one context pill of the top bar. It reads the workspace's name,
 * a type badge and the cut-off date, and opens a menu grouped by type: Production first, then Monthly newest first,
 * then Test, FTP and Stress, with superseded and archived workspaces under History. Outside a workspace it reads
 * Workspaces. Escape or an outside click closes the menu, as a select pill's does.
 */
import { useEffect, useRef, useState } from "react";
import type { WorkspaceManifest, WorkspaceType } from "@alm/reader";
import { homeHref, hrefFor } from "../router";

export const TYPE_LABEL: Record<WorkspaceType, string> = {
  production: "Production",
  monthly: "Monthly",
  test: "Test",
  ftp: "FTP",
  stress: "Stress",
};

const GROUP_ORDER: readonly WorkspaceType[] = ["production", "monthly", "test", "ftp", "stress"];

export interface SwitcherGroup {
  label: string;
  rows: WorkspaceManifest[];
}

/** Newest cut-off first; ties by id ascending, so the order never depends on how the list arrived. */
function byCutoffDesc(a: WorkspaceManifest, b: WorkspaceManifest): number {
  if (a.cutoffDate !== b.cutoffDate) return a.cutoffDate < b.cutoffDate ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The menu's groups, empty ones left out. A locked Production workspace is still Production; superseded and archived go to History. */
export function switcherGroups(workspaces: WorkspaceManifest[]): SwitcherGroup[] {
  const live = workspaces.filter((w) => w.status !== "superseded" && w.status !== "archived");
  const history = workspaces.filter((w) => w.status === "superseded" || w.status === "archived");
  const groups: SwitcherGroup[] = GROUP_ORDER.map((t) => ({ label: TYPE_LABEL[t], rows: live.filter((w) => w.type === t).sort(byCutoffDesc) }));
  groups.push({ label: "History", rows: history.sort(byCutoffDesc) });
  return groups.filter((g) => g.rows.length > 0);
}

export function TypeBadge(props: { type: WorkspaceType }) {
  return <span className={`type-badge type-badge-${props.type}`}>{TYPE_LABEL[props.type]}</span>;
}

/** `defaultOpen` is the menu's first state: false in the bar, true where a test or a story wants the list in the markup. */
export function WorkspaceSwitcher(props: { head: WorkspaceManifest | null; workspaces: WorkspaceManifest[]; defaultOpen?: boolean }) {
  const { head } = props;
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  const groups = switcherGroups(props.workspaces);
  const title = head === null ? "Workspaces" : `${head.name}: ${TYPE_LABEL[head.type]}, cut-off ${head.cutoffDate}`;
  return (
    <div className="pill-menu-wrap switcher" ref={wrap}>
      <button className="pill pill-select switcher-pill" type="button" title={title} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        {head === null ? (
          <span className="switcher-name">Workspaces</span>
        ) : (
          <>
            <span className="switcher-name">{head.name}</span>
            <TypeBadge type={head.type} />
            <span className="switcher-cutoff num">{`cut-off ${head.cutoffDate}`}</span>
          </>
        )}
      </button>
      {open && (
        <div className="pill-menu switcher-menu" role="group" aria-label="Workspaces">
          {groups.map((g) => (
            <div className="switcher-group" key={g.label}>
              <div className="switcher-group-label">{g.label}</div>
              <ul>
                {g.rows.map((w) => (
                  <li key={w.id}>
                    <a href={hrefFor({ ws: w.id, section: "workspace", screen: "overview" })} aria-current={head !== null && w.id === head.id ? "true" : undefined} onClick={() => setOpen(false)}>
                      <span className="switcher-row-name">{w.name}</span>
                      <TypeBadge type={w.type} />
                      <span className="switcher-cutoff num">{`cut-off ${w.cutoffDate}`}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="switcher-foot">
            <a href={homeHref()} onClick={() => setOpen(false)}>All workspaces</a>
          </div>
        </div>
      )}
    </div>
  );
}
