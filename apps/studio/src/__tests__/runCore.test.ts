// apps/studio/src/__tests__/runCore.test.ts
import { describe, expect, it } from "vitest";
import { ApiError, classifyRunEvent, type RunSummary } from "@alm/reader";
import { errText, pageErrText, reasonOf } from "../errText";
import { cancellable, endOf, initialRunView, reduceRun, streamFailed } from "../run/runState";
import { confirmModel, diffLines } from "../run/confirm";
import { omitKeys, pastRunRows, planIdOfSlate, progressHref, resultsHref, runHref, runPageMode } from "../run/runList";
import { EDITED, SEEDED, planDoc } from "./fixtures/run";
import { REPLY_TAG, REPLY_UNLICENSED } from "./fixtures/plan";

const OK = { state: "ok" as const, reply: { ...REPLY_TAG, planHash: "ph-1", profileHash: "pf-1" } };

describe("reduceRun", () => {
  it("folds status, phase, log, stderr and end, each as received", () => {
    const frames = [
      { t: "status", state: "queued", at: "a" },
      { t: "status", state: "running", at: "b" },
      { t: "phase", phase: "project" },
      { t: "log", line: "projecting 2,351 positions" },
      { t: "stderr", line: "warn: x" },
      { t: "status", state: "done", at: "c" },
      { t: "end", state: "done" },
    ];
    const v = frames.map(classifyRunEvent).reduce(reduceRun, initialRunView("run-1"));
    expect(v).toEqual({
      runId: "run-1", state: "done", phase: "project", log: ["projecting 2,351 positions"],
      stderr: ["warn: x"], errors: [], end: "done",
    });
    expect(cancellable(v)).toBe(false);
  });

  it("restarts from a replayed queued status, so a reconnect never doubles the log", () => {
    const once = [{ t: "status", state: "queued", at: "a" }, { t: "log", line: "L1" }];
    const v = [...once, ...once].map(classifyRunEvent).reduce(reduceRun, initialRunView("r"));
    expect(v.log).toEqual(["L1"]);
  });

  it("keeps error records and status errors, and never drops an unknown frame", () => {
    const v = [
      { t: "error", message: "child exited 1", detail: "stack" },
      { t: "status", state: "error", at: "x", error: { message: "boom" } },
      { t: "mystery", n: 1 },
    ].map(classifyRunEvent).reduce(reduceRun, initialRunView("r"));
    expect(v.errors).toEqual(["child exited 1: stack", "boom"]);
    expect(v.log[0]).toContain("unrecognized event");
  });

  it("the status error that repeats the child's error frame is not printed twice (Studio Part 2 m6)", () => {
    const withDetail = [
      { t: "error", message: "runnerEntry: SeasoningError: bad offset", detail: "at seasoningOffsetOf" },
      { t: "status", state: "error", at: "x", error: { message: "runnerEntry: SeasoningError: bad offset" } },
    ].map(classifyRunEvent).reduce(reduceRun, initialRunView("r"));
    expect(withDetail.errors).toEqual(["runnerEntry: SeasoningError: bad offset: at seasoningOffsetOf"]);
    const plain = [
      { t: "error", message: "child spawn failed" },
      { t: "status", state: "error", at: "x", error: { message: "child spawn failed" } },
    ].map(classifyRunEvent).reduce(reduceRun, initialRunView("r"));
    expect(plain.errors).toEqual(["child spawn failed"]);
    // A status error that only shares a first word with an earlier one is its own line.
    const other = [
      { t: "error", message: "boom", detail: "stack" },
      { t: "status", state: "error", at: "x", error: { message: "bo" } },
    ].map(classifyRunEvent).reduce(reduceRun, initialRunView("r"));
    expect(other.errors).toEqual(["boom: stack", "bo"]);
  });

  it("endOf names the end state only for an end frame; cancel is open until the end", () => {
    expect(endOf(classifyRunEvent({ t: "end", state: "cancelled" }))).toBe("cancelled");
    expect(endOf(classifyRunEvent({ t: "log", line: "x" }))).toBeNull();
    expect(cancellable(initialRunView("r"))).toBe(true);
    expect(cancellable({ ...initialRunView("r"), state: "running" })).toBe(true);
  });
});

describe("confirmModel", () => {
  it("the seeded plan itself: diff says so, hashes from the reply, run enabled", () => {
    const m = confirmModel(SEEDED, null, OK);
    expect(m.diff).toEqual({ kind: "self", seededId: "plan-synthetic-2500-v1" });
    expect(m.planHashText).toBe("ph-1");
    expect(m.profileHashText).toBe("pf-1");
    expect(m.runEnabled).toBe(true);
    expect(m.positionBook).toBe("synthetic-2500-v1");
  });

  it("an edited plan lists its structural changes against the seeded plan", () => {
    const m = confirmModel(EDITED, SEEDED, OK);
    expect(m.diff).toEqual({ kind: "diff", seededId: "plan-synthetic-2500-v1", lines: ["st-ftp: engine.metric.ftp to alm-ftp"] });
  });

  it("no seeded plan, or no structural difference, is one line", () => {
    expect(confirmModel(planDoc("p-other", [], "book-z"), null, OK).diff).toEqual({ kind: "no-seed", seededId: "plan-book-z" });
    expect(confirmModel({ ...SEEDED, planId: "plan-synthetic-2500-v1-copy" }, SEEDED, OK).diff.kind).toBe("same");
  });

  it("a refused compile disables Run and says why no hash exists", () => {
    const m = confirmModel(EDITED, SEEDED, { state: "ok", reply: REPLY_UNLICENSED });
    expect(m.runEnabled).toBe(false);
    expect(m.planHashText.startsWith("plan hash not computed: compile refused")).toBe(true);
    expect(m.planHashText).toContain("UnlicensedBindingError");
  });

  it("a shape error, an unavailable validator or a pending check never enables Run", () => {
    expect(confirmModel(SEEDED, null, { state: "shape", message: "bad" }).runEnabled).toBe(false);
    expect(confirmModel(SEEDED, null, { state: "shape", message: "bad" }).planHashText).toBe("plan hash not computed: malformed plan (bad)");
    expect(confirmModel(SEEDED, null, { state: "unavailable", message: "down" }).runEnabled).toBe(false);
    expect(confirmModel(SEEDED, null, { state: "checking" }).runEnabled).toBe(false);
  });

  it("diffLines words every kind of change", () => {
    expect(diffLines({
      componentChanges: [{ stageId: "a", from: "x", to: "y" }],
      wiresAdded: [{ from: "a", to: "b" }],
      wiresRemoved: [{ from: "c", to: "d" }],
      stagesAdded: ["e"],
      stagesRemoved: ["f"],
    })).toEqual(["a: x to y", "Wire added: a to b", "Wire removed: c to d", "Stage added: e", "Stage removed: f"]);
  });
});

describe("run list and hrefs", () => {
  it("reads the plan id off the plan-run slate name", () => {
    expect(planIdOfSlate("plan-plan-synthetic-2500-v1")).toBe("plan-synthetic-2500-v1");
    expect(planIdOfSlate("regulatory-grid")).toBeNull();
  });

  it("lists past runs newest first, fields as served", () => {
    const runs = [
      { runId: "r1", state: "done", submittedAt: "2026-09-25T01:00:00Z", platformRequestHash: "h", label: "one", refs: { portfolioId: "b", marketId: "m", scenarioSlateId: "plan-plan-x", assumptionSetIds: [] } },
      { runId: "r2", state: "error", submittedAt: "2026-09-25T02:00:00Z", platformRequestHash: "h" },
    ] as RunSummary[];
    expect(pastRunRows(runs)).toEqual([
      { runId: "r2", state: "error", planId: null, label: null, submittedAt: "2026-09-25T02:00:00Z", bookId: null },
      { runId: "r1", state: "done", planId: "plan-x", label: "one", submittedAt: "2026-09-25T01:00:00Z", bookId: "b" },
    ]);
  });

  it("carries the run's book from refs.portfolioId, null without refs", () => {
    const rows = pastRunRows([
      { runId: "r1", state: "done", submittedAt: "2026-09-26T10:00:00Z", refs: { portfolioId: "vanilla-book-v1", marketId: "m", scenarioSlateId: "s", assumptionSetIds: [] } },
      { runId: "r2", state: "done", submittedAt: "2026-09-25T10:00:00Z" },
    ] as never);
    expect(rows.map((r) => [r.runId, r.bookId])).toEqual([["r1", "vanilla-book-v1"], ["r2", null]]);
  });

  it("builds the run, progress and results hrefs", () => {
    const q = { book: "b", asOf: "m", plan: "p", tab: "eve" };
    expect(omitKeys(q, ["plan", "tab"])).toEqual({ book: "b", asOf: "m" });
    expect(runHref("ws-a", q, "plan-y")).toBe("#/ws/ws-a/run/queue?plan=plan-y");
    expect(progressHref("ws-a", q, "r9")).toBe("#/ws/ws-a/run/queue?run=r9");
    expect(resultsHref("ws-a", q, "r9")).toBe("#/ws/ws-a/results/eve?result=r9");
    expect(resultsHref("ws-a", {}, "r9")).toBe("#/ws/ws-a/results/dashboard?result=r9");
  });

  it("resultsHref keeps the tab so a measure layer's run list stays on that measure", () => {
    expect(resultsHref("ws-a", { book: "b", tab: "nii", scenario: "S0" }, "r9")).toBe("#/ws/ws-a/results/nii?result=r9");
    expect(resultsHref("ws-a", { book: "b" }, "r9")).toBe("#/ws/ws-a/results/dashboard?result=r9");
  });

  it("run beats plan in the page mode", () => {
    expect(runPageMode({ run: "r", plan: "p" })).toEqual({ kind: "progress", runId: "r" });
    expect(runPageMode({ plan: "p" })).toEqual({ kind: "confirm", planId: "p" });
    expect(runPageMode({})).toEqual({ kind: "list" });
  });

  it("errText prints the server's status and message, without the code (Studio Part 2 D10)", () => {
    expect(errText(new ApiError(422, "plan_not_runnable", "no base"))).toBe("422: no base");
    expect(errText(new ApiError(409, "conflict", "changed since reviewed"))).toBe(pageErrText(new ApiError(409, "conflict", "changed since reviewed")));
    expect(errText(new Error("down"))).toBe("down");
  });
  it("errText for a request the network could not deliver says so, with no status (Studio Part 2 D10)", () => {
    expect(errText(new TypeError("Failed to fetch"))).toBe("The platform could not be reached. Is it running?");
  });
  it("a non-JSON failure reads as plain words with the status once (Polish 1 F2)", () => {
    const bare = new ApiError(502, "http-error", "502 Bad Gateway");
    expect(reasonOf(bare)).toBe("The request failed with HTTP 502 and the reply gave no reason.");
    expect(errText(bare)).toBe("The request failed with HTTP 502 and the reply gave no reason.");
    expect(errText(new ApiError(404, "http-error", "404 "))).toBe("The request failed with HTTP 404 and the reply gave no reason.");
    expect(reasonOf(new ApiError(404, "not-found", 'run "r" not found'))).toBe('run "r" not found');
    expect(reasonOf(new Error("fetch failed"))).toBe("fetch failed");
    expect(reasonOf("down")).toBe("down");
  });
  it("a page's error line names the status once, in words; a server reply keeps its status and message (Polish 1 F2)", () => {
    expect(pageErrText(new ApiError(502, "http-error", "502 Bad Gateway"))).toBe("The request failed with HTTP 502 and the reply gave no reason.");
    expect(pageErrText(new ApiError(404, "http-error", "404 "))).toBe("The request failed with HTTP 404 and the reply gave no reason.");
    expect(pageErrText(new ApiError(409, "conflict", "plan p-1 already exists"))).toBe("409: plan p-1 already exists");
    expect(pageErrText(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(pageErrText("down")).toBe("down");
  });
  it("a request the network could not deliver says the platform could not be reached, on every error path (Task 8 fix I2)", () => {
    const sentence = "The platform could not be reached. Is it running?";
    for (const message of ["Failed to fetch", "fetch failed", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(reasonOf(new TypeError(message)), message).toBe(sentence);
      expect(pageErrText(new TypeError(message)), message).toBe(sentence);
      expect(errText(new TypeError(message)), message).toBe(sentence);
    }
    // A TypeError that is not a failed request keeps its own text.
    expect(reasonOf(new TypeError("x is not a function"))).toBe("x is not a function");
  });
});

describe("a failed event stream", () => {
  it("an error before any status: unobservable, with the reason, and no Cancel", () => {
    const v = streamFailed(initialRunView("r-x"));
    expect(v.state).toBeNull();
    expect(v.streamError).toBe("event stream failed for run r-x; the cause is not visible to Studio (for example an unknown run id or an unreachable server)");
    expect(cancellable(v)).toBe(false);
  });

  it("an error after a status keeps the status and Cancel", () => {
    const running = [{ t: "status", state: "running", at: "b" }].map(classifyRunEvent).reduce(reduceRun, initialRunView("r"));
    const v = streamFailed(running);
    expect(v.state).toBe("running");
    expect(v.streamError).toBeDefined();
    expect(cancellable(v)).toBe(true);
  });

  it("an event after the error clears it (EventSource reconnected)", () => {
    const v = reduceRun(streamFailed(initialRunView("r")), classifyRunEvent({ t: "status", state: "queued", at: "a" }));
    expect(v.streamError).toBeUndefined();
    expect(v.state).toBe("queued");
    const w = reduceRun(streamFailed({ ...initialRunView("r"), state: "running" }), classifyRunEvent({ t: "log", line: "L" }));
    expect(w.streamError).toBeUndefined();
    expect(w.log).toEqual(["L"]);
  });
});
