// apps/studio/src/__tests__/behavioralShocksPage.test.tsx
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSetListItem, DerivedSetPreview } from "@alm/reader";
import { bindAssumptions } from "@alm/engine/src/scenario";
import { buildDemoAssumptions } from "@alm/data/src/demo/request";
import { BehavioralShocksView, type BehavioralShocksViewProps } from "../pages/scenarios/BehavioralShocksPage";
import { addOp, emptyShockDraft, setBase, setOpField, type ShockDraft } from "../scenarios/behavioralShockModel";

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const demo = bindAssumptions(buildDemoAssumptions());
const noop = () => {};

const COPY = [
  "Derive a new assumption set from a stored one: pick a base set, then add to, scale or set named behavioral parameters. The server derives the set, checks every value against the parameter schema, and stores it under its own id with a record of its base and its ops. Nothing runs here: bind the derived set to a scenario on Scenario sets.",
  "Values are in the unit each parameter is stored in and are never converted. Add 3 to a % CPR parameter means three percentage points; add 25 to a bp parameter means 25 basis points. Scale multiplies the stored value by the factor: 1.25 is a quarter more, and 0 sets a value to zero where the schema allows zero. Add and scale results are kept to 12 significant digits; set stores the value exactly.",
  "Every value entered here is a demonstration value, calibrated to nothing. The derived set's label says so.",
  "Attribution does not split a behavioral shock. A scenario whose assumption set differs from the base scenario's set is declined by attribution, not split into drivers, so a derived set's effect shows only in the scenario totals.",
  "Where a family binds both a loan client rate and a four-factor prepayment model, the total spread must equal the securitization plus the primary spread. A shock that moves one side alone is refused; move both by the same basis points in one derivation.",
  "Only number parameters can be shocked. The deposit decay buckets and the commitment draw ramp are not offered, and neither are a plugin's registered parameters.",
  // Re-expectation: volatility shocks are built, so the "Not built" lead is dropped and the paragraph points to Volatility shocks.
  "A scenario cannot move the funding spread curve or a volatility surface, and no deterministic result reads a volatility. Target balances are shocked on Balance shocks, the funding spread (TLP) on Funding spread shocks and the constructed short-rate volatilities on Volatility shocks, each saved as its own input and run as its own run; a volatility shock moves stochastic runs only.",
];

const SETS: AssumptionSetListItem[] = [
  { id: "demo-behavioral-v1", label: "Demo behavioral set", contentHash: "h1", bindingCount: 4 },
  { id: "decay-shock-demo-v1", label: "Deposit decay +25% on the demo set (demonstration values, NOT calibrated)", contentHash: "h2", bindingCount: 4, derivedFromSetId: "demo-behavioral-v1" },
];

function draftWithOp(valueText: string): ShockDraft {
  let d = addOp(setBase(emptyShockDraft(), "demo-behavioral-v1"));
  d = setOpField(d, 0, { bindingIndex: 2 });
  return setOpField(d, 0, { path: "params.closureSteady", op: "scale", valueText });
}

const props = (over: Partial<BehavioralShocksViewProps> = {}): BehavioralShocksViewProps => ({
  sets: SETS,
  base: demo,
  baseNote: null,
  draft: draftWithOp("1.25"),
  block: null,
  preview: null,
  note: null,
  busy: null,
  setsLink: null,
  onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
  ...over,
});

const PREVIEW: DerivedSetPreview = {
  set: { schemaVersion: demo.schemaVersion, id: "derived-0123456789ab", label: "Behavioral shock on demo-behavioral-v1 (demonstration values)", bindings: [] },
  changes: [{ bindingIndex: 2, familyId: "dda", kind: "nmd-decay", path: "params.closureSteady", label: "Steady closure rate", unit: "% per month", from: 0.75, to: 0.9375, ops: [0] }],
};

describe("BehavioralShocksView copy", () => {
  it("prints each paragraph verbatim", () => {
    const t = text(renderToStaticMarkup(<BehavioralShocksView {...props()} />));
    for (const p of COPY) expect(t, p.slice(0, 40)).toContain(p);
  });
  it("holds neither an em-dash nor a section sign, in markup or in source", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({ preview: PREVIEW })} />);
    expect(html).not.toMatch(BANNED_CHARS);
    for (const f of ["../pages/scenarios/BehavioralShocksPage.tsx", "../scenarios/behavioralShockModel.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(BANNED_CHARS);
    }
  });
});

describe("BehavioralShocksView balance pointer", () => {
  it("no longer lists balance shocks as unbuilt, and points to the Balance shocks page", () => {
    const t = text(renderToStaticMarkup(<BehavioralShocksView {...props()} />));
    expect(t).not.toContain("Not built: balance shocks");
    expect(t).not.toContain("balance shocks");
    // Re-expectation: the sentence now names Volatility shocks as the third derived-input page.
    expect(t).toContain("Target balances are shocked on Balance shocks, the funding spread (TLP) on Funding spread shocks and the constructed short-rate volatilities on Volatility shocks");
  });
  it("no longer lists funding spread shocks as unbuilt (Piece 6c)", () => {
    const t = text(renderToStaticMarkup(<BehavioralShocksView {...props()} />));
    expect(t).not.toContain("Not built: funding spread");
    // Re-expectation: volatility shocks are built; no Not built sentence remains and the page points to Volatility shocks.
    expect(t).not.toContain("Not built: volatility shocks");
    expect(t).toContain("a volatility shock moves stochastic runs only");
  });
});

describe("BehavioralShocksView form", () => {
  it("lists the stored sets as base options, and the op row's choices and hint line", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props()} />);
    const t = text(html);
    expect(t).toContain("demo-behavioral-v1: Demo behavioral set");
    expect(t).toContain("dda, Deposit decay");
    expect(t).toContain("Steady closure rate (% per month)");
    expect(t).toContain("Scale by");
    expect(t).toContain("Stored value 0.75 % per month; bounds 0 to 100");
    expect(html).toContain('value="1.25"');
    expect(t).toContain("Leave empty for the derived id");
    expect(t).toContain("Add an op");
  });
  it("turns Preview and Save off by aria-disabled with the reason when blocked", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({ block: "Enter a number" })} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Preview<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Save<\/button>/);
    expect(text(html)).toContain("Enter a number");
    const open = renderToStaticMarkup(<BehavioralShocksView {...props()} />);
    expect(open).not.toContain('aria-disabled="true"');
  });
  it("says it is reading the base set, or why it could not", () => {
    expect(text(renderToStaticMarkup(<BehavioralShocksView {...props({ base: null, baseNote: "Reading set demo-behavioral-v1" })} />))).toContain("Reading set demo-behavioral-v1");
    const failed = renderToStaticMarkup(<BehavioralShocksView {...props({ base: null, baseNote: "404: assumption set not found" })} />);
    expect(text(failed)).toContain("404: assumption set not found");
  });
});

describe("BehavioralShocksView preview", () => {
  it("prints the served from and to values and no other number", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({ preview: PREVIEW })} />);
    expect(text(html)).toContain("Preview: derived-0123456789ab");
    const from = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const body = text(html.slice(from, html.indexOf("</table>", from)));
    expect(body).toContain("0.75");
    expect(body).toContain("0.9375");
    expect(body).toContain("Steady closure rate");
    expect(body).toContain("% per month");
    for (const h of ["Binding", "Parameter", "Unit", "Base value", "Derived value"]) expect(body).toContain(h);
    // Every digit in the table is in a served number.
    expect(body.replace("0.75", "").replace("0.9375", "")).not.toMatch(/\d/);
  });
  it("shows no preview card when there is none", () => {
    expect(text(renderToStaticMarkup(<BehavioralShocksView {...props()} />))).not.toContain("Preview: ");
  });
});

describe("BehavioralShocksView notes", () => {
  it("lists every problem of a refusal", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({
      note: {
        kind: "refused",
        text: "Refused: every problem is listed.",
        problems: ["bindings[0].overlay.params.maxCpr is wrong", "mma deposit-beta: Adjustment speed must be at most 1"],
        savedId: null,
      },
    })} />);
    const t = text(html);
    expect(t).toContain("Refused: every problem is listed.");
    expect(t).toContain("bindings[0].overlay.params.maxCpr is wrong");
    expect(t).toContain("mma deposit-beta: Adjustment speed must be at most 1");
    expect(html).toContain('role="alert"');
  });
  it("links a saved set to Scenario sets", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({
      note: { kind: "created", text: "Saved as derived-0123456789ab", problems: [], savedId: "derived-0123456789ab" },
      setsLink: "#/data/scenarios/sets?set=derived-0123456789ab",
    })} />);
    expect(text(html)).toContain("Saved as derived-0123456789ab");
    expect(html).toContain('href="#/data/scenarios/sets?set=derived-0123456789ab"');
    expect(text(html)).toContain("Bind it on Scenario sets");
  });
  it("a conflict prints the server text and no link", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({ note: { kind: "conflict", text: "409: already exists with different content", problems: [], savedId: null } })} />);
    expect(text(html)).toContain("409: already exists with different content");
    expect(text(html)).not.toContain("Bind it on Scenario sets");
  });
});

describe("BehavioralShocksView stored table", () => {
  it("lists the derived sets with their base", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props()} />);
    const t = text(html.slice(html.indexOf('aria-label="Stored behavioral shocks"')));
    expect(t).toContain("Stored behavioral shocks");
    for (const h of ["Set", "Label", "Base set"]) expect(t).toContain(h);
    expect(t).toContain("decay-shock-demo-v1");
    expect(t).toContain("Deposit decay +25% on the demo set (demonstration values, NOT calibrated)");
    expect(t).toContain("demo-behavioral-v1");
    // The plain set is not a stored shock.
    expect(t).not.toContain("Demo behavioral set");
  });
  it("marks a row whose stored document is gone with a muted document missing, and only that row (mfu-3 fix 1)", () => {
    const gone: AssumptionSetListItem = { id: "gone-shock-v1", label: "Gone", contentHash: "h3", derivedFromSetId: "demo-behavioral-v1", documentMissing: true };
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({ sets: [...SETS, gone] })} />);
    const rows = html.slice(html.indexOf('aria-label="Stored behavioral shocks"')).split("<tr>").slice(1);
    const row = (id: string) => rows.find((r) => r.includes(`>${id}`)) ?? "";
    expect(row("gone-shock-v1")).toContain('<th scope="row" class="mono">gone-shock-v1 <span class="muted">document missing</span></th>');
    expect(row("decay-shock-demo-v1")).toContain('<th scope="row" class="mono">decay-shock-demo-v1</th>');
    expect(html.split("document missing").length - 1).toBe(1);
  });
  it("says None stored when no set is derived", () => {
    const html = renderToStaticMarkup(<BehavioralShocksView {...props({ sets: [SETS[0]!] })} />);
    expect(text(html.slice(html.indexOf('aria-label="Stored behavioral shocks"')))).toContain("None stored");
  });
});
