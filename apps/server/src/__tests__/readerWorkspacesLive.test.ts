// apps/server/src/__tests__/readerWorkspacesLive.test.ts
// Studio A+E Slice 1, Task D3: the reader's workspace client against the real routes, so its types
// cannot drift from the server as built. Two guards in one file:
//
//  1. Compile time. Every type the reader copied is asserted equal to the server's own (the server
//     typecheck fails on a one-sided edit). The text diff in packages/reader is the second half.
//  2. Run time. Each reader function is called through a fetch shim onto a booted platform over a
//     seeded scratch store, and each reply's key set is restated here by hand, so a renamed or
//     dropped field on a route that no exported type covers fails here.
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { buildVanillaPortfolio } from "@alm/data";
import {
  ApiError,
  getNiiMonthly,
  importPortfolioJson,
  listPositions,
} from "../../../../packages/reader/src/api/client";
import * as R from "../../../../packages/reader/src/api/workspaces";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { CompareReply } from "../http/routes/workspaceCompare";
import type { RunStatus } from "../jobs/types";
import type { Collection } from "../store/paths";
import type { ReadinessItem, ReadinessReport, ReadinessState, SectionId, StaleRole } from "../workspaces/readiness";
import type { BlockOp } from "../workspaces/rules";
import type * as Srv from "../workspaces/types";
import type { Tuple } from "../workspaces/hashes";

// ---------------------------------------------------------------------------
// 1. Compile time: the copies are the server's types.
// ---------------------------------------------------------------------------

describe("type parity (checked by tsc; the assertions are no-ops at run time)", () => {
  it("the manifest, history, setup and event types equal the server's", () => {
    expectTypeOf<R.WorkspaceType>().toEqualTypeOf<Srv.WorkspaceType>();
    expectTypeOf<R.WorkspaceStatus>().toEqualTypeOf<Srv.WorkspaceStatus>();
    expectTypeOf<R.DocRef>().toEqualTypeOf<Srv.DocRef>();
    expectTypeOf<R.DerivedRef>().toEqualTypeOf<Srv.DerivedRef>();
    expectTypeOf<R.CarriedDefinition>().toEqualTypeOf<Srv.CarriedDefinition>();
    expectTypeOf<R.MarketBlock>().toEqualTypeOf<Srv.MarketBlock>();
    expectTypeOf<R.PositionsBlock>().toEqualTypeOf<Srv.PositionsBlock>();
    expectTypeOf<R.TargetsBlock>().toEqualTypeOf<Srv.TargetsBlock>();
    expectTypeOf<R.AssumptionsBlock>().toEqualTypeOf<Srv.AssumptionsBlock>();
    expectTypeOf<R.ScenarioBlock>().toEqualTypeOf<Srv.ScenarioBlock>();
    expectTypeOf<R.SetupSlot>().toEqualTypeOf<Srv.SetupSlot>();
    expectTypeOf<R.RunBlock>().toEqualTypeOf<Srv.RunBlock>();
    expectTypeOf<R.CutoffClash>().toEqualTypeOf<Srv.CutoffClash>();
    expectTypeOf<R.WorkspaceLock>().toEqualTypeOf<Srv.WorkspaceLock>();
    expectTypeOf<R.WorkspaceLineage>().toEqualTypeOf<Srv.WorkspaceLineage>();
    expectTypeOf<R.WorkspaceBlocks>().toEqualTypeOf<Srv.WorkspaceBlocks>();
    expectTypeOf<R.WorkspaceManifest>().toEqualTypeOf<Srv.WorkspaceManifest>();
    expectTypeOf<R.BlockName>().toEqualTypeOf<Srv.BlockName>();
    expectTypeOf<R.HistoryChange>().toEqualTypeOf<Srv.HistoryChange>();
    expectTypeOf<R.HistoryLine>().toEqualTypeOf<Srv.HistoryLine>();
    expectTypeOf<R.RunAttachment>().toEqualTypeOf<Srv.RunAttachment>();
    expectTypeOf<R.SetupInputs>().toEqualTypeOf<Srv.SetupInputs>();
    expectTypeOf<R.SetupScenarios>().toEqualTypeOf<Srv.SetupScenarios>();
    expectTypeOf<R.NiiBasis>().toEqualTypeOf<Srv.NiiBasis>();
    expectTypeOf<R.BasisSource>().toEqualTypeOf<Srv.BasisSource>();
    expectTypeOf<R.NiiSettings>().toEqualTypeOf<Srv.NiiSettings>();
    expectTypeOf<R.EveSettings>().toEqualTypeOf<Srv.EveSettings>();
    expectTypeOf<R.GapSettings>().toEqualTypeOf<Srv.GapSettings>();
    expectTypeOf<R.InstrumentResultSettings>().toEqualTypeOf<Srv.InstrumentResultSettings>();
    expectTypeOf<R.SetupPlanTemplate>().toEqualTypeOf<Srv.SetupPlanTemplate>();
    expectTypeOf<R.RunSetup>().toEqualTypeOf<Srv.RunSetup>();
    expectTypeOf<R.SetupEvent>().toEqualTypeOf<Srv.SetupEvent>();
    expectTypeOf<R.ConsumedRole>().toEqualTypeOf<Srv.ConsumedRole>();
    expectTypeOf<R.ConsumedPins>().toEqualTypeOf<Srv.ConsumedPins>();
  });

  it("the readiness, collection, block-op, compare and run-status types equal the server's", () => {
    expectTypeOf<R.ReadinessState>().toEqualTypeOf<ReadinessState>();
    expectTypeOf<R.SectionId>().toEqualTypeOf<SectionId>();
    expectTypeOf<R.StaleRole>().toEqualTypeOf<StaleRole>();
    expectTypeOf<R.ReadinessItem>().toEqualTypeOf<ReadinessItem>();
    expectTypeOf<R.ReadinessReport>().toEqualTypeOf<ReadinessReport>();
    expectTypeOf<R.Collection>().toEqualTypeOf<Collection>();
    expectTypeOf<R.BlockOp>().toEqualTypeOf<BlockOp>();
    expectTypeOf<R.WorkspaceCompareReply>().toEqualTypeOf<CompareReply>();
    expectTypeOf<R.WorkspaceCompareTuple>().toEqualTypeOf<Tuple>();
    expectTypeOf<R.WorkspaceRunStatus>().toEqualTypeOf<RunStatus>();
  });

  it("the setup events a reply embeds are the server's: launch-complete, and the launch reply built on it", () => {
    expectTypeOf<R.LaunchComplete>().toEqualTypeOf<Extract<Srv.SetupEvent, { t: "launch-complete" }>>();
    expectTypeOf<R.ValidateSetupReply["consumed"]>().toEqualTypeOf<Srv.ConsumedPins>();
    expectTypeOf<R.ValidateSetupReply["basisByScenario"]>().toEqualTypeOf<Record<string, Srv.BasisSource>>();
    expectTypeOf<R.RunSetupsReply["setups"][number]["setup"]>().toEqualTypeOf<Srv.RunSetup>();
  });
});

// ---------------------------------------------------------------------------
// 2. Run time: every function against the real routes.
// ---------------------------------------------------------------------------

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  // The client sends relative /api paths; the shim puts them on the booted platform.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => realFetch(url.startsWith("/") ? `${t.base}${url}` : url, init));
}, 300_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const keys = (o: object): string[] => Object.keys(o).sort();
const MANIFEST_KEYS = [
  "blockHashes", "blocks", "clashes", "createdAt", "cutoffDate", "id", "lineage", "lock", "manifestHash", "name",
  "note", "owner", "revision", "schemaVersion", "signedHash", "status", "type", "updatedAt",
];

describe("reader workspace client against the platform", () => {
  it("create, list, get, history, readiness and the setups list answer the shapes the reader declares", async () => {
    const w = await R.createWorkspace({ id: "ws-rdr-a", name: "Reader A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
    expect(keys(w)).toEqual(MANIFEST_KEYS);
    expect(w.revision).toBe(1);
    expect(keys(w.blocks)).toEqual(["assumptions", "market", "positions", "run", "scenarios", "targets"]);
    expect(keys(w.blockHashes)).toEqual(["assumptions", "market", "positions", "run", "scenarios", "targets"]);

    const listed = await R.listWorkspaces();
    expect(listed.map((m) => m.id)).toContain("ws-rdr-a");
    expect(keys(listed.find((m) => m.id === "ws-rdr-a")!)).toEqual(MANIFEST_KEYS);

    expect(await R.getWorkspace("ws-rdr-a")).toEqual(w);

    const hist = await R.getWorkspaceHistory("ws-rdr-a");
    expect(hist).toHaveLength(1);
    expect(keys(hist[0]!)).toEqual(["at", "by", "change", "manifest", "revision"]);
    expect(hist[0]!.change).toEqual({ kind: "create" });

    const rd = await R.getReadiness("ws-rdr-a");
    expect(keys(rd)).toEqual(["items", "launchable", "sections"]);
    expect(keys(rd.sections)).toEqual(["assumptions", "balance", "govern", "market", "results", "run", "workspace"]);
    expect(keys(rd.items[0]!)).toEqual(expect.arrayContaining(["detail", "item", "required", "section", "state"]));
    const slot = w.blocks.run.setups[0]!.setupLineageId;
    expect(keys(rd.launchable[slot]!)).toEqual(["acknowledgeable", "blocking", "ok"]);

    const setups = await R.listRunSetups("ws-rdr-a");
    expect(keys(setups)).toEqual(["missing", "setups"]);
    expect(setups.missing).toEqual([]);
    expect(keys(setups.setups[0]!)).toEqual(["setup", "slot"]);
    expect(setups.setups[0]!.setup.name).toBe("Standard ALCO");
    expect(await R.getRunSetup(setups.setups[0]!.setup.id)).toEqual(setups.setups[0]!.setup);
    expect(await R.listWorkspaceRuns("ws-rdr-a")).toEqual([]);
  });

  it("blocks, meta, positions and the setup save: bodies are accepted as sent and replies are the new head", async () => {
    const w = await R.createWorkspace({ id: "ws-rdr-b", name: "Reader B", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
    const imported = await importPortfolioJson(JSON.stringify({ ...buildVanillaPortfolio(), id: "rdr-book", label: "reader book" }));
    expect(imported.id).toBe("rdr-book");
    const withBook = await R.setBlock("ws-rdr-b", { expectedRevision: w.revision, by: "tester", block: "positions", op: "set", ref: { collection: "portfolios", id: "rdr-book" } });
    expect(withBook.revision).toBe(2);
    expect(withBook.blocks.positions.book?.id).toBe("rdr-book");

    const page = await listPositions("rdr-book", { q: "loan-", limit: 2, offset: 1 });
    expect(keys(page)).toEqual(["limit", "offset", "rows", "total"]);
    expect(page).toMatchObject({ total: 5, limit: 2, offset: 1 });
    expect(page.rows.map((r) => r.id)).toEqual(["loan-2", "loan-3"]);
    expect(keys(page.rows[0]!)).toEqual(["coaNodeId", "familyId", "id", "instrumentType", "maturityMonths", "notional"]);

    const renamed = await R.setMeta("ws-rdr-b", { expectedRevision: withBook.revision, by: "tester", name: "Reader B2", note: "n" });
    expect(renamed).toMatchObject({ name: "Reader B2", note: "n", revision: 3 });
    expect(renamed.signedHash).toBe(withBook.signedHash);

    const [{ slot, setup }] = (await R.listRunSetups("ws-rdr-b")).setups as [R.RunSetupListed];
    const { id: _id, ...body } = setup;
    const saved = await R.saveRunSetup({
      workspaceId: "ws-rdr-b",
      setupLineageId: slot.setupLineageId,
      expectedRevision: renamed.revision,
      by: "tester",
      setup: { ...body, name: "Runoff view", nii: { ...body.nii, basis: { kind: "runoff" } }, supersedes: setup.id },
    });
    expect(keys(saved)).toEqual(["manifest", "setup"]);
    expect(saved.setup.id).toMatch(/^rs-[0-9a-f]{16}$/);
    expect(saved.manifest.revision).toBe(4);
    expect(saved.manifest.blocks.run.setups[0]!.current.id).toBe(saved.setup.id);
  });

  it("validate, launch (refused, acknowledged), the run, its attachment row and the monthly NII reply", async () => {
    await R.createWorkspace({ id: "ws-rdr-run", name: "Reader run", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
    let rev = 1;
    const set = async (block: R.BlockName, op: R.BlockOp, collection: R.Collection, id: string) => {
      rev = (await R.setBlock("ws-rdr-run", { expectedRevision: rev, by: "tester", block, op, ref: { collection, id } })).revision;
    };
    await set("positions", "set", "portfolios", SEED_IDS.vanillaPortfolio);
    await set("market", "set", "market", SEED_IDS.market);
    await set("assumptions", "add", "assumption-sets", SEED_IDS.vanillaAssumptions);
    await set("assumptions", "set", "routing-policies", SEED_IDS.routingPolicy);
    const head = await R.getWorkspace("ws-rdr-run");
    const slot = head.blocks.run.setups[0]!.setupLineageId;
    // Slice three (decision 112): the Standard ALCO setup no longer warns, so the slot is saved onto a setting that
    // still does (EVE valuation at later dates, reserved for piece D; the fixed-rate ladder is honoured now) to
    // exercise the gate.
    const [{ setup }] = (await R.listRunSetups("ws-rdr-run")).setups as [R.RunSetupListed];
    const { id: _id, ...body } = setup;
    await R.saveRunSetup({
      workspaceId: "ws-rdr-run",
      setupLineageId: slot,
      expectedRevision: head.revision,
      by: "tester",
      setup: { ...body, eve: { ...body.eve, valuationDates: "every-12-months" }, supersedes: setup.id },
    });

    const v = await R.validateSetup("ws-rdr-run", slot, { by: "tester" });
    expect(keys(v)).toEqual(["basisByScenario", "basisLabel", "compiledChain", "consumed", "outcome", "planId", "reports", "skippedFamilies"]);
    expect(v.outcome).toBe("warn");
    expect(v.basisLabel).toBe("Flat (simple top-up)");
    expect(keys(v.reports)).toEqual(["notImplemented", "readiness", "routing", "type", "warnings"]);
    expect(v.compiledChain.length).toBeGreaterThan(0);
    expect(typeof v.planId).toBe("string");

    // The gate: the setup's warning must be acknowledged. The refusal's lists ride on ApiError.body.
    const refused = await R.launchSetup("ws-rdr-run", slot, { by: "tester" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    const gate = (refused as ApiError).body as R.LaunchGateRefusal;
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).code).toBe("acknowledge-required");
    expect(keys(gate)).toEqual(["acknowledgeable", "blocking", "error", "staleRoles"]);
    expect(gate.acknowledgeable).toEqual([R.RUN_SETUP_WARNINGS_ITEM]);

    const launched = await R.launchSetup("ws-rdr-run", slot, { by: "tester", acknowledge: gate.acknowledgeable });
    expect(keys(launched)).toEqual(["at", "failed", "launchNo", "runIds", "setupLineageId", "t"]);
    expect(launched).toMatchObject({ t: "launch-complete", launchNo: 1, failed: [] });
    expect(launched.runIds).toHaveLength(1);
    const runId = launched.runIds[0]!;

    // A setup with no batch rows refuses a batch launch with a typed 422.
    const noBatch = await R.launchSetup("ws-rdr-run", slot, { by: "tester", acknowledge: gate.acknowledgeable, batch: true }).catch((e: unknown) => e);
    expect((noBatch as ApiError).status).toBe(422);

    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 120_000);
    expect(done.body.state).toBe("done");

    const rows = await R.listWorkspaceRuns("ws-rdr-run");
    const row = rows.find((r) => r.runId === runId)!;
    expect(keys(row)).toEqual(["at", "attachedBy", "basisLabel", "launchNo", "pins", "runId", "setupLineageId", "status"]);
    expect(row).toMatchObject({ attachedBy: "launch", pins: "consumed", launchNo: 1, setupLineageId: slot, basisLabel: "Flat (simple top-up)" });
    expect(keys(row.status!)).toEqual(
      expect.arrayContaining(["platformRequestHash", "runId", "state", "submittedAt", "summary"]),
    );
    expect(row.status!.summary.workspaceId).toBe("ws-rdr-run");

    const nii = await getNiiMonthly(runId);
    expect(nii.kind).toBe("monthly");
    if (nii.kind === "monthly") {
      // The monthly reply carries the additive chart `coa`.
      expect(keys(nii)).toEqual(["byScenario", "coa", "horizonMonths", "kind"]);
      expect(keys(nii.byScenario[0]!)).toEqual(["byFamily", "expense", "income", "net", "scenarioId"]);
      expect(keys(nii.byScenario[0]!.byFamily[0]!)).toEqual(["expense", "familyId", "income", "net", "side"]);
    }
  }, 240_000);

  it("clone, compare, sign-off, archive and reapply answer as declared; a refusal is an ApiError with the server's body", async () => {
    const w = await R.createWorkspace({ id: "ws-rdr-c", name: "Reader C", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester" });
    const cloned = await R.cloneWorkspace("ws-rdr-c", { expectedRevision: w.revision, by: "tester", mode: "copy", id: "ws-rdr-c-copy", name: "Reader C copy", blocks: ["run", "assumptions"] });
    expect(keys(cloned)).toEqual(["manifest", "readiness"]);
    expect(cloned.manifest.id).toBe("ws-rdr-c-copy");
    expect(cloned.manifest.lineage).toMatchObject({ mode: "copy", fromWorkspaceId: "ws-rdr-c" });
    expect(keys(cloned.readiness)).toEqual(["items", "launchable", "sections"]);

    const cmp = await R.compareWorkspaces("ws-rdr-c", "ws-rdr-c-copy");
    expect(keys(cmp)).toEqual(["a", "b", "blocks"]);
    expect(keys(cmp.a)).toEqual(["cutoffDate", "id", "name", "revision", "signedHash", "status", "type"]);
    // A blank workspace pins the seeded routing policy at create, so the assumptions block is not empty
    // and the clone carries it only when the checklist names the block.
    expect(cmp.blocks.assumptions.verdict).toBe("same");
    expect(keys(cmp.blocks)).toEqual(["assumptions", "market", "positions", "run", "scenarios", "targets"]);

    // A Test workspace keeps its record and stays active (ruling 13): the reply is the unchanged head.
    const signed = await R.signOffWorkspace("ws-rdr-c", { expectedRevision: w.revision, by: "signer", signedHash: w.signedHash });
    expect(signed.status).toBe("active");
    expect(signed.revision).toBe(w.revision);

    const stale = await R.signOffWorkspace("ws-rdr-c", { expectedRevision: w.revision, by: "signer", signedHash: "0".repeat(64) }).catch((e: unknown) => e);
    expect((stale as ApiError).status).toBe(409);

    const reapply = await R.reapplyMarket("ws-rdr-c", { expectedRevision: w.revision, by: "tester" }).catch((e: unknown) => e);
    expect((reapply as ApiError).status).toBe(422);

    const archived = await R.archiveWorkspace("ws-rdr-c", { expectedRevision: w.revision, by: "tester", note: "done" });
    expect(archived).toMatchObject({ status: "archived", note: "done" });
    const blocked = await R.setMeta("ws-rdr-c", { expectedRevision: archived.revision, by: "tester", name: "x" }).catch((e: unknown) => e);
    expect((blocked as ApiError).status).toBe(409);
  });

  it("an unknown workspace and an unknown run are typed 404s", async () => {
    const a = await R.getWorkspace("ws-rdr-none").catch((e: unknown) => e);
    expect((a as ApiError).status).toBe(404);
    const b = await getNiiMonthly("run-0000").catch((e: unknown) => e);
    expect((b as ApiError).status).toBe(404);
  });
});
