// apps/studio/src/__tests__/workspaceHome.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryLine, ReadinessReport, WorkspaceCompareReply, WorkspaceManifest } from "@alm/reader";
import {
  cloneBody, cloneFormFor, createBody, describeChange, formProblems, groupByType, lastMonthEnd, newFormDefaults, nextMonthEnd,
  nextStep, nextStepLabel, overallReadiness, rollForwardChecklist, copyChecklist, withStart,
} from "../rows/workspaceRows";
import { HomeView } from "../pages/workspace/HomePage";
import { NewView } from "../pages/workspace/NewPage";
import { OverviewView } from "../pages/workspace/OverviewPage";
import { WorkspaceCompareView } from "../pages/workspace/ComparePage";
import { HEAD, OTHERS, READINESS, READINESS_BLANK } from "./fixtures/workspace";

const PRODUCTION: WorkspaceManifest = { ...HEAD, id: "ws-prod-2026-03", name: "March production", type: "production", status: "active" };
const LOCKED: WorkspaceManifest = {
  ...PRODUCTION,
  status: "locked",
  lock: { lockedAt: "2026-10-09T10:00:00.000Z", by: "Chih", approvalId: "appr-1", signedHash: "signed-hash" },
};

describe("workspace rows", () => {
  it("groups Production first, then Monthly by date desc, then Test, FTP, Stress; superseded and archived under History", () => {
    const g = groupByType([{ ...HEAD, id: "t1", type: "test" }, { ...HEAD, id: "p1", type: "production" }, { ...HEAD, id: "m1", type: "monthly", cutoffDate: "2026-04-30" }, { ...HEAD, id: "m2", type: "monthly", cutoffDate: "2026-05-29" }, { ...HEAD, id: "a1", status: "archived" }]);
    expect(g.map((x) => x.label)).toEqual(["Production", "Monthly", "Test", "History"]);
    expect(g[1]!.rows.map((r) => r.id)).toEqual(["m2", "m1"]);
  });
  it("next step follows Positions, Base snapshot, Assumption set, Routing policy, Validate the run setup", () => {
    expect(nextStepLabel(READINESS_BLANK)).toBe("Import positions");
    const set = (r: ReadinessReport, item: string, state: "valid" | "warning" | "stale" | "not-set"): ReadinessReport => ({ ...r, items: r.items.map((i) => (i.item === item ? { ...i, state } : i)) });
    const withBook = set(READINESS_BLANK, "Positions", "valid");
    expect(nextStepLabel(withBook)).toBe("Attach a stored snapshot");
    const withSnap = set(withBook, "Base snapshot", "warning");
    expect(nextStepLabel(withSnap)).toBe("Attach an assumption set");
    const withSet = set(withSnap, "Sets", "valid");
    // The blank fixture pins the seeded policy, as the create route does: the Routing policy step is met.
    expect(nextStepLabel(withSet)).toBe("Validate the run setup");
    // A workspace whose policy is null points at the Routing policy card on Assumptions > Sets.
    expect(nextStep(set(withSet, "Routing policy", "not-set"))).toEqual({ label: "Attach a routing policy", section: "assumptions", screen: "sets", query: { focus: "routing-policy" } });
    expect(nextStepLabel(set(withSnap, "Routing policy", "not-set"))).toBe("Attach an assumption set");
    expect(nextStepLabel(set(withSet, "Run setups", "stale"))).toBe("Validate the run setup");
    expect(nextStepLabel(set(withSet, "Run setups", "valid"))).toBe("Launch from Run setups");
  });
  it("only the routing-policy step carries the focus value; every other step and the launch carry no query", () => {
    const set = (r: ReadinessReport, item: string, state: "valid" | "not-set"): ReadinessReport => ({ ...r, items: r.items.map((i) => (i.item === item ? { ...i, state } : i)) });
    const withSet = set(set(set(READINESS_BLANK, "Positions", "valid"), "Base snapshot", "valid"), "Sets", "valid");
    expect(nextStep(set(withSet, "Routing policy", "not-set")).query).toEqual({ focus: "routing-policy" });
    for (const r of [READINESS_BLANK, set(READINESS_BLANK, "Positions", "valid"), set(set(READINESS_BLANK, "Positions", "valid"), "Base snapshot", "valid"), withSet, set(withSet, "Run setups", "valid"), null]) {
      expect(nextStep(r).query).toBeUndefined();
    }
  });
  it("roll-forward unticks targets by default and last month-end is a month end", () => {
    expect(rollForwardChecklist().targets).toBe(false); expect(rollForwardChecklist().assumptions).toBe(true);
    expect(copyChecklist().targets).toBe(true);
    expect(lastMonthEnd(new Date(Date.UTC(2026, 9, 9)))).toBe("2026-09-30");
    expect(lastMonthEnd(new Date(Date.UTC(2026, 2, 31)))).toBe("2026-02-28");
    expect(lastMonthEnd(new Date(Date.UTC(2026, 0, 15)))).toBe("2025-12-31");
    expect(lastMonthEnd(new Date(Date.UTC(2028, 2, 1)))).toBe("2028-02-29");
  });
  it("the next month-end after a cut-off date", () => {
    expect(nextMonthEnd("2026-03-31")).toBe("2026-04-30");
    expect(nextMonthEnd("2026-12-31")).toBe("2027-01-31");
    expect(nextMonthEnd("2026-01-31")).toBe("2026-02-28");
    expect(nextMonthEnd("2026-02-10")).toBe("2026-03-31");
  });
  it("overall readiness is the worst of the four launch sections", () => {
    expect(overallReadiness(READINESS)).toBe("stale");
    expect(overallReadiness(READINESS_BLANK)).toBe("not-set");
    expect(overallReadiness({ ...READINESS, sections: { ...READINESS.sections, market: "error" } })).toBe("error");
    expect(overallReadiness({ ...READINESS, sections: { workspace: "valid", market: "valid", balance: "valid", assumptions: "valid", run: "valid", results: "not-set", govern: "not-set" } })).toBe("valid");
  });
  it("a create body and a clone body carry the revision, the typed name and the checklist", () => {
    const d = newFormDefaults(new Date(Date.UTC(2026, 9, 9)));
    expect(d.cutoffDate).toBe("2026-09-30"); expect(d.type).toBe("test"); expect(d.start).toBe("blank");
    const f = { ...d, name: "Q3 test", type: "ftp" as const, owner: "ALM", by: "Chih" };
    expect(createBody(f)).toEqual({ name: "Q3 test", type: "ftp", cutoffDate: "2026-09-30", owner: "ALM", by: "Chih" });

    const copy = { ...cloneFormFor(HEAD, "copy"), name: "Copy of it", by: "Chih" };
    expect(copy.type).toBe("test");
    const b = cloneBody(copy, HEAD);
    expect(b).toEqual({ expectedRevision: 4, by: "Chih", mode: "copy", name: "Copy of it", type: "test", blocks: ["market", "positions", "targets", "assumptions", "scenarios", "run"] });
    expect("cutoffDate" in b).toBe(false);
    expect("supersedeSource" in b).toBe(false);

    const roll = { ...cloneFormFor(HEAD, "roll-forward"), name: "April", by: "Chih" };
    expect(roll.cutoffDate).toBe("2026-04-30"); expect(roll.type).toBe("monthly");
    const r = cloneBody(roll, HEAD);
    expect(r.mode).toBe("roll-forward"); expect(r.cutoffDate).toBe("2026-04-30");
    expect(r.blocks).toEqual(["market", "positions", "assumptions", "scenarios", "run"]);
    expect("supersedeSource" in r).toBe(false);
  });
  it("a Production copy of a Production month is a supersede; of any other month it is not", () => {
    expect(cloneFormFor(LOCKED, "copy").type).toBe("test");
    const fromProd = { ...cloneFormFor(LOCKED, "correct"), name: "March corrected", by: "Chih" };
    expect(fromProd.type).toBe("production");
    expect(cloneBody(fromProd, LOCKED)).toMatchObject({ mode: "copy", type: "production", supersedeSource: true, expectedRevision: 4 });
    const fromTest = { ...cloneFormFor(HEAD, "copy"), type: "production" as const, name: "Prod", by: "Chih" };
    expect("supersedeSource" in cloneBody(fromTest, HEAD)).toBe(false);
    const rolled = { ...cloneFormFor(LOCKED, "roll-forward"), name: "April", by: "Chih", type: "production" as const };
    expect("supersedeSource" in cloneBody(rolled, LOCKED)).toBe(false);
  });
  it("the form says what stops a submit", () => {
    const d = newFormDefaults(new Date(Date.UTC(2026, 9, 9)));
    expect(formProblems(d, null)).toEqual(["Name the workspace.", "Type an owner.", "Type your name: it is stamped on the history line."]);
    expect(formProblems({ ...d, name: "Q3", owner: "ALM", by: "Chih" }, null)).toEqual([]);
    const roll = { ...cloneFormFor(HEAD, "roll-forward"), by: "Chih", cutoffDate: "2026-03-31" };
    expect(formProblems(roll, HEAD)).toEqual(["A roll-forward moves the cut-off date past 2026-03-31."]);
    expect(formProblems({ ...roll, cutoffDate: "2026-04-30" }, HEAD)).toEqual([]);
    expect(formProblems({ ...d, start: "copy", name: "x", by: "Chih" }, null)).toEqual(["Choose the workspace to start from."]);
    expect(formProblems({ ...d, name: "x".repeat(81), owner: "o", by: "b" }, null)).toEqual(["The name is at most 80 characters."]);
  });
  it("switching the start mode resets the type and the date defaults", () => {
    const f = newFormDefaults(new Date(Date.UTC(2026, 9, 9)));
    expect(withStart(f, "roll-forward", HEAD).type).toBe("monthly");
    expect(withStart(f, "roll-forward", HEAD).cutoffDate).toBe("2026-04-30");
    expect(withStart(f, "roll-forward", HEAD).sourceId).toBe(HEAD.id);
    expect(withStart(f, "copy", HEAD).type).toBe("test");
    expect(withStart(f, "copy", HEAD).cutoffDate).toBe("2026-03-31");
  });
  it("history lines read as sentences", () => {
    expect(describeChange({ kind: "create" })).toBe("Created");
    expect(describeChange({ kind: "set-block", block: "positions", op: "set", ref: { collection: "portfolios", id: "book-1" } })).toBe("Set portfolios book-1 in positions");
    expect(describeChange({ kind: "set-block", block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: "s1" } })).toBe("Added assumption-sets s1 to assumptions");
    expect(describeChange({ kind: "set-block", block: "assumptions", op: "remove", ref: { collection: "assumption-sets", id: "s1" } })).toBe("Removed assumption-sets s1 from assumptions");
    expect(describeChange({ kind: "set-default", setId: "s2" })).toBe("Default assumption set is s2");
    expect(describeChange({ kind: "status", from: "active", to: "locked" })).toBe("Status active to locked");
    expect(describeChange({ kind: "lock", approvalId: "appr-1" })).toBe("Locked on approval appr-1");
    expect(describeChange({ kind: "supersede", by: "ws-x" })).toBe("Superseded by ws-x");
    expect(describeChange({ kind: "meta", name: "New name" })).toBe("Renamed to New name");
    expect(describeChange({ kind: "meta", note: "n" })).toBe("Note changed");
  });
});

describe("home", () => {
  it("home with no workspaces shows the one card, and the banner names the old address and the candidates", () => {
    expect(renderToStaticMarkup(<HomeView workspaces={[]} banner={null} />)).toContain("Create a workspace");
    const html = renderToStaticMarkup(<HomeView workspaces={[]} banner={{ oldAddress: "#/plan?book=x", candidates: ["ws-a", "ws-b"] }} />);
    expect(html).toContain("#/plan?book=x"); expect(html).toContain("ws-b");
    expect(html).toContain('href="#/ws/ws-b/workspace/overview"');
  });
  it("home lists every workspace with type, cut-off date, status and readiness, grouped by type", () => {
    const html = renderToStaticMarkup(<HomeView workspaces={[HEAD, ...OTHERS]} banner={null} readiness={{ [HEAD.id]: READINESS, "ws-prod-2026-02": null }} />);
    for (const w of [HEAD, ...OTHERS]) { expect(html).toContain(w.name); expect(html).toContain(w.cutoffDate); expect(html).toContain(`#/ws/${w.id}/workspace/overview`); }
    for (const word of ["Production", "Monthly", "Test", "Stress", "History", "Locked", "Active", "Archived"]) expect(html).toContain(word);
    expect(html).toContain("Stale");
    expect(html).not.toContain("Create a workspace");
    expect(html).toContain('href="#/workspaces/new"');
    expect(html).toContain('href="#/workspaces/compare"');
    expect(html.indexOf("February production")).toBeLessThan(html.indexOf("January monthly"));
    expect(html.indexOf("January monthly")).toBeLessThan(html.indexOf(HEAD.name));
  });
  it("no home row carries a control that changes the lock", () => {
    const html = renderToStaticMarkup(<HomeView workspaces={[LOCKED, ...OTHERS]} banner={null} />);
    expect(html).not.toMatch(/unlock|revoke/i);
  });
});

describe("new workspace", () => {
  const html = renderToStaticMarkup(<NewView workspaces={[HEAD, ...OTHERS]} today={new Date(Date.UTC(2026, 9, 9))} />);
  it("offers the five types, Test preselected, and a cut-off date at the last month-end", () => {
    for (const t of ["Production", "Test", "FTP", "Stress", "Monthly"]) expect(html).toContain(`>${t}</option>`);
    expect(html).toMatch(/<option value="test" selected="">Test<\/option>/);
    expect(html).toContain("Cut-off date");
    expect(html).toContain('value="2026-09-30"');
  });
  it("offers blank, clone and roll-forward, a name, an owner and the typed name", () => {
    for (const s of ["Blank", "Clone of a workspace", "Roll forward a workspace"]) expect(html).toContain(s);
    for (const l of ["Name", "Owner", "Your name"]) expect(html).toContain(l);
    expect(html).toContain("Create workspace");
  });
});

describe("overview", () => {
  it("overview lists the readiness items and the next-step button", () => {
    const ov = renderToStaticMarkup(<OverviewView head={HEAD} readiness={READINESS_BLANK} />);
    expect(ov).toContain("Import positions"); expect(ov).toContain("Not set"); expect(ov).toContain("cut-off");
    expect(ov).toContain('href="#/ws/ws-synthetic-2500-v1/balance/positions"');
    for (const item of ["Base snapshot", "Positions", "Sets", "Run setups"]) expect(ov).toContain(item);
    expect(ov).toContain("Draft");
  });
  it("the next-step help names the five steps in their order, routing policy included", () => {
    const ov = renderToStaticMarkup(<OverviewView head={HEAD} readiness={READINESS_BLANK} />);
    expect(ov).toContain("The first requirement still open for a first run, in the order positions, base snapshot, assumption set, routing policy, run setup.");
  });
  it("the routing-policy next step links to Assumption sets with focus=routing-policy; another step's link has no focus", () => {
    const noPolicy: ReadinessReport = {
      ...READINESS_BLANK,
      items: READINESS_BLANK.items.map((i) => (i.item === "Routing policy" ? { ...i, state: "not-set" as const } : i.required ? { ...i, state: "valid" as const } : i)),
    };
    const ov = renderToStaticMarkup(<OverviewView head={HEAD} readiness={noPolicy} />);
    expect(ov).toContain('href="#/ws/ws-synthetic-2500-v1/assumptions/sets?focus=routing-policy">Attach a routing policy</a>');
    const blank = renderToStaticMarkup(<OverviewView head={HEAD} readiness={READINESS_BLANK} />);
    expect(blank).toContain('href="#/ws/ws-synthetic-2500-v1/balance/positions">Import positions</a>');
    expect(blank).not.toContain("focus=");
  });
  it("the checklist prints all six states as words", () => {
    const all: ReadinessReport = {
      ...READINESS_BLANK,
      items: (["not-set", "draft", "valid", "warning", "error", "stale"] as const).map((state, i) => ({ section: "market" as const, item: `Item ${i}`, state, required: true, detail: `detail ${i}` })),
    };
    const ov = renderToStaticMarkup(<OverviewView head={HEAD} readiness={all} />);
    for (const w of ["Not set", "Draft", "Valid", "Warning", "Error", "Stale"]) expect(ov).toContain(`>${w}</span>`);
  });
  it("shows the manifest facts, the block summary and the history, newest first", () => {
    const history: HistoryLine[] = [
      { revision: 1, at: "2026-10-09T09:00:00.000Z", by: "seed", change: { kind: "create" }, manifest: HEAD },
      { revision: 2, at: "2026-10-09T09:05:00.000Z", by: "Chih", change: { kind: "set-default", setId: "demo-behavioral-v1" }, manifest: HEAD },
    ];
    const ov = renderToStaticMarkup(<OverviewView head={HEAD} readiness={READINESS} history={history} />);
    expect(ov).toContain("ws-synthetic-2500-v1"); expect(ov).toContain("2026-03-31"); expect(ov).toContain("synthetic-2500-v1");
    expect(ov).toContain("market-public-2026-03-31");
    expect(ov).toContain("Default assumption set is demo-behavioral-v1");
    expect(ov.indexOf("Default assumption set")).toBeLessThan(ov.indexOf(">Created</td>"));
    expect(ov).toContain("History");
  });
  it("sign-off appears for Production only and says it locks", () => {
    const prod = renderToStaticMarkup(<OverviewView head={PRODUCTION} readiness={READINESS} />);
    expect(prod).toContain("Sign-off");
    expect(prod).toMatch(/locks/);
    expect(prod).toContain("#/ws/ws-prod-2026-03/govern/approvals");
    for (const t of ["test", "ftp", "stress", "monthly"] as const) {
      const ov = renderToStaticMarkup(<OverviewView head={{ ...HEAD, type: t }} readiness={READINESS} />);
      expect(ov).not.toContain("Sign-off");
      expect(ov).not.toMatch(/locks this/i);
    }
  });
  it("a locked workspace shows its clone-to-correct path and no control that changes the lock", () => {
    const ov = renderToStaticMarkup(<OverviewView head={LOCKED} readiness={READINESS} />);
    expect(ov).toContain("appr-1");
    expect(ov).toContain("Clone to correct");
    expect(ov).toContain("supersede");
    for (const head of [PRODUCTION, LOCKED, { ...HEAD, status: "superseded" as const }, { ...HEAD, status: "archived" as const }]) {
      expect(renderToStaticMarkup(<OverviewView head={head} readiness={READINESS} />)).not.toMatch(/unlock|revoke/i);
    }
  });
  it("archive is offered on an active or locked workspace and not on an archived or superseded one", () => {
    expect(renderToStaticMarkup(<OverviewView head={HEAD} readiness={READINESS} />)).toContain("Archive workspace");
    expect(renderToStaticMarkup(<OverviewView head={LOCKED} readiness={READINESS} />)).toContain("Archive workspace");
    expect(renderToStaticMarkup(<OverviewView head={{ ...HEAD, status: "archived" }} readiness={READINESS} />)).not.toContain("Archive workspace");
    const sup = renderToStaticMarkup(<OverviewView head={{ ...HEAD, status: "superseded", lineage: { ...HEAD.lineage, supersededBy: "ws-new" } }} readiness={READINESS} />);
    expect(sup).not.toContain("Archive workspace");
    expect(sup).toContain("ws-new");
  });
  it("a readiness read that failed says so and still shows the manifest", () => {
    const ov = renderToStaticMarkup(<OverviewView head={HEAD} readiness={null} />);
    expect(ov).toContain("Readiness could not be read");
    expect(ov).toContain("ws-synthetic-2500-v1");
  });
});

describe("compare", () => {
  const reply: WorkspaceCompareReply = {
    a: { id: "ws-a", name: "March", type: "monthly", status: "active", cutoffDate: "2026-03-31", revision: 3, signedHash: "a".repeat(64) },
    b: { id: "ws-b", name: "April", type: "monthly", status: "active", cutoffDate: "2026-04-30", revision: 5, signedHash: "b".repeat(64) },
    blocks: {
      market: { verdict: "same" },
      positions: { verdict: "changed", a: [["portfolios", "book-mar", "h1"]], b: [["portfolios", "book-apr", "h2"]] },
      targets: { verdict: "only-a" },
      assumptions: { verdict: "changed", a: [["assumption-sets", "s1", "h3"], ["default", "s1"]], b: [["assumption-sets", "s2", "h4"], ["default", "s2"]] },
      scenarios: { verdict: "only-b" },
      run: { verdict: "changed", a: [["run-setups", "setup-standard-alco", "rs-1", "h5"]], b: [["run-setups", "setup-standard-alco", "rs-2", "h6"]] },
    },
  };
  const html = renderToStaticMarkup(<WorkspaceCompareView reply={reply} workspaces={[HEAD, ...OTHERS]} newestDone={{ a: "run-a", b: "run-b" }} />);
  it("prints a verdict word per block and both entry lists for a changed block", () => {
    for (const w of ["Same", "Changed", "Only in A", "Only in B"]) expect(html).toContain(w);
    for (const b of ["Market", "Positions", "Targets", "Assumptions", "Scenarios", "Run"]) expect(html).toContain(b);
    expect(html).toContain("book-mar"); expect(html).toContain("book-apr");
    expect(html).toContain("ws-a"); expect(html).toContain("2026-04-30");
  });
  it("drills a changed assumption block into the default sets, and a changed run block into Results Compare", () => {
    expect(html).toContain('href="#/ws/ws-a/assumptions/sets?base=s1&amp;layers=s2"');
    expect(html).toContain('href="#/ws/ws-a/results/compare?runs=run-a%2Crun-b"');
  });
  it("says so when a side has no done run, and prints the picker for both sides", () => {
    const none = renderToStaticMarkup(<WorkspaceCompareView reply={reply} workspaces={[HEAD]} newestDone={{ a: null, b: "run-b" }} />);
    expect(none).toContain("no done run");
    expect(none).not.toContain("results/compare");
    expect(none).toContain("Workspace A");
    expect(none).toContain("Workspace B");
  });
  it("with no pair chosen it asks for two workspaces", () => {
    const empty = renderToStaticMarkup(<WorkspaceCompareView reply={null} workspaces={[HEAD, ...OTHERS]} newestDone={{ a: null, b: null }} />);
    expect(empty).toContain("Choose two workspaces");
  });
});
