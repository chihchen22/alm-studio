// packages/reader/src/__tests__/reference.test.ts
// The reader client of the stored reference documents. The path is restated by hand
// from apps/server/src/http/routes/reference.ts; it is not read back from the code under test. The document is data,
// returned verbatim; an id the store does not hold answers a 404 that surfaces as ApiError with the server's sentence.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getReferenceDocument, getResultSection } from "../api/client";

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mock(status = 200, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("reader reference api", () => {
  it("getReferenceDocument reads GET /api/reference/:id and returns the document verbatim", async () => {
    const doc = { meta: { cet1Musd: 500 }, arms: {} };
    mock(200, doc);
    const got = await getReferenceDocument<typeof doc>("targets-demo-v1");
    expect([calls[0]!.url, calls[0]!.init?.method]).toEqual(["/api/reference/targets-demo-v1", undefined]);
    expect(got).toEqual(doc);
  });

  it("encodes the id and surfaces the 404 naming it as an ApiError", async () => {
    mock(404, { error: { code: "not_found", message: 'reference "a b" is not in the store' } });
    const err = await getReferenceDocument("a b").then(
      () => null,
      (e: unknown) => e,
    );
    expect(calls[0]!.url).toBe("/api/reference/a%20b");
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toContain("is not in the store");
  });

  it("the seg and liquidityStress sections read /api/runs/:id/result/:section", async () => {
    mock(200, { convention: "constant-balance-sheet" });
    await getResultSection("run-1", "seg");
    await getResultSection("run-1", "liquidityStress");
    expect(calls.map((c) => c.url)).toEqual(["/api/runs/run-1/result/seg", "/api/runs/run-1/result/liquidityStress"]);
  });
});
