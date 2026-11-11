// apps/studio/src/__tests__/segKnobs.test.tsx
/**
 * The SEG knobs on the setup editor. The knobs read the engine default until a setup names
 * one, typing the default back removes the key, and a setup with the knobs passes the server's own setup gate.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SEG_DEFAULTS, SEG_MAX_HORIZON_MONTHS, SEG_MAX_NII_SHOCK_BP, SEG_MAX_SHOCK_BP } from "@alm/engine";
import type { RunSetup } from "@alm/reader";
import { parseRunSetup } from "@alm/server/src/workspaces/runSetupParse";
import { SetupEditor, type SetupEditorContext } from "../run/SetupEditor";
import { SEG_KNOBS, SEG_KNOB_DEFAULTS, parseSegKnob, segKnobText, segOverlayLines, withSeg, withSegKnob } from "../rows/setupRows";
import { LIBRARIES, SLATES, STANDARD_ALCO } from "./fixtures/setup";

const CONTEXT: SetupEditorContext = { defaultSetId: "s", setIds: ["s"], balancePlanIds: [], libraries: LIBRARIES, slates: SLATES, coaNodes: [] };
const noop = () => {};
const render = (setup: RunSetup) =>
  renderToStaticMarkup(
    <SetupEditor
      setup={setup} context={CONTEXT} validation={null} readiness={null} by="Chih Chen" readOnlyReason={null} busy={false}
      message={null} onBy={noop} onSave={noop} onValidate={noop} onLaunch={noop}
    />,
  );
const inputOf = (html: string, label: string): string | null => {
  const at = html.indexOf(`aria-label="${label}"`);
  if (at < 0) return null;
  return html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at) + 1);
};

const SEG_ON: RunSetup = { ...STANDARD_ALCO, id: "rs-00000000000000c2", seg: { enabled: true } };
const BOOK: RunSetup = {
  ...SEG_ON,
  seg: { enabled: true, shockBp: 25, horizonMonths: 720, cprOverlay: [{ familyId: "mortgage-behavioral", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] },
};

describe("the SEG knobs", () => {
  it("restate the engine's defaults and bounds", () => {
    expect(SEG_KNOB_DEFAULTS).toEqual({ shockBp: SEG_DEFAULTS.shockBp, horizonMonths: SEG_DEFAULTS.horizonMonths, niiShockBp: SEG_DEFAULTS.niiShockBp });
    expect(SEG_KNOBS.map((k) => k.max)).toEqual([SEG_MAX_SHOCK_BP, SEG_MAX_HORIZON_MONTHS, SEG_MAX_NII_SHOCK_BP]);
  });

  it("show only while the SEG block is on, at the default or the setup's value", () => {
    expect(inputOf(render(STANDARD_ALCO), "SEG shock, bp")).toBeNull();
    expect(inputOf(render(SEG_ON), "SEG shock, bp")).toContain('value="10"');
    expect(inputOf(render(SEG_ON), "SEG horizon, months")).toContain('value="60"');
    expect(inputOf(render(SEG_ON), "Constant-balance NII shock, bp")).toContain('value="200"');
    const html = render(BOOK);
    expect(inputOf(html, "SEG shock, bp")).toContain('value="25"');
    expect(inputOf(html, "SEG horizon, months")).toContain('value="720"');
    expect(html).toContain("Cohort-0 prepayment overlay, mortgage-behavioral: cohort 0 at 9% CPR under the up shock and 14% under the down shock");
  });

  it("parse within the engine's bounds and say why otherwise", () => {
    expect(parseSegKnob("shockBp", "25")).toEqual({ value: 25 });
    expect(parseSegKnob("shockBp", "0")).toHaveProperty("problem");
    expect(parseSegKnob("horizonMonths", "720")).toEqual({ value: 720 });
    expect(parseSegKnob("horizonMonths", "60.5")).toHaveProperty("problem");
    expect(parseSegKnob("niiShockBp", "501")).toHaveProperty("problem");
  });

  it("the default removes the key, a setup with the knobs passes the server gate, and switching SEG off drops them", () => {
    expect(withSegKnob(withSegKnob(SEG_ON, "shockBp", 25), "shockBp", 10).seg).toEqual({ enabled: true });
    const edited = withSegKnob(withSegKnob(SEG_ON, "horizonMonths", 720), "shockBp", 25);
    expect(segKnobText(edited, "shockBp")).toBe("25");
    const { id: _id, ...body } = edited;
    expect(parseRunSetup(JSON.parse(JSON.stringify(body))).seg).toEqual({ enabled: true, shockBp: 25, horizonMonths: 720 });
    expect(withSeg(BOOK, false).seg).toBeUndefined();
    expect(segOverlayLines(SEG_ON)).toEqual([]);
  });
});
