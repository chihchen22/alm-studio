// apps/studio/src/guided/featureDemos.ts
/**
 * The feature demos on the example bank: one plain card per engine feature, and the one call a
 * card's Open button makes. Each demo is a run setup the seed stores (apps/server/src/examples/featureDemos.ts), with
 * the assumption sets it names. Open adds those sets to the Example bank workspace, saves the stored setup into a slot
 * of its own (identical content is the same document, so nothing new is written) and opens it on Run setups, where
 * Launch runs it.
 *
 * Every demo opens on Run setups, under Advanced, the six standardized shocks and the instrument results included: the
 * guided path holds one setup, the finished analysis, and a demo opened there would replace it. Each card's numbers
 * are the engine's on Quillfield Bank version 1.1, rounded; the card says "about".
 *
 * Pure parts first (which workspace a demo opens on), then the async call. The card copy moved to ./startHereCards.ts
 * in the S3f cleanup, when the Home sections it was written for were removed; it is re-exported here.
 */
import { getRunSetup, getWorkspace, saveRunSetup, setBlock, type ExampleDemoRow, type WorkspaceManifest } from "@alm/reader";
import { hrefFor } from "../router";

export { DEMO_CARDS, DEPOSIT_FORM_CARDS, SURVIVAL_PATH_CARDS, cardFor, type DemoCard } from "./startHereCards";

/**
 * The example books that ship demos. Quillfield Bank's demos open on the workspace that exploring
 * the example bank makes (it holds the finished analysis); the deposit desk's first Open makes its own workspace. Since
 * the S3f cleanup the Start here card and the learn seed read `makesWorkspace`; the titles were the old Home sections'.
 */
export interface DemoSection {
  bookId: string;
  title: string;
  /** The workspace name Open makes when none holds the book; null when the learner explores the example first. */
  makesWorkspace: string | null;
}

export const DEMO_SECTIONS: readonly DemoSection[] = [
  { bookId: "mid-size-bank-v1", title: "Feature demos", makesWorkspace: null },
  { bookId: "quillfield-deposit-desk-v1", title: "Deposit desk demos", makesWorkspace: "Deposit desk" },
];

/** A book's section; an example that ships demos and has no section here reads as a plain feature demo section. */
export function sectionFor(bookId: string): DemoSection {
  return DEMO_SECTIONS.find((s) => s.bookId === bookId) ?? { bookId, title: "Feature demos", makesWorkspace: null };
}

/**
 * S3c fix round (L7): Open on a section that makes its own workspace. The workspace Open made is remembered in `made`
 * (a ref the section card keeps), so a retry after a failed open reuses it instead of making a second one; a workspace
 * the store already lists for the book (`workspaceId`) is used first. Returns the address to open.
 */
export async function openOnSection(p: {
  workspaceId: string | null;
  made: { current: string | null };
  create: () => Promise<string>;
  open: (ws: string) => Promise<string>;
}): Promise<string> {
  let ws = p.workspaceId ?? p.made.current;
  if (ws === null) {
    ws = await p.create();
    p.made.current = ws;
  }
  return p.open(ws);
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A count as a capitalized word ("Eight"), the digits past twelve. */
export function countWord(n: number): string {
  const w = WORDS[n] ?? String(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** The words of a card's text, as a reader counts them. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * The workspace a demo opens on: the newest active workspace whose position book is the example bank. Null when there
 * is none (the card then says to explore the example bank first).
 */
export function demoWorkspace(workspaces: readonly WorkspaceManifest[], bookId: string): WorkspaceManifest | null {
  const mine = workspaces.filter((w) => w.status === "active" && w.lock === null && w.blocks.positions.book?.id === bookId);
  mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return mine[0] ?? null;
}

/** Where Open lands: the demo's slot on Run setups. */
export function demoHref(ws: string, lineageId: string): string {
  return hrefFor({ ws, section: "run", screen: "setups", slot: lineageId });
}

/** The reader calls Open makes; a test hands in its own. */
export const DEMO_API = { getWorkspace, setBlock, getRunSetup, saveRunSetup };
export type DemoApi = typeof DEMO_API;

/**
 * Open one demo on a workspace: add each set the demo names that the workspace does not hold yet, then save the stored
 * setup into the demo's slot. Saving content the store already holds writes no document; a slot that already holds it
 * moves nothing. Returns the address to open.
 */
export async function openFeatureDemo(p: { ws: string; demo: ExampleDemoRow; by: string }, api: DemoApi = DEMO_API): Promise<string> {
  let head = await api.getWorkspace(p.ws);
  for (const setId of p.demo.setIds) {
    if (head.blocks.assumptions.sets.some((s) => s.id === setId)) continue;
    head = await api.setBlock(p.ws, { expectedRevision: head.revision, by: p.by, block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: setId } });
  }
  const stored = await api.getRunSetup(p.demo.setupId);
  const { id: _id, ...setup } = stored;
  await api.saveRunSetup({ workspaceId: p.ws, setupLineageId: p.demo.lineageId, expectedRevision: head.revision, by: p.by, setup });
  return demoHref(p.ws, p.demo.lineageId);
}
