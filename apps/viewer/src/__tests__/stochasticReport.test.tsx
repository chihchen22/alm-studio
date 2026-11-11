/**
 * The Workbench stochastic report: it prints the
 * calibration arm the envelope carries, for either model, and a stored 0.2.0 envelope still renders.
 *
 * Fixtures are real engine output: the committed Hull-White golden (schema 0.2.0),
 * the same envelope as a fresh 0.3.0 run writes it (Task 2 proved the bytes differ in schemaVersion alone),
 * and the committed BGM envelopes in `fixtures/`. Every expected string is restated by hand from those files.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StochasticRunResult } from "@alm/engine";
import { StochasticReport } from "../components/StochasticReport";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const GOLDEN_020 = read("../../../../packages/engine/src/run/__tests__/golden/stochastic-hw-vanilla-64.json");
const HW_020 = JSON.parse(GOLDEN_020) as StochasticRunResult;
const HW_030 = JSON.parse(GOLDEN_020.replace('"schemaVersion": "0.2.0"', '"schemaVersion": "0.3.0"')) as StochasticRunResult;
const BGM = JSON.parse(read("./fixtures/stochastic-bgm-vanilla-64.json")) as StochasticRunResult;
const BGM_OVERRIDE = JSON.parse(read("./fixtures/stochastic-bgm-override-vanilla-20.json")) as StochasticRunResult;

const render = (sto: StochasticRunResult): string =>
  renderToStaticMarkup(<StochasticReport sto={sto} jsonUrl="/api/runs/x/stochastic" />);

/** The visible text: tags dropped, entities for the apostrophe decoded, whitespace runs to one space. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;|’/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const VOL_NAMING = /cap (normal )?vol|cap quote|cap surface|swaption (quote|normal|grid|atm)/i;

function expectClean(html: string): void {
  expect(html).not.toMatch(/undefined|NaN/);
  expect(text(html)).not.toMatch(VOL_NAMING);
  // The placeholder for an arm this report could not lay out is gone.
  expect(html).not.toContain("does not lay out this calibration");
}

describe("Hull-White envelopes", () => {
  it("a stored 0.2.0 envelope renders its calibration in full, worded on the short-rate surface", () => {
    const html = render(HW_020);
    const t = text(html);
    expectClean(html);
    expect(t).toContain("Schema 0.2.0");
    expect(t).toContain("Model hull-white-1f");
    expect(t).toContain(
      "Hull-White parameters calibrated to the at-the-money column of the short-rate volatility surface of the snapshot.",
    );
    expect(t).toContain("RMSE gate passed: 0.900995 bp vs the 5 bp gate.");
    // a, sigma, RMSE, gate, breached, quotes, underlying tau, iterations, as sig() prints them.
    expect(t).toContain("cap-atm-calibration 0.0107241 0.00611648 0.900995 5 false 15 0.25 2000");
    expect(t).not.toContain("Simulation guards");
    expect(t).not.toContain("Rebonato");
  });

  it("a fresh 0.3.0 Hull-White envelope renders exactly as the stored 0.2.0 one, schema aside", () => {
    expect(render(HW_030)).toBe(render(HW_020).replace("<code>0.2.0</code>", "<code>0.3.0</code>"));
  });

  it("a Hull-White override renders the caller's reason and no gate", () => {
    const sto: StochasticRunResult = {
      ...HW_020,
      calibration: { source: "override", a: 0.03, sigma: 0.01, reason: "stress lever" },
    };
    const html = render(sto);
    const t = text(html);
    expectClean(html);
    expect(t).toContain("Parameters supplied by override");
    expect(t).toContain("override 0.03 0.01 stress lever");
    expect(t).not.toContain("RMSE gate");
  });
});

describe("BGM envelopes", () => {
  it("the calibrated arm: the six Rebonato values, displacement and CEV, the 10 bp gate breached, 28 subset points", () => {
    const html = render(BGM);
    const t = text(html);
    expectClean(html);
    expect(t).toContain("Schema 0.3.0");
    expect(t).toContain("Model bgm-lmm-2f");
    expect(t).toContain(
      "BGM parameters calibrated to the default subset of the long-yield volatility surface of the snapshot (28 points).",
    );
    expect(t).toContain("RMSE gate BREACHED: 12.4505 bp vs the 10 bp gate");
    expect(t).toContain("long-yield-atm-calibration 0.202872 0.510905 0.481024 0.803221 -0.00000683818 0.0311162 0.05 0.5");
    // RMSE, gate, breached, subset points, iterations.
    expect(t).toContain("12.4505 10 true 28 150");
    expect(t).toContain("Subset points (28)");
    // The first and last subset points, expiry then tenor, in grid order.
    expect(t).toContain("0.0833333 1");
    expect(t).toContain("10 10");
    expect(html.match(/<tr class="subset">/g)).toHaveLength(28);
    expect(t).not.toContain("Hull-White parameters");
  });

  it("the simulation block: guard counts, evolutions, saved tenors and the fixed cost", () => {
    const t = text(render(BGM));
    expect(t).toContain("Simulation guards");
    // ceiling fires, floor fires, evolutions, fixed cost (ms)
    expect(t).toContain("0 0 4,158,720 2659.33");
    expect(t).toContain("0.00277778, 0.0833333, 1, 2, 3, 5, 7, 10, 20, 30");
    expect(t).not.toContain("guard FIRED");
  });

  it("a nonzero guard count is flagged, never absorbed", () => {
    const sto: StochasticRunResult = { ...BGM, simulation: { ...BGM.simulation!, nCapFires: 3 } };
    expect(text(render(sto))).toContain("Simulation guard FIRED: 3 ceiling and 0 floor clamps over 4,158,720 evolutions");
  });

  it("the martingale block names the BGM short-rate analog, not the Hull-White convexity shift", () => {
    const t = text(render(BGM));
    expect(t).toContain("1-day saved forward");
    expect(t).not.toContain("convexity shift");
    expect(text(render(HW_020))).toContain("convexity shift");
  });

  it("the override arm: the caller's six values and reason, no gate, the simulation block kept", () => {
    const html = render(BGM_OVERRIDE);
    const t = text(html);
    expectClean(html);
    expect(t).toContain("BGM parameters supplied by override, not a market calibration");
    expect(t).toContain("override 0.2 0.5 0.48 0.8 0 0.031 illustrative parameters");
    expect(t).not.toContain("RMSE gate");
    expect(t).toContain("0 0 1,299,600 71.5571");
  });
});
