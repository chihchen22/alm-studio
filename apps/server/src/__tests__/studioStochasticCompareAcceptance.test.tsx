// apps/server/src/__tests__/studioStochasticCompareAcceptance.test.tsx
/**
 * ALM Studio stochastic Compare acceptance on a freshly seeded test platform:
 * the Compare views fed by the real routes. Two stochastic runs (64 paths, the
 * default seed 20260331) on the public market pack and on its volatility-shocked
 * derivation vol-shock-demo-v1, and one deterministic run on the public pack.
 * The expected strings are restated from a probe measured on the unmodified code and formatted by the existing 6-decimal rule; none is read from
 * the code they check.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getStochasticCompare, listRuns, type RunSummary, type StochasticCompareReply } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import type { RunStatus } from "../jobs/types";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { RunPickers } from "../../../studio/src/pages/compare/CompareViews";
import { StochasticCompareBody } from "../../../studio/src/pages/compare/StochasticCompareViews";

let t: TestPlatform;
let base: string; // stochastic, public market pack
let shock: string; // stochastic, vol-shock-demo-v1
let det: string; // deterministic, public market pack
let runs: RunSummary[];
let reply: StochasticCompareReply;
const realFetch = globalThis.fetch;

const BASE_ID = "market-public-2026-03-31";
const SHOCK_ID = "vol-shock-demo-v1";

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
  reply = await getStochasticCompare(base, shock);
}, 480_000);
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const text = (s: string) =>
  s.replace(/<wbr\/?>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const body = (a: string, b: string, r: StochasticCompareReply) =>
  renderToStaticMarkup(<StochasticCompareBody ws="ws-a" runs={runs} query={{ runs: `${a},${b}` }} compare={{ state: "ok", value: r }} />);
const section = (html: string, label: string): string => {
  const m = html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`));
  if (m === null) throw new Error(`no section ${label}`);
  return m[1]!;
};
const rowsOf = (html: string): string[] => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => text(r[1]!));

const TEXT_BOUND =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors. Both runs use the same seed and the same path count, so their paths share random numbers. The figure is an upper bound on the standard error of the difference only if the two runs' path outcomes are non-negatively correlated; that is typical when paths share random numbers, but the stored statistics cannot confirm it, because per-path values are not stored. It is a precision figure, not a test.";
const DET_REASON = "deterministic run: the other run is stochastic, and a deterministic result compares only with another deterministic run";

describe("Compare pickers on the seeded platform", () => {
  it("with a stochastic run A, the shocked run is enabled and the deterministic run is disabled with its reason", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={runs} a={base} b={null} table="eve" query={{}} />);
    const bSel = html.match(/<label>\s*Run B[\s\S]*?<\/label>/);
    expect(bSel).not.toBeNull();
    expect(bSel![0]).toContain(`<option value="${shock}">${shock}</option>`);
    expect(bSel![0]).toContain(`<option value="${det}" disabled="" title="${DET_REASON}">${det}, ${DET_REASON}</option>`);
    expect(text(html)).toContain("Table: both distribution tables, once the other run is a stochastic run");
    expect(html).not.toContain('<option value="nii"');
  });

  it("a stochastic pair says so", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={runs} a={base} b={shock} table="eve" query={{}} />);
    expect(text(html)).toContain("Table: both distribution tables (a stochastic pair)");
  });

  it("a mixed pair says the runs do not compare and never calls it a stochastic pair", () => {
    const html = renderToStaticMarkup(<RunPickers ws="ws-a" runs={runs} a={base} b={det} table="eve" query={{}} />);
    expect(text(html)).toContain("Table: none, a deterministic run and a stochastic run do not compare (the server's reason is below)");
    expect(text(html)).not.toContain("a stochastic pair");
  });
});

describe("Stochastic Compare body from the real route", () => {
  it("the EVE distribution table prints both runs and the derived B - A", () => {
    const html = body(base, shock, reply);
    const eve = section(html, "EVE distribution");
    const rows = rowsOf(eve);
    // Printed on curve default 2 (was "Standard deviation (per path) 6,855,510.898899 10,289,688.848804 +3,434,177.949906"); deltas Step 1
    expect(rows).toContain("Standard deviation (per path) 6,843,610.473479 10,271,827.17152 +3,428,216.698042");
    // Printed on curve default 2 (was "Mean 121,065,587.850614 121,065,587.850614 0"); deltas Step 1
    expect(rows).toContain("Mean 120,866,072.269334 120,866,072.269334 0");
    // Printed on curve default 2 (was "Quantile at 0.95 132,050,902.357294 137,850,772.098818 +5,799,869.741524"); deltas Step 1
    expect(rows).toContain("Quantile at 0.95 131,831,793.788606 137,621,339.798193 +5,789,546.009586");
    const t1 = text(eve);
    // Printed on curve default 2 (was "150,508.091013"); deltas Step 1
    const i = t1.indexOf("150,256.029007");
    expect(i).toBeGreaterThan(-1);
    expect(t1.slice(i)).toContain(TEXT_BOUND);
  });

  it("every NII 12m distribution row ends in 0, and the Mean row reads as the probe measured", () => {
    const nii = section(body(base, shock, reply), "NII 12m distribution");
    const rows = rowsOf(nii).slice(1); // drop the header row
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect(r.endsWith(" 0"), r).toBe(true);
    expect(rows).toContain("Mean 11,772,965.658385 11,772,965.658385 0");
  });

  it("the like-for-like block names what differs and what is the same", () => {
    const rows = rowsOf(section(body(base, shock, reply), "Like for like"));
    expect(rows).toContain("marketId market-public-2026-03-31 vol-shock-demo-v1 differs");
    expect(rows).toContain("seed 20260331 20260331 same");
    expect(rows).toContain("nPaths 64 64 same");
    // Printed on curve default 2 (was "calibration.sigma 0.0061184513287782325 0.009177675604594539 differs"); deltas Step 1
    expect(rows).toContain("calibration.sigma 0.006116484379837266 0.009174725148401753 differs");
  });

  it("a mixed pair is refused by the route with a 400, and the body prints it in role=alert", async () => {
    const err = await getStochasticCompare(base, det).then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect((err as { status?: number }).status).toBe(400);
    const html = renderToStaticMarkup(
      <StochasticCompareBody ws="ws-a" runs={runs} query={{ runs: `${base},${det}` }} compare={{ state: "error", error: err! }} />);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(`400: run "${det}" is a deterministic run and run "${base}" is a stochastic run`);
    expect(html).not.toContain("<table");
  });

  it("the page claims no significance and no p-value", () => {
    const all = text(body(base, shock, reply)) + " " + text(renderToStaticMarkup(<RunPickers ws="ws-a" runs={runs} a={base} b={shock} table="eve" query={{}} />));
    expect(all).not.toContain("significan");
    expect(all).not.toContain("p-value");
  });
});

describe("Copy in the Studio source", () => {
  it("no Studio source file still says Compare reads deterministic results only", () => {
    const files = [
      "pages/scenarios/VolatilityShocksPage.tsx",
      "compare/compareModel.ts",
      "pages/compare/CompareViews.tsx",
      "pages/compare/ComparePage.tsx",
      "pages/compare/StochasticCompareViews.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(new URL(`../../../studio/src/${f}`, import.meta.url), "utf8");
      expect(src.length, f).toBeGreaterThan(0);
      expect(src.toLowerCase(), f).not.toContain("compare reads deterministic results only");
    }
  });
});
