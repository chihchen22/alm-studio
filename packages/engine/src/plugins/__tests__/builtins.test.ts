import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { Plugin } from "@alm/harness";
import { mountProfile, UnknownPluginError } from "@alm/harness";
import { buildGapFromSeries } from "../../gap";
import { computeEve } from "../../eve";
import { computeFtpResult } from "../../ftp";
import { computeNII } from "../../nii";
import { applyOverlayToTerms } from "../../projection/static/applyOverlays";
import { buildScenarioRatePath } from "../../projection/static";
import { buildBaseCurve } from "../../scenario";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { loadMarket, twoSidedBook } from "../../run/__tests__/fixtures";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../catalog";
import { defaultHarness, resetDefaultHarness } from "../defaultHarness";

let market: MarketSnapshot;
beforeAll(async () => { market = await loadMarket(); });

describe("BUILTIN_CATALOG and DEFAULT_PROFILE", () => {
  // Written out rather than derived from BUILTINS: the catalog and the profile
  // are both built from that one array, so any test that compares them to each
  // other passes even if a built-in is dropped. This list is the independent
  // statement of what the engine ships.
  const EXPECTED_BUILTIN_IDS = [
    "engine.run-log",
    "engine.curve.bootstrap",
    "engine.tlp-overlay",
    "engine.rate-path.registry",
    "engine.rate-path.deterministic",
    "engine.contractual",
    "engine.behavioral.registry",
    "engine.behavioral.prepay",
    "engine.behavioral.nmd-decay",
    "engine.behavioral.deposit-beta",
    "engine.behavioral.cd-rollover",
    "engine.behavioral.commitment-draw",
    "engine.behavioral.loan-client-rate",
    "engine.balance-plan",
    "engine.positions.registry",
    "engine.scenarios.registry",
    "engine.scenarios.shipped",
    "engine.metric.registry",
    "engine.metric.nii",
    "engine.metric.eve",
    "engine.metric.gap",
    "engine.metric.ftp",
    "engine.metric.balance-summary",
    "engine.metric.wal-gap",
    "engine.metric.survival-horizon",
    "engine.metric.lcr-scenario",
    "engine.metric.lcr-regulatory",
    "engine.gate.type",
    "engine.gate.routing",
  ];

  it("ships exactly the twenty-nine built-in plugins, in mount order", () => {
    expect([...BUILTIN_CATALOG.keys()]).toEqual(EXPECTED_BUILTIN_IDS);
    expect(DEFAULT_PROFILE.rows.map((row) => row.plugin)).toEqual(EXPECTED_BUILTIN_IDS);
    expect(DEFAULT_PROFILE.rows.map((row) => row.id)).toEqual(
      EXPECTED_BUILTIN_IDS.map((id) => id.replace(/^engine\./, "")),
    );
  });

  it("has a catalog entry for every row in the default profile", () => {
    for (const row of DEFAULT_PROFILE.rows) {
      expect(BUILTIN_CATALOG.has(row.plugin), `row ${row.id} names ${row.plugin}`).toBe(true);
    }
  });

  it("gives every catalog plugin the id its key carries", () => {
    for (const [id, plugin] of BUILTIN_CATALOG) expect(plugin.id).toBe(id);
  });

  it("mounts the default profile and finalizes with nothing pending", () => {
    expect(() => mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG)).not.toThrow();
  });

  it("refuses a profile row naming a plugin the catalog lacks", () => {
    expect(() =>
      mountProfile({ rows: [{ id: "r", plugin: "acme.not.here" }] }, BUILTIN_CATALOG),
    ).toThrow(UnknownPluginError);
  });
});

describe("each seam resolves to the function that runs today", () => {
  it("curves.build is buildBaseCurve", () => {
    const h = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const service = h.get("curves");
    expect(service.build).toBe(buildBaseCurve);
    // A ZeroCurve carries closures, so deep equality on the whole object compares
    // function identities. The curve IS its (t, z) pair; the methods read it.
    const through = service.build(market);
    const direct = buildBaseCurve(market);
    expect({ t: through.t, z: through.z }).toEqual({ t: direct.t, z: direct.z });
    expect(through.discountFactor(5)).toBe(direct.discountFactor(5));
  });

  it("ratePaths holds the deterministic model and returns buildScenarioRatePath", () => {
    const h = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const paths = h.get("ratePaths");
    expect(paths.has("deterministic")).toBe(true);
    expect(paths.get("deterministic")).toBe(buildScenarioRatePath);
  });

  it("behavioral registers exactly the six built-in kinds, each to applyOverlayToTerms", () => {
    const h = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const behavioral = h.get("behavioral");
    expect([...behavioral.kinds()].sort()).toEqual([
      "cd-rollover",
      "commitment-draw",
      "deposit-beta",
      "loan-client-rate",
      "nmd-decay",
      "prepay",
    ]);
    for (const kind of behavioral.kinds()) expect(behavioral.get(kind)).toBe(applyOverlayToTerms);
  });

  it("positions resolves the engine registry source", () => {
    const h = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const source = h.get("positions").get("engine");
    const book = twoSidedBook("PF-PLUGIN");
    source.load(book);
    expect(source.get("PF-PLUGIN").id).toBe("PF-PLUGIN");
  });

  it("scenarios lists the shipped libraries by id", () => {
    const h = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const registry = h.get("scenarios");
    expect(registry.list().map((l) => l.id)).toEqual(SHIPPED_LIBRARIES.map((l) => l.id));
    expect(registry.get("regulatory-grid-v1").scenarios.length).toBe(5);
  });

  it("metrics resolve to the four metric functions", () => {
    const h = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const metrics = h.get("metrics");
    expect(metrics.get("nii")).toBe(computeNII);
    expect(metrics.get("eve")).toBe(computeEve);
    expect(metrics.get("gap")).toBe(buildGapFromSeries);
    expect(metrics.get("ftp")).toBe(computeFtpResult);
    expect([...metrics.ids()].sort()).toEqual(["eve", "ftp", "gap", "nii"]);
  });

  it("runLog starts empty and appends in order", () => {
    const h = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    const log = h.get("runLog");
    expect(log.entries()).toEqual([]);
    log.append({ t: "catalog", pluginId: "engine.curve.bootstrap", source: "builtin" });
    log.append({ t: "catalog", pluginId: "engine.metric.nii", source: "builtin" });
    expect(log.entries().map((e) => (e.t === "catalog" ? e.pluginId : ""))).toEqual([
      "engine.curve.bootstrap",
      "engine.metric.nii",
    ]);
  });
});

describe("defaultHarness", () => {
  it("memoizes one context per process and rebuilds after a reset", () => {
    resetDefaultHarness();
    const first = defaultHarness();
    expect(defaultHarness()).toBe(first);
    resetDefaultHarness();
    expect(defaultHarness()).not.toBe(first);
  });

  it("resolves every seam", () => {
    resetDefaultHarness();
    const h = defaultHarness();
    for (const key of ["curves", "ratePaths", "behavioral", "positions", "scenarios", "metrics", "runLog"] as const) {
      expect(h.has(key), key).toBe(true);
    }
  });

  it("clears the memo before the unwind, so a poisoned context cannot wedge the process", async () => {
    // A context whose teardown throws. The reset must still surface that
    // failure AND leave the memo empty, or every later run in the process gets
    // the same dead context back.
    const poison: Plugin = {
      id: "test.poison",
      apply(ctx) {
        ctx.effect(() => () => {
          throw new Error("teardown boom");
        });
      },
    };
    vi.resetModules();
    vi.doMock("../catalog", () => ({
      BUILTIN_CATALOG: new Map([["test.poison", poison]]),
      DEFAULT_PROFILE: { rows: [{ id: "poison", plugin: "test.poison" }] },
    }));
    const mod = await import("../defaultHarness");
    const first = mod.defaultHarness();
    expect(() => mod.resetDefaultHarness()).toThrow();
    expect(mod.defaultHarness()).not.toBe(first);
  });
});

afterEach(() => {
  vi.doUnmock("../catalog");
  vi.resetModules();
});
