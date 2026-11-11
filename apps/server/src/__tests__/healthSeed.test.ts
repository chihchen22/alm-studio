import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPlatformServer, type PlatformServer } from "../server";
import { api, scratchConfig } from "./harness";

const STALE = {
  collection: "scenario-slates" as const, id: "regulatory-grid-vanilla",
  storedHash: "aaaa", currentHash: "bbbb",
  differences: [{ path: "scenarios[0].label", stored: "old", current: "new" }],
};
const RETIRED = {
  collection: "market" as const, id: "market-2026-03-31",
  reason: "earlier market snapshot", runs: ["run-20260802-191359-00168e1"],
};
let withReport: PlatformServer; let without: PlatformServer;
beforeAll(async () => {
  withReport = await startPlatformServer(scratchConfig(), { seedReport: { written: [], skipped: [], stale: [STALE], retired: [RETIRED] } });
  without = await startPlatformServer(scratchConfig());
});
afterAll(async () => { await withReport.close(); await without.close(); });

describe("GET /api/health seed", () => {
  it("copies the boot stale and retired reports verbatim", async () => {
    const r = await api<{ seed: { stale: unknown[]; retired: unknown[] } }>(`http://127.0.0.1:${withReport.port}`, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body.seed).toEqual({ stale: [STALE], retired: [RETIRED] });
  });
  it("is two empty lists when no report was passed", async () => {
    const r = await api<{ seed: { stale: unknown[]; retired: unknown[] } }>(`http://127.0.0.1:${without.port}`, "GET", "/api/health");
    expect(r.body.seed).toEqual({ stale: [], retired: [] });
  });
});
