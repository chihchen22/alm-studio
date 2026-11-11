// apps/studio/src/__tests__/indexHistoryModel.test.ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IndexHistory } from "@alm/engine";
import {
  clearNoteOf, HISTORY_UNIT_CHOICES, historyIdFor, historyMonthLabel, MAX_INDEX_HISTORY_FILE_BYTES, historyPoints, historySummaryText, historyTicks, importBlock, importNoteOf, parseHistoryUnit,
  landStartFill, START_FILL_NO_HISTORY, START_FILL_RACE, startFillFor, startFillLanding, startFillOf, startFillSourceOf,
} from "../market/indexHistoryModel";
import {
  addHistoryOp, addRateIndexOp, emptyRateIndexDraft, removeRateIndexOp, setRateIndexMarket, setRateIndexOpField, type RateIndexDraft, type RateIndexOpDraft, type RateIndexSource,
} from "../market/rateIndexModel";

const H: IndexHistory = { label: "Synthetic one-month (demonstration values)", firstMonth: "2025-10", values: [0.041, 0.0415, 0.042], source: { fileName: "s.csv", fileSha256: "a".repeat(64), format: "csv", frequency: "daily", rows: 60, unit: "percent" } };

describe("index history model (Piece B, step B3b, decision 54)", () => {
  it("plots percent by month index, labels each point by its month", () => {
    expect(historyPoints(H)).toEqual([[0, 4.1], [1, 4.15], [2, 4.2]]);
    expect(historyMonthLabel(H, 2)).toBe("2025-12");
  });
  it("states the last month and the gap to the cut-off (decision 54)", () => {
    expect(historySummaryText(H, "2026-03-31")).toBe("Last month 2025-12. The cut-off month is 2026-03: 2 months before it have no value and a lag reads them flat.");
    expect(historySummaryText({ ...H, values: [...H.values, 0.0425, 0.043] }, "2026-03-31")).toBe("Last month 2026-02. The cut-off month is 2026-03: every month before it has a value.");
    expect(historySummaryText({ ...H, values: [...H.values, 0.0425, 0.043, 0.0435] }, "2026-03-31")).toBe("Last month 2026-03. The cut-off month is 2026-03: every month before it has a value; months from the cut-off on are display only.");
    expect(historySummaryText(H, undefined)).toBe("Last month 2025-12. The market carries no calibration date, so the gap to the cut-off is not known.");
  });
  it("reads the cut-off month the way a run does (asOfMonthOf); a malformed calibration date gets its own sentence (B3b follow-up item 4)", () => {
    expect(historySummaryText(H, "2026-03")).toBe("Last month 2025-12. The cut-off month is 2026-03: 2 months before it have no value and a lag reads them flat.");
    expect(historySummaryText(H, "03/31/2026")).toBe(
      'Last month 2025-12. The market\'s calibration date "03/31/2026" does not start with a month YYYY-MM, so the gap to the cut-off is not known.',
    );
    expect(historySummaryText(H, "2026-13-01")).toBe(
      'Last month 2025-12. The market\'s calibration date "2026-13-01" does not start with a month YYYY-MM, so the gap to the cut-off is not known.',
    );
  });
  it("says 1 month in the singular", () => {
    expect(historySummaryText({ ...H, values: [...H.values, 0.0425] }, "2026-03-31")).toBe("Last month 2026-01. The cut-off month is 2026-03: 1 month before it has no value and a lag reads it flat.");
  });
  it("a history that starts at or after the cut-off serves no month before it (no look-ahead, Task 3 ruling)", () => {
    expect(historySummaryText({ ...H, firstMonth: "2026-03" }, "2026-03-31")).toBe(
      "Last month 2026-05. The cut-off month is 2026-03: the history starts 2026-03, at or after it, so no month before it has a value and a lag reads them flat; months from the cut-off on are display only.",
    );
  });
  it("parses the unit at the boundary (N8)", () => {
    expect(parseHistoryUnit("percent")).toBe("percent");
    expect(parseHistoryUnit("decimal")).toBe("decimal");
    expect(parseHistoryUnit("")).toBeNull();
    expect(parseHistoryUnit("Percent")).toBeNull();
  });
  it("offers the unit choices, empty first, so the unit is never guessed", () => {
    expect(HISTORY_UNIT_CHOICES).toEqual([
      { unit: "", text: "Choose a unit" },
      { unit: "percent", text: "Percent (4.31 is 4.31 percent)" },
      { unit: "decimal", text: "Decimal (0.0431 is 4.31 percent)" },
    ]);
  });
  it("blocks the import until a file and a unit are chosen; the unit is never guessed (decision 51)", () => {
    expect(importBlock({ file: null, unit: "", busy: false })).toBe("Choose a .csv or .xlsx file first.");
    expect(importBlock({ file: "s.csv", unit: "", busy: false })).toBe("Choose the file's unit, percent or decimal.");
    expect(importBlock({ file: "s.txt", unit: "percent", busy: false })).toBe("The file must be .csv or .xlsx.");
    expect(importBlock({ file: "s.csv", unit: "percent", busy: true })).toBe("An import is in progress.");
    expect(importBlock({ file: "s.xlsx", unit: "decimal", busy: false })).toBeNull();
  });
  it("refuses a file name the upload header cannot carry, before any request (Task 6 review)", () => {
    const refusal = "The file name holds a character the upload cannot carry; rename the file with Western European letters, digits, spaces and plain punctuation, then choose it again.";
    // An en dash (U+2013), a CJK character and a newline: fetch throws on each in the X-Filename header.
    for (const name of [`rates ${String.fromCharCode(0x2013)} 2026.csv`, `${String.fromCharCode(0x5229)}.csv`, "a\nb.csv"]) {
      expect(importBlock({ file: name, unit: "percent", busy: false }), JSON.stringify(name)).toBe(refusal);
    }
    // Latin-1 letters pass: the header carries them byte for byte.
    expect(importBlock({ file: `taux ${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}.csv`, unit: "percent", busy: false })).toBeNull();
    expect(importBlock({ file: "S.CSV", unit: "percent", busy: false })).toBeNull();
  });
  it("words the import reply, with the imported series' last month and gap to the cut-off (review fix)", () => {
    expect(importNoteOf({ ok: true, id: "ih-0123456789abcdef", created: true, history: H }, "2026-03-31")).toEqual({
      ok: true, refusals: [],
      text: "Imported ih-0123456789abcdef: 3 months from 2025-10. Last month 2025-12. The cut-off month is 2026-03: 2 months before it have no value and a lag reads them flat. A row below points the index at it; preview and save the market to attach it.",
    });
    expect(importNoteOf({ ok: true, id: "ih-0123456789abcdef", created: false, history: H }, "2026-03-31").text).toContain("The store already held this series as ih-0123456789abcdef: 3 months from 2025-10. Last month 2025-12.");
    expect(importNoteOf({ ok: true, id: "ih-0123456789abcdef", created: true, history: H }, undefined).text).toBe(
      "Imported ih-0123456789abcdef: 3 months from 2025-10. Last month 2025-12. The market carries no calibration date, so the gap to the cut-off is not known. A row below points the index at it; preview and save the market to attach it.",
    );
    expect(importNoteOf({ ok: false, refusals: ["row 2: value 4.3 is above 1.0, which a decimal rate cannot be; if the file is in percent, import it with the unit percent"] }, "2026-03-31")).toEqual({ ok: false, text: "The file was not imported.", refusals: ["row 2: value 4.3 is above 1.0, which a decimal rate cannot be; if the file is in percent, import it with the unit percent"] });
  });
  it("says when the file ends before its last month's last weekday, so that month is a mid-month fixing (B3b follow-up item 6)", () => {
    expect(importNoteOf({ ok: true, id: "ih-0123456789abcdef", created: true, history: H, partialLastMonth: { month: "2025-12", lastDay: "2025-12-12" } }, "2026-03-31").text).toBe(
      "Imported ih-0123456789abcdef: 3 months from 2025-10. Last month 2025-12. The cut-off month is 2026-03: 2 months before it have no value and a lag reads them flat. The file ends 2025-12-12, before the last weekday of 2025-12, so the 2025-12 value is that day's fixing, not a month-end one. A row below points the index at it; preview and save the market to attach it.",
    );
  });
  it("words a one-month reply in the singular", () => {
    expect(importNoteOf({ ok: true, id: "ih-0123456789abcdef", created: true, history: { ...H, values: [0.041] } }, "2026-03-31").text).toBe(
      "Imported ih-0123456789abcdef: 1 month from 2025-10. Last month 2025-10. The cut-off month is 2026-03: 4 months before it have no value and a lag reads them flat. A row below points the index at it; preview and save the market to attach it.",
    );
  });
  it("words Clear the history as a row below, saved with the market (review fix)", () => {
    expect(clearNoteOf("rfr-1m")).toEqual({ ok: true, refusals: [], text: "A row below clears the history of rfr-1m; preview and save the market to apply it." });
  });
  it("refuses a file over 4 MiB before reading it, in the server's words (review fix)", () => {
    expect(MAX_INDEX_HISTORY_FILE_BYTES).toBe(4194304);
    // Restated from the server's intake module, which Studio does not import.
    const server = readFileSync(new URL("../../../server/src/intake/indexHistory.ts", import.meta.url), "utf8");
    expect(server).toContain("export const MAX_INDEX_HISTORY_FILE_BYTES = 4 * 1024 * 1024;");
    expect(importBlock({ file: "s.csv", size: 4194305, unit: "percent", busy: false })).toBe('The file "s.csv" is 4194305 bytes; an index history file is at most 4194304 bytes.');
    expect(importBlock({ file: "s.csv", size: 4194304, unit: "percent", busy: false })).toBeNull();
  });
  it("ticks every third month on a short series and each January on one longer than 36 months", () => {
    expect(historyTicks({ ...H, values: Array.from({ length: 7 }, () => 0.04) })).toEqual([
      { value: 0, label: "2025-10" }, { value: 3, label: "2026-01" }, { value: 6, label: "2026-04" },
    ]);
    const long = historyTicks({ ...H, values: Array.from({ length: 40 }, () => 0.04) });
    expect(long).toEqual([{ value: 3, label: "2026-01" }, { value: 15, label: "2027-01" }, { value: 27, label: "2028-01" }, { value: 39, label: "2029-01" }]);
  });
});

/** A stored market's indices, with derivedFrom left out. */
const SEEDED_SOURCE: RateIndexSource = {
  rateIndices: [{ id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basis: 0 }],
  calibrationDate: "2026-03-31",
};

describe("the start fill (decision 53)", () => {
  const FULL6 = { ...H, values: [0.041, 0.0415, 0.042, 0.0425, 0.043, 0.0435] };
  it("fills start from the cut-off month's fixing minus the typed basis, in basis points", () => {
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "0" })).toEqual({ startText: "435" });
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "10" })).toEqual({ startText: "425" });
    // N6: an empty basis is 0, special-cased before readValue.
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "" })).toEqual({ startText: "435" });
  });
  it("refuses a history that ends before the cut-off, naming its last month; and a market with no date", () => {
    expect(startFillOf(H, "2026-03-31", { valueText: "0" })).toEqual({ refusal: "the history ends 2025-12, before the cut-off month 2026-03; type the start value" });
    expect(startFillOf(FULL6, undefined, { valueText: "0" })).toEqual({ refusal: "The market carries no calibration date, so the cut-off month is not known; type the start value." });
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "x" })).toEqual({ refusal: "Enter the basis as a number first; the start is the fixing minus the basis." });
  });
  it("a malformed calibration date gets its own sentence, never the starts-after refusal (Task 1 review)", () => {
    for (const bad of ["", "31/03/2026", "2026-13-01", "garbage"]) {
      expect(startFillOf(FULL6, bad, { valueText: "0" }), bad).toEqual({
        refusal: `The market's calibration date ${JSON.stringify(bad)} does not start with a month YYYY-MM, so the cut-off month is not known; type the start value.`,
      });
    }
    // A readable date before the history's first month keeps the engine's own refusal.
    expect(startFillOf(FULL6, "2025-08-31", { valueText: "0" })).toEqual({ refusal: "the history starts 2025-10, after the cut-off month 2025-08; type the start value" });
  });
  it("N10: refuses a fill the validator would refuse, since it checks the start alone against the floor and the cap", () => {
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "10", floorText: "430" })).toEqual({
      refusal: "The fill would write a start of 425 bp (the history's 435 bp at 2026-03 less the 10 bp basis), below the floor of 430 bp; the market checks the start alone against its floor and cap and would be refused, so type the start value or change the basis.",
    });
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "-10", capText: "440" })).toEqual({
      refusal: "The fill would write a start of 445 bp (the history's 435 bp at 2026-03 less the -10 bp basis), above the cap of 440 bp; the market checks the start alone against its floor and cap and would be refused, so type the start value or change the basis.",
    });
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "0", floorText: "430", capText: "x" })).toEqual({ startText: "435" });
    // On the bound is allowed: the validator refuses a start strictly outside it.
    expect(startFillOf(FULL6, "2026-03-31", { valueText: "0", floorText: "435", capText: "435" })).toEqual({ startText: "435" });
  });
  it("finds the index's history: a draft row first, a clear row is none, else the stored record", () => {
    const src = { ...SEEDED_SOURCE, rateIndices: [{ id: "admin-rate", label: "A", kind: "formula" as const, parent: "rfr-1m", beta: 0.4, start: 0.0433, basis: 0, historyId: "ih-1111111111111111" }] };
    const d0 = setRateIndexMarket(emptyRateIndexDraft(), "m");
    expect(historyIdFor(d0, src, "admin-rate")).toBe("ih-1111111111111111");
    expect(historyIdFor(addHistoryOp(d0, "admin-rate", "ih-2222222222222222"), src, "admin-rate")).toBe("ih-2222222222222222");
    expect(historyIdFor(addHistoryOp(d0, "admin-rate", null), src, "admin-rate")).toBeNull();
    expect(historyIdFor(d0, src, "nope")).toBeNull();
  });
  it("the last history row naming the index wins; a row for another index or with no id yet does not count", () => {
    const d0 = setRateIndexMarket(emptyRateIndexDraft(), "m");
    const d1 = addHistoryOp(addHistoryOp(d0, "rfr-1m", null), "rfr-1m", "ih-3333333333333333");
    expect(historyIdFor(d1, SEEDED_SOURCE, "rfr-1m")).toBe("ih-3333333333333333");
    expect(historyIdFor(addHistoryOp(d1, "rfr-1m", null), SEEDED_SOURCE, "rfr-1m")).toBeNull();
    expect(historyIdFor(addHistoryOp(d0, "other", "ih-4444444444444444"), SEEDED_SOURCE, "rfr-1m")).toBeNull();
    // A history row whose id is not yet set (the request builder blocks it) names nothing; a set row is not a history row.
    const unset = setRateIndexOpField(addRateIndexOp(d0, "history"), 0, { indexId: "rfr-1m" });
    expect(historyIdFor(unset, { rateIndices: [{ id: "rfr-1m", label: "R", tenorMonths: 1, basis: 0, historyId: "ih-5555555555555555" }] }, "rfr-1m")).toBe("ih-5555555555555555");
  });
  it("words the index with no history", () => {
    expect(START_FILL_NO_HISTORY).toBe("This index carries no history to fill the start from; import one under History, or type the start value.");
  });
});

describe("the start fill's source and landing (Task 10 review)", () => {
  const FULL6 = { ...H, values: [0.041, 0.0415, 0.042, 0.0425, 0.043, 0.0435] };
  const src: RateIndexSource = { ...SEEDED_SOURCE, rateIndices: [{ id: "rfr-1m", label: "R", tenorMonths: 1, basis: 0, historyId: "ih-1111111111111111" }, { id: "rfr-3m", label: "T", tenorMonths: 3, basis: 0 }] };
  const d0 = setRateIndexMarket(emptyRateIndexDraft(), "m");
  it("names the history to read, or why there is none, before any read", () => {
    expect(startFillSourceOf(d0, src, "rfr-1m")).toEqual({ historyId: "ih-1111111111111111" });
    expect(startFillSourceOf(addHistoryOp(d0, "rfr-3m", "ih-2222222222222222"), src, "rfr-3m")).toEqual({ historyId: "ih-2222222222222222" });
    expect(startFillSourceOf(d0, src, "rfr-3m")).toEqual({ refusal: START_FILL_NO_HISTORY });
    expect(startFillSourceOf(d0, src, "")).toEqual({ refusal: "Enter the index id first; the fill reads that index's own history." });
    expect(startFillSourceOf(d0, src, "  ")).toEqual({ refusal: "Enter the index id first; the fill reads that index's own history." });
    expect(startFillSourceOf(d0, src, "admin-rate")).toEqual({
      refusal: 'The market does not carry "admin-rate" yet, so it has no history to read; save the market with the index, then import its history under History, or type the start value.',
    });
  });
  it("adds the history id and the cut-off month to a fill; a refusal passes through", () => {
    expect(startFillFor(FULL6, "ih-1111111111111111", "2026-03-31", { valueText: "0" })).toEqual({ startText: "435", historyId: "ih-1111111111111111", month: "2026-03" });
    expect(startFillFor(H, "ih-1111111111111111", "2026-03-31", { valueText: "0" })).toEqual({ refusal: "the history ends 2025-12, before the cut-off month 2026-03; type the start value" });
  });
  // A beta row as clicked: the landing compares the row as it stands with this copy.
  const rowDraft = () => setRateIndexOpField(addRateIndexOp(d0, "set"), 0, { indexKind: "formula", form: "change", indexId: "rfr-1m", valueText: "0", startText: "", floorText: "", capText: "" });
  const FILL = { startText: "435", historyId: "ih-1111111111111111", month: "2026-03" };
  it("writes the start and says where it came from when the row is as it was sent", () => {
    const d = rowDraft();
    const out = startFillLanding(d, 0, d.ops[0]!, FILL);
    expect(out.draft.ops[0]!.startText).toBe("435");
    expect(out.note).toBe("Filled from ih-1111111111111111 at 2026-03.");
    const refused = startFillLanding(d, 0, d.ops[0]!, { refusal: "no" });
    expect(refused).toEqual({ draft: d, note: "no" });
  });
  it("replaces nothing when the row changed while the history was read, field by field", () => {
    const sent = rowDraft().ops[0]!;
    const patches: Array<Partial<RateIndexOpDraft>> = [
      { indexId: "rfr-3m" }, { valueText: "10" }, { startText: "433" }, { floorText: "430" }, { capText: "440" }, { form: "level" },
    ];
    for (const patch of patches) {
      const now = setRateIndexOpField(rowDraft(), 0, patch);
      const out = startFillLanding(now, 0, sent, FILL);
      expect(out.draft, JSON.stringify(patch)).toBe(now);
      expect(out.note, JSON.stringify(patch)).toBe(START_FILL_RACE);
      // A refusal judged against the old row is not shown as if it were about the new one.
      expect(startFillLanding(now, 0, sent, { refusal: "no" }).note).toBe(START_FILL_RACE);
    }
    expect(START_FILL_RACE).toBe("The row changed while its history was read; nothing was replaced.");
  });
  it("replaces nothing when the row was removed meanwhile; another row's edit does not cancel the fill", () => {
    const d = rowDraft();
    const gone = removeRateIndexOp(d, 0);
    expect(startFillLanding(gone, 0, d.ops[0]!, FILL)).toEqual({ draft: gone, note: START_FILL_RACE });
    const other = setRateIndexOpField(addRateIndexOp(d, "shift"), 1, { valueText: "25" });
    expect(startFillLanding(other, 0, d.ops[0]!, FILL).draft.ops[0]!.startText).toBe("435");
  });
  // B3b follow-up item 3: the page judged the note on the draft as last rendered and wrote through a functional update
  // that reads the draft as it stands, so a keystroke queued between the two left the row alone under "Filled from".
  // landStartFill decides the note inside the one update that writes, so the note says "Filled from" only when the
  // draft changed. `update` stands for the page's synchronous state update; here it holds the draft in a variable.
  const updater = (start: RateIndexDraft) => {
    let state = start;
    return { update: (fn: (d: RateIndexDraft) => RateIndexDraft) => { state = fn(state); }, now: () => state };
  };
  it("lands a fill through the update that writes it: Filled from, and the draft changed", () => {
    const d = rowDraft();
    const u = updater(d);
    expect(landStartFill(u.update, 0, d.ops[0]!, FILL)).toEqual({ changed: true, note: "Filled from ih-1111111111111111 at 2026-03." });
    expect(u.now().ops[0]!.startText).toBe("435");
  });
  it("a row edited after the last render but before the update leaves the draft alone and never says Filled from", () => {
    const sent = rowDraft().ops[0]!;
    // The draft the update reads already holds a keystroke the page had not rendered when the fill landed.
    const u = updater(setRateIndexOpField(rowDraft(), 0, { valueText: "10" }));
    const before = u.now();
    const out = landStartFill(u.update, 0, sent, FILL);
    expect(out).toEqual({ changed: false, note: START_FILL_RACE });
    expect(u.now()).toBe(before);
  });
  it("a refusal changes nothing and is the note; an update that never runs claims no fill", () => {
    const d = rowDraft();
    const u = updater(d);
    expect(landStartFill(u.update, 0, d.ops[0]!, { refusal: "no" })).toEqual({ changed: false, note: "no" });
    expect(u.now()).toBe(d);
    expect(landStartFill(() => {}, 0, d.ops[0]!, FILL)).toEqual({ changed: false, note: START_FILL_RACE });
  });
});

describe("the page lands a fill through landStartFill (B3b follow-up item 3)", () => {
  const page = readFileSync(new URL("../pages/market/RateIndicesPage.tsx", import.meta.url), "utf8");
  it("decides the note inside a synchronous draft update, never on the draft as last rendered", () => {
    expect(page).toContain("landStartFill((fn) => flushSync(() => setDraft(fn)), rowKey, sent, fill)");
    expect(page).not.toContain("startFillLanding(latest.current");
  });
});

describe("browser safety", () => {
  const src = readFileSync(new URL("../market/indexHistoryModel.ts", import.meta.url), "utf8");
  it("imports the engine only as types or by path, and never the hash module or node:crypto", () => {
    const imports = [...src.matchAll(/^import\s+([^;]*?)\s+from\s+"([^"]+)";/gm)].map((m) => ({ clause: m[1]!, from: m[2]! }));
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i.from).not.toContain("runtime/contentHash");
      expect(i.from.startsWith("node:")).toBe(false);
      if (i.from === "@alm/engine") expect(i.clause.startsWith("type ")).toBe(true);
    }
  });
  it("the engine's history module, and every module it reaches, stays free of Node imports (Task 1 review)", () => {
    const root = new URL("../../../../packages/engine/src/indexHistory/history.ts", import.meta.url);
    const seen = new Set<string>();
    const queue: URL[] = [root];
    const specs: string[] = [];
    while (queue.length > 0) {
      const at = queue.shift()!;
      if (seen.has(at.href)) continue;
      seen.add(at.href);
      const code = readFileSync(at, "utf8");
      for (const m of code.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)";/gm)) {
        const spec = m[1]!;
        specs.push(spec);
        if (spec.startsWith(".")) {
          const file = new URL(`${spec}.ts`, at);
          queue.push(existsSync(file) ? file : new URL(`${spec}/index.ts`, at));
        }
      }
    }
    // The walk reaches the modules the history module reads.
    const names = [...seen].map((h) => h.slice(h.indexOf("/engine/src/") + "/engine/src/".length));
    for (const f of ["indexHistory/history.ts", "contracts/indexHistory.ts", "macro/macroFactors.ts", "rateIndex/record.ts"]) expect(names).toContain(f);
    const NODE = /^(node:|fs$|path$|crypto$|os$|url$|child_process$|worker_threads$|module$)/;
    for (const s of specs) {
      expect(s, s).not.toMatch(NODE);
      expect(s, s).not.toContain("runtime/contentHash");
    }
  });
  it("holds neither an em-dash nor a section sign", () => {
    expect(src).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`));
  });
});
