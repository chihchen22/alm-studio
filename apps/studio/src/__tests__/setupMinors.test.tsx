/**
 * Final review minors m10 and m11 on the run setup editor, moved by slice three (decisions 108, 109 and 112): the
 * bucket and interval choices the run now honours carry plain labels, principal plus interest (still reserved) keeps
 * its text, the liquidity switch off says the nine bands still show, and a disabled scenario-source radio says why.
 * Expected labels are restated here by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSetup } from "@alm/reader";
import { SetupEditor, type SetupEditorContext } from "../run/SetupEditor";
import { GAP_BUCKET_CHOICES, LIQUIDITY_FLOW_CHOICES, LIQUIDITY_INTERVAL_CHOICES } from "../rows/setupRows";
import { LIBRARIES, STANDARD_ALCO } from "./fixtures/setup";

const labelOf = (choices: ReadonlyArray<{ value: string; label: string }>, value: string) => choices.find((c) => c.value === value)!.label;

describe("the honoured bucket choices carry plain labels (slice three decisions 107, 108 and 112)", () => {
  it("monthly and custom edges, and the custom liquidity interval, say what they are and nothing interim", () => {
    expect(labelOf(GAP_BUCKET_CHOICES, "monthly")).toBe("Monthly");
    expect(labelOf(GAP_BUCKET_CHOICES, "custom")).toBe("Custom edges");
    expect(labelOf(LIQUIDITY_INTERVAL_CHOICES, "monthly")).toBe("Monthly");
    expect(labelOf(LIQUIDITY_INTERVAL_CHOICES, "custom-months")).toBe("Custom interval in months");
    for (const c of [...GAP_BUCKET_CHOICES, ...LIQUIDITY_INTERVAL_CHOICES]) {
      expect(c.label, c.value).not.toMatch(/interim|piece [A-Z]\d?\b/);
    }
  });

  it("principal plus interest is honoured: its label drops the interim text", () => {
    expect(labelOf(LIQUIDITY_FLOW_CHOICES, "principal-plus-interest")).toBe("Principal plus interest");
    for (const c of LIQUIDITY_FLOW_CHOICES) expect(c.label, c.value).not.toMatch(/interim|piece [A-Z]\d?\b/);
  });
});

describe("the liquidity card notes (decisions 108 and 109)", () => {
  const context: SetupEditorContext = { defaultSetId: null, setIds: [], balancePlanIds: [], libraries: LIBRARIES, slates: [], coaNodes: [] };
  const noop = () => {};
  const render = (setup: RunSetup) =>
    renderToStaticMarkup(
      <SetupEditor setup={setup} context={context} tab="measures" validation={null} readiness={null} by="" readOnlyReason={null} busy={false} message={null} onBy={noop} onSave={noop} onValidate={noop} onLaunch={noop} />,
    );
  const OFF_SENTENCE = "The nine standard bands still show.";

  it("the reserved note names only what is still reserved", () => {
    const html = render(STANDARD_ALCO);
    // Principal plus interest is honoured; a daily interval is not offered (S2a fix round 1, L5).
    expect(html).toContain("Principal plus interest adds an interest-inclusive ladder in Results beside the principal one. A daily interval is not offered: the cash flow grid is monthly.");
    expect(html).not.toContain("Results show principal only");
    expect(html).not.toContain("Until a later release");
    expect(html).not.toContain("interim view");
  });

  it("the liquidity switch off says, once, that the nine standard bands still show; on, it says nothing of the kind", () => {
    expect(render(STANDARD_ALCO)).not.toContain(OFF_SENTENCE);
    const off = render({ ...STANDARD_ALCO, gap: { ...STANDARD_ALCO.gap, liquidity: { ...STANDARD_ALCO.gap.liquidity, enabled: false } } });
    expect(off.split(OFF_SENTENCE).length - 1).toBe(1);
    expect(off).toMatch(/aria-label="Liquidity gap on"(?![^>]*checked)[^>]*>/);
  });
});

describe("the gap bucket labels fit a select (Part 2 D15)", () => {
  it("each is 28 characters or fewer and the values are unchanged", () => {
    expect(GAP_BUCKET_CHOICES.map((c) => c.value)).toEqual(["monthly", "standard", "custom", "finer"]);
    expect(GAP_BUCKET_CHOICES.map((c) => c.label)).toEqual(["Monthly", "Nine standard bands", "Custom edges", "Finer (grid is monthly)"]);
    for (const c of GAP_BUCKET_CHOICES) expect(c.label.length).toBeLessThanOrEqual(28);
  });
});

describe("the liquidity interval offers the nine standard bands (slice three decision 108)", () => {
  it("the values are monthly, standard, custom-months and daily, and standard reads Nine standard bands", () => {
    expect(LIQUIDITY_INTERVAL_CHOICES.map((c) => c.value)).toEqual(["monthly", "standard", "custom-months", "daily"]);
    expect(labelOf(LIQUIDITY_INTERVAL_CHOICES, "standard")).toBe("Nine standard bands");
  });

  it("a setup whose liquidity interval is standard renders that choice selected, never Monthly", () => {
    const context: SetupEditorContext = { defaultSetId: null, setIds: [], balancePlanIds: [], libraries: LIBRARIES, slates: [], coaNodes: [] };
    const noop = () => {};
    const setup = { ...STANDARD_ALCO, gap: { ...STANDARD_ALCO.gap, liquidity: { ...STANDARD_ALCO.gap.liquidity, interval: { kind: "standard" as const } } } };
    const html = renderToStaticMarkup(
      <SetupEditor setup={setup} context={context} tab="measures" validation={null} readiness={null} by="" readOnlyReason={null} busy={false} message={null} onBy={noop} onSave={noop} onValidate={noop} onLaunch={noop} />,
    );
    expect(html).toContain('<option value="standard" selected="">Nine standard bands</option>');
  });
});

describe("disabled scenario sources say why (m11)", () => {
  it("no slate attached and a setup not imported from a plan", () => {
    const context: SetupEditorContext = { defaultSetId: null, setIds: [], balancePlanIds: [], libraries: LIBRARIES, slates: [], coaNodes: [] };
    const noop = () => {};
    const html = renderToStaticMarkup(
      <SetupEditor setup={STANDARD_ALCO} context={context} tab="scenarios" validation={null} readiness={null} by="" readOnlyReason={null} busy={false} message={null} onBy={noop} onSave={noop} onValidate={noop} onLaunch={noop} />,
    );
    expect(html).toContain("(no slate is attached: attach one on Run &gt; Scenario library)");
    expect(html).toContain("(only a setup imported from a plan carries its list)");
  });
});
