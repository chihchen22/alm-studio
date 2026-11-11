/**
 * The Single instrument screen (ALM Studio A+E Slice 1, Task E6; spec v3.1 Section 5.3 and 6.2; rulings 15 and the
 * Single-instrument run section). The drill reads one position of THIS workspace's book, computes on the fly and
 * stores nothing; it stays open on a locked workspace. Studio tests have no DOM: pure functions, static markup and
 * file reads. Expected texts and values are restated here, never read from the code under test.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { PositionsPage, WorkspaceManifest } from "@alm/reader";
import {
  csvFileName, csvHref, defaultForm, drillRequest, libraryOffer, libraryRefsOf, marketOptions, pageWindow, positionsQuery,
  positionsRequest, scheduleCsv, type InstrumentForm,
} from "../rows/instrumentRows";
import {
  InstrumentResultView, PositionPickerView, ScenarioPickerView, SingleInstrumentView, type SingleInstrumentViewProps,
} from "../pages/run/SingleInstrumentView";
import { SingleInstrumentPage } from "../pages/run/SingleInstrumentPage";
import { pageFor } from "../pages/pageFor";
import { HEAD } from "./fixtures/workspace";
import { DRILL, S0, SWAP_DRILL } from "./fixtures/drill";

const NOOP = () => {};
const ON = { form: NOOP, filter: NOOP, project: NOOP, scenario: NOOP };

const LOCKED: WorkspaceManifest = {
  ...HEAD,
  id: "ws-prod-2026-02",
  type: "production",
  status: "locked",
  lock: { lockedAt: "2026-03-05T10:00:00.000Z", by: "ALM", approvalId: "appr-1", signedHash: "signed-hash" },
};

const PAGE: PositionsPage = {
  total: 120, limit: 50, offset: 0,
  rows: [
    { id: "loan-1", familyId: "cre-fixed", coaNodeId: "n1", instrumentType: "fixed-loan", notional: 1000000, maturityMonths: 60 },
    { id: "loan-2", familyId: "cre-fixed", coaNodeId: "n1", instrumentType: "fixed-loan", notional: 2500000 },
  ],
};

function props(head: WorkspaceManifest, over: Partial<SingleInstrumentViewProps> = {}): SingleInstrumentViewProps {
  return {
    head,
    form: { ...defaultForm(head, {}), positionId: "loan-1" },
    filter: { q: "", offset: 0 },
    positions: { state: "ok", page: PAGE },
    library: { state: "none", reason: "no setup chosen" },
    run: { state: "idle" },
    on: ON,
    ...over,
  };
}
const view = (p: SingleInstrumentViewProps) => renderToStaticMarkup(<SingleInstrumentView {...p} />);

describe("the positions query", () => {
  it("is bounded at 50 and carries only the filters that are set, in the route's order", () => {
    expect(positionsQuery({ q: "mtg", familyId: "mortgages" })).toBe("q=mtg&familyId=mortgages&limit=50&offset=0");
    expect(positionsQuery({})).toBe("limit=50&offset=0");
    expect(positionsQuery({ q: "", instrumentType: "mortgage", offset: 100 })).toBe("instrumentType=mortgage&limit=50&offset=100");
    expect(positionsQuery({ coaNodeId: "n1", familyId: "f" })).toBe("familyId=f&coaNodeId=n1&limit=50&offset=0");
  });
  it("never asks for an unbounded list", () => {
    expect(positionsRequest({}).limit).toBe(50);
    expect(positionsRequest({ q: "a", offset: 50 })).toEqual({ q: "a", limit: 50, offset: 50 });
  });
  it("windows a page by the filtered total", () => {
    expect(pageWindow({ total: 2351, limit: 50, offset: 100, rows: new Array(50).fill(0) })).toEqual({ from: 101, to: 150, total: 2351, hasPrev: true, hasNext: true, prevOffset: 50, nextOffset: 150 });
    expect(pageWindow({ total: 120, limit: 50, offset: 100, rows: new Array(20).fill(0) })).toEqual({ from: 101, to: 120, total: 120, hasPrev: true, hasNext: false, prevOffset: 50, nextOffset: 150 });
    expect(pageWindow({ total: 0, limit: 50, offset: 0, rows: [] })).toEqual({ from: 0, to: 0, total: 0, hasPrev: false, hasNext: false, prevOffset: 0, nextOffset: 50 });
  });
});

describe("the instrument picker", () => {
  const picker = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <PositionPickerView
        bookId="synthetic-2500-v1"
        filter={{ q: "loan", offset: 0 }}
        positions={{ state: "ok", page: PAGE }}
        selectedId="loan-2"
        onFilter={NOOP}
        onPick={NOOP}
        {...over}
      />,
    );
  it("is a type-ahead over the paginated positions of this workspace's book", () => {
    const html = picker();
    expect(html).toContain('type="search"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="loan"');
    expect(html).toContain("Positions of synthetic-2500-v1");
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*role="option"[^>]*aria-selected="true"[^>]*>[^<]*loan-2/);
    expect(html).toContain("Showing 1 to 2 of 120 positions");
    expect(html).toContain("start of the position id");
  });
  it("pages: Previous is off on the first page and Next is on while rows remain", () => {
    const html = picker();
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Previous</);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Next</);
    const last = picker({ positions: { state: "ok", page: { ...PAGE, total: 52, offset: 50 } } });
    expect(last).toMatch(/<button(?![^>]*disabled)[^>]*>Previous</);
    expect(last).toMatch(/<button[^>]*disabled[^>]*>Next</);
  });
  it("says so when no position matches, and prints a refusal verbatim", () => {
    expect(picker({ positions: { state: "ok", page: { total: 0, limit: 50, offset: 0, rows: [] } } })).toContain("No position of this book starts with that text.");
    expect(picker({ positions: { state: "error", message: "404: portfolio not found" } })).toContain("404: portfolio not found");
  });
  it("names the missing book when the workspace holds no positions", () => {
    const html = picker({ bookId: null, positions: { state: "none" } });
    expect(html).toContain("This workspace holds no positions");
  });
});

describe("the scenario picker", () => {
  const picker = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <ScenarioPickerView
        arm="slate"
        slateIds={["slate-a", "slate-b"]}
        slateId="slate-b"
        shockBp="0"
        setupIds={["setup-standard-alco"]}
        setupLineageId="setup-standard-alco"
        library={{ state: "refs", refs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S200"], setupName: "Standard ALCO" }}
        onChange={NOOP}
        {...over}
      />,
    );
  it("offers the workspace's slates, one parallel shock, and the library scenarios of the chosen setup", () => {
    const html = picker();
    expect(html).toContain("Workspace slates");
    expect(html).toContain("One parallel shock");
    expect(html).toContain("Library scenarios of the chosen setup");
    expect(html).toMatch(/<option value="slate-b" selected/);
  });
  it("shows the refs a library setup resolves to, and which setup they came from", () => {
    const html = picker({ arm: "library" });
    expect(html).toContain("regulatory-grid-v1#S0");
    expect(html).toContain("regulatory-grid-v1#S200");
    expect(html).toContain("Standard ALCO");
  });
  it("a shock arm prints the bp input", () => {
    const html = picker({ arm: "shock", shockBp: "125" });
    expect(html).toContain('value="125"');
    expect(html).toContain("bp");
  });
  it("a setup whose scenarios are not a list of library refs says why the arm has nothing", () => {
    const html = picker({ arm: "library", library: { state: "none", reason: "This setup's scenarios are a stored slate" } });
    expect(html).toContain("a stored slate");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Library scenarios of the chosen setup</);
  });
});

describe("library refs of a setup", () => {
  it("reads a library arm, and a plan-scenarios list only when every item is a ref", () => {
    expect(libraryRefsOf({ kind: "library", refs: ["regulatory-grid-v1#S0"] })).toEqual(["regulatory-grid-v1#S0"]);
    expect(libraryRefsOf({ kind: "plan-scenarios", items: [{ ref: "a#S0" }, { ref: "a#S1" }] })).toEqual(["a#S0", "a#S1"]);
    expect(libraryRefsOf({ kind: "plan-scenarios", items: [{ ref: "a#S0" }, { id: "X", label: "x", rateSpec: { kind: "base" } } as never] })).toBeNull();
    expect(libraryRefsOf({ kind: "slate", slateId: "s", include: "all" })).toBeNull();
    expect(libraryRefsOf({ kind: "library", refs: [] })).toBeNull();
  });
});

describe("the library offer of a setup", () => {
  it("is the refs and the setup's name, or the reason in words", () => {
    expect(libraryOffer("Standard ALCO", { kind: "library", refs: ["regulatory-grid-v1#S0"] })).toEqual({ state: "refs", refs: ["regulatory-grid-v1#S0"], setupName: "Standard ALCO" });
    expect(libraryOffer("Edit 2", { kind: "slate", slateId: "s", include: "all" })).toEqual({ state: "none", reason: "The scenarios of Edit 2 are a stored slate; use Workspace slates." });
    expect(libraryOffer("Edit 3", { kind: "plan-scenarios", items: [{ id: "X", label: "x", rateSpec: { kind: "base" } } as never] })).toEqual({
      state: "none", reason: "The scenarios of Edit 3 include an inline definition, which the library arm cannot reproduce.",
    });
    expect(libraryOffer("Empty", { kind: "library", refs: [] })).toEqual({ state: "none", reason: "Empty names no library scenarios." });
  });
});

describe("the drill request", () => {
  const base: InstrumentForm = defaultForm(HEAD, {});
  it("picks the position of the head's own book, the head's market and 360 months at 100 bp", () => {
    expect(base.marketId).toBe("market-public-2026-03-31");
    expect(base.horizonMonths).toBe("360");
    expect(base.durationBumpBp).toBe("100");
    const r = drillRequest({ ...base, positionId: "loan-1", arm: "shock", shockBp: "50" }, "synthetic-2500-v1", null);
    expect(r).toEqual({
      ok: true,
      // With no setup named, the convention a new setup carries.
      body: { instrument: { portfolioId: "synthetic-2500-v1", positionId: "loan-1" }, marketId: "market-public-2026-03-31", scenarios: { parallelShockBp: 50 }, horizonMonths: 360, durationBumpBp: 100, modelConvention: "corrected-v1" },
    });
  });
  it("sends the chosen setup's model convention (K1 fix round M1)", () => {
    expect(drillRequest({ ...base, positionId: "p", arm: "shock", shockBp: "0" }, "b", null, "book")).toMatchObject({ ok: true, body: { modelConvention: "book" } });
  });
  it("sends a slate, a library ref list and an assumption set when each is chosen", () => {
    const slate = drillRequest({ ...base, positionId: "p", arm: "slate", slateId: "slate-a", assumptionSetId: "demo-behavioral-v1" }, "b", null);
    expect(slate).toMatchObject({ ok: true, body: { scenarios: { scenarioSlateId: "slate-a" }, assumptionSetId: "demo-behavioral-v1" } });
    const lib = drillRequest({ ...base, positionId: "p", arm: "library" }, "b", ["regulatory-grid-v1#S0"]);
    expect(lib).toMatchObject({ ok: true, body: { scenarios: { libraryRefs: ["regulatory-grid-v1#S0"] } } });
  });
  it("refuses, in words, what the route would refuse", () => {
    expect(drillRequest({ ...base, positionId: "" }, "b", null)).toEqual({ ok: false, reason: "Pick a position first." });
    expect(drillRequest({ ...base, positionId: "p", arm: "library" }, "b", null)).toEqual({ ok: false, reason: "The chosen setup has no library scenarios to reproduce." });
    expect(drillRequest({ ...base, positionId: "p", horizonMonths: "361" }, "b", null)).toEqual({ ok: false, reason: "Horizon must be a whole number of months from 1 to 360." });
    expect(drillRequest({ ...base, positionId: "p", durationBumpBp: "abc" }, "b", null)).toEqual({ ok: false, reason: "Duration bump must be a number of basis points above zero." });
    expect(drillRequest({ ...base, positionId: "p", arm: "shock", shockBp: "" }, "b", null)).toEqual({ ok: false, reason: "The parallel shock must be a number of basis points." });
    expect(drillRequest({ ...base, positionId: "p" }, null, null)).toEqual({ ok: false, reason: "This workspace holds no positions; type the terms instead." });
    expect(drillRequest({ ...base, positionId: "p", marketId: "" }, "b", null)).toEqual({ ok: false, reason: "This workspace holds no market snapshot." });
  });
  it("types a fixed or a floating loan and sends the terms with their family and side", () => {
    const typed = { ...base, source: "typed" as const };
    const fixed = drillRequest(typed, null, null);
    expect(fixed).toMatchObject({
      ok: true,
      body: {
        instrument: { familyId: "typed", side: "asset", terms: { id: "typed-1", type: "fixed-loan", notional: 1000000, maturityMonths: 60, originationOffsetMonths: 0, amortType: "level-pay", coupon: 0.06 } },
      },
    });
    const floating = drillRequest({ ...typed, typed: { ...typed.typed, type: "floating-loan", margin: "0.02", resetFrequencyMonths: "6" } }, null, null);
    expect(floating).toMatchObject({ ok: true, body: { instrument: { terms: { type: "floating-loan", margin: 0.02, resetFrequencyMonths: 6, indexTenorMonths: 1 } } } });
    expect(drillRequest({ ...typed, typed: { ...typed.typed, notional: "x" } }, null, null)).toEqual({ ok: false, reason: "Notional must be a number." });
  });
});

describe("market options", () => {
  it("lists the base snapshot first and then the derived markets by their ids", () => {
    expect(marketOptions(HEAD).map((o) => o.id)).toEqual(["market-public-2026-03-31", "macro-demo-v1", "tlp-shock-demo-v1", "vol-shock-demo-v1"]);
    expect(marketOptions(HEAD)[0]!.label).toBe("market-public-2026-03-31 (base snapshot)");
  });
});

describe("the discounted cash flow result", () => {
  const html = (over: Partial<Parameters<typeof InstrumentResultView>[0]> = {}) =>
    renderToStaticMarkup(<InstrumentResultView drill={DRILL} cutoffDate="2026-03-31" scenarioIndex={0} onScenario={NOOP} {...over} />);

  it("prints monthly cash flows with both discount factors and the row PVs, as the engine returned them", () => {
    const out = html();
    for (const h of ["Month", "Payment", "DF all-in", "DF risk-free", "PV all-in", "PV risk-free"]) expect(out).toContain(`>${h}<`);
    const r = S0.rows[0]!;
    // The raw value rides in the cell's title; the cell prints its rounded text.
    expect(out).toContain(`title="${String(r.discountFactorAllIn)}"`);
    expect(out).toContain(`title="${String(r.discountFactorRiskFree)}"`);
    expect(out).toContain(`title="${String(r.pvAllIn)}"`);
    expect(out).toContain(`title="${String(r.pvRiskFree)}"`);
    expect(out).toContain(">0.991235<");
    expect(out.match(/<tr/g)!.length).toBeGreaterThanOrEqual(1 + S0.rows.length);
  });
  it("states the PV total as of the cut-off date, from the engine's scenario totals", () => {
    const out = html();
    expect(out).toContain("Present value as of 2026-03-31");
    expect(out).toContain(`title="${String(S0.pvAllIn)}"`);
    expect(out).toContain(`title="${String(S0.pvRiskFree)}"`);
  });
  it("labels the run as one position on contractual runoff and says nothing is saved", () => {
    const out = html();
    expect(out).toContain("single position, contractual runoff");
    expect(out).toContain("the balance sheet basis is a book-level setting");
    expect(out).toContain("stores nothing");
    expect(out).toContain("Not saved");
  });
  it("a swap prints the engine's discount basis note and its two legs", () => {
    const out = renderToStaticMarkup(<InstrumentResultView drill={SWAP_DRILL} cutoffDate="2026-03-31" scenarioIndex={0} onScenario={NOOP} />);
    expect(out).toContain("swap: risk-free on both bases");
    expect(out).toContain("Receive leg");
    expect(out).toContain("Pay leg");
    expect(html()).not.toContain("swap: risk-free on both bases");
  });
  it("one tab per scenario, the shown one selected", () => {
    const out = html({ scenarioIndex: 1 });
    expect(out).toMatch(/<button[^>]*aria-selected="true"[^>]*>S200</);
    expect(out).toMatch(/<button[^>]*aria-selected="false"[^>]*>S0</);
    expect(out).toContain("S200");
  });
  it("counts the rows with a singular for one (Studio Part 2 m8)", () => {
    expect(html()).toContain("3 rows, exactly as served");
    const swap = renderToStaticMarkup(<InstrumentResultView drill={SWAP_DRILL} cutoffDate="2026-03-31" scenarioIndex={0} onScenario={NOOP} />);
    expect(swap).toContain("1 row, exactly as served");
    expect(swap).toContain("Receive leg (1 row, signed as served)");
  });
  it("exports the on-screen rows as CSV from the client, with no server call behind the link", () => {
    const out = html();
    const href = csvHref(scheduleCsv(S0));
    expect(out).toContain(`href="${href}"`);
    expect(out).toContain(`download="${csvFileName("loan-7", "S0", "2026-03-31")}"`);
    expect(out).toContain("Download CSV");
    expect(href.startsWith("data:text/csv;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(href.slice("data:text/csv;charset=utf-8,".length))).toBe(scheduleCsv(S0));
  });
});

describe("the schedule CSV", () => {
  it("is the received rows joined with commas, the engine's columns and nothing computed", () => {
    const csv = scheduleCsv(S0);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("month,pathRate,couponRate,balance,principal,interest,payment,discountFactorAllIn,discountFactorRiskFree,pvAllIn,pvRiskFree");
    expect(lines[1]).toBe("1,0.0425,0.06,985000,15000,5000,20000,0.99123456,0.99654321,19824.6912,19930.8642");
    expect(lines).toHaveLength(1 + S0.rows.length + 1);
    expect(lines[lines.length - 1]).toBe("");
  });
  it("names the file by position, scenario and cut-off", () => {
    expect(csvFileName("loan-7", "S0", "2026-03-31")).toBe("loan-7-S0-2026-03-31-dcf.csv");
    expect(csvFileName("a/b c", "S+200", "2026-03-31")).toBe("a_b_c-S_200-2026-03-31-dcf.csv");
  });
});

describe("a locked workspace", () => {
  it("leaves the screen enabled: the Project button and every control are as on an open workspace", () => {
    const open = view(props(HEAD));
    const locked = view(props(LOCKED));
    expect(locked).toMatch(/<button[^>]*type="button"[^>]*>Project</);
    expect(locked).not.toMatch(/<button[^>]*disabled[^>]*>Project</);
    expect(open).not.toMatch(/<button[^>]*disabled[^>]*>Project</);
    // Same disabled count on both: nothing here is switched off by the lock.
    expect(locked.match(/disabled/g)?.length ?? 0).toBe(open.match(/disabled/g)?.length ?? 0);
  });
  it("says the drill stays open, and says nothing is saved", () => {
    const locked = view(props(LOCKED));
    expect(locked).toContain("locked");
    expect(locked).toContain("stays open");
    expect(locked).toContain("stores nothing");
    expect(view(props(HEAD))).not.toContain("stays open");
  });
  it("the page itself renders on a locked head", () => {
    const out = renderToStaticMarkup(<SingleInstrumentPage head={LOCKED} query={{}} />);
    expect(out).toContain("stays open");
    expect(out).toContain("synthetic-2500-v1");
    expect(out).not.toMatch(/<button[^>]*disabled[^>]*>Project</);
  });
});

describe("no write controls", () => {
  it("the screen offers no save, launch, sign-off, import, clone or attach control", () => {
    const out = view(props(LOCKED, { run: { state: "ok", drill: DRILL, scenarioIndex: 0 } }));
    expect(out).not.toContain("<form");
    expect(out).not.toContain('type="submit"');
    const labels = [...out.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
    for (const l of labels) expect(l).not.toMatch(/^(Save|Launch|Sign|Import|Clone|Archive|Attach|Delete|Set |Add|Remove|Apply)/);
  });
  it("its modules import only reads from the reader and never post, store or fetch directly", () => {
    const files = ["../pages/run/SingleInstrumentPage.tsx", "../pages/run/SingleInstrumentView.tsx", "../rows/instrumentRows.ts"];
    const allowed = new Set([
      "listPositions", "getRunSetup", "projectInstrument", "legTables", "sig", "usd", "pct",
      "ApiError", "InstrumentDrill", "InstrumentScenarioProjectionView", "InstrumentScheduleRowView", "ListPositionsQuery",
      "PositionRow", "PositionsPage", "ProjectInstrumentRequest", "RunSetup", "SetupScenarios", "WorkspaceManifest",
      "DerivedRef", "DocRef", "SetupSlot",
    ]);
    for (const f of files) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8");
      for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"@alm\/reader"/g)) {
        const names = m[1]!.split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter((s) => s !== "");
        for (const n of names) expect(allowed.has(n), `${f} imports ${n}`).toBe(true);
      }
      expect(text).not.toMatch(/\bfetch\(|localStorage|sessionStorage|XMLHttpRequest|method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
  });
  it("carries no em-dash and no section sign, and its stylesheet holds tokens only", () => {
    const files = ["../pages/run/SingleInstrumentPage.tsx", "../pages/run/SingleInstrumentView.tsx", "../rows/instrumentRows.ts", "../pages/run/singleInstrument.css"];
    for (const f of files) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(text.includes(String.fromCharCode(0x2014)), f).toBe(false);
      expect(text.includes(String.fromCharCode(0xa7)), f).toBe(false);
    }
    const css = readFileSync(new URL("../pages/run/singleInstrument.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgba?|hsla?|oklch|lab|lch)\(/);
  });
});

describe("the frame routes run/instrument to this page", () => {
  it("returns SingleInstrumentPage with the head and the page query", () => {
    const el = pageFor({ kind: "screen", ws: HEAD.id, section: "run", screen: "instrument", query: { position: "loan-9" } } as never, HEAD) as ReactElement<{ head: WorkspaceManifest; query: Record<string, string> }>;
    expect((el.type as { name: string }).name).toBe("SingleInstrumentPage");
    expect(el.props.head).toBe(HEAD);
    expect(el.props.query.position).toBe("loan-9");
  });
  it("a position named in the query is the form's starting pick", () => {
    expect(defaultForm(HEAD, { position: "loan-9" }).positionId).toBe("loan-9");
    expect(defaultForm(HEAD, {}).positionId).toBe("");
  });
});
