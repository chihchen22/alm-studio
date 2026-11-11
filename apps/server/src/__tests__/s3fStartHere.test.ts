/**
 * The Start here list's pass rule. The card's list (the path and More demos,
 * apps/studio/src/guided/startHere.ts) is fixed in core, and this test holds it:
 *
 *  1. Every demo the seed stores is on the list exactly once, and the list names no demo the seed does not store. The
 *     seeded ids are read from the server's demo modules, the list's from the Studio module; neither is derived from
 *     the other.
 *  2. Every item names a check in the CORE register (data/src/examples/accept/registry.ts, no pack) whose register entry
 *     is shipped; that check, run here on this build, emits at least one line under the item's prefix that is a replica
 *     tie-out line on the item's own targets file (its detail names the independent Python replica's targets and that
 *     file), and every line under the prefix passes. The check's other lines pass too.
 *  3. The targets file each item names exists, and a demo's file is the one its replica check reads (restated here by
 *     hand per demo family, never read from the list).
 *
 * Step 1 (explore) is held to the bank's run-off tie-out (python-replica-tie-out on quillfield-v1.json): the figures its
 * Reports step adds, new volume and going-concern value, have no replica target, so they are not held here.
 *
 * A pass is what the check itself reports; the expected prefixes and files are restated in the list and here, never
 * taken from the check's output.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { capabilityChecks } from "@alm/data/src/examples/accept/registry";
import { loadRegister } from "@alm/data/src/examples/accept/register";
import type { CheckLine } from "@alm/data/src/examples/accept/types";
import { repoRoot } from "../config";
import { featureDemos } from "../examples/featureDemos";
import { depositFormDemos } from "../examples/depositForms";
import { survivalPathDemos } from "../examples/survivalPathDemo";
import { MORE_DEMOS, START_HERE_ITEMS, START_HERE_PATH, type StartHereItem } from "../../../studio/src/guided/startHere";
import { runDepositFormDemo } from "@alm/data/src/examples/accept/depositFormRuns";
import { depositFormSets } from "../examples/depositForms";

const ROOT = repoRoot();
let market: MarketSnapshot;
const linesByCheck = new Map<string, CheckLine[]>();

beforeAll(async () => {
  market = await loadMarketSnapshot(join(ROOT, "packages", "kernel", "public", "market_public.json"));
  // Each named check runs once, on this build.
  for (const id of new Set(START_HERE_ITEMS.map((i) => i.tieOut.check))) {
    const check = capabilityChecks.find((c) => c.capabilityId === id);
    if (check !== undefined) linesByCheck.set(id, (await check.run({ repoRoot: ROOT, market })).lines);
  }
}, 600_000);

/** What is wrong with one item under the pass rule; [] when it holds. */
function problemsOf(item: StartHereItem, register: ReadonlyArray<{ id: string; status: string }>, lines: ReadonlyMap<string, CheckLine[]>): string[] {
  const out: string[] = [];
  const { check, lines: names, targets } = item.tieOut;
  if (register.find((c) => c.id === check)?.status !== "shipped") out.push(`${item.id}: ${check} is not shipped in the register`);
  if (!capabilityChecks.some((c) => c.capabilityId === check)) out.push(`${item.id}: ${check} is not a core check`);
  if (!existsSync(join(ROOT, targets))) out.push(`${item.id}: ${targets} does not exist`);
  const all = lines.get(check) ?? [];
  const mine = "prefix" in names ? all.filter((l) => l.id.startsWith(names.prefix)) : all.filter((l) => names.ids.includes(l.id));
  if ("ids" in names && mine.length !== names.ids.length) out.push(`${item.id}: the check emits ${mine.length} of the ${names.ids.length} listed lines`);
  const replica = mine.filter((l) => l.detail.includes("independent Python replica's targets") && l.detail.includes(targets));
  if (replica.length === 0) out.push(`${item.id}: no replica line on ${targets}`);
  for (const l of mine) if (l.status !== "pass") out.push(`${item.id}: ${l.id} ${l.status}`);
  return out;
}

/** The seeded demos, from the server's three demo modules. */
const seeded = (): string[] => [
  ...featureDemos(ROOT).map((d) => d.id),
  ...depositFormDemos(ROOT).map((d) => d.id),
  ...survivalPathDemos(ROOT).map((d) => d.id),
];

describe("the Start here list", () => {
  it("is the path of eight steps, in the author's order, then eight more demos", () => {
    expect(START_HERE_PATH.map((i) => i.title)).toEqual([
      "Explore the bank",
      "Six regulatory shocks (EVE)",
      "Earnings sensitivity (SEG)",
      "Fixed-rate repricing ladder (gap)",
      "Floater funding tenor (FTP)",
      "Full beta, frozen slotting (deposits)",
      "Replicating-portfolio credit (deposit FTP)",
      "Survival path and dials (liquidity)",
    ]);
    expect(MORE_DEMOS).toHaveLength(8);
  });

  it("holds every seeded demo exactly once, and nothing the seed does not store but the explore step", () => {
    const listed = START_HERE_ITEMS.map((i) => i.id).filter((id) => id !== "explore");
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...seeded()].sort());
    expect(seeded()).toHaveLength(15);
  });

  it("names, for every demo, a shipped core check whose replica lines on its targets pass on this build; step 1 is held to the bank's run-off tie-out only", () => {
    const register = loadRegister(ROOT);
    const problems = START_HERE_ITEMS.flatMap((item) => problemsOf(item, register.capabilities, linesByCheck));
    expect(problems).toEqual([]);
  });

  it("the rule fails an item whose check is missing, whose lines are missing, off its targets, or failing", () => {
    const register = loadRegister(ROOT).capabilities;
    const seg = START_HERE_ITEMS.find((i) => i.id === "seg")!;
    const lines = linesByCheck.get("seg-ear")!;
    const failing = new Map([["seg-ear", lines.map((l, k) => (k === lines.findIndex((x) => x.id.startsWith("demo.seg.") && x.detail.includes("replica")) ? { ...l, status: "fail" as const } : l))]]);
    expect(problemsOf({ ...seg, tieOut: { ...seg.tieOut, check: "no-such-check" } }, register, linesByCheck).length).toBeGreaterThan(0);
    expect(problemsOf({ ...seg, tieOut: { ...seg.tieOut, lines: { prefix: "demo.no-such-demo." } } }, register, linesByCheck).length).toBeGreaterThan(0);
    expect(problemsOf({ ...seg, tieOut: { ...seg.tieOut, targets: "replica/targets/demo-regulatory-v1.json" } }, register, linesByCheck).length).toBeGreaterThan(0);
    expect(problemsOf({ ...seg, tieOut: { ...seg.tieOut, lines: { ids: ["demo.seg.no-such-line"] } } }, register, linesByCheck).length).toBeGreaterThan(0);
    expect(problemsOf(seg, register, failing).length).toBeGreaterThan(0);
    expect(problemsOf(seg, register, linesByCheck)).toEqual([]);
  });

  it("every line of every named check passes", () => {
    for (const [check, lines] of linesByCheck) {
      expect(lines.length, check).toBeGreaterThan(0);
      expect(lines.filter((l) => l.status !== "pass").map((l) => `${check} ${l.id}`)).toEqual([]);
    }
  });

  it("each demo reads its family's targets file", () => {
    // Restated by hand: the bank's seven S3b demos each have a file of their own; the desk's six and the funding tenor
    // share the deposit forms file; the survival path has its own; the explore step reads the bank's tie-out.
    const S3B = ["seg", "regulatory", "spread-consistent", "six-shocks", "instruments", "constant-prepay", "fixed-ladder"];
    for (const item of START_HERE_ITEMS) {
      const want = item.id === "explore" ? "replica/targets/quillfield-v1.json"
        : S3B.includes(item.id) ? `replica/targets/demo-${item.id}-v1.json`
        : item.id === "survival-path" ? "replica/targets/demo-survival-path-v1.json"
        : "replica/targets/deposit-forms-v1.json";
      expect(item.tieOut.targets, item.id).toBe(want);
    }
  });

  it("each item says what you learn and what to change in one short plain line each", () => {
    const BANNED = new RegExp(`[${String.fromCodePoint(0x2014)}${String.fromCodePoint(0xa7)}]`);
    for (const item of START_HERE_ITEMS) {
      for (const text of [item.learn, item.change]) {
        expect(text.split(/\s+/).length, `${item.id}: ${text}`).toBeLessThanOrEqual(26);
        expect(/[.!?]$/.test(text), text).toBe(true);
        expect(text.split(/\.\s/).length, `${item.id}: one sentence`).toBe(1);
        expect(BANNED.test(text), text).toBe(false);
        expect(/\d+\.\d+ percent|\$\d/.test(text), `${item.id}: no result figure`).toBe(false);
      }
    }
  });
});

/** S3f fix round (H1, M5): what the lines tell a learner to do or compare holds on the engine's own runs. */
describe("the change lines on the engine", () => {
  // The edit each assumption-set line asks for, made on the seeded set the item names (restated by hand from the lines).
  type Overlay = Record<string, Record<string, unknown>>;
  const editOf: Record<string, { family: string; apply: (o: Overlay) => void }> = {
    // The editor drops the pillar grid with the construction that reads it, as the copy the walk saved holds ({ construction: "strip" }).
    "desk-credit": { family: "dd-operating", apply: (o) => { o.replicatingPortfolio = { construction: "strip" }; } },
    "desk-component-decay": { family: "dd-savings", apply: (o) => { o.componentDecay!.retention = 0.99; } },
    "desk-full-beta-shocked": { family: "dd-mma", apply: (o) => { o.fullForm!.coreLifeYears = 7; } },
    "desk-scenario-credit": { family: "dd-savings", apply: (o) => { o.replicatingPortfolio!.scenarioCurve = "hold-base"; } },
  };
  /** The figure each line points the learner at, read off the run (restated by hand per item). */
  const figure = (id: string, r: ReturnType<typeof runDepositFormDemo>["result"]): number => {
    const fam = (f: string) => r.ftp!.byFamily.find((x) => x.familyId === f)!;
    if (id === "desk-credit") return fam("dd-operating").replicatingPortfolio!.totalCredit;
    if (id === "desk-component-decay") return r.cashflows.byScenario.find((x) => x.scenarioId === "S0")!.byFamily.find((x) => x.familyId === "dd-savings")!.walYears!;
    if (id === "desk-full-beta-shocked") {
      const pv = (sc: string) => r.eve.byScenario.find((x) => x.scenarioId === sc)!.byFamily.find((x) => x.familyId === "dd-mma")!.pv;
      return pv("S100") - pv("S0");
    }
    return fam("dd-savings").scenarioCredit!.byScenario.find((x) => x.scenarioId === "S100")!.totalCredit;
  };

  it("names the seeded set each assumption-set item's demo runs on, and nothing else carries an edit", () => {
    const sets = new Set(depositFormSets(ROOT).map((x) => x.id));
    for (const item of START_HERE_ITEMS) {
      expect(item.edit !== undefined, item.id).toBe(item.id in editOf);
      if (item.edit === undefined) continue;
      expect(sets.has(item.edit.setId), item.id).toBe(true);
      expect(item.change, item.id).toMatch(/^Open the assumption set, .*press Save, then Use this copy and Launch/);
    }
  });

  it("each assumption-set edit, made as its line says, moves the figure the line points at", () => {
    for (const [id, e] of Object.entries(editOf)) {
      const item = START_HERE_ITEMS.find((i) => i.id === id)!;
      const base = runDepositFormDemo(ROOT, market, id as never).result;
      const edited = runDepositFormDemo(ROOT, market, id as never, {
        editSets: (sets) => sets.map((set) => set.id !== item.edit!.setId ? set : {
          ...set,
          bindings: set.bindings.map((b) => {
            if ((b as { familyId?: string }).familyId !== e.family) return b;
            const c = structuredClone(b) as unknown as { overlay: Overlay };
            e.apply(c.overlay);
            return c as unknown as typeof b;
          }),
        }),
      }).result;
      expect(figure(id, edited), id).not.toBeCloseTo(figure(id, base), 6);
    }
  }, 300_000);

  it("step 5's comparison is true on its run: one IR FTP for the floaters, and the 60-month tenor's LP FTP above the 24-month one", () => {
    const r = runDepositFormDemo(ROOT, market, "funding-tenor").result;
    const fam = (f: string) => r.ftp!.byFamily.find((x) => x.familyId === f)!;
    expect(fam("mb-heloc").irFtpRate).toBeCloseTo(fam("mb-cre-construction").irFtpRate!, 12);
    expect(fam("mb-ci-floating").irFtpRate).toBeCloseTo(fam("mb-cre-construction").irFtpRate!, 12);
    expect(fam("mb-heloc").lpFtpRate!).toBeGreaterThan(fam("mb-cre-construction").lpFtpRate!);
    const step5 = START_HERE_PATH[4]!;
    expect(step5.change).toContain("mb-heloc's 60-month funding tenor");
    expect(step5.change).toContain("mb-cre-construction's 24");
  });
});
