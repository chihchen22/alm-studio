// apps/studio/src/__tests__/s3c1DepositForms.test.tsx
/**
 * The seven S3c-1 cards and the desk's workspace rule (the Home section that rendered them
 * was removed in the S3f cleanup; its render cases moved to s3fStartHere.test.tsx), the deposit
 * readouts of core Results (Deposit credits on FTP, Life by family on Gap and liquidity) and the two engine terms in the
 * position drawer. Expected texts are restated here; the readout values come from a small envelope written by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FtpFamilyRow, RunResult } from "@alm/engine";
import { DEMO_CARDS, DEPOSIT_FORM_CARDS, cardFor, countWord, openOnSection, sectionFor, wordCount } from "../guided/featureDemos";
import { creditRows, fullRunoffNote, scenarioCreditTables, trancheText, walRows } from "../results/depositReadouts";
import { DepositCreditsCard, FamilyLifeCard } from "../pages/results/DepositReadouts";
import { engineTermRows } from "../pages/balance/InstrumentDrawer";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const IDS = ["funding-tenor", "desk-linear-decay", "desk-component-decay", "desk-full-beta-frozen", "desk-full-beta-shocked", "desk-credit", "desk-scenario-credit"];

describe("the S3c-1 cards", () => {
  it("are seven, kept apart from S3b-1's seven, and found by id", () => {
    expect(DEPOSIT_FORM_CARDS.map((c) => c.id)).toEqual(IDS);
    expect(DEMO_CARDS).toHaveLength(7);
    for (const id of IDS) expect(cardFor(id)?.id).toBe(id);
    expect(cardFor("seg")?.id).toBe("seg");
  });

  it("each is one plain paragraph of 60 to 90 words that names a place to look and a change, with no long dash and no outside reference", () => {
    for (const c of DEPOSIT_FORM_CARDS) {
      const n = wordCount(c.text);
      expect(n, `${c.id}: ${n} words`).toBeGreaterThanOrEqual(60);
      expect(n, `${c.id}: ${n} words`).toBeLessThanOrEqual(90);
      expect(c.text, c.id).toContain("Launch it, then open Results");
      expect(c.text, c.id).toContain("Change ");
      const all = c.text + c.title + c.look + c.notes.join(" ");
      const banned = [0x2014, 0x2013, 0xa7].map((x) => String.fromCharCode(x));
      expect(banned.some((ch) => all.includes(ch)), c.id).toBe(false);
      expect(all, c.id).not.toMatch(/Chapter \d|Table \d|Figure \d/);
    }
  });

  it("say on the card what the form cannot show", () => {
    const notes = (id: string) => cardFor(id)!.notes.join(" ");
    expect(notes("desk-component-decay")).toContain("stand aside on this run");
    expect(notes("desk-full-beta-frozen")).toContain("FTP stands aside on this run");
    expect(notes("desk-full-beta-shocked")).toContain("SEG, key-rate durations and the EVE channels are refused");
    expect(notes("desk-credit")).toContain("Base scenario only");
    expect(notes("desk-credit")).toContain("stand aside on a credit run");
    expect(notes("funding-tenor")).toContain("A store that imported version 1.1 keeps it");
    // S3c fix round: L2 (the scenario credit says NII and EVE stand aside) and L6 (the regulatory invitation's reference note).
    expect(notes("desk-scenario-credit")).toContain("Earnings (NII) and value (EVE) stand aside on this run");
    expect(notes("desk-linear-decay")).toContain("The regulatory convention follows an international standard, shown as a reference. The US has not adopted it.");
  });

  it("the shocked-level card states the direction its run shows (S3c fix round, H1)", () => {
    const c = cardFor("desk-full-beta-shocked")!;
    expect(c.text).toContain("After a rise the damper is stronger, so at +100 bp the beta falls from about 0.51 to 0.46 and the core grows from 49 to 54 percent.");
    expect(c.text).not.toMatch(/higher beta and a smaller core/);
  });
});


describe("the deposit desk's own workspace (S3f cleanup: the Home section is gone, its rule is live)", () => {
  const desk = "quillfield-deposit-desk-v1";
  it("the desk's first Open makes a workspace named Deposit desk; the bank's demos wait for the explored example", () => {
    expect(sectionFor(desk)).toEqual({ bookId: desk, title: "Deposit desk demos", makesWorkspace: "Deposit desk" });
    expect(sectionFor("mid-size-bank-v1").makesWorkspace).toBeNull();
    expect(countWord(8)).toBe("Eight");
    expect(countWord(13)).toBe("13");
  });
});

describe("Open on a section that makes its own workspace (S3c fix round, L7)", () => {
  it("a failed first Open keeps the workspace it made, and the retry reuses it instead of making a second", async () => {
    const made = { current: null as string | null };
    const created: string[] = [];
    const opened: string[] = [];
    let fail = true;
    const create = async () => { const id = `ws-deposit-desk${created.length === 0 ? "" : `-${created.length + 1}`}`; created.push(id); return id; };
    const open = async (ws: string) => { opened.push(ws); if (fail) throw new Error("save failed"); return `#/ws/${ws}/run/setups/demo-desk-credit`; };
    await expect(openOnSection({ workspaceId: null, made, create, open })).rejects.toThrow("save failed");
    fail = false;
    expect(await openOnSection({ workspaceId: null, made, create, open })).toBe("#/ws/ws-deposit-desk/run/setups/demo-desk-credit");
    expect(created).toEqual(["ws-deposit-desk"]);
    expect(opened).toEqual(["ws-deposit-desk", "ws-deposit-desk"]);
  });

  it("uses a workspace the store already lists for the book and makes none", async () => {
    const made = { current: null as string | null };
    let calls = 0;
    const href = await openOnSection({ workspaceId: "ws-listed", made, create: async () => { calls++; return "x"; }, open: async (ws) => ws });
    expect(href).toBe("ws-listed");
    expect(calls).toBe(0);
    expect(made.current).toBeNull();
  });
});

// A small envelope written by hand: one straight-line credit, one scenario credit read at two scenarios.
const tranche = (kind: "overnight" | "pillar", months: number, weight: number, rate: number) => ({ kind, months, weight, rate });
const RP_ROW = {
  familyId: "ops", side: "liability", positionCount: 1, notional: 300e6, couponInterest12: 0, ftpAccrual12: 0, margin12: 0, monthly: { balance: [], couponInterest: [], ftpAccrual: [] },
  replicatingPortfolio: { positionId: "ops-1", construction: "life-target", beta: 0, runoffMonths: 48, lifeMonths: 24.5, tranches: [tranche("pillar", 36, 0.5, 0.0378), tranche("pillar", 60, 0.5, 0.0389)], rateCredit: 0.03835, liquidityCredit: 0.003, totalCredit: 0.04135 },
} as unknown as FtpFamilyRow;
const SC_ROW = {
  familyId: "sav", side: "liability", positionCount: 1, notional: 400e6, couponInterest12: 0, ftpAccrual12: 0, margin12: 0, monthly: { balance: [], couponInterest: [], ftpAccrual: [] },
  scenarioCredit: {
    positionId: "sav-1", construction: "life-target", lifeSource: "balance-path", scenarioCurve: "shift", beta: 0, lifeMonths: 49.5, tranches: [tranche("pillar", 60, 0.37, 0.0389), tranche("pillar", 120, 0.63, 0.0426)], rateCredit: 0.04125, liquidityCredit: 0.004, totalCredit: 0.04525, liquidityLegs: [],
    byScenario: [
      { scenarioId: "S0", beta: 0, lifeMonths: 49.5, tranches: [], rateCredit: 0.04125, liquidityCredit: 0.004, totalCredit: 0.04525, liquidityLegs: [] },
      { scenarioId: "S100", beta: 0, lifeMonths: 41.25, tranches: [], rateCredit: 0.0502, liquidityCredit: 0.0037, totalCredit: 0.0539, liquidityLegs: [] },
    ],
  },
} as unknown as FtpFamilyRow;

describe("the Deposit credits card", () => {
  it("reads one row per credit, the base reading, in family order, and one table per credit read at every scenario", () => {
    const rows = creditRows([RP_ROW, { ...RP_ROW, familyId: "plain", replicatingPortfolio: undefined } as FtpFamilyRow, SC_ROW]);
    expect(rows.map((r) => [r.familyId, r.lifeSource, r.lifeMonths, r.totalCredit, r.scenarioCurve])).toEqual([["ops", "straight-line runoff", 24.5, 0.04135, null], ["sav", "balance path", 49.5, 0.04525, "shift"]]);
    expect(trancheText(tranche("overnight", 1, 0.509, 0.0371))).toBe("overnight 50.9%");
    expect(trancheText(tranche("pillar", 60, 0.5, 0.0389))).toBe("60-month pillar 50.0%");
    expect(scenarioCreditTables([RP_ROW, SC_ROW]).map((t) => [t.familyId, t.rows.length])).toEqual([["sav", 2]]);
  });

  it("renders the credits and the scenario table, and nothing on a run without one", () => {
    const html = text(renderToStaticMarkup(<DepositCreditsCard byFamily={[RP_ROW, SC_ROW]} scenarioLabel={(id) => (id === "S100" ? "+100 bp" : "Base")} />));
    expect(html).toContain("Deposit credits");
    expect(html).toContain("ops straight-line runoff, life-target 24.5 0.00 36-month pillar 50.0%; 60-month pillar 50.0% 3.8350% 0.3000% 4.1350%");
    expect(html).toContain("sav at every scenario, each re-priced on its own shifted curve");
    expect(html).toContain("+100 bp 41.3 0.00 5.0200% 0.3700% 5.3900%");
    expect(renderToStaticMarkup(<DepositCreditsCard byFamily={[{ ...RP_ROW, replicatingPortfolio: undefined } as FtpFamilyRow]} scenarioLabel={(id) => id} />)).toBe("");
  });
});

describe("the Life by family card", () => {
  const result = {
    cashflows: { byScenario: [{ scenarioId: "S0", byFamily: [{ familyId: "ops", walYears: 24.5 / 12 }, { familyId: "sav", walYears: 4.126 }, { familyId: "empty" }] }] },
    notImplemented: [{ layer: "cashflows.wal.full-runoff", reason: "walYears of sav reads the full runoff of its component decay deposits." }],
  } as unknown as RunResult;

  it("reads each stored life on the scenario, leaves out a family with none, and prints the engine's full-runoff note", () => {
    expect(walRows(result, "S0")).toEqual([{ familyId: "ops", walYears: 24.5 / 12 }, { familyId: "sav", walYears: 4.126 }]);
    expect(walRows(result, "S100")).toEqual([]);
    expect(fullRunoffNote(result)).toBe("walYears of sav reads the full runoff of its component decay deposits.");
    const html = text(renderToStaticMarkup(<FamilyLifeCard result={result} scenarioId="S0" label="Base" />));
    expect(html).toContain("Life by family, Base");
    expect(html).toContain("ops 2.04 24.5");
    expect(html).toContain("sav 4.13 49.5");
    expect(html).toContain("walYears of sav reads the full runoff");
    expect(renderToStaticMarkup(<FamilyLifeCard result={result} scenarioId="S100" label="+100" />)).toBe("");
  });
});

describe("the position drawer's engine terms", () => {
  it("shows a floater's funding tenor and an nmd's straight-line runoff, each only on the type that reads it", () => {
    expect(engineTermRows({ type: "floating-loan", fundingTenorMonths: 36 })).toEqual([{ label: "Funding tenor", value: "36 months: FTP reads the rate leg at the reset tenor and the liquidity leg here" }]);
    expect(engineTermRows({ type: "nmd", linearDecay: { horizonMonths: 48 } })).toEqual([{ label: "Straight-line runoff", value: "48 months: the same amount leaves every month" }]);
    expect(engineTermRows({ type: "fixed-loan", fundingTenorMonths: 36 })).toEqual([]);
    expect(engineTermRows({ type: "nmd-b", linearDecay: { horizonMonths: 48 } })).toEqual([]);
    expect(engineTermRows({ type: "floating-loan" })).toEqual([]);
  });
});
