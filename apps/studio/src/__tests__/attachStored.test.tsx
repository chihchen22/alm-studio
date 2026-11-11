/**
 * First run from a blank workspace (final review M1, spec v3.1 Section 3.6): the market snapshot, a balance plan and a
 * scenario slate are attached from the store on their own screens, through the block-write route Positions and
 * Assumptions already use. Studio tests have no DOM: pure bodies, the server render and the pageFor table. Every
 * expected body, option and sentence is restated here by hand.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { MarketListItem, PortfolioListItem, ScenarioSlate, WorkspaceManifest } from "@alm/reader";
import {
  authoredSlateOptions, baseSnapshotOptions, bookOptions, derivedMarketOptions, marketAddBody, marketSetBody, planSavedWrite, positionsSetBody, slateAddBody,
  targetsAddBody, writeBlock,
} from "../controls/attachBodies";
import { BalancePage } from "../pages/balance/BalancePage";
import { AttachStoredView, attachWhy, listDeps, listToShow } from "../controls/AttachStored";
import { DerivedAttach, MarketPage, SnapshotAttach } from "../pages/market/MarketPage";
import { PlansAttach } from "../pages/balance/TargetsPage";
import { SlatesAttach } from "../pages/scenarios/ScenariosPage";
import type { LoadState } from "../useLoad";
import { pageFor } from "../pages/pageFor";
import { nextStepLabel } from "../rows/workspaceRows";
import type { Route } from "../router";
import { HEAD, READINESS } from "./fixtures/workspace";

// The server render never runs an effect, so the stored list would stay "loading" and the card would never draw. The
// mock hands the control a loaded list when a test sets one, and passes every other read through untouched.
const forced = vi.hoisted(() => ({ value: null as LoadState<unknown> | null }));
vi.mock("../useLoad", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../useLoad")>();
  return { ...actual, useLoad: (...args: Parameters<typeof actual.useLoad>) => { const real = actual.useLoad(...args); return (forced.value ?? real) as typeof real; } };
});
afterEach(() => { forced.value = null; });

const BLANK: WorkspaceManifest = {
  ...HEAD,
  id: "ws-blank",
  revision: 3,
  blocks: {
    ...HEAD.blocks,
    market: { ...HEAD.blocks.market, snapshot: null, derived: [] },
    targets: { balancePlans: [], templates: [] },
    scenarios: { slates: [] },
  },
};

describe("block bodies", () => {
  it("market set, targets add and scenarios add, each at the head revision with the typed name", () => {
    expect(marketSetBody(BLANK, "market-public-2026-03-31", "Chih")).toEqual({ expectedRevision: 3, by: "Chih", block: "market", op: "set", ref: { collection: "market", id: "market-public-2026-03-31" } });
    expect(targetsAddBody(BLANK, "balance-targets-demo-v1", "Chih")).toEqual({ expectedRevision: 3, by: "Chih", block: "targets", op: "add", ref: { collection: "plans", id: "balance-targets-demo-v1" } });
    expect(slateAddBody(BLANK, "slate-steep", "Chih")).toEqual({ expectedRevision: 3, by: "Chih", block: "scenarios", op: "add", ref: { collection: "scenario-slates", id: "slate-steep" } });
  });
  it("a plan saved on Strategy is added to the targets block, or the page says why it was not", () => {
    expect(planSavedWrite(BLANK, "bp-x-edit-1", "Chih")).toEqual({ expectedRevision: 3, by: "Chih", block: "targets", op: "add", ref: { collection: "plans", id: "bp-x-edit-1" } });
    expect(planSavedWrite(BLANK, "bp-x-edit-1", "  ")).toBe("Saved bp-x-edit-1 in the store. Type your name and attach it below to add it to this workspace.");
  });
});

describe("the stored choices", () => {
  it("base snapshots only: a derived market is added on its own screen, never set as the base", () => {
    const list: MarketListItem[] = [
      { id: "market-public-2026-03-31", label: "Public 2026-03-31", calibrationDate: "2026-03-31" },
      { id: "tlp-shock-demo-v1", derivedFromMarketId: "market-public-2026-03-31" },
      { id: "market-2025-12-31", calibrationDate: "2025-12-31" },
    ];
    expect(baseSnapshotOptions(list)).toEqual([
      { id: "market-public-2026-03-31", label: "Public 2026-03-31 (2026-03-31)" },
      { id: "market-2025-12-31", label: "2025-12-31" },
    ]);
  });
  it("authored slates only: the launch slate the server writes for a plan run is left out", () => {
    const slates: ScenarioSlate[] = [
      { id: "slate-steep", label: "Steepener", scenarios: [] },
      { id: "plan-plan-synthetic-2500-v1", label: "Scenarios of plan plan-synthetic-2500-v1", scenarios: [] },
      { id: "plan-like", label: "Analyst slate named plan-like", scenarios: [] },
    ];
    expect(authoredSlateOptions(slates).map((s) => s.id)).toEqual(["slate-steep", "plan-like"]);
  });
});

describe("the attach control", () => {
  it("lists the stored choices the block does not hold, with the typed name and an Attach button", () => {
    const html = renderToStaticMarkup(
      <AttachStoredView title="Market snapshot of this workspace" selectLabel="Attach a stored snapshot" current="No snapshot is attached." foot="Source: /api/market"
        stored={[{ id: "m1", label: "One" }, { id: "m2", label: "m2" }]} attachedIds={["m2"]} by="Chih" busy={false} note={null} onAttach={() => {}} onBy={() => {}} />,
    );
    expect(html).toContain("Market snapshot of this workspace");
    expect(html).toContain('aria-label="Attach a stored snapshot"');
    expect(html).toContain('<option value="m1">m1: One</option>');
    expect(html).not.toContain('<option value="m2">');
    expect(html).toContain("No snapshot is attached.");
    expect(html).toContain(">Attach</button>");
  });
});

describe("Market > Yield curves on a blank workspace", () => {
  it("says the workspace holds no snapshot, blames no catalog, offers the attach control and the workbook import under it", () => {
    const html = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section="curves" head={BLANK} onChanged={() => {}} />);
    expect(html).toContain("No market snapshot is attached to this workspace. Attach a stored snapshot or import a workbook below.");
    expect(html).not.toContain("/api/catalog");
    expect(html).toContain("Import a market workbook into this workspace");
    expect(html).toContain("Reading the stored market snapshots");
  });
  it("on Volatility surfaces the empty state points to Yield curves", () => {
    const html = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section="vols" head={BLANK} onChanged={() => {}} />);
    expect(html).toContain("No market snapshot is attached to this workspace.");
    expect(html).toContain('href="#/ws/ws-blank/market/curves"');
  });
  it("Overview's next step reads Attach a stored snapshot", () => {
    const blank = { ...READINESS, items: READINESS.items.map((i) => (i.item === "Base snapshot" ? { ...i, state: "not-set" as const } : i.item === "Positions" ? { ...i, state: "valid" as const } : i)) };
    expect(nextStepLabel(blank)).toBe("Attach a stored snapshot");
  });
});

describe("pageFor hands the three screens the head and the refresh", () => {
  const route = (section: string, screen: string, query: Record<string, string> = {}): Route => ({ kind: "screen", ws: BLANK.id, section, screen, query }) as Route;
  const refresh = () => {};
  const env = { workspaces: [BLANK], readiness: null, refresh };
  for (const [section, screen, query] of [["market", "curves", {}], ["balance", "strategy", {}], ["run", "scenarios", {}], ["run", "scenarios", { tab: "rate" }]] as const) {
    it(`${section}/${screen}${"tab" in query ? " tab rate" : ""}`, () => {
      const el = pageFor(route(section, screen, query), BLANK, env) as ReactElement<{ head?: WorkspaceManifest | null; onChanged?: () => void }>;
      expect(el.props.head).toBe(BLANK);
      expect(el.props.onChanged).toBe(refresh);
    });
  }
});

describe("the attach hint", () => {
  const view = (over: Partial<Parameters<typeof AttachStoredView>[0]> = {}) =>
    renderToStaticMarkup(
      <AttachStoredView title="Market snapshot of this workspace" selectLabel="Attach a stored snapshot" current="No snapshot is attached." foot="Source: /api/market"
        stored={[{ id: "m1", label: "One" }]} attachedIds={[]} by="Chih" busy={false} note={null} onAttach={() => {}} onBy={() => {}} {...over} />,
    );
  it("says what is missing beside a button that is off because nothing is picked", () => {
    const html = view();
    expect(html).toContain("Pick a stored snapshot first.");
    expect(html).toContain('aria-disabled="true"');
  });
  it("names the kind of document the select picks", () => {
    const html = view({ selectLabel: "Attach a stored balance plan" });
    expect(html).toContain("Pick a stored balance plan first.");
  });
  it("says nothing about a pick when no other stored choice is left, the select already says so", () => {
    const html = view({ stored: [{ id: "m1", label: "One" }], attachedIds: ["m1"] });
    expect(html).toContain("No other stored choice");
    expect(html).not.toContain("Pick a stored snapshot first.");
  });
  it("asks for the name once something is picked and no name is typed", () => {
    const base = { selectLabel: "Attach a stored snapshot", choices: 1, busy: false };
    expect(attachWhy({ ...base, pick: "m1", named: false })).toBe("Type your name first.");
    expect(attachWhy({ ...base, pick: "m1", named: true })).toBeNull();
    expect(attachWhy({ ...base, pick: "", named: false })).toBe("Pick a stored snapshot first.");
    expect(attachWhy({ ...base, pick: "", named: true, busy: true })).toBeNull();
  });
});

describe("the stored list follows the workspace revision", () => {
  it("is read again when an import or an attach bumps the revision, and for another workspace", () => {
    expect(listDeps(BLANK)).toEqual(["ws-blank", 3]);
    expect(listDeps({ ...BLANK, revision: 4 })).toEqual(["ws-blank", 4]);
    expect(listDeps({ ...BLANK, id: "ws-other" })).toEqual(["ws-other", 3]);
  });
  it("the control reads through listDeps (source-level stopgap: Studio tests have no DOM to run the hook)", () => {
    const src = readFileSync(new URL("../controls/AttachStored.tsx", import.meta.url), "utf8");
    expect(src).toContain("useLoad(props.list, listDeps(props.head))");
  });
  it("keeps the list that was on screen while the next read is in flight, and shows loading only for the first read", () => {
    const last = [{ id: "m1", label: "One" }];
    expect(listToShow({ state: "loading" }, null)).toEqual({ kind: "loading" });
    expect(listToShow({ state: "loading" }, last)).toEqual({ kind: "list", value: last });
    const next = [{ id: "m1", label: "One" }, { id: "m2", label: "Two" }];
    expect(listToShow({ state: "ok", value: next }, last)).toEqual({ kind: "list", value: next });
    const err = new Error("boom");
    expect(listToShow({ state: "error", error: err }, last)).toEqual({ kind: "error", error: err });
  });
});

describe("Balance Sheet > Positions: attach a stored book (Studio Part 2 D7)", () => {
  it("sets the position book at the head revision with the typed name", () => {
    expect(positionsSetBody(BLANK, "synthetic-2500-v1", "Chih")).toEqual({ expectedRevision: 3, by: "Chih", block: "positions", op: "set", ref: { collection: "portfolios", id: "synthetic-2500-v1" } });
  });
  it("lists the stored books as id, as-of and count, and leaves the retagged copies out", () => {
    const list: PortfolioListItem[] = [
      { id: "synthetic-2500-v1", label: "Synthetic", positionCount: 2500, asOf: "2026-03-31", contentHash: "a" },
      { id: "synthetic-2500-v1--h-region", label: "Retagged", positionCount: 2500, asOf: "2026-03-31", contentHash: "b" },
      { id: "one-loan", label: "One", positionCount: 1, asOf: "2026-02-27", contentHash: "c" },
    ];
    expect(bookOptions(list)).toEqual([
      { id: "synthetic-2500-v1", label: "synthetic-2500-v1 (2026-03-31, 2500 positions)" },
      { id: "one-loan", label: "one-loan (2026-02-27, 1 position)" },
    ]);
  });
  it("prints a label that already starts with the id once, not after the id again", () => {
    const html = renderToStaticMarkup(
      <AttachStoredView title="Position book of this workspace" selectLabel="Attach a stored book" current="No position book is attached." foot="Source: /api/portfolios"
        stored={[{ id: "one-loan", label: "one-loan (2026-02-27, 1 position)" }]} attachedIds={[]} by="Chih" busy={false} note={null} onAttach={() => {}} onBy={() => {}} />,
    );
    expect(html).toContain('<option value="one-loan">one-loan (2026-02-27, 1 position)</option>');
  });
  it("a label that only shares the id's first letters keeps the id; a bare id or a repeated id prints once", () => {
    const html = renderToStaticMarkup(
      <AttachStoredView title="Position book of this workspace" selectLabel="Attach a stored book" current="No position book is attached." foot="Source: /api/portfolios"
        stored={[{ id: "m1", label: "m10 snapshot" }, { id: "m2", label: "" }, { id: "m3", label: "m3" }]} attachedIds={[]} by="Chih" busy={false} note={null} onAttach={() => {}} onBy={() => {}} />,
    );
    expect(html).toContain('<option value="m1">m1: m10 snapshot</option>');
    expect(html).toContain('<option value="m2">m2</option>');
    expect(html).toContain('<option value="m3">m3</option>');
  });
  it("a locked, archived or superseded workspace takes no write, in the words the routing policy card uses", () => {
    expect(writeBlock({ ...BLANK, status: "active", lock: null }, "its position book")).toBeNull();
    expect(writeBlock({ ...BLANK, status: "locked" }, "its position book")).toBe("This workspace is locked by its sign-off. Clone it to change its position book.");
    expect(writeBlock({ ...BLANK, status: "active", lock: { lockedAt: "t", by: "Chih", approvalId: "a", signedHash: "h" } }, "its position book")).toBe("This workspace is locked by its sign-off. Clone it to change its position book.");
    expect(writeBlock({ ...BLANK, status: "archived" }, "its position book")).toBe("This workspace is archived and read-only.");
    expect(writeBlock({ ...BLANK, status: "superseded" }, "its position book")).toBe("This workspace was superseded and is read-only.");
  });
  it("a blocked control says why and turns the pick, the name and the button off", () => {
    const html = renderToStaticMarkup(
      <AttachStoredView title="Position book of this workspace" selectLabel="Attach a stored book" current="No position book is attached." foot="Source: /api/portfolios"
        stored={[{ id: "one-loan", label: "" }]} attachedIds={[]} by="Chih" busy={false} note={null} blocked="This workspace is archived and read-only." onAttach={() => {}} onBy={() => {}} />,
    );
    expect(html).toContain("This workspace is archived and read-only.");
    expect(html).toMatch(/<select aria-label="Attach a stored book" disabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("Pick a stored book first.");
  });
  it("the positions page of a blank workspace offers the import and the stored-book control", () => {
    const html = renderToStaticMarkup(<BalancePage ws="ws-blank" head={BLANK} onChanged={() => {}} bookId={null} marketId={null} query={{}} />);
    expect(html).toContain("Import positions (CSV or JSON)");
    expect(html).toContain("Reading the stored books");
    expect(html).toContain("Import positions above, or set a stored book.");
  });
});

describe("the snapshot, balance plan and slate controls follow the workspace's write refusal", () => {
  const LOCK = { lockedAt: "2026-10-09T09:00:00.000Z", by: "Chih", approvalId: "a", signedHash: "h" };
  const noop = () => {};
  const written = { busy: false, note: null, setNote: noop, write: async () => {} };
  const controls: Array<{ name: string; select: string; hint: string; change: string; draw(head: WorkspaceManifest): ReactElement }> = [
    { name: "SnapshotAttach", select: "Attach a stored snapshot", hint: "Pick a stored snapshot first.", change: "its base snapshot",
      draw: (head) => <SnapshotAttach head={head} onChanged={noop} /> },
    { name: "PlansAttach", select: "Attach a stored balance plan", hint: "Pick a stored balance plan first.", change: "its balance plans",
      draw: (head) => <PlansAttach head={head} written={written} byState={["Chih", noop]} onChanged={noop} refresh={0} /> },
    { name: "SlatesAttach", select: "Attach a stored slate", hint: "Pick a stored slate first.", change: "its scenario slates",
      draw: (head) => <SlatesAttach head={head} onChanged={noop} /> },
  ];
  const refusals: Array<{ state: string; over: Partial<WorkspaceManifest>; text(change: string): string }> = [
    { state: "locked", over: { status: "locked", lock: LOCK }, text: (change) => `This workspace is locked by its sign-off. Clone it to change ${change}.` },
    { state: "archived", over: { status: "archived" }, text: () => "This workspace is archived and read-only." },
    { state: "superseded", over: { status: "superseded" }, text: () => "This workspace was superseded and is read-only." },
  ];
  const render = (el: ReactElement) => {
    forced.value = { state: "ok", value: [{ id: "stored-1", label: "" }] };
    return renderToStaticMarkup(el);
  };
  for (const c of controls) {
    for (const r of refusals) {
      it(`${c.name} on a ${r.state} workspace says why and turns the pick, the name and the button off`, () => {
        const html = render(c.draw({ ...BLANK, ...r.over }));
        expect(html).toContain(r.text(c.change));
        expect(html).toContain(`<select aria-label="${c.select}" disabled=""`);
        expect(html).toContain('<input class="input" aria-label="Your name" disabled=""');
        expect(html).toContain('aria-disabled="true"');
        expect(html).not.toContain(c.hint);
      });
    }
    it(`${c.name} on an active workspace stays writable`, () => {
      const html = render(c.draw({ ...BLANK, status: "active", lock: null }));
      expect(html).toContain(`<select aria-label="${c.select}"`);
      expect(html).not.toContain(`<select aria-label="${c.select}" disabled=""`);
      expect(html).not.toContain('aria-label="Your name" disabled=""');
      expect(html).toContain(c.hint);
      expect(html).not.toContain("read-only");
      expect(html).not.toContain("locked by its sign-off");
    });
  }
});

describe("derived markets (Piece B, step B3a, decision 42)", () => {
  it("marketAddBody adds a stored derived market to the market block", () => {
    expect(marketAddBody(BLANK, "derived-mk-0123456789ab", "Chih")).toEqual({
      expectedRevision: 3, by: "Chih", block: "market", op: "add", ref: { collection: "market", id: "derived-mk-0123456789ab" },
    });
  });
  it("offers markets derived from the snapshot or from a derived market the block holds, and none it already holds", () => {
    const list: MarketListItem[] = [
      { id: "market-public-2026-03-31", label: "Public market pack", calibrationDate: "2026-03-31" },
      { id: "tlp-shock-demo-v1", label: "TLP shock", calibrationDate: "2026-03-31", derivedFromMarketId: "market-public-2026-03-31" },
      { id: "derived-mk-aaaaaaaaaaaa", label: "Rate indices on market-public-2026-03-31 (demonstration values)", calibrationDate: "2026-03-31", derivedFromMarketId: "market-public-2026-03-31" },
      { id: "derived-mk-bbbbbbbbbbbb", label: "Child of the TLP shock", calibrationDate: "2026-03-31", derivedFromMarketId: "tlp-shock-demo-v1" },
      { id: "derived-mk-cccccccccccc", label: "On another base", calibrationDate: "2026-02-27", derivedFromMarketId: "market-other" },
    ];
    expect(derivedMarketOptions(list, HEAD)).toEqual([
      { id: "derived-mk-aaaaaaaaaaaa", label: "Rate indices on market-public-2026-03-31 (demonstration values)" },
      { id: "derived-mk-bbbbbbbbbbbb", label: "Child of the TLP shock" },
    ]);
    expect(derivedMarketOptions(list, BLANK)).toEqual([]);
  });
  it("Yield curves shows the derived-market card with the stored choices", () => {
    forced.value = { state: "ok", value: [{ id: "derived-mk-aaaaaaaaaaaa", label: "Rate indices on market-public-2026-03-31 (demonstration values)" }] };
    const html = renderToStaticMarkup(<DerivedAttach head={HEAD} onChanged={() => {}} />);
    expect(html).toContain('aria-label="Derived markets of this workspace"');
    expect(html).toContain('aria-label="Attach a derived market"');
    expect(html).toContain("derived-mk-aaaaaaaaaaaa: Rate indices on market-public-2026-03-31 (demonstration values)");
    expect(html).toContain("macro-demo-v1");
  });
  it("is not offered while the workspace has no snapshot", () => {
    const html = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section="curves" head={BLANK} onChanged={() => {}} />);
    expect(html).not.toContain("Derived markets of this workspace");
    // The server render draws the card's loading line, never its title, so the absence is also read off that line.
    expect(html).not.toContain("Reading the stored derived markets");
  });
  it("is offered on Yield curves once the workspace holds a snapshot, and not on Volatility surfaces", () => {
    const at = (section: "curves" | "vols") =>
      renderToStaticMarkup(<MarketPage ws={HEAD.id} marketId="market-public-2026-03-31" query={{}} section={section} head={HEAD} onChanged={() => {}} />);
    expect(at("curves")).toContain("Reading the stored derived markets");
    expect(at("vols")).not.toContain("Reading the stored derived markets");
  });
});
