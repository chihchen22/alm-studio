/**
 * A top-bar select pill whose value is the placeholder "none" reads it whole (ALM Studio Polish 4 Task 5 fix I1). The pills shrink in proportion to
 * their content, so the four-letter "none" lost the most and printed as a lone ellipsis and "e". Its wrapper carries
 * pill-none and never shrinks; a real id still gives way and is cut from its start. Studio tests have no layout
 * engine, so this pins the markup and the rule; the drive reads the pills at 1024, 1100 and 1440 px. Markup and rule
 * texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectPill } from "../shell/SelectPill";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

describe("a select pill that reads none", () => {
  it("marks its wrapper pill-none", () => {
    expect(renderToStaticMarkup(<SelectPill label="Plan" value="none" options={[]} />)).toBe(
      '<div class="pill-menu-wrap pill-none"><button class="pill pill-select" type="button" title="Plan: none" aria-expanded="false"><span class="pill-key">Plan</span><span class="mono pill-value"><bdi dir="ltr">none</bdi></span></button></div>',
    );
  });
  it("leaves a pill with a real value unmarked", () => {
    expect(renderToStaticMarkup(<SelectPill label="Run" value="run-none-2" options={[]} />)).toMatch(/^<div class="pill-menu-wrap"><button/);
  });
  it("never shrinks in the top bar", () => {
    expect(CSS).toContain(".topbar-ctx .pill-menu-wrap.pill-none { flex: none; }");
  });
});
