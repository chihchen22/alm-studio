/**
 * The Rates tab's short-rate fan: a 1.2.0 BGM fan is drawn
 * and reads its model and Rebonato parameters; the Hull-White fan keeps its a and sigma line. Neither
 * ever prints an undefined parameter. The BGM fan is real engine output (a committed envelope in `fixtures/`); the
 * Hull-White fan below is a hand-built three-step fan carrying the golden's a and sigma.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BgmRateFan, StochasticRateFan } from "@alm/engine";
import { fanRows } from "@alm/reader";
import { FanSection } from "../components/RatesPanel";

const BGM_FAN = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/rate-fan-bgm-vanilla-64-12m.json", import.meta.url)), "utf8"),
) as BgmRateFan;

const q = (values: number[]) => [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => ({ p, values }));
const HW_FAN: StochasticRateFan = {
  scenarioId: "S0",
  nPaths: 64,
  a: 0.010724117190284644,
  sigma: 0.006116484379837266,
  times: [1 / 12, 2 / 12, 3 / 12],
  mean: [0.04, 0.041, 0.042],
  quantiles: q([0.04, 0.041, 0.042]),
};

const render = (fan: StochasticRateFan | BgmRateFan): string =>
  renderToStaticMarkup(<FanSection fan={fan} rows={fanRows(fan)} seriesName={(id) => `scenario ${id}`} />);
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("FanSection", () => {
  it("a BGM fan: drawn from its 12 stored steps, naming the model and the Rebonato parameters verbatim", () => {
    expect(fanRows(BGM_FAN)).toHaveLength(12);
    const html = render(BGM_FAN);
    const t = text(html);
    expect(html).not.toMatch(/undefined|NaN/);
    expect(t).toContain("1-day saved forward");
    expect(t).toContain(
      "Paths 64 , model bgm-lmm-2f , Rebonato a 0.2028720214643671 , b 0.5109045397295916 , c 0.4810244306875239 , " +
        "d 0.8032210913057348 , beta -0.000006838184228279072 , volScalar 0.03111624859199792 , displacement 0.05 , " +
        "CEV exponent 0.5 , as the rate document reports them.",
    );
    expect(t).not.toContain("Hull-White");
    expect(t).not.toContain("sigma");
  });

  it("a Hull-White fan keeps its a and sigma line", () => {
    const html = render(HW_FAN);
    const t = text(html);
    expect(html).not.toMatch(/undefined|NaN/);
    expect(t).toContain("Paths 64 , Hull-White a 0.010724117190284644 , sigma 0.006116484379837266 , as the envelope reports them.");
    expect(t).not.toContain("Rebonato");
  });
});
