// packages/reader/src/__tests__/importMarketWorkbook.test.ts
// Studio follow-up F1: importMarketWorkbook takes an optional third argument that becomes the query string of
// POST /api/market/import-workbook (workspaceId, by, asOf, id). The two-argument call keeps its URL byte for byte.
// Paths and keys are restated by hand from the route's header comment in apps/server/src/http/routes/market.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { importMarketWorkbook } from "../api/client";

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mock(status = 201, body: unknown = { id: "m1", summary: {} }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const BYTES = new Uint8Array([1, 2, 3]).buffer;

describe("importMarketWorkbook", () => {
  it("the two-argument call posts to the bare path: no query string, the filename in X-Filename, the bytes as the body", async () => {
    mock();
    await importMarketWorkbook(BYTES, "market_20260331.xlsx");
    expect(calls[0].url).toBe("/api/market/import-workbook");
    expect(calls[0].init!.method).toBe("POST");
    expect((calls[0].init!.headers as Record<string, string>)["X-Filename"]).toBe("market_20260331.xlsx");
    expect(calls[0].init!.body).toBe(BYTES);
  });

  it("workspaceId, by and asOf become an encoded query string, in that order", async () => {
    mock();
    await importMarketWorkbook(BYTES, "m.xlsx", { workspaceId: "ws a/1", by: "Chih Chen", asOf: "2026-03-31" });
    expect(calls[0].url).toBe("/api/market/import-workbook?workspaceId=ws%20a%2F1&by=Chih%20Chen&asOf=2026-03-31");
  });

  it("only the keys that are set are sent; id comes last; an empty options object adds no query", async () => {
    mock();
    await importMarketWorkbook(BYTES, "m.xlsx", { id: "market-x", by: undefined, asOf: undefined });
    expect(calls[0].url).toBe("/api/market/import-workbook?id=market-x");
    await importMarketWorkbook(BYTES, "m.xlsx", {});
    expect(calls[1].url).toBe("/api/market/import-workbook");
  });

  it("a workspace-scoped reply is typed with its workspace block", async () => {
    mock(201, { id: "m1", summary: { calibrationDate: "2026-03-31" }, workspace: { id: "ws-a", revision: 5, clash: false } });
    const r = await importMarketWorkbook(BYTES, "m.xlsx", { workspaceId: "ws-a", by: "Chih" });
    expect(r.workspace?.revision).toBe(5);
    expect(r.workspace?.clash).toBe(false);
  });
});
