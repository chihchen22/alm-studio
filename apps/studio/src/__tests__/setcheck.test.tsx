// apps/studio/src/__tests__/setcheck.test.tsx
/**
 * Set Check: Edit a set's "Check against a plan" row. The draft is sent to
 * POST /api/plans/validate as a candidate under its source set's id; the row
 * shows "Passes" or the refusal naming the stage and the binding. The check
 * never holds Save off. Pure functions and server render only (no DOM).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet, RunPlan } from "@alm/engine";
import type { RunPlanMeta, ValidateResponse } from "@alm/reader";
import { EditSetView, SetCheckRow, type EditSetViewProps, type SetCheckRowProps } from "../pages/assumptions/EditSetPage";
import { draftSet, saveBlock, setLabel } from "../assumptions/setEditModel";
import {
  checkBlock, checkDraft, checkHeadline, checkShown, outcomeOf, planOptionText, plansNoteOf, plansReading, readPlans, type CheckNote, type PlanReads,
} from "../assumptions/setCheckModel";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/\s+/g, " ").trim();

const SET: AssumptionSet = {
  schemaVersion: "1.0.0",
  id: "demo-behavioral-v1",
  label: "Demo",
  contentHash: "stored-hash",
  bindings: [{ familyId: "lines", overlay: { kind: "commitment-draw", rampRates: [0.35, 0.15], steadyRate: 0.02 }, modelVersion: "engine-commitment-draw-1" }],
};

const gate = (passed: boolean, failures: ValidateResponse["type"]["failures"] = []): ValidateResponse["type"] => ({ passed, failures, checked: ["x"] });
const PASS: ValidateResponse = { type: gate(true), routing: gate(true), compile: { passed: true } };
const R3: ValidateResponse = {
  type: gate(true),
  routing: gate(false, [{ gate: "routing", rule: "R3", stageId: "st-beta", detail: "selector matches no position" }]),
  compile: { passed: false, detail: "plan rejected: 1 gate failure(s): R3@st-beta", error: "PlanRejected" },
};
const UNLICENSED: ValidateResponse = {
  type: gate(true), routing: gate(true),
  compile: { passed: false, error: "UnlicensedBindingError", detail: 'assumption set "demo-behavioral-v1" bindings[4] binds family "dda" to behavioral kind "deposit-beta", which no behavioral stage in the plan licenses' },
};

const planDoc = (planId: string, sets: string[]): RunPlan => ({ planId, inputs: { assumptionSets: sets } }) as unknown as RunPlan;
const meta = (id: string, label?: string): RunPlanMeta => ({ id, contentHash: "h", importedAt: "t", ...(label !== undefined ? { label } : {}) });

describe("setCheckModel: the plans that read a set", () => {
  it("reads every listed plan once and keeps the set ids each one reads; an unreadable plan is counted, not swallowed", async () => {
    const got: string[] = [];
    const docs: Record<string, RunPlan> = { a: planDoc("a", ["demo-behavioral-v1"]), b: planDoc("b", ["vanilla-empty-v1"]) };
    const read = await readPlans(
      async () => [meta("a", "Plan A"), meta("b"), meta("gone")],
      async (id) => { got.push(id); const d = docs[id]; if (d === undefined) throw new Error("not found"); return d; },
    );
    expect(got).toEqual(["a", "b", "gone"]);
    expect(read).toEqual({ plans: [{ id: "a", label: "Plan A", setIds: ["demo-behavioral-v1"] }, { id: "b", label: "b", setIds: ["vanilla-empty-v1"] }], unread: 1 });
  });
  it("offers only the plans whose inputs name the source set", () => {
    const plans: PlanReads[] = [{ id: "a", label: "Plan A", setIds: ["demo-behavioral-v1"] }, { id: "b", label: "b", setIds: ["other"] }];
    expect(plansReading(plans, "demo-behavioral-v1").map((p) => p.id)).toEqual(["a"]);
    expect(planOptionText(plans[0]!)).toBe("a: Plan A");
    expect(planOptionText(plans[1]!)).toBe("b");
  });
  it("says why no plan is offered", () => {
    expect(plansNoteOf({ plans: [], unread: 0 }, "s1")).toBe("No stored plan reads s1, so there is no plan to check against.");
    expect(plansNoteOf({ plans: [{ id: "a", label: "a", setIds: ["s1"] }], unread: 2 }, "s1")).toBe("2 stored plans could not be read; they are not offered.");
    expect(plansNoteOf({ plans: [{ id: "a", label: "a", setIds: ["s1"] }], unread: 1 }, "s1")).toBe("1 stored plan could not be read; it is not offered.");
    expect(plansNoteOf({ plans: [{ id: "a", label: "a", setIds: ["s1"] }], unread: 0 }, "s1")).toBeNull();
  });
});

describe("setCheckModel: one check", () => {
  it("sends the stored plan and the draft under its source set's id, with no contentHash and the typed label", async () => {
    const sent: Array<{ plan: unknown; candidate: AssumptionSet }> = [];
    const plan = planDoc("plan-synthetic-2500-v1", ["demo-behavioral-v1"]);
    const out = await checkDraft(setLabel(draftSet(SET), "Demo, edited"), "plan-synthetic-2500-v1", {
      getPlan: async () => plan,
      check: async (p, candidate) => { sent.push({ plan: p, candidate }); return PASS; },
    });
    expect(out).toEqual({ kind: "passes", planId: "plan-synthetic-2500-v1" });
    expect(sent[0]!.plan).toBe(plan);
    expect(sent[0]!.candidate.id).toBe("demo-behavioral-v1");
    expect(sent[0]!.candidate.label).toBe("Demo, edited");
    expect("contentHash" in sent[0]!.candidate).toBe(false);
  });
  it("turns a failed request into its text, never a pass", async () => {
    const out = await checkDraft(draftSet(SET), "p1", { getPlan: async () => { throw new Error("plan gone"); }, check: async () => PASS });
    expect(out).toEqual({ kind: "failed", planId: "p1", text: "plan gone" });
  });
  it("reads a pass as Passes", () => {
    expect(outcomeOf("p1", PASS)).toEqual({ kind: "passes", planId: "p1" });
    expect(checkHeadline({ kind: "passes", planId: "p1" })).toBe("Passes plan p1");
  });
  it("reads a gate refusal as its rule, its stage and its detail, without the PlanRejected restatement", () => {
    expect(outcomeOf("p1", R3)).toEqual({ kind: "refused", planId: "p1", lines: ["R3 at stage st-beta: selector matches no position"] });
    expect(checkHeadline({ kind: "refused", planId: "p1", lines: [] })).toBe("Refused by plan p1");
  });
  it("reads a compile refusal as its class and its detail, which names the binding", () => {
    expect(outcomeOf("p1", UNLICENSED)).toEqual({
      kind: "refused", planId: "p1",
      lines: ['UnlicensedBindingError: assumption set "demo-behavioral-v1" bindings[4] binds family "dda" to behavioral kind "deposit-beta", which no behavioral stage in the plan licenses'],
    });
    expect(checkHeadline({ kind: "failed", planId: "p1", text: "x" })).toBe("Not checked against plan p1");
  });
  it("holds Check off with no plan picked and while a check runs", () => {
    expect(checkBlock(null, null)).toBe("Pick a plan to check against");
    expect(checkBlock("p1", "p1")).toBe("Checking against p1");
    expect(checkBlock("p1", null)).toBeNull();
  });
  it("shows a check only while the draft and the picked plan are the ones it checked", () => {
    const note: CheckNote = { outcome: { kind: "passes", planId: "p1" }, edits: 3, planId: "p1" };
    expect(checkShown(note, 3, "p1")).toBe(note);
    expect(checkShown(note, 4, "p1")).toBeNull();
    expect(checkShown(note, 3, "p2")).toBeNull();
    expect(checkShown(null, 3, "p1")).toBeNull();
  });
  it("Save's rule takes no check: a changed draft has Save on whatever a check said", () => {
    expect(saveBlock(setLabel(draftSet(SET), "Demo, edited"), false, null)).toBeNull();
  });
});

const row: SetCheckRowProps = {
  setId: "demo-behavioral-v1",
  plans: [{ id: "plan-synthetic-2500-v1", label: "Synthetic", setIds: ["demo-behavioral-v1"] }],
  plansNote: null,
  planId: "plan-synthetic-2500-v1",
  checking: null,
  note: null,
  onPlan() {}, onCheck() {},
};
const renderRow = (over: Partial<SetCheckRowProps> = {}) => renderToStaticMarkup(<SetCheckRow {...row} {...over} />);
const checkButton = (html: string) => html.match(/<button[^>]*>Check<\/button>/)![0];

describe("SetCheckRow", () => {
  it("is one group named Check against a plan: a plan picker of the plans that read the set, and a Check button", () => {
    const html = renderRow();
    expect(html).toContain('aria-label="Check against a plan"');
    expect(text(html)).toContain("Check against a plan Pick a plan plan-synthetic-2500-v1: Synthetic Check");
    expect(checkButton(html)).not.toContain("aria-disabled");
  });
  it("holds Check off with its reason while no plan is picked or a check runs", () => {
    const off = renderRow({ planId: null });
    expect(checkButton(off)).toContain('aria-disabled="true"');
    expect(text(off)).toContain("Pick a plan to check against");
    expect(text(renderRow({ checking: "plan-synthetic-2500-v1" }))).toContain("Checking against plan-synthetic-2500-v1");
  });
  it("says Reading the plans while they are read, and the note when none reads the set", () => {
    expect(text(renderRow({ plans: null }))).toContain("Reading the plans");
    const none = renderRow({ plans: [], planId: null, plansNote: "No stored plan reads demo-behavioral-v1, so there is no plan to check against." });
    expect(text(none)).toContain("No stored plan reads demo-behavioral-v1, so there is no plan to check against.");
  });
  it("prints a pass as a status with a check mark, never colour alone", () => {
    const html = renderRow({ note: { kind: "passes", planId: "plan-synthetic-2500-v1" } });
    expect(html).toMatch(/<span class="status status-pass" role="status">✓ Passes plan plan-synthetic-2500-v1<\/span>/);
  });
  it("prints a refusal as an alert: the headline, then each line naming the stage or the binding", () => {
    const html = renderRow({ note: outcomeOf("plan-synthetic-2500-v1", R3) });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("✕ Refused by plan plan-synthetic-2500-v1 R3 at stage st-beta: selector matches no position");
    const failed = renderRow({ note: { kind: "failed", planId: "plan-synthetic-2500-v1", text: "422: invalid assumption set at bindings" } });
    expect(text(failed)).toContain("✕ Not checked against plan plan-synthetic-2500-v1 422: invalid assumption set at bindings");
  });
});

describe("EditSetView with the check row", () => {
  const view: EditSetViewProps = {
    sets: [{ id: "demo-behavioral-v1", label: "Demo", contentHash: "h" }], selected: "demo-behavioral-v1", draft: setLabel(draftSet(SET), "Demo, edited"),
    reading: false, loadError: null, listNote: null, saving: null, saveId: "demo-behavioral-v1-edit-1", note: null,
    book: null, bookId: null, bookNote: null, stored: [], storedNote: null,
    onPick() {}, onDraft() {}, onSave() {}, onReread() {},
    check: { ...row, note: outcomeOf("plan-synthetic-2500-v1", R3) },
  };
  it("sits right after Save, and a refusal leaves Save on", () => {
    const html = renderToStaticMarkup(<EditSetView {...view} />);
    const save = html.match(/<button[^>]*btn-primary[^>]*>[\s\S]*?<\/button>/)![0];
    expect(save).not.toContain("aria-disabled");
    expect(html.indexOf("btn-primary")).toBeLessThan(html.indexOf('aria-label="Check against a plan"'));
    expect(text(html)).toContain("R3 at stage st-beta");
  });
  it("is absent with no draft shown", () => {
    expect(renderToStaticMarkup(<EditSetView {...view} draft={null} selected={null} />)).not.toContain("Check against a plan");
  });
});
