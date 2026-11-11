// apps/studio/src/__tests__/curveBuilderPage.test.tsx
/**
 * Market > Curve setups: the view renders from props alone (renderToStaticMarkup, no DOM),
 * the pure helpers behind it, the screen's registration and the history sentences of the four curve setup events.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CurveSetupListRow, CurveSetupPreview, HistoryChange, HistoryLine } from "@alm/reader";
import {
  APPROX_SENTENCE, CurveBuilderView, NO_COMPOUNDING_SENTENCE, addRow, appendRows, compoundingChoices, conventionOf, editorFromBlock,
  emptyEditor, fillFromSnapshot, fillOutcome, loadOutcome, markOf, pastedRows, previewBlock, problemText, removeRow, saveLines, setFields, setRow, setupNameProblem, shownFor,
  type CurveBuilderViewProps, type EditorState,
} from "../pages/market/CurveBuilderPage";
import { blockFromState, CONVENTION_NOTE, FUTURES_NOTE, unmappedPairNote, type GridRow } from "../market/curveSetupModel";
import { writeBlock } from "../controls/attachBodies";
import { SCREENS, screenDef, screensOf } from "../router";
import { pageFor } from "../pages/pageFor";
import { describeChange } from "../rows/workspaceRows";
import { changeText, historyRows } from "../govern/workspaceGovern";
import { clearCurveSetupLabelCache, curveSetupLabelsFor, rememberCurveSetupLabels } from "../rows/curveSetupLabels";
import { HEAD } from "./fixtures/workspace";

const EM_DASH = String.fromCharCode(0x2014);
const SECTION_SIGN = String.fromCharCode(0xa7);
const noop = () => {};
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const row = (p: Partial<GridRow> = {}): GridRow => ({ instrument: "ois-swap", tenorText: "1Y", quoteType: "par-rate", valueText: "0.04", convexityText: "", ...p });

function editor(rows: GridRow[], patch: Partial<EditorState> = {}): EditorState {
  return { ...appendRows({ ...emptyEditor(), id: "sofr-main", label: "SOFR main" }, rows), ...patch };
}

const LISTED: CurveSetupListRow = {
  id: "cs-0123456789abcdef", setupId: "sofr-main", label: "SOFR main", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual",
  rows: [{ instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.04 }], active: false,
};

function props(p: Partial<CurveBuilderViewProps> = {}): CurveBuilderViewProps {
  return {
    setups: [LISTED], missing: [], listError: null,
    editor: editor([row(), row({ tenorText: "2Y", valueText: "0.041" })]),
    activeId: null, blocked: null, hasSnapshot: true, by: "Chih", busy: null, note: null,
    paste: { text: "", unit: "auto", result: null }, fill: null, preview: null, previewError: null,
    onBy: noop, onEdit: noop, onActivate: noop, onDeactivate: noop, onNew: noop, onField: noop, onRow: noop, onAddRow: noop, onRemoveRow: noop,
    onPasteText: noop, onPasteUnit: noop, onPasteAdd: noop, onFill: noop, onPreview: noop, onSave: noop,
    ...p,
  };
}

const html = (p: Partial<CurveBuilderViewProps> = {}) => renderToStaticMarkup(<CurveBuilderView {...props(p)} />);

/** The markup of one select, by its aria-label. */
function selectOf(markup: string, label: string): string {
  const at = markup.indexOf(`aria-label="${label}"`);
  expect(at, `select ${label}`).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<select", at);
  return markup.slice(open, markup.indexOf("</select>", at));
}

/** The markup of one button, by its text. */
function buttonOf(markup: string, label: string): string {
  const m = markup.match(new RegExp(`<button[^>]*>${label}</button>`));
  expect(m, `button ${label}`).not.toBeNull();
  return m![0];
}

describe("CurveBuilderView: menus and grid", () => {
  it("renders the interpolation, day count and compounding menus and a typed grid row per row", () => {
    const m = html();
    expect(selectOf(m, "Interpolation")).toContain("Log-linear on discount factor");
    expect(selectOf(m, "Interpolation")).toContain("Linear in zero rate (legacy)");
    expect(selectOf(m, "Interpolation")).toContain("Monotone convex");
    expect(selectOf(m, "Day count")).toContain("Actual/360");
    expect(selectOf(m, "Day count")).toContain("Actual/365");
    expect(selectOf(m, "Compounding")).toContain("Semi-annual");
    // Two grid rows: an instrument select, a tenor, a quote type select and a value per row.
    for (const n of [1, 2]) {
      expect(selectOf(m, `Instrument, row ${n}`)).toContain("OIS swap");
      expect(selectOf(m, `Quote type, row ${n}`)).toContain("Zero rate");
      expect(m).toContain(`aria-label="Tenor, row ${n}"`);
      expect(m).toContain(`aria-label="Value, row ${n}"`);
    }
    expect(m).toContain('value="2Y"');
    expect(m).toContain('value="0.041"');
    expect(text(m)).toContain(CONVENTION_NOTE);
    // The grid scrolls inside its own container.
    expect(m).toMatch(/<div class="table-wrap cb-grid">\s*<table/);
  });

  it("shows the convexity input and the futures note only when a futures row exists", () => {
    const plain = html();
    expect(plain).not.toContain("Convexity, row 1");
    expect(text(plain)).not.toContain(FUTURES_NOTE);
    const fut = html({ editor: editor([row({ instrument: "futures", tenorText: "3M", valueText: "95.8" })]) });
    expect(fut).toContain('aria-label="Convexity, row 1"');
    expect(text(fut)).toContain(FUTURES_NOTE);
  });

  it("offers no continuous compounding when every row is a par rate, and offers it when the rows are zero rates", () => {
    const par = selectOf(html({ editor: editor([row(), row({ tenorText: "5Y" })]) }), "Compounding");
    expect(par).toContain(">Annual<");
    expect(par).toContain(">Semi-annual<");
    expect(par).not.toContain("Continuous");
    const zero = selectOf(html({ editor: editor([row({ quoteType: "zero-rate" }), row({ quoteType: "zero-rate", tenorText: "5Y" })]) }), "Compounding");
    expect(zero).toContain(">Continuous<");
  });

  it("says compounding does not apply when no row reads it", () => {
    const m = html({ editor: editor([row({ quoteType: "discount-factor", valueText: "0.96" })]) });
    expect(m).not.toContain('aria-label="Compounding"');
    expect(text(m)).toContain(NO_COMPOUNDING_SENTENCE);
    expect(NO_COMPOUNDING_SENTENCE).toBe("Compounding does not apply to the rows entered.");
  });

  it("prints a cell that cannot be read as Row N, field: why, and keeps Preview off", () => {
    const m = html({ editor: editor([row({ tenorText: "0.3y" })]) });
    expect(text(m)).toContain("Row 1, tenor: 0.3y is not a whole number of months");
    expect(buttonOf(m, "Preview")).toContain('aria-disabled="true"');
    expect(problemText({ row: 2, field: "value", why: "enter a value" })).toBe("Row 2, value: enter a value");
  });

  it("names a setup id outside the lineage pattern in a plain sentence and keeps Save off", () => {
    const m = html({ editor: editor([row()], { id: "has space" }) });
    expect(text(m)).toContain(setupNameProblem("has space")!);
    expect(buttonOf(m, "Save")).toContain('aria-disabled="true"');
  });
});

describe("CurveBuilderView: a locked workspace", () => {
  it("prints the refusal sentence and disables Save, Make active and the platform default", () => {
    const locked = { ...HEAD, status: "locked" as const };
    const why = writeBlock(locked, "its curve setups")!;
    expect(why).toBe("This workspace is locked by its sign-off. Clone it to change its curve setups.");
    const m = html({ blocked: why, activeId: LISTED.id, setups: [{ ...LISTED, active: true }, { ...LISTED, id: "cs-fedcba9876543210", label: "Other" }] });
    expect(text(m)).toContain(why);
    expect(buttonOf(m, "Save")).toContain('disabled=""');
    expect(buttonOf(m, "Make active")).toContain('disabled=""');
    expect(buttonOf(m, "Use the platform default curve")).toContain('disabled=""');
  });

  it("an open workspace leaves Save on", () => {
    expect(buttonOf(html(), "Save")).not.toContain("disabled");
  });
});

describe("CurveBuilderView: the setup list", () => {
  it("shows the Active badge and the platform default button only when a setup is active", () => {
    const none = html();
    expect(text(none)).not.toMatch(/\bActive\b/);
    expect(none).not.toContain("Use the platform default curve");
    const on = html({ activeId: LISTED.id, setups: [{ ...LISTED, active: true }] });
    expect(on).toContain('<span class="chip cb-active">Active</span>');
    expect(on).toContain("Use the platform default curve");
    // The active setup offers no Make active of its own.
    expect(on).not.toContain(">Make active<");
  });

  it("lists label, menus in words and the row count", () => {
    const t = text(html());
    expect(t).toContain("SOFR main");
    expect(t).toContain("cs-0123456789abcdef");
    expect(t).toContain("Log-linear on discount factor, Actual/360, Annual, 1 row");
  });

  it("renders interpolation, day count and compounding the server sent verbatim when this build does not list them", () => {
    const odd = { ...LISTED, interpolation: "hermite-zero", dayCount: "30/360", compounding: "quarterly" } as unknown as CurveSetupListRow;
    expect(text(html({ setups: [odd] }))).toContain("hermite-zero, 30/360, quarterly, 1 row");
    // An editor loaded with an unknown value keeps it in its menu, verbatim.
    const ed = editor([row()], { interpolation: "hermite-zero" as never });
    expect(selectOf(html({ editor: ed }), "Interpolation")).toContain(">hermite-zero<");
  });

  it("names a missing setup document and an empty list in words", () => {
    const t = text(html({ setups: [], missing: [{ id: "sofr-old", problem: "document cs-1 is gone" }] }));
    expect(t).toContain("This workspace holds no curve setup");
    expect(t).toContain("sofr-old: document cs-1 is gone");
  });
});

describe("CurveBuilderView: preview", () => {
  const OK: CurveSetupPreview = {
    ok: true, denseCount: 24, warnings: ["forward rate is negative between 18 and 24 months"],
    quoteNodes: [{ tenorMonths: 12, zeroRate: 0.0401234567, discountFactor: 0.960512345 }, { tenorMonths: 24, zeroRate: 0.041, discountFactor: 0.92 }],
  };

  it("shows the approximation sentence only when the method is not linear in zero", () => {
    expect(APPROX_SENTENCE).toBe("Between month points the curve is a straight line in zero rate; values at month points follow the method you chose.");
    expect(text(html())).toContain(APPROX_SENTENCE);
    expect(text(html({ editor: editor([row()], { interpolation: "monotone-convex" }) }))).toContain(APPROX_SENTENCE);
    expect(text(html({ editor: editor([row()], { interpolation: "linear-zero" }) }))).not.toContain(APPROX_SENTENCE);
  });

  it("tabulates quote nodes in percent to 4 decimals and discount factors to 6, with the warnings", () => {
    const t = text(html({ preview: OK }));
    expect(t).toContain("1Y 4.0123 0.960512");
    expect(t).toContain("2Y 4.1000 0.920000");
    expect(t).toContain("forward rate is negative between 18 and 24 months");
    expect(t).toContain("flat beyond the last quote at 2Y");
  });

  it("prints the server's refusals verbatim, one per line", () => {
    const m = html({ preview: { ok: false, refusals: ["row 1 tenorMonths 0 is below 1", "row 2 value NaN is not finite"] } });
    expect(m).toContain("<li>row 1 tenorMonths 0 is below 1</li><li>row 2 value NaN is not finite</li>");
  });
});

describe("CurveBuilderView: paste and fill", () => {
  it("lists every skipped line verbatim, says the unit in words and says futures are typed in the grid", () => {
    const m = html({ paste: { text: "Tenor\tRate\n1Y\t4.1", unit: "auto", result: { added: 1, skipped: ["line 1: header row skipped"], unitUsed: "percent" } } });
    const t = text(m);
    expect(t).toContain("Read as percent");
    expect(t).toContain("line 1: header row skipped");
    expect(t).toContain("Futures rows are typed in the grid");
    expect(selectOf(m, "Paste unit")).toContain(">Auto<");
    expect(selectOf(m, "Paste unit")).toContain(">Percent<");
    expect(selectOf(m, "Paste unit")).toContain(">Decimal<");
  });

  it("the fill button is off with a reason when the workspace has no base snapshot; the fill note and dropped quotes print", () => {
    const off = html({ hasSnapshot: false });
    expect(buttonOf(off, "Fill from attached snapshot")).toContain("disabled");
    expect(text(off)).toContain("Attach a base snapshot on Yield curves first.");
    const t = text(html({ fill: { lines: ["Day count and compounding follow the snapshot: Actual/360, Annual.", "Replaced 2 rows."], dropped: ["1D", "ON"] } }));
    expect(t).toContain("Replaced 2 rows.");
    expect(t).toContain("Day count and compounding follow the snapshot: Actual/360, Annual.");
    expect(t).toContain("Not filled (shorter than one month): 1D, ON");
  });
});

describe("pure helpers", () => {
  it("compoundingChoices intersects the rows that read compounding and ignores those that do not", () => {
    const v = (rows: GridRow[]) => compoundingChoices(rows).map((o) => o.value);
    expect(v([])).toEqual(["annual", "semi-annual", "continuous"]);
    expect(v([row()])).toEqual(["annual", "semi-annual"]);
    expect(v([row({ quoteType: "zero-rate" })])).toEqual(["annual", "semi-annual", "continuous"]);
    expect(v([row({ quoteType: "zero-rate" }), row()])).toEqual(["annual", "semi-annual"]);
    expect(v([row({ quoteType: "discount-factor" }), row({ quoteType: "zero-rate" })])).toEqual(["annual", "semi-annual", "continuous"]);
    expect(v([row({ quoteType: "discount-factor" }), row({ instrument: "futures" })])).toEqual([]);
  });

  it("setupNameProblem follows the lineage pattern", () => {
    expect(setupNameProblem("sofr-main_v1.2")).toBeNull();
    expect(setupNameProblem("a".repeat(70))).toBeNull();
    expect(setupNameProblem("")).toBe("Name the setup: 1 to 70 letters, digits, dots, underscores or hyphens.");
    expect(setupNameProblem("a".repeat(71))).toBe(setupNameProblem(""));
    expect(setupNameProblem("sofr main")).toBe(setupNameProblem(""));
  });

  it("refuses the reserved id platform-default with the server's sentence (B2 final I1)", () => {
    const sentence = `The curve setup id "platform-default" is reserved for the platform's own curve; pick another id.`;
    expect(setupNameProblem("platform-default")).toBe(sentence);
    // Only the exact id is reserved.
    expect(setupNameProblem("platform-default-2")).toBeNull();
    const m = html({ editor: editor([row()], { id: "platform-default" }) });
    expect(text(m).replace(/&quot;/g, '"')).toContain(sentence);
    expect(buttonOf(m, "Save")).toContain('aria-disabled="true"');
  });

  it("rows keep stable keys through add, append, edit and remove", () => {
    let ed = emptyEditor();
    ed = addRow(ed);
    ed = appendRows(ed, [row({ tenorText: "2Y" }), row({ tenorText: "3Y" })]);
    expect(ed.rows.map((r) => r.key)).toEqual([0, 1, 2]);
    ed = removeRow(ed, 1);
    ed = addRow(ed);
    expect(ed.rows.map((r) => r.key)).toEqual([0, 2, 3]);
    ed = setRow(ed, 2, { tenorText: "4Y" });
    expect(ed.rows.find((r) => r.key === 2)!.tenorText).toBe("4Y");
  });

  it("setRow clears convexity and holds par-rate when a row leaves or joins futures", () => {
    let ed = appendRows(emptyEditor(), [row({ instrument: "futures", quoteType: "par-rate", convexityText: "1.5" })]);
    ed = setRow(ed, 0, { instrument: "cash" });
    expect(ed.rows[0]!.convexityText).toBe("");
    ed = setRow(ed, 0, { quoteType: "zero-rate" });
    ed = setRow(ed, 0, { instrument: "futures" });
    expect(ed.rows[0]!.quoteType).toBe("par-rate");
  });

  it("pastedRows builds OIS par-rate rows, the skipped sentences and the unit used", () => {
    const r = pastedRows("Tenor\tRate\n3M\t4.30\n1Y\t4.1\n6M\tabc", "auto");
    expect(r.rows).toEqual([
      { instrument: "ois-swap", tenorText: "3M", quoteType: "par-rate", valueText: "0.043", convexityText: "" },
      { instrument: "ois-swap", tenorText: "1Y", quoteType: "par-rate", valueText: "0.041", convexityText: "" },
    ]);
    expect(r.skipped).toEqual(["line 1: header row skipped", "line 4: abc is not a number"]);
    expect(r.unitUsed).toBe("percent");
    expect(pastedRows("1Y\t0.041", "auto").unitUsed).toBe("decimal");
  });

  it("conventionOf maps the two snapshot conventions and refuses to guess any other", () => {
    expect(conventionOf("annual_act360")).toEqual({ dayCount: "ACT/360", compounding: "annual" });
    expect(conventionOf("semiannual_bond")).toEqual({ dayCount: "ACT/365", compounding: "semi-annual" });
    expect(conventionOf("quarterly_30360")).toBeNull();
  });

  it("fillFromSnapshot replaces rows, drops sub-month quotes and names the convention", () => {
    const f = fillFromSnapshot({
      curveConvention: "semiannual_bond",
      curveQuotes: [
        { term: "1D", tYears: 1 / 360, instrumentType: "CASH", rate: 0.043 },
        { term: "1M", tYears: 0.083333, instrumentType: "CASH", rate: 0.0431 },
        { term: "2Y", tYears: 2, instrumentType: "OIS", rate: 0.039 },
      ],
    });
    expect(f.rows.map((r) => [r.instrument, r.tenorText, r.valueText])).toEqual([["cash", "1M", "0.0431"], ["ois-swap", "2Y", "0.039"]]);
    expect(f.dropped).toEqual(["1D"]);
    expect(f.convention).toEqual({ dayCount: "ACT/365", compounding: "semi-annual" });
    expect(f.note).toBe("Day count and compounding follow the snapshot: Actual/365, Semi-annual.");
    const odd = fillFromSnapshot({ curveConvention: "weird", curveQuotes: [{ term: "2Y", tYears: 2, instrumentType: "OIS", rate: 0.039 }] });
    expect(odd.rows).toHaveLength(1);
    expect(odd.convention).toBeNull();
    expect(odd.note).toBe("The snapshot's curve convention weird is not one this screen maps; day count and compounding are unchanged.");
    expect(fillFromSnapshot({}).note).toBe("The attached snapshot carries no curve quotes.");
  });

  it("editorFromBlock loads a stored block with keyed rows", () => {
    const ed = editorFromBlock({
      id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "cubic-zero", dayCount: "ACT/365", compounding: "semi-annual",
      inputs: [{ instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 95.8, convexityBp: 1.5 }, { instrument: "ois-swap", tenorMonths: 24, quoteType: "zero-rate", value: 0.04 }],
    });
    expect(ed.id).toBe("sofr-main");
    expect(ed.interpolation).toBe("cubic-zero");
    expect(ed.rows.map((r) => [r.key, r.instrument, r.tenorText, r.valueText, r.convexityText])).toEqual([
      [0, "futures", "3M", "95.8", "1.5"],
      [1, "ois-swap", "2Y", "0.04", ""],
    ]);
    expect(ed.nextKey).toBe(2);
  });
});

describe("history lines of the curve setup events", () => {
  const ref = { collection: "curve-setups" as const, id: "cs-0123456789abcdef" };
  const add: HistoryChange = { kind: "set-block", block: "market", op: "add", ref };
  const edit: HistoryChange = { kind: "set-block", block: "market", op: "set", ref, curveSetup: "edit" };
  const activate: HistoryChange = { kind: "set-block", block: "market", op: "set", ref };
  const deactivate: HistoryChange = { kind: "set-block", block: "market", op: "remove", ref, curveSetup: "deactivate" };

  it("Workspace rows describe each event in words", () => {
    expect(describeChange(add)).toBe("Added curve setup cs-0123456789abcdef");
    expect(describeChange(edit)).toBe("Saved curve setup cs-0123456789abcdef");
    expect(describeChange(activate)).toBe("Made curve setup cs-0123456789abcdef active");
    expect(describeChange(deactivate)).toBe("Returned to the platform default curve");
  });

  it("Govern history says the same", () => {
    expect(changeText(add)).toBe("Added curve setup cs-0123456789abcdef");
    expect(changeText(edit)).toBe("Saved curve setup cs-0123456789abcdef");
    expect(changeText(activate)).toBe("Made curve setup cs-0123456789abcdef active");
    expect(changeText(deactivate)).toBe("Returned to the platform default curve");
  });

  it("other collections keep their sentences", () => {
    const market: HistoryChange = { kind: "set-block", block: "market", op: "set", ref: { collection: "market", id: "m-1" } };
    expect(describeChange(market)).toBe("Set market m-1 in market");
    expect(changeText(market)).toBe("Market: set market m-1");
  });
});

describe("the screen is registered", () => {
  it("Market > Curve setups sits after Yield curves and mounts CurveBuilderPage", () => {
    expect(SCREENS.some((s) => s.section === "market" && s.screen === "curve-builder")).toBe(true);
    expect(screenDef("market", "curve-builder").label).toBe("Curve setups");
    expect(screensOf("market").map((s) => s.screen).slice(0, 2)).toEqual(["curves", "curve-builder"]);
    const el = pageFor({ kind: "screen", ws: HEAD.id, section: "market", screen: "curve-builder", query: {} }, HEAD) as ReactElement;
    expect((el.type as { name: string }).name).toBe("CurveBuilderPage");
  });

  it("the page and its stylesheet carry no em-dash or section sign, and the page imports its stylesheet once", () => {
    const page = readFileSync(fileURLToPath(new URL("../pages/market/CurveBuilderPage.tsx", import.meta.url)), "utf8");
    const css = readFileSync(fileURLToPath(new URL("../styles/curve-builder.css", import.meta.url)), "utf8");
    for (const src of [page, css]) {
      expect(src.includes(EM_DASH)).toBe(false);
      expect(src.includes(SECTION_SIGN)).toBe(false);
    }
    expect(page.split('import "../../styles/curve-builder.css";').length - 1).toBe(1);
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});

describe("Task 11b fixes", () => {
  it("A: the platform default button follows the head's active pointer, and names an active document the store lacks", () => {
    const gone = text(html({ setups: [], activeId: "cs-gone", missing: [{ id: "cs-gone", problem: 'the curve setup document "cs-gone" is not in the store' }] }));
    expect(gone).toContain("Use the platform default curve");
    expect(gone).toContain("The active curve setup cs-gone is not in the store.");
    const listed = text(html({ activeId: LISTED.id, setups: [{ ...LISTED, active: true }] }));
    expect(listed).toContain("Use the platform default curve");
    expect(listed).not.toContain("is not in the store");
    // No pointer, no button, whatever the list says.
    expect(html({ activeId: null, setups: [{ ...LISTED, active: true }] })).not.toContain("Use the platform default curve");
  });

  it("B: a list row the server sent without rows renders as 0 rows", () => {
    const bare = { ...LISTED } as Partial<CurveSetupListRow>;
    delete bare.rows;
    expect(text(html({ setups: [bare as CurveSetupListRow] }))).toContain("Log-linear on discount factor, Actual/360, Annual, 0 rows");
  });

  it("C: every grid change moves the version; a fill that lands after a change replaces nothing and says so", () => {
    let ed = emptyEditor();
    const v0 = ed.version;
    ed = addRow(ed);
    expect(ed.version).toBeGreaterThan(v0);
    const v1 = ed.version;
    ed = setRow(ed, ed.rows[0]!.key, { tenorText: "1Y" });
    expect(ed.version).toBeGreaterThan(v1);
    const v2 = ed.version;
    ed = removeRow(appendRows(ed, [row()]), 0);
    expect(ed.version).toBeGreaterThan(v2);

    const f = fillFromSnapshot({ curveConvention: "annual_act360", curveQuotes: [{ term: "2Y", tYears: 2, instrumentType: "OIS", rate: 0.039 }] });
    const typed = appendRows(emptyEditor(), [row(), row({ tenorText: "5Y" })]);
    const started = typed.version;
    const changed = setRow(typed, 0, { valueText: "0.05" });
    const late = fillOutcome(changed, started, f);
    expect(late.editor).toBe(changed);
    expect(late.lines).toEqual(["The quotes or settings changed while the snapshot was loading; nothing was replaced."]);

    const onTime = fillOutcome(typed, started, f);
    expect(onTime.editor.rows.map((r) => r.tenorText)).toEqual(["2Y"]);
    expect(onTime.editor.dayCount).toBe("ACT/360");
    expect(onTime.lines).toEqual(["Day count and compounding follow the snapshot: Actual/360, Annual.", "Replaced 2 rows."]);
    // An empty grid is filled without a Replaced line; one replaced row is said in the singular.
    expect(fillOutcome(emptyEditor(), emptyEditor().version, f).lines).toEqual([f.note]);
    expect(fillOutcome(appendRows(emptyEditor(), [row()]), 1, f).lines[1]).toBe("Replaced 1 row.");
  });

  it("C: loading a stored setup over typed rows says how many it replaced", () => {
    const block = { id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "log-linear-df" as const, dayCount: "ACT/360" as const, compounding: "annual" as const,
      inputs: [{ instrument: "ois-swap" as const, tenorMonths: 12, quoteType: "par-rate" as const, value: 0.04 }] };
    const typed = appendRows(emptyEditor(), [row(), row({ tenorText: "5Y" }), row({ tenorText: "7Y" })]);
    const out = loadOutcome(typed, block);
    expect(out.editor.id).toBe("sofr-main");
    expect(out.editor.version).toBeGreaterThan(typed.version);
    expect(out.lines).toEqual(["Editing sofr-main. Save under the same name to replace it.", "Replaced 3 rows."]);
    expect(loadOutcome(emptyEditor(), block).lines).toEqual(["Editing sofr-main. Save under the same name to replace it."]);
  });

  it("D: a preview and a preview error are shown only for the block they were made for", () => {
    expect(shownFor({ key: "a", value: "x" }, "a")).toBe("x");
    expect(shownFor({ key: "a", value: "x" }, "b")).toBeNull();
    expect(shownFor({ key: "a", value: "x" }, null)).toBeNull();
    expect(shownFor(null, "a")).toBeNull();
  });

  it("E: the preview table carries its own class and a short header for the phone band", () => {
    const m = html({ preview: { ok: true, denseCount: 12, warnings: [], quoteNodes: [{ tenorMonths: 12, zeroRate: 0.04, discountFactor: 0.96 }] } });
    expect(m).toContain('<div class="table-wrap cb-preview-wrap"><table class="table cb-preview">');
    expect(text(m)).toContain("Zero rate %");
    const css = readFileSync(fileURLToPath(new URL("../styles/curve-builder.css", import.meta.url)), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(phone).toContain(".cb-preview-wrap.table-wrap .table.cb-preview { width: 100%; }");
    expect(phone).toMatch(/\.cb-preview-wrap\.table-wrap \.table\.cb-preview th \{[^}]*white-space: normal;/);
  });

  it("F: a compounding choice the rows do not offer keeps a short option and the full sentence beside it", () => {
    const m = html({ editor: editor([row(), row({ tenorText: "5Y" })], { compounding: "continuous" }) });
    const sel = selectOf(m, "Compounding");
    expect(sel).toContain(">Continuous (not offered)<");
    expect(sel).toContain('title="Continuous is not offered for the rows entered."');
    expect(text(m)).toContain("Continuous is not offered for the rows entered.");
  });

  it("G: the preview block names a blank setup with a placeholder; the saved block does not", () => {
    const blank = blockFromState({ ...editor([row()]), id: "", label: "" }).block!;
    expect(previewBlock(blank)).toMatchObject({ id: "preview", label: "preview" });
    expect(blank.id).toBe("");
    const named = blockFromState({ ...editor([row()]), id: "sofr-main", label: "" }).block!;
    expect(previewBlock(named)).toMatchObject({ id: "sofr-main", label: "sofr-main" });
    expect(previewBlock(named).inputs).toEqual(named.inputs);
    // A blank name keeps Preview on and Save off with the plain sentence.
    const m = html({ editor: editor([row()], { id: "", label: "" }) });
    expect(buttonOf(m, "Preview")).not.toContain("aria-disabled");
    expect(buttonOf(m, "Save")).toContain('aria-disabled="true"');
    expect(text(m)).toContain(setupNameProblem("")!);
  });
});

describe("Task 11c fixes", () => {
  it("an active pointer to a missing document says runs are refused, not that the platform default is used, and names the id once", () => {
    const m = html({ setups: [], activeId: "cs-gone", missing: [{ id: "cs-gone", problem: 'the curve setup document "cs-gone" is not in the store' }] });
    const t = text(m);
    expect(t).not.toContain("This workspace holds no curve setup. Runs use the platform default curve.");
    expect(t).toContain("The active curve setup is missing from the store. Runs are refused until you use the platform default curve.");
    expect(t).toContain("Use the platform default curve");
    expect(t.split("The active curve setup cs-gone is not in the store.").length - 1).toBe(1);
    expect(t).not.toContain("cs-gone: the curve setup document");
    // Another missing slot still prints its own line.
    const two = text(html({ setups: [], activeId: "cs-gone", missing: [{ id: "cs-gone", problem: "gone" }, { id: "cs-other", problem: "also gone" }] }));
    expect(two).toContain("cs-other: also gone");
    // No pointer: the empty list keeps its sentence.
    expect(text(html({ setups: [] }))).toContain("This workspace holds no curve setup. Runs use the platform default curve.");
  });

  it("the unmapped-pair note shows under the menus for a pair the platform does not read natively, and not for the two it does", () => {
    const zero = [row({ quoteType: "zero-rate" })];
    const NOTE_STEM = "has no platform convention of its own";
    expect(text(html({ editor: editor(zero, { dayCount: "ACT/360", compounding: "annual" }) }))).not.toContain(NOTE_STEM);
    expect(text(html({ editor: editor(zero, { dayCount: "ACT/365", compounding: "semi-annual" }) }))).not.toContain(NOTE_STEM);
    for (const [dayCount, compounding] of [["ACT/360", "semi-annual"], ["ACT/365", "annual"], ["ACT/360", "continuous"], ["ACT/365", "continuous"]] as const) {
      const note = unmappedPairNote(dayCount, compounding);
      expect(note, `${dayCount} ${compounding}`).toBeDefined();
      const m = html({ editor: editor(zero, { dayCount, compounding }) });
      expect(text(m), `${dayCount} ${compounding}`).toContain(note!);
      // Under the convention menus: after the Compounding control, inside the Settings card.
      const settings = m.slice(m.indexOf('aria-label="Settings"'), m.indexOf('aria-label="Quotes"'));
      expect(settings.indexOf(note!)).toBeGreaterThan(settings.indexOf('aria-label="Compounding"'));
    }
  });
});

// B1 follow-up (review items 8a to 8c). Sentences restated by hand.
describe("B1 follow-up", () => {
  const STORED = { id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "log-linear-df" as const, dayCount: "ACT/360" as const, compounding: "annual" as const,
    inputs: [{ instrument: "ois-swap" as const, tenorMonths: 12, quoteType: "par-rate" as const, value: 0.04 }, { instrument: "ois-swap" as const, tenorMonths: 24, quoteType: "par-rate" as const, value: 0.041 }] };

  it("8a: a settings-only edit of a loaded setup reaches the saved block and moves the version", () => {
    const loaded = loadOutcome(emptyEditor(), STORED).editor;
    for (const patch of [{ interpolation: "monotone-convex" as const }, { dayCount: "ACT/365" as const }, { compounding: "semi-annual" as const }]) {
      const edited = setFields(loaded, patch);
      expect(edited.version).toBeGreaterThan(loaded.version);
      const block = blockFromState(edited).block!;
      expect(block).toEqual({ ...STORED, ...patch });
      expect(block).not.toEqual(blockFromState(loaded).block);
    }
  });

  it("8a: a snapshot fill or a stored setup that lands after a settings-only edit replaces nothing and says so", () => {
    const loaded = loadOutcome(emptyEditor(), STORED).editor;
    const started = loaded.version;
    const mark = markOf(loaded);
    const edited = setFields(loaded, { interpolation: "cubic-zero", dayCount: "ACT/365" });
    const f = fillFromSnapshot({ curveConvention: "annual_act360", curveQuotes: [{ term: "2Y", tYears: 2, instrumentType: "OIS", rate: 0.039 }] });
    const fill = fillOutcome(edited, started, f);
    expect(fill.editor).toBe(edited);
    expect(fill.lines).toEqual(["The quotes or settings changed while the snapshot was loading; nothing was replaced."]);
    const load = loadOutcome(edited, { ...STORED, id: "ust-main" }, mark);
    expect(load.editor).toBe(edited);
    expect(load.lines).toEqual(["The editor changed while ust-main was loading; nothing was replaced."]);
    // With nothing changed in between, the stored setup loads as before.
    expect(loadOutcome(loaded, { ...STORED, id: "ust-main" }, mark).editor.id).toBe("ust-main");
  });

  it("8b: the By hint shows on an empty setup list too, with the same words", () => {
    // Review fix round 2 (F-3): one wording that fits an empty list and a full one.
    const hint = "Type your name below to save a setup or make one active.";
    expect(text(html({ by: "" }))).toContain(hint);
    expect(text(html({ by: "", setups: [] }))).toContain(hint);
    // A typed name, or a workspace that takes no write, still hides it.
    expect(text(html({ by: "Chih", setups: [] }))).not.toContain(hint);
    expect(text(html({ by: "", setups: [], blocked: "This workspace is locked." }))).not.toContain(hint);
  });

  it("8c: history names a curve setup by its label, and by its id when no label is known", () => {
    const ref = { collection: "curve-setups" as const, id: "cs-0123456789abcdef" };
    const add: HistoryChange = { kind: "set-block", block: "market", op: "add", ref };
    const edit: HistoryChange = { kind: "set-block", block: "market", op: "set", ref, curveSetup: "edit" };
    const activate: HistoryChange = { kind: "set-block", block: "market", op: "set", ref };
    const labels = new Map([["cs-0123456789abcdef", "SOFR main"]]);
    expect(describeChange(add, labels)).toBe("Added curve setup SOFR main");
    expect(describeChange(edit, labels)).toBe("Saved curve setup SOFR main");
    expect(describeChange(activate, labels)).toBe("Made curve setup SOFR main active");
    expect(changeText(add, labels)).toBe("Added curve setup SOFR main");
    expect(changeText(activate, labels)).toBe("Made curve setup SOFR main active");
    // No label known, or a blank one: the id.
    expect(describeChange(add, new Map())).toBe("Added curve setup cs-0123456789abcdef");
    expect(describeChange(add, new Map([["cs-0123456789abcdef", ""]]))).toBe("Added curve setup cs-0123456789abcdef");
    const line = { revision: 2, at: "t", by: "b", change: edit, manifest: HEAD };
    expect(historyRows([line], labels)[0]!.text).toBe("Saved curve setup SOFR main");
  });

  it("8c: the labels are read once per curve setup id in the history; a read that fails leaves the id", async () => {
    clearCurveSetupLabelCache();
    const mk = (id: string, collection = "curve-setups"): HistoryLine => ({
      revision: 1, at: "t", by: "b", manifest: HEAD,
      change: { kind: "set-block", block: "market", op: "add", ref: { collection, id } } as HistoryChange,
    });
    const reads: string[] = [];
    const read = async (id: string) => {
      reads.push(id);
      if (id === "cs-gone") throw new Error("not found");
      return { label: id === "cs-a" ? "SOFR main" : "UST main" };
    };
    const labels = await curveSetupLabelsFor([mk("cs-a"), mk("cs-a"), mk("cs-b"), mk("cs-gone"), mk("m-1", "market"), { ...mk("x"), change: { kind: "create" } as HistoryChange }], read);
    expect(reads.sort()).toEqual(["cs-a", "cs-b", "cs-gone"]);
    expect([...labels.entries()].sort()).toEqual([["cs-a", "SOFR main"], ["cs-b", "UST main"]]);
  });
});

// Review fix round 1 (M-3, M-6, M-7). Sentences restated by hand.
describe("B1 follow-up, review fix round 1", () => {
  const STORED = { id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "log-linear-df" as const, dayCount: "ACT/360" as const, compounding: "annual" as const,
    inputs: [{ instrument: "ois-swap" as const, tenorMonths: 12, quoteType: "par-rate" as const, value: 0.04 }] };
  const f = fillFromSnapshot({ curveConvention: "annual_act360", curveQuotes: [{ term: "2Y", tYears: 2, instrumentType: "OIS", rate: 0.039 }] });

  it("M-3: a name, label or curve family edit does not move the version, so a snapshot fill still lands", () => {
    const loaded = loadOutcome(emptyEditor(), STORED).editor;
    const started = loaded.version;
    for (const patch of [{ id: "sofr-new" }, { label: "SOFR renamed" }, { baseCurve: "UST" }]) {
      const named = setFields(loaded, patch);
      expect(named.version).toBe(started);
      const out = fillOutcome(named, started, f);
      expect(out.editor.rows.map((r) => r.tenorText)).toEqual(["2Y"]);
      // The fill keeps the name fields as typed.
      expect(out.editor).toMatchObject(patch);
    }
    // A menu edit still moves it, and the fill then says what changed.
    const menu = setFields(loaded, { interpolation: "cubic-zero" });
    expect(menu.version).toBeGreaterThan(started);
    expect(fillOutcome(menu, started, f).lines).toEqual(["The quotes or settings changed while the snapshot was loading; nothing was replaced."]);
  });

  it("M-6: a save says the editor changed after Save was pressed when the block on screen is no longer the one sent", () => {
    const loaded = loadOutcome(emptyEditor(), STORED).editor;
    const sent = blockFromState(loaded).block!;
    expect(saveLines(sent, loaded)).toEqual(["Saved sofr-main."]);
    for (const patch of [{ interpolation: "monotone-convex" as const }, { label: "SOFR renamed" }]) {
      expect(saveLines(sent, setFields(loaded, patch))).toEqual([
        "Saved sofr-main as it stood when Save was pressed. The editor changed after the save started; save again to keep the change.",
      ]);
    }
    expect(saveLines(sent, setRow(loaded, loaded.rows[0]!.key, { valueText: "0.05" }))[0]).toContain("The editor changed after the save started");
  });

  it("M-7: Edit is off while the setup list reloads, and on once it has", () => {
    expect(buttonOf(html({ listReloading: true }), "Edit")).toContain("disabled");
    expect(buttonOf(html({ listReloading: false }), "Edit")).not.toContain("disabled");
    expect(buttonOf(html(), "Edit")).not.toContain("disabled");
  });
});

// Review fix round 2 (N-1, F-2). Sentences restated by hand.
describe("B1 follow-up, review fix round 2", () => {
  const STORED = { id: "sofr-main", label: "SOFR main", baseCurve: "SOFR", interpolation: "log-linear-df" as const, dayCount: "ACT/360" as const, compounding: "annual" as const,
    inputs: [{ instrument: "ois-swap" as const, tenorMonths: 12, quoteType: "par-rate" as const, value: 0.04 }] };

  it("N-1: a name, label or curve family typed before a stored setup lands keeps the editor and says so", () => {
    const loaded = loadOutcome(emptyEditor(), STORED).editor;
    const mark = markOf(loaded);
    for (const patch of [{ label: "SOFR renamed" }, { id: "sofr-new" }, { baseCurve: "UST" }]) {
      const typed = setFields(loaded, patch);
      const out = loadOutcome(typed, { ...STORED, id: "ust-main", label: "UST main" }, mark);
      expect(out.editor).toBe(typed);
      expect(out.lines).toEqual(["The editor changed while ust-main was loading; nothing was replaced."]);
    }
    // M-3 still holds: the same edits let a snapshot fill land.
    const f = fillFromSnapshot({ curveConvention: "annual_act360", curveQuotes: [{ term: "2Y", tYears: 2, instrumentType: "OIS", rate: 0.039 }] });
    expect(fillOutcome(setFields(loaded, { label: "SOFR renamed" }), loaded.version, f).editor.rows.map((r) => r.tenorText)).toEqual(["2Y"]);
  });

  it("F-2: a label is read once per id per session; ids the list already named are never read", async () => {
    clearCurveSetupLabelCache();
    const line = (id: string): HistoryLine => ({
      revision: 1, at: "t", by: "b", manifest: HEAD,
      change: { kind: "set-block", block: "market", op: "add", ref: { collection: "curve-setups", id } } as HistoryChange,
    });
    const reads: string[] = [];
    const read = async (id: string) => { reads.push(id); return { label: `label of ${id}` }; };
    expect([...(await curveSetupLabelsFor([line("cs-c1")], read)).entries()]).toEqual([["cs-c1", "label of cs-c1"]]);
    expect([...(await curveSetupLabelsFor([line("cs-c1")], read)).entries()]).toEqual([["cs-c1", "label of cs-c1"]]);
    expect(reads).toEqual(["cs-c1"]);
    rememberCurveSetupLabels([{ id: "cs-listed", label: "Listed main" }]);
    expect((await curveSetupLabelsFor([line("cs-listed"), line("cs-c1")], read)).get("cs-listed")).toBe("Listed main");
    expect(reads).toEqual(["cs-c1"]);
    clearCurveSetupLabelCache();
  });
});
