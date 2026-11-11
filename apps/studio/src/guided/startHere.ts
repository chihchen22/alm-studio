// apps/studio/src/guided/startHere.ts
/**
 * The Start here card's fixed list: a numbered learning path on Quillfield Bank, then
 * "More demos", every demo the seed stores exactly once. Each item says what you learn in one plain line, where Open
 * lands, and one line on what to change and run again. Longer walkthrough prose is a later slice.
 *
 * The list is held by a test (apps/server/src/__tests__/s3fStartHere.test.ts): every demo names the accept check that
 * ties its run out against the independent Python replica, the replica lines of that check, and the targets file they
 * read, and the test fails when the check is not registered, when a named line is missing or does not pass on this
 * build, or when a seeded demo is missing from the list. Step 1 is held to the bank's run-off tie-out only: the figures
 * its Reports step adds (new volume, going-concern value) have no replica target. Nothing here is read at run time but
 * the copy and the screen.
 *
 * Pure parts only (the list, where Open lands, the card's rows); the card (pages/workspace/StartHere.tsx) makes the calls.
 */
import type { ExampleDemoRow, WorkspaceManifest, WorkspaceRunRow } from "@alm/reader";
import { analysisHref, hrefFor, type ScreenId } from "../router";
import { demoHref, demoWorkspace } from "./featureDemos";
import { GUIDED_SLOT } from "./steps";

/** Where an item's run ties out: the core accept check, the prefix of its replica lines, and their targets file. */
export interface TieOut {
  /** The capability id of the check in the core register (data/src/examples/accept/registry.ts). */
  check: string;
  /** The item's lines in that check: every line whose id starts with `prefix`, or exactly the lines `ids` names. */
  lines: { prefix: string } | { ids: readonly string[] };
  /** The targets file those lines read, under replica/targets/. */
  targets: string;
}

export interface StartHereItem {
  /** The demo id the server lists (GET /api/guided/examples/:id/demos), or "explore" for the finished analysis. */
  id: string;
  title: string;
  /** What you learn, in one plain line. */
  learn: string;
  /** What to change and run again, in one plain line; the result Open lands on shows it. */
  change: string;
  /** The example book the item runs on. */
  bookId: string;
  /** The Results screen Open lands on when the item's slot has a done run (Explore lands on the Reports step). */
  screen: ScreenId | null;
  /**
   * S3f fix round (H1): an item whose change is made in its assumption set names that set. Its result note opens the set
   * editor with the item in the address, and the editor's "Use this copy" puts the saved copy into the demo's setup.
   */
  edit?: { setId: string };
  tieOut: TieOut;
  /**
   * The "More about this demo" box's own copy, two to three plain sentences. Set together
   * with `guide`; while either is unset the box shows the old card copy (guided/startHereCards.ts) as before.
   */
  short?: string;
  /** The method guide page the box points to, shown as "Read more: <path>". */
  guide?: GuidePath;
}

/** The method guide's topic pages (docs/guide/<topic>.md) a Start here box may point to. */
export const GUIDE_TOPICS = ["explore", "eve", "nii-seg", "gap", "ftp", "deposits", "liquidity"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];
export type GuidePath = `docs/guide/${GuideTopic}.md`;

/** The box's own copy when both slots are set, else null (the box then shows the old card copy). */
export function aboutSlots(item: StartHereItem): { short: string; guide: GuidePath } | null {
  return item.short !== undefined && item.guide !== undefined ? { short: item.short, guide: item.guide } : null;
}

/** The line under the box's own copy: the guide page as plain text (a link when GUIDE_BASE_URL is set). */
export const readMoreLine = (guide: GuidePath): string => `Read more: ${guide}`;

/**
 * Where the guide pages are read on the web: null names the page as plain text; a repository file-view address makes
 * the box link the page there.
 */
export const GUIDE_BASE_URL: string | null = "https://github.com/chihchen22/alm-studio/blob/main/";

/** The web address of a guide page, or null when there is no base (this repository). */
export const guideHref = (guide: GuidePath, base: string | null = GUIDE_BASE_URL): string | null => (base === null ? null : `${base}${guide}`);

export const BANK_ID = "mid-size-bank-v1";
export const DESK_ID = "quillfield-deposit-desk-v1";

/** The example bank's own tie-out lines (the check names them without a prefix; the coverage book's carry one). */
const QUILLFIELD_LINES = ["positions", "nii", "eve-risk-free", "eve-all-in", "gap-repricing", "gap-liquidity", "ftp"];

const DEMO = (id: string, check: string): TieOut => ({ check, lines: { prefix: `demo.${id}.` }, targets: `replica/targets/demo-${id}-v1.json` });
const DESK = (check: string, prefix: string): TieOut => ({ check, lines: { prefix }, targets: "replica/targets/deposit-forms-v1.json" });

/** The learning path, in teaching order: the bank first, then value and earnings, gap, FTP, deposits, liquidity. */
export const START_HERE_PATH: readonly StartHereItem[] = Object.freeze<StartHereItem[]>([
  {
    id: "explore", title: "Explore the bank", bookId: BANK_ID, screen: null,
    learn: "A whole bank's analysis, finished: its balance sheet, earnings, value and gap, one step at a time.",
    change: "Change any step of the Analysis path, such as the scenarios, and run it again from the Run step.",
    short: "A finished analysis of one whole bank: what it earns, what it is worth and when its money comes back. Its run-off earnings, value, gap and transfer prices are checked against an independent replica. Change a step and run it again to see what moves.",
    guide: "docs/guide/explore.md",
    tieOut: { check: "python-replica-tie-out", lines: { ids: QUILLFIELD_LINES }, targets: "replica/targets/quillfield-v1.json" },
  },
  {
    id: "six-shocks", title: "Six regulatory shocks (EVE)", bookId: BANK_ID, screen: "eve",
    learn: "How the bank's value moves under the six standardized rate shocks, one row per shock.",
    change: "On Run setups set the NMD convention to regulatory, press Save as a new version, launch it, and compare the parallel up row.",
    short: "Value is what the bank's future cash is worth today, assets less liabilities. Each standardized shock is one row, and the parallel rise hurts this bank most. Switch the deposit convention and the loss roughly halves.",
    guide: "docs/guide/eve.md",
    tieOut: DEMO("six-shocks", "quillfield-feature-demos"),
  },
  {
    id: "seg", title: "Earnings sensitivity (SEG)", bookId: BANK_ID, screen: "seg",
    learn: "How much of the bank acts like a fixed-rate balance, and what a rate move does to its earnings.",
    change: "On Run setups set the NII shock to 200 bp, press Save as a new version, launch it, and watch the earnings change grow.",
    short: "The sensitivity equivalent gap reads how much of the bank acts like a fixed-rate balance when rates move a little. It covers every earning asset and every liability except the certificates of deposit. The earnings change beside it is read on a constant balance.",
    guide: "docs/guide/nii-seg.md",
    tieOut: DEMO("seg", "seg-ear"),
  },
  {
    id: "fixed-ladder", title: "Fixed-rate repricing ladder (gap)", bookId: BANK_ID, screen: "gap",
    learn: "When the money on fixed-rate loans, mortgages and CDs comes back, band by band.",
    change: "On Run setups set the NMD convention to regulatory, press Save as a new version, launch it, and watch deposits fill the 5-10Y band.",
    short: "Each dollar of fixed-rate principal sits in the band of the month it is paid back. Floating loans and live deposits are left out. Under the regulatory convention the deposit cores become fixed-rate rungs and join the ladder.",
    guide: "docs/guide/gap.md",
    tieOut: DEMO("fixed-ladder", "quillfield-feature-demos"),
  },
  {
    id: "funding-tenor", title: "Floater funding tenor (FTP)", bookId: BANK_ID, screen: "ftp",
    learn: "How a floating loan's funding tenor sets the liquidity part of its transfer price.",
    change: "Compare the floating rows of FTP by family: IR FTP is the same, but mb-heloc's 60-month funding tenor gives a higher LP FTP than mb-cre-construction's 24.",
    short: "A floating loan resets every month, but the bank funds it for longer. The funding tenor sets the liquidity leg of its transfer price; the rate leg stays at the reset. A longer tenor means a higher liquidity charge.",
    guide: "docs/guide/ftp.md",
    tieOut: DESK("ftp-replicating-portfolio-credit", "quillfield.funding-tenor."),
  },
  {
    id: "desk-full-beta-frozen", title: "Full beta, frozen slotting (deposits)", bookId: DESK_ID, screen: "eve",
    learn: "How a money market deposit's paid rate follows the short rate, and what that does to its value.",
    change: "On Run setups set the NMD convention to shocked-level, press Save as a new version, launch it, and compare the +100 bp value change.",
    short: "The full beta form sets a money market deposit's paid rate from the short rate, with a damper after each move. Frozen slotting holds the core share at the base date in every scenario. Read the money market row: its value as a liability falls under a rise, and the other deposits move too.",
    guide: "docs/guide/deposits.md",
    tieOut: DESK("nmd-b-full-beta-form", "desk.full-beta.frozen-"),
  },
  {
    id: "desk-credit", title: "Replicating-portfolio credit (deposit FTP)", bookId: DESK_ID, screen: "ftp",
    learn: "What a deposit's funding is worth: the credit a portfolio of matching bullets gives it.",
    change: "Open the assumption set, in the dd-operating card set Construction to Strip on the runoff, press Save, then Use this copy and Launch.",
    short: "A deposit's credit is what its funding is worth: fixed-rate bullets whose life matches the deposit's, plus the liquidity premium at that life. The repricing share rolls overnight. The construction decides how the balance is spread across the pillars.",
    guide: "docs/guide/ftp.md",
    edit: { setId: "quillfield-desk-credit-v1" },
    tieOut: DESK("ftp-replicating-portfolio-credit", "desk.credit."),
  },
  {
    id: "survival-path", title: "Survival path and dials (liquidity)", bookId: BANK_ID, screen: "liquidity",
    learn: "How long liquid assets last in a severe stress, and what the undrawn lines draw.",
    change: "On Run setups change a severe stress rate, press Save as a new version, launch it, and read how many days the buffer lasts.",
    short: "The survival path asks how long the liquid assets last in a severe stress. Deposits leave at the row's rates, maturing certificates renew in part, and the undrawn lines draw what the dials say. A borrowing line is counted in the path only.",
    guide: "docs/guide/liquidity.md",
    tieOut: { check: "liquidity-survival-path", lines: { prefix: "s3d." }, targets: "replica/targets/demo-survival-path-v1.json" },
  },
]);

/** The other demos, below the path: the bank's four, then the deposit desk's four. */
export const MORE_DEMOS: readonly StartHereItem[] = Object.freeze<StartHereItem[]>([
  {
    id: "regulatory", title: "The regulatory deposit convention", bookId: BANK_ID, screen: "eve",
    learn: "The international standard's split of each deposit into a stable core and a short slice.",
    change: "On Run setups set the NMD convention to behavioral, press Save as a new version, launch it, and watch base value rise.",
    short: "The international standard's convention splits each deposit into a stable core and a short slice that leaves in a month. The core is laid out in rungs with a five-year average life at today's paid rate. It is shown as a reference; the US has not adopted it.",
    guide: "docs/guide/deposits.md",
    tieOut: DEMO("regulatory", "quillfield-feature-demos"),
  },
  {
    id: "spread-consistent", title: "Spread-consistent discounting", bookId: BANK_ID, screen: "eve",
    learn: "Valuing each loan on the funding curve plus its own credit spread.",
    change: "On Run setups set the EVE discount basis to all-in, press Save as a new version, launch it, and watch base value rise.",
    short: "Each loan is valued on the funding curve plus its family's illustrative credit spread. Deposits carry no spread. Loans are worth less on this basis, so base value is lower than on the all-in curve.",
    guide: "docs/guide/eve.md",
    tieOut: DEMO("spread-consistent", "quillfield-feature-demos"),
  },
  {
    id: "instruments", title: "Instrument-level results", bookId: BANK_ID, screen: "instruments",
    learn: "One row per position per scenario, so every total can be traced to its positions.",
    change: "On Run setups store only Total Liabilities and Equity, press Save as a new version, launch it, and the grid keeps just those rows.",
    short: "One row per position per scenario: its value, its first-year earnings, its balance and the principal it pays back. The rows sum to the family totals on the value screen. Sort the grid to see where the rate risk sits.",
    guide: "docs/guide/explore.md",
    tieOut: DEMO("instruments", "per-position-drilldown"),
  },
  {
    id: "constant-prepay", title: "Constant prepayment and the stress inflow line", bookId: BANK_ID, screen: "liquidity",
    learn: "Fixed-rate loans that pay back early at a steady speed, and more slowly in a stress.",
    change: "On Run setups pick the illustrative assumption set, press Save as a new version, launch it, and watch first-year inflows fall.",
    short: "Fixed-rate loans pay back early at a steady speed, and more slowly in a stress. The stress ladder reads those inflows row by row. This setup leaves the certificates of deposit out, so it is not a full survival reading.",
    guide: "docs/guide/liquidity.md",
    tieOut: DEMO("constant-prepay", "quillfield-feature-demos"),
  },
  {
    id: "desk-linear-decay", title: "A straight-line deposit runoff", bookId: DESK_ID, screen: "gap",
    learn: "A deposit that runs off in a straight line, and how long it lasts on average.",
    change: "On Run setups set the NMD convention to regulatory, press Save as a new version, launch it, and watch the desk's value rise.",
    short: "A deposit that runs off in a straight line over a stated horizon. Its life is the midpoint of that horizon, the simplest benchmark for a deposit model. The desk holds deposits only, so its value is negative.",
    guide: "docs/guide/deposits.md",
    tieOut: DESK("ftp-replicating-portfolio-credit", "desk.linear."),
  },
  {
    id: "desk-component-decay", title: "Component decay on a dated rate path", bookId: DESK_ID, screen: "gap",
    learn: "A savings balance projected month by month on rates as they happened.",
    change: "Open the assumption set, set Monthly retention to 0.99, press Save, then Use this copy and Launch, and read the savings life.",
    short: "A savings balance projected month by month on rates as they happened. Each month a share stays, the survivors grow a little, and a rate above its own trailing average takes more away. The life is read on the full runoff.",
    guide: "docs/guide/deposits.md",
    edit: { setId: "quillfield-desk-component-decay-v1" },
    tieOut: DESK("nmd-component-decay-dated-path", "desk.component."),
  },
  {
    id: "desk-full-beta-shocked", title: "The full beta form, shocked-level slotting", bookId: DESK_ID, screen: "eve",
    learn: "The money market deposit's core share read at each scenario's own rate.",
    change: "Open the assumption set, set Core life to 7 years, press Save, then Use this copy and Launch, and read the +100 bp change.",
    short: "Shocked-level slotting reads the money market deposit's core share at each scenario's own short rate. After a rise the damper pulls the beta down, so the core grows. A larger core is worth less as a liability when rates rise, so the desk gains more.",
    guide: "docs/guide/deposits.md",
    edit: { setId: "quillfield-desk-full-beta-v1" },
    tieOut: DESK("nmd-b-full-beta-form", "desk.full-beta.shocked-"),
  },
  {
    id: "desk-scenario-credit", title: "The credit at every scenario", bookId: DESK_ID, screen: "ftp",
    learn: "The deposit credit priced again at every rate scenario, on that scenario's own curve.",
    change: "Open the assumption set, in the dd-savings card set Shocked scenarios to Hold base, press Save, then Use this copy and Launch.",
    short: "The deposit credit priced again at every rate scenario, on that scenario's own curve. The savings life comes from the balance path that scenario projects, so it shortens when rates rise. The money market life stays at its cap.",
    guide: "docs/guide/ftp.md",
    edit: { setId: "quillfield-desk-scenario-credit-v1" },
    tieOut: DESK("ftp-credit-scenario-reading", "desk.scenario-credit."),
  },
]);

/** Every item, path first. */
export const START_HERE_ITEMS: readonly StartHereItem[] = [...START_HERE_PATH, ...MORE_DEMOS];

/** An item by id; undefined for an id the list does not hold. */
export function startHereItem(id: string): StartHereItem | undefined {
  return START_HERE_ITEMS.find((i) => i.id === id);
}

/** The setup slot a demo opens in (the server's lineage rule, apps/server/src/examples). */
export const slotOf = (demoId: string): string => `demo-${demoId}`;

/** The newest done deterministic run of a slot, or null. */
export function doneRunOf(rows: readonly WorkspaceRunRow[], slot: string): string | null {
  const done = rows.filter((r) => r.setupLineageId === slot && r.mode !== "stochastic" && r.status?.state === "done");
  const at = (r: WorkspaceRunRow) => r.status?.submittedAt ?? r.at;
  done.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
  return done[0]?.runId ?? null;
}

/** Where a demo's Open lands once its slot has a done run: its Results screen on that run, the item named. */
export function resultHref(ws: string, item: StartHereItem, runId: string): string {
  return hrefFor({ ws, section: "results", screen: item.screen ?? "dashboard", query: { result: runId, demo: item.id } });
}

/**
 * What a step's Open does, given the workspace it runs on and that workspace's runs (null while they are read):
 *   "result"  the slot has a done run: Open lands on it;
 *   "setup"   no done run yet: Open sets the demo up on Run setups, where the learner presses Launch;
 *   "make"    no workspace on the desk yet, and the desk's first Open makes one;
 *   "explore" no workspace on the bank yet: the learner explores the bank first (step 1).
 */
export type OpenKind = "result" | "setup" | "make" | "explore";

export function openKind(item: StartHereItem, ws: WorkspaceManifest | null, rows: readonly WorkspaceRunRow[] | null): OpenKind {
  if (ws === null) return item.bookId === DESK_ID ? "make" : "explore";
  return rows !== null && doneRunOf(rows, slotOf(item.id)) !== null ? "result" : "setup";
}

/** The plain line a step shows under its learn line, by what Open does. */
export function openLine(kind: OpenKind): string {
  switch (kind) {
    case "result": return "Open shows its result.";
    case "setup": return "Open sets it up on Run setups. Press Launch there, then read the result.";
    case "make": return "Open makes a workspace for the deposit desk and sets it up on Run setups. Press Launch there.";
    case "explore": return "Explore the bank first (step 1): this demo opens on that workspace.";
  }
}

/**
 * Where step 1 goes when the bank's workspace exists: the Reports step once the finished analysis (the guided slot) has
 * a done run, else step 1 of the path. A done demo run does not count (S3f fix round, L4).
 */
export function exploreHref(ws: string, rows: readonly WorkspaceRunRow[]): string {
  return analysisHref(ws, doneRunOf(rows, GUIDED_SLOT) !== null ? "reports" : "market");
}

/** Where a demo's Open lands on Run setups (no run yet). */
export function setupHref(ws: string, item: StartHereItem): string {
  return demoHref(ws, slotOf(item.id));
}

/**
 * A demo the server lists but this store does not hold: a store seeded before the demos existed, or one whose seed
 * profile writes none (S3f fix round, L3). Either way the kit makes a store that holds them all.
 */
export const STORE_LACKS_DEMO = "This store does not hold this demo. npm run learn starts a store that holds every demo.";

/**
 * The old card's paragraph as the disclosure shows it (S3f fix round, L6): no change advice of its own (the item's
 * change line is the one), and no "Launch it" on a result already launched. A "Launch it, then open ...: <figure>"
 * sentence keeps its figure; a sentence that starts with "Change" or is only "Launch it, then open ..." is dropped.
 */
export function aboutText(text: string): string {
  const out: string[] = [];
  // No regex lookbehind: the design gate refuses it in the bundle (older browsers).
  const parts = text.split(/\.\s+/);
  for (const s of parts.map((x, i) => (i < parts.length - 1 ? `${x}.` : x))) {
    if (s.startsWith("Change ")) continue;
    if (s.startsWith("Launch it")) {
      const colon = s.indexOf(": ");
      if (colon >= 0) out.push(s.charAt(colon + 2).toUpperCase() + s.slice(colon + 3));
      continue;
    }
    out.push(s);
  }
  return out.join(" ");
}

/** What a step's control is: a link (the result, or the bank's workspace), a button that sets the item up, or off. */
export type StepAction = { kind: "link"; href: string } | { kind: "button" } | { kind: "off" };

export interface StepRow {
  item: StartHereItem;
  action: StepAction;
  /** A plain line under the learn line about what Open does; null when Open shows the result. */
  note: string | null;
  /** The server's row for a demo; null for step 1 and for a demo the server does not list. */
  demo: ExampleDemoRow | null;
}

/**
 * The card's rows. `demos` maps a demo id to the server's row (null while it is read); `runs` maps a workspace id to
 * its runs (absent while they are read). The bank's workspace and the desk's are the newest active ones on each book.
 */
export function stepRows(p: {
  items: readonly StartHereItem[];
  workspaces: readonly WorkspaceManifest[];
  demos: ReadonlyMap<string, ExampleDemoRow> | null;
  runs: ReadonlyMap<string, readonly WorkspaceRunRow[]>;
}): StepRow[] {
  return p.items.map((item): StepRow => {
    const ws = demoWorkspace(p.workspaces, item.bookId);
    const rows = ws === null ? null : p.runs.get(ws.id) ?? null;
    if (item.id === "explore") {
      if (ws === null) return { item, action: { kind: "button" }, note: null, demo: null };
      return { item, action: { kind: "link", href: exploreHref(ws.id, rows ?? []) }, note: null, demo: null };
    }
    const demo = p.demos?.get(item.id) ?? null;
    if (p.demos === null) return { item, action: { kind: "off" }, note: null, demo: null };
    if (demo === null) return { item, action: { kind: "off" }, note: "This platform does not list this demo.", demo: null };
    if (!demo.stored) return { item, action: { kind: "off" }, note: STORE_LACKS_DEMO, demo };
    const kind = openKind(item, ws, rows);
    if (kind === "result") return { item, action: { kind: "link", href: resultHref(ws!.id, item, doneRunOf(rows!, slotOf(item.id))!) }, note: null, demo };
    if (kind === "explore") return { item, action: { kind: "off" }, note: openLine(kind), demo };
    // While the workspace's runs are read, the button waits and says nothing yet.
    if (ws !== null && rows === null) return { item, action: { kind: "off" }, note: null, demo };
    return { item, action: { kind: "button" }, note: openLine(kind), demo };
  });
}
