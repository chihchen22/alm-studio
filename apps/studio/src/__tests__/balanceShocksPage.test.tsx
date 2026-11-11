// apps/studio/src/__tests__/balanceShocksPage.test.tsx
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BalancePlanListItem, DerivedBalancePlanPreview } from "@alm/reader";
import type { BalancePlan } from "@alm/engine";
import { BalanceShocksView, BALANCE_SHOCK_COPY, type BalanceShocksViewProps } from "../pages/scenarios/BalanceShocksPage";
import { addBalanceOp, emptyBalanceShockDraft, setBalanceBase, setBalanceOpField, type BalanceShockDraft } from "../scenarios/balanceShockModel";

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};

/** The seven paragraphs, restated verbatim from the approved design. */
const COPY = [
  "Derive a new balance plan from a stored one: pick a base plan, then add to, scale or set the target balance of a listed family, at every knot of its path or at one knot month. The server derives the plan, checks that every target still lowers onto the new-business rule against the book in the top bar, and stores it under its own id with a record of its base and its ops. Nothing runs here: bind the derived plan to a scenario on Scenario sets, in a plan with a balance stage.",
  "Add is in book currency units: add -10000000 lowers the target by 10,000,000. Scale multiplies the stored target by the factor: 0.9 is ten percent lower. Set replaces the target at one knot month and needs that month. Add and scale results are kept to 12 significant digits; set stores the value exactly. A target must stay finite and at least 0, and a target ending at zero is refused: leave the family out of the plan to run it off.",
  "Each target is carried as one monthly growth rate from the opening balance, and that rate continues past the last knot to the horizon. A one-knot target lowers unless its knot is at zero or the family has no opening balance on the book. A target that falls faster than the book runs off cannot be met: new business cannot be negative, so origination stops at zero, the balance follows runoff, and the run reports a shortfall for that family. A multi-knot path lowers only while it stays a single geometric growth from the opening balance, so on such a path the engine refuses a uniform scale or add as well as a change at one knot. No op adds or removes a family or a knot.",
  "Under the wiring that Add balance stage on Scenario sets builds, a balance shock moves NII only, through dynamic new business: EVE, the repricing and liquidity gaps and FTP stay on the contractual stage and run the book off. A hand-wired plan that also feeds the balance stage to EVE, a gap or a custom metric moves those measures as well. The opening balance is not shocked, and a stochastic run refuses a balance plan on its base scenario.",
  "Attribution compares each scenario with the base scenario. A scenario whose lowered new-business rules differ from the base scenario's is declined by attribution for NII 12 month, NII 24 month and EVE (EVE too, even where the shock does not move EVE), with a not-implemented note, and the run proceeds; the shock's effect shows only in the scenario totals.",
  "Every value entered here is a demonstration value, calibrated to nothing. The derived plan's label says so.",
  // Re-expectation: volatility shocks are built and leave the Not built list; the sentence names both derived-market pages.
  "Not built: new-business pricing shocks (spread over index and term). Funding spread (TLP) shocks and volatility shocks are derived markets, on Funding spread shocks and Volatility shocks.",
];

const PLANS: BalancePlanListItem[] = [
  { id: "balance-targets-demo-v1", contentHash: "h1", label: "Deposit targets held flat at month 12 on the synthetic book (demonstration values)", asOf: "2026-03-31" },
  { id: "balance-shock-demo-v1", contentHash: "h2", label: "dda target 10% lower at month 12 on the deposit targets (demonstration values, NOT calibrated)", asOf: "2026-03-31", derivedFromPlanId: "balance-targets-demo-v1" },
];

const BASE: BalancePlan = {
  schemaVersion: "1.0.0",
  id: "balance-targets-demo-v1",
  label: PLANS[0]!.label,
  asOf: "2026-03-31",
  targets: [
    { familyId: "dda", path: [{ month: 12, balance: 97178194 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
    { familyId: "mma", path: [{ month: 12, balance: 156318023 }], newBusinessPricing: { spreadOverIndexBp: -100, termMonths: 12 } },
  ],
  unlistedFamilies: "runoff",
};

function draftWithOp(): BalanceShockDraft {
  let d = addBalanceOp(setBalanceBase(emptyBalanceShockDraft(), BASE.id));
  d = setBalanceOpField(d, 0, { familyId: "dda" });
  return setBalanceOpField(d, 0, { month: 12, op: "scale", valueText: "0.9" });
}

const props = (over: Partial<BalanceShocksViewProps> = {}): BalanceShocksViewProps => ({
  plans: PLANS,
  base: BASE,
  baseNote: null,
  bookId: "synthetic-2500-v1",
  draft: draftWithOp(),
  block: null,
  preview: null,
  note: null,
  busy: null,
  setsLink: null,
  onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
  ...over,
});

const PREVIEW: DerivedBalancePlanPreview = {
  plan: { ...BASE, id: "derived-bp-0123456789ab", targets: [{ ...BASE.targets[0]!, path: [{ month: 12, balance: 87460374.6 }] }, BASE.targets[1]!] },
  changes: [{ targetIndex: 0, familyId: "dda", month: 12, from: 97178194, to: 87460374.6, ops: [0] }],
  rules: [
    { familyId: "dda", reinvest: "growth", monthlyGrowthRate: -0.008741610954696721, spreadOverIndexBp: -100, termMonths: 12 },
    { familyId: "mma", reinvest: "flat", spreadOverIndexBp: -100, termMonths: 12 },
  ],
};

describe("BalanceShocksView copy", () => {
  it("prints each paragraph verbatim, matching the exported copy", () => {
    const t = text(renderToStaticMarkup(<BalanceShocksView {...props()} />));
    for (const p of COPY) expect(t, p.slice(0, 40)).toContain(p);
    expect(Object.values(BALANCE_SHOCK_COPY)).toHaveLength(7);
    for (const p of Object.values(BALANCE_SHOCK_COPY)) expect(COPY).toContain(p);
  });
  it("the measures paragraph names the wiring, the hand-wired case and the stochastic refusal", () => {
    const m = BALANCE_SHOCK_COPY.measures;
    expect(m).toContain("Add balance stage");
    expect(m).toContain("hand-wired plan");
    expect(m).toContain("stochastic run refuses");
  });
  it("holds neither an em-dash nor a section sign, in markup or in source", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props({ preview: PREVIEW })} />);
    expect(html).not.toMatch(BANNED_CHARS);
    for (const f of ["../pages/scenarios/BalanceShocksPage.tsx", "../scenarios/balanceShockModel.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(BANNED_CHARS);
    }
  });
});

describe("BalanceShocksView form", () => {
  it("names the book, lists the base plans and the op row's choices", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props()} />);
    const t = text(html);
    expect(t).toContain("Checked against book synthetic-2500-v1");
    expect(t).toContain("balance-targets-demo-v1: Deposit targets held flat at month 12 on the synthetic book (demonstration values) (as of 2026-03-31)");
    expect(t).toContain("dda, 1 knot at month 12");
    expect(t).toContain("Every knot");
    expect(t).toContain("Month 12, stored 97,178,194");
    expect(t).toContain("Scale by");
    expect(html).toContain('value="0.9"');
    expect(t).toContain("Book currency units for Add, a factor for Scale by, a balance for Set to");
    expect(t).toContain("Leave empty for a label that names the base plan");
    expect(t).toContain("Leave empty for the derived id");
    expect(t).toContain("Add an op");
  });
  it("asks for a book when there is none", () => {
    expect(text(renderToStaticMarkup(<BalanceShocksView {...props({ bookId: null })} />))).toContain("Pick a book in the top bar");
  });
  it("turns Preview and Save off by aria-disabled with the reason when blocked", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props({ block: "Enter a number" })} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Preview<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Save<\/button>/);
    expect(text(html)).toContain("Enter a number");
    expect(renderToStaticMarkup(<BalanceShocksView {...props()} />)).not.toContain('aria-disabled="true"');
  });
  it("says it is reading the base plan, or why it could not", () => {
    expect(text(renderToStaticMarkup(<BalanceShocksView {...props({ base: null, baseNote: "Reading plan balance-targets-demo-v1" })} />))).toContain("Reading plan balance-targets-demo-v1");
    expect(text(renderToStaticMarkup(<BalanceShocksView {...props({ base: null, baseNote: "404: balance plan not found" })} />))).toContain("404: balance plan not found");
  });
});

describe("BalanceShocksView preview", () => {
  it("prints the served base and derived targets and the served lowering", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props({ preview: PREVIEW })} />);
    expect(text(html)).toContain("Preview: derived-bp-0123456789ab");
    const first = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const targets = text(html.slice(first, html.indexOf("</table>", first)));
    for (const h of ["Family", "Knot month", "Base target", "Derived target"]) expect(targets).toContain(h);
    expect(targets).toContain("97,178,194");
    expect(targets).toContain("87,460,374.6");
    const second = html.indexOf("<table", html.indexOf("</table>", first));
    const lowering = text(html.slice(second, html.indexOf("</table>", second)));
    for (const h of ["Family", "Lowers to", "Monthly growth rate"]) expect(lowering).toContain(h);
    expect(lowering).toContain("One growth rate");
    expect(lowering).toContain("-0.008741610954696721");
    expect(text(html)).toContain("After lowering");
    expect(text(html)).toContain("Source: /api/balance-plans/derive/preview");
  });
  it("the lowering table lists only the changed families, and says none for a flat rule", () => {
    const both = { ...PREVIEW, changes: [...PREVIEW.changes, { targetIndex: 1, familyId: "mma", month: 12, from: 156318023, to: 156318023, ops: [1] }] };
    const html = renderToStaticMarkup(<BalanceShocksView {...props({ preview: both })} />);
    const afterHead = html.indexOf("After lowering");
    const t = text(html.slice(afterHead, html.indexOf("</table>", afterHead)));
    expect(t).toContain("Hold flat");
    expect(t).toContain("none");
    const one = renderToStaticMarkup(<BalanceShocksView {...props({ preview: PREVIEW })} />);
    const oneT = text(one.slice(one.indexOf("After lowering"), one.indexOf("</table>", one.indexOf("After lowering"))));
    expect(oneT).not.toContain("mma");
  });
  it("shows no preview card when there is none", () => {
    expect(text(renderToStaticMarkup(<BalanceShocksView {...props()} />))).not.toContain("Preview: ");
  });
});

describe("BalanceShocksView notes", () => {
  it("lists every problem of a refusal", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props({ note: { kind: "refused", text: "Refused: every problem is listed.", problems: ["ops[0]: first", "second problem"], savedId: null } })} />);
    const t = text(html);
    expect(t).toContain("Refused: every problem is listed.");
    expect(t).toContain("ops[0]: first");
    expect(t).toContain("second problem");
    expect(html).toContain('role="alert"');
  });
  it("links a saved plan to Scenario sets with the Add balance stage pointer", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props({
      note: { kind: "created", text: "Saved as derived-bp-0123456789ab", problems: [], savedId: "derived-bp-0123456789ab" },
      setsLink: "#/data/scenarios/sets",
    })} />);
    expect(html).toContain('href="#/data/scenarios/sets"');
    expect(text(html)).toContain("Bind it on Scenario sets");
    expect(text(html)).toContain("Add balance stage on Scenario sets if the plan has none");
  });
  it("a conflict prints the server text and no link", () => {
    const t = text(renderToStaticMarkup(<BalanceShocksView {...props({ note: { kind: "conflict", text: "409: exists", problems: [], savedId: null } })} />));
    expect(t).toContain("409: exists");
    expect(t).not.toContain("Bind it on Scenario sets");
  });
});

describe("BalanceShocksView stored table", () => {
  it("lists only the derived plans, with base and as-of", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props()} />);
    const t = text(html.slice(html.indexOf('aria-label="Stored balance shocks"')));
    for (const h of ["Plan", "Label", "Base plan", "As of"]) expect(t).toContain(h);
    expect(t).toContain("balance-shock-demo-v1 dda target 10% lower at month 12 on the deposit targets (demonstration values, NOT calibrated) balance-targets-demo-v1 2026-03-31");
    // The plain base plan is not a stored shock.
    expect(t).not.toContain("Deposit targets held flat");
  });
  it("says None stored when no plan is derived", () => {
    const html = renderToStaticMarkup(<BalanceShocksView {...props({ plans: [PLANS[0]!] })} />);
    expect(text(html.slice(html.indexOf('aria-label="Stored balance shocks"')))).toContain("None stored");
  });
});
