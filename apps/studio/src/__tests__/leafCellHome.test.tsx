/**
 * LeafCell lives beside the leaf formatter (ALM Studio Polish 6 T5): format/LeafCell.tsx, which the Stack diff and
 * By kind both import. The move changes no markup. Markup and import texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeafCell } from "../format/LeafCell";

const VIEWS = readFileSync(new URL("../pages/assumptions/AssumptionsViews.tsx", import.meta.url), "utf8");
const BY_KIND = readFileSync(new URL("../pages/assumptions/ByKindPage.tsx", import.meta.url), "utf8");

const row = (cell: JSX.Element) => renderToStaticMarkup(<table><tbody><tr>{cell}</tr></tbody></table>);

describe("the moved LeafCell", () => {
  it("prints a figure, a text leaf and an absence word as before", () => {
    expect(row(<LeafCell leaf={{ kind: "figure", text: "1,000,000", exact: "1000000" }} />)).toBe('<table><tbody><tr><td class="num words" title="1000000">1,000,000</td></tr></tbody></table>');
    expect(row(<LeafCell leaf={{ kind: "text", text: "none" }} />)).toBe('<table><tbody><tr><td class="mono right">none</td></tr></tbody></table>');
    expect(row(<LeafCell leaf={{ kind: "absent", text: "Not stored" }} />)).toBe('<table><tbody><tr><td class="num muted words">Not stored</td></tr></tbody></table>');
  });
  it("is imported from format/ by the Stack diff and By kind, and declared nowhere else", () => {
    expect(VIEWS).toContain('import { LeafCell } from "../../format/LeafCell";');
    expect(VIEWS).not.toContain("function LeafCell");
    expect(BY_KIND).toContain('import { LeafCell } from "../../format/LeafCell";');
    expect(BY_KIND).not.toContain('from "./AssumptionsViews"');
  });
});
