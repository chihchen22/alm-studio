/**
 * Planting helpers for the workspace seed tests (Studio A+E plan Task D1).
 *
 * A freshly seeded store holds only seeded documents and no runs, while the author's store on
 * 2026-10-09 also held the documents the practitioner authored and twelve runs. `plantOwnerStore`
 * puts those back, from committed fixtures, so the migration table of spec Section 2.7 is pinned
 * without reading var/store:
 *
 *   fixtures/edited-store/        the stacked set, three balance plans, six edited run plans
 *   fixtures/seed-workspaces/     (this task) nine edited demo sets, the edited squeeze set, the edited
 *                                 regulatory grid slate, the 9-position sit-down book, and runs.json
 *
 * Verbatim copies except three things, each stated: the 25,000-position sit-down book is a copy of
 * the 9-position one under its own id (the migration rules read meta and ids, not positions), the
 * twelve runs are reduced to the fields the store mirror and the migration read (request, status),
 * and the launch slates `plan-<planId>` are copies of a seeded slate under the stored ids with the
 * `fromPlan` meta the plans route writes.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FileStore } from "../store/store";
import type { Collection } from "../store/paths";

const HERE = join(__dirname, "fixtures");

export interface FixtureRun {
  runId: string;
  portfolioId: string;
  marketId: string;
  scenarioSlateId: string;
  assumptionSetIds: string[];
  portfolioRef: { id: string; contentHash: string };
  asOf: string;
}

export function fixtureRuns(): FixtureRun[] {
  return JSON.parse(readFileSync(join(HERE, "seed-workspaces", "runs.json"), "utf8")) as FixtureRun[];
}

/** A store with no workspaces yet: what a store seeded before this task looks like. */
export function withoutWorkspaces(root: string): void {
  rmSync(join(root, "workspaces"), { recursive: true, force: true });
}

function putFixtures(store: FileStore, dir: string, collection: Collection): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as { id: string; label?: string; asOf?: string; positions?: unknown[] };
    if (store.has(collection, doc.id)) continue;
    store.putDocument(collection, doc.id, doc, {
      label: doc.label ?? doc.id,
      ...(collection === "portfolios" ? { asOf: doc.asOf, positionCount: doc.positions?.length ?? 0 } : {}),
    });
  }
}

/** Plant one run directory: request.json (reduced) and status.json. Never touches a document. */
export function plantRun(store: FileStore, r: FixtureRun, state: "error" | "cancelled" = "cancelled"): void {
  store.writeRunJson(r.runId, "request.json", {
    engineContext: { durationMode: "base-only", shards: 1 },
    request: { seed: 20260331, grid: { horizonMonths: 360, asOf: r.asOf } },
    portfolioRef: r.portfolioRef,
    mode: "deterministic",
    submission: {
      portfolioId: r.portfolioId,
      marketId: r.marketId,
      scenarioSlateId: r.scenarioSlateId,
      assumptionSetIds: r.assumptionSetIds,
      scenarios: [],
    },
  });
  store.writeRunJson(r.runId, "status.json", {
    runId: r.runId,
    state,
    submittedAt: "2026-10-09T00:00:00.000Z",
    platformRequestHash: "0".repeat(64),
    summary: { portfolioId: r.portfolioId, marketId: r.marketId, scenarioSlateId: r.scenarioSlateId, scenarioCount: 0 },
  });
}

/**
 * Plant the author's documents and runs of 2026-10-09 into a store that holds the seed. The
 * store's `workspaces/` directory should be removed first (`withoutWorkspaces`) so the
 * generator sees what the real migration saw.
 */
export function plantOwnerStore(root: string): void {
  const store = new FileStore(root);
  store.init();
  const edited = join(HERE, "edited-store");
  const mine = join(HERE, "seed-workspaces");

  putFixtures(store, join(edited, "assumption-sets"), "assumption-sets");
  putFixtures(store, join(edited, "plans"), "plans");
  putFixtures(store, join(mine, "assumption-sets"), "assumption-sets");
  putFixtures(store, join(mine, "scenario-slates"), "scenario-slates");
  putFixtures(store, join(mine, "portfolios"), "portfolios");

  // Edited run plans: id is planId, and they carry the meta the plans route writes (no `seeded`).
  for (const file of readdirSync(join(edited, "run-plans")).filter((f) => f.endsWith(".json")).sort()) {
    const plan = JSON.parse(readFileSync(join(edited, "run-plans", file), "utf8")) as { planId: string; label: string; inputs: { positionBook: string }; asOf: string };
    if (store.has("run-plans", plan.planId)) continue;
    store.putDocument("run-plans", plan.planId, plan, { label: plan.label, positionBook: plan.inputs.positionBook, asOf: plan.asOf });
  }

  // The 25k sit-down book, stood in by the 9-position sit-down book under its own id.
  const sit = JSON.parse(readFileSync(join(mine, "portfolios", "vanilla-sitdown-v1.json"), "utf8")) as { id: string; label: string; asOf: string; positions: unknown[] };
  if (!store.has("portfolios", "synthetic-25k-sitdown")) {
    store.putDocument(
      "portfolios",
      "synthetic-25k-sitdown",
      { ...sit, id: "synthetic-25k-sitdown", label: "Synthetic 25k (sit-down kill test)" },
      { label: "Synthetic 25k (sit-down kill test)", asOf: sit.asOf, positionCount: sit.positions.length },
    );
  }

  // The launch slates the twelve runs name, and the runs.
  const vanillaSlate = store.getDocument<{ id: string; label: string; scenarios: unknown[] }>("scenario-slates", "regulatory-grid-vanilla").doc;
  const runs = fixtureRuns();
  for (const r of runs) {
    if (store.has("scenario-slates", r.scenarioSlateId)) continue;
    store.putDocument(
      "scenario-slates",
      r.scenarioSlateId,
      { ...vanillaSlate, id: r.scenarioSlateId, label: `Scenarios of plan ${r.scenarioSlateId.replace(/^plan-/, "")}` },
      { label: `Scenarios of plan ${r.scenarioSlateId.replace(/^plan-/, "")}`, fromPlan: r.scenarioSlateId.replace(/^plan-/, "") },
    );
  }
  for (const r of runs) plantRun(store, r);
}
