import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listWorkspaceRuns: vi.fn(),
  listRunSetups: vi.fn(),
}));
vi.mock("@alm/reader", () => reader);

import { readerLegacyApi, resolveLegacyRoute } from "../resolveLegacy";
import { parseHash } from "../router";

const manifest = (id: string, bookId: string | null, slots: string[]) => ({
  id,
  blocks: { positions: { book: bookId === null ? null : { collection: "portfolios", id: bookId, contentHash: "h" } }, run: { setups: slots.map((s) => ({ setupLineageId: s })) } },
});

beforeEach(() => {
  reader.listWorkspaces.mockReset();
  reader.listWorkspaceRuns.mockReset();
  reader.listRunSetups.mockReset();
});

describe("the reader-backed legacy api", () => {
  it("reads the book from the positions block, the plan ids from the setups' importedFrom and the runs from each workspace", async () => {
    reader.listWorkspaces.mockResolvedValue([manifest("ws-a", "book-a", ["setup-plan-x", "setup-ab12cd34"]), manifest("ws-b", null, [])]);
    reader.listRunSetups.mockImplementation(async (id: string) => (id === "ws-a"
      ? { setups: [{ slot: {}, setup: { importedFrom: "plan-x" } }, { slot: {}, setup: { importedFrom: null } }], missing: [] }
      : { setups: [], missing: [] }));
    reader.listWorkspaceRuns.mockImplementation(async (id: string) => (id === "ws-a" ? [{ runId: "run-1" }, { runId: "run-2" }] : [{ runId: "run-2" }]));

    const api = readerLegacyApi();
    expect(await api.listWorkspaces()).toEqual([
      { id: "ws-a", bookId: "book-a", setupPlanIds: ["plan-x"] },
      { id: "ws-b", bookId: null, setupPlanIds: [] },
    ]);
    expect(await api.workspacesOfRun("run-1")).toEqual(["ws-a"]);
    expect(await api.workspacesOfRun("run-2")).toEqual(["ws-a", "ws-b"]);
    expect(await api.workspacesOfRun("run-9")).toEqual([]);
    // One workspace list read serves the whole resolution.
    expect(reader.listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("falls back to the import slot id when a workspace's setups cannot be read", async () => {
    reader.listWorkspaces.mockResolvedValue([manifest("ws-a", "book-a", ["setup-plan-x", "standard-alco"])]);
    reader.listRunSetups.mockRejectedValue(new Error("503"));
    expect(await readerLegacyApi().listWorkspaces()).toEqual([{ id: "ws-a", bookId: "book-a", setupPlanIds: ["plan-x"] }]);
  });

  it("resolves an old address end to end through it", async () => {
    reader.listWorkspaces.mockResolvedValue([manifest("ws-a", "book-a", ["setup-plan-x"])]);
    reader.listRunSetups.mockResolvedValue({ setups: [{ slot: {}, setup: { importedFrom: "plan-x" } }], missing: [] });
    reader.listWorkspaceRuns.mockResolvedValue([{ runId: "run-1" }]);
    const r = await resolveLegacyRoute(parseHash("#/results?tab=nii&run=run-1&book=book-a"), readerLegacyApi());
    expect(r).toEqual({ kind: "screen", ws: "ws-a", section: "results", screen: "nii", query: { result: "run-1" } });
  });

  it("lets a failed runs read surface instead of guessing a holder", async () => {
    reader.listWorkspaces.mockResolvedValue([manifest("ws-a", "book-a", []), manifest("ws-b", "book-a", [])]);
    reader.listRunSetups.mockResolvedValue({ setups: [], missing: [] });
    reader.listWorkspaceRuns.mockImplementation(async (id: string) => {
      if (id === "ws-b") throw new Error("503");
      return [{ runId: "run-1" }];
    });
    await expect(readerLegacyApi().workspacesOfRun("run-1")).rejects.toThrow("503");
  });
});
