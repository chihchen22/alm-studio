// apps/studio/src/__tests__/derivedCurvesPage.test.tsx
/**
 * Market > Derived curves: the view renders from props alone (renderToStaticMarkup, no DOM),
 * the screen's registration and the history sentence of a derived curve save. Sentences restated by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DerivedCurveListRow, HistoryChange } from "@alm/reader";
import { DerivedCurvesView, type DerivedCurvesViewProps } from "../pages/market/DerivedCurvesPage";
import { baseOptions, defaultState } from "../market/derivedCurveModel";
import { writeBlock } from "../controls/attachBodies";
import { SCREENS, screenDef, screensOf } from "../router";
import { pageFor } from "../pages/pageFor";
import { describeChange } from "../rows/workspaceRows";
import { changeText, historyRows } from "../govern/workspaceGovern";
import { HEAD } from "./fixtures/workspace";

const EM_DASH = String.fromCharCode(0x2014);
const SECTION_SIGN = String.fromCharCode(0xa7);
const noop = () => {};
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const SPREAD_SENTENCE = "The spread is added to index resets only. Mortgages, client rates, new business and discounting read the base curve.";

const LISTED: DerivedCurveListRow = {
  id: "dc-0123456789abcdef", curveId: "sofr-3m", label: "SOFR 3M term", base: "sofr-main",
  spreads: [{ tenorMonths: 3, spreadBp: 8 }, { tenorMonths: 12, spreadBp: 11 }],
};

function props(p: Partial<DerivedCurvesViewProps> = {}): DerivedCurvesViewProps {
  return {
    curves: [LISTED], missing: [], listError: null,
    options: baseOptions([{ id: "sofr-main", label: "SOFR OIS" }]),
    editor: defaultState(), blocked: null, by: "Chih", busy: null, note: null,
    fill: { from: "sofr-main", minus: "platform-default", lines: null },
    onBy: noop, onEdit: noop, onNew: noop, onField: noop, onCell: noop, onAddRow: noop, onRemoveRow: noop,
    onFillFrom: noop, onFillMinus: noop, onFill: noop, onSave: noop,
    ...p,
  };
}

const html = (p: Partial<DerivedCurvesViewProps> = {}) => renderToStaticMarkup(<DerivedCurvesView {...props(p)} />);

function selectOf(markup: string, label: string): string {
  const at = markup.indexOf(`aria-label="${label}"`);
  expect(at, `select ${label}`).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<select", at);
  return markup.slice(open, markup.indexOf("</select>", at));
}

function buttonOf(markup: string, label: string): string {
  const m = markup.match(new RegExp(`<button[^>]*>${label}</button>`));
  expect(m, `button ${label}`).not.toBeNull();
  return m![0];
}

describe("DerivedCurvesView", () => {
  it("renders the saved list, the form, the spread grid, the fill card and the spread sentence", () => {
    const m = html();
    const t = text(m);
    // The list: label, curve id, base by its option text, row count.
    expect(t).toContain("Saved derived curves");
    expect(t).toContain("SOFR 3M term");
    expect(t).toContain("sofr-3m");
    expect(t).toContain("Base: SOFR OIS, 2 rows");
    expect(buttonOf(m, "Edit")).toContain('aria-label="Edit SOFR 3M term"');
    // The form: id, label and the base select from baseOptions.
    expect(m).toContain('aria-label="Curve id"');
    expect(m).toContain('value="derived-1"');
    expect(m).toContain('value="New derived curve"');
    const base = selectOf(m, "Base curve");
    expect(base).toContain('<option value="platform-default" selected="">Platform default curve</option>');
    expect(base).toContain('<option value="sofr-main">SOFR OIS</option>');
    // The grid: one tenor and one spread input per row, in its own scrolling wrapper.
    expect(m).toContain('<div class="table-wrap cb-grid"><table class="table">');
    for (const [n, tenor] of [[1, "1"], [2, "3"], [3, "6"], [4, "12"]] as const) {
      expect(m).toMatch(new RegExp(`aria-label="Tenor, months, row ${n}" [^>]*value="${tenor}"`));
      expect(m).toMatch(new RegExp(`aria-label="Spread, bp, row ${n}" [^>]*value="0"`));
      expect(m).toContain(`aria-label="Remove row ${n}"`);
    }
    expect(t).toContain("Add a row");
    // The fill: two selects from the same options, and the button.
    expect(selectOf(m, "Fill from")).toContain('<option value="sofr-main" selected="">SOFR OIS</option>');
    expect(selectOf(m, "Minus")).toContain('<option value="platform-default" selected="">Platform default curve</option>');
    expect(buttonOf(m, "Fill")).not.toContain("disabled");
    expect(t).toContain(SPREAD_SENTENCE);
    // Open workspace, name typed, every cell reads: Save is on.
    expect(buttonOf(m, "Save")).not.toContain("disabled");
  });

  it("a locked workspace shows the refusal sentence and a disabled Save; the fill stays open", () => {
    const locked = { ...HEAD, status: "locked" as const };
    const why = writeBlock(locked, "its derived curves")!;
    expect(why).toBe("This workspace is locked by its sign-off. Clone it to change its derived curves.");
    const m = html({ blocked: why });
    expect(text(m)).toContain(why);
    // Said once, beside Save (fix round 1, item 3).
    expect(text(m).split(why).length - 1).toBe(1);
    expect(m.slice(m.indexOf('aria-label="Save"'))).toContain(why);
    expect(buttonOf(m, "Save")).toContain('disabled=""');
    expect(buttonOf(m, "Fill")).not.toContain("disabled");
  });

  it("an empty list says so and shows the By hint", () => {
    const hint = "Type your name below to save a derived curve.";
    const t = text(html({ curves: [], by: "" }));
    expect(t).toContain("This workspace holds no derived curve.");
    expect(t).toContain(hint);
    expect(text(html({ curves: [], by: "Chih" }))).not.toContain(hint);
    expect(text(html({ curves: [], by: "", blocked: "This workspace is archived and read-only." }))).not.toContain(hint);
  });

  it("prints server refusals one per line, and a missing slot by its document", () => {
    const refusals = ["the derived curve's spreads row 2: tenorMonths must be strictly ascending", "the derived curve's label must be 1 to 80 characters"];
    const m = html({ note: { ok: false, lines: refusals }, missing: [{ id: "dc-gone", problem: 'the derived curve document "dc-gone" is not in the store' }] });
    for (const r of refusals) expect(m).toContain(`<li>${r.replace(/'/g, "&#x27;")}</li>`);
    expect(text(m)).toContain('dc-gone: the derived curve document "dc-gone" is not in the store');
    const fill = html({ fill: { from: "sofr-main", minus: "platform-default", lines: refusals } });
    for (const r of refusals) expect(fill).toContain(`<li>${r.replace(/'/g, "&#x27;")}</li>`);
  });

  it("holds Save and Fill off, with a reason, while a cell cannot be read", () => {
    const ed = defaultState();
    const bad = { ...ed, rows: ed.rows.map((r, i) => (i === 1 ? { ...r, tenorText: "3.5" } : r)) };
    const m = html({ editor: bad });
    expect(text(m)).toContain("Row 2, tenor: type a whole number of months.");
    expect(buttonOf(m, "Save")).toContain('aria-disabled="true"');
    expect(buttonOf(m, "Fill")).toContain('disabled=""');
    expect(text(m)).toContain("Every tenor must be a whole number of months before a fill.");
    expect(buttonOf(html({ by: "" }), "Save")).toContain('aria-disabled="true"');
  });

  it("holds Fill off with a reason when both menus hold the same curve (M1)", () => {
    const sentence = "Pick two different curves: a curve minus itself is zero at every tenor.";
    const same = html({ fill: { from: "sofr-main", minus: "sofr-main", lines: null } });
    const btn = buttonOf(same, "Fill");
    expect(btn).toContain('aria-disabled="true"');
    expect(btn).not.toContain('disabled=""');
    const describedBy = btn.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeDefined();
    expect(same).toContain(`<span class="muted" id="${describedBy}">${sentence}</span>`);
    // Two different curves: Fill is on and no reason is printed.
    const ok = html();
    expect(buttonOf(ok, "Fill")).not.toContain("aria-disabled");
    expect(text(ok)).not.toContain(sentence);
  });

  it("says when the curve setups could not be read, since the menus then hold the platform default only", () => {
    const t = text(html({ options: baseOptions([]), setupsError: "502 upstream: the store did not answer" }));
    expect(t).toContain("The curve setups could not be read, so the menus list the platform default curve only: 502 upstream: the store did not answer");
    expect(text(html())).not.toContain("could not be read");
  });

  it("keeps a stored base the options do not hold, verbatim", () => {
    const m = html({ editor: { ...defaultState(), base: "ust-gone" } });
    expect(selectOf(m, "Base curve")).toContain('<option value="ust-gone" selected="">ust-gone</option>');
  });
});

describe("Market > Derived curves: registration, history and source", () => {
  it("sits right after Curve setups and mounts DerivedCurvesPage", () => {
    expect(screenDef("market", "derived-curves").label).toBe("Derived curves");
    expect(screensOf("market").map((s) => s.screen).slice(0, 3)).toEqual(["curves", "curve-builder", "derived-curves"]);
    expect(SCREENS.filter((s) => s.screen === "derived-curves")).toHaveLength(1);
    const el = pageFor({ kind: "screen", ws: HEAD.id, section: "market", screen: "derived-curves", query: {} }, HEAD) as ReactElement;
    expect((el.type as { name: string }).name).toBe("DerivedCurvesPage");
  });

  it("a derived curve save reads 'Derived curve <id> saved by <by>.' on Home and Govern, add and edit alike", () => {
    const ref = { collection: "derived-curves" as const, id: "dc-0123456789abcdef" };
    const add: HistoryChange = { kind: "set-block", block: "market", op: "add", ref, derivedCurve: "edit" };
    const edit: HistoryChange = { kind: "set-block", block: "market", op: "set", ref, derivedCurve: "edit" };
    for (const c of [add, edit]) {
      expect(describeChange(c, new Map(), "Chih")).toBe("Derived curve dc-0123456789abcdef saved by Chih.");
      expect(changeText(c, new Map(), "Chih")).toBe("Derived curve dc-0123456789abcdef saved by Chih.");
    }
    const line = { revision: 3, at: "t", by: "Chih", change: edit, manifest: HEAD };
    expect(historyRows([line])[0]!.text).toBe("Derived curve dc-0123456789abcdef saved by Chih.");
    // A remove (none is written today) never reads as a save: it falls to the generic line (fix round 1, item 2).
    const remove: HistoryChange = { kind: "set-block", block: "market", op: "remove", ref };
    expect(describeChange(remove, new Map(), "Chih")).toBe("Removed derived-curves dc-0123456789abcdef from market");
    expect(changeText(remove, new Map(), "Chih")).not.toContain("saved");
  });

  it("the page carries no em-dash or section sign", () => {
    for (const rel of ["../pages/market/DerivedCurvesPage.tsx", "../market/derivedCurveModel.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src.includes(EM_DASH)).toBe(false);
      expect(src.includes(SECTION_SIGN)).toBe(false);
    }
  });
});
