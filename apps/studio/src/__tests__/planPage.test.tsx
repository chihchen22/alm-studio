// apps/studio/src/__tests__/planPage.test.tsx
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPlanId, loadPlanPage } from "../pages/plan/loadPlan";
import { ApiError } from "@alm/reader";
import { answerFor, classify, latestOnly, STALE } from "../pages/plan/useValidate";
import { editsText, GateBar, PlanPage, planOptionText, runButton } from "../pages/plan/PlanPage";
import { editCount, planEditSummary, swapComponent } from "../plan/planEdits";
import { paint } from "../plan/gatePaint";
import { CATALOG, REPLY_NOT_RUN, REPLY_R1, REPLY_TAG, REPLY_UNLICENSED } from "./fixtures/plan";
import type { PlanDoc } from "../plan/planGraph";

function mockFetch(table: Array<[string, unknown]>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    const hit = table.find(([k]) => url.includes(k));
    if (!hit) return new Response(JSON.stringify({ error: { code: "not-found", message: `no fixture for ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

const PLANS = [
  { id: "plan-synthetic-2500-v1", contentHash: "a", importedAt: "x", positionBook: "synthetic-2500-v1", seeded: true },
  { id: "plan-vanilla-book-v1", contentHash: "b", importedAt: "x", positionBook: "vanilla-book-v1", seeded: true },
];

describe("loadPlanPage", () => {
  it("reads the stored plans and the plugin catalog", async () => {
    mockFetch([["/api/run-plans", PLANS], ["/api/catalog/plugins", CATALOG]]);
    const r = await loadPlanPage();
    expect(r.plans.map((p) => p.id)).toEqual(PLANS.map((p) => p.id));
    expect(r.catalog.mounted.length).toBe(CATALOG.mounted.length);
  });
});

describe("defaultPlanId", () => {
  it("prefers the requested id, then the selected book's plan, then the first plan", () => {
    expect(defaultPlanId(PLANS, "vanilla-book-v1", "plan-synthetic-2500-v1")).toBe("plan-synthetic-2500-v1");
    expect(defaultPlanId(PLANS, "vanilla-book-v1", undefined)).toBe("plan-vanilla-book-v1");
    expect(defaultPlanId(PLANS, "no-such-book", undefined)).toBe("plan-synthetic-2500-v1");
    expect(defaultPlanId([], null, undefined)).toBeNull();
    expect(defaultPlanId(PLANS, null, "not-stored")).toBe("plan-synthetic-2500-v1");
  });
});

describe("latestOnly", () => {
  it("drops a reply that arrives after a newer call started", async () => {
    const gate = latestOnly<string>();
    let release!: (v: string) => void;
    const slow = gate(new Promise<string>((r) => { release = r; }));
    const fast = gate(Promise.resolve("new"));
    release("old");
    expect(await slow).toBe(STALE);
    expect(await fast).toBe("new");
  });
});

describe("answerFor", () => {
  it("shows a reply only for the plan object it validated; an edited plan reads as checking", () => {
    const a = { planId: "a", stages: [] } as unknown as PlanDoc;
    const b = { ...a } as PlanDoc;
    const ok = { state: "ok" as const, reply: REPLY_TAG };
    expect(answerFor(a, { plan: a, v: ok })).toBe(ok);
    expect(answerFor(b, { plan: a, v: ok })).toEqual({ state: "checking" });
    expect(answerFor(a, { plan: null, v: { state: "idle" } })).toEqual({ state: "checking" });
    expect(answerFor(null, { plan: a, v: ok })).toEqual({ state: "idle" });
  });
});

describe("PlanPage", () => {
  it("renders a loading card before the catalog arrives", () => {
    const html = renderToStaticMarkup(<PlanPage ws="ws-a" bookId="synthetic-2500-v1" query={{}} />);
    expect(html).toContain("Reading the plan store");
  });
});

describe("PlanPage is a read-only view of a stored plan's compiled chain (Task E5, ruling 8)", () => {
  const src = () => readFileSync(fileURLToPath(new URL("../pages/plan/PlanPage.tsx", import.meta.url)), "utf8");
  it("carries no edit, swap, wire, view, book or market control and no save", () => {
    const text = src();
    for (const gone of ["PlanCanvas", "ViewsCard", "swapComponent", "addWire", "removeWire", "saveRunPlan", "MarketPicker", "Plan book", "Save as <span", "<select", "<button"]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(text).toContain("CompiledChainPanel");
  });
  it("sits no select, button or input in its markup while it loads", () => {
    const html = renderToStaticMarkup(<PlanPage ws="ws-a" bookId={null} query={{}} />);
    for (const bad of ["<select", "<button", "<input", "draggable"]) expect(html).not.toContain(bad);
  });
});

describe("classify (the validate error path is never a pass)", () => {
  it("reads a 422 as a shape error and every other failure as unavailable", () => {
    expect(classify(new ApiError(422, "invalid-plan", "stages[0].id is missing"))).toEqual({ state: "shape", message: "stages[0].id is missing" });
    expect(classify(new ApiError(500, "internal", "boom"))).toEqual({ state: "unavailable", message: "boom" });
    // The gate bar never prints the browser's raw text or a bare status (final review M2).
    expect(classify(new TypeError("Failed to fetch"))).toEqual({ state: "unavailable", message: "The platform could not be reached. Is it running?" });
    expect(classify(new ApiError(502, "http-error", "502 Bad Gateway"))).toEqual({ state: "unavailable", message: "The request failed with HTTP 502 and the reply gave no reason." });
  });
});

describe("GateBar", () => {
  it("shows a gate that did not run as not run, with no check count", () => {
    const g = paint(["st-a"], REPLY_NOT_RUN).gates;
    const html = renderToStaticMarkup(<GateBar v={{ state: "ok", reply: REPLY_NOT_RUN }} gates={g} />);
    expect(html).toContain("Type gate: not run");
    expect(html).toContain("Routing gate: not run");
    expect(html).not.toContain("check line");
    expect(html).not.toContain("failure");
    expect(html).not.toContain("✓");
  });
  it("prints failures and check lines apart, never as a ratio", () => {
    const pass = paint(["st-a"], REPLY_TAG).gates;
    const passHtml = renderToStaticMarkup(<GateBar v={{ state: "ok", reply: REPLY_TAG }} gates={pass} />);
    expect(passHtml).toContain("✓ Type gate: 0 failures, 1 check line");
    const r1 = paint(["st-decay"], REPLY_R1).gates;
    const r1Html = renderToStaticMarkup(<GateBar v={{ state: "ok", reply: REPLY_R1 }} gates={r1} />);
    expect(r1Html).toContain("✕ Routing gate: 2 failures, 1 check line");
    expect(r1Html).not.toContain(" of ");
  });
  it("reads not run for both gates after a license refusal", () => {
    const g = paint(["st-decay"], REPLY_UNLICENSED).gates;
    const html = renderToStaticMarkup(<GateBar v={{ state: "ok", reply: REPLY_UNLICENSED }} gates={g} />);
    expect(html).toContain("Type gate: not run");
    expect(html).toContain("Routing gate: not run");
    expect(html).toContain("✕ Compile: UnlicensedBindingError");
  });
  it("shows validation unavailable with no pass mark", () => {
    const html = renderToStaticMarkup(<GateBar v={{ state: "unavailable", message: "Failed to fetch" }} gates={null} />);
    expect(html).toContain("Validation unavailable");
    expect(html).not.toContain("✓");
  });
});

describe("editsText (summary form, re-exported from the plan model)", () => {
  const EXAMPLE = fileURLToPath(new URL("../../../../docs/harness/example-plan.json", import.meta.url));
  const base = JSON.parse(readFileSync(EXAMPLE, "utf8")) as PlanDoc;
  it("counts edited stages in plain words", () => {
    const one = swapComponent(base, "st-decay-nmd", "alm-competing-risks-prepay");
    const two = swapComponent(one, "st-term", "alm-competing-risks-prepay");
    expect(editsText(planEditSummary(base, base))).toBe("No edits");
    expect(editsText(planEditSummary(base, one))).toBe("1 stage edited");
    expect(editsText(planEditSummary(base, two))).toBe("2 stages edited");
  });
  it("feeds the Run button through the summary's edit count", () => {
    const one = swapComponent(base, "st-decay-nmd", "alm-competing-risks-prepay");
    expect(runButton(editCount(planEditSummary(base, base))).disabled).toBe(false);
    expect(runButton(editCount(planEditSummary(base, one))).disabled).toBe(true);
  });
});

describe("planOptionText", () => {
  it("prints the id first, then (seeded) where it applies, then the label when it differs from the id", () => {
    const labelled = { ...PLANS[0]!, label: "Synthetic 2,500-position book, behavioral chain, regulatory grid" };
    expect(planOptionText(labelled)).toBe("plan-synthetic-2500-v1 (seeded) · Synthetic 2,500-position book, behavioral chain, regulatory grid");
    expect(planOptionText(PLANS[1]!)).toBe("plan-vanilla-book-v1 (seeded)");
    expect(planOptionText({ id: "plan-x-edit-1", contentHash: "c", importedAt: "x", label: "" })).toBe("plan-x-edit-1");
    expect(planOptionText({ id: "plan-x", contentHash: "c", importedAt: "x", label: "plan-x" })).toBe("plan-x");
  });
  it("tells two saved plans of one label apart by their ids", () => {
    const label = "Vanilla book, contractual only, regulatory grid";
    expect(planOptionText({ id: "plan-vanilla-book-v1-edit-1", contentHash: "c", importedAt: "x", label }))
      .toBe("plan-vanilla-book-v1-edit-1 · Vanilla book, contractual only, regulatory grid");
    expect(planOptionText({ id: "plan-vanilla-book-v1-edit-2", contentHash: "d", importedAt: "x", label }))
      .toBe("plan-vanilla-book-v1-edit-2 · Vanilla book, contractual only, regulatory grid");
  });
});
