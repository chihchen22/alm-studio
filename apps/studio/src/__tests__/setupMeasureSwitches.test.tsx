/**
 * The measure switches and the NII fields of the run setup editor (final review M8 and M9, moved by slice three
 * decisions 115 to 118 and 120 to 122). NII, EVE and gap always run (the engine cannot skip them), so their switches
 * are shown on and disabled with "Always runs." and a saved draft never carries one switched off. The FTP switch is
 * honoured: it is editable and a saved draft keeps FTP off. The default NII window and the report horizons are
 * editable, with the server parser's rules restated client side. Expected texts are restated here by hand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getRunSetup, saveRunSetup, type RunSetup } from "@alm/reader";
import { parseRunSetup } from "@alm/server/src/workspaces/runSetupParse";
import { SetupEditor, type SetupEditorContext } from "../run/SetupEditor";
import { draftForSave, horizonProblem, parseReportHorizons } from "../rows/setupRows";
import { LIBRARIES, SLATES, STANDARD_ALCO } from "./fixtures/setup";

const CONTEXT: SetupEditorContext = {
  defaultSetId: "demo-behavioral-v1",
  setIds: ["demo-behavioral-v1"],
  balancePlanIds: [],
  libraries: LIBRARIES,
  slates: SLATES,
  coaNodes: [],
};

const noop = () => {};
const render = (setup: RunSetup, readOnlyReason: string | null = null) =>
  renderToStaticMarkup(
    <SetupEditor setup={setup} context={CONTEXT} validation={null} readiness={null} by="Chih Chen" readOnlyReason={readOnlyReason} busy={false} message={null} onBy={noop} onSave={noop} onValidate={noop} onLaunch={noop} />,
  );

/** A stored setup with all four measures switched off, as an imported or hand-written document may carry. */
const ALL_OFF: RunSetup = {
  ...STANDARD_ALCO,
  nii: { ...STANDARD_ALCO.nii, enabled: false },
  eve: { ...STANDARD_ALCO.eve, enabled: false },
  gap: { ...STANDARD_ALCO.gap, enabled: false },
  ftp: { enabled: false },
};

/** A stored setup with a well-formed id, which the server's gate demands of `supersedes`. */
const STORED: RunSetup = { ...STANDARD_ALCO, id: "rs-00000000000000a0" };

const inputOf = (html: string, label: string): string => {
  const at = html.indexOf(`aria-label="${label}"`);
  expect(at, `no control labelled ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<input", at);
  return html.slice(start, html.indexOf(">", at) + 1);
};

/** The markup from a control's input to the end of its label: the field's own help lines. */
const fieldOf = (html: string, label: string): string => {
  const at = html.indexOf(`aria-label="${label}"`);
  expect(at, `no control labelled ${label}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<label", at), html.indexOf("</label>", at) + 8);
};

const count = (html: string, text: string) => html.split(text).length - 1;

describe("NII, EVE and gap switches (decision 120)", () => {
  it("each is checked and disabled on an editable setup, even when the stored one is off", () => {
    const html = render(ALL_OFF);
    for (const sw of ["NII on", "EVE on", "Gap on"]) {
      const input = inputOf(html, sw);
      expect(input, sw).toContain('checked=""');
      expect(input, sw).toContain('disabled=""');
    }
  });

  it('each reads "Always runs.", and the old a later release sentence is gone', () => {
    const html = render(STANDARD_ALCO);
    expect(count(html, "Always runs.")).toBe(3);
    for (const sw of ["NII on", "EVE on", "Gap on"]) expect(fieldOf(html, sw), sw).toContain("Always runs.");
    expect(html).not.toContain("Measure selection arrives with a later release");
    expect(html).not.toContain("all measures run");
    expect(html).not.toContain("switched off is hidden in Results");
  });

  it("a saved draft carries NII, EVE and gap on", () => {
    const out = draftForSave(ALL_OFF, ALL_OFF);
    expect([out.nii.enabled, out.eve.enabled, out.gap.enabled]).toEqual([true, true, true]);
  });
});

describe("the FTP switch (decisions 121 and 122)", () => {
  it("is editable, reads the stored state, and does not say Always runs.", () => {
    const on = render(STANDARD_ALCO);
    expect(inputOf(on, "FTP on")).toContain('checked=""');
    expect(inputOf(on, "FTP on")).not.toContain("disabled");
    expect(fieldOf(on, "FTP on")).not.toContain("Always runs.");
    expect(on).toContain("FTP runs on the base scenario only.");
    const off = render({ ...STANDARD_ALCO, ftp: { enabled: false } });
    expect(inputOf(off, "FTP on")).not.toContain("checked");
    expect(inputOf(off, "FTP on")).not.toContain("disabled");
    expect(off).toContain("Off: the run computes no FTP and carries no FTP block.");
    expect(off).not.toContain("FTP runs on the base scenario only.");
  });

  it("is disabled on a locked workspace", () => {
    expect(inputOf(render(STANDARD_ALCO, "This workspace is locked."), "FTP on")).toContain('disabled=""');
  });

  it("a saved draft keeps FTP off, and FTP on stays on", () => {
    expect(draftForSave(ALL_OFF, ALL_OFF).ftp).toEqual({ enabled: false });
    expect(draftForSave(STANDARD_ALCO, STANDARD_ALCO).ftp).toEqual({ enabled: true });
  });
});

describe("the default NII window (decision 118)", () => {
  it("is enabled with a real label and its help, the stored months shown", () => {
    const html = render({ ...STANDARD_ALCO, nii: { ...STANDARD_ALCO.nii, horizonMonths: 36 } });
    expect(html).toContain("Default NII window, months");
    const input = inputOf(html, "NII horizon in months");
    expect(input).toContain('value="36"');
    expect(input).not.toContain("disabled");
    expect(fieldOf(html, "NII horizon in months")).toContain("Results &gt; NII opens on this window. Default 60 months.");
    expect(html).not.toContain("Default NII window (reserved");
    expect(html).not.toContain("Results show 60 months until a later release");
  });

  it("is disabled on a locked workspace", () => {
    expect(inputOf(render(STANDARD_ALCO, "This workspace is locked."), "NII horizon in months")).toContain('disabled=""');
  });

  it("reads 12 to the grid as the server parser does, and refuses the rest", () => {
    for (const ok of ["12", "36", "60", "360"]) expect(horizonProblem(ok, 360), ok).toBeNull();
    const why = "The NII window is a whole number of months from 12 to 360.";
    for (const bad of ["", " ", "11", "0", "-12", "36.5", "361", "abc"]) expect(horizonProblem(bad, 360), JSON.stringify(bad)).toBe(why);
    expect(horizonProblem("120", 60)).toBe("The NII window is a whole number of months from 12 to 60.");
  });
});

describe("the NII report horizons (decisions 115 to 117)", () => {
  it("are an editable field showing the stored list, with the FTP bridge sentence", () => {
    const html = render(STANDARD_ALCO);
    expect(html).toContain("Report horizons, months");
    const input = inputOf(html, "NII report horizons in months");
    expect(input).toContain('value="12, 24, 60"');
    expect(input).not.toContain("disabled");
    const field = fieldOf(html, "NII report horizons in months");
    expect(field).toContain("Results &gt; NII sums net interest income to each of these months.");
    expect(field).toContain("The FTP bridge to NII stays at 12 months whatever this list says.");
    expect(html).not.toContain("A different list is reserved");
  });

  it("are disabled on a locked workspace", () => {
    expect(inputOf(render(STANDARD_ALCO, "This workspace is locked."), "NII report horizons in months")).toContain('disabled=""');
  });

  it("accept a non-empty, whole, strictly rising list within the grid, commas or spaces", () => {
    expect(parseReportHorizons("12, 24, 60", 360)).toEqual({ horizons: [12, 24, 60], problem: null });
    expect(parseReportHorizons("1 12  360", 360)).toEqual({ horizons: [1, 12, 360], problem: null });
    expect(parseReportHorizons("36", 360)).toEqual({ horizons: [36], problem: null });
  });

  it("refuse each input the server parser refuses, in words", () => {
    const cases: Array<[string, string]> = [
      ["", "Name at least one report horizon, in months."],
      [" , ", "Name at least one report horizon, in months."],
      ["12, 0", "Report horizons are whole months from 1."],
      ["-12", "Report horizons are whole months from 1."],
      ["12, 24.5", "Report horizons are whole months from 1."],
      ["12, x", "Report horizons are whole months from 1."],
      ["12, 361", "Report horizon 361 is beyond the 360-month grid."],
      ["24, 12", "Report horizons must rise: 12 does not follow 24."],
      ["12, 12", "Report horizons must rise: 12 does not follow 12."],
    ];
    for (const [text, problem] of cases) expect(parseReportHorizons(text, 360).problem, JSON.stringify(text)).toBe(problem);
  });

  it("the server parser refuses the same lists the field refuses, and takes the ones it accepts", () => {
    const withList = (reportHorizons: number[]) => draftForSave(STORED, { ...STORED, nii: { ...STORED.nii, reportHorizons } });
    for (const bad of [[], [12, 0], [12, 24.5], [12, 361], [24, 12], [12, 12]]) {
      expect(() => parseRunSetup(withList(bad)), JSON.stringify(bad)).toThrow(/nii\.reportHorizons/);
    }
    for (const good of [[12, 24, 60], [1, 12, 360], [36]]) expect(parseRunSetup(withList(good)).nii.reportHorizons).toEqual(good);
    const withWindow = (horizonMonths: number) => draftForSave(STORED, { ...STORED, nii: { ...STORED.nii, horizonMonths } });
    for (const bad of [11, 361]) expect(() => parseRunSetup(withWindow(bad)), String(bad)).toThrow(/nii\.horizonMonths/);
    for (const good of [12, 36, 360]) expect(parseRunSetup(withWindow(good)).nii.horizonMonths).toBe(good);
  });
});

describe("the unlocked controls round-trip through the reader, the server gate and back", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("FTP off, a 36-month window and the list [12, 36, 120] come back as they went and show in the editor", async () => {
    const stored = new Map<string, unknown>();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const ok = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/run-setups") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { setup: unknown };
        const doc = { id: "rs-00000000000000ab", ...parseRunSetup(body.setup) };
        stored.set(doc.id, doc);
        return ok({ setup: doc, manifest: {} }, 201);
      }
      const m = /\/api\/run-setups\/([^/?]+)$/.exec(url);
      if (m !== null && stored.has(m[1]!)) return ok(stored.get(m[1]!));
      return ok({ error: { code: "not-found", message: `no fixture for ${url}` } }, 404);
    }));
    const edited: RunSetup = { ...STORED, ftp: { enabled: false }, nii: { ...STORED.nii, horizonMonths: 36, reportHorizons: [12, 36, 120] } };
    const reply = await saveRunSetup({ workspaceId: "ws-a", setupLineageId: "arm", expectedRevision: 1, by: "Chih Chen", setup: draftForSave(STORED, edited) });
    const back = await getRunSetup(reply.setup.id);
    expect(back.ftp).toEqual({ enabled: false });
    expect(back.nii.horizonMonths).toBe(36);
    expect(back.nii.reportHorizons).toEqual([12, 36, 120]);
    expect([back.nii.enabled, back.eve.enabled, back.gap.enabled]).toEqual([true, true, true]);
    const html = render(back);
    expect(inputOf(html, "FTP on")).not.toContain("checked");
    expect(inputOf(html, "NII horizon in months")).toContain('value="36"');
    expect(inputOf(html, "NII report horizons in months")).toContain('value="12, 36, 120"');
  });
});
