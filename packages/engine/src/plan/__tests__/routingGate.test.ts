import { describe, expect, it } from "vitest";
import type { BehavioralClassId, RunPlan } from "../../contracts/plan";
import { baseAssumptions, segmentedAssumptions, segmentedNmdBook, twoSidedBook } from "../../run/__tests__/fixtures";
import { routingGate, selectorMatchesFamily } from "../routingGate";
import { fixturePlan, loadPolicy } from "./fixtures";

const run = (plan = fixturePlan()) => routingGate(plan, loadPolicy(), twoSidedBook(), [baseAssumptions()]);
const rules = (r: ReturnType<typeof run>) => r.failures.map((f) => `${f.rule}:${f.stageId}`);
const detail = (r: ReturnType<typeof run>, rule: string, stageId: string | null = null) =>
  r.failures.find((f) => f.rule === rule && (stageId === null || f.stageId === stageId))?.detail ?? "";

describe("routingGate", () => {
  it("passes the fixture plan", () => {
    const r = run();
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
  });
  it("R1: decay routed into NII fails, naming the stage, the class and the metric", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-decay")!.feeds = ["nii", "eve"];
    const r = run(p);
    expect(rules(r)).toContain("R1:st-decay");
    expect(detail(r, "R1", "st-decay")).toContain("decay");
    expect(detail(r, "R1", "st-decay")).toContain("nii");
  });
  it("R2: an M stage feeding a metric the policy marks A fails without an override", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-prepay")!.feeds = ["nii", "eve", "ir-gap", "liq-gap"]; // prepayment -> liq-gap is A
    expect(rules(run(p))).toContain("R2:st-prepay");
  });
  it("R2: the same routing passes with params.override and echoes it", () => {
    const p = fixturePlan();
    const prepay = p.stages.find((s) => s.id === "st-prepay")!;
    prepay.feeds = ["nii", "eve", "ir-gap", "liq-gap"];
    prepay.params = { override: "ALCO 2026-03 approved prepay as the liquidity timing model" };
    const r = run(p);
    expect(rules(r)).not.toContain("R2:st-prepay");
    expect(r.checked.join("\n")).toContain("ALCO 2026-03");
  });
  it("R3: a selector matching no position fails", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-prepay")!.selector = { productFamily: "HELOC", behavioralClasses: "prepayment" };
    expect(rules(run(p))).toContain("R3:st-prepay");
  });
  it("R3: a side selector is compared lowercase", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-decay")!.selector = { side: "Liability", behavioralClasses: "decay" };
    expect(rules(run(p)).filter((x) => x.startsWith("R3"))).toEqual([]);
  });
  it("R4: a family with a derived class and no matching behavioral stage fails", () => {
    const p = fixturePlan();
    p.stages = p.stages.filter((s) => s.id !== "st-decay"); // DDA still carries the decay overlay
    p.stages.find((s) => s.id === "st-beta")!.dependsOn = ["st-prepay", "st-term"];
    const r = run(p);
    expect(rules(r)).toContain("R4:null");
    expect(r.failures.find((f) => f.rule === "R4")!.detail).toContain("DDA");
  });
  it("R1: a behavioral stage with no declared class fails and covers nothing under R4", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-decay")!.selector = { productFamily: "DDA" }; // DDA still carries the decay overlay
    const r = run(p);
    expect(rules(r)).toContain("R1:st-decay");
    expect(detail(r, "R1", "st-decay")).toContain("selector.behavioralClasses");
    expect(rules(r)).toContain("R4:null");
    expect(detail(r, "R4")).toContain("DDA:decay");
  });
  it("R1: a behavioral stage with no feeds array fails, naming feeds", () => {
    const p = fixturePlan();
    delete p.stages.find((s) => s.id === "st-decay")!.feeds;
    const r = run(p);
    expect(rules(r)).toContain("R1:st-decay");
    expect(detail(r, "R1", "st-decay")).toContain("feeds");
  });
  it("R1: a class absent from the policy fails, naming the class", () => {
    const policy = loadPolicy();
    const trimmed = { ...policy, classes: policy.classes.filter((c) => c.id !== "decay") };
    const r = routingGate(fixturePlan(), trimmed, twoSidedBook(), [baseAssumptions()]);
    expect(rules(r)).toContain("R1:st-decay");
    expect(detail(r, "R1", "st-decay")).toContain("decay");
    expect(detail(r, "R1", "st-decay")).toContain("not in routing policy");
  });
});

describe("selectorMatchesFamily", () => {
  const classes = new Set<BehavioralClassId>(["decay", "deposit-beta"]);
  it("an undefined selector matches every family", () => {
    expect(selectorMatchesFamily(undefined, "DDA", "liability", new Set())).toBe(true);
  });
  it("matches a scalar productFamily and rejects another family", () => {
    expect(selectorMatchesFamily({ productFamily: "DDA" }, "DDA", "liability", classes)).toBe(true);
    expect(selectorMatchesFamily({ productFamily: "DDA" }, "MMA", "liability", classes)).toBe(false);
  });
  it("matches any family in a productFamily array", () => {
    const sel = { productFamily: ["DDA", "MMA"] };
    expect(selectorMatchesFamily(sel, "MMA", "liability", classes)).toBe(true);
    expect(selectorMatchesFamily(sel, "MORTGAGE", "asset", classes)).toBe(false);
  });
  it("compares side lowercase on both sides and rejects the other side", () => {
    expect(selectorMatchesFamily({ side: "Liability" }, "DDA", "liability", classes)).toBe(true);
    expect(selectorMatchesFamily({ side: "liability" }, "DDA", "LIABILITY", classes)).toBe(true);
    expect(selectorMatchesFamily({ side: "asset" }, "DDA", "liability", classes)).toBe(false);
  });
  it("behavioralClasses is any-of, and fails when none of the wanted classes is derived", () => {
    expect(selectorMatchesFamily({ behavioralClasses: "decay" }, "DDA", "liability", classes)).toBe(true);
    expect(selectorMatchesFamily({ behavioralClasses: ["prepayment", "decay"] }, "DDA", "liability", classes)).toBe(true);
    expect(selectorMatchesFamily({ behavioralClasses: "prepayment" }, "DDA", "liability", classes)).toBe(false);
    expect(selectorMatchesFamily({ behavioralClasses: "decay" }, "DDA", "liability", new Set())).toBe(false);
  });
  it("every declared field must match, not just one", () => {
    const sel = { productFamily: "DDA", side: "liability", behavioralClasses: "decay" } as const;
    expect(selectorMatchesFamily(sel, "DDA", "liability", classes)).toBe(true);
    expect(selectorMatchesFamily(sel, "MMA", "liability", classes)).toBe(false);
    expect(selectorMatchesFamily(sel, "DDA", "asset", classes)).toBe(false);
    expect(selectorMatchesFamily(sel, "DDA", "liability", new Set(["deposit-beta"]))).toBe(false);
  });
});

describe("piece 2a: per position", () => {
  const segRun = (plan: RunPlan, sets = [segmentedAssumptions()]) => routingGate(plan, loadPolicy(), segmentedNmdBook(), sets);
  it("R3: a stage predicate that no position satisfies fails, naming the stage and the predicate", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-decay")!.selector = { behavioralClasses: "decay", dimensions: { segment: "whale" } };
    const r = segRun(p);
    expect(rules(r)).toContain("R3:st-decay");
    expect(detail(r, "R3", "st-decay")).toContain('"segment":["whale"]');
  });
  it("R3: a stage predicate some position satisfies passes and the checked line counts positions", () => {
    const p = fixturePlan();
    p.stages.find((s) => s.id === "st-decay")!.selector = { behavioralClasses: "decay", dimensions: { segment: ["rate-shopper", "relationship"] } };
    const r = segRun(p);
    expect(rules(r).filter((x) => x.startsWith("R3"))).toEqual([]);
    expect(r.checked.join("\n")).toMatch(/R3 .*st-decay.* 3 position/);
  });
  it("R4: a position whose own behavioralClasses tag is the only source of a class is uncovered without a stage", () => {
    const book = segmentedNmdBook();
    book.taxonomy = { ...book.taxonomy!, dimensions: [...book.taxonomy!.dimensions, { id: "behavioralClasses", label: "c", multiValued: true }] };
    const f1 = book.positions.find((p) => p.id === "F1")!;
    book.positions = book.positions.map((p) => (p.id === "F1" ? { ...f1, dimensions: { behavioralClasses: ["client-rate-asset"] } } : p));
    const r = routingGate(fixturePlan(), loadPolicy(), book, [baseAssumptions()]);
    expect(rules(r)).toContain("R4:null");
    expect(r.failures.find((f) => f.rule === "R4")!.detail).toContain("FIXED:client-rate-asset (1 position");
  });
  it("R4: the same book passes once a stage declares the class and matches the position", () => {
    const book = segmentedNmdBook();
    book.taxonomy = { ...book.taxonomy!, dimensions: [...book.taxonomy!.dimensions, { id: "behavioralClasses", label: "c", multiValued: true }] };
    const f1 = book.positions.find((p) => p.id === "F1")!;
    book.positions = book.positions.map((p) => (p.id === "F1" ? { ...f1, dimensions: { behavioralClasses: ["client-rate-asset"] } } : p));
    const p = fixturePlan();
    p.stages.push({ id: "st-cra", component: "alm-loan-client-rate", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], selector: { behavioralClasses: "client-rate-asset" }, disposition: "M", feeds: ["nii"], dependsOn: ["st-term"] });
    const r = routingGate(p, loadPolicy(), book, [baseAssumptions()]);
    expect(rules(r).filter((x) => x.startsWith("R4"))).toEqual([]);
  });
  it("R4: a stage declaring the class but carrying a predicate the position fails leaves it uncovered", () => {
    const book = segmentedNmdBook();
    book.taxonomy = { ...book.taxonomy!, dimensions: [...book.taxonomy!.dimensions, { id: "behavioralClasses", label: "c", multiValued: true }] };
    const f1 = book.positions.find((p) => p.id === "F1")!;
    book.positions = book.positions.map((p) => (p.id === "F1" ? { ...f1, dimensions: { behavioralClasses: ["client-rate-asset"] } } : p));
    const p = fixturePlan();
    p.stages.push({ id: "st-cra", component: "alm-loan-client-rate", kind: "behavioral", consumes: ["Position", "RatePath"], produces: ["Position"], selector: { behavioralClasses: "client-rate-asset", dimensions: { segment: "whale" } }, disposition: "M", feeds: ["nii"], dependsOn: ["st-term"] });
    const r = routingGate(p, loadPolicy(), book, [baseAssumptions()]);
    expect(rules(r)).toContain("R4:null");
    expect(r.failures.find((f) => f.rule === "R4")!.detail).toContain("FIXED:client-rate-asset (1 position");
  });
});
