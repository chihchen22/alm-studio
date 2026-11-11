/**
 * Why a key-rate or channel block is absent from Results > EVE (final review, Section 2 item on EveTab). The sentence
 * is read off the run's own envelope: its schema version and the absent field. It never blames a plan run, so it
 * cannot contradict a box ticked on a run setup. Expected sentences are restated here by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EveTab } from "../pages/results/EveTab";
import { DETAIL, freshResult } from "./fixtures/results";

const render = (r = freshResult()) => renderToStaticMarkup(<EveTab ws="ws-a" runId="run-fixture" detail={DETAIL} result={r} query={{}} scenarioLabel={(id: string) => id} />);

describe("EVE absence sentences", () => {
  it("on a 1.2.0-or-later envelope: the run's engine options did not request the block", () => {
    const html = render();
    expect(html).toContain("Key-rate durations are not in this run: its stored envelope (schema 1.13.0) has no eve.keyRate, which the engine writes only when the run&#x27;s engine options request key-rate durations.");
    expect(html).toContain("The channel decomposition is not in this run: its stored envelope (schema 1.13.0) has no eve.channels, which the engine writes only when the run&#x27;s engine options request the channel decomposition.");
    expect(html).not.toContain("plan run");
  });
  it("on an envelope older than 1.2.0: the schema predates the field", () => {
    const r = freshResult();
    r.schemaVersion = "1.1.0";
    const html = render(r);
    expect(html).toContain("Key-rate durations are not in this run: its stored envelope is schema 1.1.0, older than 1.2.0, the first to carry eve.keyRate.");
    expect(html).toContain("The channel decomposition is not in this run: its stored envelope is schema 1.1.0, older than 1.2.0, the first to carry eve.channels.");
  });
  it("a run whose book carries the regime-amplifier refusal: the key-rate sentence names the refusal, not the options", () => {
    const r = freshResult();
    r.notImplemented = [...r.notImplemented, { _tag: "not-implemented", layer: "eve.key-rate.regime-amplifier", reason: "key-rate durations were requested but the book carries 1 position(s) with a nonzero one-sided regime amplifier" }];
    const html = render(r);
    expect(html).toContain("Key-rate durations are not in this run: the engine refused them because a position on this book carries a one-sided regime amplifier.");
    expect(html).not.toContain("which the engine writes only when the run&#x27;s engine options request key-rate durations.");
    expect(html).toContain("The channel decomposition is not in this run: its stored envelope (schema 1.13.0) has no eve.channels, which the engine writes only when the run&#x27;s engine options request the channel decomposition.");
  });
});
