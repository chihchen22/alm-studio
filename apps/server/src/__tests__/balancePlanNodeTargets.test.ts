import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => { t = await bootTestPlatform(); await seedStore(new FileStore(t.storeRoot), repoRoot()); });
afterAll(() => t.close());
const base = { schemaVersion: "1.0.0", id: "bp-node-route", label: "node", asOf: "2026-03-31", targets: [], unlistedFamilies: "runoff" };

describe("POST /api/balance-plans with nodeTargets", () => {
  it("round-trips nodeTargets verbatim and refuses a malformed row naming the field", async () => {
    const nodeTargets = [{ coaNodeId: "assets-loans", path: [{ month: 12, balance: 1000 }], newBusinessPricing: { spreadOverIndexBp: 25, termMonths: 36 } }];
    const r = await api<{ nodeTargets: unknown }>(t.base, "POST", "/api/balance-plans", { balancePlan: { ...base, nodeTargets } });
    expect(r.status).toBe(201); expect(r.body.nodeTargets).toEqual(nodeTargets);
    expect((await api<{ nodeTargets: unknown }>(t.base, "GET", "/api/balance-plans/bp-node-route")).body.nodeTargets).toEqual(nodeTargets);
    const bad = await api(t.base, "POST", "/api/balance-plans", { balancePlan: { ...base, id: "bp-node-bad", nodeTargets: [{ coaNodeId: "", path: [], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 60 } }] } });
    expect(bad.status).toBe(422); expect(bad.text).toMatch(/nodeTargets\[0\]\.coaNodeId/);
    const plain = await api<Record<string, unknown>>(t.base, "POST", "/api/balance-plans", { balancePlan: { ...base, id: "bp-node-plain" } });
    expect("nodeTargets" in plain.body).toBe(false);
  });
});
