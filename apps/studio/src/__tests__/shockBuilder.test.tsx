// apps/studio/src/__tests__/shockBuilder.test.tsx
/**
 * The builder form view and the Custom rate shocks section
 * of the Scenarios page.
 * Static markup only; every expected text is restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunPlan, ScenarioLibrary } from "@alm/engine";
import { planDoc } from "./fixtures/run";
import { blankForm, checkForm, libraryIds, newBuilder, openBuilder, startOptions, takenIds, type BuilderState, type ShockForm } from "../scenarios/shockForm";
import { BuilderForm } from "../pages/scenarios/ShockBuilder";
import { ScenariosBody } from "../pages/scenarios/ScenariosPage";
import type { ScenariosData } from "../pages/scenarios/loadScenarios";

const LIBS: ScenarioLibrary[] = [
  { schemaVersion: "1.0.0", id: "regulatory-grid-v1", label: "grid", scenarios: [
    { id: "S0", label: "S0", rateSpec: { kind: "base" } },
    { id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 } },
  ] },
];
const PLAN: RunPlan = {
  ...planDoc("plan-x", []),
  scenarios: [{ ref: "regulatory-grid-v1#S0" }, { id: "UP300", label: "Up 300", rateSpec: { kind: "parallel", shockBp: 300 } }],
};
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function view(b: BuilderState, enabled = false, refused = false): string {
  return renderToStaticMarkup(
    <BuilderForm state={b} check={checkForm(b.form, takenIds(PLAN, b.mode), libraryIds(LIBS))} options={startOptions(PLAN, LIBS)} enabled={enabled} refused={refused} onState={() => {}} onAction={() => {}} />,
  );
}
/** The one <input> tag whose value is `value`. */
const inputTag = (html: string, value: string) => html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))![0];
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const withForm = (over: Partial<ShockForm>): BuilderState => ({ ...newBuilder(), form: { ...blankForm(), ...over } });

describe("BuilderForm", () => {
  it("a blank new builder: Start from lists Blank then the options, Parallel pressed, the action off, no message on empty fields", () => {
    const html = view(newBuilder());
    const t = text(html);
    expect(t).toContain("Build a shock");
    expect(html).toContain('<option value="" selected="">Blank</option>');
    expect(html).toContain('<option value="plan:UP300">UP300: Up 300 (in the plan)</option>');
    expect(html).toContain('<option value="lib:regulatory-grid-v1#S200">S200 (library regulatory-grid-v1)</option>');
    expect(html).toContain('<button type="button" aria-pressed="true">Parallel</button>');
    expect(html).toContain('<button type="button" class="btn btn-primary" disabled="">Add to plan</button>');
    expect(t).not.toContain("Type a number");
    expect(t).not.toContain("Type an id");
  });
  it("shows a field's message once the field holds text", () => {
    expect(text(view(withForm({ parallelBp: "1e3" })))).toContain("Type a number");
    expect(text(view(withForm({ parallelBp: "5", id: "base" })))).toContain('"base" is reserved: the Rates layer uses it as a chart key');
    expect(text(view(withForm({ parallelBp: "5", id: "UP300" })))).toContain('The plan already holds a scenario "UP300"');
  });
  it("an id a library holds prints the library message, on a plan that lacks that id", () => {
    const plan: RunPlan = { ...PLAN, scenarios: [{ ref: "regulatory-grid-v1#S0" }] };
    const b = withForm({ parallelBp: "5", id: "S200" });
    const html = renderToStaticMarkup(
      <BuilderForm state={b} check={checkForm(b.form, takenIds(plan, b.mode), libraryIds(LIBS))} options={startOptions(plan, LIBS)} enabled={false} refused={false} onState={() => {}} onAction={() => {}} />,
    );
    expect(text(html)).toContain('A library holds a scenario "S200"; give this scenario its own id');
  });
  it("a field's message reads as an error: aria-invalid on the input, the message in the error class and named by aria-describedby", () => {
    const html = view(withForm({ parallelBp: "1e3" }));
    const input = inputTag(html, "1e3");
    expect(attr(input, "aria-invalid")).toBe("true");
    const described = attr(input, "aria-describedby")!.split(" ");
    expect(html).toContain(`<span class="field-help field-error" id="${described[0]}">Type a number</span>`);
    expect(described.map((id) => text(html.match(new RegExp(`<span[^>]*id="${id}"[^>]*>([^<]*)</span>`))![1]!))).toEqual(["Type a number", "bp", "The same shift at every tenor."]);
    // The accessible name is the label text alone, not the unit, the help or the message.
    expect(html).toContain(`<span class="field-label" id="${attr(input, "aria-labelledby")}">Shift</span>`);
    const knot = view(withForm({ shape: "custom", knots: [{ key: 7, tenorYears: "5e", shockBp: "1" }], nextKey: 8, id: "KN" }));
    const cell = inputTag(knot, "5e");
    // Polish 1 S6: the message id follows the row's key, not its index.
    expect(attr(cell, "aria-describedby")).toMatch(/t7$/);
    expect(attr(cell, "aria-invalid")).toBe("true");
    expect(knot).toContain(`<span class="field-help field-error" id="${attr(cell, "aria-describedby")}">Type a number</span>`);
    expect(attr(inputTag(knot, "1"), "aria-invalid")).toBeUndefined();
  });
  it("puts no live region in the form: a knot edit's one live change is the preview's Checking line (Polish 2 C5)", () => {
    const live = (h: string) => (h.match(/role="status"|aria-live=/g) ?? []).length;
    expect(live(view(withForm({ shape: "custom", knots: [{ key: 7, tenorYears: "5e", shockBp: "1" }], nextKey: 8, id: "KN" })))).toBe(0);
    expect(live(view(withForm({ shape: "custom", knots: [], nextKey: 0, id: "KN" })))).toBe(0);
  });
  it("a field with no message is not invalid, and its help and unit still describe it", () => {
    const html = view(withForm({ parallelBp: "5" }));
    const input = inputTag(html, "5");
    expect(attr(input, "aria-invalid")).toBeUndefined();
    expect(html).not.toContain("field-error");
    expect(attr(input, "aria-describedby")!.split(" ").length).toBe(2);
    const sel = html.match(/<select[^>]*>/)![0];
    expect(html).toContain(`<span class="field-label" id="${attr(sel, "aria-labelledby")}">Start from</span>`);
    expect(html).toContain(`<span class="field-help" id="${attr(sel, "aria-describedby")}">A copy takes the shape and sizes only. Timing, assumption set and new business are not copied.</span>`);
  });
  it("says why the action is off when the preview refuses the shape", () => {
    const b = withForm({ shape: "twist", twist: { shortBp: "-50", pivotYears: "40", longBp: "75" }, id: "TW" });
    expect(text(view(b, false, true))).toContain("Off: the preview refuses this shock.");
    expect(text(view(b, false, true))).not.toContain("On once the form is complete");
    expect(text(view(b, false, false))).toContain("On once the form is complete and the preview accepts the shock.");
  });
  it("twist shows its three fields and the rule in words; knots show rows, Add knot and the flat-beyond rule", () => {
    const tw = text(view(withForm({ shape: "twist" })));
    for (const s of ["Shift at 0Y", "Pivot", "Shift at the longest curve tenor", "Zero at the pivot, straight lines on each side."]) expect(tw).toContain(s);
    const kn = view(withForm({ shape: "custom", knots: [{ key: 0, tenorYears: "1", shockBp: "25" }, { key: 1, tenorYears: "5", shockBp: "50" }], nextKey: 2 }));
    expect(kn).toContain('aria-label="Tenor in years, knot 2"');
    expect(kn).toContain('<button type="button" class="btn btn-quiet btn-icon" aria-label="Remove knot 2">×</button>');
    expect(text(kn)).not.toContain("Remove row");
    expect(kn).toContain('<button type="button" class="btn">Add knot</button>');
    // Each row carries a visible label, so a refusal's "(knot 2 in the table)" names a row on screen (Task 8 fix I3).
    expect(kn).toContain('<th scope="row">Knot 1</th>');
    expect(kn).toContain('<th scope="row">Knot 2</th>');
    expect(kn).toContain('<th scope="col"><span class="sr-only">Knot</span></th>');
    expect(text(kn)).toContain("The shift holds flat beyond the first and last knot.");
    expect(text(view(withForm({ shape: "custom", knots: [] })))).toContain("Add at least one knot");
  });
  it("edit mode: no Start from, the id read-only, the action names the scenario", () => {
    const html = view(openBuilder(PLAN, LIBS, "UP300"), true);
    expect(text(html)).toContain("Edit the shock of UP300");
    expect(html).not.toContain("Start from");
    const idInput = html.match(/<input[^>]*value="UP300"[^>]*>/)![0];
    expect(idInput).toMatch(/readonly=""/i);
    expect(html).toContain('<button type="button" class="btn btn-primary">Update UP300</button>');
  });
  it("prints the builder's note", () => {
    expect(text(view(openBuilder(PLAN, LIBS, "S0")))).toContain('"S0" is the base scenario. The builder does not build or edit a base scenario.');
  });
});

describe("Scenarios page, custom section", () => {
  const data: ScenariosData = {
    plans: [{ id: "plan-x", contentHash: "h", importedAt: "2026-09-27T00:00:00Z" }],
    libraries: LIBS,
    sets: [{ id: "demo-behavioral-v1", label: "Demo", contentHash: "h" }],
    balancePlans: [],
  };
  const body = (query: Record<string, string>) => renderToStaticMarkup(
    <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={query} loaded={PLAN} plan={PLAN} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="custom" />,
  );
  it("shows the shared toolbar, the builder and the idle preview, and not the Sets cards", () => {
    const t = text(body({}));
    for (const s of ["Save as", "Run this plan", "Build a shock", "Preview on market-public-2026-03-31", "Complete the form to see the shocked curve."]) expect(t).toContain(s);
    expect(t).not.toContain("Scenarios in plan");
  });
  it("a scenario= query opens the builder on that scenario, and the preview reads checking", () => {
    const html = body({ scenario: "UP300" });
    const t = text(html);
    expect(t).toContain("Edit the shock of UP300");
    expect(t).toContain("Checking the shock on market-public-2026-03-31");
    // The form passes but the preview is still checking, so the action stays off (spec Section 5.1 item 5).
    expect(html).toContain('<button type="button" class="btn btn-primary" disabled="">Update UP300</button>');
  });
  it("a copy (scenario=S200) previews the copied shape before an id is typed, and the action stays off", () => {
    const plan: RunPlan = { ...PLAN, scenarios: [...PLAN.scenarios, { ref: "regulatory-grid-v1#S200" }] };
    const html = renderToStaticMarkup(
      <ScenariosBody ws="ws-a" data={data} planId="plan-x" query={{ scenario: "S200" }} loaded={plan} plan={plan} v={{ state: "checking" }} saveMsg={null} onEdit={() => {}} onSave={() => {}} section="custom" />,
    );
    const t = text(html);
    expect(t).toContain("Build a shock");
    expect(html).toContain('<option value="plan:S200" selected="">S200 (in the plan)</option>');
    expect(attr(inputTag(html, "200"), "aria-invalid")).toBeUndefined();
    expect(t).toContain("Checking the shock on market-public-2026-03-31");
    expect(t).not.toContain("Complete the form to see the shocked curve.");
    expect(html).toContain('<button type="button" class="btn btn-primary" disabled="">Add to plan</button>');
  });
});
