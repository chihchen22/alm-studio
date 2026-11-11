#!/usr/bin/env node
/**
 * The docs number check: every number a public markdown doc marks is read again from the
 * Python replica's target file the marker names, formatted by the marker's display rule, and compared with the text that
 * follows the marker. The expected value always comes from the target, never from the doc.
 *
 *   node scripts/docs-check.mjs                 check this tree's public docs
 *   node scripts/docs-check.mjs --root <dir>    check another tree (for example an export)
 *   npm run docs:check
 *
 * A marker is an HTML comment written right before the number, so GitHub shows only the number:
 *
 *   <!-- num target=quillfield-v1 cell=nii.S0.totalNet12 scale=million dp=1 unit=$ -->$173.1 million
 *
 *   target  a file under replica/targets/, without ".json"                                    required
 *   cell    the path to a number in it: keys joined by ".", "[n]" for an array index, and        required
 *           "[key=value]" for the array element whose key holds that value
 *   scale   one, thousand, million, billion, percent (times 100) or bp (times 10,000)          required
 *   dp      decimals shown, 0 to 6                                                              required
 *   unit    "$" before the number, or "%" after it (percent scale only)                         optional
 *   sign    signed (a minus when negative, the default), abs (no sign), plus (+ when positive)  optional
 *   agg     sum: the cell is an array of numbers, and the number is their sum                  optional
 *   minus   a second cell, subtracted from the first (a change between two runs)               optional
 *   minus-target  the target of the second cell, when it is not the first's                   optional
 *
 * The number must follow the "-->" with nothing between. Thousands take commas (1,319). After a thousand, million or
 * billion number the next word must be that word; after a percent number without "%" it must be "percent"; after a bp
 * number it must be "bp" or "basis". Rounding is half away from zero.
 *
 * The check reads the public docs only (PUBLIC_ROOT_MD at the tree's root, and every flat docs/guide/*.md): the
 * markdown this repository publishes. Private files
 * (a build log and the like) are not read. Fenced code blocks and inline code spans are skipped, a span that wraps
 * across a line break within a paragraph included (CommonMark), so a doc may show a marker as code. It fails on drift, a missing target or cell, a cell that is
 * not a finite number, a malformed marker, or a marker with no number after it.
 *
 * Node built-ins only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCALES = { one: 1, thousand: 1e-3, million: 1e-6, billion: 1e-9, percent: 100, bp: 10_000 };
const SCALE_WORD = { thousand: /^ thousand\b/, million: /^ million\b/, billion: /^ billion\b/, percent: /^ percent\b/, bp: /^ ?(bp|basis)\b/ };
const SIGNS = ["signed", "abs", "plus"];
const KEYS = new Set(["target", "cell", "scale", "dp", "unit", "sign", "agg", "minus", "minus-target"]);
const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;
/** One cell segment: a key, then any number of "[n]" or "[key=value]" selectors. */
const SEGMENT = /^([A-Za-z0-9_-]+)?((?:\[[^\]=]+(?:=[^\]]+)?\])*)$/;
/** The number after a marker: an optional sign and "$", digits with optional commas and decimals, an optional "%". */
const TOKEN = /^[+-]?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/;

/** The public markdown at a tree's root. */
export const PUBLIC_ROOT_MD = ["README.md", "DATA.md", "CONTRIBUTING.md", "CHANGELOG.md"];

/**
 * The public docs of a tree, repo-relative with forward slashes: the root's public markdown that exists, and every flat
 * .md under docs/guide/ (a page whose name starts with an underscore is read too, so its live examples hold).
 */
export function docPaths(root) {
  const out = PUBLIC_ROOT_MD.filter((n) => existsSync(join(root, n)));
  const guide = join(root, "docs", "guide");
  if (existsSync(guide)) {
    for (const e of readdirSync(guide, { withFileTypes: true })) if (e.isFile() && e.name.endsWith(".md")) out.push(`docs/guide/${e.name}`);
  }
  return out.sort();
}

/**
 * The text with fenced code blocks and inline code spans blanked, every line and column kept. A code span may wrap
 * across line breaks within a paragraph, as CommonMark allows; it never crosses a blank line or a fence.
 */
export function blankCode(text) {
  let fence = null;
  const lines = text.split("\n").map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return " ".repeat(line.length);
    }
    if (m) { fence = m[1]; return " ".repeat(line.length); }
    return line;
  });
  // Paragraphs: runs of lines between blank (or blanked) lines. Spans are matched across a paragraph's line breaks.
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length > 0) out.push(para.join("\n").replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, blank));
    para = [];
  };
  for (const line of lines) {
    if (line.trim() === "") { flush(); out.push(line); } else para.push(line);
  }
  flush();
  return out.join("\n");
}

/** A marker's fields, or the reason it is malformed. */
export function parseMarker(body) {
  const words = body.trim().split(/\s+/);
  if (words[0] !== "num") return { error: `a marker starts "<!-- num ", not "<!-- ${words[0] ?? ""}"` };
  const f = {};
  for (const w of words.slice(1)) {
    const eq = w.indexOf("=");
    if (eq <= 0) return { error: `"${w}" is not key=value` };
    const k = w.slice(0, eq);
    if (!KEYS.has(k)) return { error: `unknown key "${k}"` };
    if (k in f) return { error: `key "${k}" given twice` };
    f[k] = w.slice(eq + 1);
  }
  for (const k of ["target", "cell", "scale", "dp"]) if (f[k] === undefined || f[k] === "") return { error: `missing ${k}` };
  if (!TARGET_ID.test(f.target)) return { error: `target "${f.target}" is not a target file id` };
  if (!(f.scale in SCALES)) return { error: `scale "${f.scale}" is not one of ${Object.keys(SCALES).join(", ")}` };
  if (!/^[0-6]$/.test(f.dp)) return { error: `dp "${f.dp}" is not 0 to 6` };
  if (f.unit !== undefined && f.unit !== "$" && f.unit !== "%") return { error: `unit "${f.unit}" is not $ or %` };
  if (f.unit === "%" && f.scale !== "percent") return { error: "unit % needs scale=percent" };
  if (f.sign !== undefined && !SIGNS.includes(f.sign)) return { error: `sign "${f.sign}" is not one of ${SIGNS.join(", ")}` };
  if (f.agg !== undefined && f.agg !== "sum") return { error: `agg "${f.agg}" is not sum` };
  if (f["minus-target"] !== undefined && f.minus === undefined) return { error: "minus-target without minus" };
  if (f["minus-target"] !== undefined && !TARGET_ID.test(f["minus-target"])) return { error: `minus-target "${f["minus-target"]}" is not a target file id` };
  const cell = parseCell(f.cell);
  if (cell.error) return { error: cell.error };
  const minus = f.minus === undefined ? null : parseCell(f.minus);
  if (minus?.error) return { error: minus.error };
  return {
    marker: {
      target: f.target, cell: f.cell, steps: cell.steps, scale: f.scale, dp: Number(f.dp), unit: f.unit ?? "", sign: f.sign ?? "signed", agg: f.agg ?? null,
      minus: minus === null ? null : { target: f["minus-target"] ?? f.target, cell: f.minus, steps: minus.steps },
    },
  };
}

/** A cell path as steps: { key }, { index }, or { match: [key, value] }. */
export function parseCell(cell) {
  const steps = [];
  for (const seg of cell.split(".")) {
    const m = SEGMENT.exec(seg);
    if (!m || seg === "") return { error: `cell "${cell}": bad segment "${seg}"` };
    if (m[1] !== undefined) steps.push({ key: m[1] });
    for (const b of m[2].match(/\[[^\]]+\]/g) ?? []) {
      const inner = b.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq < 0) {
        if (!/^\d+$/.test(inner)) return { error: `cell "${cell}": "[${inner}]" is not an index or key=value` };
        steps.push({ index: Number(inner) });
      } else steps.push({ match: [inner.slice(0, eq), inner.slice(eq + 1)] });
    }
  }
  if (steps.length === 0) return { error: `cell "${cell}" is empty` };
  return { steps };
}

/** The value at a cell, or undefined when the path leads nowhere. */
export function readCell(json, steps) {
  let v = json;
  for (const s of steps) {
    if (v === null || typeof v !== "object") return undefined;
    if ("key" in s) v = Array.isArray(v) ? undefined : Object.prototype.hasOwnProperty.call(v, s.key) ? v[s.key] : undefined;
    else if ("index" in s) v = Array.isArray(v) ? v[s.index] : undefined;
    else {
      if (!Array.isArray(v)) return undefined;
      const hits = v.filter((e) => e !== null && typeof e === "object" && String(e[s.match[0]]) === s.match[1]);
      v = hits.length === 1 ? hits[0] : undefined;
    }
    if (v === undefined) return undefined;
  }
  return v;
}

/** The number a marker's cell holds (summed when `agg` is sum), or the problem. */
function numberAt(loadTarget, target, cell, steps, agg) {
  const json = loadTarget(target);
  if (json === undefined) return { error: `missing target: replica/targets/${target}.json` };
  const v = readCell(json, steps);
  if (v === undefined) return { error: `missing cell: ${cell} in ${target}` };
  if (agg === "sum") {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) return { error: `cell ${cell} in ${target} is not an array of finite numbers (agg=sum)` };
    return { value: v.reduce((a, b) => a + b, 0) };
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return { error: `cell ${cell} in ${target} is not a finite number` };
  return { value: v };
}

/** A value as the display rule shows it. */
export function formatValue(value, { scale, dp, unit, sign }) {
  const x = value * SCALES[scale];
  const f = 10 ** dp;
  const mag = Math.round(Math.abs(x) * f) / f;
  const neg = x < 0 && mag !== 0;
  const [int, dec] = mag.toFixed(dp).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+$)/g, ",");
  const s = sign === "abs" ? "" : neg ? "-" : sign === "plus" && mag !== 0 ? "+" : "";
  return `${s}${unit === "$" ? "$" : ""}${grouped}${dec !== undefined ? `.${dec}` : ""}${unit === "%" ? "%" : ""}`;
}

/**
 * The problems of one doc's text. `loadTarget(id)` returns the target's parsed JSON, or undefined when there is none.
 * @returns {{ markers: number, problems: string[] }}
 */
export function checkText(text, loadTarget, label = "doc") {
  const plain = blankCode(text);
  const lineOf = (i) => plain.slice(0, i).split("\n").length;
  const problems = [];
  let markers = 0;
  const open = /<!--\s*num\b/gi;
  for (let m = open.exec(plain); m !== null; m = open.exec(plain)) {
    markers += 1;
    const at = `${label}:${lineOf(m.index)}`;
    const close = plain.indexOf("-->", m.index);
    if (close < 0) { problems.push(`${at}: malformed marker: no "-->"`); continue; }
    const parsed = parseMarker(plain.slice(m.index + 4, close));
    if (parsed.error) { problems.push(`${at}: malformed marker: ${parsed.error}`); continue; }
    const mk = parsed.marker;
    const after = plain.slice(close + 3);
    const tok = TOKEN.exec(after)?.[0];
    if (tok === undefined) { problems.push(`${at}: no number right after the marker for ${mk.target} ${mk.cell}`); continue; }
    const first = numberAt(loadTarget, mk.target, mk.cell, mk.steps, mk.agg);
    if (first.error) { problems.push(`${at}: ${first.error}`); continue; }
    let value = first.value;
    if (mk.minus !== null) {
      const second = numberAt(loadTarget, mk.minus.target, mk.minus.cell, mk.minus.steps, mk.agg);
      if (second.error) { problems.push(`${at}: ${second.error}`); continue; }
      value -= second.value;
    }
    const want = formatValue(value, mk);
    if (tok !== want) { problems.push(`${at}: drift: the doc says ${tok}, ${mk.target} ${mk.cell}${mk.minus ? ` minus ${mk.minus.target} ${mk.minus.cell}` : ""}${mk.agg ? " (sum)" : ""} gives ${want}`); continue; }
    const word = mk.scale === "percent" && mk.unit === "%" ? undefined : SCALE_WORD[mk.scale];
    if (word !== undefined && !word.test(after.slice(tok.length))) problems.push(`${at}: ${tok} is in ${mk.scale === "bp" ? "bp" : mk.scale}, but the next word is not "${mk.scale === "bp" ? "bp" : mk.scale}"`);
  }
  return { markers, problems };
}

/** Every public doc of a tree, checked. */
export function checkTree(root) {
  const cache = new Map();
  const loadTarget = (id) => {
    if (!cache.has(id)) {
      const p = join(root, "replica", "targets", `${id}.json`);
      cache.set(id, existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined);
    }
    return cache.get(id);
  };
  const files = docPaths(root);
  let markers = 0;
  const problems = [];
  for (const p of files) {
    const r = checkText(readFileSync(join(root, p), "utf8"), loadTarget, p);
    markers += r.markers;
    problems.push(...r.problems);
  }
  return { files, markers, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : REPO_ROOT;
  const { files, markers, problems } = checkTree(root);
  for (const p of problems) process.stdout.write(`${p}\n`);
  process.stdout.write(`docs check: ${files.length} docs, ${markers} marked numbers, ${problems.length} problems\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
