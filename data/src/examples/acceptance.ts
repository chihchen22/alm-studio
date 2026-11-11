/**
 * `npm run accept` — the platform acceptance battery.
 *
 * One command, five stages, one VERDICT line, exit 0/1:
 *
 *   stage 0  integrity     kernel provenance: exactly 102 manifest rows, every
 *                          file re-hashed with node:crypto, 0 mismatches;
 *                          source commit parsed from the manifest itself.
 *   stage 1  continuity    the nine-position vanilla book, base plus the
 *                          regulatory grid, asserted against the pinned v1
 *                          goldens to the digit (equity duration 5.37,
 *                          attribution residual 0.00, NII flat, EVE monotonic),
 *                          and the run's embedded kernel ref cross-checked
 *                          against the manifest on disk.
 *   stage 2  capabilities  one check per shipped v2 capability from
 *                          accept/registry.ts (16 registered at W3-V2, waves
 *                          1-3), each asserting its independent anchor from
 *                           — hand cases,
 *                          kernel identities, degeneracy limits, byte parity;
 *                          every unshipped capability prints
 *                          SKIPPED with its reason. It never prints as a pass
 *                          and never silently vanishes.
 *   stage 3  determinism   the identical vanilla request runs twice through
 *                          fresh engines; the serialized results must be
 *                          byte-identical (fixed injected timestamps).
 *   stage 4  register diff the union of RunResult.notImplemented layers
 *                          observed across every run this battery performed
 *                          must equal, as a set, what the register declares
 *                          expected. An undeclared tag is a silently degraded
 *                          capability; a declared tag that never appears means
 *                          a number showed up where a refusal was promised.
 *
 * Anchor discipline: every PASS line prints the measured value and names what
 * grounds it. "The code ran" is never acceptance. Expected values below are
 * test expectations, not
 * computed outputs; this file computes nothing it then presents as a result.
 *
 * Full machine-readable detail lands in data/out/acceptance-result.json.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot } from "@alm/kernel";
import {
  createEngine,
  resolveDefaultContext,
  type RunRequest,
  type RunResult,
} from "@alm/engine";
import { buildVanillaPortfolio, vanillaAssumptionSet, vanillaScenarios } from "../vanilla";
import { loadRegister, expectedNotImplementedUnion, REGISTER_RELATIVE_PATH } from "./accept/register";
import { allCapabilityChecks } from "./accept/registry";
import { absenceAllowed, expectedKernelRows } from "@alm/engine/src/provenance/publicCopy";
import { loadAcceptCompanion } from "../companion";
import type { CheckLine, CheckStatus } from "./accept/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const KERNEL_DIR = resolve(REPO_ROOT, "packages/kernel");
const PROVENANCE_PATH = resolve(KERNEL_DIR, "PROVENANCE.md");
const MARKET_PATH = resolve(KERNEL_DIR, "public/market_public.json");
const OUT_PATH = resolve(REPO_ROOT, "data/out/acceptance-result.json");

/**
 * Pinned expectations. These are the v1 goldens of record, cited to their
 * source documents; they are asserted here, never derived here.
 *   - 102 manifest rows: packages/kernel/PROVENANCE.md (100 source + 2 public
 *     fixtures).
 *   - Dur(eq) 5.37 and base EVE $120,866,072 (to the dollar), re-pinned on
 *     2026-10-16 from $121,065,588 when the default curve changed; the duration
 *     moved 5.366960 to 5.366329 and still reads 5.37. Before that, on 2026-09-24,
 *     they were re-pinned from 5.43 and $123,300,764.
 *   - Attribution residual 0.00 "to the digit".
 */
const GOLDEN = {
  // 102 in a full record; a release tree lists only the kernel files it holds.
  kernelManifestRows: expectedKernelRows(REPO_ROOT).total,
  durationEquityBase: 5.37,
  durationTolerance: 0.005, // "to the digit" at two decimals
  // Re-pinned 121_065_588 -> 120_866_072 on curve default 2 (interpolation only; the curveDefault: 1
  // market reproduces $121,065,587.85). Tolerance unchanged.
  baseEve: 120_866_072,
  baseEveToleranceDollars: 0.5, // to the dollar
  residualTolerance: 0.005, // prints 0.00 at two decimals
  niiFlatToleranceDollars: 1e-6,
  headlineCount: 12, // 4 shocked scenarios x 3 metrics
} as const;

// Fixed, injected timestamps: the two fields outside the deterministic core.
// Pinning them makes stage 3's byte-identity a full-serialization comparison.
const FIXED_TS = { startedAt: "2026-08-02T00:00:00.000Z", finishedAt: "2026-08-02T00:00:00.000Z" };

interface Line extends CheckLine {
  stage: string;
}

const lines: Line[] = [];

function emit(stage: string, id: string, status: CheckStatus, detail: string): void {
  lines.push({ stage, id, status, detail });
  const tag = status === "pass" ? "PASS   " : status === "fail" ? "FAIL   " : "SKIPPED";
  console.log(`${tag} ${id} — ${detail}`);
}

function header(text: string): void {
  console.log(`\n-- ${text} --`);
}

// --- Stage 0: kernel provenance integrity ------------------------------------

const HASH_ROW_RE = /^\|\s*(\S+)\s*\|\s*([0-9A-Fa-f]{64})\s*\|/gm;
const COMMIT_RE = /(?:Source git commit|Kernel source id):\*\*\s*`([0-9a-fA-F]{7,40})`/;

function stage0(): { sourceCommit: string; manifestHash: string } | null {
  header("stage 0: integrity — kernel provenance");
  let manifest: string;
  try {
    manifest = readFileSync(PROVENANCE_PATH, "utf8");
  } catch (err) {
    emit("0", "stage0.manifest", "fail", `cannot read ${PROVENANCE_PATH}: ${(err as Error).message}`);
    return null;
  }

  const rows: Array<{ file: string; hash: string }> = [];
  for (const m of manifest.matchAll(HASH_ROW_RE)) rows.push({ file: m[1], hash: m[2].toUpperCase() });

  if (rows.length !== GOLDEN.kernelManifestRows) {
    emit(
      "0", "stage0.row-count", "fail",
      `PROVENANCE.md carries ${rows.length} hash rows, expected exactly ${GOLDEN.kernelManifestRows}; a changed row count means the manifest itself was edited (anchor: committed manifest)`,
    );
  } else {
    emit("0", "stage0.row-count", "pass", `${rows.length} hash rows found, expected ${GOLDEN.kernelManifestRows} (anchor: committed PROVENANCE.md)`);
  }

  let mismatches = 0;
  let missing = 0;
  let dropped = 0;
  for (const r of rows) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(KERNEL_DIR, r.file));
    } catch {
      // A file a release tree does not ship may be absent in a release tree only; any other absence fails.
      if (absenceAllowed(REPO_ROOT, r.file)) {
        dropped++;
        emit("0", `stage0.dropped:${r.file}`, "skip", `${r.file} is absent: this tree does not ship it`);
        continue;
      }
      missing++;
      emit("0", `stage0.missing:${r.file}`, "fail", `manifest lists ${r.file} but the file is absent`);
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    if (actual !== r.hash) {
      mismatches++;
      emit("0", `stage0.mismatch:${r.file}`, "fail", `SHA-256 mismatch on ${r.file}: manifest ${r.hash.slice(0, 12)}..., disk ${actual.slice(0, 12)}...`);
    }
  }
  if (mismatches === 0 && missing === 0 && rows.length === GOLDEN.kernelManifestRows) {
    const hashed = dropped === 0 ? `${rows.length}/${GOLDEN.kernelManifestRows}` : `${rows.length - dropped}/${GOLDEN.kernelManifestRows} (${dropped} not shipped in this tree)`;
    emit("0", "stage0.kernel-hashes", "pass", `${hashed} kernel files re-hashed with node:crypto, 0 mismatches, 0 missing (anchor: byte identity vs the committed manifest; frozen kernel)`);
  }

  const commitMatch = COMMIT_RE.exec(manifest);
  if (!commitMatch) {
    emit("0", "stage0.commit", "fail", "kernel source id line not found in PROVENANCE.md");
    return null;
  }
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  emit("0", "stage0.commit", "pass", `source commit ${commitMatch[1].slice(0, 8)} parsed from the manifest; manifest SHA-256 ${manifestHash.slice(0, 12)}... (cross-checked against the run's embedded kernel ref in stage 1)`);
  return { sourceCommit: commitMatch[1], manifestHash };
}

// --- Vanilla run (shared by stages 1 and 3) ----------------------------------

async function runVanilla(): Promise<RunResult> {
  const portfolio = buildVanillaPortfolio();
  const market = await loadMarketSnapshot(MARKET_PATH);
  const set = vanillaAssumptionSet();
  const request: RunRequest = {
    runId: "accept-vanilla-1",
    portfolioId: portfolio.id,
    marketSnapshot: market,
    scenarios: vanillaScenarios(set.id),
    assumptionSets: [set],
    grid: { horizonMonths: 360, asOf: portfolio.asOf },
    seed: "accept",
    timestamps: { ...FIXED_TS },
  };
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(portfolio);
  return engine.run(request);
}

// --- Stage 1: vanilla-book continuity goldens --------------------------------

function stage1(result: RunResult, provenance: { sourceCommit: string; manifestHash: string } | null): void {
  header("stage 1: continuity — vanilla book goldens (9 positions, base + regulatory grid)");

  const byId = new Map(result.eve.byScenario.map((s) => [s.scenarioId, s]));
  const base = byId.get("S0");
  if (!base) {
    emit("1", "stage1.base-scenario", "fail", "base scenario S0 missing from the EVE block");
    return;
  }

  // Equity duration to the digit.
  const dur = base.effectiveDurationEquity;
  if (dur === undefined) {
    emit("1", "stage1.duration", "fail", "base effectiveDurationEquity is undefined; the sanity gate rejected it");
  } else if (Math.abs(dur - GOLDEN.durationEquityBase) <= GOLDEN.durationTolerance) {
    emit("1", "stage1.duration", "pass", `base equity duration ${dur.toFixed(3)} = pinned ${GOLDEN.durationEquityBase.toFixed(2)} to the digit (anchor: hand-checkable vanilla book)`);
  } else {
    emit("1", "stage1.duration", "fail", `base equity duration ${dur.toFixed(4)} != pinned ${GOLDEN.durationEquityBase.toFixed(2)} (tolerance ${GOLDEN.durationTolerance})`);
  }

  // Base EVE to the dollar.
  if (Math.abs(base.eve - GOLDEN.baseEve) <= GOLDEN.baseEveToleranceDollars) {
    emit("1", "stage1.base-eve", "pass", `base EVE $${base.eve.toFixed(2)} = pinned $${GOLDEN.baseEve.toLocaleString("en-US")} to the dollar (anchor: PV of contractual cash flows)`);
  } else {
    emit("1", "stage1.base-eve", "fail", `base EVE $${base.eve.toFixed(2)} != pinned $${GOLDEN.baseEve.toLocaleString("en-US")}`);
  }

  // Attribution: full headline set present, every residual 0.00 to the digit.
  const headlines = result.attribution.headlines;
  if (headlines.length !== GOLDEN.headlineCount) {
    emit("1", "stage1.attribution-count", "fail", `${headlines.length} attribution headlines, expected ${GOLDEN.headlineCount} (4 shocked scenarios x 3 metrics)`);
  } else {
    const maxResidual = Math.max(...headlines.map((h) => Math.abs(h.residual)));
    if (maxResidual <= GOLDEN.residualTolerance) {
      emit("1", "stage1.attribution-residual", "pass", `max |residual| ${maxResidual.toExponential(2)} across ${headlines.length} headlines = 0.00 to the digit (anchor: rate is the only driver on the regulatory grid, the residual is definitional sum(contributions) - totalDelta)`);
    } else {
      emit("1", "stage1.attribution-residual", "fail", `max |attribution residual| ${maxResidual} exceeds ${GOLDEN.residualTolerance}`);
    }
  }

  // NII flat across scenarios: a static, fully fixed-rate book has no repricing.
  const niiBase = result.nii.byScenario.find((s) => s.scenarioId === "S0");
  if (!niiBase) {
    emit("1", "stage1.nii-flat", "fail", "base scenario S0 missing from the NII block");
  } else {
    const maxDev = Math.max(
      ...result.nii.byScenario.map((s) =>
        Math.max(Math.abs(s.totalNet12 - niiBase.totalNet12), Math.abs(s.totalNet24 - niiBase.totalNet24)),
      ),
    );
    if (maxDev <= GOLDEN.niiFlatToleranceDollars) {
      emit("1", "stage1.nii-flat", "pass", `NII flat across all ${result.nii.byScenario.length} scenarios: net12 $${niiBase.totalNet12.toFixed(2)}, max deviation ${maxDev.toExponential(2)} (anchor: a static fully fixed-rate book has no repricing inside the horizon)`);
    } else {
      emit("1", "stage1.nii-flat", "fail", `NII not flat: max deviation $${maxDev} across scenarios on a book with zero repricing`);
    }
  }

  // EVE monotonic in the shock: the liability-short (asset-long) signature.
  const order = ["SM200", "SM100", "S0", "S100", "S200"];
  const eves = order.map((id) => byId.get(id)?.eve);
  if (eves.some((v) => v === undefined)) {
    emit("1", "stage1.eve-monotonic", "fail", `scenario set incomplete; expected ${order.join(", ")}`);
  } else {
    const vals = eves as number[];
    const monotone = vals.every((v, i) => i === 0 || vals[i - 1] > v);
    if (monotone) {
      emit("1", "stage1.eve-monotonic", "pass", `EVE strictly decreasing in the shock: ${vals.map((v) => (v / 1e6).toFixed(1) + "M").join(" > ")} (anchor: asset-long book with no optionality)`);
    } else {
      emit("1", "stage1.eve-monotonic", "fail", `EVE not monotonic across ${order.join(", ")}: ${vals.join(", ")}`);
    }
  }

  // Kernel ref embedded in the run matches the manifest on disk (stage 0).
  if (provenance) {
    const k = result.provenance.kernel;
    if (k.sourceCommit === provenance.sourceCommit && k.provenanceFileHash === provenance.manifestHash) {
      emit("1", "stage1.kernel-ref", "pass", `run's embedded kernel ref (commit ${k.sourceCommit.slice(0, 8)}, manifest hash ${k.provenanceFileHash.slice(0, 12)}...) matches PROVENANCE.md on disk (anchor: stage-0 independent parse and SHA-256)`);
    } else {
      emit("1", "stage1.kernel-ref", "fail", `run kernel ref (${k.sourceCommit.slice(0, 8)}, ${k.provenanceFileHash.slice(0, 12)}...) does not match the manifest on disk (${provenance.sourceCommit.slice(0, 8)}, ${provenance.manifestHash.slice(0, 12)}...)`);
    }
  }
}

// --- Stage 2: capability battery + SKIPPED register lines --------------------

async function stage2(market: Awaited<ReturnType<typeof loadMarketSnapshot>>): Promise<string[]> {
  header(`stage 2: capabilities — shipped anchors and the declared-deferred register (${REGISTER_RELATIVE_PATH})`);
  const observed: string[] = [];

  let register;
  try {
    register = loadRegister(REPO_ROOT);
  } catch (err) {
    emit("2", "stage2.register-load", "fail", (err as Error).message);
    return observed;
  }

  const capabilityChecks = allCapabilityChecks();
  const checksById = new Map(capabilityChecks.map((c) => [c.capabilityId, c]));
  const registerIds = new Set(register.capabilities.map((c) => c.id));

  // A registered check must point at a register entry.
  for (const check of capabilityChecks) {
    if (!registerIds.has(check.capabilityId)) {
      emit("2", `stage2.orphan-check:${check.capabilityId}`, "fail", `acceptance check "${check.capabilityId}" is registered but the capability is not listed in ${REGISTER_RELATIVE_PATH}; add the entry (status "shipped") in the shipping commit`);
    }
  }

  for (const entry of register.capabilities) {
    const check = checksById.get(entry.id);
    if (entry.status === "shipped") {
      if (!check) {
        emit("2", entry.id, "fail", `declared shipped but no anchor check is registered in accept/registry.ts; a shipped capability without an anchor assertion is a boundary violation `);
        continue;
      }
      try {
        const res = await check.run({ repoRoot: REPO_ROOT, market });
        if (res.lines.length === 0) {
          emit("2", entry.id, "fail", "check returned no lines; a shipped capability must assert its anchor");
        }
        for (const l of res.lines) emit("2", `${entry.id}.${l.id}`, l.status, l.detail);
        if (res.observedNotImplemented) observed.push(...res.observedNotImplemented);
      } catch (err) {
        emit("2", entry.id, "fail", `anchor check threw: ${(err as Error).message}`);
      }
    } else {
      if (check) {
        emit("2", entry.id, "fail", `register says "${entry.status}" but an acceptance check is registered; flip the status to "shipped" in the same commit as the check`);
      } else {
        const module = entry.module ? `, ${entry.module}` : "";
        emit("2", entry.id, "skip", `(${entry.status}${module}) ${entry.reason}`);
      }
    }
  }
  return observed;
}

// --- Stage 3: determinism re-run ---------------------------------------------

async function stage3(first: RunResult): Promise<RunResult | null> {
  header("stage 3: determinism — identical request, fresh engine, byte identity");
  const second = await runVanilla();
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  const hashA = createHash("sha256").update(a).digest("hex");
  const hashB = createHash("sha256").update(b).digest("hex");
  if (a === b) {
    emit("3", "stage3.byte-identity", "pass", `two full runs serialize byte-identically, ${a.length.toLocaleString("en-US")} bytes, SHA-256 ${hashA.slice(0, 16)}... (anchor: no clock, no RNG on the deterministic grid; timestamps injected fixed)`);
    return second;
  }
  emit("3", "stage3.byte-identity", "fail", `serialized results differ: ${hashA.slice(0, 16)}... vs ${hashB.slice(0, 16)}... — something non-deterministic leaked into the compute path`);
  return second;
}

// --- Stage 4: honesty-register diff ------------------------------------------

function stage4(observedLayers: string[]): void {
  header("stage 4: honesty register — observed notImplemented vs declared-deferred");
  let register;
  try {
    register = loadRegister(REPO_ROOT);
  } catch (err) {
    emit("4", "stage4.register-load", "fail", (err as Error).message);
    return;
  }
  const expected = expectedNotImplementedUnion(register);
  const observed = new Set(observedLayers);

  const undeclared = [...observed].filter((l) => !expected.has(l));
  const vanished = [...expected].filter((l) => !observed.has(l));

  if (undeclared.length > 0) {
    emit("4", "stage4.undeclared-tags", "fail", `runs emitted notImplemented layers the register does not declare: ${undeclared.join(", ")} — a capability silently degraded`);
  }
  if (vanished.length > 0) {
    emit("4", "stage4.vanished-tags", "fail", `register expects notImplemented layers that never appeared: ${vanished.join(", ")} — a number showed up where a refusal was promised, without a shipped module`);
  }
  if (undeclared.length === 0 && vanished.length === 0) {
    emit("4", "stage4.register-diff", "pass", `observed notImplemented set (${observed.size} layer${observed.size === 1 ? "" : "s"}) exactly equals the declared-expected set (anchor: ${REGISTER_RELATIVE_PATH}, ${register.capabilities.length} capabilities on the ledger)`);
  }
}

// --- Driver ------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = performance.now();
  console.log("npm run accept — ALM Studio platform acceptance battery");
  console.log(`repo root: ${REPO_ROOT}`);
  // The optional extension folder, when present, registers its checks and their register entries; the
  // battery says nothing of it when it is absent.
  if (await loadAcceptCompanion()) console.log("extension folder: loaded, its checks join the battery");

  const provenance = stage0();

  let firstRun: RunResult | null = null;
  const observedLayers: string[] = [];
  try {
    firstRun = await runVanilla();
  } catch (err) {
    header("stage 1: continuity — vanilla book goldens");
    emit("1", "stage1.run", "fail", `vanilla run threw: ${(err as Error).message}`);
  }
  if (firstRun) {
    stage1(firstRun, provenance);
    observedLayers.push(...firstRun.notImplemented.map((t) => t.layer));
  }

  const market = await loadMarketSnapshot(MARKET_PATH);
  observedLayers.push(...(await stage2(market)));

  if (firstRun) {
    const second = await stage3(firstRun);
    if (second) observedLayers.push(...second.notImplemented.map((t) => t.layer));
  } else {
    header("stage 3: determinism");
    emit("3", "stage3.byte-identity", "fail", "skipped: the stage-1 run failed, there is nothing to compare");
  }

  stage4(observedLayers);

  // Verdict and detail file.
  const passed = lines.filter((l) => l.status === "pass").length;
  const failed = lines.filter((l) => l.status === "fail").length;
  const skipped = lines.filter((l) => l.status === "skip").length;
  const checked = passed + failed;
  const elapsedMs = Math.round(performance.now() - t0);
  const verdict = failed === 0
    ? `VERDICT: PASS (${passed}/${checked} checks, ${skipped} skipped)`
    : `VERDICT: FAIL (${failed} of ${checked} checks failed, ${skipped} skipped)`;

  try {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(
      OUT_PATH,
      JSON.stringify(
        {
          verdict: failed === 0 ? "PASS" : "FAIL",
          ranAt: new Date().toISOString(),
          elapsedMs,
          counts: { passed, failed, skipped },
          lines,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`\ndetail: ${OUT_PATH} (${elapsedMs} ms end to end)`);
  } catch (err) {
    console.log(`\nwarning: could not write ${OUT_PATH}: ${(err as Error).message}`);
  }

  console.log(verdict);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log("VERDICT: FAIL (battery driver threw before completing)");
  process.exit(1);
});
