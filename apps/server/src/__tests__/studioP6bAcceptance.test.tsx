// apps/server/src/__tests__/studioP6bAcceptance.test.tsx
/**
 * ALM Studio Piece 6b acceptance on a freshly seeded test platform: the Balance
 * shocks view fed by the real routes. The request is built through the model, a
 * preview through the real derive route renders the served base and derived
 * targets and the served lowering, a save answers 201 with a derived-bp id, and
 * the stored table after a re-list names the saved plan and its base. Expected
 * values are restated here, never read from the code they check.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getBalancePlan, listBalancePlans, previewDerivedBalancePlan, saveDerivedBalancePlan, type DerivedBalancePlanPreview } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { bootTestPlatform, type TestPlatform } from "./harness";
import { ensureDemoBalancePlan } from "./seedFixtures";
import { parseHash } from "../../../studio/src/router";
import { BalanceShocksView, type BalanceShocksViewProps } from "../../../studio/src/pages/scenarios/BalanceShocksPage";
import { addBalanceOp, balanceRequestOf, balanceSaveNoteOf, emptyBalanceShockDraft, setBalanceBase, setBalanceOpField, setsLinkFor } from "../../../studio/src/scenarios/balanceShockModel";

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  const store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  ensureDemoBalancePlan(store);
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

const BASE_ID = "balance-targets-demo-v1";
const BOOK = "synthetic-2500-v1";

function view(over: Partial<BalanceShocksViewProps>): BalanceShocksViewProps {
  return {
    plans: [], base: null, baseNote: null, bookId: BOOK, draft: emptyBalanceShockDraft(), block: null, preview: null, note: null, busy: null, setsLink: null,
    onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
    ...over,
  };
}

describe("Balance shocks on the seeded platform", () => {
  it("a preview through the real route renders the served targets and the served lowering, and a save names the id and links to Scenario sets", async () => {
    const base = await getBalancePlan(BASE_ID);
    let draft = addBalanceOp(setBalanceBase(emptyBalanceShockDraft(), BASE_ID));
    draft = setBalanceOpField(draft, 0, { familyId: "dda" });
    draft = setBalanceOpField(draft, 0, { month: 12, op: "scale", valueText: "0.9" });
    const req = balanceRequestOf(draft, base, BOOK);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    expect(req.body).toEqual({ baseId: BASE_ID, bookId: BOOK, ops: [{ target: { familyId: "dda", month: 12 }, op: "scale", value: 0.9 }] });

    const preview: DerivedBalancePlanPreview = await previewDerivedBalancePlan(req.body);
    const plans = await listBalancePlans();
    const html = renderToStaticMarkup(<BalanceShocksView {...view({ plans, base, draft, preview })} />);
    const first = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const targets = text(html.slice(first, html.indexOf("</table>", first)));
    expect(targets).toContain("97,178,194");
    expect(targets).toContain("87,460,374.6");
    const lowering = html.slice(html.indexOf('aria-label="After lowering"'));
    expect(text(lowering.slice(0, lowering.indexOf("</table>")))).toContain("One growth rate");
    expect(text(lowering.slice(0, lowering.indexOf("</table>")))).toContain("-0.008741610954696721");

    const reply = await saveDerivedBalancePlan(req.body);
    expect(reply.outcome).toBe("created");
    expect(reply.plan.id).toMatch(/^derived-bp-[0-9a-f]{12}$/);
    const note = balanceSaveNoteOf(reply);
    expect(note).toMatchObject({ kind: "created", text: `Saved as ${reply.plan.id}`, savedId: reply.plan.id });

    // The stored table after a re-list names the saved plan, its base and its as-of; the plain base is not a shock.
    const after = await listBalancePlans();
    const savedHtml = renderToStaticMarkup(<BalanceShocksView {...view({ plans: after, base, draft, preview, note, setsLink: setsLinkFor("ws-a", {}) })} />);
    const m = savedHtml.match(/<section[^>]*aria-label="Stored balance shocks"[^>]*>([\s\S]*?)<\/section>/);
    expect(m).not.toBeNull();
    const rows = [...m![1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => text(r[1]!));
    expect(rows).toContain(`${reply.plan.id} Balance shock on balance-targets-demo-v1 (demonstration values) balance-targets-demo-v1 2026-03-31`);
    expect(rows.some((r) => r.startsWith(`${BASE_ID} `))).toBe(false);
    // The seeded shock plan is listed too, on the fresh seed, with its base and as-of.
    expect(rows).toContain(
      "balance-shock-demo-v1 dda target 10% lower at month 12 on the deposit targets (demonstration values, NOT calibrated) balance-targets-demo-v1 2026-03-31",
    );

    // The link lands on the scenario choice of Run setups, inside the workspace.
    expect(setsLinkFor("ws-a", {})).toBe("#/ws/ws-a/run/setups?tab=scenarios");
    expect(savedHtml).toContain('href="#/ws/ws-a/run/setups?tab=scenarios"');
    expect(parseHash(setsLinkFor("ws-a", {}))).toMatchObject({ kind: "screen", ws: "ws-a", section: "run", screen: "setups" });
  });

  it("a refusal through the real route reaches the page as every problem listed", async () => {
    const base = await getBalancePlan(BASE_ID);
    let draft = addBalanceOp(setBalanceBase(emptyBalanceShockDraft(), BASE_ID));
    draft = setBalanceOpField(draft, 0, { familyId: "dda" });
    draft = setBalanceOpField(draft, 0, { month: 12, op: "add", valueText: "-100000000000" });
    const req = balanceRequestOf(draft, base, BOOK);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    const note = await previewDerivedBalancePlan(req.body).then(() => null, balanceSaveNoteOf);
    expect(note).not.toBeNull();
    expect(note!.kind).toBe("refused");
    expect(note!.text).toBe("Refused: every problem is listed.");
    expect(note!.problems).toEqual(["dda month 12: the derived target balance is -99902821806; a target balance must be finite and at least 0"]);
  });
});
