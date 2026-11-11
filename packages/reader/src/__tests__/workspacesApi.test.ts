// packages/reader/src/__tests__/workspacesApi.test.ts
// Studio A+E Slice 1, Task D3 (contract 11): one reader function per workspace route of spec v3.1
// Section 2.8, each hitting its path with the right method and a body sent verbatim. Paths, methods
// and body keys are restated by hand from the spec; none is read back from the code under test.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveWorkspace,
  cloneWorkspace,
  compareWorkspaces,
  createWorkspace,
  getReadiness,
  getRunSetup,
  getWorkspace,
  getWorkspaceHistory,
  launchSetup,
  listCoa,
  listRoutingPolicies,
  listRunSetups,
  listSetupValidations,
  listWorkspaceRuns,
  listWorkspaces,
  reapplyMarket,
  saveRunSetup,
  setBlock,
  setMeta,
  signOffWorkspace,
  validateSetup,
} from "../api/workspaces";
import { ApiError, getNiiMonthly, listPositions, projectInstrument } from "../api/client";

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mock(status = 200, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const last = () => calls.at(-1)!;
const sent = () => JSON.parse(String(last().init!.body)) as Record<string, unknown>;

describe("reader workspaces api", () => {
  it("every function hits its spec Section 2.8 path with the right method and body, verbatim", async () => {
    mock();
    await listWorkspaces(); expect(calls.at(-1)!.url).toMatch(/\/api\/workspaces$/);
    await getWorkspace("ws-a"); expect(calls.at(-1)!.url).toMatch(/\/api\/workspaces\/ws-a$/);
    await createWorkspace({ name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "me" });
    expect(calls.at(-1)!.init!.method).toBe("POST"); expect(JSON.parse(String(calls.at(-1)!.init!.body)).by).toBe("me");
    await setBlock("ws-a", { expectedRevision: 1, by: "me", block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: "s" } });
    expect(calls.at(-1)!.url).toMatch(/\/api\/workspaces\/ws-a\/blocks$/);
    await setMeta("ws-a", { expectedRevision: 1, by: "me", name: "B" }); expect(calls.at(-1)!.url).toMatch(/\/meta$/);
    await reapplyMarket("ws-a", { expectedRevision: 1, by: "me" }); expect(calls.at(-1)!.url).toMatch(/\/market\/reapply$/);
    await getReadiness("ws-a"); expect(calls.at(-1)!.url).toMatch(/\/readiness$/);
    await validateSetup("ws-a", "setup-1", { by: "me" }); expect(calls.at(-1)!.url).toMatch(/\/setups\/setup-1\/validate$/);
    await launchSetup("ws-a", "setup-1", { by: "me", acknowledge: ["run/setups"] }); expect(calls.at(-1)!.url).toMatch(/\/setups\/setup-1\/launch$/);
    await getNiiMonthly("run-1"); expect(calls.at(-1)!.url).toMatch(/\/api\/runs\/run-1\/result\/nii\/monthly$/);
    await listPositions("book-1", { q: "ab", familyId: "dda", limit: 50, offset: 100 });
    expect(calls.at(-1)!.url).toMatch(/\/api\/portfolios\/book-1\/positions\?q=ab&familyId=dda&limit=50&offset=100$/);
  });

  it("listRoutingPolicies reads GET /api/routing-policies and returns the rows verbatim in their typed shape", async () => {
    const rows = [
      { id: "model-map-default-v1", label: "Default model map", contentHash: "h1", seeded: true, classCount: 12 },
      { id: "routing-b", contentHash: "h2" },
    ];
    mock(200, rows);
    const got = await listRoutingPolicies();
    expect([last().url, last().init?.method]).toEqual(["/api/routing-policies", undefined]);
    expect(got).toEqual(rows);
    const typed: Array<{ id: string; label?: string; seeded?: boolean; classCount?: number; contentHash: string }> = got;
    expect(typed[0]!.id).toBe("model-map-default-v1");
  });

  it("listCoa reads GET /api/coa and returns the coa rows in their typed shape", async () => {
    const rows = [
      { id: "demo-coa-v1", label: "Demo chart of accounts (11 families)", contentHash: "h1" },
      { id: "house-coa-v2", label: "", contentHash: "h2" },
    ];
    mock(200, { coa: rows });
    const got = await listCoa();
    expect([last().url, last().init?.method]).toEqual(["/api/coa", undefined]);
    expect(got).toEqual(rows);
    const typed: Array<{ id: string; label: string; contentHash: string }> = got;
    expect(typed[0]!.id).toBe("demo-coa-v1");
  });

  it("a 409 surfaces the typed error body with its status", async () => {
    mock(409, { error: { code: "conflict", message: "revision 3 expected, head is 4" } });
    await expect(setMeta("ws-a", { expectedRevision: 3, by: "me", note: "n" })).rejects.toMatchObject({ status: 409 });
  });

  it("the remaining twelve routes of Section 2.8 each use their own method, path and body", async () => {
    mock();
    await getWorkspaceHistory("ws-a");
    expect([last().url, last().init?.method]).toEqual(["/api/workspaces/ws-a/history", undefined]);
    await listWorkspaceRuns("ws-a");
    expect(last().url).toBe("/api/workspaces/ws-a/runs");
    await compareWorkspaces("ws-a", "ws-b");
    expect(last().url).toBe("/api/workspaces/compare?a=ws-a&b=ws-b");
    await cloneWorkspace("ws-a", { expectedRevision: 4, by: "me", mode: "roll-forward", name: "Apr", cutoffDate: "2026-04-30", blocks: ["assumptions", "run"], type: "monthly" });
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws-a/clone", "POST"]);
    expect(sent()).toEqual({ expectedRevision: 4, by: "me", mode: "roll-forward", name: "Apr", cutoffDate: "2026-04-30", blocks: ["assumptions", "run"], type: "monthly" });
    await archiveWorkspace("ws-a", { expectedRevision: 5, by: "me", note: "done" });
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws-a/archive", "POST"]);
    expect(sent()).toEqual({ expectedRevision: 5, by: "me", note: "done" });
    await signOffWorkspace("ws-a", { expectedRevision: 5, by: "me", signedHash: "a".repeat(64) });
    expect([last().url, last().init!.method]).toEqual(["/api/workspaces/ws-a/sign-off", "POST"]);
    expect(sent()).toEqual({ expectedRevision: 5, by: "me", signedHash: "a".repeat(64) });
    await listRunSetups("ws-a");
    expect(last().url).toBe("/api/run-setups?workspaceId=ws-a");
    await getRunSetup("rs-0123456789abcdef");
    expect(last().url).toBe("/api/run-setups/rs-0123456789abcdef");
    await saveRunSetup({ workspaceId: "ws-a", setupLineageId: "setup-1", expectedRevision: 2, by: "me", setup: { name: "S" } as never });
    expect([last().url, last().init!.method]).toEqual(["/api/run-setups", "POST"]);
    expect(Object.keys(sent()).sort()).toEqual(["by", "expectedRevision", "setup", "setupLineageId", "workspaceId"]);
    await listPositions("book-1");
    expect(last().url).toBe("/api/portfolios/book-1/positions");
    await listPositions("book-1", { coaNodeId: "coa-cash", instrumentType: "fixed-loan", q: undefined });
    expect(last().url).toBe("/api/portfolios/book-1/positions?coaNodeId=coa-cash&instrumentType=fixed-loan");
  });

  it("ids are path-encoded and the drill sends the libraryRefs arm untouched", async () => {
    mock();
    await getWorkspace("ws a/b");
    expect(last().url).toBe("/api/workspaces/ws%20a%2Fb");
    await projectInstrument({
      instrument: { portfolioId: "book-1", positionId: "loan-1" },
      marketId: "public",
      scenarios: { libraryRefs: ["regulatory-grid-v1#S0"] },
    });
    expect(last().url).toBe("/api/instrument/project");
    expect(sent().scenarios).toEqual({ libraryRefs: ["regulatory-grid-v1#S0"] });
  });

  it("a launch refusal keeps its whole body: the gate lists on a 409 and the row reports on a 422", async () => {
    const gate = { error: { code: "acknowledge-required", message: "launch needs acknowledge" }, blocking: [], acknowledgeable: ["run/setup-warnings"], staleRoles: [] };
    mock(409, gate);
    const err1 = await launchSetup("ws-a", "setup-1", { by: "me" }).catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(ApiError);
    expect((err1 as ApiError).status).toBe(409);
    expect((err1 as ApiError).code).toBe("acknowledge-required");
    expect((err1 as ApiError).body).toEqual(gate);

    const rows = { error: { code: "validation", message: "batch row failed" }, rows: [{ label: "Up 100", outcome: "fail", status: 422, error: { code: "validation", message: "m" } }] };
    mock(422, rows);
    const err2 = await launchSetup("ws-a", "setup-1", { by: "me", batch: true }).catch((e: unknown) => e);
    expect((err2 as ApiError).body).toEqual(rows);
  });

  it("a 207 partial launch is a reply, not an error: it carries the cancel offer per queued run", async () => {
    const partial = {
      t: "launch-complete", setupLineageId: "setup-1", launchNo: 3, at: "2026-10-09T10:00:00.000Z", runIds: ["run-1"],
      failed: [{ row: "Up 200", status: 409, message: "pin moved" }],
      cancel: [{ runId: "run-1", method: "POST", path: "/api/runs/run-1/cancel" }],
    };
    mock(207, partial);
    const r = await launchSetup("ws-a", "setup-1", { by: "me", batch: true });
    expect(r).toEqual(partial);
    expect(r.cancel?.[0]?.path).toBe("/api/runs/run-1/cancel");
  });

  it("listSetupValidations reads the validations route with a GET and returns the typed array unwrapped", async () => {
    const entry = { at: "2026-10-10T09:00:00.000Z", by: "me", setupDocId: "rs-0123456789abcdef", outcome: "warn", basisLabel: "Flat (simple top-up)", skippedFamilies: ["swaps"], current: true };
    mock(200, { validations: [entry] });
    const r = await listSetupValidations("ws a", "setup/1");
    expect([last().url, last().init?.method]).toEqual(["/api/workspaces/ws%20a/setups/setup%2F1/validations", undefined]);
    expect(r).toEqual([entry]);
    expect(r[0]!.current).toBe(true);
  });

  it("a failed stored validation carries its reason; a passing one carries none (Studio Part 2 D11)", async () => {
    const failed = { at: "2026-10-11T09:00:00.000Z", by: "me", setupDocId: "rs-1", outcome: "fail", basisLabel: "", skippedFamilies: [], current: true, reason: "plan rejected: 1 gate failure(s): R3@st-x; selector matches no position" };
    const passed = { at: "2026-10-10T09:00:00.000Z", by: "me", setupDocId: "rs-1", outcome: "pass", basisLabel: "Flat (simple top-up)", skippedFamilies: [], current: true };
    mock(200, { validations: [failed, passed] });
    const r = await listSetupValidations("ws-a", "s");
    const reasons: Array<string | undefined> = r.map((e) => e.reason);
    expect(reasons).toEqual(["plan rejected: 1 gate failure(s): R3@st-x; selector matches no position", undefined]);
  });
});
