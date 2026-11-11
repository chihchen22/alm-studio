// apps/server/src/__tests__/studioStochasticRunAcceptance.test.tsx
/**
 * ALM Studio Stochastic distributions acceptance on a freshly seeded test
 * platform: the single-run page, the measure-layer link and both CSV links fed
 * by the real routes. Two stochastic runs (64 paths, the default seed 20260331)
 * on the public market pack and on its volatility-shocked derivation
 * vol-shock-demo-v1, and one deterministic run on the public pack (the ADR-031
 * setup). The expected strings are restated from a probe measured on the unmodified code and formatted by the existing 6-decimal rule;
 * none is read from the code they check, and both CSV addresses are written
 * out here rather than built by the reader helpers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getStochasticCompare, getStochasticSummary, listRuns, type RunSummary, type StochasticCompareReply } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import type { RunStatus } from "../jobs/types";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { StochasticCompareBody } from "../../../studio/src/pages/compare/StochasticCompareViews";
import { loadResults } from "../../../studio/src/pages/results/loadResults";
import { loadStochastic } from "../../../studio/src/pages/results/loadStochastic";
import { ResultsLayerBody } from "../../../studio/src/pages/results/ResultsPage";
import { StochasticRunBody, StochasticRunIndexView } from "../../../studio/src/pages/results/StochasticRunViews";
import { parseHash } from "../../../studio/src/router";

let t: TestPlatform;
let base: string; // stochastic, public market pack
let shock: string; // stochastic, vol-shock-demo-v1
let det: string; // deterministic, public market pack
let runs: RunSummary[];
let pair: StochasticCompareReply;
const realFetch = globalThis.fetch;

const BASE_ID = "market-public-2026-03-31";
const SHOCK_ID = "vol-shock-demo-v1";

const STOCH_NOTE =
  "This is a stochastic run. Its result is a Monte Carlo distribution envelope, not a deterministic result, so this layer does not read it; Stochastic distributions shows it.";
const DET_NOTE =
  "This is a deterministic run. A stochastic distribution exists only for a run submitted in stochastic mode; this run's results are on the measure layers.";

const submit = async (marketId: string, stochastic: boolean): Promise<string> => {
  const r = await api<{ runId: string }>(t.base, "POST", "/api/runs", {
    portfolioId: "vanilla-book-v1",
    marketId,
    scenarioSlateId: "regulatory-grid-vanilla",
    assumptionSetIds: ["vanilla-empty-v1"],
    ...(stochastic ? { mode: "stochastic", stochastic: { nPaths: 64 } } : {}),
  });
  expect(r.status).toBe(202);
  return r.body.runId;
};
const waitDone = async (runId: string): Promise<void> => {
  const done = await waitFor(
    async () => (await api<RunStatus>(t.base, "GET", `/api/runs/${runId}`)).body,
    (s) => s.state === "done" || s.state === "error",
    240_000,
  );
  expect(done.state, JSON.stringify(done.error ?? {})).toBe("done");
};

beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  base = await submit(BASE_ID, true);
  shock = await submit(SHOCK_ID, true);
  det = await submit(BASE_ID, false);
  for (const id of [base, shock, det]) await waitDone(id);
  // Studio's reader client calls relative /api paths; send them to the test platform.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
  runs = await listRuns();
  pair = await getStochasticCompare(base, shock);
}, 480_000);
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const text = (s: string) =>
  s.replace(/<wbr\/?>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const section = (html: string, label: string): string => {
  const m = html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`));
  if (m === null) throw new Error(`no section ${label}`);
  return m[1]!;
};
const rowsOf = (html: string): string[] => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => text(r[1]!));

const runBody = async (id: string): Promise<string> => renderToStaticMarkup(<StochasticRunBody runId={id} data={await loadStochastic(id)} />);
const compareBody = () =>
  renderToStaticMarkup(<StochasticCompareBody ws="ws-a" runs={runs} query={{ runs: `${base},${shock}` }} compare={{ state: "ok", value: pair }} />);

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED = [String.fromCharCode(0x2014), String.fromCharCode(0xa7)];

describe("Stochastic distributions from the real route", () => {
  it("the reader's summary is the route's JSON", async () => {
    const r = await api<unknown>(t.base, "GET", `/api/runs/${base}/stochastic/summary`);
    expect(r.status).toBe(200);
    expect(await getStochasticSummary(base)).toEqual(r.body);
  });

  it("the EVE distribution prints each stored statistic", async () => {
    const rows = rowsOf(section(await runBody(base), "EVE distribution"));
    for (const row of [
      // Printed on curve default 2 (was "Mean 121,065,587.850614"); deltas Step 1
      "Mean 120,866,072.269334",
      // Printed on curve default 2 (was "Standard error of the mean 61,217.956059"); deltas Step 1
      "Standard error of the mean 61,115.420038",
      // Printed on curve default 2 (was "Standard deviation (per path) 6,855,510.898899"); deltas Step 1
      "Standard deviation (per path) 6,843,610.473479",
      // Printed on curve default 2 (was "Minimum 106,362,170.767909"); deltas Step 1
      "Minimum 106,189,476.981676",
      // Printed on curve default 2 (was "Maximum 138,144,575.212733"); deltas Step 1
      "Maximum 137,914,055.936155",
      // Printed on curve default 2 (was "Quantile at 0.05 110,937,500.821428"); deltas Step 1
      "Quantile at 0.05 110,756,108.080049",
      // Printed on curve default 2 (was "Quantile at 0.5 120,774,862.14222"); deltas Step 1
      "Quantile at 0.5 120,577,338.825178",
      // Printed on curve default 2 (was "Quantile at 0.95 132,050,902.357294"); deltas Step 1
      "Quantile at 0.95 131,831,793.788606",
    ]) expect(rows).toContain(row);
  });

  it("the NII 12m distribution prints its mean, a standard error that rounds to 0, and the full value in the cell title", async () => {
    const nii = section(await runBody(base), "NII 12m distribution");
    const rows = rowsOf(nii);
    expect(rows).toContain("Mean 11,772,965.658385");
    expect(rows).toContain("Standard error of the mean 0");
    expect(nii).toContain('title="1.0036228337889995e-9"');
  });

  it("the run context and the calibration gate read as the probe measured", async () => {
    const html = await runBody(base);
    const rows = rowsOf(section(html, "Run context"));
    for (const row of [
      "marketId market-public-2026-03-31",
      "seed 20260331",
      "nPaths 64",
      // Printed on curve default 2 (was "calibration.sigma 0.0061184513287782325"); deltas Step 1
      "calibration.sigma 0.006116484379837266",
      "calibration.rmseGateBreached false",
      "calibration.reason none",
    ]) expect(rows).toContain(row);
    const gate = text(section(html, "Calibration gate"));
    // Printed on curve default 2 (was Fit RMSE 0.892497 bp); deltas Step 1
    expect(gate).toContain("Within the gate Fit RMSE 0.900995 bp against the 5 bp gate.");
    expect(gate).toContain("of the run's market snapshot");
    expect(text(section(html, "Not built in this mode"))).toContain("stochastic.shocked-scenarios");
  });

  it("the page's Download CSV is the summary CSV the server serves", async () => {
    const html = await runBody(base);
    expect(html).toContain(`href="/api/runs/${base}/stochastic/summary.csv"`);
    const r = await api<unknown>(t.base, "GET", `/api/runs/${base}/stochastic/summary.csv`);
    expect(r.status).toBe(200);
    const lines = r.text.split("\r\n");
    expect(lines[0]).toBe("# kind,stochastic-distribution");
    expect(lines[1]).toBe(`# runId,${base}`);
    // Printed on curve default 2 (was eveDistribution,stdev,,6855510.898898505); deltas Step 1
    expect(r.text).toContain("eveDistribution,stdev,,6843610.473478725");
    expect(r.text).toContain("nii12mDistribution,standardError,,1.0036228337889995e-9");
  });

  it("the stochastic Compare's Download CSV is the compare CSV the server serves", async () => {
    expect(compareBody()).toContain(`href="/api/compare/stochastic.csv?runs=${base},${shock}"`);
    const r = await api<unknown>(t.base, "GET", `/api/compare/stochastic.csv?runs=${base},${shock}`);
    expect(r.status).toBe(200);
    // Printed on curve default 2 (was eveDistribution,meanDeltaStandardError,,,,150508.09101324185); deltas Step 1
    expect(r.text).toContain("eveDistribution,meanDeltaStandardError,,,,150256.0290074165,");
  });
});

describe("The measure layers link a stochastic run to Stochastic distributions", () => {
  it("loadResults names the layer, and the NII layer links to it", async () => {
    const data = await loadResults(base);
    expect(data.result).toBeNull();
    expect(data.note).toBe(STOCH_NOTE);
    const html = renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="nii" runId={base} data={data} query={{}} />);
    const href = `#/ws/ws-a/results/stochastic?result=${base}`;
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain(">Open Stochastic distributions</a>");
    const route = parseHash(href);
    expect(route).toMatchObject({ kind: "screen", ws: "ws-a", section: "results", screen: "stochastic" });
    expect(route.query.result).toBe(base);
  });

  it("a deterministic run on Stochastic distributions has no summary and says where its results are", async () => {
    const data = await loadStochastic(det);
    expect(data.summary).toBeNull();
    expect(data.note).toBe(DET_NOTE);
    expect(renderToStaticMarkup(<StochasticRunBody runId={det} data={data} />)).not.toContain("<table");
  });

  it("the run index lists both stochastic runs and not the deterministic one", () => {
    const html = renderToStaticMarkup(<StochasticRunIndexView ws="ws-a" runs={runs} />);
    expect(html).toContain(base);
    expect(html).toContain(shock);
    expect(html).not.toContain(det);
  });
});

describe("No verdict language and no banned character", () => {
  it("no markup or CSV claims a significance or a p-value, or holds an em-dash or a section sign", async () => {
    const results = await loadResults(base);
    const docs = [
      await runBody(base),
      await runBody(det),
      compareBody(),
      renderToStaticMarkup(<ResultsLayerBody ws="ws-a" tab="nii" runId={base} data={results} query={{}} />),
      renderToStaticMarkup(<StochasticRunIndexView ws="ws-a" runs={runs} />),
      (await api<unknown>(t.base, "GET", `/api/runs/${base}/stochastic/summary.csv`)).text,
      (await api<unknown>(t.base, "GET", `/api/compare/stochastic.csv?runs=${base},${shock}`)).text,
    ];
    for (const d of docs) {
      expect(d).not.toContain("significan");
      expect(d).not.toContain("p-value");
      for (const c of BANNED) expect(d).not.toContain(c);
    }
  });
});
