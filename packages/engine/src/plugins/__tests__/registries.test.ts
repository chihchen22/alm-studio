/**
 * Registry discipline: a registration is reversible and unwinds with the fiber
 * that made it, and both refusals are typed. A registry whose entries outlive
 * their fiber would leave a disposed row's model resolvable and make a remount
 * of that row refuse as a duplicate, which is how a hot-swapped profile breaks.
 */
import { describe, expect, it } from "vitest";
import { Context, mountProfile } from "@alm/harness";
import { computeNII } from "../../nii";
import { buildScenarioRatePath } from "../../projection/static";
import { SHIPPED_LIBRARIES } from "../../scenario/library";
import { behavioralRegistryPlugin, prepayPlugin } from "../behavioral";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "../catalog";
import {
  CustomMetricRegistrationError,
  DuplicateRegistrationError,
  RegistryError,
  UnknownRegistrationError,
} from "../errors";
import { metricRegistryPlugin, niiMetricPlugin } from "../metrics";
import { deterministicRatePathPlugin, ratePathRegistryPlugin } from "../ratePaths";
import { makeKeyedRegistry } from "../registry";
import type { EngineMetricId } from "../services";

describe("a model plugin's registration unwinds with its fiber", () => {
  it("frees the rate-path model, and the row mounts again cleanly", () => {
    const ctx = new Context();
    ctx.mount(ratePathRegistryPlugin, undefined, "rate-path.registry");
    const fiber = ctx.mount(deterministicRatePathPlugin, undefined, "rate-path.deterministic");
    ctx.finalize();
    const registry = ctx.get("ratePaths");
    expect(registry.has("deterministic")).toBe(true);

    fiber.dispose();
    expect(registry.has("deterministic")).toBe(false);
    expect(registry.ids()).toEqual([]);

    ctx.mount(deterministicRatePathPlugin, undefined, "rate-path.deterministic.again");
    ctx.finalize();
    expect(registry.get("deterministic")).toBe(buildScenarioRatePath);
    ctx.dispose();
  });

  it("frees a behavioral kind, and the row mounts again cleanly", () => {
    const ctx = new Context();
    ctx.mount(behavioralRegistryPlugin, undefined, "behavioral.registry");
    const fiber = ctx.mount(prepayPlugin, undefined, "behavioral.prepay");
    ctx.finalize();
    const registry = ctx.get("behavioral");
    expect(registry.kinds()).toEqual(["prepay"]);

    fiber.dispose();
    expect(registry.has("prepay")).toBe(false);

    ctx.mount(prepayPlugin, undefined, "behavioral.prepay.again");
    ctx.finalize();
    expect(registry.kinds()).toEqual(["prepay"]);
    ctx.dispose();
  });

  it("frees a metric, and the row mounts again cleanly", () => {
    const ctx = new Context();
    ctx.mount(metricRegistryPlugin, undefined, "metric.registry");
    const fiber = ctx.mount(niiMetricPlugin, undefined, "metric.nii");
    ctx.finalize();
    const registry = ctx.get("metrics");
    expect(registry.has("nii")).toBe(true);

    fiber.dispose();
    expect(registry.has("nii")).toBe(false);

    ctx.mount(niiMetricPlugin, undefined, "metric.nii.again");
    ctx.finalize();
    expect(registry.get("nii")).toBe(computeNII);
    ctx.dispose();
  });

  it("names the owner plugin while the entry is live, and nobody once it is gone", () => {
    const shelf = makeKeyedRegistry<string>("test-seam");
    const undo = shelf.register("m", "value", "test.owner");
    expect(shelf.providerOf("m")).toBe("test.owner");
    undo();
    expect(shelf.providerOf("m")).toBeUndefined();
    // An entry registered without an owner has none to name; the run log logs a
    // literal rather than inventing an id.
    shelf.register("m", "value", undefined);
    expect(shelf.providerOf("m")).toBeUndefined();
    expect(shelf.providerOf("never-registered")).toBeUndefined();
  });

  it("credits each built-in model and metric to its own plugin id", () => {
    const ctx = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
    expect(ctx.get("ratePaths").providerOf("deterministic")).toBe("engine.rate-path.deterministic");
    expect(ctx.get("behavioral").providerOf("prepay")).toBe("engine.behavioral.prepay");
    for (const metric of ["nii", "eve", "gap", "ftp"]) {
      expect(ctx.get("metrics").providerOf(metric)).toBe(`engine.metric.${metric}`);
    }
    ctx.dispose();
  });

  it("does not let a stale dispose delete a successor's entry", () => {
    const shelf = makeKeyedRegistry<string>("test-seam");
    const first = shelf.register("m", "first");
    first();
    shelf.register("m", "second");
    first(); // the same dispose again: inert, and it must not touch "second"
    expect(shelf.get("m")).toBe("second");
  });
});

describe("every seam registry refuses the same two ways", () => {
  const harness = () => mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);

  it("ratePaths", () => {
    const registry = harness().get("ratePaths");
    expect(() => registry.register("deterministic", buildScenarioRatePath)).toThrow(DuplicateRegistrationError);
    expect(() => registry.get("hull-white")).toThrow(UnknownRegistrationError);
    try {
      registry.get("hull-white");
      expect.unreachable("get of an unregistered model must refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      const refusal = err as UnknownRegistrationError;
      expect(refusal.seam).toBe("ratePaths");
      expect(refusal.id).toBe("hull-white");
      expect(refusal.registered).toEqual(["deterministic"]);
      expect(refusal.message).toMatch(/hull-white/);
      expect(refusal.message).toMatch(/deterministic/);
    }
  });

  it("behavioral", () => {
    const registry = harness().get("behavioral");
    expect(() => registry.register("prepay", (terms) => terms)).toThrow(DuplicateRegistrationError);
    try {
      registry.get("constant-cpr-2");
      expect.unreachable("get of an unregistered kind must refuse");
    } catch (err) {
      const refusal = err as UnknownRegistrationError;
      expect(refusal).toBeInstanceOf(UnknownRegistrationError);
      expect(refusal.seam).toBe("behavioral");
      // Re-expectation: commitment-draw is the
      // FIFTH builtin behavioral overlay and is mounted in the catalog beside
      // cd-rollover, so the registry enumerates it. Task 4 mounted the plugin
      // and did not re-expect here; found red by task 8a, which
      // verified the failure predates its own guards. Piece 9 adds
      // loan-client-rate, the SIXTH builtin kind.
      expect([...refusal.registered].sort()).toEqual([
        "cd-rollover",
        "commitment-draw",
        "deposit-beta",
        "loan-client-rate",
        "nmd-decay",
        "prepay",
      ]);
    }
  });

  it("positions", () => {
    const registry = harness().get("positions");
    const source = registry.get("engine");
    expect(registry.has("engine")).toBe(true);
    expect(registry.has("warehouse")).toBe(false);
    expect(() => registry.register("engine", source)).toThrow(DuplicateRegistrationError);
    try {
      registry.get("warehouse");
      expect.unreachable("get of an unregistered source must refuse");
    } catch (err) {
      const refusal = err as UnknownRegistrationError;
      expect(refusal).toBeInstanceOf(UnknownRegistrationError);
      expect(refusal.seam).toBe("positions");
      expect(refusal.registered).toEqual(["engine"]);
    }
  });

  it("scenarios", () => {
    const registry = harness().get("scenarios");
    expect(() => registry.register("regulatory-grid-v1", SHIPPED_LIBRARIES[0])).toThrow(
      DuplicateRegistrationError,
    );
    try {
      registry.get("no-such-library");
      expect.unreachable("get of an unregistered library must refuse");
    } catch (err) {
      const refusal = err as UnknownRegistrationError;
      expect(refusal).toBeInstanceOf(UnknownRegistrationError);
      expect(refusal.seam).toBe("scenarios");
      expect(refusal.registered).toEqual(SHIPPED_LIBRARIES.map((l) => l.id));
    }
  });

  it("metrics", () => {
    const registry = harness().get("metrics");
    expect(() => registry.register("nii", computeNII)).toThrow(DuplicateRegistrationError);
    try {
      // The seam is typed to the four engine metric ids; the cast is the only
      // way to ask for one that cannot exist, which is what the refusal is for.
      registry.get("oas" as EngineMetricId);
      expect.unreachable("get of an unregistered metric must refuse");
    } catch (err) {
      const refusal = err as UnknownRegistrationError;
      expect(refusal).toBeInstanceOf(UnknownRegistrationError);
      expect(refusal.seam).toBe("metrics");
      expect([...refusal.registered].sort()).toEqual(["eve", "ftp", "gap", "nii"]);
    }
  });
});

/**
 * The metrics seam's SECOND DOOR. The four built-in
 * ids are a closed union and stay one shelf; a custom metric is a second shelf
 * keyed by its own id, so `ids()`, `get()` and `has()` keep answering for the
 * four alone and no caller of the old door sees a fifth.
 */
describe("the metrics seam's custom door", () => {
  const registry = () => mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG).get("metrics");
  const noop = () => ({
    metricId: "probe",
    label: "Probe",
    keys: [{ id: "k", label: "K", unit: "count" as const }],
    byScenario: [],
  });

  it("registers a valid id, answers by plugin, and leaves the four built-ins alone", () => {
    const metrics = registry();
    const undo = metrics.registerCustom("probe", noop, "acme.metric.probe");
    expect(metrics.customIds()).toEqual(["balance-summary", "wal-gap", "survival-horizon", "lcr-scenario", "lcr-regulatory", "probe"]);
    // Identity, not deep equality: the registry hands back the very function it
    // was given, and toEqual on an object carrying a function would not say so.
    expect(metrics.customByPlugin("acme.metric.probe")?.metricId).toBe("probe");
    expect(metrics.customByPlugin("acme.metric.probe")?.fn).toBe(noop);
    expect(metrics.customByPlugin("engine.metric.nii")).toBeUndefined();
    // The old door is untouched: a custom id is not a metric id.
    expect([...metrics.ids()].sort()).toEqual(["eve", "ftp", "gap", "nii"]);
    expect(metrics.has("probe")).toBe(false);

    undo();
    expect(metrics.customIds()).toEqual(["balance-summary", "wal-gap", "survival-horizon", "lcr-scenario", "lcr-regulatory"]);
    expect(metrics.customByPlugin("acme.metric.probe")).toBeUndefined();
  });

  it("refuses all four ways with CustomMetricRegistrationError naming the id", () => {
    const metrics = registry();
    const cases: Array<[string, string, string]> = [
      // [metricId, ownerPluginId, a fragment the message must carry]
      ["Probe", "acme.metric.a", "match"],
      ["nii", "acme.metric.b", "built-in"],
      ["balance-summary", "acme.metric.c", "already registered"],
      ["second", "engine.metric.balance-summary", "one custom metric per plugin"],
    ];
    for (const [metricId, owner, fragment] of cases) {
      try {
        metrics.registerCustom(metricId, noop, owner);
        expect.unreachable(`registerCustom("${metricId}", ..., "${owner}") must refuse`);
      } catch (err) {
        expect(err).toBeInstanceOf(CustomMetricRegistrationError);
        expect(err).toBeInstanceOf(RegistryError);
        const refusal = err as CustomMetricRegistrationError;
        expect(refusal.seam).toBe("metrics");
        expect(refusal.metricId).toBe(metricId);
        expect(refusal.message).toContain(metricId);
        expect(refusal.message).toContain(fragment);
      }
    }
  });

  it("mounts the demonstration metric from the default profile and credits its plugin", () => {
    const metrics = registry();
    const mounted = metrics.customByPlugin("engine.metric.balance-summary");
    expect(mounted).toBeDefined();
    expect(mounted!.metricId).toBe("balance-summary");
    // Mounting is not running: the registry holds the function and nothing has
    // called it, which is why a plan that names no stage on it runs unchanged.
    expect(typeof mounted!.fn).toBe("function");
  });

  /**
   * The second built-in custom metric sits BESIDE the first on the
   * custom shelf. Both are mounted and neither runs; a plan names at most one
   * stage per custom metric, so a plan may run either or both.
   */
  it("mounts wal-gap beside balance-summary, each credited to its own plugin", () => {
    const metrics = registry();
    expect(metrics.customIds()).toEqual(["balance-summary", "wal-gap", "survival-horizon", "lcr-scenario", "lcr-regulatory"]);
    const walGap = metrics.customByPlugin("engine.metric.wal-gap");
    expect(walGap).toBeDefined();
    expect(walGap!.metricId).toBe("wal-gap");
    expect(typeof walGap!.fn).toBe("function");
    // Two shelves still: neither custom id is an engine metric id.
    expect([...metrics.ids()].sort()).toEqual(["eve", "ftp", "gap", "nii"]);
    expect(metrics.has("wal-gap")).toBe(false);
  });

  /**
   * The third built-in custom metric, mounted and run by nothing,
   * credited to its own plugin like the two before it.
   */
  it("mounts survival-horizon third on the custom shelf, credited to its own plugin", () => {
    const metrics = registry();
    expect(metrics.customIds()).toEqual(["balance-summary", "wal-gap", "survival-horizon", "lcr-scenario", "lcr-regulatory"]);
    const survival = metrics.customByPlugin("engine.metric.survival-horizon");
    expect(survival).toBeDefined();
    expect(survival!.metricId).toBe("survival-horizon");
    expect(typeof survival!.fn).toBe("function");
    expect(metrics.has("survival-horizon")).toBe(false);
  });

  /**
   * The two LCR metrics, mounted after survival-horizon and run by
   * nothing, each credited to its own plugin.
   */
  it("mounts lcr-scenario and lcr-regulatory fourth and fifth, each credited to its own plugin", () => {
    const metrics = registry();
    for (const id of ["lcr-scenario", "lcr-regulatory"]) {
      const mounted = metrics.customByPlugin(`engine.metric.${id}`);
      expect(mounted, id).toBeDefined();
      expect(mounted!.metricId).toBe(id);
      expect(typeof mounted!.fn).toBe("function");
      expect(metrics.has(id)).toBe(false);
    }
  });
});
