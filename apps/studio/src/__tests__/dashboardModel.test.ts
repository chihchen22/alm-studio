// apps/studio/src/__tests__/dashboardModel.test.ts
import { describe, expect, it } from "vitest";
import type { RunResult } from "@alm/engine";
import type { RunDetail } from "@alm/reader";
import { money, signedMoney, signedRatio } from "../format/figures";
import { dashboardModel } from "../dashboard/dashboardModel";

const M = "−";

describe("figures", () => {
  it("prints millions with one decimal and a true minus", () => {
    expect(money(574_278_133.25)).toBe("$574.3M");
    expect(money(-12_100_000)).toBe(`${M}$12.1M`);
    expect(signedMoney(25_314_111)).toBe("+$25.3M");
    expect(signedMoney(-186_278_877)).toBe(`${M}$186.3M`);
    expect(signedMoney(0)).toBe("$0.0M");
    expect(signedRatio(-0.32437)).toBe(`${M}32.4%`);
    expect(signedRatio(0.04408)).toBe("+4.4%");
  });
  it("prints no sign when the rounded figure is zero", () => {
    expect(money(-10_000)).toBe("$0.0M");
    expect(signedMoney(-10_000)).toBe("$0.0M");
    expect(signedMoney(10_000)).toBe("$0.0M");
    expect(signedRatio(-0.0004)).toBe("0.0%");
    expect(signedRatio(0.0004)).toBe("0.0%");
  });
});

const detail = {
  runId: "r1", state: "done",
  scenarios: [
    { id: "S0", label: "S0", rateSpec: { kind: "base" } },
    { id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 } },
    { id: "S-200", label: "S-200", rateSpec: { kind: "parallel", shockBp: -200 } },
    { id: "STEEP100", label: "Steepener +100 long", rateSpec: { kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 } },
  ],
} as unknown as RunDetail;

const result = {
  eve: { byScenario: [
    { scenarioId: "S0", eve: 574_278_133, deltaEveVsBase: 0, deltaEvePct: 0 },
    { scenarioId: "S200", eve: 387_999_256, deltaEveVsBase: -186_278_877, deltaEvePct: -0.3243704 },
    { scenarioId: "S-200", eve: 534_992_936, deltaEveVsBase: -39_285_197, deltaEvePct: -0.0684080 },
    { scenarioId: "STEEP100", eve: 479_386_266, deltaEveVsBase: -94_891_867, deltaEvePct: -0.1652368 },
  ] },
  nii: { horizonsMonths: [12, 24], byScenario: [
    { scenarioId: "S0", totalNet12: 20_000_000, totalNet24: 36_800_000 },
    { scenarioId: "S200", totalNet12: 34_300_000, totalNet24: 66_300_000 },
    { scenarioId: "S-200", totalNet12: -12_100_000, totalNet24: -51_800_000 },
    { scenarioId: "STEEP100", totalNet12: 21_600_000, totalNet24: 42_500_000 },
  ] },
} as unknown as RunResult;

const GRID = ["S0", "S100", "S-100", "S200", "S-200"];

describe("dashboardModel", () => {
  const m = dashboardModel(result, detail, GRID);
  const card = (k: string) => m.cards.find((c) => c.key === k)!;

  it("EVE base is the first base-rate scenario's stored eve", () => {
    expect(card("eve-base").value).toBe("$574.3M");
    expect(card("eve-base").field).toBe("eve.byScenario[scenarioId=S0].eve");
    expect(card("eve-base").sub).toBe("Base");
    expect(card("eve-base").absent).toBe(false);
  });
  it("worst EVE shock is the lowest stored deltaEveVsBase, with its stored percent", () => {
    expect(card("eve-worst").value).toBe(`${M}$186.3M`);
    expect(card("eve-worst").sub).toBe(`${M}32.4% · +200bp`);
    expect(card("eve-worst").tone).toBe("neg");
    expect(card("eve-worst").field).toBe("eve.byScenario[scenarioId=S200].deltaEveVsBase");
  });
  it("NII card: base totalNet12 and the lowest stored totalNet12, named", () => {
    expect(card("nii12").value).toBe("$20.0M");
    expect(card("nii12").sub).toBe(`Lowest ${M}$12.1M · -200bp`);
  });
  it("stress card: first scenario not in the regulatory grid", () => {
    expect(card("stress").value).toBe("$479.4M");
    expect(card("stress").sub).toBe(`Twist 0/+100bp · ${M}$94.9M`);
    expect(card("stress").absent).toBe(false);
  });
  it("rows carry the label the EVE layer prints, formatted from the stored rateSpec", () => {
    expect(m.rows.map((r) => [r.scenarioId, r.label])).toEqual([["S0", "Base"], ["S200", "+200bp"], ["S-200", "-200bp"], ["STEEP100", "Twist 0/+100bp"]]);
  });
  it("one row per scenario with stored fields only", () => {
    expect(m.rows.map((r) => [r.scenarioId, r.eve, r.deltaEve, r.nii12, r.nii24])).toEqual([
      ["S0", "$574.3M", "$0.0M", "$20.0M", "$36.8M"],
      ["S200", "$388.0M", `${M}$186.3M`, "$34.3M", "$66.3M"],
      ["S-200", "$535.0M", `${M}$39.3M`, `${M}$12.1M`, `${M}$51.8M`],
      ["STEEP100", "$479.4M", `${M}$94.9M`, "$21.6M", "$42.5M"],
    ]);
  });
  it("no stress scenario says so", () => {
    const only = { ...result, eve: { byScenario: result.eve.byScenario.slice(0, 3) } } as RunResult;
    const none = dashboardModel(only, detail, GRID).cards.find((c) => c.key === "stress")!;
    expect([none.value, none.sub, none.absent]).toEqual(["Not in this run", "Every scenario besides base is on the regulatory grid.", true]);
  });
  it("with no regulatory-grid-v1 in the plan library the stress card is Unobservable with the reason", () => {
    const noGrid = dashboardModel(result, detail, null);
    expect(noGrid.cards.find((c) => c.key === "stress")).toEqual({
      key: "stress", label: "Stress scenario", value: "Unobservable", sub: "regulatory-grid-v1 is not in /api/plans/library",
      field: null, tone: null, absent: true,
    });
    // The other cards do not read the grid and are unchanged.
    expect(noGrid.cards.filter((c) => c.key !== "stress")).toEqual(m.cards.filter((c) => c.key !== "stress"));
  });
  it("a base scenario outside the grid is never the stress scenario", () => {
    const offGrid = {
      runId: "r2", state: "done",
      scenarios: [
        { id: "BASE", label: "Base case", rateSpec: { kind: "base" } },
        { id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 } },
        { id: "STEEP100", label: "Steepener +100 long", rateSpec: { kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 } },
      ],
    } as unknown as RunDetail;
    const withStress = {
      eve: { byScenario: [
        { scenarioId: "BASE", eve: 574_278_133, deltaEveVsBase: 0, deltaEvePct: 0 },
        { scenarioId: "S200", eve: 387_999_256, deltaEveVsBase: -186_278_877, deltaEvePct: -0.3243704 },
        { scenarioId: "STEEP100", eve: 479_386_266, deltaEveVsBase: -94_891_867, deltaEvePct: -0.1652368 },
      ] },
    } as unknown as RunResult;
    const stress = dashboardModel(withStress, offGrid, GRID).cards.find((c) => c.key === "stress")!;
    expect(stress.value).toBe("$479.4M");
    expect(stress.sub).toBe(`Twist 0/+100bp · ${M}$94.9M`);
    expect(stress.field).toBe("eve.byScenario[scenarioId=STEEP100].eve");

    const baseOnly = { eve: { byScenario: withStress.eve.byScenario.slice(0, 2) } } as unknown as RunResult;
    const none = dashboardModel(baseOnly, offGrid, GRID).cards.find((c) => c.key === "stress")!;
    expect(none.value).toBe("Not in this run");
    expect(none.absent).toBe(true);
    expect(none.sub).toBe("Every scenario besides base is on the regulatory grid.");
    expect(none.field).toBe(null);
  });
  it("a run without an eve block prints Not in this run", () => {
    const noEve = { nii: result.nii } as unknown as RunResult;
    const cards = dashboardModel(noEve, detail, GRID).cards;
    expect(cards.find((c) => c.key === "eve-base")!.value).toBe("Not in this run");
    const worst = cards.find((c) => c.key === "eve-worst")!;
    expect([worst.value, worst.sub, worst.field, worst.tone]).toEqual(["Not in this run", "The run carries no EVE block.", null, null]);
    const stress = cards.find((c) => c.key === "stress")!;
    expect([stress.value, stress.sub, stress.field, stress.tone]).toEqual(["Not in this run", "The run carries no EVE block.", null, null]);
    expect(cards.map((c) => [c.key, c.absent])).toEqual([["eve-base", true], ["eve-worst", true], ["nii12", false], ["stress", true]]);
  });
  it("a run with an NII block and no EVE block prints the stored base NII", () => {
    const noEve = { nii: result.nii } as unknown as RunResult;
    const nii = dashboardModel(noEve, detail, GRID).cards.find((c) => c.key === "nii12")!;
    expect([nii.value, nii.sub, nii.field, nii.absent]).toEqual([
      "$20.0M",
      `Lowest ${M}$12.1M · -200bp`,
      "nii.byScenario[scenarioId=S0].totalNet12",
      false,
    ]);
  });
  it("a detail with no base-rate scenario says so on the NII card", () => {
    const noBase = { ...detail, scenarios: detail.scenarios.slice(1) } as unknown as RunDetail;
    const nii = dashboardModel(result, noBase, GRID).cards.find((c) => c.key === "nii12")!;
    expect([nii.value, nii.sub, nii.field, nii.absent]).toEqual(["Not in this run", "No base-rate scenario in this run.", null, true]);
  });
  it("delta tone follows the printed sign", () => {
    expect(m.rows.map((r) => r.deltaTone)).toEqual([null, "neg", "neg", "neg"]);
    const tiny = {
      eve: { byScenario: [
        { scenarioId: "S0", eve: 574_278_133, deltaEveVsBase: 0, deltaEvePct: 0 },
        { scenarioId: "S200", eve: 574_268_133, deltaEveVsBase: -10_000, deltaEvePct: -0.0000174 },
        { scenarioId: "S-200", eve: 574_288_133, deltaEveVsBase: 10_000, deltaEvePct: 0.0000174 },
      ] },
    } as unknown as RunResult;
    const rows = dashboardModel(tiny, detail, GRID).rows;
    expect(rows.map((r) => [r.scenarioId, r.deltaEve, r.deltaTone])).toEqual([
      ["S0", "$0.0M", null],
      ["S200", "$0.0M", null],
      ["S-200", "$0.0M", null],
    ]);
  });
  it("worst EVE shock never names the base scenario", () => {
    const allUp = {
      eve: { byScenario: [
        { scenarioId: "S0", eve: 574_278_133, deltaEveVsBase: 0, deltaEvePct: 0 },
        { scenarioId: "S200", eve: 599_592_244, deltaEveVsBase: 25_314_111, deltaEvePct: 0.04408 },
        { scenarioId: "S-200", eve: 586_378_133, deltaEveVsBase: 12_100_000, deltaEvePct: 0.02107 },
      ] },
    } as unknown as RunResult;
    const worst = dashboardModel(allUp, detail, GRID).cards.find((c) => c.key === "eve-worst")!;
    expect(worst.value).toBe("+$12.1M");
    expect(worst.sub).toBe("+2.1% · -200bp");
    expect(worst.tone).toBe("pos");
    expect(worst.field).toBe("eve.byScenario[scenarioId=S-200].deltaEveVsBase");

    const baseOnly = { eve: { byScenario: allUp.eve.byScenario.slice(0, 1) } } as unknown as RunResult;
    const none = dashboardModel(baseOnly, detail, GRID).cards.find((c) => c.key === "eve-worst")!;
    expect([none.value, none.sub, none.field, none.tone, none.absent]).toEqual(["Not in this run", "No shocked scenario in this run.", null, null, true]);
  });
});
