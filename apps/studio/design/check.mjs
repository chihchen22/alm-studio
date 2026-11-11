// apps/studio/design/check.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

export const REQUIRED_THEMED = ["--bg","--surface","--surface-2","--ink","--ink-2","--muted","--line","--line-2",
  "--accent","--accent-ink","--accent-wash","--pos","--neg","--warn","--unobs","--stale",
  "--pos-wash","--neg-wash","--warn-wash","--unobs-wash","--stale-wash",
  "--series-1","--series-2","--series-3","--series-4","--series-5","--series-6",
  "--seq-1","--seq-2","--seq-3","--seq-4","--seq-5","--seq-6","--seq-7","--font-num","--row-pad"];
export const REQUIRED_ONCE = ["--font","--mono","--fs-1","--fs-2","--fs-3","--fs-4","--fs-5","--fs-6","--fs-7",
  "--sp-1","--sp-2","--sp-3","--sp-4","--sp-5","--sp-6","--sp-7","--r-1","--r-2","--r-3",
  "--shadow-1","--shadow-2","--t-fast","--t-base"];

function block(css, startRe) {
  const m = css.match(startRe);
  if (!m) return "";
  let i = m.index + m[0].length, depth = 1;
  for (; i < css.length && depth > 0; i++) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; }
  return css.slice(m.index, i);
}

// The three token blocks. Quotes around the attribute value are optional so a
// minified build (which drops them) still matches.
const LIGHT_RE = /:root\s*\{/;
const DARK_MEDIA_RE = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme=(["']?)light\1\]\)\s*\{/;
const DARK_ATTR_RE = /:root\[data-theme=(["']?)dark\1\]\s*\{/;

export function checkTokens(path) {
  return checkTokensText(readFileSync(path, "utf8"));
}

export function checkTokensText(css) {
  const light = block(css, LIGHT_RE);
  const darkMedia = block(css, DARK_MEDIA_RE);
  const darkAttr = block(css, DARK_ATTR_RE);
  const out = [];
  if (!darkMedia) out.push("missing media dark block guarded by :root:not([data-theme=\"light\"])");
  if (!darkAttr) out.push("missing :root[data-theme=\"dark\"] block");
  for (const t of REQUIRED_THEMED) {
    for (const [name, b] of [["light", light], ["dark-media", darkMedia], ["dark-attr", darkAttr]]) {
      if (!new RegExp(`${t.replace(/-/g, "\\-")}\\s*:`).test(b)) out.push(`${name}: missing ${t}`);
    }
  }
  for (const t of REQUIRED_ONCE) if (!new RegExp(`${t.replace(/-/g, "\\-")}\\s*:`).test(light)) out.push(`light: missing ${t}`);
  const bg = (b) => (b.match(/--bg\s*:\s*([^;}]+)/) || [])[1]?.trim().toLowerCase();
  for (const [name, b] of [["dark-media", darkMedia], ["dark-attr", darkAttr]]) {
    if (b && bg(b) && bg(b) === bg(light)) out.push(`${name}: --bg equals light --bg (${bg(light)})`);
  }
  return out;
}

// Regions where a colour literal takes effect: style="..." values, SVG colour
// presentation attributes, and <style> bodies. Only a <style> body has selectors.
const ATTR_RE = /\s(style|fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

function styleRegions(html) {
  const regions = [];
  for (const m of html.matchAll(ATTR_RE)) {
    const text = m[3] ?? m[4] ?? m[5];
    const closingQuote = m[5] === undefined ? 1 : 0;
    regions.push({ text, start: m.index + m[0].length - closingQuote - text.length, body: false });
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    regions.push({ text: m[1], start: m.index + m[0].indexOf(">") + 1, body: true });
  }
  return regions;
}

// In a <style> body, a match sits in a selector when the nearest following "{"
// comes before the nearest following "}" and ";".
function inSelector(text, end) {
  const pos = (c) => { const i = text.indexOf(c, end); return i < 0 ? Infinity : i; };
  const brace = pos("{");
  return brace !== Infinity && brace < pos("}") && brace < pos(";");
}

const NAMED = ["red", "blue", "green", "white", "black", "gray", "grey", "orange", "purple", "yellow"];
const NAMED_RE = new RegExp(`(?<![\\w.#-])(${NAMED.join("|")})(?![\\w-])`, "gi");

function colourViolations(html) {
  return scanRegions(styleRegions(html));
}

function scanRegions(regions) {
  const out = [];
  for (const { text, start, body } of regions) {
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}(?![\w-])/g)) {
      const prev = m.index > 0 ? text[m.index - 1] : "";
      if (prev === "&") continue; // numeric entity, not a colour
      if (/url\(\s*['"]?$/i.test(text.slice(0, m.index))) continue; // url(#id) reference, not a colour
      const end = m.index + m[0].length;
      const selectorBefore = prev === "" || /[\s,{}>]/.test(prev);
      const selectorAfter = /^([{,.:[]|\s*\{)/.test(text.slice(end));
      if (body && selectorBefore && selectorAfter && inSelector(text, end)) continue; // id selector, not a colour
      out.push(`raw color literal ${m[0]} at offset ${start + m.index}`);
    }
    for (const m of text.matchAll(/\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\(/gi)) {
      out.push(`raw ${m[1].toLowerCase()}() at offset ${start + m.index}`);
    }
    for (const m of text.matchAll(NAMED_RE)) out.push(`raw named colour ${m[1].toLowerCase()} at offset ${start + m.index}`);
  }
  return out;
}

export function checkPage(path, { requireTokensLink = true } = {}) {
  const html = readFileSync(path, "utf8");
  const out = [];
  if (requireTokensLink && !/<link[^>]+href="[^"]*tokens\.css"/.test(html)) out.push("page does not link tokens.css");
  out.push(...colourViolations(html));
  if (html.includes(String.fromCharCode(0x2014))) out.push("U+2014 em-dash present");
  if (html.includes(String.fromCharCode(0xa7))) out.push("U+00A7 section sign present");
  if (/&(mdash;?(?![0-9a-z])|#0*8212;?(?!\d)|#x0*2014;?(?![0-9a-f]))/i.test(html)) out.push("U+2014 (entity)");
  if (/&(sect|#0*167;?(?!\d)|#x0*a7;?(?![0-9a-f]))/i.test(html)) out.push("U+00A7 (entity)");
  for (const { text } of styleRegions(html)) out.push(...cssEscapes(text));
  return out;
}

// A stylesheet is one <style> body: the whole file is scanned for colour literals,
// colour functions and named colours, and for the em-dash and section sign.
export function checkCss(path) {
  return checkCssText(readFileSync(path, "utf8"));
}

function checkCssText(css) {
  const out = scanRegions([{ text: css, start: 0, body: true }]);
  if (css.includes(String.fromCharCode(0x2014))) out.push("U+2014 em-dash present");
  if (css.includes(String.fromCharCode(0xa7))) out.push("U+00A7 section sign present");
  out.push(...cssEscapes(css));
  return out;
}

function cssEscapes(css) {
  const out = [];
  if (/\\0{0,2}2014(?![0-9a-f])/i.test(css)) out.push("U+2014 (css escape)");
  if (/\\0{0,4}a7(?![0-9a-f])/i.test(css)) out.push("U+00A7 (css escape)");
  return out;
}

// Source files. A .css file gets the full stylesheet scan (checkCssText). A
// .ts/.tsx file is scanned for a quoted hex literal, a colour function in a
// string or style value, the em-dash and the section sign.
export function checkSourceDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(p); continue; }
      const ext = extname(name);
      if (![".ts", ".tsx", ".css"].includes(ext)) continue;
      const text = readFileSync(p, "utf8");
      if (ext === ".css") { out.push(...checkCssText(text).map((v) => `${p}: ${v}`)); continue; }
      for (const m of text.matchAll(/(["'`])#[0-9a-fA-F]{3,8}(?![\w-])/g)) out.push(`${p}: raw color literal ${m[0].slice(1)} at offset ${m.index}`);
      for (const m of text.matchAll(/\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\(/g)) {
        if (/["'`:]\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index))) out.push(`${p}: raw ${m[1]}() at offset ${m.index}`);
      }
      for (const m of text.matchAll(/(["'])(red|blue|green|white|black|gray|grey|orange|purple|yellow)\1/gi)) out.push(`${p}: raw named colour ${m[0]} at offset ${m.index}`);
      if (text.includes(String.fromCharCode(0x2014))) out.push(`${p}: U+2014 em-dash present`);
      if (text.includes(String.fromCharCode(0xa7))) out.push(`${p}: U+00A7 section sign present`);
    }
  };
  walk(dir);
  return out;
}

// A built app: every .css under <distDir>/assets is concatenated. The token
// blocks must be complete. Only the first match of each token block (the one
// tokens.css contributes, the one place a literal is allowed) is exempt; any
// further :root block is app-authored and is scanned like the rest. index.html is checked without the tokens-link
// requirement (the bundler renames the stylesheet), and the source tree is scanned. No built script may hold a regex
// lookbehind, positive or negative: Safari below 16.4 cannot parse one, and the build keeps a lookbehind literal as a
// RegExp string that throws where it runs (Polish 7 T1; counted over every .js under assets since Polish 8 T3). A
// named group and a lookahead do not count.
const LOOKBEHINDS = ["(?<=", "(?<!"];

export function checkApp(distDir, srcDir) {
  const assets = join(distDir, "assets");
  const css = readdirSync(assets).filter((n) => extname(n) === ".css").sort()
    .map((n) => readFileSync(join(assets, n), "utf8")).join("\n");
  const out = checkTokensText(css).map((v) => `assets css: ${v}`);
  let rest = css;
  for (const re of [DARK_MEDIA_RE, DARK_ATTR_RE, LIGHT_RE]) {
    const b = block(rest, re);
    if (b) rest = rest.replace(b, "");
  }
  out.push(...checkCssText(rest).map((v) => `assets css: ${v}`));
  out.push(...checkPage(join(distDir, "index.html"), { requireTokensLink: false }).map((v) => `index.html: ${v}`));
  out.push(...checkSourceDir(srcDir));
  for (const name of readdirSync(assets).filter((n) => extname(n) === ".js").sort()) {
    const js = readFileSync(join(assets, name), "utf8");
    for (const token of LOOKBEHINDS) {
      const count = js.split(token).length - 1;
      if (count > 0) out.push(`assets/${name}: regex lookbehind ${token} (${count})`);
    }
  }
  return out;
}

const USAGE = "usage: node check.mjs tokens|page|css <file> | app <distDir> <srcDir>";

if (process.argv[1] && process.argv[1].endsWith("check.mjs")) {
  const args = process.argv.slice(2);
  const ok = args[0] === "app" ? args.length === 3 : args.length === 2 && ["tokens", "page", "css"].includes(args[0]);
  if (!ok) { console.error(USAGE); process.exit(2); }
  const [cmd, file, src] = args;
  const v = cmd === "app" ? checkApp(file, src) : cmd === "tokens" ? checkTokens(file) : cmd === "css" ? checkCss(file) : checkPage(file);
  if (v.length) { console.error(v.join("\n")); process.exit(1); }
  console.log(`clean: ${file}`);
}
