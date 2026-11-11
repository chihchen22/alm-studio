// apps/studio/src/__tests__/limitUseModel.test.ts
/** Controls (limits): the Dashboard's Limit use rows, one per lens, from the stored readings and the stored labels. */
import { describe, expect, it } from "vitest";
import { ApiError, type LensListItem, type RunLensesResponse } from "@alm/reader";
import { limitUseModel } from "../dashboard/limitUseModel";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { LimitUseCard } from "../pages/dashboard/DashboardPage";

const M = "−";

const readings = {
  baseScenarioId: "S0",
  lenses: [
    // A pass lens with a fraction-basis headline.
    { lensId: "rate-demo-v1", objective: "rate", baseScenarioId: "S0", byScenario: [], headline: 0.1234, worst: { scenarioId: "S200", constraintId: "eve-15" }, status: "pass" },
    // A breach lens: the headline is negative.
    { lensId: "balance-demo-v1", objective: "strategy", baseScenarioId: "S0", byScenario: [], headline: -0.3, worst: { scenarioId: "S-100", constraintId: "runoff-50" }, status: "breach" },
    // An unobservable lens: no headline is stored.
    { lensId: "capital-demo-v1", objective: "capital", baseScenarioId: "S0", byScenario: [], status: "unobservable" },
  ],
} as unknown as RunLensesResponse;

const definitions = [
  { id: "balance-demo-v1", label: "Balance runoff (demonstration limits, reads the demonstration metric)" },
  { id: "capital-demo-v1", label: "Capital (demonstration limits)" },
  { id: "rate-demo-v1", label: "Interest-rate risk (demonstration limits)" },
] as unknown as LensListItem[];

describe("limitUseModel", () => {
  it("one row per lens in the reading's order: stored label, worst status with its icon, the headline as a percent of the limit", () => {
    const m = limitUseModel({ state: "ok", value: { readings, definitions } });
    expect(m).toEqual({
      state: "ok",
      rows: [
        {
          lensId: "rate-demo-v1",
          label: "Interest-rate risk (demonstration limits)",
          status: "pass",
          statusText: "✓ Pass",
          statusClass: "status status-pass",
          headroom: "+12.34% of limit",
          worst: "at S200, constraint eve-15",
        },
        {
          lensId: "balance-demo-v1",
          label: "Balance runoff (demonstration limits, reads the demonstration metric)",
          status: "breach",
          statusText: "✕ Breach",
          statusClass: "status status-breach",
          headroom: `${M}30.00% of limit`,
          worst: "at S-100, constraint runoff-50",
        },
        {
          lensId: "capital-demo-v1",
          label: "Capital (demonstration limits)",
          status: "unobservable",
          statusText: "Unobservable",
          statusClass: "status status-unobs",
          headroom: null,
          worst: null,
        },
      ],
    });
  });

  it("a lens the definition list does not hold prints its id as the label", () => {
    const m = limitUseModel({ state: "ok", value: { readings, definitions: [] } });
    expect(m.state === "ok" ? m.rows.map((r) => r.label) : null).toEqual(["rate-demo-v1", "balance-demo-v1", "capital-demo-v1"]);
  });

  it("a failed lens read is the error state with the server's status and message", () => {
    const m = limitUseModel({ state: "error", error: new ApiError(422, "unprocessable", "lens \"x\" is not valid") });
    expect(m).toEqual({ state: "error", text: "422: lens \"x\" is not valid" });
  });

  it("loading stays loading", () => {
    expect(limitUseModel({ state: "loading" })).toEqual({ state: "loading" });
  });

  // S3c fix round (M3): a credit or component decay run carries no value (EVE) scenario, so the route refuses every lens
  // with a 422; the card says why in plain words and never prints the route's text.
  it("a run whose value block carries no scenario reads 'not applicable' in a plain sentence, never the 422 text", () => {
    const refusal = { state: "error" as const, error: new ApiError(422, "unprocessable", 'lens "rate-demo-v1" is unavailable: the base scenario "S0" is not on this envelope; this envelope carries []') };
    const m = limitUseModel(refusal, { eve: { byScenario: [] } });
    expect(m.state).toBe("not-applicable");
    const text = m.state === "not-applicable" ? m.text : "";
    expect(text).toBe("Limits do not apply to this run: every lens reads value (EVE) or earnings (NII) at the base scenario, and this run carries neither, because its deposit form prices volume or transfer rates. Read the limits on a run of the same book that carries them.");
    expect(text).not.toMatch(/422|envelope/);
    const html = renderToStaticMarkup(createElement(LimitUseCard, { runId: "run-x", model: m }));
    expect(html).toContain("Not applicable");
    expect(html).not.toMatch(/422|Lenses refused/);
    // A run that does carry value keeps the route's refusal, as before.
    expect(limitUseModel(refusal, { eve: { byScenario: [{ scenarioId: "S0" }] } }).state).toBe("error");
    expect(limitUseModel(refusal).state).toBe("error");
  });
});
