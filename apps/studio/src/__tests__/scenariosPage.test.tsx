// apps/studio/src/__tests__/scenariosPage.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunPlan, ScenarioLibrary } from "@alm/engine";
import { getRunPlan, validatePlan, type AssumptionSetListItem, type BalancePlanListItem, type ValidateResponse } from "@alm/reader";
import { planCards, libraryCards } from "../scenarios/scenarioCards";
import { BalancePlanPicker, BalanceStageBanner, DefaultSetPicker, LibraryList, ScenarioCardView, SetHint, libraryRefOf, unknownRefOf } from "../pages/scenarios/ScenariosViews";
import { ScenariosBody, ScenariosPage, isEdited, savedHref, stageRefusalShown } from "../pages/scenarios/ScenariosPage";
import { addBalanceStage } from "../scenarios/scenarioEdits";
import { loadScenarios } from "../pages/scenarios/loadScenarios";
import { mockFetch, planDoc } from "./fixtures/run";
import { REPLY_PLAN_NOTE, REPLY_UNLICENSED } from "./fixtures/plan";

afterEach(() => vi.unstubAllGlobals());

const LIBS: ScenarioLibrary[] = [
  { schemaVersion: "1.0.0", id: "regulatory-grid-v1", label: "grid", scenarios: [
    { id: "S0", label: "Base", rateSpec: { kind: "base" } },
    { id: "S200", label: "+200", rateSpec: { kind: "parallel", shockBp: 200 } },
  ] },
  { schemaVersion: "1.0.0", id: "ramp-200-12m-v1", label: "ramp", scenarios: [{ id: "R200", label: "Ramp", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 12 } }] },
];
const item = (id: string): AssumptionSetListItem => ({ id, label: `Label ${id}`, contentHash: `h-${id}` });
const SETS = [item("demo-behavioral-v1"), item("rate-shock-v1"), item("stack-0123456789ab")];
const BPS: BalancePlanListItem[] = [{ id: "bp-2", contentHash: "hash-bp-2", label: "Static balance", asOf: "2026-03-31" }];
const PLAN: RunPlan = planDoc("plan-x", [{ id: "st-curve", component: "alm-yield-curve" }]);

describe("ScenarioCardView", () => {
  it("prints id, label, source, rate text, timing text, set text and the picture", () => {
    const card = planCards(PLAN, LIBS)[0]!;
    const html = renderToStaticMarkup(<ScenarioCardView card={card} sets={SETS} ownSet={null} onSet={() => {}} onRemove={() => {}} />);
    for (const s of ["S0", "Base", "library ref regulatory-grid-v1#S0", "Base curve, no shock", "Immediate", "plan default: demo-behavioral-v1"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("<svg");
  });

  it("Remove scenario sits in the card head, apart from the New business field", () => {
    const card = planCards(PLAN, LIBS)[0]!;
    const html = renderToStaticMarkup(<ScenarioCardView card={card} sets={SETS} ownSet={null} onSet={() => {}} onRemove={() => {}} nb={{ value: null, ownRules: false, listed: BPS, onChange() {} }} />);
    const remove = html.indexOf(">Remove scenario</button>");
    expect(remove).toBeGreaterThan(-1);
    expect(remove).toBeLessThan(html.indexOf("<dl"));
    expect(html.slice(html.indexOf('class="sheet-actions"'))).not.toContain("Remove");
  });

  it("a refused card prints the refusal and no picture", () => {
    const card = libraryCards(PLAN, LIBS).find((c) => c.id === "R200")!;
    const html = renderToStaticMarkup(<ScenarioCardView card={card} sets={SETS} ownSet={null} />);
    expect(html).toContain("refused at compile: ScenarioNotExecutableError (ramp timing over 12 months is typed, not executed)");
    expect(html).toContain("Ramp over 12 months");
    expect(html).not.toContain("<svg");
  });

  it("the set picker lists plan default and the stored set ids, stack ids first", () => {
    const card = planCards(PLAN, LIBS)[0]!;
    const html = renderToStaticMarkup(<ScenarioCardView card={card} sets={SETS} ownSet={null} onSet={() => {}} />);
    expect(html).toContain(">plan default</option>");
    for (const s of SETS) expect(html).toContain(`<option value="${s.id}"`);
    const at = (id: string) => html.indexOf(`<option value="${id}"`);
    expect(at("stack-0123456789ab")).toBeLessThan(at("demo-behavioral-v1"));
    expect(at("stack-0123456789ab")).toBeLessThan(at("rate-shock-v1"));
  });

  it("an unknown ref disables the set picker and says why", () => {
    const plan: RunPlan = { ...PLAN, scenarios: [{ ref: "gone-v1#X" }] };
    const card = planCards(plan, LIBS)[0]!;
    const html = renderToStaticMarkup(<ScenarioCardView card={card} sets={SETS} ownSet={null} onSet={() => {}} onRemove={() => {}} />);
    expect(html).toContain('unknown scenario ref &quot;gone-v1#X&quot;');
    const select = html.slice(html.indexOf("<select"), html.indexOf(">", html.indexOf("<select")) + 1);
    expect(select).toContain('disabled=""');
    expect(select).toContain('title="No library holds gone-v1#X, so it cannot take a set: remove it or add a library scenario"');
  });

  it("reads the ref off the card's fields, not its display text", () => {
    const plan: RunPlan = { ...PLAN, scenarios: [{ ref: "gone-v1#X" }] };
    const unknown = { ...planCards(plan, LIBS)[0]!, source: "reworded" };
    expect(unknownRefOf(unknown)).toBe("gone-v1#X");
    expect(libraryRefOf(unknown)).toBe(null);
    const select = (html: string) => html.slice(html.indexOf("<select"), html.indexOf(">", html.indexOf("<select")) + 1);
    expect(select(renderToStaticMarkup(<ScenarioCardView card={unknown} sets={SETS} ownSet={null} onSet={() => {}} />))).toContain('disabled=""');
    const known = { ...planCards(PLAN, LIBS)[0]!, source: "reworded" };
    expect(unknownRefOf(known)).toBe(null);
    expect(libraryRefOf(known)).toBe("regulatory-grid-v1#S0");
    expect(select(renderToStaticMarkup(<ScenarioCardView card={known} sets={SETS} ownSet={null} onSet={() => {}} />))).not.toContain("disabled");
    const lib = { ...libraryCards(PLAN, LIBS)[0]!, source: "reworded" };
    expect(libraryRefOf(lib)).toBe("regulatory-grid-v1#S200");
  });
});

describe("LibraryList", () => {
  it("offers Add on each library scenario the plan lacks", () => {
    const html = renderToStaticMarkup(<LibraryList cards={libraryCards(PLAN, LIBS)} onAdd={() => {}} />);
    expect(html).toContain("S200");
    expect(html).toContain("R200");
    expect(html).not.toContain(">S0<");
    expect(html.split(">Add<").length - 1).toBe(2);
  });
});

describe("DefaultSetPicker", () => {
  it("says validate refuses a plan that names no default set", () => {
    const plan: RunPlan = { ...PLAN, inputs: { ...PLAN.inputs, assumptionSets: [] } };
    const html = renderToStaticMarkup(<DefaultSetPicker plan={plan} sets={SETS} onChange={() => {}} />);
    expect(html).toContain('<option value="" disabled="" selected="">none stated: validate refuses the plan until a default set is named</option>');
  });
  it("selects the plan default and lists stack ids first", () => {
    const html = renderToStaticMarkup(<DefaultSetPicker plan={PLAN} sets={SETS} onChange={() => {}} />);
    expect(html).toContain('<option value="demo-behavioral-v1" selected=""');
    expect(html.indexOf('<option value="stack-0123456789ab"')).toBeLessThan(html.indexOf('<option value="demo-behavioral-v1"'));
  });
});

const p2Plan = (): RunPlan => ({
  schemaVersion: "1.4.0", planId: "P", label: "P", authoredBy: "person", asOf: "2026-03-31", grid: { horizonMonths: 360 },
  inputs: { marketSnapshot: "m", positionBook: "b", routingPolicy: "r", assumptionSets: ["a"] },
  stages: [
    { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"] },
    { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
    { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
    { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
    { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve"], produces: ["EveResult"], dependsOn: ["st-curve", "st-cashflow"] },
  ],
  scenarios: [{ ref: "regulatory-grid-v1#BASE" }, { ref: "regulatory-grid-v1#S100" }],
  reports: [],
  validationRules: { typeGate: [], routingGate: [] },
} as RunPlan);

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const LISTED: BalancePlanListItem[] = [
  { id: "bp-a", contentHash: "h1", label: "Grow loans", asOf: "2026-03-31" },
  { id: "bp-old", contentHash: "h2", label: "Old", asOf: "2025-12-31" },
];

/** The HTML of the New business field only: the assumption set picker also offers "plan default". */
const nbField = (html: string) => {
  const at = html.indexOf('aria-label="New business"');
  return at < 0 ? "" : html.slice(at, html.indexOf("</label>", at));
};

describe("P2 new business controls", () => {
  it("the plan picker lists balance plans with the plan's as-of, plus None", () => {
    const html = renderToStaticMarkup(<BalancePlanPicker plan={{ ...p2Plan(), balancePlan: "bp-a" }} listed={LISTED} onChange={() => {}} />);
    expect(html).toContain(">None: every scenario runs off unless it has its own<");
    expect(html).toContain("bp-a: Grow loans");
    expect(html).not.toContain("bp-old");
  });
  it("the plan picker keeps an unlisted current id visible and says so", () => {
    const t = text(renderToStaticMarkup(<BalancePlanPicker plan={{ ...p2Plan(), balancePlan: "bp-gone" }} listed={LISTED} onChange={() => {}} />));
    expect(t).toContain("bp-gone (not in /api/balance-plans for as-of 2026-03-31)");
  });
  it("the stage banner shows only when a balance plan is bound and the chain has no balance stage", () => {
    const bound = { ...p2Plan(), balancePlan: "bp-a" };
    expect(text(renderToStaticMarkup(<BalanceStageBanner plan={bound} onAdd={() => {}} refusal={null} />))).toContain("This chain has no balance stage, so the targets would not run.");
    expect(renderToStaticMarkup(<BalanceStageBanner plan={p2Plan()} onAdd={() => {}} refusal={null} />)).toBe("");
  });
  it("counts a binding or a stage change as an edit", () => {
    expect(isEdited(p2Plan(), { ...p2Plan(), balancePlan: "bp-a" })).toBe(true);
    expect(isEdited(p2Plan(), { ...p2Plan(), scenarioBalancePlans: { BASE: "bp-a" } })).toBe(true);
    expect(isEdited(p2Plan(), { ...p2Plan(), stages: [] })).toBe(true);
    expect(isEdited(p2Plan(), p2Plan())).toBe(false);
  });
  it("a plan card carries a New business picker with plan default, or reads own rules", () => {
    const card = planCards(PLAN, LIBS)[0]!;
    const picker = renderToStaticMarkup(
      <ScenarioCardView card={card} sets={SETS} ownSet={null} onSet={() => {}} nb={{ value: null, ownRules: false, listed: LISTED, onChange() {} }} />,
    );
    expect(text(picker)).toContain("New business");
    expect(nbField(picker)).toContain(">plan default</option>");
    const own = renderToStaticMarkup(
      <ScenarioCardView card={card} sets={SETS} ownSet={null} onSet={() => {}} nb={{ value: null, ownRules: true, listed: LISTED, onChange() {} }} />,
    );
    expect(text(own)).toContain("Own rules (stored on the scenario, read-only here)");
    expect(nbField(own)).not.toBe("");
    expect(nbField(own)).not.toContain("<select");
  });
});

describe("SetHint", () => {
  it("names the set carried from the Assumptions or Behavioral shocks page", () => {
    const html = renderToStaticMarkup(<SetHint query={{ set: "stack-0123456789ab" }} />);
    expect(html).toContain("Set stack-0123456789ab: pick it on a scenario or as the plan default.");
  });
  it("prints nothing without a set in the query", () => {
    expect(renderToStaticMarkup(<SetHint query={{}} />)).toBe("");
  });
});

describe("the page", () => {
  // Effects do not run under renderToStaticMarkup, so the loaders run here
  // under mockFetch and their answers feed the exported body directly.
  const routes = (): Array<[string, unknown, number?]> => [
    ["/api/run-plans/plan-x", PLAN],
    ["/api/run-plans", [{ id: "plan-x", contentHash: "h", importedAt: "2026-09-26" }]],
    ["/api/plans/library", LIBS],
    ["/api/plans/validate", REPLY_UNLICENSED],
    ["/api/assumption-sets", SETS],
    ["/api/balance-plans", BPS],
  ];

  it("loadScenarios reads plans, library, sets and balance plans", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    expect(data.plans.map((p) => p.id)).toEqual(["plan-x"]);
    expect(data.libraries.map((l) => l.id)).toEqual(["regulatory-grid-v1", "ramp-200-12m-v1"]);
    expect(data.sets.map((s) => s.id)).toEqual(SETS.map((s) => s.id));
    expect(data.balancePlans).toEqual(BPS);
  });

  it("renders the gate bar's compile refusal and the banner text verbatim", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const reply = await validatePlan(loaded);
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "ok", reply }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    expect(html).toContain("✕ Compile: UnlicensedBindingError");
    expect(html).toContain(REPLY_UNLICENSED.compile.detail!.replace(/"/g, "&quot;"));
    expect(html).toContain("Save as <span class=\"mono\">plan-x-edit-1</span>");
    expect(html).toContain("POST /api/plans/validate");
  });

  it("a flat-basis note reads Informational beside the plan, not Not implemented (Studio Part 2 D16)", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const reply = { ...REPLY_PLAN_NOTE, notImplemented: [{ layer: "plan.balance-basis.skipped", reason: "flat basis skipped 2 families: swaps, fees" }] } as ValidateResponse;
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "ok", reply }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    expect(html.split("○ Informational").length - 1).toBe(1);
    expect(html.split("○ Not implemented").length - 1).toBe(0);
    expect(html).toContain("plan.balance-basis.skipped");
  });

  it("a derived curve note reads Informational beside the plan, not Not implemented (Piece B, step B2)", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const reply = { ...REPLY_PLAN_NOTE, notImplemented: [{ layer: "plan.derived-curve.index-only", reason: "derived curve X (x) adds a constant spread to index resets only (i); mortgages, client rates, new business and discounting read the base curve" }] } as ValidateResponse;
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "ok", reply }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    expect(html.split("○ Informational").length - 1).toBe(1);
    expect(html.split("○ Not implemented").length - 1).toBe(0);
    expect(html).toContain("plan.derived-curve.index-only");
  });

  it("Run this plan waits for Save as while there are edits", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const clean = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    const runOf = (html: string) => html.slice(html.lastIndexOf("<button", html.indexOf("Run this plan")), html.indexOf("Run this plan"));
    expect(runOf(clean)).not.toContain("disabled");
    const edited: RunPlan = { ...loaded, scenarios: [...loaded.scenarios, { ref: "regulatory-grid-v1#S200" }] };
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={edited} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    expect(runOf(html)).toContain('disabled=""');
    expect(runOf(html)).toContain('title="Save as first"');
  });

  it("renders a loading card before the store answers", () => {
    expect(renderToStaticMarkup(<ScenariosPage ws="ws-a" bookId={null} query={{}} section="sets" />)).toContain("Reading the plan store");
  });

  it("sets section shows the plan's cards and the default set, not the library", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    expect(html).toContain("Scenarios in plan");
    expect(html).toContain("Plan default set");
    expect(html).not.toContain("Library scenarios not in the plan");
  });

  it("sets section shows the plan default balance plan picker and a New business field on each plan card", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    expect(html).toContain("Plan default balance plan");
    expect(html.split('aria-label="New business"').length - 1).toBe(loaded.scenarios.length);
  });

  it("a { ref } whose library definition carries newBusiness shows Own rules and no New business select", async () => {
    const libs: ScenarioLibrary[] = [
      { schemaVersion: "1.0.0", id: "nb-lib-v1", label: "nb", scenarios: [
        { id: "NB0", label: "Own NB", rateSpec: { kind: "base" }, newBusiness: { mode: "static", rules: [] } },
      ] },
    ];
    const plan: RunPlan = { ...PLAN, scenarios: [{ ref: "nb-lib-v1#NB0" }] };
    mockFetch([
      ["/api/run-plans/plan-x", plan],
      ["/api/run-plans", [{ id: "plan-x", contentHash: "h", importedAt: "2026-09-26" }]],
      ["/api/plans/library", libs],
      ["/api/plans/validate", REPLY_UNLICENSED],
      ["/api/assumption-sets", SETS],
      ["/api/balance-plans", BPS],
    ]);
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
    );
    const at = html.indexOf('aria-label="New business"');
    expect(at).toBeGreaterThan(-1);
    const field = html.slice(at, html.indexOf("</label>", at));
    expect(text(field)).toContain("Own rules (stored on the scenario, read-only here)");
    expect(field).not.toContain("<select");
  });

  it("library section shows the library, not the plan's cards", async () => {
    mockFetch(routes());
    const data = await loadScenarios();
    const loaded = await getRunPlan("plan-x");
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{}} loaded={loaded} plan={loaded} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="library" />,
    );
    expect(html).toContain("Library scenarios not in the plan");
    expect(html).not.toContain("Scenarios in plan");
    expect(html).not.toContain("Plan default set");
    // Toolbar, gates, Save as and Run stay on the library section; the library is single-column.
    expect(html).toContain("Run this plan");
    expect(html).toContain("Save as <span class=\"mono\">plan-x-edit-1</span>");
    expect(html).toContain("POST /api/plans/validate");
    expect(html).not.toContain('class="grid-2"');
  });
});

describe("P3 shock links and the base guard", () => {
  const P3: RunPlan = {
    ...PLAN,
    scenarios: [
      { ref: "regulatory-grid-v1#S0" },
      { ref: "regulatory-grid-v1#S200" },
      { id: "UP300", label: "Up 300", rateSpec: { kind: "parallel", shockBp: 300 } },
      { ref: "nope-v1#X" },
    ],
  };
  const data = { plans: [{ id: "plan-x", contentHash: "h", importedAt: "2026-09-27T00:00:00Z" }], libraries: LIBS, sets: SETS, balancePlans: BPS };
  const body = (plan: RunPlan, query: Record<string, string> = {}) => renderToStaticMarkup(
    <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={query} loaded={plan} plan={plan} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="sets" />,
  );
  const cardOf = (html: string, id: string): string => {
    const start = html.indexOf(`aria-label="Scenario ${id}"`);
    expect(start, id).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</article>", start));
  };
  const removeTag = (card: string): string => card.match(/<button[^>]*>Remove scenario<\/button>/)![0];

  it("links an own inline shock to Edit shock and a library scenario to Copy shock; no link on the base or an unknown ref", () => {
    const html = body(P3);
    expect(cardOf(html, "UP300")).toContain('<a class="btn btn-quiet" href="#/ws/ws-a/run/scenarios?tab=custom&amp;scenario=UP300">Edit shock</a>');
    expect(cardOf(html, "S200")).toContain('<a class="btn btn-quiet" href="#/ws/ws-a/run/scenarios?tab=custom&amp;scenario=S200">Copy shock</a>');
    expect(cardOf(html, "S0")).not.toContain("shock</a>");
    expect(cardOf(html, "X")).not.toContain("shock</a>");
  });
  it("an own inline shock whose id the builder refuses links to Copy shock, not Edit shock (spec Section 5.3 item 1)", () => {
    const html = body({ ...P3, scenarios: [...P3.scenarios, { id: "S.1", rateSpec: { kind: "parallel", shockBp: 100 } }] });
    expect(cardOf(html, "S.1")).toContain('<a class="btn btn-quiet" href="#/ws/ws-a/run/scenarios?tab=custom&amp;scenario=S.1">Copy shock</a>');
    expect(cardOf(html, "S.1")).not.toContain("Edit shock");
  });
  it("the link carries the page state as it stands, in its own order, with tab then scenario last, and not the book", () => {
    const html = body(P3, { plan: "plan-x", book: "b1" });
    expect(cardOf(html, "UP300")).toContain('href="#/ws/ws-a/run/scenarios?plan=plan-x&amp;tab=custom&amp;scenario=UP300"');
  });
  it("the plan's only base cannot be removed; with two bases both can", () => {
    const only = removeTag(cardOf(body(P3), "S0"));
    expect(only).toContain('disabled=""');
    expect(only).toContain('title="A run needs one base scenario"');
    expect(removeTag(cardOf(body(P3), "UP300"))).not.toContain("disabled");
    const two: RunPlan = { ...P3, scenarios: [...P3.scenarios, { id: "B2", rateSpec: { kind: "base" } }] };
    expect(removeTag(cardOf(body(two), "S0"))).not.toContain("disabled");
    expect(removeTag(cardOf(body(two), "B2"))).not.toContain("disabled");
  });
});

describe("savedHref (Polish 1 S7)", () => {
  it("drops scenario= after a save on Custom rate shocks, so the builder does not reopen as a copy", () => {
    expect(savedHref("ws-a", { plan: "p", scenario: "X" }, "p-edit-1", "custom")).toBe("#/ws/ws-a/run/scenarios?plan=p-edit-1&tab=custom");
    expect(savedHref("ws-a", { book: "b", plan: "p", scenario: "X" }, "p-edit-1", "custom")).toBe("#/ws/ws-a/run/scenarios?plan=p-edit-1&tab=custom");
  });
  it("keeps every other key on the other Scenarios layers", () => {
    expect(savedHref("ws-a", { plan: "p", scenario: "X" }, "p-edit-1", "sets")).toBe("#/ws/ws-a/run/setups?plan=p-edit-1&scenario=X&tab=scenarios");
    expect(savedHref("ws-a", { plan: "p" }, "p-edit-1", "library")).toBe("#/ws/ws-a/run/scenarios?plan=p-edit-1&tab=rate");
  });
});

describe("a refused Add balance stage after Reset (Piece 2 bugs)", () => {
  it("shows the refusal on the plan it was refused on, and none once Reset puts the stored plan back", () => {
    // The stored plan has no NII stage, so the balance stage has nowhere to go.
    const loaded: RunPlan = { ...p2Plan(), stages: p2Plan().stages.filter((s) => s.id !== "st-nii") };
    const edited: RunPlan = { ...loaded, balancePlan: "bp-a" };
    const r = addBalanceStage(edited);
    if (r.kind !== "refused") throw new Error("expected a refusal");
    const refusal = { text: r.text, plan: edited };
    // Restated refusal text.
    expect(stageRefusalShown(refusal, edited)).toBe("The chain has no NII stage that reads the contractual stage, so Studio cannot place the balance stage. Add it on the Model chain page.");
    // Reset: the page's plan is the stored one again.
    expect(stageRefusalShown(refusal, loaded)).toBeNull();
    expect(stageRefusalShown(null, edited)).toBeNull();
  });
});
