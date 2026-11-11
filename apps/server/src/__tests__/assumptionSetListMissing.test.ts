/**
 * Piece 7b follow-up (mfu-1, Slice 3 M4): GET /api/assumption-sets reads each
 * set's document for its macro mapping. A meta whose document file is missing
 * must not fail the whole listing with 404: the rest list as before, and that
 * row is marked documentMissing. Runs on a scratch store; values restated here.
 */
import { unlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDemoAssumptions } from "@alm/data/src/demo/request";
import { storePaths } from "../store/paths";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); });
afterAll(() => t.close());

interface Row { id: string; label: string; documentMissing?: boolean; macroBindings?: unknown }

describe("assumption-set listing with a missing document", () => {
  it("lists every row and marks the one whose document is gone", async () => {
    const demo = buildDemoAssumptions();
    for (const id of ["list-keep", "list-gone"]) {
      expect((await api<unknown>(t.base, "POST", "/api/assumption-sets", { ...demo, id, label: id })).status).toBe(201);
    }
    unlinkSync(storePaths(t.storeRoot).documentPath("assumption-sets", "list-gone"));
    const reply = await api<Row[]>(t.base, "GET", "/api/assumption-sets");
    expect(reply.status).toBe(200);
    const byId = new Map(reply.body.map((r) => [r.id, r] as const));
    expect(byId.get("list-gone")!.documentMissing).toBe(true);
    expect(byId.get("list-gone")!.label).toBe("list-gone");
    expect("documentMissing" in byId.get("list-keep")!).toBe(false);
    expect("macroBindings" in byId.get("list-keep")!).toBe(false);
  });
});
