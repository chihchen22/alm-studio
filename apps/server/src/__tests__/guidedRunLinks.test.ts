/**
 * The exact link from a guided stochastic run to its workspace (S2a fix round 1, H2). Two workspaces named "My analysis"
 * and "My analysis 2" get the ids ws-my-analysis and ws-my-analysis-2, one a prefix of the other: a run linked to the
 * second must never be read by the first. The run files are written straight into the store, as a finished run leaves
 * them; the expected rows are written out here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../config";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let tp: TestPlatform;

interface Head { id: string; revision: number; blocks: { run: { setups: Array<{ setupLineageId: string }> } } }

async function workspace(name: string): Promise<Head> {
  const made = await api<Head>(tp.base, "POST", "/api/workspaces", { name, type: "test", cutoffDate: "2026-03-31", owner: "t", by: "t" });
  expect(made.status, made.text).toBe(201);
  const set = await api<Head>(tp.base, "POST", `/api/workspaces/${made.body.id}/blocks`, { expectedRevision: made.body.revision, by: "t", block: "positions", op: "set", ref: { collection: "portfolios", id: "example-book-v1" } });
  expect(set.status, set.text).toBe(201);
  return set.body;
}

function finishedRun(runId: string, bookId: string): void {
  const store = tp.platform.context.store;
  store.writeRunJson(runId, "request.json", { portfolioRef: { id: bookId, contentHash: "x" }, request: {}, engineContext: {} });
  store.writeRunJson(runId, "status.json", { runId, state: "done", label: "Guided stochastic run", submittedAt: "2026-11-02T12:00:00.000Z", platformRequestHash: "h" });
}

let a: Head;
let b: Head;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const imp = await api(tp.base, "POST", "/api/portfolios/import", readFileSync(join(repoRoot(), "examples", "example-book-v1.json"), "utf8"));
  expect(imp.status, imp.text).toBe(201);
  a = await workspace("My analysis");
  b = await workspace("My analysis 2");
}, 120_000);

afterAll(async () => {
  await tp.close();
});

describe("guided run links", () => {
  it("the two default names give ids where one is a prefix of the other", () => {
    expect([a.id, b.id]).toEqual(["ws-my-analysis", "ws-my-analysis-2"]);
  });

  it("a run linked to My analysis 2 is read by it alone", async () => {
    finishedRun("run-guided-b", "example-book-v1");
    const slot = b.blocks.run.setups[0]!.setupLineageId;
    const link = await api<{ runId: string; setupDocId: string }>(tp.base, "POST", `/api/workspaces/${b.id}/guided-runs`, { runId: "run-guided-b", setupLineageId: slot, setupDocId: "rs-doc-1", by: "t" });
    expect(link.status, link.text).toBe(201);
    expect(link.body).toMatchObject({ runId: "run-guided-b", setupDocId: "rs-doc-1" });
    const mine = await api<Array<{ runId: string; setupDocId: string; status: { state: string } | null }>>(tp.base, "GET", `/api/workspaces/${b.id}/guided-runs`);
    expect(mine.body.map((r) => [r.runId, r.setupDocId, r.status?.state])).toEqual([["run-guided-b", "rs-doc-1", "done"]]);
    const other = await api<unknown[]>(tp.base, "GET", `/api/workspaces/${a.id}/guided-runs`);
    expect(other.status).toBe(200);
    expect(other.body).toEqual([]);
  });

  it("refuses a run of another book, an unknown run, an unknown slot and a second link, in words", async () => {
    finishedRun("run-other-book", "some-other-book");
    const slot = a.blocks.run.setups[0]!.setupLineageId;
    const wrong = await api<{ error: { message: string } }>(tp.base, "POST", `/api/workspaces/${a.id}/guided-runs`, { runId: "run-other-book", setupLineageId: slot, setupDocId: "d", by: "t" });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.message).toMatch(/ran book "some-other-book", not this workspace's book "example-book-v1"/);
    expect((await api(tp.base, "POST", `/api/workspaces/${a.id}/guided-runs`, { runId: "run-none", setupLineageId: slot, setupDocId: "d", by: "t" })).status).toBe(404);
    expect((await api(tp.base, "POST", `/api/workspaces/${a.id}/guided-runs`, { runId: "run-guided-b", setupLineageId: "setup-nope", setupDocId: "d", by: "t" })).status).toBe(422);
    const again = await api<{ error: { message: string } }>(tp.base, "POST", `/api/workspaces/${b.id}/guided-runs`, { runId: "run-guided-b", setupLineageId: b.blocks.run.setups[0]!.setupLineageId, setupDocId: "d", by: "t" });
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/already linked/);
    expect((await api(tp.base, "POST", `/api/workspaces/${a.id}/guided-runs`, { runId: "run-guided-b", setupLineageId: slot, setupDocId: "d" })).status).toBe(422);
  });
});
