/**
 * Run > Queue inside a workspace (final review M2). The stored-plan confirm sheet submits through POST /api/plans/run,
 * which is blind to the workspace and its lock, so inside the frame no plan launches from here: the list says it holds
 * every plan in the store and sends the user to Run > Run setups. Past runs are the workspace's attached runs only.
 * Studio tests have no DOM: the markup is the server render; expected texts and hrefs are restated by hand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { WorkspaceManifest } from "@alm/reader";
import { PlansCard, PastRunsCard, QueueLaunchNotice } from "../pages/run/RunViews";
import { loadRunPage } from "../pages/run/runActions";
import { pageFor } from "../pages/pageFor";
import type { Route } from "../router";
import { mockFetch } from "./fixtures/run";
import { HEAD } from "./fixtures/workspace";

afterEach(() => vi.unstubAllGlobals());

const PLANS = [{ id: "plan-synthetic-2500-v1", contentHash: "a", importedAt: "x", positionBook: "synthetic-2500-v1", seeded: true, label: "Synthetic" }];

describe("Run > Queue inside a workspace", () => {
  it("pageFor hands RunPage the workspace head", () => {
    const route = { kind: "screen", ws: HEAD.id, section: "run", screen: "queue", query: {} } as Route;
    const el = pageFor(route, HEAD) as ReactElement<{ head?: WorkspaceManifest | null }>;
    expect(el.props.head).toBe(HEAD);
  });
  it("the plan list carries no Run link, says it lists every plan in the store, and sends the user to Run setups", () => {
    const html = renderToStaticMarkup(<PlansCard ws="ws-a" plans={PLANS} query={{}} launch={false} />);
    expect(html).not.toContain("run/queue?plan=");
    expect(html).not.toMatch(/>Run<\/a>/);
    expect(html).toContain("Lists every plan in the store, not only this workspace&#x27;s.");
    expect(html).toContain('href="#/ws/ws-a/run/setups"');
    expect(html).toContain("Launch from Run &gt; Run setups");
  });
  it("an address naming a plan gets the notice, not the confirm sheet", () => {
    const html = renderToStaticMarkup(<QueueLaunchNotice ws="ws-a" planId="plan-synthetic-2500-v1" />);
    expect(html).toContain("plan-synthetic-2500-v1");
    expect(html).toContain("A stored plan does not launch inside a workspace.");
    expect(html).toContain('href="#/ws/ws-a/run/setups"');
    expect(html).not.toContain("<button");
  });
  it("past runs are the workspace's attached runs only, read from its runs list", async () => {
    mockFetch([
      ["/api/run-plans", PLANS],
      ["/api/workspaces/ws-a/runs", [{ runId: "r-attached", attachedBy: "launch", at: "2026-10-08T09:00:00Z", pins: "consumed", setupLineageId: "s", launchNo: 1, status: null, basisLabel: null }]],
      ["/api/runs", [
        { runId: "r-attached", state: "done", submittedAt: "2026-10-08T09:00:00Z" },
        { runId: "r-other", state: "done", submittedAt: "2026-10-09T09:00:00Z" },
      ]],
    ]);
    const page = await loadRunPage("ws-a");
    expect(page.runs.map((r) => r.runId)).toEqual(["r-attached"]);
    expect(page.plans.map((p) => p.id)).toEqual(["plan-synthetic-2500-v1"]);
  });
  it("the past-runs card in the frame names its source and says where a run comes from", () => {
    const html = renderToStaticMarkup(<PastRunsCard ws="ws-a" rows={[]} query={{}} scoped />);
    expect(html).toContain("Past runs of this workspace");
    expect(html).toContain("No run is attached to this workspace yet; launch one from Run &gt; Run setups.");
    expect(html).toContain("Source: /api/workspaces/ws-a/runs joined to /api/runs");
  });
});
