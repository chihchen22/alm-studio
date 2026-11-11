// apps/studio/src/__tests__/newBusiness.test.tsx
/** ALM Studio P2 fix wave: which scenarios carry new business, read from stored provenance fields only. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunResult } from "@alm/engine";
import type { RunDetail } from "@alm/reader";
import { newBusinessRead } from "../results/newBusiness";
import { FtpTab } from "../pages/results/FtpTab";
import { NiiTab } from "../pages/results/NiiTab";
import { dashboardModel } from "../dashboard/dashboardModel";
import { DashboardView } from "../pages/dashboard/DashboardPage";
import { DETAIL, freshResult } from "./fixtures/results";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const props = (result: RunResult) => ({ runId: "run-fixture", detail: DETAIL, result, query: {}, scenarioLabel: (id: string) => id });

/** The fixture run (base S0, shocks S100 to S-200) with base S0 mapped to a balance plan. */
function mappedBase(): RunResult {
  const r = freshResult();
  r.provenance.scenarioBalancePlanHashes = { S0: "9f7bdc9b" };
  return r;
}
function planLevel(unused: boolean): RunResult {
  const r = freshResult();
  r.provenance.balancePlanHash = "f34aa81c";
  if (unused) r.notImplemented = [{ _tag: "NotImplemented", layer: "plan.balance-plan.unused", reason: "no scenario consumed it" } as never];
  return r;
}

const NII_NOTE = "Scenarios with a balance plan include new-business income. A scenario without one runs off unless it carries its own new-business rules, which the stored fields do not show. A difference between scenarios is then not rate sensitivity alone.";
const MARK_NOTE = "Marked New business: the scenarios provenance.scenarioBalancePlanHashes names.";
const PLAN_LEVEL_NOTE = "The plan-level balance plan (provenance.balancePlanHash) feeds every scenario without its own balance plan or new-business rules; the stored fields do not name those scenarios, so they are not marked.";

describe("newBusinessRead", () => {
  it("is null when provenance names no balance plan", () => {
    expect(newBusinessRead(freshResult())).toBe(null);
  });
  it("lists the mapped scenario ids as stored", () => {
    expect(newBusinessRead(mappedBase())).toEqual({ mapped: ["S0"], planLevel: false });
  });
  it("reads a plan-level balance plan, unless the plan.balance-plan.unused tag says no scenario took it", () => {
    expect(newBusinessRead(planLevel(false))).toEqual({ mapped: [], planLevel: true });
    expect(newBusinessRead(planLevel(true))).toBe(null);
  });
});

describe("FTP bridge with new business on the base scenario (D1)", () => {
  it("says NII includes new-business income and the bridge covers the contractual book only", () => {
    const t = text(renderToStaticMarkup(<FtpTab ws="ws-a" {...props(mappedBase())} />));
    expect(t).toContain("The base scenario runs a balance plan (provenance.scenarioBalancePlanHashes names S0): NII net includes new-business income and the bridge covers the contractual book only, so the two differ by that income.");
  });
  it("states the condition in words when only a plan-level balance plan is stored", () => {
    const t = text(renderToStaticMarkup(<FtpTab ws="ws-a" {...props(planLevel(false))} />));
    expect(t).toContain("This run names a plan-level balance plan (provenance.balancePlanHash). The base scenario takes it unless it carries its own new-business rules, which the stored fields do not show. If the base runs new business, NII net includes that income and the bridge covers the contractual book only, so the two differ by that income.");
  });
  it("prints no note when the base runs off", () => {
    for (const r of [freshResult(), planLevel(true)]) {
      expect(text(renderToStaticMarkup(<FtpTab ws="ws-a" {...props(r)} />))).not.toContain("differ by that income");
    }
    const shockOnly = freshResult();
    shockOnly.provenance.scenarioBalancePlanHashes = { S100: "h" };
    expect(text(renderToStaticMarkup(<FtpTab ws="ws-a" {...props(shockOnly)} />))).not.toContain("differ by that income");
  });
});

describe("NII horizon table with new business (D4)", () => {
  it("prints one note and marks the mapped scenario by id", () => {
    const html = renderToStaticMarkup(<NiiTab ws="ws-a" {...props(mappedBase())} />);
    const t = text(html);
    expect(t).toContain(`${NII_NOTE} ${MARK_NOTE}`);
    expect(html).toContain('<span class="chip" title="provenance.scenarioBalancePlanHashes[S0]">New business</span>');
    expect(html.split(">New business</span>").length - 1).toBe(1);
  });
  it("with a plan-level plan only, says consumers are not marked and marks none", () => {
    const html = renderToStaticMarkup(<NiiTab ws="ws-a" {...props(planLevel(false))} />);
    expect(text(html)).toContain(`${NII_NOTE} ${PLAN_LEVEL_NOTE}`);
    expect(html).not.toContain(">New business</span>");
  });
  it("prints no note when no balance plan is stored", () => {
    expect(text(renderToStaticMarkup(<NiiTab ws="ws-a" {...props(freshResult())} />))).not.toContain("new-business income");
  });
});

describe("Dashboard with new business (D4)", () => {
  const detail = {
    runId: "r1", state: "done",
    scenarios: [{ id: "S0", label: "S0", rateSpec: { kind: "base" } }, { id: "S100", label: "S100", rateSpec: { kind: "parallel", shockBp: 100 } }],
  } as unknown as RunDetail;
  const result = {
    provenance: { scenarioBalancePlanHashes: { S0: "9f7bdc9b" } },
    notImplemented: [],
    eve: { byScenario: [{ scenarioId: "S0", eve: 1, deltaEveVsBase: 0, deltaEvePct: 0 }, { scenarioId: "S100", eve: 1, deltaEveVsBase: 0, deltaEvePct: 0 }] },
    nii: { byScenario: [{ scenarioId: "S0", totalNet12: 21_140_752, totalNet24: 48_200_000 }, { scenarioId: "S100", totalNet12: 11_772_965, totalNet24: 21_800_000 }] },
  } as unknown as RunResult;

  it("the model carries the note and flags the mapped row only", () => {
    const m = dashboardModel(result, detail, ["S0", "S100"]);
    expect(m.newBusinessNote).toBe(`${NII_NOTE} ${MARK_NOTE}`);
    expect(m.rows.map((r) => [r.scenarioId, r.newBusiness])).toEqual([["S0", true], ["S100", false]]);
  });
  it("the model carries no note without a stored balance plan", () => {
    const plain = { ...result, provenance: {} } as unknown as RunResult;
    const m = dashboardModel(plain, detail, ["S0", "S100"]);
    expect(m.newBusinessNote).toBe(null);
    expect(m.rows.every((r) => !r.newBusiness)).toBe(true);
  });
  it("the view prints the note once and marks the flagged row", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={dashboardModel(result, detail, ["S0", "S100"])} limitUse={{ state: "loading" }} />);
    expect(text(html)).toContain(`${NII_NOTE} ${MARK_NOTE}`);
    expect(html).toContain('<th scope="row" title="S0">Base <span class="chip" title="provenance.scenarioBalancePlanHashes[S0]">New business</span></th>');
    expect(html).toContain('<th scope="row" title="S100">+100bp</th>');
  });
});
