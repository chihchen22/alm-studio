/**
 * The phone gate at 900 px (ALM Studio band 900, ruling 2026-10-01, candidate A of the 720 to 900 px scout): the
 * phone layout now holds up to 900 px, since from 720 to about 790 px the desktop bar's Book and As of pills read
 * nothing and the Scenario sets card actions ran past their card. Both stylesheets open their phone block at 900 px
 * and Shell's matchMedia closes the context sheet when the window leaves that same band. Separately, a card head's
 * actions wrap at every width, since the Scenario sets pair ran past its card up to 919 px. Studio tests have no DOM,
 * so the gate is pinned by source text. Query strings and rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const COMPONENTS_CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");
const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const SHELL = readFileSync(new URL("../shell/Shell.tsx", import.meta.url), "utf8");
const clean = (rule: string) => rule.replace(/\s+/g, " ").trim();

/** Every rule outside any @media or @container block, comments dropped, whitespace collapsed. */
function base(css: string): string[] {
  let text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let i = text.search(/@(media|container)[^{]*\{/); i !== -1; i = text.search(/@(media|container)[^{]*\{/)) {
    let depth = 1;
    let j = text.indexOf("{", i) + 1;
    for (; depth > 0; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    text = text.slice(0, i) + text.slice(j);
  }
  return [...text.matchAll(/[^{}]+\{[^{}]*\}/g)].map((m) => clean(m[0]));
}

describe("the phone gate at 900 px", () => {
  it("opens the phone block at 900 px in components.css, once, and no block opens at 719 px", () => {
    expect(COMPONENTS_CSS.split("@media (max-width: 900px) {")).toHaveLength(2);
    expect(COMPONENTS_CSS).not.toContain("719px");
  });
  it("opens the phone block at 900 px in app.css, once, and no block opens at 719 px", () => {
    expect(APP_CSS.split("@media (max-width: 900px) {")).toHaveLength(2);
    expect(APP_CSS).not.toContain("719px");
  });
  it("closes the context sheet in Shell when the window leaves the same 900 px band", () => {
    expect(SHELL).toContain('window.matchMedia("(max-width: 900px)")');
    expect(SHELL).not.toContain("719px");
  });
});

describe("a card head's actions wrap at every width", () => {
  it("carries flex-wrap: wrap and min-width: 0 for .card-head-actions outside any media block", () => {
    expect(base(APP_CSS)).toContain(".card-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex: 0 1 auto; flex-wrap: wrap; min-width: 0; }");
    expect(base(APP_CSS).filter((r) => r.startsWith(".card-head-actions "))).toHaveLength(1);
  });
  it("leaves no second copy of the rule in the phone block", () => {
    const at = APP_CSS.indexOf("@media (max-width: 900px) {");
    expect(at).toBeGreaterThan(-1);
    expect(APP_CSS.slice(at)).not.toContain(".card-head-actions");
  });
});
