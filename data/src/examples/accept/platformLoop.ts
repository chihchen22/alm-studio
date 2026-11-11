/**
 * Acceptance check: platform-service-loop.
 *
 * Anchor: HASH PARITY against the
 * in-process engine. The platform's one compute path is a spawned child
 * process; this check replicates the M5 smoke inside the battery:
 * store the vanilla request in a scratch file store, spawn the REAL child
 * runner (`runnerEntry.mjs` on process.execPath — the exact bootstrap the
 * platform uses), read the result.json it lands atomically, and byte-compare
 * its canonical serialization (timestamps blanked, the limitations page
 * convention) against `buildRunResult` on the same request in this process.
 * Any divergence means the service layer computed or mutated — which it must
 * never do. The HTTP routes over this path are contract-tested in the
 * apps/server suite; the compute-parity anchor is here.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadMarketSnapshot } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext, type RunRequest, type RunResult } from "@alm/engine";
import { FileStore } from "../../../../apps/server/src/store/store";
import type { StoredRunRequest } from "../../../../apps/server/src/jobs/types";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../../vanilla";
import type { CapabilityCheck, CheckLine } from "./types";

const RUN_ID = "accept-platform-1";
const CHILD_TIMEOUT_MS = 120_000;

/** Blank the two injected wall-clock stamps (the only fields allowed to differ). */
function canonical(result: RunResult): string {
  const clone = JSON.parse(JSON.stringify(result)) as RunResult;
  clone.provenance.timestamps = { startedAt: "", finishedAt: "" };
  return JSON.stringify(clone);
}

export const platformLoopCheck: CapabilityCheck = {
  capabilityId: "platform-service-loop",
  title: "Platform service loop: child runner adds no arithmetic",
  async run({ repoRoot }) {
    const lines: CheckLine[] = [];
    const storeRoot = mkdtempSync(join(tmpdir(), "alm-accept-loop-"));
    try {
      const store = new FileStore(storeRoot);
      store.init();
      const portfolio = buildVanillaPortfolio();
      const meta = store.putDocument("portfolios", portfolio.id, portfolio, { label: portfolio.label });
      const market = await loadMarketSnapshot(
        resolve(repoRoot, "packages/kernel/public/market_public.json"),
      );
      const set = vanillaAssumptionSet();
      const scenarios = vanillaScenarios(set.id);
      const request: RunRequest = {
        runId: RUN_ID,
        portfolioId: portfolio.id,
        marketSnapshot: market,
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
          marketId: "accept-market",
          scenarioSlateId: "accept-slate",
          assumptionSetIds: [set.id],
          scenarios: scenarios.map((s) => ({ id: s.id, label: s.label, rateSpec: s.rateSpec })),
        },
      };
      store.writeRunJson(RUN_ID, "request.json", stored);
      const runDir = store.paths.runDir(RUN_ID);

      const runnerEntry = resolve(repoRoot, "apps/server/src/jobs/runnerEntry.mjs");
      const child = spawn(process.execPath, [runnerEntry, runDir], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.stdout.on("data", () => undefined); // protocol lines; parity is judged on bytes on disk
      const exitCode: number = await new Promise((resolveExit) => {
        const timer = setTimeout(() => {
          child.kill();
          resolveExit(-2);
        }, CHILD_TIMEOUT_MS);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolveExit(code ?? -1);
        });
      });
      if (exitCode !== 0) {
        lines.push({
          id: "child-run",
          status: "fail",
          detail: `child runner exited ${exitCode}${exitCode === -2 ? " (timeout)" : ""}; stderr: ${stderr.slice(0, 400)}`,
        });
        return { lines, observedNotImplemented: [] };
      }
      const platformResult = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as RunResult;
      lines.push({
        id: "child-run",
        status: "pass",
        detail:
          `the real platform child (runnerEntry.mjs on process.execPath) ran the stored vanilla ` +
          `request and landed result.json atomically in a scratch store (anchor: the platform's ` +
          `one compute path, exercised for real — not a mock)`,
      });

      const direct = buildRunResult(
        { ...request, timestamps: { startedAt: "x", finishedAt: "x" } },
        portfolio,
        { ...resolveDefaultContext(), durationMode: "base-only", shards: "auto" },
      );
      const a = canonical(platformResult);
      const b = canonical(direct);
      const hash = createHash("sha256").update(a).digest("hex");
      lines.push({
        id: "byte-parity",
        status: a === b ? "pass" : "fail",
        detail:
          a === b
            ? `platform result.json === in-process buildRunResult, ${a.length.toLocaleString("en-US")} ` +
              `canonical bytes (timestamps blanked), SHA-256 ${hash.slice(0, 16)}... (anchor: the ` +
              `transport added no arithmetic — byte identity, the design Section 2.8 standard)`
            : `BYTE MISMATCH: platform ${a.length} bytes vs direct ${b.length} bytes — the service layer changed a number`,
      });
      return {
        lines,
        observedNotImplemented: platformResult.notImplemented.map((t) => t.layer),
      };
    } finally {
      try {
        rmSync(storeRoot, { recursive: true, force: true });
      } catch {
        // Windows file locking (McAfee); the OS temp cleaner owns the leftovers.
      }
    }
  },
};
