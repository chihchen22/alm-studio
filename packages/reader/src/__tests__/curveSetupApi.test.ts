// packages/reader/src/__tests__/curveSetupApi.test.ts
// Piece B, step B1, plan Task 9: the reader client of the curve setup routes. Paths, methods and body
// keys are restated by hand from apps/server/src/http/routes/curveSetups.ts; none is read back from
// the code under test. A refused setup (422 with a `refusals` list) is data; every other refusal
// (409 stale revision or no active setup, 404, a 422 without `refusals`) is an ApiError, as for run setups.
import type { CurveSetupBlock } from "@alm/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  activateCurveSetup,
  deactivateCurveSetup,
  getCurveSetup,
  listCurveSetups,
  previewCurveSetup,
  saveCurveSetup,
  type CurveSetupListRow,
  type CurveSetupPreview,
  type CurveSetupsReply,
  type SaveCurveSetupResult,
} from "../api/workspaces";

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mock(status = 200, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const last = () => calls.at(-1)!;
const sent = () => JSON.parse(String(last().init!.body)) as Record<string, unknown>;

const SETUP: CurveSetupBlock = {
  id: "sofr-desk",
  label: "SOFR desk curve",
  baseCurve: "SOFR",
  interpolation: "log-linear-df",
  dayCount: "ACT/360",
  compounding: "annual",
  inputs: [
    { instrument: "cash", tenorMonths: 3, quoteType: "zero-rate", value: 0.043 },
    { instrument: "futures", tenorMonths: 3, quoteType: "par-rate", value: 95.8, convexityBp: 0.5 },
    { instrument: "ois-swap", tenorMonths: 24, quoteType: "par-rate", value: 0.039 },
  ],
};

const REVISION_409 = { error: { code: "conflict", message: "revision 3 expected, head is 4" } };

describe("reader curve setup api", () => {
  it("listCurveSetups reads GET /api/workspaces/:id/curve-setups and returns the rows verbatim", async () => {
    const reply: CurveSetupsReply = {
      setups: [
        { id: "cs-0123456789abcdef", setupId: "sofr-desk", label: "SOFR desk curve", interpolation: "log-linear-df", dayCount: "ACT/360", compounding: "annual", rows: SETUP.inputs, active: true },
        { id: "cs-fedcba9876543210", setupId: "ust-check", label: "UST check", interpolation: "linear-zero", dayCount: "ACT/365", compounding: "semi-annual", rows: [], active: false },
      ],
    };
    mock(200, reply);
    const got = await listCurveSetups("ws a");
    expect([last().url, last().init?.method]).toEqual(["/api/workspaces/ws%20a/curve-setups", undefined]);
    expect(got).toEqual(reply);
    const row: CurveSetupListRow = got.setups[0]!;
    expect(row.active).toBe(true);
    // The setup's own id beside the document id (B2 ruling R9): what a derived curve's base names.
    expect(row.setupId).toBe("sofr-desk");
    expect(row.rows[1]!.convexityBp).toBe(0.5);
  });

  it("listCurveSetups keeps the server's `missing` list when a slot's document is gone", async () => {
    const reply = { setups: [], missing: [{ id: "cs-0000000000000000", problem: 'the curve setup document "cs-0000000000000000" is not in the store' }] };
    mock(200, reply);
    const got = await listCurveSetups("ws-a");
    expect(got).toEqual(reply);
    expect(got.missing?.[0]?.id).toBe("cs-0000000000000000");
  });

  it("getCurveSetup reads GET /api/curve-setups/:docId and returns the whole stored block, id and baseCurve included", async () => {
    mock(200, SETUP);
    const got = await getCurveSetup("cs-0123456789abcdef");
    expect([last().url, last().init?.method]).toEqual(["/api/curve-setups/cs-0123456789abcdef", undefined]);
    expect(got).toEqual(SETUP);
    expect([got.id, got.baseCurve]).toEqual(["sofr-desk", "SOFR"]);
  });

  it("saveCurveSetup posts { setup, expectedRevision, by } to the workspace and answers { ok: true, id, revision } on a 201", async () => {
    mock(201, { id: "cs-0123456789abcdef", revision: 5 });
    const got: SaveCurveSetupResult = await saveCurveSetup("ws-a", SETUP, 4, "chih");
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws-a/curve-setups", "POST"]);
    expect(sent()).toEqual({ setup: SETUP, expectedRevision: 4, by: "chih" });
    expect(got).toEqual({ ok: true, id: "cs-0123456789abcdef", revision: 5 });
  });

  it("saveCurveSetup answers the same shape on a 200 (the slot already held this document)", async () => {
    mock(200, { id: "cs-0123456789abcdef", revision: 4 });
    expect(await saveCurveSetup("ws-a", SETUP, 4, "chih")).toEqual({ ok: true, id: "cs-0123456789abcdef", revision: 4 });
  });

  it("saveCurveSetup returns a refused setup's sentences as data on a 422, never throws", async () => {
    const refusals = ["row 2: a par-rate row may use annual or semi-annual compounding only", "row 3: tenorMonths repeats row 2"];
    mock(422, { error: { code: "validation", message: refusals.join("; "), detail: { field: "setup", refusals } }, refusals });
    const got = await saveCurveSetup("ws-a", SETUP, 4, "chih");
    expect(got).toEqual({ ok: false, refusals });
  });

  it("saveCurveSetup throws ApiError on a 422 that carries no refusals (a body the route refused before the setup)", async () => {
    const body = { error: { code: "validation", message: "by is required" } };
    mock(422, body);
    const err = await saveCurveSetup("ws-a", SETUP, 4, "chih").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).body).toEqual(body);
  });

  it("saveCurveSetup throws a 409 stale revision as ApiError with the typed body, as saveRunSetup does", async () => {
    mock(409, REVISION_409);
    const err = await saveCurveSetup("ws-a", SETUP, 3, "chih").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("conflict");
    expect((err as ApiError).body).toEqual(REVISION_409);
  });

  it("activateCurveSetup posts { expectedRevision, by } to :setupId/activate and returns { revision }", async () => {
    mock(200, { revision: 6 });
    const got = await activateCurveSetup("ws-a", "cs-0123456789abcdef", 5, "chih");
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws-a/curve-setups/cs-0123456789abcdef/activate", "POST"]);
    expect(sent()).toEqual({ expectedRevision: 5, by: "chih" });
    expect(got).toEqual({ revision: 6 });
  });

  it("activateCurveSetup throws a 409 stale revision as ApiError", async () => {
    mock(409, REVISION_409);
    const err = await activateCurveSetup("ws-a", "cs-0123456789abcdef", 3, "chih").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).body).toEqual(REVISION_409);
  });

  it("deactivateCurveSetup posts { expectedRevision, by } to curve-setups/deactivate and returns { revision }", async () => {
    mock(200, { revision: 7 });
    const got = await deactivateCurveSetup("ws-a", 6, "chih");
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws-a/curve-setups/deactivate", "POST"]);
    expect(sent()).toEqual({ expectedRevision: 6, by: "chih" });
    expect(got).toEqual({ revision: 7 });
  });

  it("deactivateCurveSetup throws a 409 (stale revision, or no setup active) as ApiError", async () => {
    const none = { error: { code: "conflict", message: 'no curve setup is active in workspace "ws-a"; there is nothing to deactivate' } };
    mock(409, none);
    const err = await deactivateCurveSetup("ws-a", 6, "chih").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe(none.error.message);
  });

  it("previewCurveSetup posts { setup } to /api/curve-setups/preview and returns the ok arm verbatim", async () => {
    const reply = {
      ok: true,
      quoteNodes: [
        { tenorMonths: 3, zeroRate: 0.043, discountFactor: 0.9893 },
        { tenorMonths: 24, zeroRate: 0.0388, discountFactor: 0.9267 },
      ],
      denseCount: 24,
      warnings: ["forward rate below zero between 18 and 24 months"],
    };
    mock(200, reply);
    const got: CurveSetupPreview = await previewCurveSetup(SETUP);
    expect([last().url, last().init!.method]).toEqual(["/api/curve-setups/preview", "POST"]);
    expect(sent()).toEqual({ setup: SETUP });
    expect(got).toEqual(reply);
    if (!got.ok) throw new Error("expected the ok arm");
    expect(got.quoteNodes[1]!.tenorMonths).toBe(24);
    expect(got.denseCount).toBe(24);
  });

  it("previewCurveSetup returns a 422 as the refusals arm, never throws", async () => {
    const refusals = ["the bootstrap could not bracket a root for row 3"];
    mock(422, { ok: false, refusals });
    const got = await previewCurveSetup(SETUP);
    expect(got).toEqual({ ok: false, refusals });
    if (got.ok) throw new Error("expected the refusals arm");
    expect(got.refusals).toEqual(refusals);
  });

  it("previewCurveSetup still throws ApiError on a non-422 failure", async () => {
    mock(500, { error: { code: "internal", message: "boom" } });
    const err = await previewCurveSetup(SETUP).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});
