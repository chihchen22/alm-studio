import { describe, expect, it } from "vitest";
import { componentLabel, menuFor, resolvePlugin } from "../plan/componentMenu";
import { CATALOG } from "./fixtures/plan";

describe("resolvePlugin", () => {
  it("resolves a plugin id to itself, an alias to its plugin, anything else to null", () => {
    expect(resolvePlugin(CATALOG, "engine.metric.ftp")).toBe("engine.metric.ftp");
    expect(resolvePlugin(CATALOG, "alm-deposit-decay")).toBe("engine.behavioral.nmd-decay");
    expect(resolvePlugin(CATALOG, "alm-competing-risks-prepay")).toBeNull();
  });
});

describe("menuFor", () => {
  it("lists catalog components of the kind, then mounted plugins of the kind not already covered, current first", () => {
    const items = menuFor(CATALOG, "behavioral", "alm-deposit-decay");
    expect(items.map((i) => i.id)).toEqual([
      "alm-deposit-decay",
      "alm-mortgage-prepayment",
      "alm-competing-risks-prepay",
      "engine.behavioral.cd-rollover",
    ]);
    expect(items[0]).toMatchObject({ current: true, runs: true, pluginId: "engine.behavioral.nmd-decay" });
    expect(items.find((i) => i.id === "alm-competing-risks-prepay")).toMatchObject({ runs: false, pluginId: null });
    expect(items.map((i) => i.id)).not.toContain("engine.behavioral.nmd-decay");
    expect(items.map((i) => i.id)).not.toContain("engine.behavioral.prepay");
  });

  it("puts a current component that is in neither list at the top, with its real runs flag", () => {
    const items = menuFor(CATALOG, "metric", "engine.metric.ftp");
    expect(items[0]).toMatchObject({ id: "engine.metric.ftp", current: true, runs: true });
    expect(items.filter((i) => i.id === "engine.metric.ftp")).toHaveLength(1);
  });
});

describe("componentLabel", () => {
  it("uses the catalog label, else the id", () => {
    expect(componentLabel(CATALOG, "alm-ftp")).toBe("FTP");
    expect(componentLabel(CATALOG, "engine.metric.ftp")).toBe("engine.metric.ftp");
  });
});
