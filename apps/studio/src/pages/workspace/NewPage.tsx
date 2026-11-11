// apps/studio/src/pages/workspace/NewPage.tsx
/**
 * New workspace (spec v3.1 Section 3.6 step 2). Name, type (Test preselected), cut-off date (the newest
 * market snapshot's date preselected, ADR-055; the last month-end when the store holds none), owner and the typed name; the start is a blank workspace, a clone of one, or a
 * roll-forward of one. Create lands on the new workspace's Overview. The server owns the rules (a taken id, a second
 * Production month for one date, a clone that would break a lock) and answers in its own words.
 */
import { listMarket, type WorkspaceManifest } from "@alm/reader";
import { newFormDefaults } from "../../rows/workspaceRows";
import { newestSnapshot } from "../../guided/start";
import { useLoad } from "../../useLoad";
import { WorkspaceFormCard } from "./wsCommon";

/**
 * Props only. `today` fixes the preselected cut-off date when the store holds no market snapshot; `marketDate`, the
 * newest base snapshot's date, is the cut-off a new workspace starts on, so a first run meets no date clash.
 */
export function NewView(props: { workspaces: WorkspaceManifest[]; today?: Date; marketDate?: string | null }) {
  const today = props.today ?? new Date();
  const initial = props.marketDate === undefined || props.marketDate === null ? newFormDefaults(today) : { ...newFormDefaults(today), cutoffDate: props.marketDate };
  return (
    <>
      <section className="card" aria-label="About a new workspace">
        <p className="card-desc">
          A workspace is one reporting date and one type. Choose Production for a month that will be signed off and locked; Test, FTP, Stress and
          Monthly stay editable after a sign-off.
        </p>
      </section>
      <WorkspaceFormCard
        title="New workspace"
        submitLabel="Create workspace"
        initial={initial}
        blankCutoff={props.marketDate ?? null}
        workspaces={props.workspaces}
        fixedSource={null}
        today={today}
      />
    </>
  );
}

export function NewPage(props: { workspaces: WorkspaceManifest[] }) {
  const markets = useLoad(() => listMarket(), []);
  if (markets.state === "loading") return <div className="card muted">Reading the market snapshots</div>;
  // A store whose market list cannot be read falls back to the last month-end, as before.
  const date = markets.state === "ok" ? newestSnapshot(markets.value)?.calibrationDate ?? null : null;
  return <NewView workspaces={props.workspaces} marketDate={date} />;
}
