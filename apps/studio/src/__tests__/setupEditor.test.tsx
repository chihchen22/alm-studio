// apps/studio/src/__tests__/setupEditor.test.tsx
/**
 * The run setup editor (spec v3.1 Section 5.2). Separate NII, EVE and gap settings; the basis control with
 * its honest labels; reserved controls disabled with the piece that will honour them; scenario sources; batch rows.
 * Every expected text is restated here from the spec, not imported from the code under test.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupEditor, type SetupEditorContext } from "../run/SetupEditor";
import { marketInputChoices } from "../rows/setupRows";
import { CUSTOM_SETUP, ITEMS, LIBRARIES, RUNOFF_SETUP, SLATES, STANDARD_ALCO, VALIDATION_WARN } from "./fixtures/setup";
import { HEAD } from "./fixtures/workspace";

const CONTEXT: SetupEditorContext = {
  defaultSetId: "demo-behavioral-v1",
  setIds: ["demo-behavioral-v1", "loan-repricing-demo-v1"],
  balancePlanIds: ["balance-targets-demo-v1"],
  libraries: LIBRARIES,
  slates: SLATES,
  coaNodes: [{ id: "coa-assets", label: "Assets" }, { id: "coa-deposits", label: "Deposits" }],
};

const noop = () => {};
const render = (over: Partial<Parameters<typeof SetupEditor>[0]> = {}) =>
  renderToStaticMarkup(
    <SetupEditor
      setup={STANDARD_ALCO}
      context={CONTEXT}
      validation={null}
      readiness={null}
      by="Chih Chen"
      readOnlyReason={null}
      busy={false}
      message={null}
      onBy={noop}
      onSave={noop}
      onValidate={noop}
      onLaunch={noop}
      {...over}
    />,
  );

const selectOf = (html: string, label: string): string => {
  const at = html.indexOf(`aria-label="${label}"`);
  expect(at, `no control labelled ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<select", at);
  return html.slice(start, html.indexOf("</select>", at) + 9);
};

describe("Measures tab", () => {
  it("is the first tab, with the four tabs in order", () => {
    const html = render();
    const order = ["Measures", "Scenarios", "Path", "Batch"].map((t) => html.indexOf(`>${t}</button>`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/aria-selected="true"[^>]*>Measures</);
  });

  it("keeps NII, EVE and gap as three separate settings cards, each with its own on switch", () => {
    const html = render();
    for (const card of ["NII settings", "EVE settings", "Gap settings"]) expect(html).toContain(`aria-label="${card}"`);
    for (const sw of ["NII on", "EVE on", "Gap on", "FTP on"]) expect(html).toContain(`aria-label="${sw}"`);
    expect(html.indexOf('aria-label="NII settings"')).toBeLessThan(html.indexOf('aria-label="EVE settings"'));
    expect(html.indexOf('aria-label="EVE settings"')).toBeLessThan(html.indexOf('aria-label="Gap settings"'));
  });

  it("NII horizon defaults to 60 months and the report horizons read 12, 24, 60", () => {
    const html = render();
    expect(html).toMatch(/aria-label="NII horizon in months"[^>]*value="60"/);
    expect(html).toContain("12, 24, 60");
  });

  it("offers the three bases in order with the exact copy, Flat selected", () => {
    const html = render();
    const flat = html.indexOf("Flat (default): balances held at opening, 60-month fixed bullets at the par swap rate");
    const runoff = html.indexOf("Runoff (no new business)");
    const custom = html.indexOf("Custom dynamic (targets per family or strategic node)");
    expect(flat).toBeGreaterThan(-1);
    expect(runoff).toBeGreaterThan(flat);
    expect(custom).toBeGreaterThan(runoff);
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked=""[^>]*value="flat"/);
  });

  it("Flat carries the honest standing note; Runoff and Custom carry their own and drop it", () => {
    const flat = render();
    expect(flat).toContain("Simple top-up, not like-for-like: a maturing 5/1 ARM or a decaying deposit is replaced by a 60-month fixed bullet at the par swap rate.");
    expect(flat).toContain("A family whose setup carries a new-volume product (set on the Analysis path&#x27;s New volume step) is topped up with that product instead.");
    expect(flat).toContain("Families skipped: derivative families and any family with no positive opening balance; the validation report lists them.");
    const runoff = render({ setup: RUNOFF_SETUP });
    expect(runoff).toContain("Runoff: balances decay as the book runs off; a 60-month NII on this basis falls mechanically.");
    expect(runoff).not.toContain("Simple top-up");
    const custom = render({ setup: CUSTOM_SETUP });
    expect(custom).not.toContain("Simple top-up");
    expect(custom).toContain("balance-targets-demo-v1");
    expect(custom).toContain("Custom dynamic");
  });

  it("the Custom choice is switched off, with its reason, when the targets block holds no balance plan", () => {
    const html = render({ context: { ...CONTEXT, balancePlanIds: [] } });
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*disabled=""[^>]*value="custom"/);
    expect(html).toContain("Attach a balance plan under Balance Sheet, Strategy to run a custom dynamic basis.");
  });

  it("the assumption set control offers the workspace default first, then the block's sets", () => {
    const sel = selectOf(render(), "Assumption set");
    const options = [...sel.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
    expect(options).toEqual(["Workspace default (demo-behavioral-v1)", "demo-behavioral-v1", "loan-repricing-demo-v1"]);
  });

  it("an imported list of several sets is kept, not silently replaced", () => {
    const html = render({ setup: { ...STANDARD_ALCO, inputs: { ...STANDARD_ALCO.inputs, assumptionSetIds: ["a-set", "b-set"] } } });
    expect(html).toContain("Keep the imported list (2 sets)");
  });

  it("EVE defaults to the all-in basis, honours the other two, and hides the later valuation dates it does not run", () => {
    const html = render();
    const dates = selectOf(html, "EVE valuation dates");
    expect(dates).toMatch(/<option value="as-of"[^>]*selected=""[^>]*>As of the grid date \(default\)</);
    for (const value of ["every-nii-date", "every-12-months", "custom"]) expect(dates).not.toContain(`value="${value}"`);
    expect(dates).not.toContain("reserved");
    const basis = selectOf(html, "EVE discount basis");
    expect(basis).toMatch(/<option value="all-in"[^>]*selected=""/);
    // The server honours all three bases now, so none is reserved.
    expect(basis).toMatch(/<option value="risk-free"(?![^>]*disabled)[^>]*>Risk-free/);
    expect(basis).toMatch(/<option value="spread-consistent"(?![^>]*disabled)[^>]*>Spread-consistent/);
  });

  it("the gap card defaults to monthly buckets, plainly labelled, and never offers a finer one", () => {
    const html = render();
    const sel = selectOf(html, "Repricing gap bucket size");
    expect(sel).toMatch(/<option value="monthly"[^>]*selected=""[^>]*>Monthly</);
    expect(sel).toMatch(/<option value="standard"[^>]*>Nine standard bands</);
    expect(sel).toMatch(/<option value="custom"[^>]*>Custom edges</);
    expect(sel).not.toContain("interim");
    // A finer bucket than the monthly grid is not offered at all (hidden, not greyed).
    expect(sel).not.toContain('value="finer"');
  });

  it("custom bucket edges show a field with the whole-month rule", () => {
    const html = render({ setup: { ...STANDARD_ALCO, gap: { ...STANDARD_ALCO.gap, repricingBuckets: { kind: "custom", edgesMonths: [3, 6, 12, 24] } } } });
    expect(html).toMatch(/aria-label="Bucket edges in months"[^>]*value="3, 6, 12, 24"/);
    expect(html).toContain("whole months");
  });

  it("the liquidity gap offers principal only against principal plus interest, and an interval", () => {
    const html = render();
    const flows = selectOf(html, "Liquidity gap flows");
    expect(flows).toMatch(/<option value="principal"[^>]*selected=""[^>]*>Principal only</);
    // Honoured, so the interim text is gone.
    expect(flows).toMatch(/<option value="principal-plus-interest"[^>]*>Principal plus interest</);
    expect(flows).not.toContain("interim");
    const interval = selectOf(html, "Liquidity gap interval");
    expect(interval).toMatch(/<option value="monthly"[^>]*selected=""[^>]*>Monthly</);
    expect(interval).toMatch(/<option value="standard"[^>]*>Nine standard bands</);
    expect(interval).toMatch(/<option value="custom-months"[^>]*>Custom interval in months</);
    expect(interval).not.toContain("interim");
    expect(interval).not.toContain('value="daily"');
  });

  // RE-EXPECTATION: the fixed-rate ladder is honoured, so its control is live and off by default.
  it("the fixed-rate ladder is a live control, off by default, that names what it ladders", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="Fixed-rate gap ladder"[^>]*type="checkbox"/);
    expect(html).not.toMatch(/aria-label="Fixed-rate gap ladder"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Fixed-rate gap ladder"[^>]*checked=""/);
    expect(html).toContain("Fixed-rate gap ladder (rate-locked principal by payment month)");
  });

  it("instrument-level results are off by default, with no node selected", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*aria-label="Save instrument-level results"[^>]*type="checkbox"/);
    expect(html).not.toMatch(/aria-label="Save instrument-level results"[^>]*checked=""/);
    expect(html).toContain("Off: nothing is stored at instrument level.");
    expect(html).not.toContain('aria-label="Chart of account nodes to store"');
  });

  it("with the save on, selection is node-scoped: one checkbox per chart of account node, the chosen ones ticked", () => {
    const html = render({ setup: { ...STANDARD_ALCO, instrumentResults: { save: true, coaNodeIds: ["coa-deposits"] } } });
    expect(html).toContain('aria-label="Chart of account nodes to store"');
    expect(html).toMatch(/aria-label="Store instrument results for Deposits"[^>]*checked=""/);
    expect(html).not.toMatch(/aria-label="Store instrument results for Assets"[^>]*checked=""/);
    expect(html).toContain("Saved beside the run as instruments.json, one row per position per scenario.");
  });

  it("the summary strip prints the validation's basis label, outcome and skipped families beside the compiled chain", () => {
    const html = render({ validation: VALIDATION_WARN });
    expect(html).toContain("Flat (simple top-up)");
    expect(html).toContain("Validated with warnings");
    expect(html).toContain("NII basis");
    expect(html).toContain("swaps, preferred");
    expect(html).toContain("st-balance");
    expect(html).toContain("Read-only");
  });

  it("with no validation in this session and none stored the strip says Not validated yet and prints no basis label", () => {
    const html = render({ history: [] });
    expect(html).toContain("Not validated yet.");
    expect(html).toContain("Validate to compile the setup, check the gates and label the basis.");
    expect(html).not.toContain("Not validated in this session");
    expect(html).not.toContain("Validated earlier");
    expect(html).not.toContain("Flat (simple top-up)");
  });

  it("before the history has loaded the strip keeps the session sentence", () => {
    const html = render({ history: null });
    expect(html).toContain("Not validated in this session");
    expect(html).not.toContain("Not validated yet");
  });

  const STORED = { at: "2026-10-10T09:30:00.000Z", by: "Dana", setupDocId: "rs-standard-alco", outcome: "warn" as const, basisLabel: "Flat (simple top-up)", skippedFamilies: ["swaps"], current: true };

  it("a stored current validation reads Validated earlier with its outcome, time, author and basis", () => {
    const html = render({ history: [STORED] });
    expect(html).toContain("Validated earlier");
    expect(html).toContain("Validated with warnings");
    expect(html).toContain("2026-10-10T09:30:00.000Z");
    expect(html).toContain("Dana");
    expect(html).toContain("Flat (simple top-up)");
    expect(html).not.toContain("Not validated");
  });

  it("a stored validation of an older document says the setup changed and is not shown as passing", () => {
    const html = render({ history: [{ ...STORED, outcome: "pass", current: false }] });
    expect(html).toContain("The setup changed since its last validation");
    expect(html).toContain("must be validated again");
    expect(html).not.toContain("Validated: both gates passed");
    expect(html).not.toContain("Validated earlier");
  });

  it("a stored entry flagged current but naming another document says the setup changed (the editor sits on a newly saved document)", () => {
    const html = render({ history: [{ ...STORED, setupDocId: "rs-older-version", current: true }] });
    expect(html).toContain("The setup changed since its last validation");
    expect(html).toContain("must be validated again");
    expect(html).not.toContain("Validated earlier");
  });

  it("the session result wins over the stored one", () => {
    const html = render({ validation: VALIDATION_WARN, history: [{ ...STORED, basisLabel: "Stored basis" }] });
    expect(html).toContain("Flat (simple top-up)");
    expect(html).not.toContain("Validated earlier");
    expect(html).not.toContain("Stored basis");
  });

  it("a history load failure keeps the session sentence and shows the server's message on one line", () => {
    const html = render({ history: null, historyError: "The server could not read the validation history." });
    expect(html).toContain("Not validated in this session");
    expect(html).toContain("The server could not read the validation history.");
    expect(html).toMatch(/aria-label="Setup header"/);
  });

  // A refused compile, as the validate route answers it: the headline in error.message, both gate reports in detail.
  const R3_SENTENCE = 'selector {"behavioralClasses":"prepayment"} (dimensions <none>) matches no position in portfolio vanilla-book-v1';
  const REFUSED = {
    ...VALIDATION_WARN,
    outcome: "fail" as const,
    basisLabel: "",
    skippedFamilies: [],
    planId: null,
    reports: {
      error: {
        code: "plan_rejected",
        message: "plan rejected: 2 gate failure(s): R3@st-behavioral-prepay, R4",
        detail: {
          type: { passed: true, failures: [], checked: ["T1 every consumed type resolved"] },
          routing: {
            passed: false,
            failures: [
              { gate: "routing", rule: "R3", stageId: "st-behavioral-prepay", detail: R3_SENTENCE },
              { gate: "routing", rule: "R4", stageId: null, detail: "position mortgages-0 has class prepayment and no stage covers it" },
            ],
            checked: ["R1 2 behavioral stages checked"],
          },
        },
      },
    },
  };
  const esc = (s: string) => s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  it("a refused validation prints the headline and each gate failure's sentence (Studio Part 2 D5)", () => {
    const html = render({ validation: REFUSED });
    expect(html).toContain("plan rejected: 2 gate failure(s): R3@st-behavioral-prepay, R4");
    expect(html).toContain(esc(`R3 at st-behavioral-prepay: ${R3_SENTENCE}`));
    // A plan-wide failure names no stage.
    expect(html).toContain("R4: position mortgages-0 has class prepayment and no stage covers it");
    expect(html).not.toContain("at null");
    expect(html).toContain("Routing gate");
    // A refusal has no basis, so the row is not printed with an empty value (as the stored card does).
    expect(html).not.toContain("NII basis");
  });

  it("a validation whose reports hold neither a refusal nor a gate pair prints no gates and does not throw", () => {
    const html = render({ validation: { ...VALIDATION_WARN, reports: { warnings: [] } as never } });
    expect(html).not.toContain("Type gate");
    expect(html).not.toContain("Routing gate");
    expect(html).toContain("Validated with warnings");
  });

  it("a refusal with no compiled chain still prints the gate sentences", () => {
    const html = render({ validation: { ...REFUSED, compiledChain: [] } });
    expect(html).toContain(esc(`R3 at st-behavioral-prepay: ${R3_SENTENCE}`));
  });

  it("a refusal whose detail is not a pair of gate reports prints the headline only", () => {
    const html = render({ validation: { ...REFUSED, reports: { error: { code: "validation", message: "book holds 7 positions", detail: { field: "x" } } } } });
    expect(html).toContain("book holds 7 positions");
    expect(html).not.toContain("Routing gate");
  });

  it("a stored failed validation prints its reason and no empty basis row (Studio Part 2 D11)", () => {
    const html = render({ history: [{ ...STORED, outcome: "fail", basisLabel: "", reason: "plan rejected: 1 gate failure(s): R3@st-x; selector matches no position" }] });
    expect(html).toContain("Validated earlier");
    expect(html).toContain("plan rejected: 1 gate failure(s): R3@st-x; selector matches no position");
    expect(html).not.toContain("NII basis");
    expect(html).not.toContain("No gate refusal was stored with this validation.");
  });

  it("a stored failed validation with no reason says no gate refusal was stored", () => {
    const html = render({ history: [{ ...STORED, outcome: "fail", basisLabel: "" }] });
    expect(html).toContain("No gate refusal was stored with this validation.");
  });

  it("a stored passing validation prints no reason line", () => {
    const html = render({ history: [STORED] });
    expect(html).not.toContain("No gate refusal was stored");
    expect(html).toContain("NII basis");
  });

  it("under a stored validation the chain card says the stages are not stored with it (Studio Part 2 D12)", () => {
    const html = render({ history: [STORED] });
    expect(html).toContain("The stages are not stored with a validation. Validate again to see them.");
    expect(html).not.toContain("No compiled chain yet.");
    const none = render({ history: [] });
    expect(none).toContain("No compiled chain yet.");
    expect(none).not.toContain("The stages are not stored");
  });

  it("the launch status prints in the Launch card beside the button, not in the header (Studio Part 2 D6)", () => {
    const html = render({
      readiness: { items: ITEMS, launchable: { ok: true, blocking: [], acknowledgeable: [] } },
      launchMessage: "Launch 1 queued 1 run: r1.",
    });
    const launchCard = html.slice(html.indexOf('aria-label="Launch"'));
    expect(launchCard).toContain("Launch 1 queued 1 run: r1.");
    expect(html.indexOf("Launch 1 queued 1 run: r1.")).toBeGreaterThan(html.indexOf('aria-label="Launch"'));
    expect(html.split("Launch 1 queued 1 run: r1.").length - 1).toBe(1);
  });

  it("the Launch strip carries the readiness lists of the slot", () => {
    const html = render({ readiness: { items: ITEMS, launchable: { ok: false, blocking: ["balance/Positions"], acknowledgeable: ["run/setup-warnings"] } } });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Launch</);
    expect(html).toContain("Positions");
  });

  it("a locked workspace shows the reason and switches the form off", () => {
    const html = render({ readOnlyReason: "This workspace is locked; clone it to change a setup." });
    expect(html).toContain("This workspace is locked; clone it to change a setup.");
    expect(html).toMatch(/aria-label="NII horizon in months"[^>]*disabled=""/);
  });
});

describe("Scenarios tab", () => {
  const html = () => render({ tab: "scenarios" });

  it("offers the sources: shipped library, user-defined slate and the imported plan's list", () => {
    const h = html();
    // renderToStaticMarkup escapes the apostrophe.
    for (const label of ["Shipped library", "User-defined (a slate in this workspace)", "Imported plan&#x27;s own list"]) expect(h).toContain(label);
  });

  it("lists library scenarios with their kind and size, the setup's picks ticked", () => {
    const h = html();
    expect(h).toContain("Parallel +100 bp");
    expect(h).toContain("Parallel -200 bp");
    expect(h).toContain("Base");
    expect(h).toContain("Twist");
    expect(h).toMatch(/aria-label="Include regulatory-grid-v1#S100"[^>]*checked=""/);
    expect(h).not.toMatch(/aria-label="Include steepener-v1#STEEP100"[^>]*checked=""/);
  });

  it("offers no reserved set and no ramp; the six standardized shocks live on the Analysis path", () => {
    const h = html();
    expect(h).not.toContain("reserved");
    expect(h).not.toContain("IRRBB six scenarios");
    expect(h).not.toContain("ramp-200-12m-v1#R200");
    expect(h).toContain("Analysis path&#x27;s Scenarios step");
  });

  it("a slate source lists the slate's scenarios, user-defined knots as such", () => {
    const h = render({ tab: "scenarios", setup: { ...STANDARD_ALCO, scenarios: { kind: "slate", slateId: "alco-user-slate", include: "all" } } });
    expect(h).toContain("ALCO user shocks");
    expect(h).toContain("User-defined, 3 tenor knots");
  });

  it("an imported plan's list is shown read-only, inline definitions expanded", () => {
    const h = render({
      tab: "scenarios",
      setup: { ...STANDARD_ALCO, scenarios: { kind: "plan-scenarios", items: [{ ref: "regulatory-grid-v1#S0" } as never, { id: "DRVS7", label: "Derived 7", rateSpec: { kind: "parallel", shockBp: 7 } } as never] } },
    });
    expect(h).toContain("regulatory-grid-v1#S0");
    expect(h).toContain("DRVS7");
    expect(h).toContain("Parallel +7 bp");
  });
});

describe("Path tab", () => {
  it("single path is the choice; stochastic is not offered here and the note points to the Analysis path", () => {
    const h = render({ tab: "path" });
    const sel = selectOf(h, "EVE path");
    expect(sel).toMatch(/<option value="single"[^>]*selected=""[^>]*>Single path</);
    expect(sel).not.toContain('value="stochastic"');
    expect(h).toContain("A stochastic run launches from the Analysis path");
  });

  it("a setup that asks for stochastic reads the full refusal beside the control", () => {
    const h = render({ tab: "path", setup: { ...STANDARD_ALCO, eve: { ...STANDARD_ALCO.eve, path: "stochastic" } } });
    expect(h).toContain("Stochastic runs launch from the Analysis path in this release: choose one on the Simulation step and launch it on the Run step. This setup asks for the stochastic EVE path. Choose single path to launch it on the deterministic path.");
  });

  it("NII stays single path, said plainly with no reserved label", () => {
    expect(render({ tab: "path" })).toContain("NII runs on a single path.");
    expect(render({ tab: "path" })).not.toContain("reserved");
  });
});

describe("Batch tab", () => {
  it("lists rows of label, scenarios, assumption set and basis, and says a failing row blocks the whole launch", () => {
    const setup = {
      ...STANDARD_ALCO,
      batch: [
        { label: "Flat, up 200", scenarios: { kind: "library" as const, refs: ["regulatory-grid-v1#S200"] }, assumptionSetIds: { kind: "block-default" as const }, basis: { kind: "flat" as const, termMonths: 60 as const, spreadOverIndexBp: 0 as const } },
        { label: "Runoff, up 200", scenarios: { kind: "library" as const, refs: ["regulatory-grid-v1#S200"] }, assumptionSetIds: ["loan-repricing-demo-v1"], basis: { kind: "runoff" as const } },
      ],
    };
    const h = render({ tab: "batch", setup });
    expect(h).toContain("Flat, up 200");
    expect(h).toContain("Runoff, up 200");
    expect(h).toContain("Launch validates every row first and submits nothing if any row fails.");
    expect(h).toContain('aria-label="Row 1 basis"');
    expect(h).toContain('aria-label="Row 2 assumption set"');
    expect(h).toContain("Add a row");
  });

  it("an empty batch says so", () => {
    expect(render({ tab: "batch" })).toContain("No batch rows");
  });

  it("the setups page clears the launch answer and its run ids when the chosen slot changes (source-level stopgap: Studio tests have no DOM to run the hook)", () => {
    const src = readFileSync(new URL("../pages/run/SetupsPage.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/useEffect\(\(\) => \{ setLaunchMessage\(null\); setRunIds\(\[\]\); \}, \[chosenLineage\]\);/);
  });
});

describe("the Market input (Piece B, step B3a, decision 42)", () => {
  const markets = marketInputChoices(HEAD.blocks.market);
  it("puts a Market select in the Inputs card, the base first", () => {
    const sel = selectOf(render({ context: { ...CONTEXT, markets } }), "Market");
    expect(sel).toContain("Base snapshot (market-public-2026-03-31)");
    expect(sel).toContain('value="derived:tlp-shock-demo-v1"');
  });
  it("selects the setup's derived market", () => {
    const setup = { ...STANDARD_ALCO, inputs: { ...STANDARD_ALCO.inputs, market: { role: "derived" as const, definitionKey: "tlp-shock-demo-v1" } } };
    expect(selectOf(render({ setup, context: { ...CONTEXT, markets } }), "Market")).toMatch(/<option value="derived:tlp-shock-demo-v1" selected="">/);
  });
  it("without markets in the context it offers the base snapshot alone", () => {
    const sel = selectOf(render(), "Market");
    expect(sel).toContain('<option value="base" selected="">Base snapshot</option>');
    expect(sel).not.toContain("derived:");
  });
});
