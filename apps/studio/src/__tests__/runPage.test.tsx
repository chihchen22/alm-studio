// apps/studio/src/__tests__/runPage.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { paint } from "../plan/gatePaint";
import { confirmModel } from "../run/confirm";
import { initialRunView, runErrorLine, streamFailed } from "../run/runState";
import { confirmFor, loadConfirm, loadRunPage, submitStoredPlan, type ConfirmData } from "../pages/run/runActions";
import { ConfirmView, PastRunsCard, PlansCard, ProgressView, RefusalBanner } from "../pages/run/RunViews";
import { RunPage } from "../pages/run/RunPage";
import { runButton } from "../pages/plan/PlanPage";
import { EDITED, SEEDED, mockFetch } from "./fixtures/run";
import { REPLY_TAG, REPLY_UNLICENSED } from "./fixtures/plan";

afterEach(() => vi.unstubAllGlobals());

const OK_REPLY = { ...REPLY_TAG, planHash: "ph-1", profileHash: "pf-1" };
const ids = SEEDED.stages.map((s) => s.id);
const PLANS = [
  { id: "plan-synthetic-2500-v1-edit-1", contentHash: "b", importedAt: "x", positionBook: "synthetic-2500-v1" },
  { id: "plan-synthetic-2500-v1", contentHash: "a", importedAt: "x", positionBook: "synthetic-2500-v1", seeded: true, label: "Synthetic" },
];

describe("loadConfirm and submitStoredPlan", () => {
  it("reads the plan, its book's seeded plan and the validate reply", async () => {
    mockFetch([
      ["/api/run-plans/plan-synthetic-2500-v1-edit-1", EDITED],
      ["/api/run-plans/plan-synthetic-2500-v1", SEEDED],
      ["/api/plans/validate", OK_REPLY],
    ]);
    const d = await loadConfirm("plan-synthetic-2500-v1-edit-1", PLANS);
    expect(d.plan.planId).toBe("plan-synthetic-2500-v1-edit-1");
    expect(d.seeded?.planId).toBe("plan-synthetic-2500-v1");
    expect(d.v).toEqual({ state: "ok", reply: OK_REPLY });
  });

  it("maps a 422 to a refusal carrying the server's code and message", async () => {
    mockFetch([["/api/plans/run", { error: { code: "plan_not_runnable", message: "a run needs exactly one base scenario" } }, 422]]);
    expect(await submitStoredPlan(SEEDED)).toEqual({ kind: "refused", status: 422, code: "plan_not_runnable", message: "a run needs exactly one base scenario" });
  });

  it("answers a 202 with the run id", async () => {
    mockFetch([["/api/plans/run", { runId: "run-7", queuePosition: 0 }, 202]]);
    expect(await submitStoredPlan(SEEDED)).toEqual({ kind: "submitted", runId: "run-7" });
  });

  it("a failure with no reason reads as plain words naming the status once; a server reply keeps its status and message (Polish 1 F2)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" })));
    expect(await submitStoredPlan(SEEDED)).toEqual({ kind: "failed", message: "The request failed with HTTP 502 and the reply gave no reason." });
    mockFetch([["/api/plans/run", { error: { code: "internal", message: "boom" } }, 500]]);
    expect(await submitStoredPlan(SEEDED)).toEqual({ kind: "failed", message: "500: boom" });
  });
});

describe("ConfirmView", () => {
  it("shows ids, hashes, the gate bar and the diff; Run is live", () => {
    const v = { state: "ok" as const, reply: OK_REPLY };
    const html = renderToStaticMarkup(
      <ConfirmView model={confirmModel(EDITED, SEEDED, v)} v={v} gates={paint(ids, OK_REPLY).gates} busy={false} outcome={null} closeHref="#/run" onRun={() => {}} />,
    );
    expect(html).toContain("plan-synthetic-2500-v1-edit-1");
    expect(html).toContain("ph-1");
    expect(html).toContain("pf-1");
    expect(html).toContain("Type gate");
    expect(html).toContain("st-ftp: engine.metric.ftp to alm-ftp");
    expect(html).not.toContain("disabled");
  });

  it("a refused compile: no hash, the reason, Run disabled", () => {
    const v = { state: "ok" as const, reply: REPLY_UNLICENSED };
    const html = renderToStaticMarkup(
      <ConfirmView model={confirmModel(EDITED, SEEDED, v)} v={v} gates={paint(ids, REPLY_UNLICENSED).gates} busy={false} outcome={null} closeHref="#/run" onRun={() => {}} />,
    );
    expect(html).toContain("plan hash not computed: compile refused");
    expect(html).toContain('disabled=""');
  });

  it("the refusal banner prints the server's code and message and says no run started", () => {
    const html = renderToStaticMarkup(<RefusalBanner outcome={{ kind: "refused", status: 409, code: "conflict", message: "slate exists" }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("conflict");
    expect(html).toContain("slate exists");
    expect(html).toContain("No run was started");
    expect(renderToStaticMarkup(<RefusalBanner outcome={null} />)).toBe("");
  });

  it("a failed submit says the submit was not confirmed, with the message, never that nothing was submitted", () => {
    const html = renderToStaticMarkup(<RefusalBanner outcome={{ kind: "failed", message: "timed out" }} />);
    expect(html).toContain("Submit not confirmed");
    expect(html).toContain("timed out");
    expect(html).not.toContain("Not submitted");
  });
});

describe("ProgressView", () => {
  it("a running run: Cancel, no results link, no percent", () => {
    const html = renderToStaticMarkup(
      <ProgressView ws="ws-a" view={{ ...initialRunView("run-1"), state: "running", phase: "project", log: ["L1"] }} query={{}} cancelMsg={null} onCancel={() => {}} />,
    );
    expect(html).toContain("Cancel");
    expect(html).toContain("project");
    expect(html).toContain("L1");
    expect(html).not.toContain("#/analyze/");
    expect(html).not.toContain("%");
  });

  it("a live stream with no end and no log keeps the yet wording", () => {
    const html = renderToStaticMarkup(<ProgressView ws="ws-a" view={{ ...initialRunView("run-1"), state: "queued" }} query={{}} cancelMsg={null} onCancel={() => {}} />);
    expect(html).toContain("Ended</dt><dd>not yet");
    expect(html).toContain("No log lines yet.");
  });

  it("an ended run prints the stored endedAt, not the end state", () => {
    const view = { ...initialRunView("run-1"), state: "done" as const, end: "done" as const };
    const html = renderToStaticMarkup(<ProgressView ws="ws-a" view={view} query={{}} cancelMsg={null} onCancel={() => {}} endedAt="2026-09-27T00:41:28.710Z" />);
    expect(html).toContain('Ended</dt><dd class="num">2026-09-27T00:41:28.710Z</dd>');
    const before = renderToStaticMarkup(<ProgressView ws="ws-a" view={view} query={{}} cancelMsg={null} onCancel={() => {}} />);
    expect(before).toContain("Ended</dt><dd>Unobservable: /api/runs holds no end time for run run-1 yet</dd>");
    expect(before).not.toContain("Ended</dt><dd>done");
  });

  it("a done run links to its results and offers no Cancel", () => {
    const html = renderToStaticMarkup(
      <ProgressView ws="ws-a" view={{ ...initialRunView("run-1"), state: "done", end: "done" }} query={{}} cancelMsg={null} onCancel={() => {}} />,
    );
    expect(html).toContain('href="#/ws/ws-a/results/dashboard?result=run-1"');
    expect(html).not.toContain("Cancel");
  });

  it("a failed run's line drops the runner's entry name and keeps the typed failure (Studio Part 2 m4)", () => {
    const message = 'runnerEntry: SeasoningError: instrument "loan-1" (floating-loan): originationOffsetMonths -6; cannot be applied to a floating loan';
    expect(runErrorLine(message)).toBe('SeasoningError: instrument "loan-1" (floating-loan): originationOffsetMonths -6; cannot be applied to a floating loan');
    expect(runErrorLine("boom")).toBe("boom");
    const html = renderToStaticMarkup(
      <ProgressView ws="ws-a" view={{ ...initialRunView("run-1"), state: "error", end: "error", errors: [message] }} query={{}} cancelMsg={null} onCancel={() => {}} />,
    );
    expect(html).toContain("SeasoningError: instrument");
    expect(html).not.toContain("runnerEntry");
  });
  it("an error end shows the alert and no results link", () => {
    const html = renderToStaticMarkup(
      <ProgressView ws="ws-a" view={{ ...initialRunView("run-1"), state: "error", end: "error", errors: ["boom"] }} query={{}} cancelMsg={null} onCancel={() => {}} />,
    );
    expect(html).toContain("Run error");
    expect(html).toContain("boom");
    expect(html).toContain("No log lines.");
    expect(html).not.toContain("No log lines yet");
    expect(html).not.toContain("#/analyze/");
  });
});

describe("the followed run's end time (Studio Part 2 m6)", () => {
  const ATTACHED = [{ runId: "r-attached", attachedBy: "launch", at: "2026-10-08T09:00:00Z", pins: "consumed", setupLineageId: "s", launchNo: 1, status: null, basisLabel: null }];
  const RUNS = [
    { runId: "r-attached", state: "done", submittedAt: "2026-10-08T09:00:00Z", endedAt: "2026-10-08T09:01:00.000Z" },
    { runId: "r-other", state: "done", submittedAt: "2026-10-09T09:00:00Z" },
  ];
  const urls = () => (vi.mocked(fetch).mock.calls as Array<[string | URL]>).map(([u]) => String(u));

  it("a run in the workspace's own list takes its end time from that list, with no extra read", async () => {
    mockFetch([["/api/run-plans", PLANS], ["/api/workspaces/ws-a/runs", ATTACHED], ["/api/runs", RUNS]]);
    const page = await loadRunPage("ws-a", "r-attached");
    expect(page.endedAt).toBe("2026-10-08T09:01:00.000Z");
    expect(urls().some((u) => u.includes("/api/runs/r-attached"))).toBe(false);
  });

  it("a run outside the workspace's list reads its own record for the end time", async () => {
    mockFetch([
      ["/api/run-plans", PLANS],
      ["/api/workspaces/ws-a/runs", ATTACHED],
      ["/api/runs/r-elsewhere", { runId: "r-elsewhere", state: "error", submittedAt: "x", endedAt: "2026-10-11T08:00:00.000Z", scenarios: [] }],
      ["/api/runs", RUNS],
    ]);
    const page = await loadRunPage("ws-a", "r-elsewhere");
    expect(page.endedAt).toBe("2026-10-11T08:00:00.000Z");
    expect(page.runs.map((r) => r.runId)).toEqual(["r-attached"]);
  });

  it("an unknown run id leaves the end time unread and the lists still load", async () => {
    mockFetch([["/api/run-plans", PLANS], ["/api/workspaces/ws-a/runs", ATTACHED], ["/api/runs/r-gone", { error: { code: "not-found", message: "no run" } }, 404], ["/api/runs", RUNS]]);
    const page = await loadRunPage("ws-a", "r-gone");
    expect(page.endedAt).toBeUndefined();
    expect(page.runs.map((r) => r.runId)).toEqual(["r-attached"]);
  });

  it("no followed run reads nothing more", async () => {
    mockFetch([["/api/run-plans", PLANS], ["/api/workspaces/ws-a/runs", ATTACHED], ["/api/runs", RUNS]]);
    const page = await loadRunPage("ws-a");
    expect(page.endedAt).toBeUndefined();
    expect(urls()).toHaveLength(3);
  });
});

describe("ProgressView over a failed stream", () => {
  it("no status ever arrived: Unobservable with the reason, no Cancel, no results link", () => {
    const html = renderToStaticMarkup(<ProgressView ws="ws-a" view={streamFailed(initialRunView("run-404"))} query={{}} cancelMsg={null} onCancel={() => {}} />);
    expect(html).toContain("Unobservable");
    expect(html).toContain("event stream failed for run run-404; the cause is not visible to Studio (for example an unknown run id or an unreachable server)");
    expect(html).toContain("Ended</dt><dd>not reported");
    expect(html).toContain("No log lines.");
    expect(html).not.toContain("not yet");
    expect(html).not.toContain("No log lines yet");
    expect(html).not.toContain("Cancel");
    expect(html).not.toContain("waiting for the first event");
    expect(html).not.toContain("#/analyze/");
  });

  it("a status arrived before the error: the status stays, with the stream note", () => {
    const html = renderToStaticMarkup(
      <ProgressView ws="ws-a" view={streamFailed({ ...initialRunView("run-1"), state: "running", phase: "project" })} query={{}} cancelMsg={null} onCancel={() => {}} />,
    );
    expect(html).toContain("running");
    expect(html).toContain("event stream failed");
    expect(html).toContain("Cancel");
  });
});

describe("lists, the page and the toolbar button", () => {
  it("lists stored plans with Run links and past runs with results links", () => {
    const plans = renderToStaticMarkup(<PlansCard ws="ws-a" plans={PLANS} query={{}} />);
    expect(plans).toContain('href="#/ws/ws-a/run/queue?plan=plan-synthetic-2500-v1"');
    const runs = renderToStaticMarkup(
      <PastRunsCard ws="ws-a" rows={[{ runId: "r1", state: "done", planId: "plan-x", label: "L", submittedAt: "2026-09-25T01:00:00Z", bookId: null }, { runId: "r2", state: "running", planId: null, label: null, submittedAt: "2026-09-25T02:00:00Z", bookId: null }]} query={{}} />,
    );
    expect(runs).toContain('href="#/ws/ws-a/results/dashboard?result=r1"');
    expect(runs).toContain('href="#/ws/ws-a/run/queue?run=r2"');
    expect(runs).toContain("no plan");
    expect(renderToStaticMarkup(<PastRunsCard ws="ws-a" rows={[]} query={{}} />)).toContain("No runs yet, press Run");
  });

  it("renders a loading card before the lists arrive", () => {
    expect(renderToStaticMarkup(<RunPage ws="ws-a" query={{}} />)).toContain("Reading the plan store and the run list");
  });

  it("the plan toolbar Run button waits for Save as while the canvas has edits", () => {
    expect(runButton(0)).toEqual({ disabled: false, title: "Run this stored plan" });
    expect(runButton(2)).toEqual({ disabled: true, title: "Save as first" });
  });
});

describe("the confirm sheet never pairs a reply with another plan", () => {
  it("validates the very plan it returns", async () => {
    mockFetch([
      ["/api/run-plans/plan-synthetic-2500-v1-edit-1", EDITED],
      ["/api/run-plans/plan-synthetic-2500-v1", SEEDED],
      ["/api/plans/validate", OK_REPLY],
    ]);
    const d = await loadConfirm("plan-synthetic-2500-v1-edit-1", PLANS);
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls;
    const post = calls.find(([u]) => String(u).includes("/api/plans/validate"));
    expect(JSON.parse(String(post?.[1]?.body)).plan.planId).toBe(d.plan.planId);
  });

  it("a late answer for plan A is dropped while plan B is on the sheet", () => {
    const a: ConfirmData = { plan: EDITED, seeded: SEEDED, v: { state: "ok", reply: OK_REPLY } };
    const answerA = { planId: EDITED.planId, data: a };
    expect(confirmFor(SEEDED.planId, answerA)).toBeNull();
    expect(confirmFor(EDITED.planId, answerA)).toBe(a);
    expect(confirmFor(EDITED.planId, null)).toBeNull();
  });
});
