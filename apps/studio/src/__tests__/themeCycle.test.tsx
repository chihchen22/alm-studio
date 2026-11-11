/**
 * Below 1280px the theme switch is one button (ALM Studio Polish 4 T2). It steps System, Light, Dark and back to
 * System, shows a monitor, a sun or a moon drawn in the text colour, and its title, which is also its accessible
 * name (it has no text of its own), says the theme and the action. It and the three-button switch read and write one
 * state; CSS shows the switch at 1280px and wider and the button below (top bar 1). Markup and rule texts are restated here; the
 * drive clicks the button at 1024 px.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeCycle, ThemeSeg, nextTheme } from "../shell/ThemeSeg";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

const SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const MONITOR = '<rect x="1.5" y="2.25" width="13" height="9" rx="1.25"></rect><path d="M5.5 14h5M8 11.25V14"></path>';
const SUN =
  '<circle cx="8" cy="8" r="2.75"></circle><path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.23 3.23l1.06 1.06M11.71 11.71l1.06 1.06M3.23 12.77l1.06-1.06M11.71 4.29l1.06-1.06"></path>';
const MOON = '<path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53Z"></path>';
const button = (title: string, icon: string) => `<button class="theme-cycle" type="button" title="${title}">${SVG}${icon}</svg></button>`;

describe("the theme cycle button", () => {
  it("steps System, Light, Dark and back to System", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });
  it("says the theme and the action in its title and draws a monitor, a sun or a moon", () => {
    const noop = () => {};
    expect(renderToStaticMarkup(<ThemeCycle theme="system" onCycle={noop} />)).toBe(button("Theme: System. Switch to Light", MONITOR));
    expect(renderToStaticMarkup(<ThemeCycle theme="light" onCycle={noop} />)).toBe(button("Theme: Light. Switch to Dark", SUN));
    expect(renderToStaticMarkup(<ThemeCycle theme="dark" onCycle={noop} />)).toBe(button("Theme: Dark. Switch to System", MOON));
  });
  it("sits beside the three-button switch, both on one theme", () => {
    expect(renderToStaticMarkup(<ThemeSeg />)).toBe(
      '<div class="seg" role="group" aria-label="Theme"><button type="button" aria-pressed="true">System</button><button type="button" aria-pressed="false">Light</button><button type="button" aria-pressed="false">Dark</button></div>'
        + button("Theme: System. Switch to Light", MONITOR),
    );
  });
  it("is hidden at 1280px and wider, where the three-button switch shows: its base rule sits outside every media block (Polish 6 T5)", () => {
    const rule = ".theme-cycle { display: none; flex: none;";
    const at = CSS.indexOf(rule);
    expect(at).toBeGreaterThan(-1);
    expect(CSS.indexOf(rule, at + 1)).toBe(-1);
    // Each media block runs from its opening brace to the brace that closes it.
    const blocks = [...CSS.matchAll(/@media[^{]*\{/g)].map((m) => {
      let depth = 1;
      let i = m.index! + m[0].length;
      for (; i < CSS.length && depth > 0; i++) depth += CSS[i] === "{" ? 1 : CSS[i] === "}" ? -1 : 0;
      return [m.index!, i];
    });
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.filter(([start, end]) => at > start! && at < end!)).toEqual([]);
  });
});
