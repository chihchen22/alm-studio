/**
 * Spec Section 8.4, acceptance (d). A user metric mounted by ONE profile row and
 * named by ONE plan stage runs, its result reaches the caller, and the run log's
 * `stage` entry names its plugin.
 *
 * DEVIATION, recorded in the plan: EngineMetricId is a closed union of four ids
 * and the result envelope has four metric slots, so a genuinely NEW metric id
 * has nowhere to land its number. The toy here REPLACES the built-in ftp metric
 * through a profile patch, which exercises every part of the acceptance the
 * closed union permits: one row mounts it, one stage names it, its number
 * reaches result.ftp, and the log credits it by its own id.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { composeProfile, mountProfile, type Plugin } from "@alm/harness";
import type { RunLogEntry } from "../../contracts/runLog";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../../plugins/catalog";
import { defaultPlanFor } from "../defaultPlan";
import { resolveDefaultContext } from "../engine";
import { buildRunResult } from "../orchestrate";
import { computeFtpResult } from "../../ftp";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

const TOY_ID = "acme.metric.ftp-doubled";

/** A user metric: the shipped function with its FTP accrual doubled on the way out. */
const toyFtp: Plugin = {
  id: TOY_ID,
  inject: ["metrics"],
  declares: { kind: "metric", produces: ["FtpResult"], consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"] },
  apply(ctx) {
    const registry = ctx.get("metrics");
    ctx.effect(() =>
      registry.register(
        "ftp",
        ((args: Parameters<typeof computeFtpResult>[0]) => {
          const out = computeFtpResult(args);
          return { ...out, byFamily: out.byFamily.map((f) => ({ ...f, ftpAccrual12: f.ftpAccrual12 * 2 })) };
        }) as typeof computeFtpResult,
        TOY_ID,
      ),
    );
  },
};

const TOY_CATALOG = new Map(BUILTIN_CATALOG).set(toyFtp.id, toyFtp);
const TOY_PROFILE = composeProfile(DEFAULT_PROFILE, [
  {
    label: "toy-ftp",
    patches: [{ disable: "metric.ftp" }, { insert: { id: "toy-ftp", plugin: TOY_ID } }],
  },
]);

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

describe("a user metric mounted by one profile row", () => {
  it("runs from one plan stage, reaches the caller, and is credited in the run log", () => {
    const request = makeRunRequest(market);
    const portfolio = twoSidedBook();
    const base = resolveDefaultContext();
    const baseline = buildRunResult(request, portfolio, base);

    const harness = mountProfile(TOY_PROFILE, TOY_CATALOG);
    const { plan } = defaultPlanFor(request, portfolio);
    const ftpStage = plan.stages.find((s) => s.id === "st-ftp")!;
    ftpStage.component = TOY_ID;
    const result = buildRunResult(request, portfolio, { ...base, harness, plan });
    harness.dispose();

    expect(result.ftp, "the user metric's result must reach the caller").toBeDefined();
    // Nonzero first, so "doubled" is a real comparison rather than 0 === 0.
    expect(baseline.ftp!.byFamily[0]!.ftpAccrual12).not.toBe(0);
    expect(result.ftp!.byFamily[0]!.ftpAccrual12).toBe(baseline.ftp!.byFamily[0]!.ftpAccrual12 * 2);

    const entry = (result.provenance.runLog ?? []).find(
      (e): e is Extract<RunLogEntry, { t: "stage" }> => e.t === "stage" && e.stageId === "st-ftp",
    );
    expect(entry, "the run log must carry a stage entry for the user metric").toBeDefined();
    expect(entry!.pluginId).toBe(TOY_ID);
    expect(entry!.produced).toEqual([{ type: "FtpResult", scope: "run" }]);
  });
});
