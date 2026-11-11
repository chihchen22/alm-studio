// apps/server/src/__tests__/studioP6aAcceptance.test.tsx
/**
 * ALM Studio Piece 6a acceptance on a freshly seeded test platform: the
 * Behavioral shocks view fed by the real routes. The listing feeds the stored
 * table with the seeded decay shock set; a preview through the real derive
 * route renders the served from and to values; a save, the Scenario sets link
 * and the Scenario sets hint name the saved id. Expected values are restated
 * here, never read from the code they check.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getAssumptionSet, listAssumptionSets, previewDerivedSet, saveDerivedSet, type DerivedSetPreview } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { bootTestPlatform, type TestPlatform } from "./harness";
import { parseHash } from "../../../studio/src/router";
import { BehavioralShocksView, type BehavioralShocksViewProps } from "../../../studio/src/pages/scenarios/BehavioralShocksPage";
import { SetHint } from "../../../studio/src/pages/scenarios/ScenariosViews";
import { addOp, emptyShockDraft, requestOf, saveNoteOf, setBase, setOpField, setsHref } from "../../../studio/src/scenarios/behavioralShockModel";

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  // Studio's reader client calls relative /api paths; send them to the test platform.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const text = (s: string) =>
  s.replace(/<wbr\/?>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};

const BASE_ID = "demo-behavioral-v1";

describe("Behavioral shocks on the seeded platform", () => {
  it("the listing feeds the stored table with the seeded decay shock set and its base", async () => {
    const sets = await listAssumptionSets();
    const html = renderToStaticMarkup(<BehavioralShocksView {...view({ sets })} />);
    const m = html.match(/<section[^>]*aria-label="Stored behavioral shocks"[^>]*>([\s\S]*?)<\/section>/);
    expect(m).not.toBeNull();
    const rows = [...m![1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => text(r[1]!));
    expect(rows).toContain("decay-shock-demo-v1 Deposit decay +25% on the demo set (demonstration values, NOT calibrated) demo-behavioral-v1");
    // A plain set is not a behavioral shock.
    expect(rows.some((r) => r.startsWith("vanilla-empty-v1"))).toBe(false);
  });

  it("a preview through the real route renders the served 0.75 and 0.9375, and a save links to Scenario sets", async () => {
    const base = await getAssumptionSet(BASE_ID);
    let draft = addOp(setBase(emptyShockDraft(), BASE_ID));
    draft = setOpField(draft, 0, { bindingIndex: 2 });
    draft = setOpField(draft, 0, { path: "params.closureSteady", op: "scale", valueText: "1.25" });
    const req = requestOf(draft, base);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    expect(req.body).toEqual({
      baseId: BASE_ID,
      ops: [{ target: { familyId: "dda", kind: "nmd-decay" }, path: "params.closureSteady", op: "scale", value: 1.25 }],
    });

    const preview: DerivedSetPreview = await previewDerivedSet(req.body);
    const previewHtml = renderToStaticMarkup(<BehavioralShocksView {...view({ sets: await listAssumptionSets(), base, draft, preview })} />);
    const from = previewHtml.indexOf("<table", previewHtml.indexOf('aria-label="Preview"'));
    const table = text(previewHtml.slice(from, previewHtml.indexOf("</table>", from)));
    expect(table).toContain("Steady closure rate");
    expect(table).toContain("0.75");
    expect(table).toContain("0.9375");

    const reply = await saveDerivedSet(req.body);
    expect(reply.outcome).toBe("created");
    expect(reply.set.id).toMatch(/^derived-[0-9a-f]{12}$/);
    const note = saveNoteOf(reply);
    expect(note.savedId).toBe(reply.set.id);
    const link = setsHref("ws-a", {}, reply.set.id);
    expect(link).toBe(`#/ws/ws-a/run/setups?tab=scenarios&set=${reply.set.id}`);
    const savedHtml = renderToStaticMarkup(<BehavioralShocksView {...view({ sets: await listAssumptionSets(), base, draft, preview, note, setsLink: link })} />);
    expect(savedHtml).toContain(`href="${link.replaceAll("&", "&amp;")}"`);

    // The link lands on the scenario choice of Run setups with the saved id in its query, and the hint names it.
    const route = parseHash(link);
    expect(route).toMatchObject({ kind: "screen", ws: "ws-a", section: "run", screen: "setups" });
    expect(text(renderToStaticMarkup(<SetHint query={route.query} />))).toBe(`Set ${reply.set.id}: pick it on a scenario or as the plan default.`);
  });
});

function view(over: Partial<BehavioralShocksViewProps>): BehavioralShocksViewProps {
  return {
    sets: [], base: null, baseNote: null, draft: emptyShockDraft(), block: null, preview: null, note: null, busy: null, setsLink: null,
    onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
    ...over,
  };
}
