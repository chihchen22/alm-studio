/**
 * The two optional slots of each Start here item, a short text and a guide path. Unset, the
 * "More about this demo" box shows the old card copy and the card renders byte for byte as it did before the slots
 * existed (the hash below was taken from the build, before this slice, on the same fixture). Set, the box
 * shows the short text and "Read more: <path>" instead of the card copy. Expected lines are restated here by hand.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExampleDemoRow } from "@alm/reader";
import { GUIDE_BASE_URL, GUIDE_TOPICS, guideHref, MORE_DEMOS, START_HERE_ITEMS, START_HERE_PATH, stepRows, type StartHereItem } from "../guided/startHere";
import { StartHereView } from "../pages/workspace/StartHere";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const demoRow = (id: string): ExampleDemoRow => ({ id, title: id, lineageId: `demo-${id}`, setupId: `rs-${id}`, setIds: ["s"], stored: true });
const demos = new Map(START_HERE_ITEMS.filter((i) => i.id !== "explore").map((i) => [i.id, demoRow(i.id)]));
const render = (path: readonly StartHereItem[], more: readonly StartHereItem[]) => {
  const rows = (items: readonly StartHereItem[]) => stepRows({ items, workspaces: [], demos, runs: new Map() });
  return renderToStaticMarkup(<StartHereView path={rows(path)} more={rows(more)} busy={null} error={null} status={null} onOpen={() => undefined} />);
};
/**
 * The shipped list with both slots stripped from every item (S4 fix round 2): the S4b docs set all sixteen, so the
 * unset-slot behavior is held on this fixture, not on the shipped list.
 */
const unset = (xs: readonly StartHereItem[]): StartHereItem[] => xs.map(({ short: _s, guide: _g, ...i }) => i);
/**
 * The "Read more" line as the box renders it: plain text when the guide base is null, a link to the repository's
 * file view when it is set. Restated by hand for both.
 */
const PUBLIC_GUIDE_BASE = "https://github.com/chihchen22/alm-studio/blob/main/";
const readMore = (guide: string): string =>
  GUIDE_BASE_URL === null ? `Read more: ${guide}` : `Read more: <a href="${PUBLIC_GUIDE_BASE}${guide}" target="_blank" rel="noreferrer">${guide}</a>`;
const PATH = unset(START_HERE_PATH);
const MORE = unset(MORE_DEMOS);
/** The card on an empty store with every demo listed, rendered on the unmodified code before the slots existed: 22,608 characters. */
const BEFORE_SLOTS_SHA256 = "402595c3505e46981c36ed02ff1cb0afd4a2b10838e0d9fefd487928ffdb2400";
/**
 * One sentence of the SEG card copy (guided/startHereCards.ts) was corrected to the SEG target's coverage, so the
 * unset card was retaken on the same fixture: 22,615 characters. Put the old sentence
 * back and the card is the card from before the slots byte for byte, so nothing else moved.
 */
const SEG_SENTENCE_BEFORE = "It covers the loans and the non-maturity deposits only.";
const SEG_SENTENCE_NOW = "It covers every earning asset and every liability but the CDs.";
const UNSET_CARD_SHA256 = "c96a357ce0424755e7d3cff4272c3771c1b6c699f117460826960b597e87af56";

describe("the Start here box slots, unset", () => {
  it("renders the card byte for byte as before the slots existed, but for the corrected SEG sentence", () => {
    const html = render(PATH, MORE);
    expect(html.length).toBe(22_615);
    expect(createHash("sha256").update(html).digest("hex")).toBe(UNSET_CARD_SHA256);
    expect(html).not.toContain("Read more:");
    expect(html.split(SEG_SENTENCE_NOW)).toHaveLength(2);
    const before = html.replace(SEG_SENTENCE_NOW, SEG_SENTENCE_BEFORE);
    expect(before.length).toBe(22_608);
    expect(createHash("sha256").update(before).digest("hex")).toBe(BEFORE_SLOTS_SHA256);
  });
});

describe("the Start here box slots, set", () => {
  const short = "Value is what the bank's future cash is worth today. A rate move changes it. Each shock is one row.";
  const withSlots = (id: string, guide: StartHereItem["guide"]) => PATH.map((i) => (i.id === id ? { ...i, short, guide } : i));

  it("shows the short text and the guide path as plain text instead of the old card copy, on that item only", () => {
    const html = render(withSlots("six-shocks", "docs/guide/eve.md"), MORE);
    const box = html.slice(html.indexOf('aria-label="Step 2: Six regulatory shocks (EVE)"'), html.indexOf('aria-label="Step 3:'));
    expect(box).toContain("<summary>More about this demo</summary>");
    expect(box).toContain(`<li>${short.replace(/'/g, "&#x27;")}</li><li>${readMore("docs/guide/eve.md")}</li></ul>`);
    if (GUIDE_BASE_URL === null) expect(box).not.toContain("<a ");
    // The old six-shocks card copy (restated from guided/startHereCards.ts) is gone from this box only.
    expect(box).not.toContain("The six standardized shocks are the rate moves");
    expect(box).not.toContain("recalibrated in July 2024");
    expect(html).toContain("The CDs are not split.");
    expect((html.match(/Read more: /g) ?? []).length).toBe(1);
    expect((html.match(/More about this demo/g) ?? []).length).toBe(15);
  });

  it("gives step 1, which has no card, a box once its slots are set", () => {
    const html = render(withSlots("explore", "docs/guide/explore.md"), MORE);
    expect((html.match(/More about this demo/g) ?? []).length).toBe(16);
    expect(html).toContain(`<li>${readMore("docs/guide/explore.md")}</li>`);
  });

  it("keeps the old copy when only one of the two slots is set", () => {
    const one = PATH.map((i) => (i.id === "six-shocks" ? { ...i, short } : i));
    const html = render(one, MORE);
    expect(html).not.toContain("Read more:");
    expect(html).toContain("The six standardized shocks are the rate moves");
  });
});

describe("the guide link", () => {
  it("is plain text with no guide base and a link to the repository's file view with one", () => {
    expect(GUIDE_BASE_URL === null || GUIDE_BASE_URL === PUBLIC_GUIDE_BASE).toBe(true);
    expect(guideHref("docs/guide/eve.md", null)).toBeNull();
    expect(guideHref("docs/guide/eve.md", PUBLIC_GUIDE_BASE)).toBe("https://github.com/chihchen22/alm-studio/blob/main/docs/guide/eve.md");
    expect(guideHref("docs/guide/eve.md")).toBe(GUIDE_BASE_URL === null ? null : `${PUBLIC_GUIDE_BASE}docs/guide/eve.md`);
  });
});

describe("the slots on the shipped list", () => {
  it("are all sixteen set (S4b), each box showing its short text and its topic page and no old card copy", () => {
    // The topic of each item, restated by hand from the S4 guide plan (fact-checked), not read from the list.
    const TOPIC: Record<string, string> = {
      explore: "explore", "six-shocks": "eve", seg: "nii-seg", "fixed-ladder": "gap", "funding-tenor": "ftp",
      "desk-full-beta-frozen": "deposits", "desk-credit": "ftp", "survival-path": "liquidity", regulatory: "deposits",
      "spread-consistent": "eve", instruments: "explore", "constant-prepay": "liquidity", "desk-linear-decay": "deposits",
      "desk-component-decay": "deposits", "desk-full-beta-shocked": "deposits", "desk-scenario-credit": "ftp",
    };
    expect(START_HERE_ITEMS.map((i) => i.id).sort()).toEqual(Object.keys(TOPIC).sort());
    const html = render(START_HERE_PATH, MORE_DEMOS);
    expect((html.match(/More about this demo/g) ?? []).length).toBe(16);
    expect((html.match(/Read more: /g) ?? []).length).toBe(16);
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
    for (const item of START_HERE_ITEMS) {
      expect(item.guide, item.id).toBe(`docs/guide/${TOPIC[item.id]}.md`);
      expect(html, item.id).toContain(`<li>${esc(item.short!)}</li><li>${readMore(`docs/guide/${TOPIC[item.id]}.md`)}</li></ul>`);
    }
    // No card copy or card note is left in any box (two notes restated from guided/startHereCards.ts).
    expect(html).not.toContain("The CDs are not split.");
    expect(html).not.toContain("The US has not adopted it.");
  });

  it("are set together or not at all, point to a topic page that exists, and hold two or three sentences and no figure", () => {
    expect(GUIDE_TOPICS).toEqual(["explore", "eve", "nii-seg", "gap", "ftp", "deposits", "liquidity"]);
    for (const item of START_HERE_ITEMS) {
      expect(item.short === undefined, `${item.id}: short and guide are set together`).toBe(item.guide === undefined);
      if (item.short === undefined || item.guide === undefined) continue;
      expect(existsSync(resolve(REPO, item.guide)), `${item.id}: ${item.guide} exists`).toBe(true);
      const sentences = item.short.split(/[.!?](\s+|$)/).filter((s) => s.trim().length > 1).length;
      expect(sentences, `${item.id}: two or three sentences`).toBeGreaterThanOrEqual(2);
      expect(sentences, `${item.id}: two or three sentences`).toBeLessThanOrEqual(3);
      // A figure belongs on the guide page, where the docs check holds it to a replica target; the box quotes none.
      expect(item.short, `${item.id}: no figure`).not.toMatch(/\d/);
    }
  });
});
