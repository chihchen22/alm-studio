/**
 * A top-bar select pill whose value does not fit keeps the end of the value (ALM Studio Polish 4 T1). Every seeded book id starts
 * "synthetic-2500-", so a pill cut at its end reads the same for every book. The value span runs right to left and
 * the value inside it is an isolated left-to-right run, so the overflow and the ellipsis fall at the start and the
 * characters keep their reading order. Studio tests have no layout engine, so this pins the markup and the rule; the
 * drive reads the pills at 1024 and 1100 px. Markup and rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectPill, StatusPill } from "../shell/SelectPill";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

describe("a select pill keeps the end of its value", () => {
  it("wraps the value in an isolated left-to-right run; the title keeps the full value", () => {
    expect(renderToStaticMarkup(<SelectPill label="Book" value="synthetic-2500-commit-v1" options={[]} />)).toBe(
      '<div class="pill-menu-wrap"><button class="pill pill-select" type="button" title="Book: synthetic-2500-commit-v1" aria-expanded="false"><span class="pill-key">Book</span><span class="mono pill-value"><bdi dir="ltr">synthetic-2500-commit-v1</bdi></span></button></div>',
    );
  });
  it("sets the top bar's select pill value right to left, and nothing else", () => {
    expect(CSS).toContain(".topbar-ctx .pill-select .pill-value { direction: rtl; }");
    expect(CSS.match(/(?<![\w-])direction\s*:/g)).toEqual(["direction:"]);
  });
  it("leaves the failed-list pill as it was", () => {
    const html = renderToStaticMarkup(<StatusPill label="Plan" reason="GET /api/run-plans failed" />);
    expect(html).toContain('<span class="mono pill-value" aria-hidden="true">Unobservable</span>');
    expect(html).not.toContain("<bdi");
  });
});
