/**
 * The docs number check (scripts/docs-check.mjs). Each expected text below is restated by
 * hand from the target file's raw value (rounded by hand, half away from zero), never computed by the check under test.
 * The negative cases show each failure mode trips it: drift, a missing target, a missing cell, a cell that is not a
 * number, a malformed marker, no number after the marker, a wrong scale word, and a sign the rule does not allow.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkText, checkTree, docPaths, REPO_ROOT } from "../docs-check.mjs";

const fixture: Record<string, unknown> = {
  t: {
    a: { b: -1234567.891, pct: 0.04135813, tiny: 0.00004, list: [1.5, 2.25, 3], text: "x", nul: null },
    rows: [{ id: "S0", v: 1000 }, { id: "S100", v: 1500.5 }, { id: "dup", v: 1 }, { id: "dup", v: 2 }],
    "risk-free": { "S-100": { eve: 2_500_000_000 } },
  },
  u: { a: { b: 234567.891 } },
};
const load = (id: string) => fixture[id];
const problems = (text: string) => checkText(text, load, "x.md").problems;
const one = (text: string) => {
  const p = problems(text);
  expect(p, text).toHaveLength(1);
  return p[0]!;
};

describe("a marked number that holds", () => {
  it("formats by the rule: scale, decimals, $ and %, thousands commas, the sign rule, rounding half away from zero", () => {
    expect(problems("Value <!-- num target=t cell=a.b scale=million dp=1 unit=$ -->-$1.2 million here.")).toEqual([]);
    expect(problems("<!-- num target=t cell=a.b scale=thousand dp=0 unit=$ sign=abs -->$1,235 thousand")).toEqual([]);
    expect(problems("<!-- num target=t cell=a.b scale=one dp=2 -->-1,234,567.89 dollars")).toEqual([]);
    expect(problems("<!-- num target=t cell=a.pct scale=percent dp=2 -->4.14 percent")).toEqual([]);
    expect(problems("<!-- num target=t cell=a.pct scale=percent dp=1 unit=% -->4.1%")).toEqual([]);
    expect(problems("<!-- num target=t cell=a.pct scale=bp dp=0 sign=plus -->+414 bp")).toEqual([]);
    // 0.4 bp rounds to 0, which carries no sign under any rule.
    expect(problems("<!-- num target=t cell=a.tiny scale=bp dp=0 sign=plus -->0 bp")).toEqual([]);
    expect(problems("<!-- num target=t cell=rows[1].v scale=one dp=0 -->1,501 and")).toEqual([]);
    expect(problems("<!-- num target=t cell=rows[id=S100].v scale=one dp=1 -->1,500.5.")).toEqual([]);
    expect(problems("<!-- num target=t cell=risk-free.S-100.eve scale=billion dp=1 unit=$ -->$2.5 billion")).toEqual([]);
    expect(problems("<!-- num target=t cell=a.list agg=sum scale=one dp=2 -->6.75")).toEqual([]);
    expect(problems("<!-- num target=t cell=rows[id=S100].v minus=rows[id=S0].v scale=one dp=1 -->500.5")).toEqual([]);
    expect(problems("<!-- num target=u cell=a.b minus=a.b minus-target=t scale=million dp=2 unit=$ -->$1.47 million")).toEqual([]);
  });

  it("skips fenced code blocks and inline code spans, so a doc can show a marker as code", () => {
    const text = [
      "Write `<!-- num target=t cell=a.b scale=million dp=1 -->9.9 million` before the number.",
      "```markdown",
      "<!-- num target=nope cell=x scale=bad dp=9 -->",
      "```",
      "~~~",
      "<!-- num",
      "~~~",
    ].join("\n");
    expect(checkText(text, load, "x.md")).toEqual({ markers: 0, problems: [] });
  });

  it("skips an inline code span that wraps across a line break, as CommonMark does, but not across a blank line (fix)", () => {
    // The review's case: a span opened on one line and closed on the next, holding a marker-like comment.
    const wrapped = "The marker is `<!-- num target=<replica target> cell=<path>\nscale=<s> dp=<n> -->` in prose.\n";
    expect(checkText(wrapped, load, "x.md")).toEqual({ markers: 0, problems: [] });
    // A double-backtick span wrapping two lines, and a live marker after it on the second line, which is still checked.
    const after = "See ``a `<!-- num x`\nstill code`` then <!-- num target=t cell=a.b scale=million dp=1 unit=$ -->-$1.3 million\n";
    expect(checkText(after, load, "x.md").problems).toEqual(["x.md:2: drift: the doc says -$1.3, t a.b gives -$1.2"]);
    // A blank line ends the paragraph: the backtick before it opens no span, so the marker after it is live.
    const split = "An odd ` here\n\n<!-- num target=t cell=zz scale=one dp=0 -->1 and ` there\n";
    expect(checkText(split, load, "x.md").problems).toEqual(["x.md:3: missing cell: zz in t"]);
    // Line numbers are kept when a span is blanked across lines.
    const lines = "`a\nb`\n<!-- num target=t cell=zz scale=one dp=0 -->1\n";
    expect(checkText(lines, load, "x.md").problems).toEqual(["x.md:3: missing cell: zz in t"]);
  });

  it("holds three real cells, restated by hand: Quillfield's base NII and run-off EVE, and the survival days", () => {
    const real = (id: string) => JSON.parse(readFileSync(join(REPO_ROOT, "replica", "targets", `${id}.json`), "utf8"));
    const text = [
      // nii.S0.totalNet12 = 173,063,742.21
      "Base NII is <!-- num target=quillfield-v1 cell=nii.S0.totalNet12 scale=million dp=1 unit=$ -->$173.1 million.",
      // eve.risk-free.S0.eve = 1,318,894,326.61
      "Base EVE is <!-- num target=quillfield-v1 cell=eve.risk-free.S0.eve scale=million dp=0 unit=$ -->$1,319 million.",
      // survivalDays = 203.379 without the borrowing line, 322.236 with it
      "It lasts <!-- num target=demo-survival-path-v1 cell=liquidityStress.survivalPath.ladderBuffer.survivalDays scale=one dp=0 -->203 days,",
      "or <!-- num target=demo-survival-path-v1 cell=liquidityStress.survivalPath.withFacility.survivalDays scale=one dp=0 -->322 days with the line.",
      // 1,318,894,326.61 less the regulatory base 1,114,235,092.64 = 204,659,233.97
      "Value rises by <!-- num target=quillfield-v1 cell=eve.risk-free.S0.eve minus=eve.byScenario[scenarioId=S0].eve minus-target=demo-regulatory-v1 scale=million dp=0 unit=$ -->$205 million.",
      // The twelve business-as-usual inflows sum to 304,343,590.94.
      "Inflows: <!-- num target=demo-constant-prepay-v1 cell=liquidityStress.scenarios[id=bau].inflow agg=sum scale=million dp=0 unit=$ -->$304 million.",
    ].join("\n");
    expect(checkText(text, real, "real.md")).toEqual({ markers: 6, problems: [] });
    expect(checkText(text.replace("$173.1 million", "$173.2 million"), real, "real.md").problems).toEqual([
      "real.md:1: drift: the doc says $173.2, quillfield-v1 nii.S0.totalNet12 gives $173.1",
    ]);
  });
});

describe("a marked number that fails", () => {
  it("drift: the doc's number is not the target's", () => {
    expect(one("<!-- num target=t cell=a.b scale=million dp=1 unit=$ -->-$1.3 million")).toBe("x.md:1: drift: the doc says -$1.3, t a.b gives -$1.2");
    // Missing thousands commas, a dropped sign and a dropped $ are drift too.
    expect(one("<!-- num target=t cell=a.b scale=thousand dp=0 sign=abs unit=$ -->$1235 thousand")).toMatch(/drift: the doc says \$1235, .* gives \$1,235$/);
    expect(one("<!-- num target=t cell=a.b scale=million dp=1 unit=$ -->$1.2 million")).toMatch(/drift: the doc says \$1\.2, .* gives -\$1\.2$/);
    expect(one("<!-- num target=t cell=a.b scale=million dp=1 sign=abs unit=$ -->1.2 million")).toMatch(/drift: the doc says 1\.2, .* gives \$1\.2$/);
    expect(one("<!-- num target=t cell=a.list agg=sum scale=one dp=1 -->6.7")).toMatch(/drift: the doc says 6\.7, t a\.list \(sum\) gives 6\.8$/);
  });

  it("a missing target, a missing cell, an ambiguous selector, and a cell that is not a number", () => {
    expect(one("<!-- num target=gone cell=a.b scale=one dp=0 -->1")).toBe("x.md:1: missing target: replica/targets/gone.json");
    expect(one("<!-- num target=t cell=a.c scale=one dp=0 -->1")).toBe("x.md:1: missing cell: a.c in t");
    expect(one("<!-- num target=t cell=rows[9].v scale=one dp=0 -->1")).toBe("x.md:1: missing cell: rows[9].v in t");
    expect(one("<!-- num target=t cell=rows[id=S9].v scale=one dp=0 -->1")).toBe("x.md:1: missing cell: rows[id=S9].v in t");
    expect(one("<!-- num target=t cell=rows[id=dup].v scale=one dp=0 -->1")).toBe("x.md:1: missing cell: rows[id=dup].v in t");
    expect(one("<!-- num target=t cell=a.b minus=a.zz scale=one dp=0 -->1")).toBe("x.md:1: missing cell: a.zz in t");
    expect(one("<!-- num target=t cell=a.text scale=one dp=0 -->1")).toBe("x.md:1: cell a.text in t is not a finite number");
    expect(one("<!-- num target=t cell=a.nul scale=one dp=0 -->1")).toBe("x.md:1: cell a.nul in t is not a finite number");
    expect(one("<!-- num target=t cell=a.list scale=one dp=0 -->1")).toBe("x.md:1: cell a.list in t is not a finite number");
    expect(one("<!-- num target=t cell=a.b agg=sum scale=one dp=0 -->1")).toMatch(/is not an array of finite numbers/);
  });

  it("a malformed marker", () => {
    const bad: Array<[string, RegExp]> = [
      ["<!-- num: target=t cell=a.b scale=one dp=0 -->1", /malformed marker: a marker starts "<!-- num "/],
      ["<!-- NUM target=t cell=a.b scale=one dp=0 -->1", /malformed marker: a marker starts "<!-- num "/],
      ["<!-- num target=t cell=a.b scale=one -->1", /malformed marker: missing dp/],
      ["<!-- num cell=a.b scale=one dp=0 -->1", /malformed marker: missing target/],
      ["<!-- num target=t cell=a.b scale=lakh dp=0 -->1", /malformed marker: scale "lakh"/],
      ["<!-- num target=t cell=a.b scale=one dp=7 -->1", /malformed marker: dp "7"/],
      ["<!-- num target=t cell=a.b scale=one dp=0 unit=EUR -->1", /malformed marker: unit "EUR"/],
      ["<!-- num target=t cell=a.b scale=million dp=0 unit=% -->1", /malformed marker: unit % needs scale=percent/],
      ["<!-- num target=t cell=a.b scale=one dp=0 sign=minus -->1", /malformed marker: sign "minus"/],
      ["<!-- num target=t cell=a.b scale=one dp=0 colour=red -->1", /malformed marker: unknown key "colour"/],
      ["<!-- num target=t cell=a.b scale=one dp=0 dp=1 -->1", /malformed marker: key "dp" given twice/],
      ["<!-- num target=t cell=a..b scale=one dp=0 -->1", /malformed marker: cell "a\.\.b": bad segment ""/],
      ["<!-- num target=t cell=a[x].b scale=one dp=0 -->1", /malformed marker: cell "a\[x\]\.b": "\[x\]" is not an index/],
      ["<!-- num target=../t cell=a.b scale=one dp=0 -->1", /malformed marker: target "\.\.\/t"/],
      ["<!-- num target=t cell=a.b scale=one dp=0 agg=mean -->1", /malformed marker: agg "mean"/],
      ["<!-- num target=t cell=a.b scale=one dp=0 minus-target=u -->1", /malformed marker: minus-target without minus/],
      ["<!-- num target=t cell=a.b scale=one dp=0 1", /malformed marker: no "-->"/],
    ];
    for (const [text, re] of bad) expect(one(text), text).toMatch(re);
  });

  it("no number right after the marker, a wrong scale word, and a sign the rule leaves out", () => {
    expect(one("<!-- num target=t cell=a.b scale=one dp=0 --> -1,234,568")).toBe("x.md:1: no number right after the marker for t a.b");
    expect(one("<!-- num target=t cell=a.b scale=one dp=0 -->about")).toBe("x.md:1: no number right after the marker for t a.b");
    expect(one("<!-- num target=t cell=a.b scale=million dp=1 unit=$ -->-$1.2 billion")).toBe('x.md:1: -$1.2 is in million, but the next word is not "million"');
    expect(one("<!-- num target=t cell=a.pct scale=percent dp=2 -->4.14 bp")).toBe('x.md:1: 4.14 is in percent, but the next word is not "percent"');
    expect(one("<!-- num target=t cell=a.pct scale=bp dp=0 -->414 percent")).toBe('x.md:1: 414 is in bp, but the next word is not "bp"');
    expect(one("<!-- num target=t cell=a.pct scale=bp dp=0 -->+414 bp")).toMatch(/drift: the doc says \+414, .* gives 414$/);
  });

  it("reports the line of each marker, every marker in a file", () => {
    const text = "one\n<!-- num target=t cell=a.zz scale=one dp=0 -->1\nthree <!-- num target=gone cell=a scale=one dp=0 -->2\n";
    expect(checkText(text, load, "y.md")).toEqual({ markers: 2, problems: ["y.md:2: missing cell: a.zz in t", "y.md:3: missing target: replica/targets/gone.json"] });
  });
});

describe("the docs a tree holds", () => {
  it("are the public docs only: the root's README, DATA.md and CONTRIBUTING.md and the flat docs/guide/*.md (fix)", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-check-"));
    mkdirSync(join(root, "docs", "guide", "deep"), { recursive: true });
    mkdirSync(join(root, "docs", "other"), { recursive: true });
    mkdirSync(join(root, "replica", "targets"), { recursive: true });
    writeFileSync(join(root, "replica", "targets", "t.json"), JSON.stringify({ v: 42.4 }));
    writeFileSync(join(root, "README.md"), "<!-- num target=t cell=v scale=one dp=0 -->42 here\n");
    writeFileSync(join(root, "NOTICE"), "<!-- num target=t cell=v scale=one dp=0 -->41\n");
    writeFileSync(join(root, "docs", "guide", "eve.md"), "<!-- num target=t cell=v scale=one dp=1 -->42.5\n");
    writeFileSync(join(root, "docs", "guide", "deep", "x.md"), "<!-- num target=t cell=w scale=one dp=0 -->1\n");
    writeFileSync(join(root, "docs", "other", "y.md"), "<!-- num target=t cell=w scale=one dp=0 -->1\n");
    // Private files are not read, whatever they hold: a build record with a broken marker, an internal root note.
    writeFileSync(join(root, "NOTES.md"), "`<!-- num target=<replica\ntarget> -->` and <!-- num bad -->\n");
    writeFileSync(join(root, "PLATFORM-V2.md"), "<!-- num target=t cell=w scale=one dp=0 -->1\n");
    writeFileSync(join(root, "DATA.md"), "<!-- num target=t cell=v scale=one dp=0 -->42\n");
    writeFileSync(join(root, "docs", "guide", "_notes.md"), "<!-- num target=t cell=v scale=one dp=0 -->41\n");
    expect(docPaths(root)).toEqual(["DATA.md", "README.md", "docs/guide/_notes.md", "docs/guide/eve.md"]);
    expect(checkTree(root)).toEqual({
      files: ["DATA.md", "README.md", "docs/guide/_notes.md", "docs/guide/eve.md"],
      markers: 4,
      problems: ["docs/guide/_notes.md:1: drift: the doc says 41, t v gives 42", "docs/guide/eve.md:1: drift: the doc says 42.5, t v gives 42.4"],
    });
  });

  it("this repository's public docs hold (the docs:check gate)", () => {
    const r = checkTree(REPO_ROOT);
    expect(r.problems).toEqual([]);
    // Guide pages whose names start with an underscore, where present, hold worked examples as live markers, scanned
    // and holding.
    if (r.files.some((f) => /^docs\/guide\/_/.test(f))) expect(r.markers).toBeGreaterThanOrEqual(3);
  });
});
