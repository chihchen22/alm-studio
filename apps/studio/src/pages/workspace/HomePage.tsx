// apps/studio/src/pages/workspace/HomePage.tsx
/**
 * Workspace Home (spec v3.1 Sections 3.2 and 3.6 step 1). Every workspace the store holds, grouped by type
 * in the switcher's order, each with its type, cut-off date, status and readiness. An empty store shows one card,
 * "Create a workspace". An old address that named no single workspace leaves a banner here that
 * names the address and the workspaces the evidence pointed at. The Start here card comes first,
 * then the start choices. A card a pack registered (registry.ts) shows above the workspace list when it has
 * something to say. Home reads; New, Compare and Overview write.
 */
import { Fragment, useEffect, useState } from "react";
import { getReadiness, type ReadinessReport, type WorkspaceManifest } from "@alm/reader";
import { takeForwardBanner } from "../../forwardBanner";
import type { ForwardBanner } from "../../resolveLegacy";
import { hrefFor, newWorkspaceHref } from "../../router";
import { groupByType, overallReadiness, statusLabel } from "../../rows/workspaceRows";
import { ReadinessChip } from "../../shell/ReadinessChip";
import { TypeBadge } from "../../shell/WorkspaceSwitcher";
import { useLoad } from "../../useLoad";
import { registeredHomeCards } from "../../registry";
import { StartChoices } from "./StartChoices";
import { StartHere } from "./StartHere";
import "./wsCommon";

const overviewHref = (id: string): string => hrefFor({ ws: id, section: "workspace", screen: "overview" });

function ForwardBannerCard(props: { banner: ForwardBanner }) {
  const { oldAddress, candidates } = props.banner;
  return (
    <section className="card ws-banner" role="status" aria-label="Old address">
      <p className="card-title">That address does not name one workspace</p>
      <p className="card-desc">
        The address <span className="mono">{oldAddress}</span> from an earlier version of Studio belongs to a workspace, and the store does not
        say which one.
        {candidates.length > 0 ? " The workspaces it could mean:" : " No workspace holds the book or run it named."}
      </p>
      {candidates.length > 0 ? (
        <ul className="list">
          {candidates.map((c) => <li key={c}><a href={overviewHref(c)}>{c}</a></li>)}
        </ul>
      ) : null}
    </section>
  );
}

function ReadinessCell(props: { id: string; readiness: Record<string, ReadinessReport | null> | undefined }) {
  if (props.readiness === undefined || !(props.id in props.readiness)) return <span className="muted">Not read</span>;
  const report = props.readiness[props.id];
  if (report === null || report === undefined) return <span className="muted">Not read</span>;
  return <ReadinessChip state={overallReadiness(report)} />;
}

/** Props only: the list, the banner to show and, when read, each workspace's readiness report. */
export function HomeView(props: {
  workspaces: WorkspaceManifest[];
  banner: ForwardBanner | null;
  readiness?: Record<string, ReadinessReport | null>;
}) {
  const { workspaces } = props;
  const groups = groupByType(workspaces);
  return (
    <>
      {props.banner !== null ? <ForwardBannerCard banner={props.banner} /> : null}
      {/* Start here comes first on every store, every demo once; it replaces the two demo
          sections of S3b-1 and S3c-1. The start choices follow, then the workspace list. */}
      <StartHere workspaces={workspaces} />
      <StartChoices workspaces={workspaces} />

      {workspaces.length === 0 ? (
        <section className="card ws-empty" aria-label="Create a workspace">
          <div className="card-title">Create a workspace</div>
          <p className="card-desc">
            A workspace is one reporting date, one type, and the positions, market, assumptions and run setups that make a run reproducible.
            The store holds none yet.
          </p>
          <p><a className="btn btn-primary" href={newWorkspaceHref()}>Create a workspace</a></p>
        </section>
      ) : (
        <>
          {registeredHomeCards().map((c) => <Fragment key={c.id}>{c.render({ workspaces })}</Fragment>)}
          <section className="card" aria-label="Workspace actions">
            <div className="card-title">Workspaces</div>
            <p className="card-desc">{workspaces.length} in the store. Open one to see its manifest and what it still needs.</p>
            <div className="ws-actions">
              <a className="btn btn-primary" href={newWorkspaceHref()}>New workspace</a>
              <a className="btn" href="#/workspaces/compare">Compare workspaces</a>
            </div>
          </section>
          {groups.map((g) => (
            <section className="card table-card" aria-label={g.label} key={g.label}>
              <div className="card-title ws-group-title">{g.label}</div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th><th scope="col">Type</th><th scope="col">Cut-off date</th><th scope="col">Status</th><th scope="col">Readiness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((w) => (
                      <tr key={w.id}>
                        <td><a href={overviewHref(w.id)}>{w.name}</a><br /><span className="mono muted">{w.id}</span></td>
                        <td><TypeBadge type={w.type} /></td>
                        <td className="num">{w.cutoffDate}</td>
                        <td>
                          {statusLabel(w.status)}
                          {w.status === "superseded" && w.lineage.supersededBy !== null ? <> by <a href={overviewHref(w.lineage.supersededBy)}>{w.lineage.supersededBy}</a></> : null}
                        </td>
                        <td><ReadinessCell id={w.id} readiness={props.readiness} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}

/**
 * The route: the list from App, each workspace's readiness read once, and the forward banner. App stashes the banner
 * in an effect that runs after this page's first render (a child renders before its parent's effect), so the page
 * reads once at mount and once more after the commit; `takeForwardBanner` clears it, so a reload does not show it twice.
 */
export function HomePage(props: { workspaces: WorkspaceManifest[] }) {
  const [banner, setBanner] = useState<ForwardBanner | null>(() => takeForwardBanner());
  useEffect(() => {
    if (banner !== null) return;
    const t = window.setTimeout(() => setBanner(takeForwardBanner()), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const key = props.workspaces.map((w) => `${w.id}@${w.revision}`).join(",");
  const load = useLoad(
    async (): Promise<Record<string, ReadinessReport | null>> => {
      const rows = await Promise.all(props.workspaces.map((w) => getReadiness(w.id).then((r): [string, ReadinessReport | null] => [w.id, r], (): [string, ReadinessReport | null] => [w.id, null])));
      return Object.fromEntries(rows);
    },
    [key],
  );
  return <HomeView workspaces={props.workspaces} banner={banner} {...(load.state === "ok" ? { readiness: load.value } : {})} />;
}
