/**
 * The page behind the open context sheet holds still on a phone (ALM Studio phone 2, phone 1 final review Finding 3:
 * a touch drag on the scrim scrolled the document). The decision is a pure function in shell/phone.ts; Shell.tsx
 * applies it to document.body in an effect whose cleanup removes the class, so a close (the scrim, the close button,
 * Escape, a route change, leaving the phone band) and an unmount all take it off. Studio tests have no DOM, so the
 * effect is pinned by its source and the rules by the stylesheets' text; the review's 390 px drive confirms that
 * a drag on the scrim leaves the document's scroll where it was. Class names and rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sheetBodyClass } from "../shell/phone";

const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const COMPONENTS_CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");
const SHELL = readFileSync(new URL("../shell/Shell.tsx", import.meta.url), "utf8");
const OPEN = "@media (max-width: 900px) {";
const clean = (rule: string) => rule.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();

/** The rules inside app.css's phone block, and every rule outside it in both stylesheets. */
function split(css: string): { inside: string[]; outside: string[] } {
  const i = css.indexOf(OPEN);
  if (i === -1) return { inside: [], outside: [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[^{}]+\{[^{}]*\}/g)].map((m) => clean(m[0])) };
  let depth = 1;
  let j = i + OPEN.length;
  for (; depth > 0; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") depth--;
  }
  const rule = (s: string) => [...s.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/[^{}]+\{[^{}]*\}/g)].map((m) => clean(m[0]));
  return { inside: rule(css.slice(i + OPEN.length, j - 1)), outside: rule(css.slice(0, i) + css.slice(j)) };
}

describe("the body class while the context sheet is open", () => {
  it("is ctx-sheet-open while the sheet is open, and none while it is shut", () => {
    expect(sheetBodyClass(true)).toBe("ctx-sheet-open");
    expect(sheetBodyClass(false)).toBeNull();
  });
});

describe("Shell's effect on document.body", () => {
  it("adds the class the sheet's state names and removes that same class in its cleanup, run on every change of the state and on unmount", () => {
    expect(SHELL).toContain('import { ctxSheet, sheetBodyClass } from "./phone";');
    expect(SHELL).toContain(
      [
        "  useEffect(() => {",
        "    const cls = sheetBodyClass(ctxOpen);",
        "    if (cls === null) return;",
        "    document.body.classList.add(cls);",
        "    return () => document.body.classList.remove(cls);",
        "  }, [ctxOpen]);",
      ].join("\n"),
    );
    // One class, added in one place and removed in its cleanup.
    expect(SHELL.match(/classList\.add\(/g)).toHaveLength(1);
    expect(SHELL.match(/classList\.remove\(/g)).toHaveLength(1);
  });
});

describe("the lock's rules", () => {
  const app = split(APP_CSS);
  const components = split(COMPONENTS_CSS);
  it("hide the document's overflow and hold its gutter inside the phone band only, and keep a drag on the open scrim from panning", () => {
    for (const r of [
      "body.ctx-sheet-open { overflow: hidden; overscroll-behavior: none; }",
      ":root:has(> body.ctx-sheet-open) { scrollbar-gutter: stable; }",
      '.ctx-scrim[data-open="true"] { touch-action: none; }',
    ]) expect(app.inside).toContain(r);
  });
  it("never apply outside the band, in either stylesheet", () => {
    for (const r of [...app.outside, ...components.outside]) expect(r).not.toContain("ctx-sheet-open");
    expect(components.inside.filter((r) => r.includes("ctx-sheet-open"))).toEqual([]);
  });
});
