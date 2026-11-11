// packages/reader/src/__tests__/indexHistoryApi.test.ts
// The reader client of the index history routes. Paths, headers and statuses are
// restated by hand from apps/server/src/http/routes/indexHistories.ts; none is read back from the code under
// test. A refused file (422 with a `refusals` list) is data; every other failure is an ApiError.
import type { IndexHistory } from "@alm/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { getIndexHistory, importIndexHistory, type ImportIndexHistoryResult } from "../api/indexHistories";

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mock(status = 200, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const last = () => calls.at(-1)!;

const HISTORY: IndexHistory = {
  label: "One-month",
  firstMonth: "2026-01",
  values: [0.0431, 0.0434],
  source: { fileName: "m.csv", fileSha256: "a".repeat(64), format: "csv", frequency: "monthly", rows: 2, unit: "percent" },
};
const BYTES = new TextEncoder().encode("2026-01,4.31\n2026-02,4.34\n").buffer as ArrayBuffer;

describe("reader index history api", () => {
  it("importIndexHistory posts the raw bytes with X-Filename, the unit and the label; a 201 is { ok: true, id, created, history }", async () => {
    mock(201, { id: "ih-0123456789abcdef", created: true, history: HISTORY });
    const got = await importIndexHistory(BYTES, "m.csv", { unit: "percent", label: "One-month" });
    expect(last().url).toBe("/api/index-histories/import?unit=percent&label=One-month");
    expect(last().init?.method).toBe("POST");
    expect(last().init?.headers).toEqual({ "content-type": "application/octet-stream", "X-Filename": "m.csv" });
    expect(last().init?.body).toBe(BYTES);
    const expected: ImportIndexHistoryResult = { ok: true, id: "ih-0123456789abcdef", created: true, history: HISTORY };
    expect(got).toEqual(expected);
  });

  it("a 200 for content already stored is created false; no label leaves the label out of the query", async () => {
    mock(200, { id: "ih-0123456789abcdef", created: false, history: HISTORY });
    const got = await importIndexHistory(BYTES, "m.csv", { unit: "decimal" });
    expect(last().url).toBe("/api/index-histories/import?unit=decimal");
    expect(got).toEqual({ ok: true, id: "ih-0123456789abcdef", created: false, history: HISTORY });
  });

  it("a reply that flags a partial last month passes the flag through; none is added when the reply has none (B3b follow-up item 6)", async () => {
    mock(201, { id: "ih-0123456789abcdef", created: true, history: HISTORY, partialLastMonth: { month: "2026-02", lastDay: "2026-02-13" } });
    expect(await importIndexHistory(BYTES, "m.csv", { unit: "percent" })).toEqual({
      ok: true, id: "ih-0123456789abcdef", created: true, history: HISTORY, partialLastMonth: { month: "2026-02", lastDay: "2026-02-13" },
    });
    mock(201, { id: "ih-0123456789abcdef", created: true, history: HISTORY });
    expect("partialLastMonth" in (await importIndexHistory(BYTES, "m.csv", { unit: "percent" }))).toBe(false);
  });

  it("a 422 carrying refusals returns them as data, never throws", async () => {
    const refusals = ["row 2: value 4.3 is above 1.0, which a decimal rate cannot be; if the file is in percent, import it with the unit percent"];
    mock(422, { error: { code: "validation", message: refusals.join("; "), detail: { refusals } }, refusals });
    expect(await importIndexHistory(BYTES, "m.csv", { unit: "decimal" })).toEqual({ ok: false, refusals });
  });

  it("any other failure throws ApiError: a 400, and a 422 with no refusals", async () => {
    mock(400, { error: { code: "bad-request", message: "missing X-Filename header (the history file's original name)" } });
    const e400 = await importIndexHistory(BYTES, "", { unit: "percent" }).catch((e: unknown) => e);
    expect(e400).toBeInstanceOf(ApiError);
    expect((e400 as ApiError).status).toBe(400);
    mock(422, { error: { code: "validation", message: "x" } });
    const e422 = await importIndexHistory(BYTES, "m.csv", { unit: "percent" }).catch((e: unknown) => e);
    expect(e422).toBeInstanceOf(ApiError);
    expect((e422 as ApiError).status).toBe(422);
  });

  it("getIndexHistory GETs /api/index-histories/:id and returns the document verbatim; a 404 throws ApiError", async () => {
    mock(200, HISTORY);
    expect(await getIndexHistory("ih-0123456789abcdef")).toEqual(HISTORY);
    expect([last().url, last().init?.method]).toEqual(["/api/index-histories/ih-0123456789abcdef", undefined]);
    mock(404, { error: { code: "not-found", message: 'index history "ih-0000000000000000" not found' } });
    const err = await getIndexHistory("ih-0000000000000000").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});
