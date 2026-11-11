/**
 * What a plugin DECLARES is now load-bearing: T6 compares a
 * stage's declared consumes and produces against the mounted plugin's, and the
 * walker's edges-out check compares what a stage function returned against what
 * the stage declared. A declares row that lies is therefore a refusal generator,
 * which is why the four behavioral kinds and the four metrics are pinned here.
 */
import { describe, expect, it } from "vitest";
import { mountProfile } from "@alm/harness";
import { CONTEXT_SUPPLIED_TYPES, CONTRACT_TYPE_NAMES, scopeKey, type ArtifactScope } from "../../contracts/plan";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../catalog";

const NAMES: readonly string[] = CONTRACT_TYPE_NAMES;

function declaresOf(): Map<string, { kind: string; produces: string[]; consumes?: string[] }> {
  const ctx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
  const out = new Map<string, { kind: string; produces: string[]; consumes?: string[] }>();
  for (const p of ctx.mountedPlugins()) if (p.declares !== undefined) out.set(p.id, p.declares);
  ctx.dispose();
  return out;
}

describe("contract type names", () => {
  it("carries FtpResult, the result slot the ftp metric fills", () => {
    expect(NAMES).toContain("FtpResult");
  });

  it("carries FundingCurve, the all-in leg, distinct from the risk-free ZeroCurve", () => {
    expect(NAMES).toContain("FundingCurve");
    expect(NAMES).toContain("ZeroCurve");
  });

  it("keeps every context-supplied type in the name list", () => {
    for (const t of CONTEXT_SUPPLIED_TYPES) expect(NAMES).toContain(t);
  });
});

describe("scopeKey", () => {
  it("canonicalises the three scopes distinctly", () => {
    const run: ArtifactScope = { kind: "run" };
    const s0: ArtifactScope = { kind: "scenario", scenarioId: "S0" };
    const as: ArtifactScope = { kind: "assumptionSet", assumptionSetId: "S0" };
    expect(scopeKey(run)).toBe("run");
    expect(scopeKey(s0)).toBe("scenario:S0");
    expect(scopeKey(as)).toBe("assumptionSet:S0");
    expect(scopeKey(s0)).not.toBe(scopeKey(as));
  });
});

describe("built-in plugin declares", () => {
  const declares = declaresOf();

  it("names only contract types on every mounted plugin", () => {
    for (const [id, d] of declares) {
      for (const t of d.produces) expect(NAMES, `${id} produces`).toContain(t);
      for (const t of d.consumes ?? []) expect(NAMES, `${id} consumes`).toContain(t);
    }
  });

  it("declares the behavioral kinds as Position rewriters", () => {
    for (const id of [
      "engine.behavioral.prepay",
      "engine.behavioral.nmd-decay",
      "engine.behavioral.deposit-beta",
      "engine.behavioral.cd-rollover",
    ]) {
      const d = declares.get(id)!;
      expect(d.kind, id).toBe("behavioral");
      expect(d.produces, id).toEqual(["Position"]);
      expect(d.consumes, id).toEqual(["Position", "RatePath"]);
    }
  });

  it("declares the ftp metric as the FtpResult producer", () => {
    const d = declares.get("engine.metric.ftp")!;
    expect(d.produces).toEqual(["FtpResult"]);
    expect(d.consumes).toEqual(["Cashflow", "ZeroCurve", "FundingCurve", "Position", "NiiResult", "RatePath"]);
  });

  it("declares the all-in overlay as the FundingCurve producer", () => {
    const d = declares.get("engine.tlp-overlay")!;
    expect(d.kind).toBe("curve");
    expect(d.produces).toEqual(["FundingCurve"]);
    expect(d.consumes).toEqual(["ZeroCurve", "MarketSnapshot"]);
    // The bootstrap stage keeps the risk-free type to itself: two legs, two
    // types, so a consumer that needs both names both producers.
    expect(declares.get("engine.curve.bootstrap")!.produces).toEqual(["ZeroCurve"]);
  });

  it("declares the effective book and both legs on the metrics that read them", () => {
    expect(declares.get("engine.metric.eve")!.consumes).toEqual(["Cashflow", "ZeroCurve", "FundingCurve", "Position"]);
    expect(declares.get("engine.metric.gap")!.consumes).toEqual(["Cashflow", "RepricingSchedule", "Position"]);
    expect(declares.get("engine.metric.nii")!.consumes).toEqual(["Cashflow"]);
  });

  it("declares the balance stage's contractual input", () => {
    const d = declares.get("engine.balance-plan")!;
    expect(d.consumes).toEqual(["Position", "RatePath", "Cashflow"]);
    expect(d.produces).toEqual(["Cashflow"]);
  });

  it("leaves exactly one result slot per metric type", () => {
    const byType = new Map<string, string[]>();
    for (const [id, d] of declares) {
      if (d.kind !== "metric") continue;
      for (const t of d.produces) byType.set(t, [...(byType.get(t) ?? []), id]);
    }
    // Piece 3b adds the fifth slot, CustomMetricResult. The one-producer rule it
    // joins is per PLAN, not per catalog: a plan names at most one stage per
    // custom metric, so the catalog may mount several producers of
    // this type and a plan still runs each at most once. Piece 3c mounts the
    // second, `wal-gap`, beside the demonstration metric. Piece 5b mounts the
    // third, `survival-horizon`. The four typed result slots stay one producer
    // each. Piece 6 mounts the fourth and fifth, `lcr-scenario` and
    // `lcr-regulatory`.
    expect([...byType.keys()].sort()).toEqual([
      "CustomMetricResult",
      "EveResult",
      "FtpResult",
      "GapResult",
      "NiiResult",
    ]);
    expect(byType.get("CustomMetricResult")).toEqual([
      "engine.metric.balance-summary",
      "engine.metric.wal-gap",
      "engine.metric.survival-horizon",
      "engine.metric.lcr-scenario",
      "engine.metric.lcr-regulatory",
    ]);
    for (const [t, ids] of byType) {
      if (t === "CustomMetricResult") continue;
      expect(ids, t).toHaveLength(1);
    }
  });
});
