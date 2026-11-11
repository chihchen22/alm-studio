// apps/studio/src/market/indexHistoryModel.ts
/**
 * The History panel of Data > Market > Rate indices. Pure functions over
 * one stored index history: the chart's points and ticks, the sentence that states its last month and the gap to the
 * market's cut-off month, the import's block and the words for its reply. The month reads (monthIndex,
 * historyLastMonth) come by path from the engine's browser-safe history module, so the gap is counted the way a run
 * counts it; the server reads the file and converts the unit, and nothing here re-derives a stored value. The one
 * piece of arithmetic is display scaling: a stored decimal is plotted as a percent. The start fill of a beta index
 * (decision 53) takes its number from the engine's startFromHistory; the fixing it names in a refusal is that number
 * plus the basis, restated for the sentence.
 */
import type { IndexHistory, IndexHistoryUnit } from "@alm/engine";
import { historyLastMonth, monthIndex, startFromHistory } from "@alm/engine/src/indexHistory/history";
import { asOfMonthOf, monthAdd } from "@alm/engine/src/macro/macroFactors";
import type { ImportIndexHistoryResult } from "@alm/reader";
import type { Point, XTick } from "../charts/plotScale";
import { readValue } from "../scenarios/behavioralShockModel";
import { setRateIndexOpField, type RateIndexDraft, type RateIndexOpDraft, type RateIndexSource } from "./rateIndexModel";

/** The unit select: empty first, so the unit is always chosen and never guessed (decision 51). */
export const HISTORY_UNIT_CHOICES: ReadonlyArray<{ unit: "" | IndexHistoryUnit; text: string }> = [
  { unit: "", text: "Choose a unit" },
  { unit: "percent", text: "Percent (4.31 is 4.31 percent)" },
  { unit: "decimal", text: "Decimal (0.0431 is 4.31 percent)" },
];

/** The select's text as the contract's unit, by a parse at the boundary (plan v2 N8), never a cast. */
export function parseHistoryUnit(text: string): IndexHistoryUnit | null {
  return text === "percent" || text === "decimal" ? text : null;
}

/**
 * Characters the X-Filename header can carry: printable ASCII and the Latin-1 letters. fetch throws on anything else
 * (an en dash, a CJK name, a control character), so such a name is refused before the bytes are read.
 */
const HEADER_SAFE = /^[\x20-\x7e\xa0-\xff]*$/;

/**
 * The import file cap in bytes (4 MiB), restated from apps/server/src/intake/indexHistory.ts, which Studio does not
 * import; a test pins the server's line. A larger file is refused before its bytes are read.
 */
export const MAX_INDEX_HISTORY_FILE_BYTES = 4194304;

/** Why Import is off, or null when it can run. size is the chosen file's size in bytes, when known. */
export function importBlock(s: { file: string | null; size?: number; unit: string; busy: boolean }): string | null {
  if (s.file === null) return "Choose a .csv or .xlsx file first.";
  if (!/\.(csv|xlsx)$/i.test(s.file)) return "The file must be .csv or .xlsx.";
  if (!HEADER_SAFE.test(s.file)) {
    return "The file name holds a character the upload cannot carry; rename the file with Western European letters, digits, spaces and plain punctuation, then choose it again.";
  }
  if (s.size !== undefined && s.size > MAX_INDEX_HISTORY_FILE_BYTES) {
    return `The file ${JSON.stringify(s.file)} is ${s.size} bytes; an index history file is at most ${MAX_INDEX_HISTORY_FILE_BYTES} bytes.`;
  }
  if (parseHistoryUnit(s.unit) === null) return "Choose the file's unit, percent or decimal.";
  if (s.busy) return "An import is in progress.";
  return null;
}

const monthsText = (n: number): string => (n === 1 ? "1 month" : `${n} months`);

/**
 * The note after an import: what was stored, its last month and gap to the cut-off (historySummaryText, so the user
 * sees the gap before attaching it), or that nothing was, with the server's refusals as they stand.
 */
export function importNoteOf(reply: ImportIndexHistoryResult, calibrationDate: string | undefined): { ok: boolean; text: string; refusals: string[] } {
  if (!reply.ok) return { ok: false, text: "The file was not imported.", refusals: reply.refusals };
  const h = reply.history;
  const span = `${monthsText(h.values.length)} from ${h.firstMonth}`;
  const head = reply.created ? `Imported ${reply.id}: ${span}.` : `The store already held this series as ${reply.id}: ${span}.`;
  // B3b follow-up item 6: a daily file that ends before its last month's last weekday stored that day's fixing.
  const p = reply.partialLastMonth;
  const partial = p === undefined ? "" : ` The file ends ${p.lastDay}, before the last weekday of ${p.month}, so the ${p.month} value is that day's fixing, not a month-end one.`;
  return { ok: true, refusals: [], text: `${head} ${historySummaryText(h, calibrationDate)}${partial} A row below points the index at it; preview and save the market to attach it.` };
}

/** The note after Clear the history: the clear is a row of the derivation, applied when the market is saved. */
export function clearNoteOf(indexId: string): { ok: boolean; text: string; refusals: string[] } {
  return { ok: true, refusals: [], text: `A row below clears the history of ${indexId}; preview and save the market to apply it.` };
}

/** One point per month: x the month's place in the series, y the stored decimal as a percent (display only). */
export function historyPoints(h: IndexHistory): Point[] {
  return h.values.map((v, k) => [k, Number((v * 100).toFixed(6))]);
}

export function historyMonthLabel(h: IndexHistory, x: number): string {
  return monthAdd(h.firstMonth, x);
}

/** A tick on each January of a series longer than 36 months, else on every third month from the first. */
export function historyTicks(h: IndexHistory): XTick[] {
  const long = h.values.length > 36;
  const first = monthIndex(h.firstMonth);
  const out: XTick[] = [];
  for (let k = 0; k < h.values.length; k++) {
    if (long ? (first + k) % 12 === 0 : k % 3 === 0) out.push({ value: k, label: historyMonthLabel(h, k) });
  }
  return out;
}

/**
 * The last month and the gap to the cut-off (decision 54). The cut-off month is the market's calibration month; the
 * months between the history's last month and it have no value, and a lag reads them flat (decisions 45 and 49). A
 * history that starts at or after the cut-off serves no month before it (no look-ahead, Task 3 ruling). The cut-off
 * month is read by asOfMonthOf, as the run and the start fill read it, so a malformed date is said, never sliced.
 */
export function historySummaryText(h: IndexHistory, calibrationDate: string | undefined): string {
  const last = historyLastMonth(h);
  const head = `Last month ${last}.`;
  if (calibrationDate === undefined) return `${head} The market carries no calibration date, so the gap to the cut-off is not known.`;
  const cut = asOfMonthOf({ calibrationDate });
  if (cut === null) {
    return `${head} The market's calibration date ${JSON.stringify(calibrationDate)} does not start with a month YYYY-MM, so the gap to the cut-off is not known.`;
  }
  const lead = `${head} The cut-off month is ${cut}:`;
  const displayOnly = "months from the cut-off on are display only.";
  if (monthIndex(h.firstMonth) >= monthIndex(cut)) {
    return `${lead} the history starts ${h.firstMonth}, at or after it, so no month before it has a value and a lag reads them flat; ${displayOnly}`;
  }
  const gap = monthIndex(cut) - monthIndex(last) - 1;
  if (gap > 0) return `${lead} ${gap === 1 ? "1 month before it has no value and a lag reads it flat" : `${gap} months before it have no value and a lag reads them flat`}.`;
  return gap === 0 ? `${lead} every month before it has a value.` : `${lead} every month before it has a value; ${displayOnly}`;
}

/** The fill's note for an index whose draft and stored record name no history (decision 53). */
export const START_FILL_NO_HISTORY = "This index carries no history to fill the start from; import one under History, or type the start value.";

/**
 * The history the index reads once the draft is saved: the last history row of the draft naming it (null when that
 * row clears it), else the chosen market's record. A history row with no id yet names nothing; the request builder
 * blocks it. A set row is not a history row, and a later set-index keeps the id (R2), so it does not count here.
 */
export function historyIdFor(d: RateIndexDraft, source: RateIndexSource, indexId: string): string | null {
  for (let k = d.ops.length - 1; k >= 0; k--) {
    const o = d.ops[k]!;
    if (o.kind === "history" && o.indexId.trim() === indexId && o.historyId !== undefined) return o.historyId;
  }
  return (source.rateIndices ?? []).find((r) => r.id === indexId)?.historyId ?? null;
}

/** Basis points as typed; null for empty; undefined for text that is not a number. */
const bpOf = (text: string | undefined): number | null | undefined => {
  const t = (text ?? "").trim();
  if (t === "") return null;
  const r = readValue(t);
  return "value" in r ? r.value : undefined;
};

/**
 * The start value of a beta index from its own history (decision 53, ruling D2): the cut-off month's fixing minus the
 * typed basis, in basis points, so the index's month 0 (start plus basis) is the published fixing. Only the market's
 * readable as-of month (asOfMonthOf, the month the run reads) reaches the engine; a missing or malformed calibration
 * date is said in its own sentence. The number is written into the Start field and is of record from there: the
 * helper stores nothing, and the user saves the market as usual (the B2 spread-helper pattern).
 */
export function startFillOf(
  h: IndexHistory,
  calibrationDate: string | undefined,
  row: Pick<RateIndexOpDraft, "valueText" | "floorText" | "capText">,
): { startText: string } | { refusal: string } {
  if (calibrationDate === undefined) return { refusal: "The market carries no calibration date, so the cut-off month is not known; type the start value." };
  const month = asOfMonthOf({ calibrationDate });
  if (month === null) {
    return { refusal: `The market's calibration date ${JSON.stringify(calibrationDate)} does not start with a month YYYY-MM, so the cut-off month is not known; type the start value.` };
  }
  // N6: an empty basis is 0, before readValue sees it.
  const basis = bpOf(row.valueText);
  if (basis === undefined) return { refusal: "Enter the basis as a number first; the start is the fixing minus the basis." };
  const basisBp = basis ?? 0;
  const r = startFromHistory(h, month, basisBp);
  if ("refusal" in r) return r;
  // N10: the validator checks start alone against floor and cap (rateIndices.ts:201-202), so a basis can push a fill
  // past them; refuse here with the numbers rather than write a start the save would refuse. A floor or cap that is
  // not a number is not checked here; the request builder blocks it.
  const fixingBp = Number((r.startBp + basisBp).toPrecision(12));
  const why = `The fill would write a start of ${r.startBp} bp (the history's ${fixingBp} bp at ${month} less the ${basisBp} bp basis)`;
  const tail = "; the market checks the start alone against its floor and cap and would be refused, so type the start value or change the basis.";
  const floor = bpOf(row.floorText);
  const cap = bpOf(row.capText);
  if (typeof floor === "number" && r.startBp < floor) return { refusal: `${why}, below the floor of ${floor} bp${tail}` };
  if (typeof cap === "number" && r.startBp > cap) return { refusal: `${why}, above the cap of ${cap} bp${tail}` };
  return { startText: String(r.startBp) };
}

/**
 * The history a fill reads for the index typed on the row, or why there is none, before any read: an empty id, an id
 * the chosen market does not carry and no draft row points at a history, or an index with no history.
 */
export function startFillSourceOf(d: RateIndexDraft, source: RateIndexSource, indexId: string): { historyId: string } | { refusal: string } {
  const id = indexId.trim();
  if (id === "") return { refusal: "Enter the index id first; the fill reads that index's own history." };
  const historyId = historyIdFor(d, source, id);
  if (historyId !== null) return { historyId };
  if (!(source.rateIndices ?? []).some((r) => r.id === id)) {
    return { refusal: `The market does not carry ${JSON.stringify(id)} yet, so it has no history to read; save the market with the index, then import its history under History, or type the start value.` };
  }
  return { refusal: START_FILL_NO_HISTORY };
}

/** A fill with what it read, for the row's note: the history id and the cut-off month. */
export type StartFill = { startText: string; historyId: string; month: string } | { refusal: string };

/** startFillOf on a history read by id, carrying the id and the cut-off month a landed fill names. */
export function startFillFor(
  h: IndexHistory, historyId: string, calibrationDate: string | undefined, row: Pick<RateIndexOpDraft, "valueText" | "floorText" | "capText">,
): StartFill {
  const r = startFillOf(h, calibrationDate, row);
  // A fill exists only for a readable as-of month, so asOfMonthOf is not null here.
  return "refusal" in r ? r : { startText: r.startText, historyId, month: asOfMonthOf({ calibrationDate }) ?? "" };
}

export const START_FILL_RACE = "The row changed while its history was read; nothing was replaced.";

/** The fields a fill reads or writes: the row as sent must still stand when the history lands. */
export type StartFillSent = Pick<RateIndexOpDraft, "indexId" | "valueText" | "startText" | "floorText" | "capText" | "form">;
const SENT_FIELDS = ["indexId", "valueText", "startText", "floorText", "capText", "form"] as const;

/**
 * A fill landing on the draft as it stands now (the B2 spread-helper race rule): a row removed, or edited in any field
 * the fill reads or writes since the click, is left alone and the note says so, since a start against an old basis
 * would break ruling D2 and a floor or cap typed meanwhile was never checked (N10). Otherwise the fill writes the
 * start and names its source, or the refusal is the note.
 */
export function startFillLanding(d: RateIndexDraft, rowKey: number, sent: StartFillSent, fill: StartFill): { draft: RateIndexDraft; note: string } {
  const now = d.ops.find((o) => o.key === rowKey);
  if (now === undefined || SENT_FIELDS.some((f) => (now[f] ?? "") !== (sent[f] ?? ""))) return { draft: d, note: START_FILL_RACE };
  if ("refusal" in fill) return { draft: d, note: fill.refusal };
  return { draft: setRateIndexOpField(d, rowKey, { startText: fill.startText }), note: `Filled from ${fill.historyId} at ${fill.month}.` };
}

/**
 * A fill landing through the page's draft update (B3b follow-up item 3). `update` hands the landing to a functional
 * state update that runs before it returns (the page wraps setDraft in flushSync), so the landing reads the draft as
 * it stands at the write, a keystroke queued after the last render included, and the note is decided in that same
 * update: "Filled from" only when the draft changed. An update that never ran claims no fill.
 */
export function landStartFill(
  update: (fn: (d: RateIndexDraft) => RateIndexDraft) => void, rowKey: number, sent: StartFillSent, fill: StartFill,
): { changed: boolean; note: string } {
  let out: { changed: boolean; note: string } = { changed: false, note: START_FILL_RACE };
  update((d) => {
    const landed = startFillLanding(d, rowKey, sent, fill);
    out = { changed: landed.draft !== d, note: landed.note };
    return landed.draft;
  });
  return out;
}
