/**
 * Readiness (Studio A+E spec v3.1 Section 3.5; contract 14; plan Task C4): the six states,
 * the escalation order, the Stale cascade over consumed pins, the launchable lists and the
 * clone reply. Expected states, item names and item ids are restated by hand from the
 * Section 3.5 table; nothing is imported from the module under test but its types.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore, sha256Hex } from "../store/store";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import type { ConsumedPins, WorkspaceManifest } from "../workspaces/types";
import type { ReadinessReport } from "../workspaces/readiness";

let t: TestPlatform;
const OTHER_SET = "rd-empty-2";
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  // A second assumption set that compiles on the vanilla book: the empty set again under another id.
  const empty = (await api<Record<string, unknown>>(t.base, "GET", `/api/assumption-sets/${SEED_IDS.vanillaAssumptions}`)).body;
  const { contentHash: _h, ...rest } = empty as { contentHash?: string } & Record<string, unknown>;
  const made = await api(t.base, "POST", "/api/assumption-sets", { ...rest, id: OTHER_SET, label: "Another empty set" });
  expect(made.status).toBe(201);
}, 120_000);
afterAll(() => t.close());

const head = async (id: string) => (await api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`)).body;
/** One block write at the head's current revision (a warned clash is a second history line, so revisions are read, never counted). */
async function put(id: string, body: object): Promise<WorkspaceManifest> {
  const h = await head(id);
  const r = await api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: h.revision, by: "tester", ...body });
  expect(r.status).toBe(201);
  return head(id);
}
const create = (id: string, cutoffDate: string, type = "test") =>
  api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id, name: "A", type, cutoffDate, owner: "o", by: "tester" });
const readiness = async (id: string) => (await api<ReadinessReport>(t.base, "GET", `/api/workspaces/${id}/readiness`)).body;
const item = (r: ReadinessReport, section: string, name: string) => r.items.find((i) => i.section === section && i.item === name)!;
const validate = (id: string, slot: string) => api<{ outcome: string; consumed: ConsumedPins }>(t.base, "POST", `/api/workspaces/${id}/setups/${slot}/validate`, { by: "tester" });

/** A workspace that compiles: book, base market, one set (the default) and the routing policy, at the data's own date. */
async function ready(id: string, type = "test"): Promise<WorkspaceManifest> {
  expect((await create(id, "2026-03-31", type)).status).toBe(201);
  await put(id, { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
  await put(id, { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
  await put(id, { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  return put(id, { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
}

describe("readiness", () => {
  it("a blank workspace: every required item Not set, Scenarios Valid, Strategy optional, Assumptions Not set for the missing default", async () => {
    expect((await create("ws-rd-blank", "2026-03-31")).status).toBe(201);
    const r = await readiness("ws-rd-blank");
    // Section 3.5, in order: the table's thirteen rows and the Routing policy row (Studio Part 2 M6), fourteen.
    expect(r.items.map((i) => `${i.section}/${i.item}`)).toEqual([
      "market/Base snapshot",
      "market/Curves",
      "market/Vol surface",
      "market/Rate indices and derived markets",
      "balance/Positions",
      "balance/Chart of accounts",
      "balance/Strategy",
      "assumptions/Sets",
      "assumptions/Routing policy",
      "assumptions/Mapping",
      "run/Scenarios",
      "run/Run setups",
      "results/Newest result",
      "govern/Sign-off",
    ]);
    expect(item(r, "balance", "Positions").state).toBe("not-set");
    expect(item(r, "balance", "Positions").required).toBe(true);
    expect(item(r, "market", "Base snapshot").state).toBe("not-set");
    expect(item(r, "market", "Base snapshot").required).toBe(true);
    expect(item(r, "run", "Scenarios").state).toBe("valid");
    expect(item(r, "balance", "Strategy").state).toBe("not-set");
    expect(item(r, "balance", "Strategy").required).toBe(false);
    expect(item(r, "market", "Vol surface").required).toBe(false);
    expect(item(r, "assumptions", "Sets").state).toBe("not-set");
    expect(item(r, "assumptions", "Sets").required).toBe(true);
    expect(item(r, "assumptions", "Sets").detail).toMatch(/default/);
    // The create route pinned the seeded routing policy, so the new row is met and adds no blocker.
    expect(item(r, "assumptions", "Routing policy").state).toBe("valid");
    expect(item(r, "assumptions", "Routing policy").required).toBe(true);
    // Standard ALCO is saved and never validated: Draft.
    expect(item(r, "run", "Run setups").state).toBe("draft");
    expect(item(r, "run", "Run setups").required).toBe(true);
    // A chip is the worst counted item; an optional Not set never counts.
    expect(r.sections.balance).toBe("not-set");
    expect(r.sections.market).toBe("not-set");
    expect(r.sections.assumptions).toBe("not-set");
    expect(r.sections.run).toBe("draft");
    expect(r.sections.results).toBe("not-set");
    expect(r.sections.govern).toBe("not-set");
    const slot = Object.keys(r.launchable)[0]!;
    expect(r.launchable[slot]!.ok).toBe(false);
    // In WORKSPACE_ITEMS order, the three required Not set items and nothing else: the pinned policy blocks nothing.
    expect(r.launchable[slot]!.blocking).toEqual(["market/Base snapshot", "balance/Positions", "assumptions/Sets"]);
    expect(r.launchable[slot]!.blocking).not.toContain("balance/Strategy");
    expect(r.launchable[slot]!.acknowledgeable).toEqual([]);
  });

  it("a null routing policy is a required Not set item that names the fix and blocks the launch", async () => {
    const w = await ready("ws-rd-nopol");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    expect(item(await readiness("ws-rd-nopol"), "assumptions", "Routing policy").state).toBe("valid");
    expect(item(await readiness("ws-rd-nopol"), "assumptions", "Routing policy").detail).toBe(`Routing policy "${SEED_IDS.routingPolicy}" is attached.`);
    const bare = await put("ws-rd-nopol", { block: "assumptions", op: "remove", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
    expect(bare.blocks.assumptions.routingPolicy).toBeNull();
    const r = await readiness("ws-rd-nopol");
    const policy = item(r, "assumptions", "Routing policy");
    expect(policy.state).toBe("not-set");
    expect(policy.required).toBe(true);
    expect(policy.detail).toBe("Attach a routing policy; Validate refuses a setup without one.");
    expect(r.sections.assumptions).toBe("not-set");
    // Everything else on this workspace is met at the data's own date: the policy is the one blocker.
    expect(r.launchable[slot]!.ok).toBe(false);
    expect(r.launchable[slot]!.blocking).toEqual(["assumptions/Routing policy"]);
    expect(r.launchable[slot]!.acknowledgeable).toEqual([]);
  });

  it("escalation: a clash is Warning; Error and required Not set outrank it; a moved consumed pin is Stale; an unconsumed document moves nothing", async () => {
    // Cut-off one month after the data: both documents clash and warn.
    expect((await create("ws-rd", "2026-04-30")).status).toBe(201);
    await put("ws-rd", { block: "positions", op: "set", ref: { collection: "portfolios", id: SEED_IDS.vanillaPortfolio } });
    let r = await readiness("ws-rd");
    expect(item(r, "balance", "Positions").state).toBe("warning");
    expect(item(r, "balance", "Chart of accounts").state).toBe("valid");
    expect(r.sections.balance).toBe("warning");
    // The required Not set market item outranks the book's Warning in the launch list, and the chip says Not set.
    expect(r.sections.market).toBe("not-set");
    await put("ws-rd", { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    expect(item(await readiness("ws-rd"), "market", "Base snapshot").state).toBe("warning");
    expect(item(await readiness("ws-rd"), "market", "Curves").state).toBe("valid");
    await put("ws-rd", { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
    const w = await put("ws-rd", { block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    r = await readiness("ws-rd");
    expect(item(r, "assumptions", "Sets").state).toBe("valid");
    expect(item(r, "assumptions", "Mapping").state).toBe("valid");
    expect(item(r, "run", "Run setups").state).toBe("draft");

    const v = await validate("ws-rd", slot);
    expect(v.status).toBe(200);
    expect(v.body.outcome).toBe("warn");
    r = await readiness("ws-rd");
    expect(item(r, "run", "Run setups").state).toBe("warning");
    expect(r.sections.run).toBe("warning");
    expect(r.launchable[slot]!.ok).toBe(false);
    expect(r.launchable[slot]!.blocking).toEqual([]);
    expect(r.launchable[slot]!.acknowledgeable).toContain("balance/Positions");
    expect(r.launchable[slot]!.acknowledgeable).toContain("market/Base snapshot");
    // A setup validated with warnings is acknowledged under its own id, never the one Stale uses (review C m2).
    expect(r.launchable[slot]!.acknowledgeable).toContain("run/setup-warnings");
    expect(r.launchable[slot]!.acknowledgeable).not.toContain("run/setups");

    // An unconsumed lens moves nothing.
    const lens = (await api<Array<{ id: string }>>(t.base, "GET", "/api/lenses")).body[0]!.id;
    await put("ws-rd", { block: "run", op: "add", ref: { collection: "lens", id: lens } });
    expect(item(await readiness("ws-rd"), "run", "Run setups").state).toBe("warning");
    expect(item(await readiness("ws-rd"), "run", "Run setups").staleRoles).toBeUndefined();

    // Moving the default set: the setup consumed set:<vanilla>, which the block-default no longer resolves to.
    await put("ws-rd", { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: OTHER_SET } });
    await put("ws-rd", { block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: OTHER_SET } });
    r = await readiness("ws-rd");
    const setup = item(r, "run", "Run setups");
    expect(setup.state).toBe("stale");
    expect(setup.staleRoles).toEqual([
      { role: `set:${SEED_IDS.vanillaAssumptions}`, pinned: expect.stringMatching(/^[0-9a-f]{64}$/), current: null },
    ]);
    // Stale outranks Warning in the chip and stays acknowledgeable on a Test workspace.
    expect(r.sections.run).toBe("stale");
    expect(r.launchable[slot]!.blocking).toEqual([]);
    expect(r.launchable[slot]!.acknowledgeable).toContain("run/setups");
    expect(r.launchable[slot]!.acknowledgeable).not.toContain("run/setup-warnings");
  });

  it("validating again clears Stale and a Production workspace blocks on it", async () => {
    const w = await ready("ws-rd-prod", "production");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    // Slice three (decision 112): the Standard ALCO setup no longer warns, so a clean validation reads Valid.
    expect((await validate("ws-rd-prod", slot)).body.outcome).toBe("pass");
    let r = await readiness("ws-rd-prod");
    expect(item(r, "run", "Run setups").state).toBe("valid");
    expect(r.launchable[slot]!.blocking).toEqual([]);
    // The newest validation consumed the first set; the block default now resolves to another one.
    await put("ws-rd-prod", { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: OTHER_SET } });
    await put("ws-rd-prod", { block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: OTHER_SET } });
    r = await readiness("ws-rd-prod");
    expect(item(r, "run", "Run setups").state).toBe("stale");
    expect(r.launchable[slot]!.blocking).toEqual(["run/setups"]);
    expect(r.launchable[slot]!.acknowledgeable).not.toContain("run/setups");
    // Validate again: the roles are fresh and the chip falls back to the validation's own outcome.
    expect((await validate("ws-rd-prod", slot)).status).toBe(200);
    r = await readiness("ws-rd-prod");
    expect(item(r, "run", "Run setups").state).toBe("valid");
    expect(item(r, "run", "Run setups").staleRoles).toBeUndefined();
  });

  it("the rate-index check runs against the setup's own market role", async () => {
    expect((await create("ws-rd-idx", "2026-03-31")).status).toBe(201);
    await put("ws-rd-idx", { block: "positions", op: "set", ref: { collection: "portfolios", id: "synthetic-2500-indexed-v1" } });
    await put("ws-rd-idx", { block: "market", op: "set", ref: { collection: "market", id: SEED_IDS.market } });
    await put("ws-rd-idx", { block: "market", op: "add", ref: { collection: "market", id: "rate-indices-demo-v1" } });
    const r = await readiness("ws-rd-idx");
    const idx = item(r, "market", "Rate indices and derived markets");
    // Standard ALCO's role is base; the floaters' indices live on the derived market.
    expect(idx.state).toBe("error");
    expect(idx.detail).toMatch(/rate-indices-demo-v1/);
    expect(r.sections.market).toBe("error");
    expect(r.launchable[Object.keys(r.launchable)[0]!]!.blocking).toContain("market/Rate indices and derived markets");
  });

  it("a book without floaters needs no derived market: the item is Valid on the base market", async () => {
    const w = await ready("ws-rd-plain");
    expect(w.blocks.market.derived).toEqual([]);
    expect(item(await readiness("ws-rd-plain"), "market", "Rate indices and derived markets").state).toBe("valid");
  });

  it("Strategy is required only for a Custom basis and names the plan the targets block lacks", async () => {
    const w = await ready("ws-rd-strat");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    expect(item(await readiness("ws-rd-strat"), "balance", "Strategy").required).toBe(false);
    const setup = (await api<{ setups: Array<{ setup: Record<string, unknown> & { id: string; nii: object } }> }>(t.base, "GET", "/api/run-setups?workspaceId=ws-rd-strat")).body.setups[0]!.setup;
    const custom = { ...setup, id: undefined, supersedes: setup.id, nii: { ...setup.nii, basis: { kind: "custom", balancePlanId: "bp-not-in-block" } } };
    const saved = await api(t.base, "POST", "/api/run-setups", { workspaceId: "ws-rd-strat", setupLineageId: slot, expectedRevision: w.revision, by: "tester", setup: custom });
    expect(saved.status).toBe(201);
    const r = await readiness("ws-rd-strat");
    expect(item(r, "balance", "Strategy").required).toBe(true);
    expect(item(r, "balance", "Strategy").state).toBe("not-set");
    expect(item(r, "balance", "Strategy").detail).toMatch(/bp-not-in-block/);
    expect(r.launchable[slot]!.blocking).toContain("balance/Strategy");
  });

  it("Sign-off: Not set, Valid at the signed hash, Stale once a block moves on a Test workspace", async () => {
    const w = await ready("ws-rd-sign");
    expect(item(await readiness("ws-rd-sign"), "govern", "Sign-off").state).toBe("not-set");
    const signed = await api(t.base, "POST", "/api/workspaces/ws-rd-sign/sign-off", { expectedRevision: w.revision, by: "tester", signedHash: w.signedHash });
    expect(signed.status).toBe(200);
    expect(item(await readiness("ws-rd-sign"), "govern", "Sign-off").state).toBe("valid");
    const lens = (await api<Array<{ id: string }>>(t.base, "GET", "/api/lenses")).body[0]!.id;
    await put("ws-rd-sign", { block: "run", op: "add", ref: { collection: "lens", id: lens } });
    const r = await readiness("ws-rd-sign");
    expect(item(r, "govern", "Sign-off").state).toBe("stale");
    // Sign-off reports on the month, it never gates a launch.
    expect(Object.values(r.launchable).every((l) => !l.blocking.includes("govern/Sign-off") && !l.acknowledgeable.includes("govern/Sign-off"))).toBe(true);
  });

  it("Results: Draft while queued, Warning when errored or reconstructed, Valid when every pin is current, Stale when one moved", async () => {
    const w = await ready("ws-rd-res");
    const slot = w.blocks.run.setups[0]!;
    const v = await validate("ws-rd-res", slot.setupLineageId);
    const store = new FileStore(t.storeRoot);
    const slateMeta = store.getMeta("scenario-slates", SEED_IDS.vanillaSlate);
    // The run's `slate` role pins a launch slate the workspace never lists; it is compared with the stored document.
    const consumed: ConsumedPins = {
      ...v.body.consumed,
      slate: { collection: "scenario-slates", id: SEED_IDS.vanillaSlate, contentHash: slateMeta.contentHash, pinnedAt: "t" },
    };
    const wsStore = new WorkspaceStore(t.storeRoot);
    let n = 0;
    const attach = (state: string, pins: "consumed" | "reconstructed" = "consumed"): void => {
      n += 1;
      const runId = `run-20261009-00000${n}-00000a${n}`;
      store.writeRunJson(runId, "status.json", {
        runId, state, submittedAt: `2026-10-09T00:00:0${n}.000Z`, platformRequestHash: "x",
        summary: { portfolioId: SEED_IDS.vanillaPortfolio, marketId: SEED_IDS.market, scenarioSlateId: SEED_IDS.vanillaSlate, scenarioCount: 1, workspaceId: "ws-rd-res" },
      });
      store.writeRunJson(runId, "request.json", {
        workspace: { workspaceId: "ws-rd-res", setupLineageId: slot.setupLineageId, setupDocId: slot.current.id, launchNo: n, consumed },
      });
      wsStore.appendRunAttachment("ws-rd-res", { runId, attachedBy: "launch", at: `2026-10-09T00:00:0${n}.000Z`, setupLineageId: slot.setupLineageId, launchNo: n, pins });
    };
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("not-set");
    attach("queued");
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("draft");
    attach("running");
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("draft");
    attach("error");
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("warning");
    attach("cancelled");
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("warning");
    attach("done", "reconstructed");
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("warning");
    attach("done");
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("valid");
    // A document in no consumed role moves nothing.
    const lens = (await api<Array<{ id: string }>>(t.base, "GET", "/api/lenses")).body[0]!.id;
    await put("ws-rd-res", { block: "run", op: "add", ref: { collection: "lens", id: lens } });
    expect(item(await readiness("ws-rd-res"), "results", "Newest result").state).toBe("valid");
    // The default set moves: the consumed set role no longer resolves.
    await put("ws-rd-res", { block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: OTHER_SET } });
    await put("ws-rd-res", { block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: OTHER_SET } });
    const r = await readiness("ws-rd-res");
    const res = item(r, "results", "Newest result");
    expect(res.state).toBe("stale");
    expect(res.staleRoles!.map((s) => s.role)).toEqual([`set:${SEED_IDS.vanillaAssumptions}`]);
    // A stale result reports on the past; it never gates the next launch.
    expect(r.launchable[slot.setupLineageId]!.acknowledgeable).not.toContain("results/Newest result");
  });

  it("a clone replies with its readiness report, and a roll-forward shows what is Not set on the new date", async () => {
    await ready("ws-rd-src");
    const src = await head("ws-rd-src");
    const cloned = await api<{ manifest: WorkspaceManifest; readiness: ReadinessReport }>(t.base, "POST", "/api/workspaces/ws-rd-src/clone", {
      expectedRevision: src.revision,
      by: "tester",
      mode: "roll-forward",
      id: "ws-rd-next",
      name: "Next",
      cutoffDate: "2026-04-30",
      blocks: ["assumptions", "run"],
    });
    expect(cloned.status).toBe(201);
    const rr = cloned.body.readiness;
    expect(rr).not.toBeNull();
    // Book and snapshot are cleared on a roll-forward; the set and the policy carry.
    expect(item(rr, "balance", "Positions").state).toBe("not-set");
    expect(item(rr, "market", "Base snapshot").state).toBe("not-set");
    expect(item(rr, "assumptions", "Sets").state).toBe("valid");
    // The reply is the report GET readiness would give for the same head.
    expect(rr.items).toEqual((await readiness("ws-rd-next")).items);
  });

  // Last in the file on purpose: it moves the seeded policy out of the live store, which no later test may need.
  it("a pinned routing policy whose bytes were superseded is a required Error that names the document and blocks the launch", async () => {
    const w = await ready("ws-rd-polmoved");
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    expect(item(await readiness("ws-rd-polmoved"), "assumptions", "Routing policy").state).toBe("valid");
    new FileStore(t.storeRoot).supersedeDocument("routing-policies", SEED_IDS.routingPolicy, "stamp-rd-polmoved", sha256Hex(Buffer.from("a newer policy")));
    const r = await readiness("ws-rd-polmoved");
    const policy = item(r, "assumptions", "Routing policy");
    expect(policy.state).toBe("error");
    expect(policy.required).toBe(true);
    expect(policy.detail.startsWith(`Routing policy: pinned bytes of routing-policies "${SEED_IDS.routingPolicy}" were superseded`)).toBe(true);
    expect(r.launchable[slot]!.blocking).toContain("assumptions/Routing policy");
    expect(r.launchable[slot]!.ok).toBe(false);
  });
});
