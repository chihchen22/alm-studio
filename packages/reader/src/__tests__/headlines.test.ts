// packages/reader/src/__tests__/headlines.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunResult } from "@alm/engine";
import { formatHeadline, headlineFor, headlinesFor, NOT_IN_RUN, readPath, readSeries, scenarioSelector } from "../headlines";
import { signedMM, usdMM } from "../format";

const FIXTURE = fileURLToPath(new URL("../../../../apps/viewer/public/runResult.json", import.meta.url));
const BASE = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { runResult: RunResult }).runResult;
const fresh = (): RunResult => structuredClone(BASE);

describe("headlinesFor", () => {
  it("lists EVE per eve scenario, then NII 12m and 24m per nii scenario, in envelope order", () => {
    const r = fresh();
    const h = headlinesFor(r);
    expect(h.length).toBe(r.eve.byScenario.length + 2 * r.nii.byScenario.length);
    expect(h[0]).toEqual({
      id: "eve:S0", metric: "eve", scenarioId: "S0", label: "EVE",
      envelopePath: "eve.byScenario[scenarioId=S0].eve", format: "usdMM",
    });
    expect(h.filter((x) => x.metric === "nii24").map((x) => x.envelopePath)).toContain("nii.byScenario[scenarioId=S-200].totalNet24");
    expect(new Set(h.map((x) => x.id)).size).toBe(h.length);
  });

  it("reads each headline's path to the stored field, restated by direct access", () => {
    const r = fresh();
    for (const h of headlinesFor(r)) {
      const read = readPath(r, h.envelopePath);
      const expected = h.metric === "eve"
        ? r.eve.byScenario.find((s) => s.scenarioId === h.scenarioId)?.eve
        : h.metric === "nii12"
          ? r.nii.byScenario.find((s) => s.scenarioId === h.scenarioId)?.totalNet12
          : r.nii.byScenario.find((s) => s.scenarioId === h.scenarioId)?.totalNet24;
      expect(read).toEqual({ kind: "value", value: expected });
    }
  });

  it("formats EVE with usdMM and NII with signedMM, the viewer's formatters", () => {
    expect(formatHeadline(headlineFor("eve", "S0"), 574278133.25)).toBe(usdMM(574278133.25));
    expect(formatHeadline(headlineFor("nii12", "S0"), -1234567)).toBe(signedMM(-1234567));
  });
});

describe("readPath never fabricates", () => {
  it("a removed field reads as not in this run, with a reason naming it", () => {
    const r = fresh();
    delete (r.nii.byScenario[1] as Partial<(typeof r.nii.byScenario)[number]>).totalNet24;
    const read = readPath(r, headlineFor("nii24", r.nii.byScenario[1]!.scenarioId).envelopePath);
    expect(read.kind).toBe("not-in-run");
    if (read.kind === "not-in-run") expect(read.reason).toContain("totalNet24");
    expect(NOT_IN_RUN).toBe("Not in this run");
  });

  it("a scenario the envelope lacks reads as not in this run", () => {
    const read = readPath(fresh(), "eve.byScenario[scenarioId=S999].eve");
    expect(read).toEqual({ kind: "not-in-run", reason: "eve.byScenario has no entry with scenarioId=S999" });
  });

  it("a removed block reads as not in this run", () => {
    const r = fresh() as Partial<RunResult>;
    delete r.eve;
    expect(readPath(r, "eve.byScenario[scenarioId=S0].eve")).toEqual({ kind: "not-in-run", reason: "the envelope has no eve" });
  });

  it("a field that is not a number is not read as one", () => {
    const read = readPath(fresh(), "eve.byScenario[scenarioId=S0].byFamily");
    expect(read.kind).toBe("not-in-run");
  });

  it("readSeries hands back the stored vector itself", () => {
    const r = fresh();
    const s = readSeries(r, "nii.byScenario[scenarioId=S0].netMonthly");
    expect(s.kind).toBe("series");
    if (s.kind === "series") expect(s.values).toBe(r.nii.byScenario[0]!.netMonthly);
  });
});

describe("scenario ids holding \".\" or \"]\"", () => {
  const ODD = ["Up 0.5", "S[x]"];

  function renamed(id: string): RunResult {
    const r = fresh();
    r.eve.byScenario[1]!.scenarioId = id;
    r.nii.byScenario[1]!.scenarioId = id;
    return r;
  }

  for (const id of ODD) {
    it(`reads the present values for "${id}"`, () => {
      const r = renamed(id);
      expect(readPath(r, headlineFor("eve", id).envelopePath)).toEqual({ kind: "value", value: r.eve.byScenario[1]!.eve });
      expect(readPath(r, headlineFor("nii12", id).envelopePath)).toEqual({ kind: "value", value: r.nii.byScenario[1]!.totalNet12 });
      expect(readPath(r, headlineFor("nii24", id).envelopePath)).toEqual({ kind: "value", value: r.nii.byScenario[1]!.totalNet24 });
      const s = readSeries(r, `nii.byScenario${scenarioSelector(id)}.netMonthly`);
      expect(s.kind).toBe("series");
      if (s.kind === "series") expect(s.values).toBe(r.nii.byScenario[1]!.netMonthly);
      for (const h of headlinesFor(r)) expect(readPath(r, h.envelopePath).kind).toBe("value");
    });

    it(`is truly not in this run when "${id}" is absent`, () => {
      expect(readPath(fresh(), headlineFor("eve", id).envelopePath)).toEqual({
        kind: "not-in-run",
        reason: `eve.byScenario has no entry with scenarioId=${id}`,
      });
    });
  }

  it("an id the path grammar cannot hold fails loudly, never as not in this run", () => {
    expect(headlineFor("eve", "a].b").envelopePath).toBe("eve.byScenario[scenarioId=a].b].eve");
    expect(() => scenarioSelector("")).toThrow(/cannot be written/);
    expect(() => headlineFor("eve", "")).toThrow(/cannot be written/);
  });

  it("reads a scenario whose id holds ']. ' and keeps two-selector paths working", () => {
    const r = fresh();
    r.eve.byScenario[0]!.scenarioId = "a].b";
    expect(readPath(r, `eve.byScenario${scenarioSelector("a].b")}.eve`)).toEqual({ kind: "value", value: r.eve.byScenario[0]!.eve });
    const fam = r.eve.byScenario[0]!.byFamily[0]!;
    expect(readPath(r, `eve.byScenario[scenarioId=a].b].byFamily[familyId=${fam.familyId}].pv`).kind).toBe("value");
    expect(readPath(r, "eve.byScenario[scenarioId=a].b].nope")).toEqual({ kind: "not-in-run", reason: "eve.byScenario[scenarioId=a].b] has no nope" });
  });

  it("writes a selector only when it parses back to the same id", () => {
    expect(() => scenarioSelector("a].b[k=c")).toThrow(/cannot be written/);
    expect(() => headlineFor("eve", "a].b[k=c")).toThrow(/cannot be written/);
    for (const id of ["a].b", "S].0", "Up 0.5", "S[x]"]) expect(scenarioSelector(id)).toBe(`[scenarioId=${id}]`);
  });
});
