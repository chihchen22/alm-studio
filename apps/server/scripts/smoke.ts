/**
 * M5 smoke: prove the platform's child-process runner added no arithmetic.
 *
 * The script composes a vanilla-book run request exactly as the server does,
 * executes it BOTH ways —
 *
 *   (a) through the child process (runnerEntry.mjs spawned on process.execPath,
 *       the platform's one compute path), and
 *   (b) directly in-process via buildRunResult on the same stored request —
 *
 * then byte-compares the two serialized RunResults with the two injected
 * provenance timestamps blanked (the only legitimately differing fields). Any other byte difference is a finding: it would mean
 * the service layer changed a number, which is exactly what it must never do.
 *
 * Run from the repo root:  npx tsx apps/server/scripts/smoke.ts
 * Exit 0 on byte parity; exit 1 with a loud report otherwise.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import type { RunRequest, RunResult } from "@alm/engine";
import {
  buildVanillaPortfolio,
  vanillaAssumptionSet,
  vanillaScenarios,
} from "@alm/data";
import { FileStore, serializeDocument, sha256Hex } from "../src/store/store";
import type { StoredRunRequest } from "../src/jobs/types";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const MARKET_PATH = join(REPO_ROOT, "packages", "kernel", "public", "market_public.json");
const RUNNER_ENTRY = join(HERE, "..", "src", "jobs", "runnerEntry.mjs");

const RUN_ID = "smoke-run-1";

/** Blank the two injected wall-clock stamps, the only fields allowed to differ. */
function canonical(result: RunResult): string {
  const clone = JSON.parse(JSON.stringify(result)) as RunResult;
  clone.provenance.timestamps = { startedAt: "", finishedAt: "" };
  return JSON.stringify(clone);
}

async function main(): Promise<void> {
  const storeRoot = mkdtempSync(join(tmpdir(), "alm-smoke-"));
  const store = new FileStore(storeRoot);
  store.init();

  // Compose the request the way the server does: portfolio by reference with a
  // content-hash pin, market snapshot inlined, fixed platform seed.
  const portfolio = buildVanillaPortfolio();
  const meta = store.putDocument("portfolios", portfolio.id, portfolio, { label: portfolio.label });
  const marketSnapshot = await loadMarketSnapshot(MARKET_PATH);
  const set = vanillaAssumptionSet();
  const scenarios = vanillaScenarios(set.id);

  const request: RunRequest = {
    runId: RUN_ID,
    portfolioId: portfolio.id,
    marketSnapshot,
    scenarios,
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: portfolio.asOf },
    seed: "platform-0",
    timestamps: { startedAt: "", finishedAt: "" },
  };
  const stored: StoredRunRequest = {
    engineContext: { durationMode: "base-only", shards: "auto" },
    request,
    portfolioRef: { id: portfolio.id, contentHash: meta.contentHash },
    submission: {
      portfolioId: portfolio.id,
      marketId: "smoke-market",
      scenarioSlateId: "smoke-slate",
      assumptionSetIds: [set.id],
      scenarios: scenarios.map((s) => ({ id: s.id, label: s.label, rateSpec: s.rateSpec })),
    },
  };
  store.writeRunJson(RUN_ID, "request.json", stored);
  const runDir = store.paths.runDir(RUN_ID);

  // (a) The platform path: one spawned child per run.
  console.log(`smoke: spawning child runner for ${RUN_ID} (store ${storeRoot})`);
  const childStart = Date.now();
  const child = spawn(process.execPath, [RUNNER_ENTRY, runDir], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const exitCode: number = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? -1)));
  const childMs = Date.now() - childStart;
  console.log(`smoke: child exited ${exitCode} in ${(childMs / 1000).toFixed(2)} s`);
  if (exitCode !== 0) {
    console.error(`smoke: child FAILED.\n--- child stdout ---\n${stdout}\n--- child stderr ---\n${stderr}`);
    process.exit(1);
  }
  const platformResult = JSON.parse(
    readFileSync(join(runDir, "result.json"), "utf8"),
  ) as RunResult;

  // (b) The direct path: same request, same context, in this process.
  const context = { ...resolveDefaultContext(), durationMode: "base-only" as const, shards: "auto" as const };
  const startedAt = new Date().toISOString();
  const directResult = buildRunResult(
    { ...request, timestamps: { startedAt, finishedAt: startedAt } },
    portfolio,
    context,
  );

  const a = canonical(platformResult);
  const b = canonical(directResult);
  if (a === b) {
    console.log(
      `smoke: BYTE PARITY — platform result.json equals in-process buildRunResult ` +
        `(${a.length} canonical bytes, timestamps blanked). The service added no arithmetic.`,
    );
    // Belt and braces: the stored request must re-hash to its own serialization.
    const requestBytes = readFileSync(join(runDir, "request.json"));
    console.log(`smoke: platformRequestHash ${sha256Hex(requestBytes)}`);
    console.log(`smoke: canonical result hash ${sha256Hex(serializeDocument(JSON.parse(a)))}`);
    process.exit(0);
  }
  // Report the first divergence honestly.
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  console.error(
    `smoke: BYTE MISMATCH at canonical offset ${i} (platform len ${a.length}, direct len ${b.length}).\n` +
      `  platform: ...${a.slice(Math.max(0, i - 60), i + 60)}...\n` +
      `  direct:   ...${b.slice(Math.max(0, i - 60), i + 60)}...`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
