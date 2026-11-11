/**
 * Legacy run attachment (Studio A+E spec v3.1 Section 2.7 rule 11 and "Legacy runs"; plan Task D1).
 *
 * A run is attached by one `runs.ndjson` line `{ runId, attachedBy: "migration", at, pins: "reconstructed" }`.
 * `status.json` is supervisor-owned and is never written by the migration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { copyStoreWithoutDb, seededTemplate } from "./seedFixtures";
import { plantRun, withoutWorkspaces, type FixtureRun } from "./seedWorkspaceFixtures";

let template: string;
const made: string[] = [];
beforeAll(async () => {
  template = await seededTemplate();
  made.push(template);
}, 120_000);
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const copy = (prefix: string): string => {
  const d = copyStoreWithoutDb(template, prefix);
  made.push(d);
  return d;
};

const VANILLA_HASH = "b7d8f1cbad64dcd6ad4a02fb6a121445a17a7b70955041f81884f3e7138dab37";

function run(runId: string, over: Partial<FixtureRun> = {}): FixtureRun {
  return {
    runId,
    portfolioId: "vanilla-book-v1",
    marketId: "market-public-2026-03-31",
    scenarioSlateId: "regulatory-grid-vanilla",
    assumptionSetIds: ["vanilla-empty-v1"],
    portfolioRef: { id: over.portfolioId ?? "vanilla-book-v1", contentHash: VANILLA_HASH },
    asOf: "2026-03-31",
    ...over,
  };
}

describe("legacy run attachment", () => {
  it("attaches a run to the workspace whose book, market and sets match, and leaves status.json alone", async () => {
    const root = copy("ae1-legacy1-");
    const store = new FileStore(root);
    // The template was seeded by this code: the workspaces already exist, the run is new.
    plantRun(store, run("run-legacy-1"));
    const statusBefore = readFileSync(store.paths.runFile("run-legacy-1", "status.json"));
    const report = await seedStore(store, repoRoot());
    const ws = new WorkspaceStore(root);
    expect(report.workspaces!.created).toEqual([]);
    expect(report.workspaces!.runsAttached).toEqual(["run-legacy-1 -> ws-vanilla-book-v1"]);
    expect(ws.readRunAttachments("ws-vanilla-book-v1")).toEqual([
      { runId: "run-legacy-1", attachedBy: "migration", at: expect.any(String), pins: "reconstructed" },
    ]);
    expect(readFileSync(store.paths.runFile("run-legacy-1", "status.json")).equals(statusBefore)).toBe(true);
    // The head was not touched: attachment is a line, never a head write.
    expect(ws.history("ws-vanilla-book-v1")).toHaveLength(1);
    // A second seed attaches nothing again.
    const again = await seedStore(store, repoRoot());
    expect(again.workspaces!.runsAttached).toEqual([]);
    expect(new WorkspaceStore(root).readRunAttachments("ws-vanilla-book-v1")).toHaveLength(1);
  }, 120_000);

  it("puts a run that matches no workspace under ws-legacy-<as-of>, a Test workspace, archived", async () => {
    const root = copy("ae1-legacy2-");
    const store = new FileStore(root);
    // A book id absent from the store: no workspace can hold it.
    plantRun(store, run("run-legacy-2", { portfolioId: "book-absent-v1", portfolioRef: { id: "book-absent-v1", contentHash: VANILLA_HASH } }));
    const report = await seedStore(store, repoRoot());
    const ws = new WorkspaceStore(root);
    expect(report.workspaces!.legacyWorkspace).toBe("ws-legacy-2026-03-31");
    expect(report.workspaces!.created).toEqual(["ws-legacy-2026-03-31"]);
    const head = ws.head("ws-legacy-2026-03-31");
    expect(head.type).toBe("test");
    expect(head.status).toBe("archived");
    expect(head.cutoffDate).toBe("2026-03-31");
    expect(head.lineage.mode).toBe("seed");
    expect(ws.history("ws-legacy-2026-03-31").map((l) => l.by)).toEqual(["seed"]);
    expect(ws.readRunAttachments("ws-legacy-2026-03-31")).toEqual([
      { runId: "run-legacy-2", attachedBy: "migration", at: expect.any(String), pins: "reconstructed" },
    ]);
    // No seeded workspace took it.
    for (const h of ws.list()) if (h.id !== "ws-legacy-2026-03-31") expect(ws.readRunAttachments(h.id)).toEqual([]);
  }, 120_000);

  it("adds the derived market a run used to the block when the workspace is created (run-20261008-070617-00241e7)", async () => {
    const root = copy("ae1-legacy3-");
    withoutWorkspaces(root);
    const store = new FileStore(root);
    plantRun(store, run("run-20261008-070617-00241e7", { marketId: "vol-shock-demo-v1" }));
    await seedStore(store, repoRoot());
    const ws = new WorkspaceStore(root);
    const head = ws.head("ws-vanilla-book-v1");
    expect(head.blocks.market.derived.map((d) => d.id)).toEqual(["vol-shock-demo-v1"]);
    expect(head.blocks.market.derived[0]!.definitionKey).toBe("vol-shock-demo-v1");
    expect(head.blocks.market.derived[0]!.parentKey).toBeNull();
    expect(ws.readRunAttachments("ws-vanilla-book-v1").map((a) => a.runId)).toEqual(["run-20261008-070617-00241e7"]);
    // The synthetic workspace holds vol-shock by the hand map, not by this run.
    expect(ws.head("ws-synthetic-2500-v1").blocks.market.derived.map((d) => d.id)).toContain("vol-shock-demo-v1");
  }, 120_000);

  it.each(["locked", "archived"] as const)(
    "never attaches a late run to a %s workspace: it goes to ws-legacy-<as-of> instead (review M3)",
    async (status) => {
      const root = copy(`ae1-legacy-${status}-`);
      const store = new FileStore(root);
      const ws = new WorkspaceStore(root);
      const h = ws.head("ws-vanilla-book-v1");
      if (status === "locked") {
        ws.commit(h.id, h.revision, "tester", { kind: "lock", approvalId: "ap-late-1" }, {
          ...h,
          status: "locked",
          lock: { lockedAt: "2026-10-09T00:00:00.000Z", by: "tester", approvalId: "ap-late-1", signedHash: h.signedHash },
        });
      } else {
        ws.commit(h.id, h.revision, "tester", { kind: "status", from: "active", to: "archived" }, { ...h, status: "archived" });
      }
      // A run submitted through the old route after the sign-off: it matches the month's book, market and sets.
      plantRun(store, run("run-late-1"));
      const report = await seedStore(store, repoRoot());
      expect(report.workspaces!.runsAttached).toEqual(["run-late-1 -> ws-legacy-2026-03-31"]);
      const after = new WorkspaceStore(root);
      expect(after.readRunAttachments("ws-vanilla-book-v1")).toEqual([]);
      expect(after.history("ws-vanilla-book-v1")).toHaveLength(2);
      // Idempotent: a second seed attaches nothing anywhere.
      const again = await seedStore(store, repoRoot());
      expect(again.workspaces!.runsAttached).toEqual([]);
      expect(again.workspaces!.created).toEqual([]);
    },
    120_000,
  );

  it("leaves a launched run to boot reconcile: a request.json that names its workspace is not migrated", async () => {
    const root = copy("ae1-legacy4-");
    const store = new FileStore(root);
    plantRun(store, run("run-launched-1"));
    const req = store.readRunJson<Record<string, unknown>>("run-launched-1", "request.json");
    store.writeRunJson("run-launched-1", "request.json", {
      ...req,
      workspace: { workspaceId: "ws-vanilla-book-v1", setupLineageId: "setup-x", setupDocId: "rs-0", launchNo: 1, consumed: {} },
    });
    const report = await seedStore(store, repoRoot());
    expect(report.workspaces!.runsAttached).toEqual([]);
    expect(new WorkspaceStore(root).readRunAttachments("ws-vanilla-book-v1")).toEqual([]);
  }, 120_000);
});
