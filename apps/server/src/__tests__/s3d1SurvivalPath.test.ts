/**
 * The survival path on Quillfield Bank version 1.3.
 *
 *  1. Version 1.3's liquidity values are the ones the data note states (restated here by hand), and both core profiles
 *     plan the survival-path setup after the documents and before the hierarchy; the setup is canonical, carries
 *     the corrected convention, leaves the buffer to the HQLA tags and reads every bank value from the file.
 *  2. On a fresh starter store the demo is listed after the others, opens on the Example bank workspace the way the
 *     Studio card does and runs to done; the accept check's in-process runner equals the launched run's every block.
 *  3. The run exports liquidity-stress.csv and survival-path.csv; compare refuses both with a sentence.
 *  4. The run-setups parse gate keeps a 1.9.0 liquidity opt-in's bytes and drops a key it does not know.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortfolioSpec, RunResult } from "@alm/engine";
import { loadMarketSnapshot } from "@alm/kernel";
import { planDepositFormDocuments, planSeedDocuments, planSurvivalPathDocuments, seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { DEMO_BOOK_ID, DEMO_SET_IDS, type FeatureDemoRow } from "../examples/featureDemos";
import { survivalPathDemos } from "../examples/survivalPathDemo";
import { FileStore } from "../store/store";
import type { RunStatus } from "../jobs/types";
import type { ReadinessReport } from "../workspaces/readiness";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { runSetupIdOf } from "../workspaces/standardAlco";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { runSurvivalPathDemo } from "../../../../data/src/examples/accept/survivalPathRuns";

const ROOT = repoRoot();
const bank = JSON.parse(readFileSync(join(ROOT, "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec & {
  liquidity: { receivedFacilities: Array<{ label: string; capacity: number; haircut: number }>; cdRenewal: Record<string, number> };
};

describe("Quillfield Bank version 1.3 and the survival-path setup", () => {
  it("carries the liquidity values the data note states: the CDs a term deposit, five HQLA levels, Ubar and U99 on the line, the FHLB line, the CD renewal", () => {
    expect(bank.label).toContain("version 1.3");
    const dims = (id: string) => bank.positions.find((p) => p.id === id)!.dimensions;
    expect(dims("mb-cds-1")).toEqual({ liquidityRole: "term-deposit" });
    expect(["mb-cash-1", "mb-ust-2y", "mb-ust-5y", "mb-agency-3y", "mb-mbs-1"].map((id) => dims(id)?.["hqla-level"])).toEqual(["l1", "l1", "l1", "l2a", "l2a"]);
    // Interest checking stays in the transactional pool.
    expect(dims("mb-intchk-1")).toEqual({ liquidityRole: "nib-pool" });
    const line = bank.positions.find((p) => p.id === "mb-lines-1") as unknown as { commitmentDials: unknown; terms: { notional: number } };
    expect(line.commitmentDials).toEqual({ expectedUtilization: 0.15, tailUtilization: 0.35 });
    expect(line.terms.notional).toBe(1_000_000_000);
    expect(bank.liquidity.receivedFacilities).toEqual([{ id: "mb-fhlb-capacity", label: "FHLB borrowing capacity, unused", capacity: 500_000_000, haircut: 0.2 }]);
    expect(bank.liquidity.cdRenewal).toEqual({ bau: 0.9, moderate: 0.6, severe: 0.3 });
    const tax = bank.taxonomy!.dimensions;
    expect(tax.find((d) => d.id === "liquidityRole")!.values).toContain("term-deposit");
    expect(tax.find((d) => d.id === "hqla-level")!.values).toEqual(["l1", "l2a", "l2b"]);
  });

  it("is one setup, planned after S3c-1's documents and before the hierarchy in both core profiles", async () => {
    const own = planSurvivalPathDocuments(ROOT);
    expect(own.map((d) => d.collection)).toEqual(["run-setups"]);
    const s3c = planDepositFormDocuments(ROOT).map((d) => `${d.collection}/${d.id}`);
    for (const profile of ["demo", "starter"] as const) {
      const keys = (await planSeedDocuments(ROOT, profile)).map((d) => `${d.collection}/${d.id}`);
      expect(keys[keys.indexOf(s3c[s3c.length - 1]!) + 1], profile).toBe(`run-setups/${own[0]!.id}`);
      expect(keys[keys.length - 1], profile).toBe("hierarchies/liquidity-funding-demo-v1");
    }
  }, 60_000);

  it("is canonical, on the corrected convention, its buffer left to the tags and every bank value read from the file", () => {
    const d = survivalPathDemos(ROOT)[0]!;
    const { id, ...body } = d.setup;
    expect(parseRunSetup(JSON.parse(JSON.stringify(body)))).toEqual(body);
    expect(runSetupIdOf(body)).toBe(id);
    expect(d.lineageId).toBe("demo-survival-path");
    expect(d.setIds).toEqual([DEMO_SET_IDS.illustrative]);
    expect(d.setup.modelConvention).toBe("corrected-v1");
    const ls = d.setup.liquidityStress!;
    expect("buffer" in ls).toBe(false);
    expect([ls.table.bau.cdRenewal, ls.table.moderate.cdRenewal, ls.table.severe.cdRenewal]).toEqual([0.9, 0.6, 0.3]);
    expect(ls.undrawnFace).toBe(1_000_000_000);
    // S3d fix round (ruling 2026-11-05): the dials carry no amount; they read the $1,000M undrawn face as undrawn now.
    expect(ls.dials).toEqual({ expectedUtilization: 0.15, tailUtilization: 0.35, fundingSpreadBp: 50, lcrFactor: 0.1, thirtyDayShare: 1 / 12 });
    expect(ls.survivalPath).toEqual({ horizonMonths: 24, facility: { label: "FHLB borrowing capacity, unused", capacity: 500_000_000, haircut: 0.2 } });
  });

  it("the run-setups parse gate keeps a 1.9.0 opt-in's bytes and drops a key it does not know", () => {
    const d = survivalPathDemos(ROOT)[0]!;
    const { id: _id, ...body } = d.setup;
    const v19 = { table: { bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0 }, moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12 }, severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25 } }, buffer: 1, undrawnFace: 2 };
    expect(JSON.stringify(parseRunSetup({ ...body, liquidityStress: v19 }).liquidityStress)).toBe(JSON.stringify(v19));
    expect(parseRunSetup({ ...body, liquidityStress: { ...v19, extra: true, survivalPath: { horizonMonths: 36, junk: 1 } } }).liquidityStress).toEqual({ ...v19, survivalPath: { horizonMonths: 36 } });
    expect(() => parseRunSetup({ ...body, liquidityStress: { ...v19, survivalPath: { horizonMonths: 6 } } })).toThrow(/survivalPath.horizonMonths must be a whole number of months from 12 to 120, got 6/);
  });
});

describe("on a fresh starter store", () => {
  let tp: TestPlatform;
  beforeAll(async () => {
    tp = await bootTestPlatform();
    await seedStore(new FileStore(tp.storeRoot), ROOT, { mode: "seed" }, "starter");
  }, 120_000);
  afterAll(async () => {
    await tp.close();
  });

  it("lists the demo last for the bank, opens it the way the card does, runs it to done, and the in-process runner is the launch", async () => {
    const d = survivalPathDemos(ROOT)[0]!;
    const q = await api<{ demos: FeatureDemoRow[] }>(tp.base, "GET", `/api/guided/examples/${DEMO_BOOK_ID}/demos`);
    expect(q.body.demos[q.body.demos.length - 1]).toEqual({ id: d.id, title: d.title, lineageId: d.lineageId, setupId: d.setup.id, setIds: d.setIds, stored: true });
    const ws = "ws-example-bank";
    expect((await api(tp.base, "POST", "/api/portfolios/import", bank)).status).toBe(201);
    let w = (await api<WorkspaceManifest>(tp.base, "POST", "/api/workspaces", { id: ws, name: "Example bank", type: "test", cutoffDate: bank.asOf, owner: "Learner", by: "Learner" })).body;
    for (const body of [
      { block: "market", op: "set", ref: { collection: "market", id: "market-public-2026-03-31" } },
      { block: "positions", op: "set", ref: { collection: "portfolios", id: bank.id } },
      ...d.setIds.map((s) => ({ block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: s } })),
    ]) {
      const r = await api<WorkspaceManifest>(tp.base, "POST", `/api/workspaces/${ws}/blocks`, { expectedRevision: w.revision, by: "Learner", ...body });
      expect(r.status, r.text.slice(0, 400)).toBe(201);
      w = r.body;
    }
    const seeded = (await api<RunSetup>(tp.base, "GET", `/api/run-setups/${d.setup.id}`)).body;
    const { id: _id, ...body } = seeded;
    const sr = await api<{ setup: RunSetup }>(tp.base, "POST", "/api/run-setups", { workspaceId: ws, setupLineageId: d.lineageId, expectedRevision: w.revision, by: "Learner", setup: body });
    expect(sr.status, sr.text.slice(0, 400)).toBe(201);
    expect(sr.body.setup.id).toBe(d.setup.id);
    const gate = (await api<ReadinessReport>(tp.base, "GET", `/api/workspaces/${ws}/readiness`)).body.launchable[d.lineageId]!;
    expect(gate.blocking).toEqual([]);
    expect(gate.acknowledgeable).toEqual([]);
    const l = await api<{ runIds: string[] }>(tp.base, "POST", `/api/workspaces/${ws}/setups/${d.lineageId}/launch`, { by: "Learner", acknowledge: [] });
    expect(l.status, l.text.slice(0, 400)).toBe(200);
    const runId = l.body.runIds[0]!;
    const st = await waitFor(() => api<RunStatus>(tp.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 540_000, 500);
    expect(st.body.state, JSON.stringify(st.body).slice(0, 600)).toBe("done");
    const launched = JSON.parse(readFileSync(join(tp.storeRoot, "runs", runId, "result.json"), "utf8")) as RunResult & Record<string, unknown>;
    expect(launched.schemaVersion).toBe("1.13.0");
    const market = await loadMarketSnapshot(join(ROOT, "packages", "kernel", "public", "market_public.json"));
    const own = runSurvivalPathDemo(ROOT, market).result as RunResult & Record<string, unknown>;
    const keys = Object.keys(launched).filter((k) => k !== "provenance").sort();
    expect(Object.keys(own).filter((k) => k !== "provenance").sort()).toEqual(keys);
    for (const k of keys) expect(JSON.stringify(own[k]), k).toBe(JSON.stringify(launched[k]));
    const sp = launched.liquidityStress!.survivalPath!;
    expect(sp.horizonMonths).toBe(24);
    expect(sp.ladderBuffer.survivalMonths).not.toBeNull();

    // The two liquidity tables export; compare refuses them with a sentence.
    const csv = await api(tp.base, "GET", `/api/runs/${runId}/export/survival-path.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("rowType,month,scenarioId,days");
    expect(csv.text).toContain("with-facility");
    const ladder = await api(tp.base, "GET", `/api/runs/${runId}/export/liquidity-stress.csv`);
    expect(ladder.status).toBe(200);
    expect(ladder.text).toContain("buffer-position");
    const cmp = await api(tp.base, "GET", `/api/compare.csv?runs=${runId},${runId}&table=survival-path`);
    expect(cmp.status).toBe(400);
    expect(cmp.text).toContain("not compared across runs yet");
    console.log(`S3d-1 demo run: ${runId}`);
  }, 900_000);
});
