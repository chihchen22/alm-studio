// apps/studio/src/__tests__/harnessFrame.test.tsx
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { HarnessFrame } from "../harness/HarnessFrame";
import {
  behavioralInstances,
  behavioralMethods,
  curveInstances,
  curveMethods,
  definitionOrder,
  importMethods,
  importTemplateInstances,
  newBusinessInstances,
  newBusinessMethods,
  rateIndexInstances,
  rateIndexMethods,
  rateModelInstances,
  rateModelMethods,
  rateModelNamesOf,
  reservedMethods,
  STOCHASTIC_MODEL_NOTE,
  volInstances,
  volMethods,
} from "../harness/instances";
import { MARKET, CATALOG } from "./fixtures/market";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("harness frame", () => {
  it("lists instances left, shows method menu with availability and piece, settings read-only, used-by and provenance", () => {
    const inst = curveInstances(MARKET, { positions: 2351, setupsOnBase: ["setup-plan-synthetic-2500-v1"] });
    expect(inst.map((i) => i.name)).toEqual(["Risk-free", "Term funding", "TLP overlay"]);
    const html = renderToStaticMarkup(<HarnessFrame module="curve" instances={inst} methods={rateModelMethods(CATALOG)} selected={inst[0]!.id} />);
    expect(html).toContain("Risk-free"); expect(html).toContain("linear in zero");
    expect(html).toMatch(/alm-bgm-lmm[\s\S]*mounted/);
    expect(html).toMatch(/alm-sabr[\s\S]*surface preview/);
    // The method rows wrap their parts (label, id, chips, note) rather than squeeze a chip's word across lines (live walk).
    expect(html).toContain('<ul class="list harness-methods">');
    expect(readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")).toContain(".harness-methods li { flex-wrap: wrap; justify-content: flex-start; gap: var(--sp-1) var(--sp-2); }");
    expect(html).toMatch(/Spread over base[\s\S]*reserved[\s\S]*a later release/);
    expect(html).toContain("2,351 positions"); expect(html).toContain("setup-plan-synthetic-2500-v1");
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
  it("a mounted plugin appears without a Studio change; a catalog-only plugin says engine: later phase", () => {
    const methods = rateModelMethods({
      ...CATALOG,
      mounted: [...CATALOG.mounted, { id: "alm-new-model", aliases: [], kind: "term-structure" }],
      components: [...CATALOG.components, { id: "alm-new-model", kind: "term-structure", label: "New model" }, { id: "alm-later-model", kind: "term-structure", label: "Later model" }],
    });
    expect(methods.find((m) => m.id === "alm-new-model")!.availability).toBe("mounted");
    expect(methods.find((m) => m.id === "alm-later-model")!.availability).toBe("catalog");
    const html = renderToStaticMarkup(<HarnessFrame module="rate-model" instances={[]} methods={methods} selected={null} />);
    expect(html).toMatch(/alm-later-model[\s\S]*engine: later phase/);
  });

  it("shows the five regions of one instance: method menu, settings, inputs, validation state, used-by, and the Formula and Code slots as not available in this release", () => {
    const inst = curveInstances(MARKET, { positions: 2351, setupsOnBase: [] });
    const html = renderToStaticMarkup(<HarnessFrame module="curve" instances={inst} methods={curveMethods(CATALOG)} selected={inst[2]!.id} />);
    const t = text(html);
    for (const region of ["Method", "Settings", "Inputs", "Validation", "Used by", "Provenance"]) expect(t, region).toContain(region);
    expect(t).toMatch(/Formula[^.]*not available in this release/);
    expect(t).toMatch(/Code[^.]*not available in this release/);
    expect(t).toContain("Valid");
    // The selected instance is the TLP overlay: its method is the overlay plugin, and the settings are read-only (no input element).
    expect(t).toContain("alm-tlp-overlay");
    expect(html).not.toContain("<input");
  });

  it("an empty instance list says so, and the frame still shows the method menu and the reserved slots", () => {
    const html = renderToStaticMarkup(<HarnessFrame module="new-business-template" instances={newBusinessInstances()} methods={newBusinessMethods()} selected={null} />);
    const t = text(html);
    expect(t).toContain("No instance in this release");
    expect(t).toMatch(/60-month fixed bullet/);
    expect(t).toMatch(/Formula[^.]*not available in this release/);
  });
});

describe("module instances over the loaded snapshot, set and catalog", () => {
  it("curve construction: the three curves, the builder per curve, validation from the stored quotes", () => {
    const inst = curveInstances(MARKET, { positions: null, setupsOnBase: [] });
    expect(inst.map((i) => i.methodId)).toEqual(["alm-yield-curve", "alm-yield-curve", "alm-tlp-overlay"]);
    expect(inst.every((i) => i.module === "curve" && i.validation.state === "valid")).toBe(true);
    const none = curveInstances({ ...MARKET, curves: { ...MARKET.curves, tlp: [] } }, { positions: null, setupsOnBase: [] });
    expect(none[2]!.validation.state).toBe("not-set");
    expect(inst[0]!.provenance.contentHash).toBe("hash-q1");
  });

  it("curve methods: the two builders run, a reserved pair names a later release", () => {
    const m = curveMethods(CATALOG);
    expect(m.map((x) => [x.id, x.availability])).toEqual([["alm-yield-curve", "mounted"], ["alm-tlp-overlay", "mounted"]]);
  });

  it("vol surface: the short-rate and long-yield volatility surfaces, ids kept, each used by the model that reads it, with Bond-option and Flat vol reserved for a later release", () => {
    const inst = volInstances(MARKET, { rateModelNames: ["Hull-White 1F", "BGM"] });
    expect(inst.map((i) => i.name)).toEqual(["Short-rate volatility surface", "Long-yield volatility surface"]);
    expect(inst.map((i) => i.id)).toEqual(["cap-normal-vols", "swaption-atm-grid"]);
    expect(inst.map((i) => i.methodId)).toEqual(["cap-normal-vols", "swaption-grid"]);
    expect(inst[0]!.usedBy).toEqual([{ kind: "instance", id: "Hull-White 1F" }]);
    expect(inst[1]!.usedBy).toEqual([{ kind: "instance", id: "BGM" }]);
    expect(inst[0]!.validation.state).toBe("valid");
    expect(volInstances(MARKET, { rateModelNames: ["BGM"] })[0]!.usedBy).toEqual([]);
    expect(volInstances(MARKET, { rateModelNames: ["Hull-White 1F"] })[1]!.usedBy).toEqual([]);
    const empty = volInstances({ ...MARKET, capVolSurface: [], swaptionVolSurface: [] }, { rateModelNames: [] });
    expect(empty.map((i) => i.validation.messages)).toEqual([
      ["The snapshot stores no short-rate volatility surface."], ["The snapshot stores no long-yield volatility surface."],
    ]);
    const noAtm = volInstances({ ...MARKET, capVolSurface: MARKET.capVolSurface.filter((q) => !q.isAtm) }, { rateModelNames: [] });
    expect(noAtm[0]!.validation).toEqual({ state: "warning", messages: ["The short-rate volatility surface stores no at-the-money column."] });
    expect(volMethods(CATALOG).map((m) => [m.id, m.label, m.availability])).toEqual([
      ["cap-normal-vols", "Short-rate volatility surface, read by Hull-White 1F", "mounted"],
      ["swaption-grid", "Long-yield volatility surface, read by BGM", "mounted"],
    ]);
    const html = renderToStaticMarkup(<HarnessFrame module="vol-surface" instances={inst} methods={volMethods(CATALOG)} selected={inst[0]!.id} />);
    expect(html).toMatch(/Bond-option vols[\s\S]*reserved[\s\S]*a later release/);
    expect(html).toMatch(/Flat vol[\s\S]*reserved[\s\S]*a later release/);
  });

  it("rate model: deterministic forwards, Hull-White 1F and BGM; both stochastic models mounted from the Studio constant, SABR a surface preview", () => {
    const inst = rateModelInstances({ stochasticSetups: ["setup-hw"] });
    expect(inst.map((i) => i.name)).toEqual(["Deterministic forwards", "Hull-White 1F", "BGM"]);
    expect(inst.map((i) => i.methodId)).toEqual(["engine.rate-path", "alm-hull-white", "alm-bgm-lmm"]);
    expect(inst[1]!.usedBy).toEqual([{ kind: "run-setup", id: "setup-hw" }]);
    expect(inst[1]!.settings[0]).toEqual({ label: "Calibration", value: "the at-the-money column of the short-rate volatility surface" });
    expect(inst[2]!.settings[0]).toEqual({ label: "Calibration", value: "the default subset of the long-yield volatility surface (28 points, at least 8 required); the 10 bp gate is reported, never refused" });
    expect(inst[2]!.inputs).toEqual([{ kind: "instance", ref: "risk-free" }, { kind: "instance", ref: "swaption-atm-grid" }]);
    expect(inst[2]!.validation).toEqual({ state: "valid", messages: ["Runs by request from the Workbench or the API; no run setup names it."] });
    const m = rateModelMethods(CATALOG, "#/ws/ws-a/market/vols");
    expect(m.map((x) => [x.id, x.availability])).toEqual([
      ["engine.rate-path", "mounted"], ["alm-hull-white", "mounted"], ["alm-bgm-lmm", "mounted"], ["alm-sabr", "preview"],
    ]);
    expect(STOCHASTIC_MODEL_NOTE).toBe("stochastic runs by request from the Workbench or the API, base scenario only; not a plan stage");
    expect(m[1]!.note).toBe(STOCHASTIC_MODEL_NOTE);
    expect(m[2]!.note).toBe(STOCHASTIC_MODEL_NOTE);
    expect(m[3]!.link).toEqual({ href: "#/ws/ws-a/market/vols", text: "Volatility surfaces" });
  });

  it("rate model from a catalog without alm-hull-white (the live catalog mounts no stochastic plugin): both models still read mounted", () => {
    const live = { components: CATALOG.components.filter((c) => c.id !== "alm-hull-white"), mounted: CATALOG.mounted.filter((p) => p.id !== "alm-hull-white") };
    for (const cat of [live, { components: [], mounted: [] }]) {
      const m = rateModelMethods(cat);
      expect(m.find((x) => x.id === "alm-hull-white")!.availability).toBe("mounted");
      expect(m.find((x) => x.id === "alm-bgm-lmm")!.availability).toBe("mounted");
      expect(m.find((x) => x.id === "alm-sabr")!.availability).toBe("preview");
    }
  });

  it("the rate model names of the workspace's stochastic runs: a run with no stored model is Hull-White 1F, each name once", () => {
    expect(rateModelNamesOf([])).toEqual([]);
    expect(rateModelNamesOf([undefined, "hull-white-1f"])).toEqual(["Hull-White 1F"]);
    expect(rateModelNamesOf(["bgm-lmm-2f", undefined, "bgm-lmm-2f"])).toEqual(["Hull-White 1F", "BGM"]);
    expect(rateModelNamesOf(["bgm-lmm-2f"])).toEqual(["BGM"]);
    expect(rateModelNamesOf(["some-new-model"])).toEqual(["some-new-model"]);
  });

  it("rate index: one row per index of the market, then the carried definitions by status", () => {
    const inst = rateIndexInstances({
      indices: [{ id: "sofr-3m", label: "3-month term SOFR", tenorMonths: 3, basisBp: 12 }, { id: "sofr-1m", label: "1-month SOFR", tenorMonths: 1, basisBp: 0 }],
      carried: [
        { definitionKey: "macro-demo-v1", parentKey: null, status: "awaiting", refusal: null },
        { definitionKey: "tlp-shock-demo-v1", parentKey: "macro-demo-v1", status: "refused", refusal: "the macro history ends at the old as-of month" },
        { definitionKey: "vol-shock-demo-v1", parentKey: null, status: "applied", refusal: null },
      ],
      readers: { "sofr-3m": ["floaters"] },
    });
    expect(inst.map((i) => i.name)).toEqual(["sofr-1m", "sofr-3m", "macro-demo-v1", "tlp-shock-demo-v1", "vol-shock-demo-v1"]);
    const states = Object.fromEntries(inst.map((i) => [i.name, i.validation.state]));
    expect(states["macro-demo-v1"]).toBe("draft");
    expect(states["tlp-shock-demo-v1"]).toBe("warning");
    expect(states["vol-shock-demo-v1"]).toBe("valid");
    expect(inst.find((i) => i.name === "tlp-shock-demo-v1")!.validation.messages).toEqual(["the macro history ends at the old as-of month"]);
    expect(rateIndexMethods().map((x) => [x.id, x.availability])).toEqual([["curve-tenor-basis", "mounted"]]);
    expect(reservedMethods("rate-index").map((x) => [x.id, x.availability, x.piece])).toEqual([["formula", "reserved", "B"], ["history-only", "reserved", "B"]]);
  });

  it("definitions list in dependency order: a parent before its child, each with its level", () => {
    const order = definitionOrder([
      { definitionKey: "c", parentKey: "b" },
      { definitionKey: "a", parentKey: null },
      { definitionKey: "d", parentKey: null },
      { definitionKey: "b", parentKey: "a" },
    ]);
    expect(order.map((o) => `${o.definitionKey}:${o.level}`)).toEqual(["a:0", "b:1", "c:2", "d:0"]);
  });

  it("a definition whose parent is not in the list is a root, and a cycle terminates", () => {
    const order = definitionOrder([{ definitionKey: "x", parentKey: "gone" }, { definitionKey: "p", parentKey: "q" }, { definitionKey: "q", parentKey: "p" }]);
    expect(order.map((o) => o.definitionKey).sort()).toEqual(["p", "q", "x"]);
    expect(order.find((o) => o.definitionKey === "x")!.level).toBe(0);
  });

  it("import template: CSV and JSON positions and the market workbook run; Excel and SQL are reserved for a later release", () => {
    const inst = importTemplateInstances({ lastImport: null });
    expect(inst.map((i) => i.name)).toEqual(["CSV positions", "JSON positions", "Market workbook"]);
    expect(importMethods().map((x) => [x.id, x.availability])).toEqual([["csv", "mounted"], ["json", "mounted"], ["workbook", "mounted"]]);
    expect(reservedMethods("import-template").map((x) => [x.id, x.availability, x.piece])).toEqual([["excel-positions", "reserved", "C"], ["sql", "reserved", "C"]]);
  });

  it("behavioral: one instance per binding, grouped by overlay kind, with the families and the setups that name the set", () => {
    const set = { schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo", bindings: [
      { familyId: "mma", overlay: { kind: "deposit-beta", params: { betaMin: 0.45 } }, modelVersion: "kernel-deposit-beta-1" },
      { familyId: "dda", overlay: { kind: "nmd-decay", params: { closureSteady: 0.75, maxRateDecay: 3 } }, modelVersion: "kernel-nmd-decay-1" },
      { familyId: "dda", selector: { segment: "retail" }, overlay: { kind: "nmd-decay", params: { closureSteady: 0.5, maxRateDecay: 3 } }, modelVersion: "kernel-nmd-decay-1" },
    ] } as unknown as AssumptionSet;
    const inst = behavioralInstances(set, { setups: ["setup-standard-alco"] });
    expect(inst.map((i) => i.name)).toEqual(["deposit-beta: mma, whole family", "nmd-decay: dda, segment: retail", "nmd-decay: dda, whole family"]);
    expect(inst[0]!.usedBy).toEqual([{ kind: "run-setup", id: "setup-standard-alco" }]);
    expect(inst[0]!.methodId).toBe("deposit-beta");
    const m = behavioralMethods(CATALOG);
    expect(m.find((x) => x.id === "alm-deposit-decay")!.availability).toBe("mounted");
    expect(m.map((x) => x.id)).not.toContain("lookup-table");
  });

  it("new-business template: no instance in Slice 1; the eight engine instrument types are the reserved menu", () => {
    expect(newBusinessInstances()).toEqual([]);
    expect(newBusinessMethods()[0]).toMatchObject({ id: "flat-bullet", availability: "mounted" });
    const reserved = reservedMethods("new-business-template");
    expect(reserved.length).toBe(8);
    expect(reserved.every((x) => x.availability === "reserved" && x.piece === "C")).toBe(true);
  });
});
