/**
 * The Launch strip's readiness list (spec v3.1 Section 3.5, Launch gate). Task E2 wrote this test against
 * `apps/studio/src/run/LaunchStrip.tsx` while the component was absent; Task E5 created it and the suite is now live.
 *
 *   LaunchStrip({ items, launchable, onLaunch })
 *     items       the ReadinessItem rows of the setup being launched
 *     launchable  `ReadinessReport.launchable[slot]`: { ok, blocking, acknowledgeable }
 *
 * Expected values and texts are restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReadinessItem } from "@alm/reader";
import { LaunchStrip } from "../run/LaunchStrip";
import { READINESS_ESCALATION } from "../shell/ReadinessChip";

const item = (name: string, state: ReadinessItem["state"], required = true): ReadinessItem => ({ section: "run", item: name, state, required, detail: `${name} detail` });
const ITEMS: ReadinessItem[] = [
  item("Positions", "not-set"),
  item("Base snapshot", "error"),
  item("Sets", "valid"),
  item("Run setups", "stale"),
  item("Scenarios", "warning"),
];

describe("the Launch strip", () => {
  it("a setup with a blocking item renders a disabled Launch button and the blocking list in words", () => {
    const html = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: false, blocking: ["Positions", "Base snapshot"], acknowledgeable: ["Run setups", "Scenarios"] }} onLaunch={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Launch</);
    expect(html).toContain("Positions, Base snapshot");
  });
  it("prints one chip per state present, worst first", () => {
    const html = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: false, blocking: ["Positions"], acknowledgeable: [] }} onLaunch={() => {}} />);
    const order = [...html.matchAll(/chip-readiness-([a-z-]+)/g)].map((m) => m[1]);
    const seen = [...new Set(order)];
    expect(seen).toEqual(READINESS_ESCALATION.filter((s) => ITEMS.some((i) => i.state === s)));
    expect(seen).toEqual(["error", "not-set", "stale", "warning", "valid"]);
  });
  it("an acknowledgeable item gets a checkbox the launch needs ticked", () => {
    const html = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: true, blocking: [], acknowledgeable: ["Run setups", "Scenarios"] }} onLaunch={() => {}} />);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    // Nothing is ticked yet, so the launch is still off.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Launch</);
  });
  it("names an acknowledgeable item by its words and lists the blocking items apart from them", () => {
    const html = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: false, blocking: ["Positions"], acknowledgeable: ["Run setups"] }} onLaunch={() => {}} />);
    expect(html).toContain("Blocking: Positions");
    expect(html).toContain("Run setups: Run setups detail");
  });
  it("a setup with nothing blocking and nothing to acknowledge launches", () => {
    const html = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: true, blocking: [], acknowledgeable: [] }} onLaunch={() => {}} />);
    expect(html).toMatch(/<button[^>]*>Launch</);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Launch</);
    expect(html).not.toContain("Blocking:");
  });
  it("a disabled reason from the page switches the launch off and says why", () => {
    const html = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: true, blocking: [], acknowledgeable: [] }} onLaunch={() => {}} disabledReason="Save the edits first." />);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Launch</);
    expect(html).toContain("Save the edits first.");
  });
  it("offers the batch launch only when the setup has batch rows", () => {
    const none = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: true, blocking: [], acknowledgeable: [] }} onLaunch={() => {}} />);
    expect(none).not.toContain("Launch batch");
    const some = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: true, blocking: [], acknowledgeable: [] }} onLaunch={() => {}} batchRows={3} />);
    expect(some).toContain("Launch batch (3 rows)");
  });
  it("prints the last launch's outcome as a status beside the buttons, and nothing when there is none (Studio Part 2 D6)", () => {
    const html = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: true, blocking: [], acknowledgeable: [] }} onLaunch={() => {}} message="Launch 2 queued 2 runs: r1, r2." />);
    expect(html).toMatch(/<div class="launch-actions"><button[^>]*>Launch<\/button><span class="launch-message" role="status">Launch 2 queued 2 runs: r1, r2\.<\/span><\/div>/);
    const none = renderToStaticMarkup(<LaunchStrip items={ITEMS} launchable={{ ok: true, blocking: [], acknowledgeable: [] }} onLaunch={() => {}} message={null} />);
    expect(none).not.toContain('role="status"');
  });
});

describe("the escalation order the strip reads", () => {
  it("is Error, Not set, Stale, Warning, Draft, Valid", () => {
    expect([...READINESS_ESCALATION]).toEqual(["error", "not-set", "stale", "warning", "draft", "valid"]);
  });
});
