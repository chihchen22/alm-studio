// packages/reader/src/__tests__/derivedCurveApi.test.ts
// Piece B, step B2, plan Task 7: the reader client of the derived curve routes. Paths, methods and body
// keys are restated by hand from apps/server/src/http/routes/derivedCurves.ts; none is read back from
// the code under test. A refused curve or estimate (422 with a `refusals` list) is data; every other
// refusal (409 stale revision, 404, a 422 without `refusals`, a 500) is an ApiError, as for curve setups.
import type { DerivedCurveBlock } from "@alm/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  estimateDerivedCurve,
  getDerivedCurve,
  listDerivedCurves,
  saveDerivedCurve,
  type DerivedCurveEstimate,
  type DerivedCurveListRow,
  type DerivedCurvesReply,
  type SaveDerivedCurveResult,
} from "../api/workspaces";

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mock(status = 200, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const last = () => calls.at(-1)!;
const sent = () => JSON.parse(String(last().init!.body)) as Record<string, unknown>;

const CURVE: DerivedCurveBlock = {
  id: "prime-over-sofr",
  label: "Prime over SOFR",
  base: "sofr-desk",
  spreads: [
    { tenorMonths: 1, spreadBp: 300 },
    { tenorMonths: 12, spreadBp: 295.5 },
  ],
  source: { from: "prime-setup", minus: "platform-default" },
};

const REVISION_409 = { error: { code: "conflict", message: "revision 3 expected, head is 4" } };

describe("reader derived curve api", () => {
  it("listDerivedCurves reads GET /api/workspaces/:id/derived-curves and returns the rows verbatim", async () => {
    const reply: DerivedCurvesReply = {
      curves: [
        { id: "dc-0123456789abcdef", curveId: "prime-over-sofr", label: "Prime over SOFR", base: "sofr-desk", spreads: CURVE.spreads, source: CURVE.source },
        { id: "dc-fedcba9876543210", curveId: "typed", label: "Typed grid", base: "platform-default", spreads: [{ tenorMonths: 3, spreadBp: -12.5 }] },
      ],
    };
    mock(200, reply);
    const got = await listDerivedCurves("ws a");
    expect([last().url, last().init?.method]).toEqual(["/api/workspaces/ws%20a/derived-curves", undefined]);
    expect(got).toEqual(reply);
    const row: DerivedCurveListRow = got.curves[0]!;
    expect([row.id, row.curveId]).toEqual(["dc-0123456789abcdef", "prime-over-sofr"]);
    expect(row.source).toEqual({ from: "prime-setup", minus: "platform-default" });
    expect("source" in got.curves[1]!).toBe(false);
    expect(got.missing).toBeUndefined();
  });

  it("listDerivedCurves keeps the server's `missing` list when a slot's document is gone", async () => {
    const reply = { curves: [], missing: [{ id: "dc-0000000000000000", problem: 'the derived curve document "dc-0000000000000000" is not in the store' }] };
    mock(200, reply);
    const got = await listDerivedCurves("ws-a");
    expect(got).toEqual(reply);
    expect(got.missing?.[0]?.id).toBe("dc-0000000000000000");
  });

  it("getDerivedCurve reads GET /api/derived-curves/:docId and returns the whole stored block", async () => {
    mock(200, CURVE);
    const got = await getDerivedCurve("dc-0123456789abcdef");
    expect([last().url, last().init?.method]).toEqual(["/api/derived-curves/dc-0123456789abcdef", undefined]);
    expect(got).toEqual(CURVE);
  });

  it("getDerivedCurve throws a 404 as ApiError", async () => {
    mock(404, { error: { code: "not_found", message: 'derived-curves "dc-x" not found' } });
    const err = await getDerivedCurve("dc-x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("saveDerivedCurve posts { curve, expectedRevision, by } to the workspace and answers { ok: true, id, revision } on a 201", async () => {
    mock(201, { id: "dc-0123456789abcdef", revision: 5 });
    const got: SaveDerivedCurveResult = await saveDerivedCurve("ws-a", CURVE, 4, "chih");
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws-a/derived-curves", "POST"]);
    expect(sent()).toEqual({ curve: CURVE, expectedRevision: 4, by: "chih" });
    expect(got).toEqual({ ok: true, id: "dc-0123456789abcdef", revision: 5 });
  });

  it("saveDerivedCurve answers the same shape on a 200 (the slot already held this document)", async () => {
    mock(200, { id: "dc-0123456789abcdef", revision: 4 });
    expect(await saveDerivedCurve("ws-a", CURVE, 4, "chih")).toEqual({ ok: true, id: "dc-0123456789abcdef", revision: 4 });
  });

  it("saveDerivedCurve returns a refused curve's sentences as data on a 422, never throws", async () => {
    const refusals = ["row 2: tenorMonths must be greater than row 1's (12)", "row 3: spreadBp must be a finite number with absolute value at most 1000"];
    mock(422, { error: { code: "validation", message: refusals.join("; "), detail: { field: "curve", refusals } }, refusals });
    const got = await saveDerivedCurve("ws-a", CURVE, 4, "chih");
    expect(got).toEqual({ ok: false, refusals });
  });

  it("saveDerivedCurve throws ApiError on a 422 that carries no refusals (a body the route refused before the curve)", async () => {
    const body = { error: { code: "validation", message: "by is required" } };
    mock(422, body);
    const err = await saveDerivedCurve("ws-a", CURVE, 4, "chih").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).body).toEqual(body);
  });

  it("saveDerivedCurve throws a 409 stale revision as ApiError with the typed body", async () => {
    mock(409, REVISION_409);
    const err = await saveDerivedCurve("ws-a", CURVE, 3, "chih").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("conflict");
    expect((err as ApiError).body).toEqual(REVISION_409);
  });

  it("estimateDerivedCurve posts { from, minus, tenors } to derived-curves/estimate and returns the ok arm verbatim", async () => {
    const reply = { ok: true, spreads: [{ tenorMonths: 1, spreadBp: 301.25 }, { tenorMonths: 3, spreadBp: 0 }] };
    mock(200, reply);
    const got: DerivedCurveEstimate = await estimateDerivedCurve("ws a", "prime-setup", "platform-default", [1, 3]);
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws%20a/derived-curves/estimate", "POST"]);
    expect(sent()).toEqual({ from: "prime-setup", minus: "platform-default", tenors: [1, 3] });
    expect(got).toEqual(reply);
    if (!got.ok) throw new Error("expected the ok arm");
    expect(got.spreads[0]!.spreadBp).toBe(301.25);
  });

  it("estimateDerivedCurve returns a 422 as the refusals arm, never throws", async () => {
    const refusals = ['"minus" names curve setup "gone", which workspace "ws-a" does not hold', "row 2: tenorMonths must be greater than row 1's (12)"];
    mock(422, { ok: false, refusals });
    const got = await estimateDerivedCurve("ws-a", "prime-setup", "gone", [12, 6]);
    expect(got).toEqual({ ok: false, refusals });
    if (got.ok) throw new Error("expected the refusals arm");
    expect(got.refusals).toEqual(refusals);
  });

  it("estimateDerivedCurve still throws ApiError on a non-422 failure (404 unknown workspace)", async () => {
    mock(404, { error: { code: "not_found", message: 'workspace "ws-x" not found' } });
    const err = await estimateDerivedCurve("ws-x", "platform-default", "platform-default", [1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});
