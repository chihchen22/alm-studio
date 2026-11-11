/**
 * Studio slice S2b-1, test (e) on the platform: a stored setup compiles to the same request, byte for
 * byte. Standard ALCO (Flat 60 and 0), an S2a guided setup as it was saved (Flat, all-in EVE, no templates) and a
 * Runoff setup are compiled on the vanilla book; the content hash of each compiled request and plan (the plan id,
 * which hashes the workspace's creation time, blanked) was recorded by
 * running this same file on the unmodified code, before any S2b-1 change, and is pinned here. Set PARITY_PRINT=1 to
 * print them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { compileSetupRow } from "../workspaces/setupCompile";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

const blocks = (id: string, rev: number, body: object) =>
  api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });

async function ready(id: string): Promise<void> {
  await api(t.base, "POST", "/api/workspaces", { id, name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
  await blocks(id, 1, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
  await blocks(id, 2, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
  await blocks(id, 3, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  await blocks(id, 4, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
}

function hashes(edit: (s: RunSetup) => RunSetup): { request: string; plan: string } {
  const wsStore = new WorkspaceStore(t.storeRoot);
  const head = wsStore.head("ws-parity");
  const slot = head.blocks.run.setups[0]!;
  const setup = edit(store.getDocument<RunSetup>("run-setups", slot.current.id).doc);
  const row = compileSetupRow(t.platform.context, wsStore, head, slot, setup, null);
  // The plan id carries a hash of the workspace's creation (a wall-clock stamp), so it and the plan hash stamped from
  // it are blanked; every other byte of the plan and the request is compared.
  const plan = { ...row.planDocument, planId: "" };
  const request = { ...row.request, plan: { ...row.request.plan!, planId: "", planHash: "" } };
  return { request: contentHash(request), plan: contentHash(plan) };
}

/** Recorded on the unmodified code (before S2b-1). */
const PINNED: Record<string, { request: string; plan: string }> = {
  alco: { request: "b4adc1bd29ea2bfb24baf62fc601b234d9dbdd368f77d1932961afec1d1d3234", plan: "1740088a24f602dda1a6f5921e99e1cb7c8568cee20d98955f5a52befbd0994e" },
  // The S2a guided body differs from Standard ALCO only in fields the compile does not read (its name), so it compiles alike.
  guidedS2a: { request: "b4adc1bd29ea2bfb24baf62fc601b234d9dbdd368f77d1932961afec1d1d3234", plan: "1740088a24f602dda1a6f5921e99e1cb7c8568cee20d98955f5a52befbd0994e" },
  runoff: { request: "c64362eeb58eec96f634d53881b518dd189b1a46220fb5278bbb2468a4658b9b", plan: "fb51afe0c1e3aa716bad662e82772bd22465f58cb828407a8f2f5682fc2c41d8" },
};

/**
 * An S2b-1 guided setup as it was saved (Flat, risk-free EVE, a product on
 * every family, no behavior field) compiles to the request S2b-1 compiled. Recorded by running this same file on the unmodified code (S2b-1 merged, before any S2b-2 change).
 */
const PINNED_S2B1: Record<string, { request: string; plan: string }> = {
  guidedS2b1: { request: "2724f8a5ca3d388908701a7f52d3710e4e7f45477606af0fed2cf3d51b1c8a65", plan: "64fb337693059fb9c374f453662454b33fa98548f881d5fe39aa1c3650b10224" },
};
const S2B1_TEMPLATES = [
  { familyId: "cash", rateType: "fixed", amortization: "bullet", indexTenorMonths: 1, fixedIndex: "matched", termMonths: 1, spreadOverIndexBp: 0 },
  { familyId: "fixed-loans", rateType: "floating", amortization: "level-pay", indexTenorMonths: 3, termMonths: 48, spreadOverIndexBp: 175 },
  { familyId: "fhlb", rateType: "fixed", amortization: "bullet", indexTenorMonths: 60, fixedIndex: "swap", termMonths: 60, spreadOverIndexBp: 10 },
] as const;

describe("(e) stored setups compile byte-identical", () => {
  it("Standard ALCO, an S2a guided setup and a Runoff setup compile to the requests main compiled", async () => {
    await ready("ws-parity");
    const got = {
      alco: hashes((s) => s),
      // As the S2a guided path saved it: Flat at 60 and 0, all-in EVE, NII over 60 months on 12, 24 and 60.
      guidedS2a: hashes((s) => ({ ...s, name: "Guided analysis", eve: { ...s.eve, discountBasis: "all-in" }, nii: { ...s.nii, horizonMonths: 60, reportHorizons: [12, 24, 60] } })),
      runoff: hashes((s) => ({ ...s, nii: { ...s.nii, basis: { kind: "runoff" } } })),
    };
    if (process.env.PARITY_PRINT === "1") console.log(`PARITY ${JSON.stringify(got)}`);
    expect(got).toEqual(PINNED);
  });
  it("an S2b-1 guided setup with a product on every family compiles to the request S2b-1 compiled", () => {
    const got = {
      guidedS2b1: hashes((s) => ({ ...s, name: "Guided analysis", eve: { ...s.eve, discountBasis: "risk-free" }, nii: { ...s.nii, horizonMonths: 60, reportHorizons: [12, 24, 60], templates: S2B1_TEMPLATES.map((t) => ({ ...t })) as unknown as NonNullable<RunSetup["nii"]["templates"]> } })),
    };
    if (process.env.PARITY_PRINT === "1") console.log(`PARITY ${JSON.stringify(got)}`);
    expect(got).toEqual(PINNED_S2B1);
  });
});
