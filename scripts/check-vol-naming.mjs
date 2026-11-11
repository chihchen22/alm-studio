#!/usr/bin/env node
/**
 * Volatility naming sweep.
 *
 * ADR-030 forbids calling the two volatility blocks cap or swaption quotes in user-visible copy; the
 * words of record are "short-rate volatility surface", "long-yield volatility surface" and "at-the-money
 * column". This script reads every `.ts` and `.tsx` file under the roots it is given (default: the five
 * source roots below, `__tests__` directories excluded) plus `docs/harness/catalog.json`, and applies
 * the pattern case-insensitively to the text a user can read:
 *
 *  - every string literal, no-substitution template and template expression (cooked, so a `\`
 *    line continuation joins its two lines; a `${...}` substitution reads as a placeholder);
 *  - adjacent string literals joined by `+`, matched as one text, so a phrase split across a
 *    concatenation is still found;
 *  - JSX text and JSX attribute strings, with the non-breaking space entities (`&nbsp;`, `&#160;`,
 *    `&#xA0;`) read as a space;
 *  - the children of one JSX element joined as one text: adjacent JSX text, string-literal expression
 *    children (`cap{" "}quotes`) and any other expression child read as nothing between its neighbours
 *    (`cap {n} quotes`, or an expression holding only a comment), so a phrase split by an expression is
 *    still found; an element child ends the run. A literal inside a non-literal expression child is
 *    still read alone;
 *  - every string value of the catalog JSON (keys are not read).
 *
 * Whitespace runs read as one space before matching. The allowlist is exactly decision 95's:
 *  - identifiers and keys (`capQuotes`, `swaptionATMQuotes`, `capVolSurface`, `swaptionVolSurface`,
 *    `swaption_vol_points`, `kind="cap"`, `kind="swaption"`, the SQLite column names): never read,
 *    because identifiers are not string text and a property-name, element-access, import or export
 *    string is skipped;
 *  - code comments: never read (the TypeScript scanner keeps them as trivia), and the `--` line
 *    comments inside an SQL statement string (the SQLite schema) are cut before matching;
 *  - the one frozen user-visible text, the `StochasticCapVolsError` message in
 *    `packages/engine/src/scenario/stochasticEnvironment.ts`, which the limitations page names as the residual
 *    the Hull-White freeze keeps. It is reported as allowlisted, never as a hit.
 *
 * Usage: `node scripts/check-vol-naming.mjs [root ...]` (paths relative to the repository root; a root
 * may be a directory or a file). Prints every hit off the allowlist and a count per root; exits 1 when
 * any hit is off the allowlist, else 0. Expected: zero.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_ROOTS = [
  "packages/engine/src",
  "packages/reader/src",
  "apps/server/src",
  "apps/studio/src",
  "apps/viewer/src",
  "docs/harness/catalog.json",
];

export const PATTERN = /cap (normal )?vol|cap quote|cap surface|swaption (quote|normal|grid|atm)/i;

/** The one frozen user-visible text (decision 95): file, and the class whose message it is. */
export const ALLOWLIST = [
  {
    file: "packages/engine/src/scenario/stochasticEnvironment.ts",
    enclosingClass: "StochasticCapVolsError",
    why: "frozen Hull-White module: the route pre-validates, so the text reaches a user only through a hand-built engine call",
  },
];

const SUBSTITUTION = "${...}";

const normalize = (text) => text.replace(/\s+/g, " ");

/** JSX decodes HTML entities in its text and attribute strings; a non-breaking space reads as a space. */
const decodeJsxSpaces = (text) => text.replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ");

/** An SQL statement string: its `--` comments are code comments, cut before matching. */
const SQL_STATEMENT = /\bCREATE (TABLE|INDEX|UNIQUE INDEX|VIEW|TRIGGER)\b|\bSELECT\b[\s\S]*\bFROM\b|\bINSERT INTO\b/;
const withoutSqlComments = (text) => (SQL_STATEMENT.test(text) ? text.replace(/--[^\n]*/g, "") : text);

function isStringish(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

function stringText(node) {
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => SUBSTITUTION + s.literal.text).join("");
  }
  return node.text;
}

/** A string that is a key or a module name, not text a user reads. */
function isKeyString(node) {
  const p = node.parent;
  if (p === undefined) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === node) {
    return true;
  }
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) && p.parent !== undefined && ts.isImportTypeNode(p.parent)) return true;
  return false;
}

/** The left-to-right operands of a `+` chain, through parentheses. */
function plusOperands(node, out) {
  if (ts.isParenthesizedExpression(node)) return plusOperands(node.expression, out);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    plusOperands(node.left, out);
    plusOperands(node.right, out);
    return out;
  }
  out.push(node);
  return out;
}

function enclosingClassName(node) {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name !== undefined) return n.name.text;
  }
  return null;
}

/**
 * Every pattern hit in one TypeScript source, as { line, match, text, enclosingClass }. `fileName`
 * decides TS against TSX.
 */
export function scanSource(sourceText, fileName) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  const check = (text, node) => {
    const norm = normalize(withoutSqlComments(text));
    const m = PATTERN.exec(norm);
    if (m === null) return;
    hits.push({
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      match: m[0],
      text: norm.trim(),
      enclosingClass: enclosingClassName(node),
    });
  };
  const visitTemplateSpans = (node) => {
    if (ts.isTemplateExpression(node)) for (const s of node.templateSpans) visit(s.expression);
  };
  /**
   * The children of one JSX element or fragment as runs of joined text. JSX text and string-literal
   * expression children append their text; any other expression child (or an empty one, a comment)
   * appends nothing and is visited on its own; an element child flushes the run and is visited.
   */
  const visitJsxChildren = (children) => {
    let text = "";
    let first;
    const flush = () => {
      if (first !== undefined) check(text, first);
      text = "";
      first = undefined;
    };
    for (const child of children) {
      if (ts.isJsxText(child)) {
        first ??= child;
        text += decodeJsxSpaces(child.text);
      } else if (ts.isJsxExpression(child)) {
        const e = child.expression;
        if (e !== undefined && isStringish(e)) {
          first ??= child;
          text += stringText(e);
          visitTemplateSpans(e);
        } else if (e !== undefined) {
          visit(e);
        }
      } else {
        flush();
        visit(child);
      }
    }
    flush();
  };
  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      visit(node.openingElement);
      visitJsxChildren(node.children);
      return;
    }
    if (ts.isJsxFragment(node)) {
      visitJsxChildren(node.children);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      let run = [];
      const flush = () => {
        if (run.length > 0) check(run.map(stringText).join(""), run[0]);
        for (const r of run) visitTemplateSpans(r);
        run = [];
      };
      for (const op of plusOperands(node, [])) {
        if (isStringish(op)) {
          run.push(op);
        } else {
          flush();
          visit(op);
        }
      }
      flush();
      return;
    }
    if (isStringish(node)) {
      const inAttribute = node.parent !== undefined && ts.isJsxAttribute(node.parent);
      if (!isKeyString(node)) check(inAttribute ? decodeJsxSpaces(stringText(node)) : stringText(node), node);
      visitTemplateSpans(node);
      return;
    }
    if (ts.isJsxText(node)) {
      check(decodeJsxSpaces(node.text), node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Every pattern hit in the string values of one JSON document, as { line: path, match, text }. */
export function scanJson(sourceText) {
  const hits = [];
  const walk = (v, path) => {
    if (typeof v === "string") {
      const norm = normalize(v);
      const m = PATTERN.exec(norm);
      if (m !== null) hits.push({ line: path, match: m[0], text: norm.trim(), enclosingClass: null });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(JSON.parse(sourceText), "$");
  return hits;
}

export function isAllowlisted(file, hit) {
  return ALLOWLIST.some((a) => a.file === file && a.enclosingClass === hit.enclosingClass);
}

function filesUnder(absRoot) {
  const st = statSync(absRoot);
  if (st.isFile()) return [absRoot];
  const out = [];
  for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(absRoot, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out.sort();
}

/** Sweeps the given roots; returns per-root hits off the allowlist and the allowlisted residuals. */
export function sweep(roots, repoRoot = REPO_ROOT) {
  const result = [];
  for (const root of roots) {
    const absRoot = resolve(repoRoot, root);
    const hits = [];
    const allowlisted = [];
    for (const abs of filesUnder(absRoot)) {
      const file = relative(repoRoot, abs).split(sep).join("/");
      const text = readFileSync(abs, "utf8");
      const found = file.endsWith(".json") ? scanJson(text) : scanSource(text, file);
      for (const h of found) (isAllowlisted(file, h) ? allowlisted : hits).push({ file, ...h });
    }
    result.push({ root, hits, allowlisted });
  }
  return result;
}

function main(argv) {
  const roots = argv.length > 0 ? argv : DEFAULT_ROOTS;
  const result = sweep(roots);
  let total = 0;
  for (const r of result) {
    for (const h of r.hits) console.log(`${h.file}:${h.line}: "${h.match}" in: ${h.text.slice(0, 200)}`);
    total += r.hits.length;
  }
  console.log("");
  for (const r of result) {
    const allow = r.allowlisted.length > 0 ? ` (allowlisted: ${r.allowlisted.map((h) => `${h.file}:${h.line}`).join(", ")})` : "";
    console.log(`${r.root}: ${r.hits.length} hit${r.hits.length === 1 ? "" : "s"} off the allowlist${allow}`);
  }
  console.log(`check-vol-naming: ${total} hit${total === 1 ? "" : "s"} off the allowlist over ${roots.length} root${roots.length === 1 ? "" : "s"}`);
  return total === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
