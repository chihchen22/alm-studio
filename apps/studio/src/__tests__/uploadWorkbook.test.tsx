/**
 * Studio follow-up F1: the market workbook upload card on Market > Yield curves. Studio tests have no DOM: the card is a
 * pure view plus one async function that makes the call, so the sentences are read off the server render and the call
 * is read off a stubbed fetch. Every expected sentence, URL and header is restated here by hand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceManifest } from "@alm/reader";
import { MarketPage } from "../pages/market/MarketPage";
import { UploadWorkbook, UploadWorkbookView, asOfProblem, importWorkbook, outcomeOnAttach, stampSentence, uploadBlock, uploadWritable, type UploadOutcome } from "../pages/market/UploadWorkbook";
import { HEAD } from "./fixtures/workspace";

const BLANK: WorkspaceManifest = {
  ...HEAD,
  id: "ws-blank",
  revision: 3,
  blocks: { ...HEAD.blocks, market: { ...HEAD.blocks.market, snapshot: null, derived: [] } },
};
const LOCKED: WorkspaceManifest = { ...BLANK, status: "locked", lock: { lockedAt: "2026-10-08T10:00:00.000Z", by: "ALM", approvalId: "ap-1", signedHash: "sh-1" } };

const calls: Array<{ url: string; init?: RequestInit }> = [];
function stub(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const FILE = { name: "market_20260331.xlsx", arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer };

describe("the card on Market", () => {
  it("is on Yield curves and its spreads view when the head is writable, under the attach control", () => {
    for (const section of ["curves", "spreads"] as const) {
      const html = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section={section} head={BLANK} onChanged={() => {}} />);
      expect(html).toContain("Import a market workbook into this workspace");
      expect(html.indexOf("Reading the stored market snapshots")).toBeLessThan(html.indexOf("Import a market workbook into this workspace"));
    }
  });
  it("is not on Volatility surfaces, on a locked head or without a head", () => {
    const vols = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section="vols" head={BLANK} onChanged={() => {}} />);
    expect(vols).not.toContain("Import a market workbook into this workspace");
    const locked = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section="curves" head={LOCKED} onChanged={() => {}} />);
    expect(locked).not.toContain("Import a market workbook into this workspace");
    const none = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section="curves" />);
    expect(none).not.toContain("Import a market workbook into this workspace");
  });
  it("the blank-workspace sentence now offers the workbook as well as a stored snapshot", () => {
    const html = renderToStaticMarkup(<MarketPage ws="ws-blank" marketId={null} query={{}} section="curves" head={BLANK} onChanged={() => {}} />);
    expect(html).toContain("No market snapshot is attached to this workspace. Attach a stored snapshot or import a workbook below.");
  });
  it("writable means active with no lock; locked, archived and superseded heads are not", () => {
    expect(uploadWritable(BLANK)).toBe(true);
    expect(uploadWritable(LOCKED)).toBe(false);
    expect(uploadWritable({ ...BLANK, status: "archived" })).toBe(false);
    expect(uploadWritable({ ...BLANK, status: "superseded" })).toBe(false);
    expect(uploadWritable({ ...BLANK, lock: LOCKED.lock })).toBe(false);
  });
});

describe("the button and its reason", () => {
  const view = (over: Partial<Parameters<typeof UploadWorkbookView>[0]> = {}) =>
    renderToStaticMarkup(
      <UploadWorkbookView file={null} asOf="" by="Chih" busy={false} outcome={null} onFile={() => {}} onAsOf={() => {}} id="" onId={() => {}} onBy={() => {}} onImport={() => {}} {...over} />,
    );
  it("prints the card's words: title, the date check, the two fields and the button", () => {
    const html = view();
    expect(html).toContain("Import a market workbook into this workspace");
    expect(html).toContain("The server checks the workbook&#x27;s calibration date against the workspace cut-off before it stores anything.");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".xlsx"');
    expect(html).toContain("As-of date (only if the filename has no _YYYYMMDD suffix)");
    expect(html).toContain(">Import and attach</button>");
  });
  it("is off with its reason until a file is chosen", () => {
    expect(uploadBlock({ file: null, by: "Chih", busy: false })).toBe("Choose a .xlsx workbook first.");
    const html = view();
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Choose a .xlsx workbook first.");
  });
  it("is off with its reason until a name is typed, and while busy", () => {
    expect(uploadBlock({ file: "m.xlsx", by: "  ", busy: false })).toBe("Type your name first; the server records who attached the snapshot.");
    expect(uploadBlock({ file: "m.xlsx", by: "Chih", busy: true })).toBe("An import is in progress.");
    expect(uploadBlock({ file: "m.xlsx", by: "Chih", busy: false })).toBeNull();
    expect(view({ file: "m.xlsx", busy: true })).toContain("An import is in progress.");
  });
  it("is on, with no reason line, once a file and a name are given", () => {
    const html = view({ file: "market_20260331.xlsx" });
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain("Choose a .xlsx workbook first.");
    expect(html).toContain("market_20260331.xlsx");
  });
});

describe("the as-of date", () => {
  it("accepts nothing (the filename then decides) or a real YYYY-MM-DD date, and refuses anything else in words", () => {
    expect(asOfProblem("")).toBeNull();
    expect(asOfProblem("  ")).toBeNull();
    expect(asOfProblem("2026-03-31")).toBeNull();
    const words = "Write the as-of date as YYYY-MM-DD, for example 2026-03-31.";
    for (const bad of ["03/31/2026", "20260331", "2026-3-31", "2026-02-30", "2026-13-01", "tomorrow"]) expect(asOfProblem(bad)).toBe(words);
  });
  it("a bad string is refused in the browser and no request is made", async () => {
    stub(201, {});
    const onChanged = vi.fn();
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "03/31/2026", by: "Chih", onChanged });
    expect(out).toEqual({ kind: "invalid", message: "Write the as-of date as YYYY-MM-DD, for example 2026-03-31." });
    expect(calls).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("the call", () => {
  it("posts the bytes with the filename, the workspace and the typed name; an empty as-of is not sent", async () => {
    stub(201, { id: "market_20260331", summary: { calibrationDate: "2026-03-31" }, workspace: { id: "ws-blank", revision: 4, clash: false } });
    await importWorkbook({ head: BLANK, file: FILE, asOf: "", by: " Chih Chen ", onChanged: () => {} });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih%20Chen");
    expect(calls[0].init!.method).toBe("POST");
    expect((calls[0].init!.headers as Record<string, string>)["X-Filename"]).toBe("market_20260331.xlsx");
    expect((calls[0].init!.body as ArrayBuffer).byteLength).toBe(4);
  });
  it("sends a given as-of date as the fallback", async () => {
    stub(201, { id: "m", summary: { calibrationDate: "2026-03-31" }, workspace: { id: "ws-blank", revision: 4, clash: false } });
    await importWorkbook({ head: BLANK, file: { ...FILE, name: "market.xlsx" }, asOf: "2026-03-31", by: "Chih", onChanged: () => {} });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih&asOf=2026-03-31");
  });
  it("on success prints the id and the calibration date, and re-reads the head once", async () => {
    stub(201, { id: "market_20260331", summary: { calibrationDate: "2026-03-31" }, workspace: { id: "ws-blank", revision: 4, clash: false } });
    const onChanged = vi.fn();
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "", by: "Chih", onChanged });
    expect(out.kind).toBe("ok");
    expect(onChanged).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(
      <UploadWorkbookView file={null} asOf="" by="Chih" busy={false} outcome={out} onFile={() => {}} onAsOf={() => {}} id="" onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html).toContain("Imported market_20260331 and attached it. Calibration date 2026-03-31.");
    expect(html).not.toContain('role="alert"');
  });
  it("a date that differs from a test workspace's cut-off is attached and the line says the server recorded a warning", async () => {
    stub(201, { id: "m", summary: { calibrationDate: "2026-02-28" }, workspace: { id: "ws-blank", revision: 4, clash: true } });
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "", by: "Chih", onChanged: () => {} });
    expect(out).toMatchObject({ kind: "ok", note: "Imported m and attached it. Calibration date 2026-02-28. The date differs from the workspace cut-off; the server recorded a warning." });
  });
  it("a 422 refusal prints the server's text verbatim in an alert line and does not re-read the head", async () => {
    const text = 'market snapshot "market_20260228" is dated 2026-02-28, but workspace "ws-blank" is Production with cut-off 2026-03-31; a Production workspace holds only documents dated at its cut-off.';
    stub(422, { error: { code: "validation", message: text, detail: { field: "asOf" } } });
    const onChanged = vi.fn();
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "", by: "Chih", onChanged });
    expect(out.kind).toBe("refused");
    expect(onChanged).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(
      <UploadWorkbookView file={null} asOf="" by="Chih" busy={false} outcome={out} onFile={() => {}} onAsOf={() => {}} id="" onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(text.replace(/"/g, "&quot;"));
    expect(html).not.toContain("<li>");
  });
  it("a rejected workbook lists its errors, ten at most, then says how many more", async () => {
    const detail = Array.from({ length: 13 }, (_, i) => ({ message: `sheet error number ${i + 1}` }));
    stub(422, { error: { code: "validation", message: "market workbook rejected: 13 error(s)", detail } });
    const out: UploadOutcome = await importWorkbook({ head: BLANK, file: FILE, asOf: "", by: "Chih", onChanged: () => {} });
    const html = renderToStaticMarkup(
      <UploadWorkbookView file={null} asOf="" by="Chih" busy={false} outcome={out} onFile={() => {}} onAsOf={() => {}} id="" onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html).toContain("market workbook rejected: 13 error(s)");
    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).toContain("sheet error number 1<");
    expect(html).toContain("sheet error number 10<");
    expect(html).not.toContain("sheet error number 11");
    expect(html).toContain("and 3 more");
  });
  it("exactly ten errors print all ten and no 'more' line", async () => {
    const detail = Array.from({ length: 10 }, (_, i) => ({ message: `e${i + 1}` }));
    stub(422, { error: { code: "validation", message: "market workbook rejected: 10 error(s)", detail } });
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "", by: "Chih", onChanged: () => {} });
    const html = renderToStaticMarkup(
      <UploadWorkbookView file={null} asOf="" by="Chih" busy={false} outcome={out} onFile={() => {}} onAsOf={() => {}} id="" onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).not.toContain(" more");
  });
  it("a platform that cannot be reached prints the reason alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "", by: "Chih", onChanged: () => {} });
    expect(out).toEqual({ kind: "refused", message: "The platform could not be reached. Is it running?", items: [], more: 0 });
  });
});

describe("the stamp date", () => {
  const view = (file: string | null, asOf = "") =>
    renderToStaticMarkup(
      <UploadWorkbookView file={file} asOf={asOf} id="" by="Chih" busy={false} outcome={null} onFile={() => {}} onAsOf={() => {}} onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
  it("the sentence names the date the filename gives, or says the as-of date below is used", () => {
    expect(stampSentence("market_20260331.xlsx")).toBe("The snapshot will be stamped 2026-03-31.");
    expect(stampSentence("market.xlsx")).toBe("The filename has no date; the as-of date below is used.");
    expect(stampSentence(null)).toBeNull();
  });
  it("a date anywhere in the name is the date the server stamps, so the sentence names it", () => {
    expect(stampSentence("x_20260331_v2.xlsx")).toBe("The snapshot will be stamped 2026-03-31.");
  });
  it("an impossible date in the suffix is named as a problem, not passed off as no date", () => {
    const bad = "The date in the filename (2026-13-31) is not a real date. Rename the file.";
    expect(stampSentence("x_20261331.xlsx")).toBe(bad);
    expect(stampSentence("a_20260331_b_20261301.xlsx")).toBe("The date in the filename (2026-13-01) is not a real date. Rename the file.");
    expect(stampSentence("x_20260230.xlsx")).toBe("The snapshot will be stamped 2026-02-30.");
    expect(stampSentence("x_20260331_v2.xlsx")).toBe("The snapshot will be stamped 2026-03-31.");
    expect(stampSentence("x.xlsx")).toBe("The filename has no date; the as-of date below is used.");
    const html = view("x_20261331.xlsx");
    expect(html).toContain(bad);
    expect(html).not.toContain("will be stamped");
    expect(html).not.toContain("The filename has no date");
  });
  it("prints under the file field once a file is chosen, and not before", () => {
    expect(view("market_20260331.xlsx")).toContain("The snapshot will be stamped 2026-03-31.");
    expect(view("market.xlsx")).toContain("The filename has no date; the as-of date below is used.");
    expect(view(null)).not.toContain("will be stamped");
    expect(view(null)).not.toContain("The filename has no date");
  });
});

describe("the import note after another snapshot is attached", () => {
  const ok: UploadOutcome = { kind: "ok", id: "market_20260331", calibrationDate: "2026-03-31", note: "Imported market_20260331 and attached it. Calibration date 2026-03-31." };
  it("is cleared when the attached id moves to a snapshot the note does not name, from the Attach control or with none left", () => {
    expect(outcomeOnAttach(ok, "market_other")).toBeNull();
    expect(outcomeOnAttach(ok, null)).toBeNull();
  });
  it("still shows after the person's own import, which moves the attached id to the imported one", () => {
    expect(outcomeOnAttach(ok, "market_20260331")).toBe(ok);
  });
  it("leaves no outcome and a refusal that is not about the attached snapshot as they are", () => {
    const refused: UploadOutcome = { kind: "refused", message: "409: x", items: [], more: 0 };
    expect(outcomeOnAttach(null, "market_other")).toBeNull();
    expect(outcomeOnAttach(refused, "market_other")).toBe(refused);
  });
  const text = (id: string) => `market "${id}" already exists; the store is append-only; import under a new id instead of overwriting`;
  it("clears the already-attached refusal once another snapshot, or none, is attached; keeps it while that snapshot stays attached", async () => {
    const attachedId = HEAD.blocks.market.snapshot!.id;
    stub(409, { error: { code: "conflict", message: text(attachedId) } });
    const same = await importWorkbook({ head: HEAD, file: FILE, asOf: "", id: "", by: "Chih", onChanged: () => {} });
    expect(same).toMatchObject({ kind: "refused", message: "That snapshot id is already stored and is the one attached to this workspace. Import under a new id to replace it." });
    expect(outcomeOnAttach(same, "market_other")).toBeNull();
    expect(outcomeOnAttach(same, null)).toBeNull();
    expect(outcomeOnAttach(same, attachedId)).toBe(same);
  });
  it("keeps the id-already-stored refusal for another stored snapshot, and a server refusal, after an attach", async () => {
    stub(409, { error: { code: "conflict", message: text("market_other") } });
    const taken = await importWorkbook({ head: HEAD, file: FILE, asOf: "", id: "", by: "Chih", onChanged: () => {} });
    expect(taken).toMatchObject({ kind: "refused", message: "That snapshot id is already stored. Pick it under Attach a stored snapshot, or import under a new id." });
    expect(outcomeOnAttach(taken, "market_third")).toBe(taken);
    stub(422, { error: { code: "validation", message: "market workbook rejected", detail: [{ message: "e1" }] } });
    const rejected = await importWorkbook({ head: HEAD, file: FILE, asOf: "", id: "", by: "Chih", onChanged: () => {} });
    expect(outcomeOnAttach(rejected, "market_other")).toBe(rejected);
  });
});

describe("the as-of preset", () => {
  it("the as-of input starts at the workspace cut-off", () => {
    const html = renderToStaticMarkup(<UploadWorkbook head={BLANK} onChanged={() => {}} />);
    expect(html).toMatch(/aria-label="As-of date"[^>]*value="2026-03-31"|value="2026-03-31"[^>]*aria-label="As-of date"/);
  });
});

describe("the snapshot id", () => {
  it("has its own input on the card", () => {
    const html = renderToStaticMarkup(
      <UploadWorkbookView file={null} asOf="" id="" by="Chih" busy={false} outcome={null} onFile={() => {}} onAsOf={() => {}} onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html).toContain("Snapshot id");
    expect(html).toContain('aria-label="Snapshot id"');
  });
  it("is sent only when typed, trimmed", async () => {
    stub(201, { id: "q1", summary: { calibrationDate: "2026-03-31" }, workspace: { id: "ws-blank", revision: 4, clash: false } });
    await importWorkbook({ head: BLANK, file: FILE, asOf: "", id: "", by: "Chih", onChanged: () => {} });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih");
    await importWorkbook({ head: BLANK, file: FILE, asOf: "", id: "  q1-final ", by: "Chih", onChanged: () => {} });
    expect(calls[1].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih&id=q1-final");
  });
  it("a 409 for an id that is already stored says so and says what to do, then prints the server's own sentence", async () => {
    const server = 'market "market_20260331" already exists; the store is append-only; import under a new id instead of overwriting';
    stub(409, { error: { code: "conflict", message: server } });
    const onChanged = vi.fn();
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "", id: "", by: "Chih", onChanged });
    expect(out).toMatchObject({
      kind: "refused",
      message: "That snapshot id is already stored. Pick it under Attach a stored snapshot, or import under a new id.",
      follow: `409: ${server}`,
    });
    expect(onChanged).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(
      <UploadWorkbookView file={null} asOf="" id="" by="Chih" busy={false} outcome={out} onFile={() => {}} onAsOf={() => {}} onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html).toContain("That snapshot id is already stored. Pick it under Attach a stored snapshot, or import under a new id.");
    expect(html).toContain(server.replace(/"/g, "&quot;"));
  });
  it("a 409 for the id of the snapshot already attached to this workspace says so and says how to replace it; another id keeps the first sentence", async () => {
    const attachedId = HEAD.blocks.market.snapshot!.id;
    const text = (id: string) => `market "${id}" already exists; the store is append-only; import under a new id instead of overwriting`;
    stub(409, { error: { code: "conflict", message: text(attachedId) } });
    const same = await importWorkbook({ head: HEAD, file: FILE, asOf: "", id: "", by: "Chih", onChanged: () => {} });
    expect(same).toMatchObject({
      kind: "refused",
      message: "That snapshot id is already stored and is the one attached to this workspace. Import under a new id to replace it.",
      follow: `409: ${text(attachedId)}`,
    });
    stub(409, { error: { code: "conflict", message: text("market_other") } });
    const other = await importWorkbook({ head: HEAD, file: FILE, asOf: "", id: "", by: "Chih", onChanged: () => {} });
    expect(other).toMatchObject({
      kind: "refused",
      message: "That snapshot id is already stored. Pick it under Attach a stored snapshot, or import under a new id.",
    });
  });
  it("a 409 that is not an existing id keeps the server's text alone", async () => {
    stub(409, { error: { code: "revision-conflict", message: "workspace \"ws-blank\" is at revision 5, not 4" } });
    const out = await importWorkbook({ head: BLANK, file: FILE, asOf: "", id: "", by: "Chih", onChanged: () => {} });
    expect(out).toMatchObject({ kind: "refused", message: '409: workspace "ws-blank" is at revision 5, not 4' });
  });
});

describe("the as-of date is sent only when the filename has no date", () => {
  const ok = { id: "m", summary: { calibrationDate: "2026-03-31" }, workspace: { id: "ws-blank", revision: 4, clash: false } };
  it("a suffix date wins: the preset cut-off is not sent", async () => {
    stub(201, ok);
    await importWorkbook({ head: BLANK, file: FILE, asOf: "2026-03-31", id: "", by: "Chih", onChanged: () => {} });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih");
  });
  it("a date elsewhere in the name is the route's to find: the preset cut-off is not sent over it", async () => {
    stub(201, ok);
    await importWorkbook({ head: BLANK, file: { ...FILE, name: "market_20260228_v2.xlsx" }, asOf: "2026-03-31", id: "", by: "Chih", onChanged: () => {} });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih");
  });
  it("no date in the name: the as-of date is sent", async () => {
    stub(201, ok);
    await importWorkbook({ head: BLANK, file: { ...FILE, name: "market.xlsx" }, asOf: "2026-03-31", id: "", by: "Chih", onChanged: () => {} });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih&asOf=2026-03-31");
  });
});

describe("an impossible date in the filename", () => {
  const BAD = { ...FILE, name: "x_20261331.xlsx" };
  const reason = "The date in the filename (2026-13-31) is not a real date. Rename the file.";
  it("blocks the button with the same sentence, after the missing-file reason and before the name", () => {
    expect(uploadBlock({ file: null, by: "Chih", busy: false })).toBe("Choose a .xlsx workbook first.");
    expect(uploadBlock({ file: "x_20261331.xlsx", by: "Chih", busy: false })).toBe(reason);
    expect(uploadBlock({ file: "x_20261331.xlsx", by: "  ", busy: false })).toBe(reason);
    expect(uploadBlock({ file: "x_20261331.xlsx", by: "Chih", busy: true })).toBe("An import is in progress.");
    expect(uploadBlock({ file: "x_20260230.xlsx", by: "Chih", busy: false })).toBeNull();
  });
  it("shows the reason beside a button that is off", () => {
    const html = renderToStaticMarkup(
      <UploadWorkbookView file="x_20261331.xlsx" asOf="2026-03-31" id="" by="Chih" busy={false} outcome={null} onFile={() => {}} onAsOf={() => {}} onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html.split(reason).length - 1).toBe(1);
  });
  it("prints the sentence once, under the file field, and the off button points at it", () => {
    const html = renderToStaticMarkup(
      <UploadWorkbookView file="x_20261331.xlsx" asOf="2026-03-31" id="" by="Chih" busy={false} outcome={null} onFile={() => {}} onAsOf={() => {}} onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html.indexOf(reason)).toBeLessThan(html.indexOf(">Import and attach</button>"));
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeDefined();
    expect(html).toContain(`id="${described}" role="status">${reason}<`);
  });
  it("a busy card with a bad filename still prints both lines: the date under the field and the busy reason by the button", () => {
    const html = renderToStaticMarkup(
      <UploadWorkbookView file="x_20261331.xlsx" asOf="" id="" by="Chih" busy={true} outcome={null} onFile={() => {}} onAsOf={() => {}} onId={() => {}} onBy={() => {}} onImport={() => {}} />,
    );
    expect(html.split(reason).length - 1).toBe(1);
    expect(html).toContain("An import is in progress.");
  });
  it("makes no request and sends no as-of text if the call is made anyway", async () => {
    stub(201, {});
    const onChanged = vi.fn();
    const out = await importWorkbook({ head: BLANK, file: BAD, asOf: "2026-03-31", id: "", by: "Chih", onChanged });
    expect(out).toEqual({ kind: "invalid", message: reason });
    expect(calls).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("a name with two dates whose last is bad makes no request either", async () => {
    stub(201, {});
    const out = await importWorkbook({ head: BLANK, file: { ...FILE, name: "a_20260331_b_20261301.xlsx" }, asOf: "2026-03-31", by: "Chih", onChanged: () => {} });
    expect(out.kind).toBe("invalid");
    expect(calls).toHaveLength(0);
  });
  it("Feb 30 is still sent as a good date: no as-of text goes with it", async () => {
    stub(201, { id: "m", summary: { calibrationDate: "2026-02-30" }, workspace: { id: "ws-blank", revision: 4, clash: false } });
    await importWorkbook({ head: BLANK, file: { ...FILE, name: "x_20260230.xlsx" }, asOf: "2026-03-31", id: "", by: "Chih", onChanged: () => {} });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws-blank&by=Chih");
  });
});
