/**
 * The Start here card on Home. Where each step's Open lands, by what the store holds, and
 * what the card and the result's note print. The pass rule that holds the list to the replica tie-outs is
 * apps/server/src/__tests__/s3fStartHere.test.ts. Expected addresses and lines are restated here by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExampleDemoRow, WorkspaceManifest, WorkspaceRunRow } from "@alm/reader";
import { aboutText, MORE_DEMOS, START_HERE_ITEMS, START_HERE_PATH, stepRows, type StepRow } from "../guided/startHere";
import { DEMO_CARDS, DEPOSIT_FORM_CARDS, SURVIVAL_PATH_CARDS } from "../guided/featureDemos";
import { StartHereNote, StartHereView } from "../pages/workspace/StartHere";
import { HomeView } from "../pages/workspace/HomePage";

function ws(id: string, book: string, name = id): WorkspaceManifest {
  return {
    id, name, status: "active", lock: null, createdAt: "2026-11-05T00:00:00.000Z", revision: 4,
    blocks: { positions: { book: { collection: "portfolios", id: book } }, assumptions: { sets: [] }, run: { setups: [] } },
  } as unknown as WorkspaceManifest;
}

const run = (runId: string, slot: string, state: string, submittedAt = "2026-11-05T10:00:00.000Z"): WorkspaceRunRow =>
  ({ runId, attachedBy: "launch", at: submittedAt, setupLineageId: slot, pins: "consumed", status: { runId, state, submittedAt }, basisLabel: null }) as unknown as WorkspaceRunRow;

const demoRow = (id: string, stored = true): ExampleDemoRow => ({ id, title: id, lineageId: `demo-${id}`, setupId: `rs-${id}`, setIds: ["s"], stored });
const allDemos = (stored = true) => new Map(START_HERE_ITEMS.filter((i) => i.id !== "explore").map((i) => [i.id, demoRow(i.id, stored)]));
const byId = (rows: StepRow[], id: string) => rows.find((r) => r.item.id === id)!;

const BANK = ws("ws-example-bank", "mid-size-bank-v1", "Example bank");
const DESK = ws("ws-deposit-desk", "quillfield-deposit-desk-v1", "Deposit desk");

describe("where Open lands", () => {
  it("on an empty store: step 1 explores, a bank demo waits for step 1, a desk demo makes the desk's workspace", () => {
    const rows = stepRows({ items: START_HERE_ITEMS, workspaces: [], demos: allDemos(), runs: new Map() });
    expect(byId(rows, "explore")).toMatchObject({ action: { kind: "button" }, note: null });
    expect(byId(rows, "six-shocks")).toMatchObject({ action: { kind: "off" }, note: "Explore the bank first (step 1): this demo opens on that workspace." });
    expect(byId(rows, "desk-credit")).toMatchObject({
      action: { kind: "button" },
      note: "Open makes a workspace for the deposit desk and sets it up on Run setups. Press Launch there.",
    });
  });

  it("with the workspaces and no run yet: each demo sets up on Run setups and says to press Launch", () => {
    const runs = new Map([[BANK.id, [run("r-g", "setup-guided", "done")]], [DESK.id, []]]);
    const rows = stepRows({ items: START_HERE_ITEMS, workspaces: [BANK, DESK], demos: allDemos(), runs });
    expect(byId(rows, "explore").action).toEqual({ kind: "link", href: "#/ws/ws-example-bank/analysis/reports" });
    for (const id of ["six-shocks", "survival-path", "desk-full-beta-frozen", "desk-scenario-credit"]) {
      expect(byId(rows, id), id).toMatchObject({ action: { kind: "button" }, note: "Open sets it up on Run setups. Press Launch there, then read the result." });
    }
  });

  it("with a done run in the slot: Open lands on that run's Results screen, the newest done run, the demo named", () => {
    const runs = new Map([
      [BANK.id, [run("r-old", "demo-six-shocks", "done", "2026-11-05T09:00:00.000Z"), run("r-new", "demo-six-shocks", "done", "2026-11-05T11:00:00.000Z"), run("r-err", "demo-seg", "error"), run("r-sp", "demo-survival-path", "done")]],
      [DESK.id, [run("r-dc", "demo-desk-credit", "done")]],
    ]);
    const rows = stepRows({ items: START_HERE_ITEMS, workspaces: [BANK, DESK], demos: allDemos(), runs });
    expect(byId(rows, "six-shocks")).toMatchObject({ action: { kind: "link", href: "#/ws/ws-example-bank/results/eve?result=r-new&demo=six-shocks" }, note: null });
    expect(byId(rows, "survival-path").action).toEqual({ kind: "link", href: "#/ws/ws-example-bank/results/liquidity?result=r-sp&demo=survival-path" });
    expect(byId(rows, "desk-credit").action).toEqual({ kind: "link", href: "#/ws/ws-deposit-desk/results/ftp?result=r-dc&demo=desk-credit" });
    // A run that ended in error is no result: the step still sets up on Run setups.
    expect(byId(rows, "seg").action).toEqual({ kind: "button" });
    // With no done run of the finished analysis, step 1 opens step 1 of the path, even when demo runs are done (L4).
    const fresh = stepRows({ items: START_HERE_PATH, workspaces: [BANK], demos: allDemos(), runs: new Map([[BANK.id, []]]) });
    expect(byId(fresh, "explore").action).toEqual({ kind: "link", href: "#/ws/ws-example-bank/analysis/market" });
    const demosOnly = stepRows({ items: START_HERE_PATH, workspaces: [BANK], demos: allDemos(), runs: new Map([[BANK.id, [run("r-s", "demo-seg", "done"), run("r-g", "setup-guided", "error")]]]) });
    expect(byId(demosOnly, "explore").action).toEqual({ kind: "link", href: "#/ws/ws-example-bank/analysis/market" });
  });

  it("waits, saying nothing, while the demos or a workspace's runs are read; says when the store predates the demos", () => {
    expect(stepRows({ items: START_HERE_ITEMS, workspaces: [BANK], demos: null, runs: new Map() }).filter((r) => r.item.id !== "explore").every((r) => r.action.kind === "off" && r.note === null)).toBe(true);
    expect(byId(stepRows({ items: START_HERE_ITEMS, workspaces: [BANK], demos: allDemos(), runs: new Map() }), "seg")).toMatchObject({ action: { kind: "off" }, note: null });
    expect(byId(stepRows({ items: START_HERE_ITEMS, workspaces: [BANK], demos: allDemos(false), runs: new Map([[BANK.id, []]]) }), "seg")).toMatchObject({
      action: { kind: "off" }, note: "This store does not hold this demo. npm run learn starts a store that holds every demo.",
    });
  });
});

describe("the card", () => {
  const rowsOf = (items: typeof START_HERE_PATH) => stepRows({ items, workspaces: [], demos: allDemos(), runs: new Map() });
  const html = renderToStaticMarkup(<StartHereView path={rowsOf(START_HERE_PATH)} more={rowsOf(MORE_DEMOS)} busy={null} error={null} status={null} onOpen={() => undefined} />);
  // S4 fix round 2: the S4b docs set every item's box slots, so the old card copy is the fallback for an item whose
  // slots are unset; the two fallback tests below render the list with the slots stripped.
  const unset = (xs: typeof START_HERE_PATH) => xs.map(({ short: _s, guide: _g, ...i }) => i);
  const fallback = renderToStaticMarkup(<StartHereView path={rowsOf(unset(START_HERE_PATH))} more={rowsOf(unset(MORE_DEMOS))} busy={null} error={null} status={null} onOpen={() => undefined} />);

  it("numbers the eight steps of the path in order, then lists the eight more demos, each with Open", () => {
    const steps = [...html.matchAll(/aria-label="Step (\d): ([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(steps).toEqual([
      "1 Explore the bank", "2 Six regulatory shocks (EVE)", "3 Earnings sensitivity (SEG)", "4 Fixed-rate repricing ladder (gap)",
      "5 Floater funding tenor (FTP)", "6 Full beta, frozen slotting (deposits)", "7 Replicating-portfolio credit (deposit FTP)", "8 Survival path and dials (liquidity)",
    ]);
    expect(html).toContain("More demos");
    expect((html.match(/>Open</g) ?? []).length).toBe(16);
    for (const item of START_HERE_ITEMS) expect(html).toContain(item.learn.replace(/'/g, "&#x27;"));
  });

  it("keeps the old card's copy and caveats behind a disclosure on each demo, with no change advice and no Launch it (L6)", () => {
    expect((fallback.match(/More about this demo/g) ?? []).length).toBe(15);
    expect(fallback).toContain("The US has not adopted it.");
    for (const c of [...DEMO_CARDS, ...DEPOSIT_FORM_CARDS, ...SURVIVAL_PATH_CARDS]) {
      const t = aboutText(c.text);
      expect(t, c.id).not.toMatch(/(^|\. )(Change |Launch it)/);
      expect(t.length, c.id).toBeGreaterThan(40);
    }
    // A "Launch it, then open ...: <figure>" sentence keeps its figure (restated from the survival card).
    expect(aboutText(SURVIVAL_PATH_CARDS[0]!.text)).toContain("The buffer lasts about 6.7 months, 203 days.");
    expect(aboutText(SURVIVAL_PATH_CARDS[0]!.text)).not.toContain("Off on the page");
  });

  it("shows every demo's card notes behind its disclosure, the fix round's included (moved from the removed Home section's test)", async () => {
    const { cardFor } = await import("../guided/startHereCards");
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
    for (const item of START_HERE_ITEMS.filter((i) => i.id !== "explore")) {
      const card = cardFor(item.id);
      expect(card, item.id).toBeDefined();
      for (const note of card!.notes) expect(fallback, `${item.id}: ${note}`).toContain(esc(note));
    }
    expect(fallback).toContain("The CDs are not split.");
  });

  it("comes first on Home, before the start choices, and the two demo sections are gone", () => {
    const home = renderToStaticMarkup(<HomeView workspaces={[]} banner={null} />);
    expect(home.indexOf('aria-label="Start here"')).toBeGreaterThanOrEqual(0);
    expect(home.indexOf('aria-label="Start here"')).toBeLessThan(home.indexOf('aria-label="Start choices"'));
    expect(home).not.toContain('aria-label="Feature demos"');
    expect(home).not.toContain('aria-label="Deposit desk demos"');
  });
});

describe("the note on a Start here result", () => {
  it("names the demo, says what to change and run again, and links to its setup and back to Start here", () => {
    const note = renderToStaticMarkup(<StartHereNote ws="ws-example-bank" demoId="seg" runSlot="demo-seg" />);
    expect(note).toContain("Earnings sensitivity (SEG).");
    expect(note).toContain("On Run setups set the NII shock to 200 bp, press Save as a new version, launch it, and watch the earnings change grow.");
    expect(note).toContain('href="#/ws/ws-example-bank/run/setups/demo-seg?demo=seg"');
    expect(note).toContain('href="#/workspaces"');
  });

  it("prints nothing for no demo, an unknown one, or step 1", () => {
    for (const id of [undefined, "no-such-demo", "explore"]) expect(renderToStaticMarkup(<StartHereNote ws="ws-x" demoId={id} runSlot="demo-seg" />)).toBe("");
  });

  it("prints nothing above a run of another slot, or a run whose slot is unknown (M2)", () => {
    for (const slot of ["demo-survival-path", "setup-guided", null]) expect(renderToStaticMarkup(<StartHereNote ws="ws-x" demoId="seg" runSlot={slot} />), String(slot)).toBe("");
  });
});

describe("the Reports step's Advanced links (fix round M4)", () => {
  it("open Results on the run Reports shows: the finished analysis by default, the address's run when it names one", async () => {
    const { advancedHrefs } = await import("../guided/steps");
    const { reportsRunId } = await import("../pages/analysis/ReportsStep");
    // Newest first, as the workspace lists them: a demo run is newer than the analysis's.
    const runs = [run("r-demo", "demo-survival-path", "done", "2026-11-05T11:00:00.000Z"), run("r-guided", "setup-guided", "done", "2026-11-05T10:00:00.000Z")];
    expect(reportsRunId({ runs, stochastic: [], query: {} })).toBe("r-guided");
    expect(reportsRunId({ runs, stochastic: [], query: { run: "r-demo" } })).toBe("r-demo");
    expect(reportsRunId({ runs, stochastic: [], query: { run: "r-gone" } })).toBe("r-guided");
    const links = advancedHrefs("ws-example-bank", "reports", "r-guided");
    expect(links.find((l) => l.label === "Value (EVE)")?.href).toBe("#/ws/ws-example-bank/results/eve?result=r-guided");
    expect(links.find((l) => l.label === "Dashboard")?.href).toBe("#/ws/ws-example-bank/results/dashboard?result=r-guided");
    // Without a run the links are as before.
    expect(advancedHrefs("ws-example-bank", "reports").find((l) => l.label === "Value (EVE)")?.href).toBe("#/ws/ws-example-bank/results/eve");
  });
});

describe("a change made in the assumption set (fix round H1)", () => {
  it("Use this copy attaches the copy when the workspace lacks it, saves the demo's setup naming only the copy, and opens Run setups", async () => {
    const { putCopyInDemo } = await import("../guided/startHereEdit");
    const item = START_HERE_ITEMS.find((i) => i.id === "desk-credit")!;
    const calls: Array<[string, unknown]> = [];
    const head = (rev: number, sets: string[]) => ({
      id: "ws-deposit-desk", revision: rev,
      blocks: { assumptions: { sets: sets.map((id) => ({ collection: "assumption-sets", id })) }, run: { setups: [{ setupLineageId: "demo-desk-credit", current: { collection: "run-setups", id: "rs-seeded" } }] } },
    });
    const api = {
      getWorkspace: async () => head(4, ["quillfield-desk-credit-v1"]),
      setBlock: async (_ws: string, body: unknown) => { calls.push(["setBlock", body]); return head(5, ["quillfield-desk-credit-v1", "quillfield-desk-credit-v1-edit-1"]); },
      getRunSetup: async (id: string) => ({ id, name: "Demo", inputs: { book: { role: "base" }, market: { role: "base" }, assumptionSetIds: ["quillfield-desk-credit-v1"] } }),
      saveRunSetup: async (body: unknown) => { calls.push(["saveRunSetup", body]); return {}; },
    } as never;
    const href = await putCopyInDemo({ ws: "ws-deposit-desk", item, copyId: "quillfield-desk-credit-v1-edit-1", by: "Learner" }, api);
    expect(href).toBe("#/ws/ws-deposit-desk/run/setups/demo-desk-credit?demo=desk-credit");
    expect(calls.map((c) => c[0])).toEqual(["setBlock", "saveRunSetup"]);
    expect(calls[0]![1]).toMatchObject({ expectedRevision: 4, block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: "quillfield-desk-credit-v1-edit-1" } });
    expect(calls[1]![1]).toMatchObject({ workspaceId: "ws-deposit-desk", setupLineageId: "demo-desk-credit", expectedRevision: 5, by: "Learner", setup: { name: "Demo", inputs: { assumptionSetIds: ["quillfield-desk-credit-v1-edit-1"] } } });
    expect((calls[1]![1] as { setup: { id?: string } }).setup.id).toBeUndefined();
  });

  it("the result note opens the item's set with the item in the address; the editor banner and the Run setups note name the next step", async () => {
    const { StartHereSetBanner, StartHereSetupNote } = await import("../pages/workspace/StartHere");
    const note = renderToStaticMarkup(<StartHereNote ws="ws-deposit-desk" demoId="desk-credit" runSlot="demo-desk-credit" />);
    expect(note).toContain('href="#/ws/ws-deposit-desk/assumptions/sets?demo=desk-credit&amp;set=quillfield-desk-credit-v1"');
    expect(note).toContain("Open the assumption set");
    const onSeed = renderToStaticMarkup(<StartHereSetBanner ws="ws-deposit-desk" query={{ demo: "desk-credit" }} shownSetId="quillfield-desk-credit-v1" />);
    expect(onSeed).toContain("then press Save");
    expect(onSeed).not.toContain(">Use this copy<");
    const onCopy = renderToStaticMarkup(<StartHereSetBanner ws="ws-deposit-desk" query={{ demo: "desk-credit" }} shownSetId="quillfield-desk-credit-v1-edit-1" />);
    expect(onCopy).toContain(">Use this copy<");
    expect(renderToStaticMarkup(<StartHereSetBanner ws="ws-x" query={{}} shownSetId="s" />)).toBe("");
    const ready = renderToStaticMarkup(<StartHereSetupNote ws="ws-deposit-desk" query={{ demo: "desk-credit" }} slot="demo-desk-credit" setIds={["quillfield-desk-credit-v1-edit-1"]} runIds={[]} named={false} />);
    expect(ready).toContain("now runs on your copy, quillfield-desk-credit-v1-edit-1. Type your name in Recorded by, then press Launch.");
    const launched = renderToStaticMarkup(<StartHereSetupNote ws="ws-deposit-desk" query={{ demo: "desk-credit" }} slot="demo-desk-credit" setIds={["x"]} runIds={["run-9"]} named />);
    expect(launched).toContain('href="#/ws/ws-deposit-desk/results/ftp?result=run-9&amp;demo=desk-credit"');
    expect(renderToStaticMarkup(<StartHereSetupNote ws="ws-x" query={{ demo: "desk-credit" }} slot="demo-seg" setIds={[]} runIds={[]} named />)).toBe("");
  });
});
