// apps/studio/src/__tests__/macroFactorsPage.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAssumptionSets } from "@alm/reader";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readersText, vintageText } from "../market/macroModel";
import { LAYERS } from "../router";
import { MACRO_COPY, MacroFactorsView, uploadNoteOf } from "../pages/market/MacroFactorsPage";

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("Macro factors layer (A10)", () => {
  it("no layer is Soon", () => { expect(LAYERS.filter((l) => l.status === "soon")).toEqual([]); });
  it("renders the table, the gap note and the readers card", () => {
    const html = renderToStaticMarkup(<MacroFactorsView markets={[]} chosen={null} chosenNote={null} readers={[]} draft={{ marketId: null, id: "", label: "", valuesText: "" }} preview={null} note={null} busy={null} onMarket={() => {}} onDraft={() => {}} onPreview={() => {}} onSave={() => {}} onUploadError={() => {}} />);
    // React writes ">" and "'" as entities; the intro names Market > Yield curves and a run setup's Market.
    expect(html.replace(/&gt;/g, ">").replace(/&#x27;/g, "'")).toContain(MACRO_COPY.intro);
    expect(MACRO_COPY.intro.endsWith("Nothing runs here: a saved market is attached on Market > Yield curves and named as a run setup's Market on Run > Setups.")).toBe(true);
    expect(html).toContain(MACRO_COPY.unemployment);
    expect(html).toContain(MACRO_COPY.projection);
  });
  it("renders a chosen market's series with its source record and the gap note", () => {
    const un = { id: "unrate", label: "Civilian unemployment rate (BLS via FRED)", kind: "rate", role: "history", unit: "decimal",
      firstMonth: "2025-09", values: [0.044, null, 0.045, 0.045, 0.044, 0.044, 0.043],
      source: { seriesId: "UNRATE", provider: "BLS via FRED", url: "u", retrievedOn: "2026-10-08", vintage: "FRED as retrieved 2026-10-08, revised, not point-in-time", endMonth: "2026-03", rawFileSha256: "a".repeat(64), knownGaps: ["2025-10"] } };
    const html = renderToStaticMarkup(<MacroFactorsView markets={[]} chosen={{ id: "macro-demo-v1", source: { macroFactors: [un as never], calibrationDate: "2026-03-31" } }} chosenNote={null} readers={[]} draft={{ marketId: "macro-demo-v1", id: "", label: "", valuesText: "" }} preview={null} note={null} busy={null} onMarket={() => {}} onDraft={() => {}} onPreview={() => {}} onSave={() => {}} onUploadError={() => {}} />);
    expect(html).toContain("Not published by the provider: 2025-10");
    expect(html).toContain("BLS via FRED, series UNRATE, retrieved 2026-10-08, FRED as retrieved 2026-10-08, revised, not point-in-time");
    expect(html).toContain(MACRO_COPY.gap);
    // mfu-3, final-review Minor 4: the About card's vintage line reads the source record's retrievedOn.
    expect(html).toContain("The histories are the vintage retrieved on 2026-10-08, revised since first release, not point-in-time at the as-of.");
  });
  it("the vintage line reads retrievedOn from the source records; with no history it names no date (mfu-3)", () => {
    const hist = (retrievedOn: string) => ({ id: "h", label: "h", kind: "rate", role: "history", unit: "decimal", firstMonth: "2026-01", values: [0.04],
      source: { seriesId: "X", provider: "p", url: "u", retrievedOn, vintage: "v", endMonth: "2026-01", rawFileSha256: "a".repeat(64), knownGaps: [] } }) as never;
    const proj = { id: "p", label: "p", kind: "index", role: "projection", unit: "r", firstMonth: "2026-04", values: [1], source: { authored: true, note: "n" } } as never;
    expect(vintageText([hist("2026-10-08")])).toBe("The histories are the vintage retrieved on 2026-10-08, revised since first release, not point-in-time at the as-of.");
    expect(vintageText([hist("2026-10-08"), hist("2026-10-08"), hist("2026-11-02"), proj])).toBe("The histories are the vintage retrieved on 2026-10-08 and 2026-11-02, revised since first release, not point-in-time at the as-of.");
    // Re-expectation (mfu-3 fix 1): with no history shown the line names no history; a projection carries no vintage.
    const none = "A history is the vintage named in each history's source record, revised since first release, not point-in-time at the as-of.";
    expect(MACRO_COPY.vintage).toBe(none);
    expect(vintageText([proj])).toBe(none);
    expect(vintageText([])).toBe(none);
    expect(MACRO_COPY.vintage).not.toMatch(/\d/);
    expect(MACRO_COPY.vintage.startsWith("The histories are")).toBe(false);
    const html = renderToStaticMarkup(<MacroFactorsView markets={[]} chosen={null} chosenNote={null} readers={[]} draft={{ marketId: null, id: "", label: "", valuesText: "" }} preview={null} note={null} busy={null} onMarket={() => {}} onDraft={() => {}} onPreview={() => {}} onSave={() => {}} onUploadError={() => {}} />);
    expect(html).toContain("A history is the vintage named in each history&#x27;s source record, revised since first release, not point-in-time at the as-of.");
    expect(html).not.toContain("The histories are");
  });
  it("an upload whose read fails sets the page note instead of an unhandled rejection (Slice 1 M7, mfu-3)", () => {
    expect(uploadNoteOf(new Error("NotReadableError"))).toEqual({ kind: "error", text: "The file was not read: NotReadableError", problems: [], savedId: null });
    expect(uploadNoteOf("gone")).toEqual({ kind: "error", text: "The file was not read: gone", problems: [], savedId: null });
    const src = SRC("../pages/market/MacroFactorsPage.tsx");
    expect(src).toContain("void f.text().then((t) => p.onDraft({ valuesText: t })).catch((err: unknown) => p.onUploadError(err));");
    expect(src).toContain("onUploadError={(err) => { setShown(null); setNote(uploadNoteOf(err)); }}");
  });
  it("a mapped set from the assumption-set listing appears on the readers card", async () => {
    // The listing as the server sends it (macroBindings on a mapped row); a synthetic mapped set.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { id: "demo-behavioral-v1", label: "Demo", contentHash: "h1" },
      { id: "housing-synthetic", label: "Synthetic", contentHash: "h2", macroBindings: [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }] },
    ]), { status: 200, headers: { "content-type": "application/json" } })));
    const readers = readersText(await listAssumptionSets());
    const html = renderToStaticMarkup(<MacroFactorsView markets={[]} chosen={null} chosenNote={null} readers={readers} draft={{ marketId: null, id: "", label: "", valuesText: "" }} preview={null} note={null} busy={null} onMarket={() => {}} onDraft={() => {}} onPreview={() => {}} onSave={() => {}} onUploadError={() => {}} />);
    expect(html).toContain("housing-synthetic maps hpi-down-30 to mbs (house-price response)");
    expect(html).not.toContain("demo-behavioral-v1 maps");
  });
});
afterEach(() => vi.unstubAllGlobals());
