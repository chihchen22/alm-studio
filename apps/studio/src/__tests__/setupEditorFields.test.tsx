// apps/studio/src/__tests__/setupEditorFields.test.tsx
/**
 * The schema 1.9.0 setup fields on the run setup editor: the NMD convention,
 * the EVE discount basis (spread-consistent now honoured), the SEG switch, the liquidity stress table (twelve rates,
 * buffer and undrawn face) and the instrument-level results switch. Rendering is checked on the markup; the round
 * trip runs the edit helpers, the reader's save and read calls, and the server's own setup gate (parseRunSetup)
 * behind a stubbed fetch, so a field the gate would drop or refuse fails here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getRunSetup, saveRunSetup, type RunSetup } from "@alm/reader";
import { parseRunSetup } from "@alm/server/src/workspaces/runSetupParse";
import { SetupEditor, type SetupEditorContext } from "../run/SetupEditor";
import {
  DEFAULT_LIQUIDITY_STRESS, draftForSave, nmdConventionOf, parseStressAmount, parseStressRate, stressAmountText, stressRateText,
  withInstrumentNode, withInstrumentSave, withLiquidityStress, withNextReset, withNmdConvention, withSeg, withStressAmount, withStressRate,
} from "../rows/setupRows";
import { LIBRARIES, SLATES, STANDARD_ALCO } from "./fixtures/setup";

const CONTEXT: SetupEditorContext = {
  defaultSetId: "example-behavioral-v1",
  setIds: ["example-behavioral-v1"],
  balancePlanIds: [],
  libraries: LIBRARIES,
  slates: SLATES,
  coaNodes: [{ id: "coa-example-loans", label: "Loans" }, { id: "coa-example-deposits", label: "Deposits" }],
};
const noop = () => {};
const render = (setup: RunSetup, over: Partial<Parameters<typeof SetupEditor>[0]> = {}) =>
  renderToStaticMarkup(
    <SetupEditor
      setup={setup} context={CONTEXT} validation={null} readiness={null} by="Chih Chen" readOnlyReason={null} busy={false}
      message={null} onBy={noop} onSave={noop} onValidate={noop} onLaunch={noop} {...over}
    />,
  );
const selectOf = (html: string, label: string): string => {
  const at = html.indexOf(`aria-label="${label}"`);
  expect(at, `no control labelled ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<select", at);
  return html.slice(start, html.indexOf("</select>", at) + 9);
};
const inputOf = (html: string, label: string): string => {
  const at = html.indexOf(`aria-label="${label}"`);
  expect(at, `no control labelled ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<input", at);
  return html.slice(start, html.indexOf(">", at) + 1);
};

/** The default table (rows/setupRows.ts DEFAULT_LIQUIDITY_STRESS) restated by hand, in percent. */
const DEFAULT_TABLE_PERCENT = {
  bau: { hys: "0.4", wholesale: "100", nib: "0.1", draw: "0" },
  moderate: { hys: "4", wholesale: "60", nib: "0.8", draw: "12" },
  severe: { hys: "8", wholesale: "20", nib: "1.5", draw: "25" },
};

/** A stored setup with a well-formed id, which the server's gate demands of `supersedes`. */
const STORED: RunSetup = { ...STANDARD_ALCO, id: "rs-00000000000000a0" };

const ARM: RunSetup = {
  ...STANDARD_ALCO,
  id: "rs-0000000000000001",
  name: "pinned-run",
  eve: { ...STANDARD_ALCO.eve, discountBasis: "spread-consistent", keyRate: true },
  instrumentResults: { save: true },
  nmdConvention: "regulatory",
  seg: { enabled: true },
  liquidityStress: DEFAULT_LIQUIDITY_STRESS,
  gap: { ...STANDARD_ALCO.gap, nextReset: true },
};

describe("the Measures tab shows the new fields", () => {
  it("offers the NMD convention with the stored value selected, and Behavioral when the field is absent", () => {
    const reg = selectOf(render(ARM), "NMD convention");
    expect(reg).toMatch(/<option value="regulatory"[^>]*selected=""/);
    expect(reg).toMatch(/<option value="behavioral"[^>]*>Behavioral/);
    const beh = selectOf(render(STANDARD_ALCO), "NMD convention");
    expect(beh).toMatch(/<option value="behavioral"[^>]*selected=""/);
    expect(beh).not.toMatch(/<option value="regulatory"[^>]*disabled/);
  });

  it("offers all three discount bases as live choices and selects the stored one", () => {
    const basis = selectOf(render(ARM), "EVE discount basis");
    for (const v of ["all-in", "risk-free", "spread-consistent"]) expect(basis).toMatch(new RegExp(`<option value="${v}"(?![^>]*disabled)`));
    expect(basis).toMatch(/<option value="spread-consistent"[^>]*selected=""/);
    expect(basis).not.toContain("reserved");
  });

  it("the SEG switch follows the setup", () => {
    expect(inputOf(render(ARM), "Compute SEG, EBP and constant-balance NII")).toContain('checked=""');
    expect(inputOf(render(STANDARD_ALCO), "Compute SEG, EBP and constant-balance NII")).not.toContain('checked=""');
  });

  it("the next-reset ladder checkbox follows gap.nextReset (Task 15)", () => {
    expect(inputOf(render(ARM), "Next reset or maturity ladder (ALCO convention)")).toContain('checked=""');
    expect(inputOf(render(STANDARD_ALCO), "Next reset or maturity ladder (ALCO convention)")).not.toContain('checked=""');
    expect(inputOf(render(ARM, { readOnlyReason: "This workspace is locked." }), "Next reset or maturity ladder (ALCO convention)")).toContain("disabled");
  });

  it("prints the stress table as twelve percent inputs plus the buffer and the undrawn face in $M", () => {
    const html = render(ARM);
    expect(DEFAULT_LIQUIDITY_STRESS.buffer).toBe(1_000_000_000);
    for (const [sc, label] of [["bau", "Business as usual"], ["moderate", "Moderate"], ["severe", "Severe"]] as const) {
      const want = DEFAULT_TABLE_PERCENT[sc];
      expect(inputOf(html, `${label}: savings pool outflow per month, percent`)).toContain(`value="${want.hys}"`);
      expect(inputOf(html, `${label}: wholesale renewal, percent`)).toContain(`value="${want.wholesale}"`);
      expect(inputOf(html, `${label}: checking pool outflow per month, percent`)).toContain(`value="${want.nib}"`);
      expect(inputOf(html, `${label}: commitment draw rate, percent`)).toContain(`value="${want.draw}"`);
    }
    expect(inputOf(html, "Liquidity buffer, $M")).toContain('value="1000"');
    expect(inputOf(html, "Undrawn commitment face, $M")).toContain('value="250"');
    expect(html.match(/aria-label="[A-Za-z ]+: [a-z -]+, percent"/g)?.length).toBe(12);
  });

  it("with the stress ladder off prints the switch and one sentence, and no table", () => {
    const html = render(STANDARD_ALCO);
    expect(inputOf(html, "Liquidity stress on")).not.toContain('checked=""');
    expect(html).toContain("Off: the run computes no liquidity stress ladder.");
    expect(html).not.toContain("Severe: wholesale renewal, percent");
  });

  it("the instrument-level switch is honoured: no reserved note, and no node ticked means every position", () => {
    const html = render(ARM);
    expect(html).not.toContain("Reserved: a later release writes the instrument-level files");
    expect(html).toContain("Saved beside the run as instruments.json, one row per position per scenario.");
    expect(html).toContain("No node ticked: every position is stored.");
  });

  it("a locked workspace disables every new control", () => {
    const html = render(ARM, { readOnlyReason: "This workspace is locked." });
    expect(inputOf(html, "Compute SEG, EBP and constant-balance NII")).toContain("disabled");
    expect(inputOf(html, "Liquidity buffer, $M")).toContain("disabled");
    expect(selectOf(html, "NMD convention")).toContain("disabled");
  });
});

describe("the edit helpers leave an absent field out", () => {
  it("behavioral removes nmdConvention, regulatory sets it", () => {
    const reg = withNmdConvention(STANDARD_ALCO, "regulatory");
    expect(nmdConventionOf(reg)).toBe("regulatory");
    const back = withNmdConvention(reg, "behavioral");
    expect("nmdConvention" in back).toBe(false);
    expect(JSON.stringify(back)).toBe(JSON.stringify(STANDARD_ALCO));
  });

  it("SEG off removes the block, on writes { enabled: true }", () => {
    const on = withSeg(STANDARD_ALCO, true);
    expect(on.seg).toEqual({ enabled: true });
    expect("seg" in withSeg(on, false)).toBe(false);
  });

  it("the next-reset switch writes gap.nextReset true and off removes the key (Task 15)", () => {
    const on = withNextReset(STANDARD_ALCO, true);
    expect(on.gap.nextReset).toBe(true);
    const off = withNextReset(on, false);
    expect("nextReset" in off.gap).toBe(false);
    expect(JSON.stringify(off)).toBe(JSON.stringify(STANDARD_ALCO));
  });

  it("the stress switch starts from the default table and off removes the block", () => {
    const on = withLiquidityStress(STANDARD_ALCO, true);
    expect(on.liquidityStress).toEqual(DEFAULT_LIQUIDITY_STRESS);
    expect("liquidityStress" in withLiquidityStress(on, false)).toBe(false);
  });

  it("the instrument switch drops an empty node list, and unticking the last node drops the list", () => {
    const on = withInstrumentSave(STANDARD_ALCO, true);
    expect(on.instrumentResults).toEqual({ save: true });
    const one = withInstrumentNode(on, "coa-example-loans", true);
    expect(one.instrumentResults).toEqual({ save: true, coaNodeIds: ["coa-example-loans"] });
    expect(withInstrumentNode(one, "coa-example-loans", false).instrumentResults).toEqual({ save: true });
  });

  it("percent and $M text round-trip without float noise, and a bad entry names the field", () => {
    for (const v of [0, 0.005, 0.0235, 0.07, 0.15, 0.3, 1]) {
      const back = parseStressRate(stressRateText(v));
      expect(back).toEqual({ value: v });
    }
    expect(stressRateText(0.07)).toBe("7");
    expect(parseStressRate("120")).toEqual({ problem: "Enter a percent from 0 to 100." });
    expect(parseStressRate("abc")).toEqual({ problem: "Enter a percent from 0 to 100." });
    expect(stressAmountText(1_250_000_000)).toBe("1250");
    expect(parseStressAmount("1250.5")).toEqual({ value: 1_250_500_000 });
    expect(parseStressAmount("-1")).toEqual({ problem: "Enter an amount in $M, zero or more." });
  });
});

describe("every new field round-trips through the reader, the server gate and back", () => {
  const stored = new Map<string, unknown>();
  function stubServer() {
    stored.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const ok = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/run-setups") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { setup: unknown };
        const parsed = parseRunSetup(body.setup);
        const doc = { id: "rs-00000000000000aa", ...parsed };
        stored.set(doc.id, doc);
        return ok({ setup: doc, manifest: {} }, 201);
      }
      const m = /\/api\/run-setups\/([^/?]+)$/.exec(url);
      if (m !== null && stored.has(m[1]!)) return ok(stored.get(m[1]!));
      return ok({ error: { code: "not-found", message: `no fixture for ${url}` } }, 404);
    }));
  }
  afterEach(() => vi.unstubAllGlobals());

  it("nmdConvention, discountBasis, seg, liquidityStress and instrumentResults.save come back as they went", async () => {
    stubServer();
    let s: RunSetup = STORED;
    s = withNmdConvention(s, "regulatory");
    s = { ...s, eve: { ...s.eve, discountBasis: "spread-consistent" } };
    s = withSeg(s, true);
    s = withLiquidityStress(s, true);
    s = withStressRate(s, "severe", "drawRate", 0.25);
    s = withStressRate(s, "moderate", "hysOutflowMonthly", 0.0235);
    s = withStressAmount(s, "buffer", 2_000_500_000);
    s = withStressAmount(s, "undrawnFace", 400_000_000);
    s = withInstrumentSave(s, true);
    s = withNextReset(s, true);
    const draft = draftForSave(STORED, s);
    const reply = await saveRunSetup({ workspaceId: "ws-a", setupLineageId: "arm", expectedRevision: 1, by: "Chih Chen", setup: draft });
    const back = await getRunSetup(reply.setup.id);
    expect(back.nmdConvention).toBe("regulatory");
    expect(back.eve.discountBasis).toBe("spread-consistent");
    expect(back.seg).toEqual({ enabled: true });
    expect(back.liquidityStress?.table.severe.drawRate).toBe(0.25);
    expect(back.liquidityStress?.table.moderate.hysOutflowMonthly).toBe(0.0235);
    expect(back.liquidityStress?.table.bau).toEqual(DEFAULT_LIQUIDITY_STRESS.table.bau);
    expect(back.liquidityStress?.buffer).toBe(2_000_500_000);
    expect(back.liquidityStress?.undrawnFace).toBe(400_000_000);
    expect(back.instrumentResults).toEqual({ save: true });
    expect(back.gap.nextReset).toBe(true);
    // The editor reads the stored copy back into the same controls.
    const html = render(back);
    expect(inputOf(html, "Severe: commitment draw rate, percent")).toContain('value="25"');
    expect(inputOf(html, "Moderate: savings pool outflow per month, percent")).toContain('value="2.35"');
    expect(inputOf(html, "Liquidity buffer, $M")).toContain('value="2000.5"');
    expect(inputOf(html, "Next reset or maturity ladder (ALCO convention)")).toContain('checked=""');
  });

  it("a setup with none of the new fields saves without them", async () => {
    stubServer();
    const reply = await saveRunSetup({ workspaceId: "ws-a", setupLineageId: "plain", expectedRevision: 1, by: "Chih Chen", setup: draftForSave(STORED, STORED) });
    const back = await getRunSetup(reply.setup.id);
    for (const k of ["nmdConvention", "seg", "liquidityStress"]) expect(k in back).toBe(false);
    expect("nextReset" in back.gap).toBe(false);
  });

  it("the server gate refuses a stress rate above 100 percent in a sentence, so the editor never sends one", () => {
    const bad = withStressRate(withLiquidityStress(STANDARD_ALCO, true), "bau", "drawRate", 1.5);
    expect(() => parseRunSetup(draftForSave(STORED, bad))).toThrow(/drawRate/);
    expect(parseStressRate("150")).toEqual({ problem: "Enter a percent from 0 to 100." });
  });
});
