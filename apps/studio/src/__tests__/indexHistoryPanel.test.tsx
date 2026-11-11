// apps/studio/src/__tests__/indexHistoryPanel.test.tsx
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { IndexHistory } from "@alm/engine";
import { IndexHistoryView, type IndexHistoryViewProps } from "../pages/market/IndexHistoryPanel";

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};
/** The reason beside Import while another call on the page runs, restated. */
const BUSY_ELSEWHERE = "Another call on this page is running; Import waits for it.";

const H: IndexHistory = { label: "Synthetic one-month (demonstration values)", firstMonth: "2025-10", values: [0.041, 0.0415, 0.042], source: { fileName: "s.csv", fileSha256: "a".repeat(64), format: "csv", frequency: "daily", rows: 60, unit: "percent" } };
const H_ID = "ih-0123456789abcdef";
/** The summary of the model test, restated. */
const SUMMARY = "Last month 2025-12. The cut-off month is 2026-03: 2 months before it have no value and a lag reads them flat.";

const props = (over: Partial<IndexHistoryViewProps> = {}): IndexHistoryViewProps => ({
  indexId: "rfr-1m",
  history: { state: "ok", id: H_ID, value: H },
  calibrationDate: "2026-03-31",
  file: null,
  unit: "",
  label: "",
  busy: false,
  note: null,
  off: false,
  onFile: noop, onUnit: noop, onLabel: noop, onImport: noop, onClear: noop,
  ...over,
});

describe("IndexHistoryView (Piece B, step B3b, decision 54)", () => {
  it("a loaded history shows the summary, the chart, its table, the import controls and Clear the history", () => {
    const html = renderToStaticMarkup(<IndexHistoryView {...props()} />);
    const t = text(html);
    expect(html).toContain('aria-label="History of rfr-1m"');
    expect(t).toContain(SUMMARY);
    expect(html).toContain("<svg");
    expect(t).toContain("Show table");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="\.csv,\.xlsx"/);
    const at = html.indexOf('aria-label="Unit"');
    expect(at).toBeGreaterThan(0);
    const sel = html.slice(at, html.indexOf("</select>", at));
    expect([...sel.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])).toEqual([
      "Choose a unit", "Percent (4.31 is 4.31 percent)", "Decimal (0.0431 is 4.31 percent)",
    ]);
    expect(html).toMatch(/<button[^>]*>Clear the history<\/button>/);
    expect(t).toContain(`Source: GET /api/index-histories/${H_ID}; s.csv, daily rows read as month-end fixings, declared percent`);
    expect(t).toContain("Two columns, date and value. Dates YYYY-MM-DD, YYYY-MM or Excel dates; a daily file keeps each month's last fixing.");
    expect(t).toContain("Leave empty for the file name");
    // The table prints each stored month and its value.
    expect(t).toContain("2025-12 4.2000 percent");
  });
  it("no history: says so, offers the import, draws no chart and offers no Clear", () => {
    const html = renderToStaticMarkup(<IndexHistoryView {...props({ history: { state: "none" } })} />);
    expect(text(html)).toContain("This index carries no history.");
    expect(html).toMatch(/<input[^>]*type="file"/);
    expect(html).toContain('aria-label="Unit"');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("Clear the history");
  });
  it("a history that is being read, or could not be read, says so and keeps Clear", () => {
    const loading = renderToStaticMarkup(<IndexHistoryView {...props({ history: { state: "loading" } })} />);
    expect(text(loading)).toContain("Reading the history");
    expect(loading).toContain("Clear the history");
    const err = renderToStaticMarkup(<IndexHistoryView {...props({ history: { state: "error", text: "404: index history not found" } })} />);
    expect(err).toMatch(/role="alert"[^>]*>[^<]*404: index history not found/);
    expect(err).toContain("Clear the history");
  });
  it("the Import button is off by aria-disabled with the block sentence beside it (the Polish 1 rule)", () => {
    const html = renderToStaticMarkup(<IndexHistoryView {...props({ file: "s.csv" })} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Import<\/button>/);
    expect(text(html)).toContain("Choose the file's unit, percent or decimal.");
    const ready = renderToStaticMarkup(<IndexHistoryView {...props({ file: "s.csv", unit: "percent" })} />);
    expect(ready).toMatch(/<button[^>]*>Import<\/button>/);
    expect(ready).not.toMatch(/<button[^>]*aria-disabled="true"[^>]*>Import<\/button>/);
  });
  it("a page that is busy elsewhere turns the import off and says why (review fix)", () => {
    const html = renderToStaticMarkup(<IndexHistoryView {...props({ file: "s.csv", unit: "percent", off: true })} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="([^"]+)"[^>]*>Import<\/button>/);
    const id = /aria-describedby="([^"]+)"[^>]*>Import</.exec(html)![1]!;
    expect(html).toContain(`id="${id}" role="status">${BUSY_ELSEWHERE.replace(/'/g, "&#x27;")}</span>`);
  });
  it("a file over 4 MiB turns the import off with the size sentence (review fix)", () => {
    const t = text(renderToStaticMarkup(<IndexHistoryView {...props({ file: "s.csv", fileSize: 5000000, unit: "percent" })} />));
    expect(t).toContain('The file "s.csv" is 5000000 bytes; an index history file is at most 4194304 bytes.');
  });
  it("Clear the history prints its note as a status (review fix)", () => {
    const html = renderToStaticMarkup(<IndexHistoryView {...props({ note: { ok: true, text: "A row below clears the history of rfr-1m; preview and save the market to apply it.", refusals: [] } })} />);
    expect(html).toMatch(/role="status"[^>]*>A row below clears the history of rfr-1m; preview and save the market to apply it\.</);
  });
  it("a refused import prints the note and each refusal in a list, as an alert", () => {
    const refusals = ["row 2: value 4.3 is above 1.0, which a decimal rate cannot be; if the file is in percent, import it with the unit percent", "and 3 more rows refused"];
    const html = renderToStaticMarkup(<IndexHistoryView {...props({ note: { ok: false, text: "The file was not imported.", refusals } })} />);
    const at = html.indexOf('role="alert"');
    expect(at).toBeGreaterThan(0);
    const alert = html.slice(at, html.indexOf("</ul>", at));
    expect(text(alert)).toContain("The file was not imported.");
    for (const r of refusals) expect(alert).toContain(`<li>${r.replace(/'/g, "&#x27;")}</li>`);
  });
  it("an import that landed prints its note as a status", () => {
    const html = renderToStaticMarkup(<IndexHistoryView {...props({ note: { ok: true, text: "Imported ih-0123456789abcdef: 3 months, 2025-10 to 2025-12.", refusals: [] } })} />);
    expect(html).toMatch(/role="status"[^>]*>Imported ih-0123456789abcdef/);
  });
  it("holds neither an em-dash nor a section sign, in markup or in source", () => {
    for (const p of [props(), props({ history: { state: "none" }, note: { ok: false, text: "The file was not imported.", refusals: ["row 2"] } })]) {
      expect(renderToStaticMarkup(<IndexHistoryView {...p} />)).not.toMatch(BANNED_CHARS);
    }
    for (const f of ["../pages/market/IndexHistoryPanel.tsx", "../market/indexHistoryModel.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(BANNED_CHARS);
    }
  });
});
