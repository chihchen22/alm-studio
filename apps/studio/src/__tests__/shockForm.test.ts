// apps/studio/src/__tests__/shockForm.test.ts
/**
 * The shock builder's form model. Every expected spec, message and rule is restated here from the spec,
 * never read back from the module.
 */
import { describe, expect, it } from "vitest";
import type { RunPlan, ScenarioLibrary } from "@alm/engine";
import { planDoc } from "./fixtures/run";
import {
  addKnot, afterUpdate, blankForm, checkForm, chooseStart, editRule, errorFor, fromRateSpec, libraryIds, newBuilder, openBuilder,
  focusAfterRemove, readNumber, reconcile, removeKnot, setKnot, shapeSpec, startOptions, takenIds, withForm, type ShockForm,
} from "../scenarios/shockForm";

const LIBS: ScenarioLibrary[] = [
  { schemaVersion: "1.0.0", id: "regulatory-grid-v1", label: "grid", scenarios: [
    { id: "S0", label: "S0", rateSpec: { kind: "base" } },
    { id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 } },
  ] },
  { schemaVersion: "1.0.0", id: "steepener-v1", label: "steep", scenarios: [
    { id: "STEEP100", label: "Steepener +100 long", rateSpec: { kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 } },
  ] },
];

/** A base ref, a library ref, an inline copy under a library id, an own inline shock, a ramp, an environment scenario, an unknown ref. */
const PLAN: RunPlan = {
  ...planDoc("plan-x", []),
  scenarios: [
    { ref: "regulatory-grid-v1#S0" },
    { ref: "steepener-v1#STEEP100" },
    { id: "S200", label: "S200", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: "stack-0123456789ab" },
    { id: "UP300", label: "Up 300", rateSpec: { kind: "parallel", shockBp: 300 } },
    { id: "RAMP50", rateSpec: { kind: "parallel", shockBp: 50 }, timing: { kind: "ramp", months: 6 } },
    { id: "ENV1", rateSpec: { kind: "parallel", shockBp: 25 }, environment: { unemploymentPath: [0.04] } },
    { ref: "nope-v1#X" },
  ],
};
const at = (id: string) => PLAN.scenarios.find((s) => ("ref" in s ? s.ref.endsWith(`#${id}`) : s.id === id))!;
const form = (over: Partial<ShockForm>): ShockForm => ({ ...blankForm(), ...over });
const NONE: ReadonlySet<string> = new Set();

describe("blankForm and newBuilder", () => {
  it("a blank form is parallel with every field empty and one empty knot row, built fresh on each call; a new builder holds one", () => {
    const BLANK: ShockForm = { shape: "parallel", parallelBp: "", twist: { shortBp: "", pivotYears: "", longBp: "" }, knots: [{ key: 0, tenorYears: "", shockBp: "" }], nextKey: 1, id: "", label: "" };
    expect(blankForm()).toEqual(BLANK);
    expect(newBuilder()).toEqual({ mode: { kind: "new" }, start: "", form: BLANK, note: null });
    const a = blankForm();
    const b = blankForm();
    expect(a).not.toBe(b);
    expect(a.knots).not.toBe(b.knots);
    expect(a.knots[0]).not.toBe(b.knots[0]);
    expect(a.twist).not.toBe(b.twist);
  });
});

describe("readNumber", () => {
  it("reads a plain decimal and nothing else", () => {
    expect(readNumber("300")).toBe(300);
    expect(readNumber("-0.25")).toBe(-0.25);
    for (const s of ["", " 5", "5 ", "+5", "5.", ".5", "0x10", "1e3", "1,000", "abc"]) expect(readNumber(s), s).toBeNull();
  });
});

describe("libraryIds", () => {
  it("holds every scenario id any library holds", () => {
    expect(libraryIds(LIBS)).toEqual(new Set(["S0", "S200", "STEEP100"]));
  });
});

describe("checkForm", () => {
  it("parallel: the shift in bp", () => {
    expect(checkForm(form({ parallelBp: "300", id: "UP300B" }), NONE, NONE))
      .toEqual({ ok: true, id: "UP300B", label: undefined, rateSpec: { kind: "parallel", shockBp: 300 } });
  });
  it("twist: shift at 0y, pivot and long-end shift", () => {
    expect(checkForm(form({ shape: "twist", twist: { shortBp: "-50", pivotYears: "2", longBp: "75" }, id: "TW", label: "Twist" }), NONE, NONE))
      .toEqual({ ok: true, id: "TW", label: "Twist", rateSpec: { kind: "twist", shortBp: -50, longBp: 75, pivotYears: 2 } });
  });
  it("tenor knots keep the typed order; the engine, not the form, refuses a disorder", () => {
    const c = checkForm(form({ shape: "custom", knots: [{ key: 0, tenorYears: "5", shockBp: "10" }, { key: 1, tenorYears: "1", shockBp: "20" }], id: "KN" }), NONE, NONE);
    expect(c.ok && c.rateSpec).toEqual({ kind: "custom", shocks: [{ tenorYears: 5, shockBp: 10 }, { tenorYears: 1, shockBp: 20 }] });
  });
  it("names every field that is not a plain decimal", () => {
    for (const bp of ["", "1e3"]) {
      const p = checkForm(form({ shape: "parallel", parallelBp: bp, id: "P" }), NONE, NONE);
      expect(p.ok, `parallelBp "${bp}"`).toBe(false);
      expect(errorFor(p, "parallelBp"), `parallelBp "${bp}"`).toBe("Type a number");
    }
    const c = checkForm(form({ shape: "twist", twist: { shortBp: "x", pivotYears: "", longBp: "1e2" }, id: "TW" }), NONE, NONE);
    expect(c.ok).toBe(false);
    expect(errorFor(c, "twist.shortBp")).toBe("Type a number");
    expect(errorFor(c, "twist.pivotYears")).toBe("Type a number");
    expect(errorFor(c, "twist.longBp")).toBe("Type a number");
    const k = checkForm(form({ shape: "custom", knots: [{ key: 0, tenorYears: "1", shockBp: "" }], id: "KN" }), NONE, NONE);
    expect(errorFor(k, "knots[0].shockBp")).toBe("Type a number");
    expect(errorFor(k, "knots[0].tenorYears")).toBeNull();
    const k2 = checkForm(form({ shape: "custom", knots: [{ key: 0, tenorYears: "1", shockBp: "5" }, { key: 1, tenorYears: "", shockBp: "5" }], id: "KN" }), NONE, NONE);
    expect(errorFor(k2, "knots[1].tenorYears")).toBe("Type a number");
    expect(errorFor(k2, "knots[0].tenorYears")).toBeNull();
  });
  it("needs at least one knot", () => {
    expect(errorFor(checkForm(form({ shape: "custom", knots: [], id: "KN" }), NONE, NONE), "knots")).toBe("Add at least one knot");
  });
  it("applies the id rules", () => {
    const idErr = (id: string, taken: ReadonlySet<string> = NONE) => errorFor(checkForm(form({ parallelBp: "1", id }), taken, NONE), "id");
    expect(idErr("")).toBe("Type an id");
    for (const bad of ["a b", "x#y", "-x", "S.1", "a".repeat(41)]) {
      expect(idErr(bad), bad).toBe("Use letters, digits, dash or underscore, up to 40 characters, starting with a letter or digit");
    }
    expect(idErr("a".repeat(40))).toBeNull();
    expect(idErr("S-300")).toBeNull();
    for (const r of ["t", "month", "base"]) expect(idErr(r), r).toBe(`"${r}" is reserved: the Rates layer uses it as a chart key`);
    expect(idErr("UP300", takenIds(PLAN, { kind: "new" }))).toBe('The plan already holds a scenario "UP300"');
    expect(idErr("UP300", takenIds(PLAN, { kind: "edit", id: "UP300" }))).toBeNull();
  });
  it("refuses an id a library holds, after the plan rule", () => {
    const held = libraryIds(LIBS);
    const lean: RunPlan = { ...PLAN, scenarios: [{ ref: "regulatory-grid-v1#S0" }] };
    const idErr = (plan: RunPlan, id: string) => errorFor(checkForm(form({ parallelBp: "1", id }), takenIds(plan, { kind: "new" }), held), "id");
    expect(idErr(lean, "S200")).toBe('A library holds a scenario "S200"; give this scenario its own id');
    expect(idErr(PLAN, "S200")).toBe('The plan already holds a scenario "S200"');
    expect(checkForm(form({ parallelBp: "1", id: "UP300" }), takenIds(PLAN, { kind: "edit", id: "UP300" }), held)).toMatchObject({ ok: true, id: "UP300" });
  });
  it("an empty label stores none; a typed label is kept as typed", () => {
    expect(checkForm(form({ parallelBp: "1", id: "A" }), NONE, NONE)).toMatchObject({ ok: true, label: undefined });
    expect(checkForm(form({ parallelBp: "1", id: "A", label: "Up 1" }), NONE, NONE)).toMatchObject({ ok: true, label: "Up 1" });
  });
});

describe("shapeSpec (spec Section 5.1 item 4: the preview reads the shape alone)", () => {
  it("reads the shape with no id rule, so an empty or refused id still gives the spec", () => {
    expect(shapeSpec(form({ parallelBp: "200" }))).toEqual({ kind: "parallel", shockBp: 200 });
    expect(shapeSpec(form({ parallelBp: "200", id: "base" }))).toEqual({ kind: "parallel", shockBp: 200 });
    expect(shapeSpec(form({ shape: "twist", twist: { shortBp: "-50", pivotYears: "40", longBp: "75" } })))
      .toEqual({ kind: "twist", shortBp: -50, longBp: 75, pivotYears: 40 });
    expect(shapeSpec(form({ shape: "custom", knots: [{ key: 0, tenorYears: "5", shockBp: "10" }, { key: 1, tenorYears: "1", shockBp: "20" }] })))
      .toEqual({ kind: "custom", shocks: [{ tenorYears: 5, shockBp: 10 }, { tenorYears: 1, shockBp: 20 }] });
  });
  it("is null while a shape number is not a plain decimal, and with no knot row", () => {
    for (const bp of ["", "1e3", "+5"]) expect(shapeSpec(form({ parallelBp: bp, id: "P" })), bp).toBeNull();
    expect(shapeSpec(form({ shape: "twist", twist: { shortBp: "-50", pivotYears: "", longBp: "75" }, id: "TW" }))).toBeNull();
    expect(shapeSpec(form({ shape: "custom", knots: [{ key: 0, tenorYears: "1", shockBp: "x" }], id: "KN" }))).toBeNull();
    expect(shapeSpec(form({ shape: "custom", knots: [], id: "KN" }))).toBeNull();
  });
  it("gives a passing form the same spec checkForm gives it", () => {
    const f = form({ shape: "twist", twist: { shortBp: "0", pivotYears: "5", longBp: "100" }, id: "MINE" });
    const c = checkForm(f, NONE, NONE);
    expect(c.ok && c.rateSpec).toEqual({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 });
    expect(shapeSpec(f)).toEqual({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 });
  });
});

describe("the builder's note (spec Section 5.1 item 7; drive D7 and D11)", () => {
  const BASE_NOTE = '"S0" is the base scenario. The builder does not build or edit a base scenario.';
  it("withForm sets the form and clears the note; the mode and the Start from key stay", () => {
    const b = openBuilder(PLAN, LIBS, "S0");
    expect(b.note).toBe(BASE_NOTE);
    expect(withForm(b, form({ parallelBp: "5", id: "MINE" })))
      .toEqual({ mode: { kind: "new" }, start: "", form: form({ parallelBp: "5", id: "MINE" }), note: null });
    const copy = { ...openBuilder(PLAN, LIBS, "STEEP100"), note: "x" };
    expect(withForm(copy, form({ parallelBp: "1" }))).toEqual({ mode: { kind: "new" }, start: "plan:STEEP100", form: form({ parallelBp: "1" }), note: null });
  });
  it("chooseStart clears the note, for an option and for Blank; an unknown key changes nothing", () => {
    const b = { ...openBuilder(PLAN, LIBS, "S0"), form: form({ id: "MINE", label: "Mine" }) };
    const opts = startOptions(PLAN, LIBS);
    expect(chooseStart(b, "plan:STEEP100", opts)).toEqual({
      mode: { kind: "new" }, start: "plan:STEEP100", form: form({ shape: "twist", twist: { shortBp: "0", pivotYears: "5", longBp: "100" }, id: "MINE", label: "Mine" }), note: null,
    });
    expect(chooseStart(b, "", opts)).toEqual({ mode: { kind: "new" }, start: "", form: form({ id: "MINE", label: "Mine" }), note: null });
    expect(chooseStart(b, "plan:NOPE", opts)).toBe(b);
  });
  const LINE = 'Updated "UP300" in the plan. Save as keeps it.';
  /** The builder right after Update UP300 wrote parallel 301 with the label "Up 301". */
  const EDITED = form({ parallelBp: "301", id: "UP300", label: "Up 301" });
  const DONE = {
    mode: { kind: "edit" as const, id: "UP300" }, start: "", form: EDITED, note: LINE,
    updated: { id: "UP300", rateSpec: { kind: "parallel" as const, shockBp: 301 }, label: "Up 301" },
  };
  /** PLAN with UP300 as that Update left it: a spec equal by value to the one recorded, not the same object. */
  const withUp = (rateSpec: { kind: "parallel"; shockBp: number }, label: string | undefined): RunPlan => ({
    ...PLAN,
    scenarios: PLAN.scenarios.map((s) => ("id" in s && s.id === "UP300" ? (label === undefined ? { id: "UP300", rateSpec } : { id: "UP300", label, rateSpec }) : s)),
  });
  it("afterUpdate names the updated scenario in one line and records the shock and label it wrote", () => {
    const edit = { ...openBuilder(PLAN, LIBS, "UP300"), form: EDITED };
    expect(afterUpdate(edit, "UP300", { kind: "parallel", shockBp: 301 }, "Up 301")).toEqual(DONE);
    expect(afterUpdate(edit, "UP300", { kind: "parallel", shockBp: 301 }, undefined).updated).toEqual({ id: "UP300", rateSpec: { kind: "parallel", shockBp: 301 }, label: undefined });
  });
  it("reconcile keeps the line while the plan's scenario holds the shock and label the Update wrote", () => {
    expect(reconcile(DONE, withUp({ kind: "parallel", shockBp: 301 }, "Up 301"), LIBS)).toBe(DONE);
  });
  it("reconcile drops the line and its record once the plan no longer holds the update: the stored plan (as after Reset), another label, another shock", () => {
    const LOST = { mode: { kind: "edit", id: "UP300" }, start: "", form: EDITED, note: null };
    for (const plan of [PLAN, withUp({ kind: "parallel", shockBp: 301 }, "Up 300"), withUp({ kind: "parallel", shockBp: 301 }, undefined), withUp({ kind: "parallel", shockBp: 302 }, "Up 301")]) {
      const r = reconcile(DONE, plan, LIBS);
      expect(r).toEqual(LOST);
      expect("updated" in r).toBe(false);
    }
  });
  it("a form edit or a Start from choice clears the line and its record", () => {
    const next = withForm(DONE, form({ parallelBp: "302", id: "UP300", label: "Up 301" }));
    expect(next).toEqual({ mode: { kind: "edit", id: "UP300" }, start: "", form: form({ parallelBp: "302", id: "UP300", label: "Up 301" }), note: null });
    expect("updated" in next).toBe(false);
    const chosen = chooseStart({ ...DONE, mode: { kind: "new" } }, "", startOptions(PLAN, LIBS));
    expect(chosen.note).toBeNull();
    expect("updated" in chosen).toBe(false);
  });
});

describe("fromRateSpec", () => {
  it("fills the shape and sizes and keeps the caller's id and label", () => {
    expect(fromRateSpec({ kind: "parallel", shockBp: -400 }, { id: "D", label: "Down" })).toEqual(form({ parallelBp: "-400", id: "D", label: "Down" }));
    expect(fromRateSpec({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 }, { id: "", label: "" }))
      .toEqual(form({ shape: "twist", twist: { shortBp: "0", pivotYears: "5", longBp: "100" } }));
    expect(fromRateSpec({ kind: "custom", shocks: [{ tenorYears: 0.25, shockBp: 10 }] }, { id: "", label: "" }))
      .toEqual(form({ shape: "custom", knots: [{ key: 0, tenorYears: "0.25", shockBp: "10" }] }));
    expect(() => fromRateSpec({ kind: "base" }, { id: "", label: "" })).toThrow("the builder does not build or edit a base scenario");
  });
});

describe("knot rows", () => {
  it("add, set and remove rows, never sorting", () => {
    let f = form({ shape: "custom", knots: [{ key: 0, tenorYears: "5", shockBp: "1" }] });
    f = addKnot(f);
    expect(f.knots).toEqual([{ key: 0, tenorYears: "5", shockBp: "1" }, { key: 1, tenorYears: "", shockBp: "" }]);
    f = setKnot(f, 1, { key: 1, tenorYears: "1", shockBp: "2" });
    expect(f.knots).toEqual([{ key: 0, tenorYears: "5", shockBp: "1" }, { key: 1, tenorYears: "1", shockBp: "2" }]);
    expect(removeKnot(f, 0).knots).toEqual([{ key: 1, tenorYears: "1", shockBp: "2" }]);
  });
  it("row keys are stable: removing a middle row keeps the first and third keys, and a key is never reused (Polish 1 S6)", () => {
    const f = removeKnot(addKnot(addKnot(blankForm())), 1);
    expect(f.knots.map((k) => k.key)).toEqual([0, 2]);
    expect(addKnot(f).knots.map((k) => k.key)).toEqual([0, 2, 3]);
    const filled = fromRateSpec({ kind: "custom", shocks: [{ tenorYears: 1, shockBp: 5 }, { tenorYears: 5, shockBp: 10 }] }, { id: "", label: "" });
    expect(filled.knots.map((k) => k.key)).toEqual([0, 1]);
    expect(filled.nextKey).toBe(2);
  });
  it("after a remove, focus goes to the next row's Remove button, or to Add knot when no row follows (Task 8 fix S6 focus)", () => {
    const f = addKnot(addKnot(blankForm()));
    expect(f.knots.map((k) => k.key)).toEqual([0, 1, 2]);
    expect(focusAfterRemove(f, 0)).toBe(1);
    expect(focusAfterRemove(f, 1)).toBe(2);
    expect(focusAfterRemove(f, 2)).toBe("add");
    expect(focusAfterRemove(blankForm(), 0)).toBe("add");
  });
});

describe("editRule", () => {
  it("edits only an own inline shock; copies library, ramp and environment scenarios; nothing for a base or an unknown ref", () => {
    expect(editRule(at("UP300"), LIBS)).toBe("edit");
    expect(editRule(at("S200"), LIBS)).toBe("copy");
    expect(editRule(at("STEEP100"), LIBS)).toBe("copy");
    expect(editRule(at("RAMP50"), LIBS)).toBe("copy");
    expect(editRule(at("ENV1"), LIBS)).toBe("copy");
    expect(editRule(at("S0"), LIBS)).toBe("none");
    expect(editRule(at("X"), LIBS)).toBe("none");
    expect(editRule({ id: "B2", rateSpec: { kind: "base" } }, LIBS)).toBe("none");
  });
  it("copies an own inline shock whose id the builder refuses (item 1): a dot, a reserved id, over 40 characters", () => {
    for (const id of ["S.1", "base", "t", "month", "a".repeat(41)]) {
      expect(editRule({ id, rateSpec: { kind: "parallel", shockBp: 100 } }, LIBS), id).toBe("copy");
    }
    expect(editRule({ id: "a".repeat(40), rateSpec: { kind: "parallel", shockBp: 100 } }, LIBS)).toBe("edit");
  });
});

describe("openBuilder (spec Section 5.3 item 4)", () => {
  it("opens blank with no scenario, and blank with a reason for an unknown id, a base or an unknown ref", () => {
    expect(openBuilder(PLAN, LIBS, undefined)).toEqual(newBuilder());
    expect(openBuilder(PLAN, LIBS, "NOPE").note).toBe('The plan holds no scenario "NOPE".');
    expect(openBuilder(PLAN, LIBS, "S0")).toEqual({ ...newBuilder(), note: '"S0" is the base scenario. The builder does not build or edit a base scenario.' });
    expect(openBuilder(PLAN, LIBS, "X").note).toBe("No library holds nope-v1#X, so its shock cannot be read.");
  });
  it("opens an own inline shock in edit mode, and any other scenario as Start from with an empty id", () => {
    expect(openBuilder(PLAN, LIBS, "UP300"))
      .toEqual({ mode: { kind: "edit", id: "UP300" }, start: "", form: form({ parallelBp: "300", id: "UP300", label: "Up 300" }), note: null });
    expect(openBuilder(PLAN, LIBS, "STEEP100")).toEqual({
      mode: { kind: "new" }, start: "plan:STEEP100", form: form({ shape: "twist", twist: { shortBp: "0", pivotYears: "5", longBp: "100" } }), note: null,
    });
  });
  it("opens an own inline shock whose id the builder refuses as Start from with an empty id, not as an edit it could never update", () => {
    const odd: RunPlan = {
      ...PLAN,
      scenarios: [...PLAN.scenarios, { id: "S.1", rateSpec: { kind: "parallel", shockBp: 100 } }, { id: "base", label: "Up 50", rateSpec: { kind: "parallel", shockBp: 50 } }],
    };
    expect(openBuilder(odd, LIBS, "S.1")).toEqual({ mode: { kind: "new" }, start: "plan:S.1", form: form({ parallelBp: "100" }), note: null });
    expect(openBuilder(odd, LIBS, "base")).toEqual({ mode: { kind: "new" }, start: "plan:base", form: form({ parallelBp: "50" }), note: null });
    expect(startOptions(odd, LIBS).map((o) => o.key)).toEqual(expect.arrayContaining(["plan:S.1", "plan:base"]));
  });
});

describe("reconcile", () => {
  it("keeps an edit whose scenario the plan still holds: the same object", () => {
    const edit = openBuilder(PLAN, LIBS, "UP300");
    expect(reconcile(edit, PLAN, LIBS)).toBe(edit);
  });
  it("an edit whose scenario the plan no longer holds (Reset removed it) opens blank, with the reason", () => {
    const lost: RunPlan = { ...PLAN, scenarios: PLAN.scenarios.filter((s) => !("id" in s) || s.id !== "UP300") };
    expect(reconcile(openBuilder(PLAN, LIBS, "UP300"), lost, LIBS)).toEqual({
      mode: { kind: "new" },
      start: "",
      form: { shape: "parallel", parallelBp: "", twist: { shortBp: "", pivotYears: "", longBp: "" }, knots: [{ key: 0, tenorYears: "", shockBp: "" }], nextKey: 1, id: "", label: "" },
      note: 'The plan holds no scenario "UP300".',
    });
  });
  it("returns a new-mode state as is", () => {
    const fresh = newBuilder();
    expect(reconcile(fresh, PLAN, LIBS)).toBe(fresh);
  });
});

describe("Start from", () => {
  it("lists the plan's scenarios, then library scenarios the plan lacks; never a base or an unknown ref", () => {
    expect(startOptions(PLAN, LIBS).map((o) => [o.key, o.text])).toEqual([
      ["plan:STEEP100", "STEEP100: Steepener +100 long (in the plan)"],
      ["plan:S200", "S200 (in the plan)"],
      ["plan:UP300", "UP300: Up 300 (in the plan)"],
      ["plan:RAMP50", "RAMP50 (in the plan)"],
      ["plan:ENV1", "ENV1 (in the plan)"],
    ]);
    const lean: RunPlan = { ...PLAN, scenarios: [{ ref: "regulatory-grid-v1#S0" }] };
    expect(startOptions(lean, LIBS).map((o) => o.key)).toEqual(["lib:regulatory-grid-v1#S200", "lib:steepener-v1#STEEP100"]);
  });
  it("fills the shape and sizes and keeps the typed id and label; Blank clears them; an unknown key changes nothing", () => {
    const b = { ...newBuilder(), form: form({ parallelBp: "9", id: "MINE", label: "Mine" }) };
    const opts = startOptions(PLAN, LIBS);
    const s = chooseStart(b, "plan:STEEP100", opts);
    expect(s.start).toBe("plan:STEEP100");
    expect(s.form).toEqual(form({ shape: "twist", twist: { shortBp: "0", pivotYears: "5", longBp: "100" }, id: "MINE", label: "Mine" }));
    expect(chooseStart(s, "", opts)).toEqual({ ...s, start: "", form: form({ id: "MINE", label: "Mine" }) });
    expect(chooseStart(s, "plan:NOPE", opts)).toBe(s);
  });
});
