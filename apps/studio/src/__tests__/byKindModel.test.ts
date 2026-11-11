// apps/studio/src/__tests__/byKindModel.test.ts
import { describe, expect, it } from "vitest";
import type { AssumptionSet } from "@alm/engine";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { byKindModel, leaves, KIND_OF_LAYER } from "../assumptions/byKindModel";
import { ByKindView } from "../pages/assumptions/ByKindPage";

const demo = { schemaVersion: "1.0.0", id: "demo", label: "Demo", bindings: [
  { familyId: "dda", overlay: { kind: "nmd-decay", params: { closureSteady: 0.75, maxRateDecay: 3 } }, modelVersion: "kernel-nmd-decay-1" },
  { familyId: "mma", overlay: { kind: "deposit-beta", params: { betaMin: 0.45 } }, modelVersion: "kernel-deposit-beta-1" },
] } as unknown as AssumptionSet;
const stress = { schemaVersion: "1.0.0", id: "stress", label: "Stress", bindings: [
  { familyId: "dda", overlay: { kind: "nmd-decay", params: { closureSteady: 1.5, maxRateDecay: 6 } }, modelVersion: "kernel-nmd-decay-1" },
] } as unknown as AssumptionSet;
const draws = { schemaVersion: "1.0.0", id: "sq", label: "Squeeze", bindings: [
  { familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [0.35, 0.15], steadyRate: 0.02 }, modelVersion: "engine-commitment-draw-1" },
] } as unknown as AssumptionSet;

// A cell as it prints (Polish 5 T1: a cell is a figure, a text leaf or an absence word, each with its text).
const shown = (c: { text: string }) => c.text;

describe("leaves", () => {
  it("walks objects and arrays to stored leaves, skipping kind, and keeps each stored value", () => {
    expect(leaves({ kind: "commitment-draw", rampRates: [0.35, 0.15], steadyRate: 0.02 })).toEqual([
      { path: "rampRates[0]", value: 0.35 },
      { path: "rampRates[1]", value: 0.15 },
      { path: "steadyRate", value: 0.02 },
    ]);
  });
});

describe("byKindModel", () => {
  it("maps each layer to its overlay kinds", () => {
    expect(KIND_OF_LAYER["data/assumptions/decay"]).toEqual(["nmd-decay"]);
    expect(KIND_OF_LAYER["data/assumptions/renewal-draws"]).toEqual(["cd-rollover", "commitment-draw"]);
    expect(KIND_OF_LAYER["data/assumptions/loan-repricing"]).toEqual(["loan-client-rate"]);
  });
  it("the loan repricing layer shows the stored flat-carry spread, and Not bound for a set without it", () => {
    const loan = { schemaVersion: "1.0.0", id: "loan", label: "Loan repricing", bindings: [
      { familyId: "mortgages", overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 250 }, modelVersion: "illustrative-flat-carry-1" },
    ] } as unknown as AssumptionSet;
    const other = { schemaVersion: "1.0.0", id: "other", label: "Other", bindings: [
      { familyId: "mbs", overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp: 180 }, modelVersion: "illustrative-flat-carry-1" },
    ] } as unknown as AssumptionSet;
    const m = byKindModel([demo, loan, other], KIND_OF_LAYER["data/assumptions/loan-repricing"]);
    expect(m.columns.map((c) => c.id)).toEqual(["loan", "other"]);
    expect(m.rows.map((r) => [r.familyId, r.path, ...r.cells.map(shown)])).toEqual([
      ["mortgages", "model", "flat-carry", "Not bound"],
      ["mortgages", "totalSpreadBp", "250", "Not bound"],
      ["mbs", "model", "Not bound", "flat-carry"],
      ["mbs", "totalSpreadBp", "Not bound", "180"],
    ]);
  });
  it("one column per set that binds the kind, one row per family and leaf, stored values as text", () => {
    const m = byKindModel([demo, stress, draws], ["nmd-decay"]);
    expect(m.columns.map((c) => c.id)).toEqual(["demo", "stress"]);
    expect(m.rows.map((r) => [r.familyId, r.path, ...r.cells.map(shown)])).toEqual([
      ["dda", "params.closureSteady", "0.75", "1.5"],
      ["dda", "params.maxRateDecay", "3", "6"],
    ]);
  });
  it("a set without the binding for that family prints Not bound", () => {
    const other = { ...stress, id: "other", bindings: [{ ...stress.bindings[0]!, familyId: "sav" }] } as AssumptionSet;
    const m = byKindModel([demo, other], ["nmd-decay"]);
    expect(m.rows.find((r) => r.familyId === "sav" && r.path === "params.closureSteady")!.cells.map(shown)).toEqual(["Not bound", "1.5"]);
  });
  it("a set that binds the group but lacks the leaf prints Not stored, not Not bound", () => {
    const longer = { schemaVersion: "1.0.0", id: "long", label: "Longer ramp", bindings: [
      { familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [0.4, 0.2, 0.1], steadyRate: 0.03 }, modelVersion: "engine-commitment-draw-1" },
    ] } as unknown as AssumptionSet;
    const empty = { schemaVersion: "1.0.0", id: "empty", label: "Empty ramp", bindings: [
      { familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [], steadyRate: 0.01 }, modelVersion: "engine-commitment-draw-1" },
    ] } as unknown as AssumptionSet;
    const m = byKindModel([draws, longer, empty], ["commitment-draw"]);
    expect(m.columns.map((c) => c.id)).toEqual(["sq", "long", "empty"]);
    expect(m.rows.map((r) => [r.familyId, r.path, ...r.cells.map(shown)])).toEqual([
      ["lines", "rampRates[0]", "0.35", "0.4", "Not stored"],
      ["lines", "rampRates[1]", "0.15", "0.2", "Not stored"],
      ["lines", "steadyRate", "0.02", "0.03", "0.01"],
      ["lines", "rampRates[2]", "Not stored", "0.1", "Not stored"],
    ]);
  });
  it("a set that binds the kind on another family only prints Not bound for this family's rows", () => {
    const union = { schemaVersion: "1.0.0", id: "u", label: "Union", bindings: [
      { familyId: "mtg", overlay: { kind: "prepay", model: "cpr", cpr: 0.06 }, modelVersion: "engine-prepay-1" },
    ] } as unknown as AssumptionSet;
    const other = { schemaVersion: "1.0.0", id: "v", label: "Other model", bindings: [
      { familyId: "mtg", overlay: { kind: "prepay", model: "psa", psaSpeed: 1.5 }, modelVersion: "engine-prepay-1" },
      { familyId: "heloc", overlay: { kind: "prepay", model: "cpr", cpr: 0.1 }, modelVersion: "engine-prepay-1" },
    ] } as unknown as AssumptionSet;
    const m = byKindModel([union, other], ["prepay"]);
    expect(m.rows.map((r) => [r.familyId, r.path, ...r.cells.map(shown)])).toEqual([
      ["mtg", "model", "cpr", "psa"],
      ["mtg", "cpr", "0.06", "Not stored"],
      ["mtg", "psaSpeed", "Not stored", "1.5"],
      ["heloc", "model", "Not bound", "cpr"],
      ["heloc", "cpr", "Not bound", "0.1"],
    ]);
  });
  it("selectors that differ only in key order share one row", () => {
    const a = { schemaVersion: "1.0.0", id: "a", label: "A", bindings: [
      { familyId: "dda", selector: { tier: "retail", region: ["west", "east"] }, overlay: { kind: "nmd-decay", params: { closureSteady: 0.5 } }, modelVersion: "kernel-nmd-decay-1" },
    ] } as unknown as AssumptionSet;
    const b = { schemaVersion: "1.0.0", id: "b", label: "B", bindings: [
      { familyId: "dda", selector: { region: ["east", "west"], tier: ["retail"] }, overlay: { kind: "nmd-decay", params: { closureSteady: 0.9 } }, modelVersion: "kernel-nmd-decay-1" },
    ] } as unknown as AssumptionSet;
    const m = byKindModel([a, b], ["nmd-decay"]);
    expect(m.rows.map((r) => [r.familyId, r.selector, r.path, ...r.cells.map(shown)])).toEqual([
      ["dda", "region: east or west and tier: retail", "params.closureSteady", "0.5", "0.9"],
    ]);
  });
  it("a binding without a selector prints whole family", () => {
    const m = byKindModel([demo], ["deposit-beta"]);
    expect(m.rows.map((r) => [r.familyId, r.selector, r.path, ...r.cells.map(shown)])).toEqual([["mma", "whole family", "params.betaMin", "0.45"]]);
  });
});

describe("ByKindView", () => {
  it("prints Not bound and Not stored muted, a stored value as a figure with its stored text as the title (Polish 5 T1)", () => {
    const union = { schemaVersion: "1.0.0", id: "u", label: "Union", bindings: [
      { familyId: "mtg", overlay: { kind: "prepay", model: "cpr", cpr: 0.06 }, modelVersion: "engine-prepay-1" },
    ] } as unknown as AssumptionSet;
    const other = { schemaVersion: "1.0.0", id: "v", label: "Other model", bindings: [
      { familyId: "mtg", overlay: { kind: "prepay", model: "psa", psaSpeed: 1.5 }, modelVersion: "engine-prepay-1" },
      { familyId: "heloc", overlay: { kind: "prepay", model: "cpr", cpr: 0.1 }, modelVersion: "engine-prepay-1" },
    ] } as unknown as AssumptionSet;
    const html = renderToStaticMarkup(createElement(ByKindView, { ws: "ws-a", kinds: ["prepay"], model: byKindModel([union, other], ["prepay"]), query: { book: "b1" } }));
    expect(html).toContain('<tr><th scope="row" class="mono">mtg</th><td class="words">whole family</td><td class="mono">cpr</td><td class="num words" title="0.06">0.06</td><td class="num muted words">Not stored</td></tr>');
    expect(html).toContain('<tr><th scope="row" class="mono">heloc</th><td class="words">whole family</td><td class="mono">cpr</td><td class="num muted words">Not bound</td><td class="num words" title="0.1">0.1</td></tr>');
  });
  it("links each set column to Edit a set for that set inside the workspace, and no longer to the Workbench (Piece 4a)", () => {
    const union = { schemaVersion: "1.0.0", id: "u", label: "Union", bindings: [
      { familyId: "mtg", overlay: { kind: "prepay", model: "cpr", cpr: 0.06 }, modelVersion: "engine-prepay-1" },
    ] } as unknown as AssumptionSet;
    const html = renderToStaticMarkup(createElement(ByKindView, { ws: "ws-a", kinds: ["prepay"], model: byKindModel([union], ["prepay"]), query: { book: "b1" } }));
    expect(html).toContain('<a href="#/ws/ws-a/assumptions/sets?set=u" aria-label="Edit u">Edit</a>');
    expect(html).not.toContain("Workbench");
    expect(html).not.toContain("no schema is declared");
  });
});
