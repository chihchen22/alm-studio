// apps/studio/design/check.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkTokens, checkPage, checkCss, checkSourceDir, checkApp } from "./check.mjs";

const TOKENS = fileURLToPath(new URL("./tokens.css", import.meta.url));
const CHECK = fileURLToPath(new URL("./check.mjs", import.meta.url));
const COMPONENTS = fileURLToPath(new URL("./components.css", import.meta.url));
const LINK = `<link rel="stylesheet" href="tokens.css">`;

function tmpFile(t, name, content) {
  const dir = mkdtempSync(join(tmpdir(), "studio-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
const tmpDirs = [];
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
function tmpDir(name) {
  const d = join(mkdtempSync(join(tmpdir(), "studio-check-")), name);
  tmpDirs.push(dirname(d));
  mkdirSync(d);
  return d;
}
function tmp(name, content) {
  const p = join(tmpDir("f"), name);
  writeFileSync(p, content);
  return p;
}
const page = (head, body) => `<html><head>${LINK}${head}</head><body>${body}</body></html>`;
const colourHits = (v) => v.filter((s) => s.startsWith("raw "));

test("tokens.css declares every required token in light and both dark blocks", () => {
  assert.deepEqual(checkTokens(TOKENS), []);
});

test("a dark --bg equal to the light --bg is a violation", (t) => {
  const css = readFileSync(TOKENS, "utf8").replaceAll("--bg: #0D1117", "--bg: #F6F6F4");
  const v = checkTokens(tmpFile(t, "tokens.css", css));
  assert.ok(v.some((s) => s.includes("dark-media") && s.includes("--bg")), v.join("\n"));
  assert.ok(v.some((s) => s.includes("dark-attr") && s.includes("--bg")), v.join("\n"));
});

test("a clean page has no violations", (t) => {
  assert.deepEqual(checkPage(tmpFile(t, "ok.html", page("", `<p style="color: var(--ink)">Base NII</p>`))), []);
});

test("a page with a raw hex color is a violation", (t) => {
  const p = tmpFile(t, "bad.html", `<html><head>${LINK}</head><body style="color:#123456"></body></html>`);
  const v = checkPage(p);
  assert.ok(v.some((s) => s.includes("#123456")), v.join("\n"));
});

test("hex outside style regions, entities and id selectors are not colours", (t) => {
  const css = `<style>
#add { color: var(--ink); }
#fed:hover, #bad.x, #cab[data-a] { gap: var(--sp-1); }
body>#dab { margin: 0; }
.chip-red, .white-space { white-space: nowrap; }
#add-row { color: var(--muted); }
</style>`;
  const v = checkPage(tmpFile(t, "fp.html", page(css, `<p>Issue #123 &#123; <a href="#abc">x</a></p><svg><use xlink:href="#fed"/></svg>`)));
  assert.deepEqual(colourHits(v), [], v.join("\n"));
});

test("colour functions and named colours inside style regions are violations", (t) => {
  const css = `<style>
.a { color: red; }
.b { background: oklch(50% .1 200); }
.c { color: HSLA(0,0%,0%,.5); }
.d { border-color: lab(50 20 30); }
.e { fill: #abc; }
</style>`;
  const body = `<p style="border-color: color-mix(in srgb, var(--ink), white)">x</p>`;
  const v = checkPage(tmpFile(t, "fn.html", page(css, body)));
  for (const want of [" red ", "oklch()", "hsla()", "lab()", "#abc", "color-mix()", " white "]) {
    assert.ok(v.some((s) => s.toLowerCase().includes(want)), `missing ${want}:\n${v.join("\n")}`);
  }
});

test("SVG colour attributes are scanned; var() and keywords are clean", (t) => {
  const bad = checkPage(tmpFile(t, "svgbad.html", page("", `<svg><rect fill="#abc"/><path stroke='red'/></svg>`)));
  assert.ok(bad.some((s) => s.includes("#abc")), bad.join("\n"));
  assert.ok(bad.some((s) => s.includes(" red ")), bad.join("\n"));
  const svg = `<svg><rect fill="var(--series-1)" stroke="none"/><path stroke="currentColor" fill='transparent'/>`
    + `<stop stop-color="inherit"/><rect fill="url(#fed)" stroke-width="2"/></svg>`;
  const ok = checkPage(tmpFile(t, "svgok.html", page("", svg)));
  assert.deepEqual(colourHits(ok), [], ok.join("\n"));
});

test("hex in a comma list inside a rule body is a colour; a selector list is not", (t) => {
  const bad = checkPage(tmpFile(t, "shadow.html", page(`<style>.card { box-shadow: 0 1px 2px #abc, 0 4px 8px #def; }</style>`, "")));
  assert.equal(colourHits(bad).length, 2, bad.join("\n"));
  assert.ok(bad.some((s) => s.includes("#abc")) && bad.some((s) => s.includes("#def")), bad.join("\n"));
  const ok = checkPage(tmpFile(t, "sel.html", page(`<style>#add, #bad { gap: var(--sp-1); }</style>`, "")));
  assert.deepEqual(colourHits(ok), [], ok.join("\n"));
  const attr = checkPage(tmpFile(t, "attr.html", page("", `<p style="box-shadow: 0 1px #abc, 0 2px #def">x</p>`)));
  assert.equal(colourHits(attr).length, 2, attr.join("\n"));
});

test("an em-dash or section sign is a violation", (t) => {
  const p = tmpFile(t, "dash.html", page("", `a ${String.fromCharCode(0x2014)} b ${String.fromCharCode(0xa7)}`));
  const v = checkPage(p);
  assert.ok(v.some((s) => s.includes("U+2014")) && v.some((s) => s.includes("U+00A7")));
});

test("entity-encoded em-dashes and section signs are violations", (t) => {
  for (const ent of ["&mdash;", "&#8212;", "&#x2014;", "&MDASH;", "&#X2014;"]) {
    const v = checkPage(tmpFile(t, "e.html", page("", `a ${ent} b`)));
    assert.ok(v.includes("U+2014 (entity)"), `${ent}: ${v.join("\n")}`);
  }
  for (const ent of ["&sect;", "&#167;", "&#xa7;", "&#XA7;"]) {
    const v = checkPage(tmpFile(t, "s.html", page("", `a ${ent} b`)));
    assert.ok(v.includes("U+00A7 (entity)"), `${ent}: ${v.join("\n")}`);
  }
});

test("a page without the tokens link is a violation", (t) => {
  const p = tmpFile(t, "nolink.html", `<html><head></head><body></body></html>`);
  assert.ok(checkPage(p).some((s) => s.includes("tokens.css")));
});

test("CLI accepts only tokens|page|css plus a file", (t) => {
  const run = (...a) => spawnSync(process.execPath, [CHECK, ...a], { encoding: "utf8" });
  for (const args of [[], ["tokens"], ["bogus", TOKENS], ["tokens", TOKENS, "extra"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stderr, /usage/i);
  }
  const ok = run("tokens", TOKENS);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(run("css", COMPONENTS).status, 0);
  const bad = run("page", tmpFile(t, "nolink.html", "<html></html>"));
  assert.equal(bad.status, 1);
});

test("css mode: a stylesheet with a raw hex colour is a violation", (t) => {
  const v = checkCss(tmpFile(t, "bad.css", ".a { color: #abc; }\n#abc { gap: var(--sp-1); }\n"));
  assert.equal(colourHits(v).length, 1, v.join("\n"));
  assert.ok(v[0].includes("#abc"), v.join("\n"));
});

test("css mode: components.css is clean", () => {
  assert.deepEqual(checkCss(COMPONENTS), []);
});

test("unquoted attribute colour is caught", () => {
  const p = tmp("u.html", `<link href="tokens.css"><div style=color:#ff0000>x</div>`);
  assert.ok(checkPage(p).some((v) => v.includes("#ff0000")));
});
test("em-dash entity without a semicolon is caught", () => {
  const p = tmp("e.html", `<link href="tokens.css"><p>a &#8212 b</p>`);
  assert.ok(checkPage(p).some((v) => v.includes("U+2014")));
});
test("url('#id') inside quotes is not a colour", () => {
  const p = tmp("q.html", `<link href="tokens.css"><svg><rect fill="url('#abc')"/></svg>`);
  assert.deepEqual(checkPage(p), []);
});
test("hwb() and color() are caught in css mode", () => {
  const p = tmp("f.css", `.a{color:hwb(10 0% 0%)} .b{color:color(display-p3 1 0 0)}`);
  assert.equal(checkCss(p).length, 2);
});
test("CSS escapes for the em-dash and section sign are caught in css mode", () => {
  const p = tmp("esc.css", `.a::before{content:"\\2014"} .b::before{content:"\\a7"}`);
  const v = checkCss(p);
  assert.ok(v.some((x) => x.includes("U+2014")));
  assert.ok(v.some((x) => x.includes("U+00A7")));
});
test("checkSourceDir catches a hex literal in a tsx file", () => {
  const d = tmpDir("src");
  writeFileSync(join(d, "A.tsx"), `export const s = { color: "#123456" };`);
  assert.ok(checkSourceDir(d).some((v) => v.includes("#123456")));
});
test("checkSourceDir catches a quoted named colour in a tsx file; a word containing one is clean", () => {
  const d = tmpDir("src");
  writeFileSync(join(d, "A.tsx"), `export const A = () => <b style={{ color: "red" }} />;`);
  assert.ok(checkSourceDir(d).some((v) => v.includes('named colour "red"')));
  const e = tmpDir("src");
  writeFileSync(join(e, "B.tsx"), `const label = "greenlight";`);
  assert.deepEqual(checkSourceDir(e), []);
});

function appFixture(css, srcFiles, jsFiles = {}) {
  const root = tmpDir("app");
  const dist = join(root, "dist"), src = join(root, "src");
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(src);
  writeFileSync(join(dist, "assets", "index-abc.css"), css);
  for (const [name, text] of Object.entries(jsFiles)) writeFileSync(join(dist, "assets", name), text);
  writeFileSync(join(dist, "index.html"), `<html><head><link rel="stylesheet" href="/assets/index-abc.css"></head><body></body></html>`);
  for (const [name, text] of Object.entries(srcFiles)) writeFileSync(join(src, name), text);
  return { dist, src };
}
// tokens.css as a minifier emits it: comments gone, whitespace collapsed, attribute quotes dropped.
const minTokens = () => readFileSync(TOKENS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replaceAll('"', "");

test("app mode: a clean build and source tree pass", () => {
  const { dist, src } = appFixture(minTokens() + ".card{color:var(--ink)}", {
    "App.tsx": `export const A = () => <div style={{ color: "var(--ink)" }} />;`,
    "App.css": `.y { color: var(--ink-2); }`,
  });
  assert.deepEqual(checkApp(dist, src), []);
});
test("app mode: an app-authored :root literal and an unquoted hex in source css are caught", () => {
  const { dist, src } = appFixture(minTokens() + ":root{--brand:#ff0000}.card{color:var(--ink)}", {
    "App.css": `:root { --brand: #0000ff; }\n.y { color: #00ff00; }`,
  });
  const v = checkApp(dist, src);
  for (const want of ["#ff0000", "#0000ff", "#00ff00"]) assert.ok(v.some((s) => s.includes(want)), `missing ${want}:\n${v.join("\n")}`);
  const r = spawnSync(process.execPath, [CHECK, "app", dist, src], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
test("app mode: a regex lookbehind in a built script fails the gate; a named group and a lookahead pass (Polish 8 T3)", () => {
  const css = minTokens() + ".card{color:var(--ink)}";
  const clean = appFixture(css, {}, { "index-abc.js": "const d=/(?<year>\\d{4})(?=-)/;" });
  assert.deepEqual(checkApp(clean.dist, clean.src), []);
  // As the build emits the Polish 6 idPieces literal (a RegExp string), and a vendor script with a negative one.
  const { dist, src } = appFixture(css, {}, {
    "index-abc.js": 'const p=new RegExp("(?<=-)|(?<=[a-z0-9])(?=[A-Z])");',
    "vendor-def.js": "const q=/(?<!x)y/;",
  });
  assert.deepEqual(checkApp(dist, src), ["assets/index-abc.js: regex lookbehind (?<= (2)", "assets/vendor-def.js: regex lookbehind (?<! (1)"]);
  const r = spawnSync(process.execPath, [CHECK, "app", dist, src], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /regex lookbehind/);
});
test("entity lookaheads follow each form", () => {
  const hit = (s) => checkPage(tmp("x.html", `<link href="tokens.css"><p>${s}</p>`));
  assert.ok(hit("&#8212a").includes("U+2014 (entity)"));
  assert.ok(!hit("&#82120").includes("U+2014 (entity)"));
  assert.ok(hit("&#x2014g").includes("U+2014 (entity)"));
  assert.ok(!hit("&#x2014a").includes("U+2014 (entity)"));
  assert.ok(hit("&sections").includes("U+00A7 (entity)"));
  assert.ok(!hit("&#1670").includes("U+00A7 (entity)"));
});
test("CSS escapes inside a page's style regions are caught", () => {
  const v = checkPage(tmp("s.html", `<link href="tokens.css"><style>.a::before{content:"\\2014"}</style><p style='content:"\\a7"'>x</p>`));
  assert.ok(v.includes("U+2014 (css escape)"), v.join("\n"));
  assert.ok(v.includes("U+00A7 (css escape)"), v.join("\n"));
});

// The compact top-bar block in components.css (top bar 1) must come after the base top-bar rules and stay its own
// media block, apart from the assistant rail's 1279px block above them. Before this test the order rested on a comment.
const COMPACT_OPENER = "@media (max-width: 1279px) {";
const COMPACT_RULE = ".topbar-ctx .theme-cycle { display: inline-flex; }";
const BASE_PILL_RULE = ".topbar-ctx .pill {";
function compactOrderViolations(css) {
  // Comments blanked to spaces of the same length, so braces in prose do not count and offsets hold.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const blocks = [];
  let at = text.indexOf(COMPACT_OPENER);
  while (at !== -1) {
    let depth = 0, end = -1;
    for (let i = at + COMPACT_OPENER.length - 1; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { end = i; break; }
    }
    if (end === -1) end = text.length; // an unbalanced block runs to the end of the file, so it still counts
    const body = text.slice(at + COMPACT_OPENER.length, end).replace(/\s+/g, " ");
    blocks.push({ start: at, end, body });
    at = text.indexOf(COMPACT_OPENER, at + 1);
  }
  // The first base pill rule: the first ".topbar-ctx .pill {" at brace depth 0, outside every media block.
  let anchor = -1, depth = 0;
  for (let i = 0; i < text.length && anchor === -1; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    else if (depth === 0 && text.startsWith(BASE_PILL_RULE, i) && (i === 0 || /\s|}/.test(text[i - 1]))) anchor = i;
  }
  const v = [];
  const compact = blocks.filter((b) => b.body.includes(COMPACT_RULE));
  const rail = blocks.filter((b) => b.body.includes(".assist-rail"));
  if (compact.length !== 1) v.push(`compact block count ${compact.length}, want 1`);
  if (rail.length !== 1) v.push(`rail block count ${rail.length}, want 1`);
  if (anchor === -1) v.push("no base .topbar-ctx .pill rule");
  if (compact.length === 1 && anchor !== -1 && compact[0].start < anchor) v.push("compact block opens before the base .topbar-ctx .pill rule");
  if (compact.length === 1 && rail.length === 1) {
    if (compact[0] === rail[0]) v.push("compact block merged into the rail block");
    else if (compact[0].start < rail[0].end) v.push("compact block opens before the rail block closes");
  }
  return v;
}

test("components.css: the compact top-bar block is one separate 1279px block after the base pill rule (order pin)", () => {
  const css = readFileSync(COMPONENTS, "utf8");
  assert.deepEqual(compactOrderViolations(css), []);
  // Two distinct 1279px openers in the file: the rail's first, the compact one second.
  assert.equal(css.split(COMPACT_OPENER).length - 1, 2);
});

test("order pin bites: a moved, merged, doubled or emptied compact block is a violation", () => {
  const css = readFileSync(COMPONENTS, "utf8");
  const open = css.indexOf(COMPACT_OPENER, css.indexOf(".theme-cycle:hover"));
  const close = css.indexOf("\n}\n", open) + 3;
  const block = css.slice(open, close);
  assert.ok(block.includes(COMPACT_RULE), block);
  const without = css.slice(0, open) + css.slice(close);
  // Moved ahead of the base top-bar rules (before the shell grid).
  const shell = without.indexOf("/* ALM Studio P1 shell");
  const moved = without.slice(0, shell) + block + without.slice(shell);
  assert.deepEqual(compactOrderViolations(moved), ["compact block opens before the base .topbar-ctx .pill rule"]);
  // Merged into the rail's block: its rules pasted before the rail block's closing brace.
  const railOpen = without.indexOf(COMPACT_OPENER);
  const railClose = without.indexOf("\n}\n", railOpen) + 1;
  const inner = block.slice(COMPACT_OPENER.length + 1, block.lastIndexOf("}"));
  const merged = without.slice(0, railClose) + inner + without.slice(railClose);
  assert.deepEqual(compactOrderViolations(merged), ["compact block opens before the base .topbar-ctx .pill rule", "compact block merged into the rail block"]);
  // Doubled, and with the theme-cycle rule gone.
  assert.deepEqual(compactOrderViolations(css.slice(0, close) + block + css.slice(close)), ["compact block count 2, want 1"]);
  assert.deepEqual(compactOrderViolations(css.replace(COMPACT_RULE, "")), ["compact block count 0, want 1"]);
});

// The Run setups measure cards (NII, EVE, Gap) hold native selects that cut their selected label at the card's inner
// width (observed at 1280 px: "Monthly (interim" and "As of the grid dat"). The cards take columns of at least a floor
// that covers the enabled labels of the EVE valuation dates and Gap bucket selects; a reserved (disabled) label may
// cut in the closed select by ruling. Layout cannot be measured under node:test, so this is a static pin: the rule and
// its 901px guard must be present (the guard keeps it off the phone block's one column), and its floor must cover the
// longest enabled label at 7px a character (measured at most 7.0 at the 14px select font) plus 38px of native chrome,
// 48px of card padding and a 2px border.
const SETUPS_CSS = fileURLToPath(new URL("../src/styles/run-setups.css", import.meta.url));
const SETUP_ROWS = fileURLToPath(new URL("../src/rows/setupRows.ts", import.meta.url));
const MEASURE_RULE = /@media \(min-width: 901px\) \{\s*\.grid-3\.setup-measures \{\s*grid-template-columns: repeat\(auto-fit, minmax\(min\((\d+)px, 100%\), 1fr\)\);\s*\}\s*\}/;
function enabledLabels(ts, name) {
  const at = ts.indexOf(`export const ${name}`);
  assert.ok(at >= 0, `${name} is not exported from setupRows.ts; the pin reads it by name`);
  const block = ts.slice(at, ts.indexOf("];", at));
  const rows = [...block.matchAll(/label: "([^"]+)", disabled: (true|false)/g)];
  assert.ok(rows.length > 0, `${name} holds no label and disabled pairs; the pin reads that shape`);
  return rows.filter((m) => m[2] === "false").map((m) => m[1]);
}
function floorNeed(labels) {
  const longest = labels.reduce((a, b) => (b.length > a.length ? b : a), "");
  return { longest, need: longest.length * 7 + 38 + 48 + 2 };
}
function measureSelectViolations(css, labels) {
  const m = css.replace(/\/\*[\s\S]*?\*\//g, "").match(MEASURE_RULE);
  if (!m) return ["run-setups.css must hold the .grid-3.setup-measures rule (repeat(auto-fit, minmax(min(<floor>px, 100%), 1fr))) inside @media (min-width: 901px); it is missing or reshaped"];
  const { longest, need } = floorNeed(labels);
  return Number(m[1]) >= need ? [] : [`column floor ${m[1]}px is under the ${need}px "${longest}" needs`];
}

test("run-setups.css: the measure cards keep a column floor that fits the enabled EVE valuation and Gap bucket select labels", () => {
  const css = readFileSync(SETUPS_CSS, "utf8");
  const ts = readFileSync(SETUP_ROWS, "utf8");
  const labels = [...enabledLabels(ts, "EVE_VALUATION_CHOICES"), ...enabledLabels(ts, "GAP_BUCKET_CHOICES")];
  for (const named of ["As of the grid date (default)", "Monthly", "Nine standard bands", "Custom edges"]) {
    assert.ok(labels.includes(named), `${named} is not among the enabled labels: ${labels.join(" | ")}`);
  }
  // Slice three honours the bucket setting, so no enabled bucket label says interim (decision 112).
  assert.ok(!labels.some((l) => l.includes("interim")), `an enabled label still says interim: ${labels.join(" | ")}`);
  assert.ok(!labels.some((l) => l.includes("reserved")), "a reserved label is disabled and must not size the floor");
  assert.deepEqual(measureSelectViolations(css, labels), []);
  // It bites: the rule gone, its guard moved, the floor lowered under the longest enabled label (exactly at the need
  // passes, one pixel under fails, then the clipped 1280px width), or a longer enabled label than the floor covers.
  assert.equal(measureSelectViolations(css.replace(MEASURE_RULE, ""), labels).length, 1);
  assert.equal(measureSelectViolations(css.replace("min-width: 901px", "min-width: 1000px"), labels).length, 1);
  const { need } = floorNeed(labels);
  assert.equal(measureSelectViolations(css.replace(/min\(\d+px, 100%\)/, `min(${need}px, 100%)`), labels).length, 0);
  assert.equal(measureSelectViolations(css.replace(/min\(\d+px, 100%\)/, `min(${need - 1}px, 100%)`), labels).length, 1);
  assert.equal(measureSelectViolations(css.replace(/min\(\d+px, 100%\)/, "min(199px, 100%)"), labels).length, 1);
  assert.equal(measureSelectViolations(css, [...labels, "An enabled label that is much longer than any the cards hold today"]).length, 1);
});
